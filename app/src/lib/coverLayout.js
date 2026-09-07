// Presentation-only values. Never persisted into itinerary data or image slots.
export function coverLayout(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { displayMode: "portrait", aspectRatio: null };
  }
  const ratio = width / height;
  if (ratio < 1.2 && ratio > 1 / 1.2) {
    return { displayMode: "portrait", aspectRatio: null };
  }
  if (ratio < 1.2) {
    return { displayMode: "portrait", aspectRatio: null };
  }
  return { displayMode: "landscape", aspectRatio: `${width} / ${height}` };
}
