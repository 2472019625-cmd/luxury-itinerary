import { bindingSpotIdentity, daySpotIdentity } from './dayEditorState.js';

export function dayVisualCards(day, dayIndex, bindings, { includeUnboundSpots = false } = {}) {
  if (!bindings) return (day.spots || []).map((spot, spotIndex) => ({ spot, spotId: daySpotIdentity(spot, dayIndex, spotIndex), spotIndex, imageIndex: 0, cardKind: 'experience' }));
  const boundSpotIds = new Set();
  const cards = Object.entries(bindings).filter(([, binding]) => binding.module === "day" && binding.dayIndex === dayIndex).flatMap(([slotId, binding]) => {
    const spotId = bindingSpotIdentity(day, binding);
    const resolvedSpotIndex = spotId ? day.spots?.findIndex((spot) => String(spot.id || '') === spotId) : binding.spotIndex;
    const source = Number.isInteger(resolvedSpotIndex) ? day.spots?.[resolvedSpotIndex] : null;
    if (!source) return [];
    const image = source.images?.[binding.imageIndex];
    if (!binding.required && !image?.src) return [];
    const usesExperience = binding.useSpotCopy !== false;
    if (usesExperience && spotId) boundSpotIds.add(spotId);
    return [{ slotId, spotId: usesExperience ? spotId : null, spotIndex: resolvedSpotIndex, imageIndex: binding.imageIndex, cardKind: usesExperience ? 'experience' : 'visual', spot: {
      ...(usesExperience ? source : { description: binding.description || '', status: binding.status || '', statusLabel: binding.statusLabel || '', feeBoundary: binding.feeBoundary || '', reminder: binding.reminder || '' }),
      name: usesExperience ? source.name : binding.cardTitle || '行程体验',
      description: usesExperience ? source.experience || source.description || '' : binding.cardDescription || binding.description || '',
      experience: undefined,
      images: image?.src ? [image] : [],
      image: undefined,
    } }];
  });
  const unbound = (day.spots || []).flatMap((spot, spotIndex) => {
    const spotId = daySpotIdentity(spot, dayIndex, spotIndex);
    if (boundSpotIds.has(spotId)) return [];
    if (!includeUnboundSpots) return [];
    return [{ spot, spotId, spotIndex, imageIndex: 0, slotId: null, cardKind: 'experience' }];
  });
  return [...cards, ...unbound];
}
