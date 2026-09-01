import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeLegacyNotesForDisplay, validateNotesSchema } from '../src/lib/notesSchema.js';

test('new notes require titled groups with a non-empty item array', () => {
  assert.equal(validateNotesSchema(['签证请核对']).valid, false);
  assert.equal(validateNotesSchema([{title:'证件',items:'请核对'}]).valid, false);
  assert.equal(validateNotesSchema([{title:'证件',items:['请在出发前核对护照。'],tone:'gold'}]).valid, true);
});

test('legacy strings are converted for display and explicitly marked for review', () => {
  const result = normalizeLegacyNotesForDisplay(['请核对证件','建议携带外套']);
  assert.equal(result[0].legacyConverted, true);
  assert.deepEqual(result[0].items, ['请核对证件','建议携带外套']);
});

test('customer renderer lists note items instead of joining them into one paragraph', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /group\.items\.map/);
  assert.doesNotMatch(source, /group\.items\.join\(" "\)/);
});
