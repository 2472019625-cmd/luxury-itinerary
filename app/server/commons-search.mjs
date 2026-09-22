import { assertPublicUrl, awaitImageWork, fetchPublicImageResource, imageNetworkError, IMAGE_USER_AGENT } from './public-image-http.mjs';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const plainText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function boundedOptions(options) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20_000);
  const deadline = AbortSignal.timeout(timeoutMs);
  return { ...options, timeoutMs, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
}

export function commonsFileTitleFromUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'commons.wikimedia.org' || url.port || url.username || url.password) return null;
    const title = url.pathname.startsWith('/wiki/') ? decodeURIComponent(url.pathname.slice(6))
      : url.pathname === '/w/index.php' ? url.searchParams.get('title') : '';
    if (!/^File:.+/i.test(title || '') || /[|\x00-\x1f]/.test(title) || title.length > 512) return null;
    return `File:${title.slice(5).replace(/_/g, ' ')}`;
  } catch { return null; }
}

async function readCommonsApi(parameters, options = {}) {
  const url = new URL(COMMONS_API);
  url.search = new URLSearchParams({ action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata|mime|mediatype|size', iiurlwidth: '1800', format: 'json', ...parameters });
  const response = await fetchPublicImageResource(url, {
    ...options, maxBytes: 2_000_000, headers: { 'user-agent': IMAGE_USER_AGENT, accept: 'application/json' },
  });
  if (new URL(response.responseUrl).origin !== new URL(COMMONS_API).origin) throw imageNetworkError('commons_api_redirect_mismatch', 'Commons API 跳转到其他来源', { status: response.status, technicalRetryHandled: true });
  let payload;
  try { payload = JSON.parse(response.buffer.toString('utf8')); }
  catch { throw imageNetworkError('commons_api_invalid_json', 'Commons API 未返回有效 JSON', { status: response.status, technicalRetryHandled: true }); }
  if (payload?.error) throw imageNetworkError('commons_api_error', 'Commons API 返回错误', { status: response.status, apiCode: String(payload.error.code || 'unknown').slice(0, 80), technicalRetryHandled: true });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw imageNetworkError('commons_api_invalid_json', 'Commons API 返回结构无效', { status: response.status, technicalRetryHandled: true });
  return payload;
}

function mediaRejection(page) {
  const info = page?.imageinfo?.[0];
  if (!info?.url) return 'commons_imageinfo_missing';
  // Validate the original media, never its JPEG thumbnail. PDFs, SVGs, TIFFs,
  // animations and video posters cannot enter the photographic candidate pool.
  if (!SUPPORTED_MIME.has(String(info.mime).toLowerCase()) || info.mediatype !== 'BITMAP') return 'commons_unsupported_media';
  if (!(Number(info.width) > 0 && Number(info.height) > 0)) return 'commons_dimensions_missing';
  return null;
}

async function commonsCandidate(page, fallbackPageUrl, signal) {
  const info = page.imageinfo[0];
  const meta = info.extmetadata || {};
  const originalImageUrl = (await awaitImageWork(assertPublicUrl(info.url), signal)).href;
  const imageUrl = info.thumburl ? (await awaitImageWork(assertPublicUrl(info.thumburl), signal)).href : originalImageUrl;
  const sourcePageUrl = info.descriptionurl || fallbackPageUrl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title).replace(/%3A/i, ':')}`;
  if (!commonsFileTitleFromUrl(sourcePageUrl)) throw imageNetworkError('commons_source_invalid', 'Commons 图片缺少有效的文件来源页', { technicalRetryHandled: true });
  return {
    title: page.title, pageUrl: sourcePageUrl, imageUrl, originalImageUrl,
    imageVariants: [...new Set([imageUrl, originalImageUrl])],
    summary: plainText(meta.ImageDescription?.value), alt: plainText(meta.ImageDescription?.value) || page.title,
    media: 'Wikimedia Commons', searchRank: Number(page.index) || null, officialHint: false, kind: 'commons', acquisitionMethod: 'commons_api',
    originalMime: info.mime, mediaType: info.mediatype, originalWidth: Number(info.width), originalHeight: Number(info.height), originalBytes: Number(info.size) || null,
    license: plainText(meta.LicenseShortName?.value || meta.UsageTerms?.value), licenseUrl: String(meta.LicenseUrl?.value || ''), creator: plainText(meta.Artist?.value),
  };
}

export async function fetchCommonsFileImage(pageUrl, options = {}) {
  const title = commonsFileTitleFromUrl(pageUrl);
  if (!title) return null;
  options = boundedOptions(options);
  const payload = await readCommonsApi({ titles: title, redirects: '1' }, options);
  const page = Object.values(payload.query?.pages || {})[0];
  const rejection = mediaRejection(page);
  if (rejection) throw imageNetworkError(rejection, rejection === 'commons_unsupported_media' ? 'Commons 原始资源不是受支持的照片格式' : 'Commons 未提供可用图片元数据', {
    status: 200, originalMime: page?.imageinfo?.[0]?.mime || null, mediaType: page?.imageinfo?.[0]?.mediatype || null, technicalRetryHandled: true,
  });
  return commonsCandidate(page, pageUrl, options.signal);
}

export async function searchCommonsImages(query, { count = 12, ...options } = {}) {
  const search = String(query || '').replace(/official photos?/gi, '').trim().slice(0, 120);
  if (!search) return [];
  options = boundedOptions(options);
  const payload = await readCommonsApi({ generator: 'search', gsrsearch: `${search} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(Math.max(1, Math.min(50, Math.floor(Number(count) || 12)))) }, options);
  const pages = Object.values(payload.query?.pages || {}).sort((a, b) => (Number(a.index) || Infinity) - (Number(b.index) || Infinity));
  const candidates = [], diagnostics = [];
  for (const page of pages) {
    const rejection = mediaRejection(page);
    if (rejection) { diagnostics.push({ code: rejection, title: page.title, originalMime: page.imageinfo?.[0]?.mime || null, mediaType: page.imageinfo?.[0]?.mediatype || null }); continue; }
    try { candidates.push(await commonsCandidate(page, null, options.signal)); }
    catch (error) {
      if (options.signal.aborted) throw error;
      diagnostics.push({ code: error.code || 'commons_candidate_invalid', title: page.title });
    }
  }
  return Object.assign(candidates, { diagnostics });
}
