const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizedCrop(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const x = Number(crop.x), y = Number(crop.y), width = Number(crop.width), height = Number(crop.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 1 || height > 1) return null;
  return { x: clamp(x, 0, 1 - width), y: clamp(y, 0, 1 - height), width, height };
}

export function initialCrop(imageWidth, imageHeight, targetRatio, focus = '50% 50%') {
  if (!(imageWidth > 0 && imageHeight > 0 && targetRatio > 0)) return null;
  const imageRatio = imageWidth / imageHeight;
  const width = Math.min(1, targetRatio / imageRatio);
  const height = Math.min(1, imageRatio / targetRatio);
  const [fx = 50, fy = 50] = String(focus).match(/[\d.]+/g)?.map(Number) || [];
  return { x: (1 - width) * clamp(fx / 100, 0, 1), y: (1 - height) * clamp(fy / 100, 0, 1), width, height };
}

export function fitCropToRatio(crop, imageWidth, imageHeight, targetRatio) {
  const value = normalizedCrop(crop);
  if (!value || !(imageWidth > 0 && imageHeight > 0 && targetRatio > 0)) return null;
  const desired = targetRatio / (imageWidth / imageHeight);
  let width = value.width, height = width / desired;
  if (height > 1) { height = 1; width = desired; }
  const cx = value.x + value.width / 2, cy = value.y + value.height / 2;
  return { x: clamp(cx - width / 2, 0, 1 - width), y: clamp(cy - height / 2, 0, 1 - height), width, height };
}

export function cropImageStyle(crop, imageWidth, imageHeight, viewportWidth, viewportHeight) {
  if (!(viewportWidth > 0 && viewportHeight > 0)) return null;
  const value = fitCropToRatio(crop, imageWidth, imageHeight, viewportWidth / viewportHeight);
  if (!value) return null;
  const scale = Math.max(viewportWidth / (imageWidth * value.width), viewportHeight / (imageHeight * value.height));
  const width = imageWidth * scale, height = imageHeight * scale;
  return {
    position: 'absolute', inset: 'auto', maxWidth: 'none', width: `${width}px`, height: `${height}px`,
    aspectRatio: 'auto', objectFit: 'fill', objectPosition: 'center',
    left: `${viewportWidth / 2 - (value.x + value.width / 2) * width}px`,
    top: `${viewportHeight / 2 - (value.y + value.height / 2) * height}px`,
  };
}
