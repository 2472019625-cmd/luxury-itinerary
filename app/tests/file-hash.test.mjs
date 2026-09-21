import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { sha256Bytes, sha256File } from '../src/lib/fileHash.js';

test('Excel file fingerprints are the same with and without Web Crypto', async () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 1024, 1024 * 1024 + 17]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await sha256Bytes(bytes, null), expected, `HTTP fallback, ${length} bytes`);
    assert.equal(await sha256Bytes(bytes, webcrypto.subtle), expected, `Web Crypto, ${length} bytes`);
  }
});

test('file hashing reads bytes once and returns the same persisted fingerprint', async () => {
  const bytes = new TextEncoder().encode('行程报价单.xlsx\0binary');
  let reads = 0;
  const file = { arrayBuffer: async () => { reads++; return bytes.buffer; } };
  assert.equal(await sha256File(file), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(reads, 1);
});
