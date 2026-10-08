import { getSlotImage, setSlotImage } from './imageSlots.js';

export function isStaleManualImagePayload(current, incoming) {
  if (!current || incoming.manualVersion == null) return false;
  const before = Number(current.manualVersion || 0), after = Number(incoming.manualVersion);
  if (after !== before) return after < before;
  if (current.manualRevision && incoming.manualRevision && current.manualRevision !== incoming.manualRevision) return true;
  // The finished check and its pending response share a revision; never go backwards.
  return current.renderPending === false && incoming.renderPending === true;
}

export function mergeManualImageMetadata(current, incoming) {
  if (isStaleManualImagePayload(current, incoming)) return current;
  const merged = { ...current };
  for (const key of ['manualVersion', 'manualRevision', 'renderPending']) if (incoming[key] != null) merged[key] = incoming[key];
  return merged;
}

// Server image responses must not roll back unrelated edits made while searching.
export function mergeManualImagePayload(current, incoming) {
  if (incoming.compactImageResponse) incoming = { ...incoming, project: { ...incoming.project, data: { ...incoming.project.data, imageReview: incoming.imageReview } } };
  if (!current) return incoming;
  if (isStaleManualImagePayload(current, incoming)) return current;
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

// Read the same text the editor displays; visual slots use colon IDs in stored data.
export function manualCopyValue(data, item) {
  const slotId = item.slotId || (item.id?.startsWith('copy:visual:') ? item.id.slice('copy:visual:'.length) : null);
  if (!slotId) return structuredClone(valueAtPath(data, item.targetPath));
  const binding = data.simpleImageSlotBindings?.[slotId];
  if (!binding || binding.module !== 'day') return undefined;
  const spots = data.days?.[binding.dayIndex]?.spots || [];
  const spot = binding.spotId ? spots.find(entry => entry.id === binding.spotId) : spots[binding.spotIndex];
  const description = binding.useSpotCopy !== false ? spot?.experience || spot?.description || '' : binding.cardDescription || binding.description || '';
  if (item.targetPath?.endsWith('.description')) return description;
  return { cardTitle: binding.cardTitle || (binding.useSpotCopy !== false ? spot?.name : '') || '', cardDescription: description };
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
  const targets = incoming.repair?.kind === 'copy_batch'
    ? (incoming.repair.successfulTargets || []).filter(item => item.targetPath)
    : incoming.repair?.kind === 'copy' && incoming.repair.status === 'success' && incoming.repair.targetPath
      ? [incoming.repair]
      : [];
  if (!targets.length) return mergeManualImagePayload(current, incoming);
  const merged = mergeManualImagePayload(current, incoming);
  if (merged === current) return current;
  const data = structuredClone(merged.project.data);
  for (const { targetPath, targetId } of targets) {
    if (targetPath.startsWith('simpleImageSlotBindings.')) {
      // Copy task paths use underscore aliases; persisted bindings use colon
      // slot IDs. Never create a binding at the task path or copy its layout.
      const matches = Object.entries(incoming.project.data.simpleImageSlotBindings || {}).filter(([slotId, binding]) => {
        const root = `simpleImageSlotBindings.${slotId.replace(/:/g, '_')}`;
        return binding?.module === 'day' && (targetPath === root || targetPath === `${root}.description`)
          && (!targetId?.startsWith('copy:visual:') || targetId === `copy:visual:${slotId}`);
      });
      if (matches.length !== 1) continue;
      const [slotId, serverBinding] = matches[0];
      const binding = data.simpleImageSlotBindings?.[slotId];
      if (binding?.module !== 'day') continue;
      const fields = targetPath.endsWith('.description') ? ['description'] : ['cardTitle', 'cardDescription'];
      for (const field of fields) if (typeof serverBinding[field] === 'string') binding[field] = serverBinding[field];
      continue;
    }
    const serverValue = valueAtPath(incoming.project.data, targetPath);
    if (serverValue !== undefined) setValueAtPath(data, targetPath, serverValue);
  }
  return { ...merged, project: { ...merged.project, data } };
}
