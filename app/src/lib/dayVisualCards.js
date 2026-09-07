export function dayVisualCards(day, dayIndex, bindings) {
  if (!bindings) return (day.spots || []).map((spot, spotIndex) => ({ spot, spotIndex, imageIndex: 0 }));
  return Object.entries(bindings).filter(([, binding]) => binding.module === "day" && binding.dayIndex === dayIndex).flatMap(([slotId, binding]) => {
    const source = day.spots?.[binding.spotIndex];
    if (!source) return [];
    const image = source.images?.[binding.imageIndex];
    if (!binding.required && !image?.src) return [];
    return [{ slotId, spotIndex: binding.spotIndex, imageIndex: binding.imageIndex, spot: {
      ...(binding.useSpotCopy !== false ? source : { description: binding.description || '', status: binding.status || '', statusLabel: binding.statusLabel || '', feeBoundary: binding.feeBoundary || '', reminder: binding.reminder || '' }),
      name: binding.visualSubject || source.name,
      images: image?.src ? [image] : [],
      image: undefined,
    } }];
  });
}
