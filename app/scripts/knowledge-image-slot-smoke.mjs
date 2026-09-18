import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runImageSearchSkill } from "../server/simple-image-skill.mjs";

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
const sourceMode = String(process.env.IMAGE_SOURCE_MODE || "knowledge_only").trim().toLowerCase();
if (sourceMode !== "knowledge_only") throw new Error(`本探针只允许 IMAGE_SOURCE_MODE=knowledge_only，当前为 ${sourceMode}`);
const probeHotel = String(process.env.KNOWLEDGE_PROBE_HOTEL || "Singita").trim();
const probeSubject = String(process.env.KNOWLEDGE_PROBE_SUBJECT || `${probeHotel} 酒店泳池`).trim();

const slot = {
  slotId: "knowledge-probe:hotel-pool",
  moduleType: "hotel",
  required: true,
  location: "",
  hotel: probeHotel,
  activity: "",
  subject: "",
  primaryVisualSubject: "",
  visualGoal: `验证知识库中的 ${probeSubject}`,
  visualContext: { dayRole: "酒店空间验证", avoid: ["无泳池的普通客房", `与 ${probeHotel} 无关的酒店`] },
  searchIntent: [`${probeSubject}图片`],
  copyTargetId: "knowledge-probe-copy:hotel-pool",
  aspectRatio: "16:9",
  userLocked: false,
};

const capabilityEvents = [];
const startedAt = Date.now();
const result = await runImageSearchSkill({
  root: appRoot,
  slots: [slot],
  sourceMode,
  knowledgeBaseUrl: process.env.IMAGE_KNOWLEDGE_BASE_URL,
  knowledgeTopK: Number(process.env.IMAGE_KNOWLEDGE_TOP_K || 5),
  knowledgeScopeNodeIds: csv(process.env.IMAGE_KNOWLEDGE_NODE_IDS),
  trustedKnowledgeOrigins: csv(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS),
  knowledgeTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_TIMEOUT_MS || 120_000),
  knowledgeRequestTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_REQUEST_TIMEOUT_MS || 30_000),
  knowledgePollIntervalMs: Number(process.env.IMAGE_KNOWLEDGE_POLL_INTERVAL_MS || 2_000),
  visionApiKey: process.env.BIGMODEL_API_KEY,
  visionBaseUrl: process.env.BIGMODEL_BASE_URL,
  visionModel: process.env.BIGMODEL_MODEL,
  downloadsPerSlot: 5,
  visionCandidatesPerSlot: 5,
  concurrency: { slots: 1, search: 1, pages: 1, downloads: 2, vision: 1 },
  onCapabilityCall: (event) => capabilityEvents.push(event),
});

const report = {
  createdAt: new Date().toISOString(),
  scope: `one real ${probeHotel} hotel pool Image Slot; no Planner, Copy, Parser, routeNodes or Renderer`,
  wallClockMs: Date.now() - startedAt,
  result,
  capabilityEvents: capabilityEvents.filter((event) => event.phase === "finished"),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
