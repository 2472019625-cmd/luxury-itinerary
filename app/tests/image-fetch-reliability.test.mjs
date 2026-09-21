import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import sharp from 'sharp';
import { Readable } from 'node:stream';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { extractImageCandidatesFromHtml, fetchImagePageContent, extractPageImages, createImageRetrievalSession } from '../server/page-images.mjs';
import { downloadCandidate } from '../server/image-download.mjs';
import { assertPublicUrl, decodedImageBody, fetchPublicUrl, fetchPublicImageResource, readImageResponse, retryAfterMs } from '../server/public-image-http.mjs';

const origin = 'https://93.184.216.34';
async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'image-fetch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('resized candidates retain publisher URL and fall back when the unsigned resize fails', async (t) => {
  const directory = await temporaryDirectory(t);
  const candidates = extractImageCandidatesFromHtml('<img src="/photo.jpg?w=1400&amp;sig=original" alt="wildebeest river crossing">', { pageUrl: `${origin}/gallery` });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].imageVariants.length, 2);
  const calls = [];
  const buffer = await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#887766' } }).jpeg().toBuffer();
  const result = await downloadCandidate(candidates[0], { directory, publicPrefix: '/fixture', fetchImpl: async (url, { headers }) => {
    calls.push(url); assert.doesNotMatch(headers.get('accept'), /avif/i);
    return new URL(url).searchParams.get('w') === '2400'
      ? new Response('signature mismatch', { status: 403, headers: { 'content-type': 'text/plain' } })
      : new Response(buffer, { headers: { 'content-type': 'image/jpeg' } });
  } });
  assert.equal(calls.length, 2); assert.match(result.downloadedImageUrl, /w=1400/); assert.equal(result.downloadVariantAttempts, 2);
  assert.equal(result.width, 1400);
});

test('AVIF is never advertised and remains outside supported image formats', async (t) => {
  const directory = await temporaryDirectory(t);
  const buffer = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#887766' } }).avif().toBuffer();
  await assert.rejects(downloadCandidate({ imageUrl: `${origin}/photo.avif` }, { directory, publicPrefix: '/fixture', fetchImpl: async (_, { headers }) => {
    assert.equal(headers.get('accept'), 'image/webp,image/png,image/jpeg');
    return new Response(buffer, { headers: { 'content-type': 'image/avif' } });
  } }), /不支持的图片格式/);
});

test('200 and 503 challenge pages stop after one request and never become empty content', async () => {
  for (const status of [200, 503]) {
    let calls = 0;
    await assert.rejects(fetchImagePageContent(`${origin}/gallery`, { fetchImpl: async () => {
      calls += 1; return new Response('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test"></script>', { status, headers: { 'content-type': 'text/html' } });
    } }), (error) => error.code === 'page_access_blocked' && error.challengeDetected);
    assert.equal(calls, 1);
  }
});

test('non-HTML 429 honors bounded Retry-After recovery and does not retry before a long delay', async () => {
  let calls = 0;
  const resource = await fetchPublicImageResource(`${origin}/photo.jpg`, { fetchImpl: async () => ++calls === 1
    ? new Response('{"error":"limited"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } })
    : new Response('ok', { headers: { 'content-type': 'text/plain' } }) });
  assert.equal(calls, 2); assert.equal(resource.buffer.toString(), 'ok');
  calls = 0;
  await assert.rejects(fetchPublicImageResource(`${origin}/photo.jpg`, { fetchImpl: async () => {
    calls += 1; return new Response('limited', { status: 429, headers: { 'retry-after': '3600' } });
  } }), (error) => error.code === 'page_rate_limited' && error.technicalRetryHandled);
  assert.equal(calls, 1);
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:58 GMT')), 2000);
});

test('a stalled body has a deadline and oversized streamed HTML is cancelled while reading', async () => {
  let cancelled = false;
  const hanging = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(readImageResponse(hanging, { timeoutMs: 25 }), (error) => error.code === 'image_fetch_timeout');
  assert.equal(cancelled, true);
  cancelled = false;
  const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(12)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readImageResponse(oversized, { maxBytes: 10 }), (error) => error.code === 'image_body_too_large');
  assert.equal(cancelled, true);
});

test('gzip/br/deflate HTML and scripts decode before parsing; expanded bytes obey the limit', async () => {
  const plain = Buffer.from('<script>document.body.dataset.ready = "yes"</script>');
  for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]]) {
    const compressed = compress(plain); const headers = new Headers({ 'content-encoding': encoding, 'content-length': String(compressed.length) });
    const response = new Response(decodedImageBody(Readable.from([compressed]), headers), { headers });
    assert.equal((await readImageResponse(response)).toString(), plain.toString());
    assert.equal(response.headers.get('content-encoding'), null);
  }
  const expanded = gzipSync(Buffer.alloc(10_000, 65));
  const headers = new Headers({ 'content-encoding': 'gzip' });
  await assert.rejects(readImageResponse(new Response(decodedImageBody(Readable.from([expanded]), headers)), { maxBytes: 500 }), (error) => error.code === 'image_body_too_large');
});

test('cookies stay in one invocation memory, match the request host/path, and never appear on candidates', async (t) => {
  const directory = await temporaryDirectory(t);
  const session = createImageRetrievalSession({ domainIntervalMs: 0 }); t.after(() => session.close());
  await fetchImagePageContent(`${origin}/gallery`, { retrievalSession: session, fetchImpl: async () => new Response('<img src="/photo.jpg">', {
    headers: { 'content-type': 'text/html', 'set-cookie': 'session=private-fixture-value; Path=/; Secure; HttpOnly' },
  }) });
  assert.equal(session.headersFor(`${origin}/photo.jpg`).cookie, 'session=private-fixture-value');
  assert.equal(session.headersFor('https://8.8.8.8/photo.jpg').cookie, undefined);
  assert.equal(session.headersFor('http://93.184.216.34/photo.jpg').cookie, undefined);
  const buffer = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#887766' } }).png().toBuffer();
  const result = await downloadCandidate({ imageUrl: `${origin}/photo.jpg`, pageUrl: `${origin}/gallery` }, { directory, publicPrefix: '/fixture', retrievalSession: session, fetchImpl: async (_, { headers }) => {
    assert.equal(headers.get('cookie'), 'session=private-fixture-value'); assert.equal(headers.get('referer'), `${origin}/gallery`);
    return new Response(buffer, { headers: { 'content-type': 'image/png' } });
  } });
  assert.doesNotMatch(JSON.stringify({ result, diagnostics: session.getDiagnostics(), session }), /private-fixture-value|session=|cookie/i);
  await session.close(); assert.equal(session.headersFor(`${origin}/photo.jpg`).cookie, undefined);
});

test('per-domain acquisition serializes transfers, while different hosts can proceed', async () => {
  const session = createImageRetrievalSession({ domainIntervalMs: 0 });
  const first = await session.acquire(`${origin}/a`); let sameHostEntered = false;
  const same = session.acquire(`${origin}/b`).then((release) => { sameHostEntered = true; return release; });
  const other = await session.acquire('https://8.8.8.8/a');
  assert.equal(sameHostEntered, false); other(); first(); (await same)(); await session.close();
});

test('cancelled domain waiters exit without waiting for the previous transfer', async () => {
  const session = createImageRetrievalSession({ domainIntervalMs: 0 });
  const release = await session.acquire(`${origin}/a`); const controller = new AbortController();
  const waiting = session.acquire(`${origin}/b`, controller.signal); controller.abort(new Error('cancel-test'));
  await assert.rejects(waiting, /cancel-test/); release(); await session.close();
});

test('private, mapped-IP and redirect addresses are rejected before transport', async () => {
  for (const url of ['http://127.0.0.1/photo', 'http://[::ffff:127.0.0.1]/photo', 'http://100.64.0.1/photo', 'https://user:secret@93.184.216.34/photo']) await assert.rejects(assertPublicUrl(url));
  let calls = 0;
  await assert.rejects(fetchPublicUrl(`${origin}/redirect`, { fetchImpl: async () => {
    calls += 1; return new Response(null, { status: 302, headers: { location: 'http://[::ffff:192.168.1.1]/photo' } });
  } }), (error) => error.code === 'public_url_blocked');
  assert.equal(calls, 1);
});

test('DNS validation is part of the request deadline and cannot trigger a late transport', async () => {
  const originalLookup = dns.lookup; let calls = 0;
  dns.lookup = async () => { await new Promise((resolve) => setTimeout(resolve, 60)); return [{ address: '93.184.216.34', family: 4 }]; };
  try {
    await assert.rejects(fetchPublicUrl('https://deadline.fixture.invalid/photo', { timeoutMs: 15, fetchImpl: async () => { calls += 1; return new Response('late'); } }), (error) => error.code === 'image_fetch_timeout');
    assert.equal(calls, 0);
  } finally { dns.lookup = originalLookup; }
});

test('same-page browser fallback is bounded and preserves static candidates if unavailable', async () => {
  let browserCalls = 0;
  const result = await extractPageImages({ pageUrl: `${origin}/gallery` }, {
    loadPage: async () => ({ html: '<img src="/photo.jpg"><script>renderGallery()</script>', responseUrl: `${origin}/gallery` }),
    retrievalSession: { renderPage: async () => { browserCalls += 1; throw Object.assign(new Error('unavailable'), { code: 'browser_unavailable' }); } },
  });
  assert.equal(browserCalls, 1); assert.equal(result.length, 1); assert.equal(result[0].acquisitionMethod, 'http');
});

test('a direct image search result does not promote page title to photo-local alt evidence', async () => {
  const [candidate] = await extractPageImages({ pageUrl: `${origin}/image.jpg`, title: 'Target Hotel Official Gallery' }, { loadPage: async () => ({ directImage: true, responseUrl: `${origin}/image.jpg` }) });
  assert.equal(candidate.alt, ''); assert.equal(candidate.title, 'Target Hotel Official Gallery');
});

test('direct images defer their body to the downloader and do not inherit the smaller HTML limit', async () => {
  let cancelled = false;
  const content = await fetchImagePageContent(`${origin}/image.jpg`, { fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'image/jpeg', 'content-length': '9000000' } }) });
  assert.equal(content.directImage, true); assert.equal(cancelled, true);
});

const chromeAvailable = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].some(existsSync);
test('real browser executes a controlled gallery with all resources mediated, blocks private requests and retires its profile', { skip: !chromeAvailable, timeout: 30_000 }, async (t) => {
  const runtimeDirectory = await temporaryDirectory(t); const requests = [];
  const session = createImageRetrievalSession({ runtimeDirectory, maxBrowserPages: 1, domainIntervalMs: 0, browserTimeoutMs: 15_000, fetchImpl: async (url, { headers }) => {
    requests.push(url);
    if (url.endsWith('/data')) { assert.match(headers.get('cookie') || '', /client=anonymous-test/); return new Response('{"image":"/wildlife.jpg"}', { headers: { 'content-type': 'application/json' } }); }
    if (url.endsWith('/bad-redirect')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    return new Response('<html><body><script>document.cookie="client=anonymous-test; Path=/";fetch("/data").then(r=>r.json()).then(x=>{document.body.insertAdjacentHTML("beforeend",`<figure><img src="${x.image}" alt="wildebeest river crossing"></figure>`)});fetch("http://127.0.0.1/private").catch(()=>{});fetch("/bad-redirect").catch(()=>{});</script></body></html>', { headers: { 'content-type': 'text/html' } });
  } });
  t.after(() => session.close());
  const content = await session.renderPage(`${origin}/gallery`);
  assert.match(content.html, /wildlife\.jpg/); assert.equal(content.acquisitionMethod, 'browser');
  assert.ok(requests.some((url) => url.endsWith('/data')));
  assert.ok(requests.every((url) => new URL(url).hostname === '93.184.216.34'));
  assert.ok(session.getDiagnostics().blockedBrowserRequests >= 1);
  await assert.rejects(session.renderPage(`${origin}/other`), (error) => error.code === 'browser_budget_exhausted');
  assert.equal(session.getDiagnostics().browserPages, 1);
  await session.close(); assert.deepEqual(await readdir(runtimeDirectory), []);
});

test('browser subresource count and concurrent transfers are bounded on a noisy page', { skip: !chromeAvailable, timeout: 30_000 }, async (t) => {
  const runtimeDirectory = await temporaryDirectory(t); let active = 0; let peak = 0; let fetched = 0;
  const session = createImageRetrievalSession({ runtimeDirectory, domainIntervalMs: 0, fetchImpl: async (url) => {
    fetched += 1; active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1;
    if (url.endsWith('/gallery')) return new Response('<html><body><script>for(let i=0;i<70;i++) fetch("https://"+(["93.184.216.34","8.8.8.8","1.1.1.1"][i%3])+"/resource/"+i).catch(()=>{});</script></body></html>', { headers: { 'content-type': 'text/html' } });
    return new Response('ok', { headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
  } });
  t.after(() => session.close());
  await session.renderPage(`${origin}/gallery`);
  assert.ok(fetched <= 40); assert.ok(peak <= 3);
  assert.ok(session.getDiagnostics().failures.browser_resource_budget > 0);
  await session.close(); assert.deepEqual(await readdir(runtimeDirectory), []);
});

test('browser handle survives a failed ownership update and is closed before profile removal', { skip: !chromeAvailable }, async (t) => {
  const runtimeDirectory = await temporaryDirectory(t); let closed = false;
  const session = createImageRetrievalSession({ runtimeDirectory, launchBrowser: async ({ userDataDir }) => {
    const record = path.join(path.dirname(userDataDir), 'ownership.json');
    await rm(record); await mkdir(record); // Controlled disk-write failure after the mock launch.
    return { close: async () => { closed = true; }, process: () => ({ pid: null }) };
  } });
  await assert.rejects(session.renderPage(`${origin}/gallery`));
  await session.close(); assert.equal(closed, true); assert.deepEqual(await readdir(runtimeDirectory), []);
});

test('browser close failure retains its owned directory and does not prevent memory cleanup', { skip: !chromeAvailable }, async (t) => {
  const runtimeDirectory = await temporaryDirectory(t);
  const session = createImageRetrievalSession({ runtimeDirectory, launchBrowser: async () => ({
    createBrowserContext: async () => { throw new Error('context failed'); }, close: async () => { throw new Error('close failed'); }, process: () => ({ pid: null }),
  }) });
  session.rememberResponse(origin, new Headers({ 'set-cookie': 'session=test-private-value; Path=/' }));
  await assert.rejects(session.renderPage(`${origin}/gallery`));
  await session.close();
  assert.equal(session.getDiagnostics().failures.browser_close_failed, 1);
  assert.ok(session.getDiagnostics().retainedRuntimePath.startsWith(runtimeDirectory));
  assert.equal((await readdir(runtimeDirectory)).length, 1);
  assert.equal(session.headersFor(`${origin}/photo.jpg`).cookie, undefined);
});
