import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { createOperationTrace, safeErrorDetails, operationAbortDetails } from './operation-trace.mjs';

export const IMAGE_ACCEPT = 'image/avif,image/webp,image/png,image/jpeg';
export const IMAGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 LuxuryTravelImageResearch/1.2';
const responseCleanup = new WeakMap();
const responseDeadlines = new WeakMap();

export function imageNetworkError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function isPrivateIp(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!net.isIP(normalized)) return true;
  if (net.isIP(normalized) === 6) {
    // Reject mapped/translated IPv4 and special-use IPv6 as well as RFC1918.
    return normalized.startsWith('::') || /^(?:fc|fd|fe[89abcdef]|ff)/.test(normalized)
      || normalized.startsWith('64:ff9b:') || normalized.startsWith('2001:db8:');
  }
  const [a, b] = normalized.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 198 && [18, 19].includes(b));
}

async function publicRecords(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!records.length || records.some(({ address }) => isPrivateIp(address))) {
    throw imageNetworkError('public_url_blocked', '已阻止本地或私有网络地址');
  }
  return records;
}

export function decodedImageBody(incoming, headers) {
  const encodings = (headers.get('content-encoding') || '').toLowerCase().split(',').map((value) => value.trim()).filter((value) => value && value !== 'identity');
  if (!encodings.length) return Readable.toWeb(incoming);
  const transforms = encodings.reverse().map((encoding) => {
    if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip();
    if (encoding === 'br') return createBrotliDecompress();
    if (encoding === 'deflate') return createInflate();
    throw imageNetworkError('image_encoding_unsupported', '来源资源压缩格式不受支持');
  });
  const output = transforms.at(-1);
  pipeline(incoming, ...transforms, () => {});
  headers.delete('content-encoding'); headers.delete('content-length');
  return Readable.toWeb(output);
}

export async function assertPublicUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw imageNetworkError('public_url_blocked', '不支持的图片地址协议');
  if (url.username || url.password) throw imageNetworkError('public_url_blocked', '不允许带认证信息的公网图片地址');
  await publicRecords(url.hostname);
  return url;
}

// Resolve at connection time too, and pin the connection to the checked address.
// This avoids the DNS check / browser-or-fetch connection rebinding gap.
function nativePublicFetch(value, { headers, signal }) {
  return new Promise((resolve, reject) => {
    const url = new URL(value);
    const requestHeaders = new Headers(headers);
    requestHeaders.set('accept-encoding', 'identity');
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', headers: Object.fromEntries(requestHeaders), signal,
      lookup(hostname, options, callback) {
        publicRecords(hostname).then((records) => {
          const matching = options.family ? records.filter((record) => record.family === options.family) : records;
          if (!matching.length) return callback(imageNetworkError('public_url_blocked', '没有可用的公网地址'));
          if (options.all) callback(null, matching);
          else callback(null, matching[0].address, matching[0].family);
        }, callback);
      },
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      const status = incoming.statusCode || 502;
      try {
        const response = new Response([204, 205, 304].includes(status) ? null : decodedImageBody(incoming, responseHeaders), { status, headers: responseHeaders });
        Object.defineProperty(response, 'url', { value: url.href });
        resolve(response);
      } catch (error) { incoming.destroy(); reject(error); }
    });
    request.on('error', reject);
    request.end();
  });
}

export function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || imageNetworkError('request_cancelled', '请求已取消'));
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(signal.reason || imageNetworkError('request_cancelled', '请求已取消')); };
    const timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function awaitImageWork(work, signal) {
  if (!signal) return work;
  if (signal.aborted) throw signal.reason || imageNetworkError('request_cancelled', '图片获取已取消');
  let cancel;
  const aborted = new Promise((_, reject) => { cancel = () => reject(signal.reason || imageNetworkError('request_cancelled', '图片获取已取消')); });
  signal.addEventListener('abort', cancel, { once: true });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export async function closeImageResponse(response) {
  try { await response?.body?.cancel?.(); } catch { /* A reader may already own the stream. */ }
  responseCleanup.get(response)?.();
  responseCleanup.delete(response);
  responseDeadlines.delete(response);
}

function deadlineSignal(signal, timeoutMs, keepAlive = false) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason || imageNetworkError('request_cancelled', '请求已取消'));
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(imageNetworkError('image_fetch_timeout', '图片资源读取超时')), timeoutMs);
  if (!keepAlive) timer.unref?.();
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
}

export async function readImageResponse(response, { maxBytes = 5_000_000, timeoutMs = 20_000, signal, onBodyBytes, traceContext, logger } = {}) {
  const trace = createOperationTrace('image_http_body', traceContext, logger);
  trace.emit('body_read_start');
  const responseDeadline = responseDeadlines.get(response);
  const deadline = deadlineSignal(signal, timeoutMs, true);
  const reader = response.body?.getReader?.();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(deadline.signal.reason); });
  deadline.signal.addEventListener('abort', rejectAbort, { once: true });
  const chunks = []; let received = 0;
  try {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (Number(response.headers.get('content-length') || 0) > maxBytes) throw imageNetworkError('image_body_too_large', '图片或网页超过资源上限');
    if (!reader) {
      const body = await Promise.race([response.arrayBuffer ? response.arrayBuffer() : response.text().then((value) => Buffer.from(value)), aborted]);
      const buffer = Buffer.from(body);
      onBodyBytes?.(buffer.length);
      if (buffer.length > maxBytes) throw imageNetworkError('image_body_too_large', '图片或网页超过资源上限');
      trace.emit('body_read_end', { bytes: buffer.length });
      return buffer;
    }
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      received += value.byteLength;
      onBodyBytes?.(value.byteLength);
      if (received > maxBytes) throw imageNetworkError('image_body_too_large', '图片或网页超过资源上限');
      chunks.push(Buffer.from(value));
    }
    trace.emit('body_read_end', { bytes: received });
    return Buffer.concat(chunks);
  } catch (error) {
    trace.emit('body_read_failed', { ...safeErrorDetails(error), ...operationAbortDetails(error, deadline.signal, responseDeadline, signal) });
    throw error;
  } finally {
    deadline.cleanup();
    deadline.signal.removeEventListener('abort', rejectAbort);
    if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
    await closeImageResponse(response);
  }
}

export function classifyImageHttpResponse(status, type = '', body = '') {
  const sample = String(body).slice(0, 80_000);
  // Captcha libraries/configuration also occur on readable articles (including
  // MediaWiki's edit configuration). Require a challenge UI or visible denial,
  // not a word in an inline script, JSON setting or HTML comment.
  const markup = sample.replace(/<!--[\s\S]*?-->/g, '');
  const staticMarkup = markup.replace(/<(script|style)\b([^>]*)>[\s\S]*?(?:<\/\1\s*>|$)/gi, '<$1$2></$1>');
  const challengeUi = /<(?:script|iframe)\b[^>]*\bsrc\s*=\s*["'][^"']*(?:\/cdn-cgi\/challenge-platform\/|\/cf-chl-)/i.test(staticMarkup)
    || /<(?:form|div|iframe|input)\b[^>]*\b(?:id|class|name)\s*=\s*["'][^"']*\b(?:challenge-form|cf-chl-widget|captcha-container|captcha-challenge|h-captcha|g-recaptcha)\b/i.test(staticMarkup);
  const visibleMarkup = staticMarkup.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const visibleText = visibleMarkup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const challengeHeading = /<(?:title|h1|h2)\b[^>]*>\s*(?:just a moment|attention required|access denied|verify (?:that )?you are human|请求被拦截|访问验证|人机验证)/i.test(visibleMarkup);
  const visibleDenial = visibleText.length < 1500 && /(?:verify|checking) (?:that )?you are human|access denied|请求被拦截|访问验证|人机验证/i.test(visibleText);
  const challenge = challengeUi || challengeHeading || visibleDenial;
  if (challenge || [401, 403].includes(status)) return { code: 'page_access_blocked', message: '来源站点要求验证或拒绝访问', retryable: false, challengeDetected: challenge };
  if (status === 429) return { code: 'page_rate_limited', message: '来源站点请求受限', retryable: true };
  if (status === 503) return { code: 'page_service_unavailable', message: '来源站点暂时不可用', retryable: true };
  if (status < 200 || status >= 300) return { code: 'page_http_error', message: `来源资源请求失败（${status}）`, retryable: false };
  return null;
}

export async function fetchPublicUrl(value, { signal, headers = {}, timeoutMs = 20_000, maxRedirects = 5, fetchImpl = fetch, onRequest, retrievalSession, sourcePageUrl, followRedirects = true, traceContext, logger } = {}) {
  const trace = createOperationTrace('image_http', traceContext, logger);
  let current;
  const deadline = deadlineSignal(signal, timeoutMs);
  const transport = fetchImpl === globalThis.fetch ? nativePublicFetch : fetchImpl;
  let release;
  try {
    current = (await trace.measure('url_validation', () => awaitImageWork(assertPublicUrl(value), deadline.signal))).href;
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      await awaitImageWork(assertPublicUrl(current), deadline.signal);
      release = await trace.measure('domain_wait', () => retrievalSession?.acquire(current, deadline.signal));
      const requestHeaders = new Headers(headers);
      // Callers never supply persistent credentials for public fetching.
      requestHeaders.delete('authorization'); requestHeaders.delete('cookie');
      for (const [key, val] of Object.entries(retrievalSession?.headersFor(current, sourcePageUrl) || {})) requestHeaders.set(key, val);
      onRequest?.(current);
      const response = await trace.measure('http_headers', () => transport(current, { redirect: 'manual', headers: requestHeaders, signal: deadline.signal }));
      trace.emit('http_status', { statusCode: response.status, redirectCount: redirects });
      retrievalSession?.rememberResponse(current, response.headers);
      if ([429, 503].includes(response.status)) retrievalSession?.cooldown(current, retryAfterMs(response.headers.get('retry-after')) ?? 500);
      const cleanup = () => { deadline.cleanup(); release?.(); release = undefined; };
      responseCleanup.set(response, cleanup);
      responseDeadlines.set(response, deadline.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) { await closeImageResponse(response); throw imageNetworkError('page_redirect_error', '重定向响应缺少地址'); }
      let next;
      try { next = (await awaitImageWork(assertPublicUrl(new URL(location, current)), deadline.signal)).href; }
      catch (error) { await closeImageResponse(response); throw error; }
      if (!followRedirects) return response;
      // Keep the same total deadline over every redirect and its body disposal.
      responseCleanup.delete(response);
      responseDeadlines.delete(response);
      try { await response.body?.cancel?.(); } catch {}
      release?.(); release = undefined;
      current = next;
    }
    throw imageNetworkError('page_redirect_error', '重定向次数过多');
  } catch (error) {
    trace.emit('request_failed', { ...safeErrorDetails(error), ...operationAbortDetails(error, deadline.signal, signal) });
    deadline.cleanup(); release?.(); throw error;
  }
}

export async function fetchPublicImageResource(value, { maxBytes = 5_000_000, timeoutMs = 20_000, maxRetryDelayMs = 5_000, ...options } = {}) {
  const trace = createOperationTrace('image_http_resource', options.traceContext, options.logger);
  const traceContext = { ...options.traceContext, requestId: trace.requestId };
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw imageNetworkError('image_fetch_timeout', '图片资源读取超时');
    trace.emit('attempt_start', { attempt: attempt + 1 });
    const response = await fetchPublicUrl(value, { ...options, traceContext, timeoutMs: remaining });
    const type = response.headers.get('content-type') || '';
    if (options.skipImageBody && response.status >= 200 && response.status < 300 && type.startsWith('image/')) {
      await closeImageResponse(response);
      return { buffer: null, headers: response.headers, status: response.status, responseUrl: response.url || String(value) };
    }
    const buffer = await readImageResponse(response, { maxBytes, timeoutMs: remaining, signal: options.signal, onBodyBytes: options.onBodyBytes, traceContext, logger: options.logger });
    const body = /html|text|json/i.test(type) || !type ? buffer.subarray(0, 80_000).toString('utf8') : '';
    const failure = options.followRedirects === false && [301, 302, 303, 307, 308].includes(response.status)
      ? null : classifyImageHttpResponse(response.status, type, body);
    if (!failure) return { buffer, headers: response.headers, status: response.status, responseUrl: response.url || String(value) };
    options.retrievalSession?.recordFailure(failure.code);
    const requestedWait = retryAfterMs(response.headers.get('retry-after'));
    const wait = requestedWait ?? 500;
    // A longer server-requested wait is respected by stopping, never clamped into an earlier retry.
    if (!attempt && failure.retryable && wait <= maxRetryDelayMs && Date.now() - started + wait < timeoutMs) {
      options.retrievalSession?.cooldown(value, wait);
      options.retrievalSession?.recordRetry();
      trace.emit('technical_retry', { attempt: attempt + 1, durationMs: wait, statusCode: response.status });
      await abortableDelay(wait, options.signal);
      continue;
    }
    throw imageNetworkError(failure.code, failure.message, { status: response.status, challengeDetected: failure.challengeDetected === true, retryAfterMs: requestedWait, technicalRetryHandled: true });
  }
}
