import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assertPublicUrl, fetchPublicUrl } from "./page-images.mjs";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

export async function downloadCandidate(candidate, { directory, publicPrefix, signal, minWidth = 900, minHeight = 500, maxBytes = 14 * 1024 * 1024 }) {
  await assertPublicUrl(candidate.imageUrl);
  const response = await fetchPublicUrl(candidate.imageUrl, {
    headers: { "user-agent": "Mozilla/5.0 LuxuryTravelImageResearch/1.0", accept: "image/avif,image/webp,image/png,image/jpeg" },
    signal,
    timeoutMs: 25_000,
  });
  if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("图片文件过大");
  const chunks = []; let received = 0;
  for await (const chunk of response.body || []) {
    received += chunk.length;
    if (received > maxBytes) { await response.body?.cancel?.().catch(() => {}); throw new Error('图片文件超过资源上限'); }
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length || buffer.length > maxBytes) throw new Error("图片文件大小不合格");
  const metadata = await sharp(buffer, { failOn: "warning" }).metadata();
  const contentType = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : '';
  if (!allowedTypes.has(contentType)) throw new Error("不支持的图片格式");
  if ((metadata.width || 0) < minWidth || (metadata.height || 0) < minHeight) throw new Error("图片分辨率不足");
  const ratio = metadata.width / metadata.height;
  if (ratio < 0.65 || ratio > 3.2) throw new Error("图片比例不适合行程卡片");
  const hash = createHash("sha256").update(buffer).digest("hex");
  const name = `${hash.slice(0, 20)}${extensions[contentType]}`;
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await writeFile(filePath, buffer, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return { ...candidate, filePath, publicUrl: `${publicPrefix}/${name}`, sha256: hash, width: metadata.width, height: metadata.height, bytes: buffer.length, contentType };
}
