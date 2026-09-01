import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COPY_RULE_RUNTIME, COPY_RULE_VERSION, copyRuleCardsFor } from '../config/copy-rule-runtime.mjs';

test('COPY-001—COPY-017 each map to prompt, checks, merge, failure and tests', async () => {
  assert.equal(COPY_RULE_RUNTIME.length, 17);
  assert.deepEqual(COPY_RULE_RUNTIME.map((item) => item.id), Array.from({length:17}, (_, index) => `COPY-${String(index + 1).padStart(3,'0')}`));
  for (const item of COPY_RULE_RUNTIME) assert.ok(item.version === COPY_RULE_VERSION && item.fields.length && item.must.length && item.forbid.length && item.evidence.length && item.pass.length && item.stage && item.promptSections.length && item.deterministicChecks.length && item.aiReview && item.merge && item.failure && item.tests.length);
  const generation = await readFile(new URL('../prompts/customer-itinerary-editor-v2.md', import.meta.url), 'utf8');
  const reviewer = await readFile(new URL('../prompts/customer-itinerary-brand-reviewer-v1.md', import.meta.url), 'utf8');
  for (const item of COPY_RULE_RUNTIME) assert.match(generation, new RegExp(item.id));
  assert.match(reviewer, /独立于首轮作者/);
  assert.match(reviewer, /unresolvedIssues/);
});

test('target injection selects only relevant complete rule cards', () => {
  const cards = copyRuleCardsFor(['COPY-006','COPY-010']);
  assert.deepEqual(cards.map((item) => item.id), ['COPY-006','COPY-010']);
  assert.ok(cards.every((item) => item.must.length && item.forbid.length && item.pass.length));
});
