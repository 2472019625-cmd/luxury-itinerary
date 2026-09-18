function hashText(value = "") {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function daySpotIdentity(spot = {}, dayIndex = 0, spotIndex = 0) {
  const existing = String(spot.id || "").trim();
  if (existing) return existing;
  const evidence = Array.isArray(spot.sourceEvidence) ? spot.sourceEvidence.join("|") : "";
  return `day-${dayIndex + 1}-spot-${hashText(`${spot.name || ""}|${spot.description || spot.experience || ""}|${evidence}|${spotIndex}`)}`;
}

export function ensureDaySpotIds(day = {}, dayIndex = 0) {
  const used = new Set();
  (day.spots || []).forEach((spot, spotIndex) => {
    const base = daySpotIdentity(spot, dayIndex, spotIndex);
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    spot.id = id;
    used.add(id);
  });
  return day.spots || [];
}

export function createManualDayCard(data, dayIndex, { spotId, slotId } = {}) {
  const day = data.days?.[dayIndex];
  if (!day || !spotId || !slotId) return null;
  day.spots ||= [];
  ensureDaySpotIds(day, dayIndex);
  if (day.spots.some((spot) => String(spot.id || "") === String(spotId))) return null;
  data.simpleImageSlotBindings ||= {};
  if (data.simpleImageSlotBindings[slotId]) return null;

  const spotIndex = day.spots.length;
  const spot = {
    id: spotId,
    name: "新体验卡片",
    description: "",
    reminder: "",
    status: "pending",
    statusLabel: "待确认",
    feeBoundary: "pending",
    sourceEvidence: [],
    userProvided: true,
    images: [],
  };
  day.spots.push(spot);
  data.simpleImageSlotBindings[slotId] = {
    module: "day",
    dayIndex,
    itemIndex: dayIndex,
    spotId,
    spotIndex,
    imageIndex: 0,
    fieldPath: `days.${dayIndex}.spots.${spotIndex}.images.0`,
    useSpotCopy: true,
    required: false,
    manualEditorCard: true,
    editorImageRequired: false,
    editorImageStatus: "等待上传",
    cardTitle: "新体验卡片",
    cardDescription: "",
  };
  return { spot, slotId };
}

export function resolveDaySpotIndex(day = {}, selection = {}) {
  if (selection.spotId) {
    const byId = (day.spots || []).findIndex((spot) => String(spot.id || "") === String(selection.spotId));
    if (byId >= 0) return byId;
  }
  return Number.isInteger(selection.subItemIndex) && day.spots?.[selection.subItemIndex] ? selection.subItemIndex : -1;
}

export function resolveDayPreviewSpotIndex(day = {}, { spotId, slotId, spotIndex } = {}) {
  if (spotId) return resolveDaySpotIndex(day, { spotId, subItemIndex: spotIndex });
  if (slotId) return -1;
  return resolveDaySpotIndex(day, { subItemIndex: spotIndex });
}

export function bindingSpotIdentity(day = {}, binding = {}) {
  if (binding.useSpotCopy === false) return null;
  if (binding.spotId && day.spots?.some((spot) => String(spot.id || "") === String(binding.spotId))) return String(binding.spotId);
  return day.spots?.[binding.spotIndex]?.id || null;
}

function updateBindingLocation(binding, dayIndex, spotIndex, imageIndex = binding.imageIndex || 0) {
  binding.dayIndex = dayIndex;
  binding.itemIndex = dayIndex;
  binding.spotIndex = spotIndex;
  binding.imageIndex = imageIndex;
  binding.fieldPath = Number.isInteger(spotIndex) ? `days.${dayIndex}.spots.${spotIndex}.images.${imageIndex}` : "";
}

export function reorderDaySpots(data, dayIndex, sourceSpotId, targetSpotId) {
  const day = data.days?.[dayIndex];
  if (!day) return false;
  ensureDaySpotIds(day, dayIndex);
  const previous = [...(day.spots || [])];
  const sourceIndex = previous.findIndex((spot) => spot.id === sourceSpotId);
  const targetIndex = previous.findIndex((spot) => spot.id === targetSpotId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;

  const locations = new Map(Object.entries(data.simpleImageSlotBindings || {}).filter(([, binding]) => binding.module === "day" && binding.dayIndex === dayIndex).map(([slotId, binding]) => [slotId, {
    semanticSpotId: bindingSpotIdentity(day, binding),
    storageSpotId: previous[binding.spotIndex]?.id || null,
  }]));
  const [moved] = day.spots.splice(sourceIndex, 1);
  day.spots.splice(targetIndex, 0, moved);

  for (const [slotId, location] of locations) {
    const binding = data.simpleImageSlotBindings[slotId];
    const identity = location.semanticSpotId || location.storageSpotId;
    const nextIndex = day.spots.findIndex((spot) => spot.id === identity);
    if (nextIndex < 0) continue;
    if (location.semanticSpotId) binding.spotId = location.semanticSpotId;
    updateBindingLocation(binding, dayIndex, nextIndex);
  }
  return true;
}

export function deleteDaySpotPreservingSlots(data, dayIndex, spotId) {
  const day = data.days?.[dayIndex];
  if (!day) return null;
  ensureDaySpotIds(day, dayIndex);
  const previous = [...(day.spots || [])];
  const deleteIndex = previous.findIndex((spot) => spot.id === spotId);
  if (deleteIndex < 0) return null;
  const removed = previous[deleteIndex];
  const affected = Object.entries(data.simpleImageSlotBindings || {}).filter(([, binding]) => binding.module === "day" && binding.dayIndex === dayIndex).map(([slotId, binding]) => ({
    slotId,
    binding,
    semanticSpotId: bindingSpotIdentity(day, binding),
    storageSpotId: previous[binding.spotIndex]?.id || null,
    image: previous[binding.spotIndex]?.images?.[binding.imageIndex] || null,
  }));

  day.spots.splice(deleteIndex, 1);
  for (const item of affected) {
    const { binding } = item;
    if (item.semanticSpotId === spotId && binding.manualEditorCard === true) {
      delete data.simpleImageSlotBindings[item.slotId];
      continue;
    }
    if (item.semanticSpotId === spotId) {
      binding.useSpotCopy = false;
      delete binding.spotId;
      if (!Object.hasOwn(binding, "cardTitle")) binding.cardTitle = removed.name || "行程体验";
      if (!Object.hasOwn(binding, "cardDescription")) binding.cardDescription = removed.description || removed.experience || "";
      binding.status = removed.status || binding.status || "pending";
      binding.statusLabel = removed.statusLabel || binding.statusLabel || "待确认";
      binding.feeBoundary = removed.feeBoundary || binding.feeBoundary || binding.status;
      binding.reminder = removed.reminder || binding.reminder || "";
    }

    let anchorIndex = day.spots.findIndex((spot) => spot.id === item.storageSpotId);
    if (anchorIndex < 0) anchorIndex = day.spots.length ? Math.min(deleteIndex, day.spots.length - 1) : -1;
    if (anchorIndex < 0) {
      updateBindingLocation(binding, dayIndex, null, binding.imageIndex || 0);
      continue;
    }
    if (item.storageSpotId === spotId) {
      const images = Array.isArray(day.spots[anchorIndex].images) ? day.spots[anchorIndex].images : [];
      const imageIndex = images.length;
      if (item.image?.src) images[imageIndex] = item.image;
      day.spots[anchorIndex].images = images;
      updateBindingLocation(binding, dayIndex, anchorIndex, imageIndex);
    } else {
      updateBindingLocation(binding, dayIndex, anchorIndex);
    }
  }
  return removed;
}
