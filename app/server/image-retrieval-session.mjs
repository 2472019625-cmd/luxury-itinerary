import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import { abortableDelay, awaitImageWork, assertPublicUrl, classifyImageHttpResponse, fetchPublicImageResource, imageNetworkError, IMAGE_USER_AGENT } from './public-image-http.mjs';

const executables = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// One invocation owns this object. No cookie/header is enumerable on it or on candidates.
export function createImageRetrievalSession({ signal, runtimeDirectory, maxBrowserPages = 4, browserTimeoutMs = 20_000, domainIntervalMs = 150, launchBrowser = (options) => puppeteer.launch(options), fetchImpl } = {}) {
  const cookies = new Map(); const domains = new Map(); const pages = new Map(); const unavailablePages = new Map();
  const diagnostics = { browserPages: 0, browserFailures: 0, browserRequests: 0, browserBytes: 0, technicalRetries: 0, failures: {}, blockedBrowserRequests: 0 };
  let browserPromise; let browserHandle; let ownedDirectory; let launchAttempted = false; let closed = false; let browserTail = Promise.resolve();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || imageNetworkError('request_cancelled', '图片获取已取消'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const stateFor = (url) => {
    const key = new URL(url).hostname;
    if (!domains.has(key)) domains.set(key, { tail: Promise.resolve(), nextAt: 0, cooldownAt: 0 });
    return domains.get(key);
  };
  const putCookie = (host, item) => {
    if (!item.name || /[\r\n;]/.test(item.name) || /[\r\n]/.test(item.value || '')) return;
    const key = `${host}|${item.path || '/'}|${item.name}`;
    if (item.expires && item.expires <= Date.now()) cookies.delete(key);
    else cookies.set(key, { ...item, host });
  };
  const api = {
    async acquire(url, requestSignal = controller.signal) {
      if (closed) throw imageNetworkError('request_cancelled', '图片获取会话已关闭');
      const state = stateFor(url); const previous = state.tail;
      let release; const held = new Promise((resolve) => { release = resolve; });
      state.tail = previous.catch(() => {}).then(() => held);
      try {
        await awaitImageWork(previous, requestSignal);
        await abortableDelay(Math.max(0, state.nextAt - Date.now(), state.cooldownAt - Date.now()), requestSignal);
        state.nextAt = Date.now() + domainIntervalMs;
        return release;
      } catch (error) { release(); throw error; }
    },
    cooldown(url, ms) { const state = stateFor(url); state.cooldownAt = Math.max(state.cooldownAt, Date.now() + ms); },
    recordFailure(code) { diagnostics.failures[code] = (diagnostics.failures[code] || 0) + 1; },
    recordRetry() { diagnostics.technicalRetries += 1; },
    rememberUnavailablePage(pageUrl, error) {
      const code = error?.code;
      if (code !== 'page_access_blocked' && !(code === 'page_http_error' && /(?:\b404\b|（404）)/.test(String(error?.message || '')))) return false;
      unavailablePages.set(pageUrl, code);
      return true;
    },
    unavailablePageReason(pageUrl) { return unavailablePages.get(pageUrl) || null; },
    headersFor(value, sourcePageUrl) {
      const url = new URL(value); const headers = {};
      const matched = [...cookies.values()].filter((cookie) => cookie.host === url.hostname && (!cookie.secure || url.protocol === 'https:')
        && (!cookie.expires || cookie.expires > Date.now()) && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)));
      if (matched.length) headers.cookie = matched.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      if (sourcePageUrl) {
        try {
          const source = new URL(sourcePageUrl);
          if (['https:', 'http:'].includes(source.protocol) && !(source.protocol === 'https:' && url.protocol === 'http:')) {
            source.username = ''; source.password = ''; source.hash = '';
            headers.referer = source.origin === url.origin ? source.href : `${source.origin}/`;
          }
        } catch {}
      }
      return headers;
    },
    rememberResponse(value, headers) {
      const url = new URL(value);
      for (const entry of headers.getSetCookie?.() || []) {
        const [pair, ...attributes] = entry.split(';'); const separator = pair.indexOf('=');
        if (separator < 1) continue;
        const attrs = Object.fromEntries(attributes.map((attribute) => { const [key, ...rest] = attribute.trim().split('='); return [key.toLowerCase(), rest.join('=')]; }));
        const domain = attrs.domain?.replace(/^\./, '').toLowerCase();
        if (domain && url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
        // Conservative host-only retention, even when the publisher requests a wider Domain.
        const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/';
        putCookie(url.hostname, { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1), path: attrs.path?.startsWith('/') ? attrs.path : defaultPath,
          secure: Object.hasOwn(attrs, 'secure'), expires: attrs['max-age'] !== undefined ? Date.now() + Number(attrs['max-age']) * 1000 : Date.parse(attrs.expires) || null });
      }
    },
    getDiagnostics() { return structuredClone(diagnostics); },
    async renderPage(pageUrl, { onRequest } = {}) {
      if (pages.has(pageUrl)) return pages.get(pageUrl);
      if (diagnostics.browserPages >= maxBrowserPages || closed) throw imageNetworkError('browser_budget_exhausted', '本批同页浏览器获取次数已用完');
      diagnostics.browserPages += 1;
      const operation = browserTail.catch(() => {}).then(() => renderPage(pageUrl, onRequest));
      pages.set(pageUrl, operation); browserTail = operation;
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true; controller.abort(imageNetworkError('request_cancelled', '图片获取会话已结束'));
      await browserTail.catch(() => {});
      const browser = browserHandle || await browserPromise?.catch(() => null);
      let safelyStopped = !launchAttempted;
      if (browser) {
        try { await browser.close(); safelyStopped = true; }
        catch { api.recordFailure('browser_close_failed'); }
      }
      cookies.clear(); domains.clear(); pages.clear(); unavailablePages.clear(); signal?.removeEventListener('abort', abort);
      if (ownedDirectory && safelyStopped) {
        const resolved = path.resolve(ownedDirectory);
        const parent = path.resolve(runtimeDirectory || path.join(process.env.LOCAL_CODEX_RUNTIME_ROOT || path.join(os.tmpdir(), 'codex-runtime'), 'luxury-itinerary', 'image-retrieval'));
        if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('session-')) {
          try { await rm(resolved, { recursive: true, force: true }); }
          catch { api.recordFailure('browser_runtime_cleanup_failed'); diagnostics.retainedRuntimePath = ownedDirectory; }
        }
      } else if (ownedDirectory) diagnostics.retainedRuntimePath = ownedDirectory;
    },
  };

  async function browserInstance() {
    if (!browserPromise) browserPromise = (async () => {
      const executablePath = executables.find(existsSync);
      if (!executablePath) throw imageNetworkError('browser_unavailable', '未找到可用于来源页提取的浏览器');
      const parent = path.resolve(runtimeDirectory || path.join(process.env.LOCAL_CODEX_RUNTIME_ROOT || path.join(os.tmpdir(), 'codex-runtime'), 'luxury-itinerary', 'image-retrieval'));
      await mkdir(parent, { recursive: true });
      ownedDirectory = await mkdtemp(path.join(parent, 'session-'));
      const ownership = { owner: 'image-retrieval-session', purpose: 'ephemeral public-page browser profile', consumers: [], path: ownedDirectory, retirement: 'close after this Image Skill invocation', createdAt: new Date().toISOString() };
      await writeFile(path.join(ownedDirectory, 'ownership.json'), JSON.stringify(ownership));
      launchAttempted = true;
      const browser = await launchBrowser({ executablePath, headless: true, pipe: true, userDataDir: path.join(ownedDirectory, 'profile'),
        // No DIRECT proxy fallback: even an unexpected browser transport cannot
        // leave through Chromium. Allowed resources are fulfilled by Node below.
        args: ['--proxy-server=http://127.0.0.1:0', '--proxy-bypass-list=<-loopback>', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--no-first-run', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      browserHandle = browser;
      await writeFile(path.join(ownedDirectory, 'ownership.json'), JSON.stringify({ ...ownership, consumers: [{ pid: browser.process?.()?.pid || null }] }));
      return browser;
    })();
    return browserPromise;
  }

  async function renderPage(pageUrl, onRequest) {
    let context; let page; let timer;
    const pending = new Set(); let stopped = false;
    const requestController = new AbortController();
    const cancel = () => { stopped = true; requestController.abort(controller.signal.reason); page?.close().catch(() => {}); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      timer = setTimeout(() => { requestController.abort(imageNetworkError('browser_timeout', '来源页浏览器提取超时')); page?.close().catch(() => {}); }, browserTimeoutMs);
      await awaitImageWork(assertPublicUrl(pageUrl), requestController.signal);
      const browser = await awaitImageWork(browserInstance(), requestController.signal);
      context = await browser.createBrowserContext();
      page = await context.newPage();
      await page.setUserAgent(IMAGE_USER_AGENT);
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      let mainFailure = null; let mainStatus = 200; let pageRequestCount = 0;
      let availableBytes = 20_000_000; let laneIndex = 0;
      const networkLanes = Array.from({ length: 3 }, () => Promise.resolve());
      const limitedRequest = async (worker) => {
        const index = laneIndex++ % networkLanes.length;
        const previous = networkLanes[index]; let release;
        const held = new Promise((resolve) => { release = resolve; });
        networkLanes[index] = previous.catch(() => {}).then(() => held);
        let allowance = 0; let consumed = 0;
        try {
          await awaitImageWork(previous, requestController.signal);
          allowance = Math.min(5_000_000, availableBytes);
          if (allowance <= 0) throw imageNetworkError('browser_resource_budget', '来源页提取资源预算已用完');
          availableBytes -= allowance;
          const result = await worker(allowance, (bytes) => {
            consumed += bytes; diagnostics.browserBytes += bytes;
            if (consumed > allowance) throw imageNetworkError('browser_resource_budget', '来源页提取资源预算已用完');
          });
          return result;
        } finally { availableBytes += allowance - consumed; release(); }
      };
      page.on('request', (request) => {
        const work = (async () => {
          if (stopped || requestController.signal.aborted) return request.abort().catch(() => {});
          try {
            pageRequestCount += 1;
            if (pageRequestCount > 40) throw imageNetworkError('browser_resource_budget', '来源页请求数预算已用完');
            if (request.method() !== 'GET') return await request.abort();
            const value = request.url();
            await awaitImageWork(assertPublicUrl(value), requestController.signal);
            const kind = request.resourceType();
            if (['image', 'media', 'font', 'websocket', 'eventsource', 'other'].includes(kind) || (kind === 'document' && request.frame() !== page.mainFrame())) return await request.abort();
            // Include cookies created by ordinary page JS, scoped by Chromium to
            // this anonymous context. They never leave this session as data.
            for (const cookie of await context.cookies()) {
              const host = cookie.domain.replace(/^\./, '');
              if (host === new URL(value).hostname) putCookie(host, { name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: cookie.secure, expires: cookie.expires > 0 ? cookie.expires * 1000 : null });
            }
            const resource = await limitedRequest((maxBytes, onBodyBytes) => {
              diagnostics.browserRequests += 1;
              return fetchPublicImageResource(value, { fetchImpl, retrievalSession: api, signal: requestController.signal, followRedirects: false,
                sourcePageUrl: pageUrl, timeoutMs: 8_000, maxRetryDelayMs: 1_000, maxBytes, onBodyBytes,
                headers: { 'user-agent': IMAGE_USER_AGENT, accept: request.headers().accept || '*/*' }, onRequest });
            });
            if (kind === 'document') mainStatus = resource.status;
            const headers = Object.fromEntries(resource.headers);
            delete headers['content-length']; delete headers['content-encoding'];
            const responseCookies = resource.headers.getSetCookie?.();
            if (responseCookies?.length) headers['set-cookie'] = responseCookies;
            // Browser executes ordinary page JS, but all network is mediated above. These
            // extra restrictions prevent worker/frame/WebSocket transports escaping it.
            headers['content-security-policy'] = `connect-src http: https:; worker-src 'none'; frame-src 'none'; object-src 'none'; ${headers['content-security-policy'] || ''}`;
            await request.respond({ status: resource.status, headers, body: resource.buffer });
          } catch (error) {
            diagnostics.blockedBrowserRequests += 1;
            if (error.code === 'browser_resource_budget') api.recordFailure(error.code);
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) mainFailure = error;
            await request.abort().catch(() => {});
          }
        })();
        pending.add(work); work.finally(() => pending.delete(work)).catch(() => {});
      });
      try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: browserTimeoutMs }); }
      catch (error) { throw mainFailure || requestController.signal.reason || error; }
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.min(2_000, browserTimeoutMs) }).catch(() => {});
      // One bounded scroll exposes ordinary lazy galleries without following links.
      await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 1800)));
      await page.waitForNetworkIdle({ idleTime: 200, timeout: Math.min(1_000, browserTimeoutMs) }).catch(() => {});
      const html = await page.content();
      if (Buffer.byteLength(html) > 5_000_000) throw imageNetworkError('image_body_too_large', '来源页超过提取资源上限');
      const failure = classifyImageHttpResponse(mainStatus, 'text/html', html);
      if (failure) throw imageNetworkError(failure.code, failure.message);
      const responseUrl = (await assertPublicUrl(page.url())).href;
      for (const cookie of await context.cookies()) {
        const host = cookie.domain.replace(/^\./, '');
        putCookie(host, { name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: cookie.secure, expires: cookie.expires > 0 ? cookie.expires * 1000 : null });
      }
      return { html, responseUrl, acquisitionMethod: 'browser' };
    } catch (error) {
      diagnostics.browserFailures += 1; api.recordFailure(error.code || 'browser_failed'); throw error;
    } finally {
      stopped = true; clearTimeout(timer); requestController.abort();
      controller.signal.removeEventListener('abort', cancel);
      await page?.close().catch(() => {});
      await Promise.allSettled([...pending]);
      await context?.close().catch(() => {});
    }
  }
  return api;
}
