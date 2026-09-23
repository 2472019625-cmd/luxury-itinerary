import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSimpleRendererOrigin } from '../server/simple-renderer-runtime.mjs';

test('render origin is checked before a long generation and rejects an unavailable page', async () => {
  const fetchImpl = async () => new Response('请先运行 npm run build', { status: 503, headers: { 'content-type': 'text/plain' } });
  await assert.rejects(assertSimpleRendererOrigin('http://127.0.0.1:4180', { fetchImpl }), { code: 'renderer_origin_unavailable' });
  const ready = await assertSimpleRendererOrigin('http://127.0.0.1:4180', { fetchImpl: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.equal(ready.origin, 'http://127.0.0.1:4180');
  await assert.rejects(assertSimpleRendererOrigin('file:///tmp/index.html'), { code: 'renderer_origin_invalid' });
});
