import { createHash } from 'node:crypto';

export function createCopyResearchStateStore({ store, projectId, executionRunId }) {
  if (!store?.getEvidence || !store?.saveEvidence || !store?.claimEvidence || !projectId || !executionRunId) throw new Error('事实研究缺少可持久化的执行身份');
  const evidenceId = (key) => `copy-facts-state-${createHash('sha256').update(String(key)).digest('hex')}`;
  const load = (key) => store.getEvidence(projectId, executionRunId, evidenceId(key));
  const save = (key, patch = {}) => {
    const current = load(key) || { key, claims: {} };
    const next = { ...current, ...patch, key, claims: current.claims || {}, updatedAt: new Date().toISOString() };
    store.saveEvidence(projectId, executionRunId, evidenceId(key), next);
    return next;
  };
  const claim = (key, phase) => {
    if (!['main', 'supplement'].includes(phase)) throw new Error('未知事实研究阶段');
    const current = load(key) || { key, claims: {} };
    const markerId = `${evidenceId(key)}-${phase}-claim`;
    const marker = { key, phase, claimedAt: new Date().toISOString() };
    if (!store.claimEvidence(projectId, executionRunId, markerId, marker)) {
      return { claimed: false, state: { ...current, claims: { ...current.claims, [phase]: current.claims?.[phase] || marker.claimedAt } } };
    }
    const next = { ...current, claims: { ...current.claims, [phase]: new Date().toISOString() }, updatedAt: new Date().toISOString() };
    // The separate wx marker claims the call across processes before any request.
    store.saveEvidence(projectId, executionRunId, evidenceId(key), next);
    return { claimed: true, state: next };
  };
  return { load, claim, save };
}
