import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fetchPublicImageResource, readImageResponse, IMAGE_ACCEPT, IMAGE_USER_AGENT } from './public-image-http.mjs';

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

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
  const metadata = await sharp(buffer, { failOn: "warning" }).metadata();
  const contentType = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : '';
  if (!allowedTypes.has(contentType)) throw new Error("不支持的图片格式");
  if ((metadata.width || 0) < minWidth || (metadata.height || 0) < minHeight) {
    throw technicalImageError(
      `图片分辨率不足：实际 ${metadata.width || 0}×${metadata.height || 0}，至少需要 ${minWidth}×${minHeight}`,
      "image_resolution_insufficient",
      { actualWidth: metadata.width || 0, actualHeight: metadata.height || 0, minWidth, minHeight },
    );
  }
  const ratio = metadata.width / metadata.height;
  if (ratio < 0.65 || ratio > 3.2) throw new Error("图片比例不适合行程卡片");
  const hash = createHash("sha256").update(buffer).digest("hex");
  const name = `${hash.slice(0, 20)}${extensions[contentType]}`;
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await writeFile(filePath, buffer, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return { ...candidate, filePath, publicUrl: `${publicPrefix}/${name}`, sha256: hash, width: metadata.width, height: metadata.height, bytes: buffer.length, contentType };
}
