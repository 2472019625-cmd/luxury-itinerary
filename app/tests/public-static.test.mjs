import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { publicCachePolicy, servePublicStatic } from '../server/public-static.mjs';

test('only content addressed public files are immutable', () => {
  for (const file of ['assets/index-ABCdef12.js', 'fonts/web/Test.1234567890abcdef.woff2']) assert.match(publicCachePolicy(file), /immutable/);
  for (const file of ['index.html', 'fonts/A.otf', 'logo-gold.png', 'assets/plain.css', 'image-assets/test.jpg']) assert.doesNotMatch(publicCachePolicy(file), /immutable/);
});
test('static GET, conditional 304 and HEAD', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sheyou-static-test-'));
  const file = path.join(dir, 'logo.svg');
  writeFileSync(file, '<svg/>');
  const server = createServer((req, res) => servePublicStatic(req, res, file, dir, {'.svg':'image/svg+xml'}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/logo.svg`;
    const first = await fetch(url);
    assert.equal(await first.text(), '<svg/>');
    assert.equal(first.headers.get('content-length'), '6');
    const cached = await fetch(url, {headers:{'If-None-Match':first.headers.get('etag')}});
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
    const head = await fetch(url, {method:'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive:true});
  }
});
test('private image route does not use public static cache', () => {
  const source = readFileSync(new URL('../server/agent-planner-app.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/servePublicStatic\(request/g)?.length, 1);
  assert.ok(source.indexOf('return streamFile(response, file)') < source.indexOf('servePublicStatic(request'));
});
