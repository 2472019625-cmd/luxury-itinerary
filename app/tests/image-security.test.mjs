import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { assertPublicUrl, fetchPublicUrl } from '../server/page-images.mjs';
import { downloadCandidate, fetchTrustedKnowledgeUrl, imageResolutionPolicyForSlot, withDayGalleryLayout } from '../server/image-download.mjs';
import { knowledgeOutputToCandidates } from '../server/knowledge-image-search.mjs';
import { reviewCardImageUpscales } from '../server/simple-renderer.mjs';

test('image network boundary rejects local, private and non-http addresses', async () => {
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /协议/);
  await assert.rejects(assertPublicUrl('http://127.0.0.1/a.jpg'), /本地网络|私有网络/);
  await assert.rejects(assertPublicUrl('http://192.168.1.10/a.jpg'), /私有网络/);
});

test('every redirect target is revalidated before it can be fetched', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 302, headers: new Headers({ location: 'http://127.0.0.1/secret' }) }; };
  await assert.rejects(fetchPublicUrl('https://93.184.216.34/start', { fetchImpl }), /本地网络|私有网络/);
  assert.equal(calls, 1);
});

test('knowledge library permits only the exact configured download origin', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 200, headers: new Headers() }; };
  const response = await fetchTrustedKnowledgeUrl('http://192.168.100.210:9000/signed/image.jpg', { allowedOrigins: ['http://192.168.100.210:9000'], fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  await assert.rejects(fetchTrustedKnowledgeUrl('http://192.168.100.210:9001/signed/image.jpg', { allowedOrigins: ['http://192.168.100.210:9000'], fetchImpl }), /不在允许列表/);
  await assert.rejects(fetchTrustedKnowledgeUrl('http://127.0.0.1:9000/secret', { allowedOrigins: ['http://192.168.100.210:9000'], fetchImpl }), /不在允许列表/);
});

test('knowledge library redirects cannot leave the configured origin allowlist', async () => {
  const fetchImpl = async () => ({ status: 302, headers: new Headers({ location: 'http://127.0.0.1:9000/secret' }) });
  await assert.rejects(fetchTrustedKnowledgeUrl('http://192.168.100.210:9000/signed/image.jpg', { allowedOrigins: ['http://192.168.100.210:9000'], fetchImpl }), /不在允许列表/);
});

test('low-resolution knowledge originals report their actual and required dimensions', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-low-resolution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const buffer = await sharp({ create: { width: 521, height: 377, channels: 3, background: '#887766' } }).jpeg().toBuffer();
  const fetchImpl = async () => new Response(buffer, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(buffer.length) } });
  await assert.rejects(
    downloadCandidate(
      { sourceKind: 'knowledge_library', imageUrl: 'http://192.168.100.210:9000/original/giraffe.jpg', title: 'giraffe.jpg' },
      { directory, publicPrefix: '/test', trustedKnowledgeOrigins: ['http://192.168.100.210:9000'], fetchImpl },
    ),
    (error) => error.code === 'image_resolution_insufficient'
      && error.actualWidth === 521
      && error.actualHeight === 377
      && error.minWidth === 900
      && error.minHeight === 500,
  );
});

test('AVIF knowledge original is decoded at full size and stored with its real JPEG MIME and hash', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-avif-original-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#807060' } }).avif().toBuffer();
  const fetched = async () => new Response(original, { status: 200, headers: { 'content-type': 'image/avif' } });
  const result = await downloadCandidate(
    { sourceKind: 'knowledge_library', imageUrl: 'http://192.168.100.210:9000/original/photo.avif', title: 'photo.avif' },
    { directory, publicPrefix: '/test', trustedKnowledgeOrigins: ['http://192.168.100.210:9000'], fetchImpl: fetched },
  );
  assert.match(result.filePath, /\.jpg$/);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.sourceContentType, 'image/avif');
  assert.equal(result.conversion, 'avif_to_jpeg');
  assert.equal(result.sourceBytes, original.length);
  const stored = await readFile(result.filePath);
  assert.deepEqual([result.width, result.height], [1200, 800]);
  assert.equal((await sharp(stored).metadata()).format, 'jpeg');
  assert.equal(result.bytes, stored.length);
  assert.equal(result.sha256.length, 64);
});

test('knowledge discovery retains an AVIF matched original with no declared MIME', () => {
  const output = { results: [{ path: [
    { relation: 'preview', version_id: 'v1', filename: 'preview.jpg', url: 'http://192.168.100.210:9000/preview.jpg' },
    { relation: 'matched_file', version_id: 'v1', filename: 'full.avif', url: 'http://192.168.100.210:9000/full.avif' },
  ] }] };
  const result = knowledgeOutputToCandidates(output, { baseUrl: 'http://192.168.100.210:9000', queryId: 'q1', queryText: 'hotel' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].knowledgeMatchedFile.mimeType, 'image/avif');
});

test('AVIF normalization rejects corrupt, oversized and disguised originals', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-avif-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, publicPrefix: '/test', trustedKnowledgeOrigins: ['http://192.168.100.210:9000'] };
  const candidate = { sourceKind: 'knowledge_library', imageUrl: 'http://192.168.100.210:9000/original/photo.avif' };
  for (const body of [Buffer.from('not an avif'), Buffer.alloc(1025)]) {
    await assert.rejects(downloadCandidate(candidate, { ...options, maxBytes: 1024, fetchImpl: async () => new Response(body, { status: 200 }) }));
  }
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"></svg>');
  await assert.rejects(downloadCandidate(candidate, { ...options, fetchImpl: async () => new Response(svg, { status: 200, headers: { 'content-type': 'image/avif' } }) }), /不支持的图片格式/);
});

test('hotel card resolution follows the rendered crop rather than a fixed 900px width', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hotel-card-resolution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const standard = imageResolutionPolicyForSlot({ moduleType: 'hotel' });
  const wide = imageResolutionPolicyForSlot({ moduleType: 'hotel', displayLayout: 'wide' });
  assert.deepEqual(standard, { minWidth: 723, minHeight: 423 });
  assert.deepEqual(wide, { minWidth: 875, minHeight: 460 });
  assert.deepEqual(imageResolutionPolicyForSlot({ moduleType: 'day', dayCardCount: 2, dayCardIndex: 1 }), { minWidth: 575, minHeight: 384 });
  assert.deepEqual(imageResolutionPolicyForSlot({ moduleType: 'day', dayCardCount: 1, dayCardIndex: 0 }), { minWidth: 1181, minHeight: 665 });
  const buffer = await sharp({ create: { width: 750, height: 750, channels: 3, background: '#887766' } }).jpeg().toBuffer();
  const fetchImpl = async () => new Response(buffer, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(buffer.length) } });
  const candidate = { sourceKind: 'knowledge_library', imageUrl: 'http://192.168.100.210:9000/original/hotel.jpg', title: 'hotel.jpg' };
  const options = { directory, publicPrefix: '/test', trustedKnowledgeOrigins: ['http://192.168.100.210:9000'], fetchImpl };
  const downloaded = await downloadCandidate(candidate, { ...options, ...standard });
  assert.equal(downloaded.width, 750);
  assert.equal(downloaded.height, 750);
  await assert.rejects(downloadCandidate(candidate, { ...options, ...wide }), (error) => error.code === 'image_resolution_insufficient' && error.minWidth === 875);
});

test('automatic DAY download uses the planned paired frame and rejects the same original in a single frame', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'day-card-resolution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const slots = ['primary', 'supporting:1'].map((role) => ({ slotId: `image:day:6:${role}`, moduleType: 'day', visualContext: { dayIndex: 5 } }));
  const pairedPolicy = imageResolutionPolicyForSlot(withDayGalleryLayout(slots[1], slots));
  const singlePolicy = imageResolutionPolicyForSlot(withDayGalleryLayout(slots[1], [slots[1]]));
  const buffer = await sharp({ create: { width: 850, height: 550, channels: 3, background: '#887766' } }).jpeg().toBuffer();
  const candidate = { sourceKind: 'knowledge_library', imageUrl: 'http://192.168.100.210:9000/original/day.jpg', title: 'day.jpg' };
  const options = { directory, publicPrefix: '/test', trustedKnowledgeOrigins: ['http://192.168.100.210:9000'], fetchImpl: async () => new Response(buffer, { status: 200, headers: { 'content-type': 'image/jpeg' } }) };
  assert.equal((await downloadCandidate(candidate, { ...options, ...pairedPolicy })).width, 850);
  await assert.rejects(downloadCandidate(candidate, { ...options, ...singlePolicy }), (error) => error.code === 'image_resolution_insufficient' && error.actualWidth === 850 && error.minWidth === 1181);
});

test('the final 2000px layout blocks a card that becomes too enlarged', () => {
  const layout = { cardImageUpscales: [
    { selector: '[data-edit-path="hotels.0"]', scale: 976 / 750 },
    { selector: '[data-edit-path="hotels.1"]', scale: 1180 / 750 },
    { selector: '[data-edit-path="days.5.spots.0"]', scale: 1594 / 850 },
  ] };
  const finalIssues = reviewCardImageUpscales(layout);
  assert.equal(finalIssues.length, 2);
  assert.equal(finalIssues[0].selector, '[data-edit-path="hotels.1"]');
  assert.equal(finalIssues[0].severity, 'blocker');
  assert.equal(finalIssues[1].selector, '[data-edit-path="days.5.spots.0"]');
  assert.equal(finalIssues[1].severity, 'blocker');
  assert.equal(reviewCardImageUpscales(layout, 'draft')[0].severity, 'warning');
});
