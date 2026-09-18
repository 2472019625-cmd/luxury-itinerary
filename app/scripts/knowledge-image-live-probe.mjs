import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { downloadCandidate } from "../server/image-download.mjs";
import { searchKnowledgeImages } from "../server/knowledge-image-search.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env.local", ".env.image-search.local", ".env.knowledge.local"]) {
  const file = path.join(appRoot, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

const csv = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
const baseUrl = String(process.env.IMAGE_KNOWLEDGE_BASE_URL || "").trim();
const trustedKnowledgeOrigins = csv(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS);
const query = process.argv.slice(2).join(" ").trim() || "Singita 酒店图片";

if (!baseUrl) throw new Error("请先配置 IMAGE_KNOWLEDGE_BASE_URL");

const result = await searchKnowledgeImages({
  queries: [query],
  baseUrl,
  topK: Number(process.env.IMAGE_KNOWLEDGE_TOP_K || 5),
  scopeNodeIds: csv(process.env.IMAGE_KNOWLEDGE_NODE_IDS),
  timeoutMs: Number(process.env.IMAGE_KNOWLEDGE_TIMEOUT_MS || 120_000),
  requestTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_REQUEST_TIMEOUT_MS || 30_000),
  pollIntervalMs: Number(process.env.IMAGE_KNOWLEDGE_POLL_INTERVAL_MS || 2_000),
});

const report = {
  status: result.status,
  queryId: result.queryId,
  queryText: result.queryText,
  scope: result.scope,
  durationMs: result.durationMs,
  candidateCount: result.candidates.length,
  clarificationNodeIds: result.clarificationNodeIds,
  candidates: result.records.map(({ recordId, ranking, filename, mimeType, fragmentContent, sourcePaths, downloadOrigin }, index) => ({ recordId, ranking, filename, mimeType, fragmentContent, sourcePaths, pathUrl: result.candidates[index]?.imageUrl || null, downloadOrigin })),
};

if (result.candidates[0]) {
  if (!trustedKnowledgeOrigins.length) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    throw new Error(`查询成功，实际下载 origin 为 ${result.records[0]?.downloadOrigin || "unknown"}；确认后通过 IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS 精确配置，再执行下载验证`);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-image-probe-"));
  try {
    const downloaded = await downloadCandidate(result.candidates[0], { directory, publicPrefix: "/knowledge-probe", trustedKnowledgeOrigins });
    report.firstDownload = { status: "success", contentType: downloaded.contentType, width: downloaded.width, height: downloaded.height, bytes: downloaded.bytes };
  } catch (error) {
    report.firstDownload = { status: "failed", reason: error.message || String(error) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
