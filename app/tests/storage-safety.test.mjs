import assert from 'node:assert/strict';
import test from 'node:test';
import { safeWriteStorage, storageRisk } from '../src/lib/storageSafety.js';

test('storage precheck rejects oversized data before replacing the prior saved value', () => {
  const values = new Map([['project', 'previous']]);
  const storage = { setItem: (key, value) => values.set(key, value) };
  const result = safeWriteStorage(storage, 'project', { huge: 'x'.repeat(2000) }, 100);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'capacity_precheck');
  assert.equal(values.get('project'), 'previous');
});

test('quota failures are explicit and current persisted value remains recoverable', () => {
  const storage = { setItem() { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } };
  const result = safeWriteStorage(storage, 'project', { title: 'safe' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'quota_exceeded');
  assert.match(result.message, /尚未持久保存/);
  assert.equal(storageRisk({ image: 'data:image/png;base64,AAAA' }).dataUrlBytes, 3);
});
