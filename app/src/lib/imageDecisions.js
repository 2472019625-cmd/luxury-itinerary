export function recordImageDecision(data, decision) {
  const entry = {
    id: decision.id || `image-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    slotId: decision.slotId,
    action: decision.action,
    source: decision.source || 'user',
    candidateId: decision.candidateId || null,
    sourceSlotId: decision.sourceSlotId || null,
    fileName: decision.fileName || null,
    decidedAt: decision.decidedAt || Date.now(),
    locked: true,
  };
  data.imageDecisions = [...(data.imageDecisions || []), entry];
  return entry;
}
