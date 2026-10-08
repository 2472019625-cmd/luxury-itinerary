import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, MAX_IMAGE_BYTES } from '../src/lib/imageTechnicalPolicy.js';

// One resource ceiling for downloaded originals, picker adoption and uploads.
export { MAX_IMAGE_PIXELS, MAX_IMAGE_BYTES };
export const SAFE_IMAGE_DECODE_OPTIONS = Object.freeze({ failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS, animated: false });

export function imageDecodeError(error) {
  if (/exceeds pixel limit/i.test(error?.message || '')) return Object.assign(new Error('图片超过8000万像素的安全处理上限，请缩小原图后重试'), { code: 'image_pixel_limit_exceeded' });
  return error;
}

export async function decodeSafeImage(input) {
  try {
    const metadata = await sharp(input, SAFE_IMAGE_DECODE_OPTIONS).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1 || !metadata.width || !metadata.height) {
      throw Object.assign(new Error('仅支持单张 JPEG、PNG 或 WebP 图片'), { code: 'image_format_unsupported' });
    }
    // Evaluate every pixel without materializing a 80MP raw Buffer in JS.
    // Metadata alone cannot detect a truncated/corrupt image body.
    await sharp(input, SAFE_IMAGE_DECODE_OPTIONS).stats();
    return metadata;
  } catch (error) { throw imageDecodeError(error); }
}
