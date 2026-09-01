import assert from 'node:assert/strict';
import test from 'node:test';
import { generationCompletionGate, monotonicProgress } from '../server/workflow-state.mjs';
import { humanReviewReady, recordHumanReview } from '../src/lib/humanReview.js';

test('generation cannot complete after copy or before final 2000px QA', () => {
  assert.deepEqual(generationCompletionGate({ copy: {} }).missing, ['blueprint','images','final_review']);
  assert.equal(generationCompletionGate({ copy: {}, blueprint: {}, images: {}, finalReview: { outputQa: { passed: false } } }).complete, false);
  assert.equal(generationCompletionGate({ copy: {}, blueprint: {}, images: {}, finalReview: { failed: true } }).complete, false);
  assert.equal(generationCompletionGate({ copy: {}, blueprint: {}, images: {}, finalReview: {} }).complete, false);
  assert.equal(generationCompletionGate({ copy: { contentQuality: { passed: true, status: 'passed' } }, blueprint: {}, images: {}, finalReview: { outputQa: { passed: true } } }).complete, true);
  const pending = generationCompletionGate({ copy: { contentQuality: { passed: false, needsReview: true, status: 'needs_copy_revision' } }, blueprint: {}, images: {}, finalReview: { outputQa: { passed: true } } });
  assert.equal(pending.complete, false);
  assert.equal(pending.state, 'needs_copy_revision');
  const blocked = generationCompletionGate({ copy: { contentQuality: { passed: false, blocked: true, hardIssueCount: 1 } }, blueprint: {}, images: {}, finalReview: { outputQa: { passed: true } } });
  assert.equal(blocked.state, 'blocked_generation');
});

test('post-editor aesthetic and license decisions are recorded before formal export', () => {
  let review = recordHumanReview({}, 'aestheticConfirmed', true, 'user-1', 10);
  assert.equal(humanReviewReady(review), false);
  review = recordHumanReview(review, 'licenseReviewed', true, 'user-1', 11);
  assert.equal(humanReviewReady(review), true);
  assert.equal(review.reviewerId, 'user-1');
  assert.equal(review.updatedAt, 11);
});

test('progress is monotonic and reserved below 100 until completion', () => {
  assert.equal(monotonicProgress(65, 40), 65);
  assert.equal(monotonicProgress(98, 105), 99);
  assert.equal(monotonicProgress(98, 20, true), 100);
});
