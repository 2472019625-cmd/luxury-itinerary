import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { commonsFileTitleFromUrl, fetchCommonsFileImage, searchCommonsImages } from '../server/commons-search.mjs';
import { extractPageImages, fetchImagePageContent } from '../server/page-images.mjs';

const fileUrl = 'https://commons.wikimedia.org/wiki/File:Great_Rift_Valley.jpg';
const imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Great_Rift_Valley.jpg';
const publicDns = t => t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const photo = (overrides = {}, pageOverrides = {}) => ({
  pageid: 900, index: 1, title: 'File:Great Rift Valley.jpg', ...pageOverrides,
  imageinfo: [{ url: imageUrl, descriptionurl: fileUrl, mime: 'image/jpeg', mediatype: 'BITMAP', width: 2400, height: 1400, size: 300000,
    extmetadata: { ImageDescription: { value: '<p>Rift Valley photographed from a viewpoint</p>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }, Artist: { value: '<a href="/User:Example">Example photographer</a>' } }, ...overrides }],
});
const payload = (...pages) => ({ query: { pages: Object.fromEntries(pages.map(page => [page.pageid, page])) } });

test('Commons File routing requires the exact public host and one File title', () => {
  assert.equal(commonsFileTitleFromUrl(fileUrl), 'File:Great Rift Valley.jpg');
  assert.equal(commonsFileTitleFromUrl('https://commons.wikimedia.org/w/index.php?title=File%3AVolcano.jpg'), 'File:Volcano.jpg');
  for (const url of ['https://commons.wikimedia.org.evil.test/wiki/File:a.jpg', 'https://user@commons.wikimedia.org/wiki/File:a.jpg', 'https://commons.wikimedia.org:8080/wiki/File:a.jpg', 'file://commons.wikimedia.org/wiki/File:a.jpg', 'https://commons.wikimedia.org/wiki/Category:Valley', 'https://commons.wikimedia.org/wiki/File:a.jpg%7CFile:b.jpg']) assert.equal(commonsFileTitleFromUrl(url), null);
});

test('Commons API search preserves API ranking and image-level attribution', async t => {
  publicDns(t);
  let requests = 0;
  const results = await searchCommonsImages('valley official photos', { count: 6, fetchImpl: async url => {
    requests += 1;
    const params = new URL(url).searchParams;
    assert.equal(params.get('gsrsearch'), 'valley filetype:bitmap');
    assert.match(params.get('iiprop'), /mediatype/);
    return jsonResponse(payload(photo({}, { pageid: 100, index: 2 }), photo({}, { pageid: 900, index: 1 })));
  } });
  assert.equal(requests, 1);
  assert.deepEqual(results.map(item => item.searchRank), [1, 2]);
  assert.equal(results[0].originalMime, 'image/jpeg');
  assert.equal(results[0].originalWidth, 2400);
  assert.equal(results[0].creator, 'Example photographer');
  assert.equal(results[0].license, 'CC BY-SA 4.0');
  assert.equal(results[0].acquisitionMethod, 'commons_api');
  assert.equal(results[0].officialHint, false);
});

test('original PDF/SVG/TIFF/video media are filtered even when thumbnails are JPEG', async t => {
  publicDns(t);
  const pages = [['application/pdf', 'OFFICE'], ['image/svg+xml', 'DRAWING'], ['image/tiff', 'BITMAP'], ['video/webm', 'VIDEO']].map(([mime, mediatype], i) => photo({ mime, mediatype, thumburl: `${imageUrl}?page=1`, thumbmime: 'image/jpeg' }, { pageid: i + 1, index: i + 1 }));
  const results = await searchCommonsImages('valley', { fetchImpl: async () => jsonResponse(payload(...pages, photo())) });
  assert.equal(results.length, 1);
  assert.equal(results.diagnostics.length, 4);
  assert.ok(results.diagnostics.every(item => item.code === 'commons_unsupported_media'));
});

test('a search-result File page gets its photograph through imageinfo without HTML or image downloads', async t => {
  publicDns(t);
  const requests = [];
  const candidates = await extractPageImages({ pageUrl: fileUrl, title: 'Unverified search-result title' }, { fetchImpl: async url => {
    requests.push(String(url));
    assert.equal(new URL(url).pathname, '/w/api.php');
    assert.equal(new URL(url).searchParams.get('titles'), 'File:Great Rift Valley.jpg');
    return jsonResponse(payload(photo()));
  } });
  assert.equal(requests.length, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].imageUrl, imageUrl);
  assert.equal(candidates[0].pageUrl, fileUrl);
  assert.equal(candidates[0].title, 'File:Great Rift Valley.jpg');
  assert.doesNotMatch(candidates[0].alt, /Unverified/);
});

test('unsupported Commons originals do not fall back to a rendered JPEG from HTML', async t => {
  publicDns(t);
  let requests = 0;
  await assert.rejects(fetchImagePageContent(fileUrl, { fetchImpl: async () => {
    requests += 1;
    return jsonResponse(payload(photo({ mime: 'application/pdf', mediatype: 'OFFICE', thumburl: `${imageUrl}?page=1` })));
  } }), error => error.code === 'commons_unsupported_media' && error.originalMime === 'application/pdf');
  assert.equal(requests, 1);
});

test('missing or invalid API metadata permits one ordinary HTML fallback with diagnostic evidence', async t => {
  publicDns(t);
  for (const apiResponse of [() => jsonResponse({ query: { pages: { '-1': { missing: '', title: 'File:Great Rift Valley.jpg' } } } }), () => new Response('invalid JSON', { headers: { 'content-type': 'application/json' } })]) {
    let requests = 0;
    const content = await fetchImagePageContent(fileUrl, { fetchImpl: async () => ++requests === 1 ? apiResponse() : new Response(`<img src="${imageUrl}">`, { headers: { 'content-type': 'text/html' } }) });
    assert.equal(requests, 2);
    assert.equal(content.acquisitionMethod, 'http');
    assert.ok(content.commonsApiFailure.code.startsWith('commons_'));
    assert.equal(content.commonsApiFailure.status, 200);
    assert.match(content.html, /img/);
  }
});

test('API blocks and rate limits remain terminal, never retried through a File HTML page', async t => {
  publicDns(t);
  for (const status of [200, 403, 429]) {
    let requests = 0;
    await assert.rejects(fetchImagePageContent(fileUrl, { fetchImpl: async () => {
      requests += 1;
      return new Response(status === 429 ? 'limited' : '<h1>Verify you are human</h1>', { status, headers: { 'content-type': 'text/html', 'retry-after': '3600' } });
    } }), error => error.status === status && (error.code === 'page_access_blocked' || error.code === 'page_rate_limited'));
    assert.equal(requests, 1);
  }
});

test('API redirects and returned original/thumbnail URLs retain the public-network boundary', async t => {
  publicDns(t);
  for (const response of [() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }), () => jsonResponse(payload(photo({ url: 'http://192.168.1.2/photo.jpg' }))), () => jsonResponse(payload(photo({ thumburl: 'http://127.0.0.1/thumbnail.jpg' })))]) {
    let requests = 0;
    await assert.rejects(fetchImagePageContent(fileUrl, { fetchImpl: async () => { requests += 1; return response(); } }), error => error.code === 'public_url_blocked');
    assert.equal(requests, 1);
  }
});

test('Commons API failures are surfaced instead of looking like a successful empty search', async t => {
  publicDns(t);
  await assert.rejects(searchCommonsImages('valley', { fetchImpl: async () => new Response('missing', { status: 404 }) }), error => error.code === 'page_http_error' && error.status === 404);
  await assert.rejects(searchCommonsImages('valley', { fetchImpl: async () => jsonResponse({ error: { code: 'maxlag' } }) }), error => error.code === 'commons_api_error' && error.apiCode === 'maxlag');
});

test('Commons metadata reads keep the body-size limit and cancellation deadline', async t => {
  publicDns(t);
  await assert.rejects(fetchCommonsFileImage(fileUrl, { fetchImpl: async () => new Response('{}', { headers: { 'content-length': '2000001' } }) }), error => error.code === 'image_body_too_large');
  let cancelled = false;
  await assert.rejects(fetchCommonsFileImage(fileUrl, { timeoutMs: 25, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) }), error => error.name === 'TimeoutError' || error.code === 'image_fetch_timeout');
  assert.equal(cancelled, true);
});
