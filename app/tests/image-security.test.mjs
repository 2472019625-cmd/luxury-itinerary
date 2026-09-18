import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { assertPublicUrl, fetchPublicUrl } from '../server/page-images.mjs';
import { downloadCandidate, fetchTrustedKnowledgeUrl } from '../server/image-download.mjs';

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
