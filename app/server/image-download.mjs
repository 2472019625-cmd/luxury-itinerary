import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fetchPublicImageResource, readImageResponse, IMAGE_ACCEPT, IMAGE_USER_AGENT } from './public-image-http.mjs';

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const MAX_IMAGE_PIXELS = 80_000_000;

// These card sizes are the rendered pixels in the 2000px itinerary. A source
// may be cropped to the card, but should not need more than modest enlargement.
const cardDisplaySizes = {
  hotel: { standard: [976, 570], wide: [1180, 620] },
  dining: { standard: [976, 520], wide: [1120, 570] },
  transport: { standard: [976, 470], wide: [1180, 640] },
};
export const MAX_CARD_IMAGE_UPSCALE = 1.35;

// Mirrors the 2000px DAY gallery geometry in styles.css. The renderer checks
// the actual DOM scale after optional cards are removed or rearranged.
const DAY_GALLERY_WIDTH = 1780 - 186;
const DAY_GALLERY_GAP = 42;
const dayFrame = (count, index) => {
  const groupCount = Math.max(1, Math.min(4, Number(count) || 1));
  if (groupCount === 1) return [DAY_GALLERY_WIDTH, DAY_GALLERY_WIDTH * 9 / 16];
  if (groupCount === 3 && index === 2) return [DAY_GALLERY_WIDTH * 0.56, 470];
  const width = (DAY_GALLERY_WIDTH - DAY_GALLERY_GAP) / 2;
  return [width, width * 2 / 3];
};

export function withDayGalleryLayout(slot, visibleSlots = []) {
  if (String(slot?.moduleType || "").toLowerCase() !== "day") return slot;
  const dayIndex = Number(slot.visualContext?.dayIndex);
  const daySlots = visibleSlots.filter((item) => String(item?.moduleType || "").toLowerCase() === "day"
    && Number(item.visualContext?.dayIndex) === dayIndex);
  const position = Math.max(0, daySlots.findIndex((item) => item.slotId === slot.slotId));
  const groupStart = Math.floor(position / 4) * 4;
  return { ...slot, dayCardCount: Math.max(1, daySlots.slice(groupStart, groupStart + 4).length), dayCardIndex: position - groupStart };
}

export function imageResolutionPolicyForSlot(slot = {}) {
  if (String(slot.moduleType || "").toLowerCase() === "day") {
    const [displayWidth, displayHeight] = dayFrame(slot.dayCardCount, slot.dayCardIndex);
    return { minWidth: Math.ceil(displayWidth / MAX_CARD_IMAGE_UPSCALE), minHeight: Math.ceil(displayHeight / MAX_CARD_IMAGE_UPSCALE) };
  }
  const cards = cardDisplaySizes[String(slot.moduleType || "").toLowerCase()];
  if (!cards) return { minWidth: 900, minHeight: 500 };
  const [displayWidth, displayHeight] = slot.displayLayout === "wide" ? cards.wide : cards.standard;
  return {
    minWidth: Math.ceil(displayWidth / MAX_CARD_IMAGE_UPSCALE),
    minHeight: Math.ceil(displayHeight / MAX_CARD_IMAGE_UPSCALE),
  };
}

function technicalImageError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function trustedOrigins(values = []) {
  return new Set((Array.isArray(values) ? values : String(values || "").split(",")).map((value) => {
    try { return new URL(String(value || "").trim()).origin; } catch { return ""; }
  }).filter(Boolean));
}

export async function fetchTrustedKnowledgeUrl(value, { allowedOrigins = [], signal, headers = {}, timeoutMs = 25_000, maxRedirects = 3, fetchImpl = fetch, onRequest } = {}) {
  const allowlist = trustedOrigins(allowedOrigins);
  if (!allowlist.size) throw new Error("知识库图片下载白名单未配置");
  let current = new URL(value).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combinedSignal = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const parsed = new URL(current);
      if (!["http:", "https:"].includes(parsed.protocol) || !allowlist.has(parsed.origin)) throw new Error(`知识库图片地址不在允许列表：${parsed.origin}`);
      onRequest?.(current);
      const response = await fetchImpl(current, { redirect: "manual", headers, signal: combinedSignal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error("知识库重定向响应缺少地址");
      current = new URL(location, current).href;
    }
    throw new Error("知识库图片重定向次数过多");
  } finally { clearTimeout(timer); }
}

export async function downloadCandidate(candidate, options) {
  const variants = candidate.sourceKind === 'knowledge_library' ? [candidate.imageUrl]
    : [...new Set([candidate.imageUrl, ...(Array.isArray(candidate.imageVariants) ? candidate.imageVariants : [])])].slice(0, 3);
  let lastError;
  for (const [index, imageUrl] of variants.entries()) {
    try {
      const downloaded = await downloadVariant({ ...candidate, imageUrl }, options);
      return { ...downloaded, imageUrl: candidate.imageUrl, downloadedImageUrl: imageUrl, downloadVariantAttempts: index + 1 };
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || error.challengeDetected || ['public_url_blocked', 'page_rate_limited', 'page_service_unavailable'].includes(error.code)) break;
    }
  }
  throw lastError;
}

async function downloadVariant(candidate, { directory, publicPrefix, signal, minWidth = 900, minHeight = 500, maxBytes = 14 * 1024 * 1024, onRequest, trustedKnowledgeOrigins = [], fetchImpl = fetch, retrievalSession, timeoutMs = 25_000 }) {
  const isKnowledgeLibrary = candidate.sourceKind === "knowledge_library";
  let buffer;
  if (isKnowledgeLibrary) {
    const response = await fetchTrustedKnowledgeUrl(candidate.imageUrl, {
    allowedOrigins: trustedKnowledgeOrigins,
    headers: { 'user-agent': IMAGE_USER_AGENT, accept: IMAGE_ACCEPT },
    signal,
    timeoutMs,
    fetchImpl,
    onRequest,
    });
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw new Error(`图片下载失败（${response.status}）`); }
    buffer = await readImageResponse(response, { signal, timeoutMs, maxBytes });
  } else {
    const resource = await fetchPublicImageResource(candidate.imageUrl, {
      headers: { 'user-agent': IMAGE_USER_AGENT, accept: IMAGE_ACCEPT },
      signal, timeoutMs, maxBytes, fetchImpl, onRequest, retrievalSession, sourcePageUrl: candidate.pageUrl,
    });
    buffer = resource.buffer;
  }
  if (!buffer.length || buffer.length > maxBytes) throw new Error("图片文件大小不合格");
  const source = sharp(buffer, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, animated: false });
  const metadata = await source.metadata();
  const sourceContentType = metadata.mediaType === 'image/avif' ? 'image/avif' : metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : '';
  if (!sourceContentType || (metadata.pages || 1) !== 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error("不支持的图片格式或多页图片");
  if ((metadata.width || 0) < minWidth || (metadata.height || 0) < minHeight) {
    throw technicalImageError(
      `图片分辨率不足：实际 ${metadata.width || 0}×${metadata.height || 0}，至少需要 ${minWidth}×${minHeight}`,
      "image_resolution_insufficient",
      { actualWidth: metadata.width || 0, actualHeight: metadata.height || 0, minWidth, minHeight },
    );
  }
  const ratio = metadata.width / metadata.height;
  if (ratio < 0.65 || ratio > 3.2) throw new Error("图片比例不适合行程卡片");
  // Preserve the full-resolution original pixels; only the storage encoding
  // changes. Never label AVIF bytes as JPEG or substitute a preview.
  const storedBuffer = sourceContentType === 'image/avif'
    ? await sharp(buffer, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, animated: false }).rotate().jpeg({ quality: 95, mozjpeg: true }).toBuffer()
    : buffer;
  const storedMetadata = await sharp(storedBuffer, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  const contentType = storedMetadata.format === 'jpeg' ? 'image/jpeg' : storedMetadata.format === 'png' ? 'image/png' : storedMetadata.format === 'webp' ? 'image/webp' : '';
  if (!allowedTypes.has(contentType) || (storedMetadata.pages || 1) !== 1) throw new Error("不支持的图片格式");
  if ((storedMetadata.width || 0) < minWidth || (storedMetadata.height || 0) < minHeight) {
    throw technicalImageError(`图片分辨率不足：实际 ${storedMetadata.width || 0}×${storedMetadata.height || 0}，至少需要 ${minWidth}×${minHeight}`,
      "image_resolution_insufficient", { actualWidth: storedMetadata.width || 0, actualHeight: storedMetadata.height || 0, minWidth, minHeight });
  }
  const storedRatio = storedMetadata.width / storedMetadata.height;
  if (storedRatio < 0.65 || storedRatio > 3.2) throw new Error("图片比例不适合行程卡片");
  if (storedBuffer.length > maxBytes) throw new Error("图片文件大小不合格");
  const hash = createHash("sha256").update(storedBuffer).digest("hex");
  const name = `${hash.slice(0, 20)}${extensions[contentType]}`;
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await writeFile(filePath, storedBuffer, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return { ...candidate, filePath, publicUrl: `${publicPrefix}/${name}`, sha256: hash, width: storedMetadata.width, height: storedMetadata.height, bytes: storedBuffer.length, contentType,
    sourceContentType, sourceBytes: buffer.length, sourceFormat: sourceContentType === 'image/avif' ? 'avif' : metadata.format,
    conversion: sourceContentType === 'image/avif' ? 'avif_to_jpeg' : null };
}
