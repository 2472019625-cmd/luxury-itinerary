import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicUrl, fetchPublicUrl } from '../server/page-images.mjs';

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
