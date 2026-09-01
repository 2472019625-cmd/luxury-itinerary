export const GENERATION_STAGES = Object.freeze(['copy','blueprint','images','searching','auditing','allocating','final_review']);

export function generationCompletionGate(results = {}) {
  const missing = [];
  if (!results.copy) missing.push('copy');
  if (!results.blueprint) missing.push('blueprint');
  if (!results.images) missing.push('images');
  if (!results.finalReview || results.finalReview.failed) missing.push('final_review');
  if (results.finalReview && results.finalReview?.outputQa?.passed !== true) missing.push('final_output_qa');
  const quality = results.copy?.contentQuality || results.copy?.data?.copyQuality || {};
  const blocked = quality.blocked === true || quality.status === 'blocked_generation' || Number(quality.hardIssueCount || 0) > 0;
  const needsRevision = !blocked && (quality.needsReview === true || quality.status === 'needs_copy_revision' || quality.status === 'needs_final_review' || quality.passed !== true);
  const stagesComplete = missing.length === 0;
  const state = !stagesComplete ? 'incomplete' : blocked ? 'blocked_generation' : needsRevision ? 'needs_copy_revision' : 'complete';
  return { complete: state === 'complete', stagesComplete, blocked, needsRevision, state, missing };
}

export function monotonicProgress(current, requested, completed = false) {
  if (completed) return 100;
  return Math.max(0, Math.min(99, Math.max(Number(current) || 0, Number(requested) || 0)));
}
