import { getSlotImage, setSlotImage } from './imageSlots.js';

// Server image responses must not roll back unrelated edits made while searching.
export function mergeManualImagePayload(current, incoming) {
  if (!current) return incoming;
  if (Number(incoming.manualVersion || 0) < Number(current.manualVersion || 0)) return current;
  const data = structuredClone(current.project.data);
  for (const binding of Object.values(incoming.project.data.simpleImageSlotBindings || {})) {
    setSlotImage(data, binding, getSlotImage(incoming.project.data, binding));
  }
  for (const key of ['imageCandidates', 'imageReview', 'simpleImageSlotBindings', 'generationIssues', 'requiredImageGate', 'imageLocks']) data[key] = incoming.project.data[key];
  return { ...incoming, project: { ...current.project, ...incoming.project, data } };
}
