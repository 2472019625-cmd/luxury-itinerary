import { getSlotImage, setSlotImage } from './imageSlots.js';

// Server image responses must not roll back unrelated edits made while searching.
export function mergeManualImagePayload(current, incoming) {
  if (!current) return incoming;
  if (Number(incoming.manualVersion || 0) < Number(current.manualVersion || 0)) return current;
  const data = structuredClone(current.project.data);
  for (const binding of Object.values(incoming.project.data.simpleImageSlotBindings || {})) {
    setSlotImage(data, binding, getSlotImage(incoming.project.data, binding));
  }
  for (const key of ['imageCandidates', 'imageReview', 'generationIssues', 'requiredImageGate', 'imageLocks']) data[key] = incoming.project.data[key];
  const currentBindings = current.project.data.simpleImageSlotBindings || {};
  data.simpleImageSlotBindings = Object.fromEntries(Object.entries(incoming.project.data.simpleImageSlotBindings || {}).map(([slotId, binding]) => {
    const currentBinding = currentBindings[slotId] || {};
    const merged = { ...binding };
    for (const key of ['spotId', 'spotIndex', 'imageIndex', 'fieldPath', 'useSpotCopy', 'cardTitle', 'cardDescription', 'status', 'statusLabel', 'feeBoundary', 'reminder', 'manualEditorCard', 'required', 'editorImageRequired', 'editorImageStatus']) {
      if (Object.hasOwn(currentBinding, key)) merged[key] = currentBinding[key];
    }
    return [slotId, merged];
  }));
  return { ...incoming, project: { ...current.project, ...incoming.project, data } };
}

function pathParts(targetPath = '') {
  return String(targetPath).split('.').filter(Boolean).map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function valueAtPath(root, targetPath) {
  return pathParts(targetPath).reduce((value, part) => value?.[part], root);
}

function setValueAtPath(root, targetPath, value) {
  const parts = pathParts(targetPath);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (cursor?.[part] == null) return false;
    cursor = cursor[part];
  }
  if (!parts.length || cursor == null) return false;
  cursor[parts.at(-1)] = structuredClone(value);
  return true;
}

// A targeted copy retry may finish while the designer is editing elsewhere.
// Apply only the repaired field and server gate metadata; keep every unrelated local edit.
export function mergeTargetedRepairPayload(current, incoming) {
  if (!current) return incoming;
  const targetPaths = incoming.repair?.kind === 'copy_batch'
    ? (incoming.repair.successfulTargets || []).map((item) => item.targetPath).filter(Boolean)
    : incoming.repair?.kind === 'copy' && incoming.repair.status === 'success' && incoming.repair.targetPath
      ? [incoming.repair.targetPath]
      : [];
  if (!targetPaths.length) return mergeManualImagePayload(current, incoming);
  const merged = mergeManualImagePayload(current, incoming);
  const data = structuredClone(merged.project.data);
  for (const targetPath of targetPaths) {
    const serverValue = valueAtPath(incoming.project.data, targetPath);
    setValueAtPath(data, targetPath, serverValue);
  }
  return { ...merged, project: { ...merged.project, data } };
}
