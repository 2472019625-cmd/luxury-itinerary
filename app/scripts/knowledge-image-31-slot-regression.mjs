import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { createProductionDefaultData } from "../src/lib/itineraryRules.js";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
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

const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
const sourcePath = path.resolve(arg("input"));
const plannerRawPath = path.resolve(arg("planner-raw"));
if (!sourcePath || !existsSync(sourcePath)) throw new Error("缺少 --input=真实Excel路径");
if (!plannerRawPath || !existsSync(plannerRawPath)) throw new Error("缺少 --planner-raw=已确认Planner原始JSON路径");
if (!process.env.IMAGE_KNOWLEDGE_BASE_URL) throw new Error("缺少 IMAGE_KNOWLEDGE_BASE_URL");
if (!process.env.BIGMODEL_API_KEY || !process.env.BIGMODEL_BASE_URL || !process.env.BIGMODEL_MODEL) throw new Error("缺少视觉审核模型配置");

const startedAt = Date.now();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDirectory = path.join(appRoot, "output", "knowledge-image-31-slot-runs", stamp);
await mkdir(reportDirectory, { recursive: true });

const workbookBuffer = await readFile(sourcePath);
const imported = await importItineraryWorkbook({
  name: path.basename(sourcePath),
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  arrayBuffer: async () => workbookBuffer.buffer.slice(workbookBuffer.byteOffset, workbookBuffer.byteOffset + workbookBuffer.byteLength),
}, createProductionDefaultData());
const agentPlan = JSON.parse(await readFile(plannerRawPath, "utf8"));
const runtimePlan = materializeSimpleSkillPlan({ data: imported.data, report: imported.report, agentPlan });
if (runtimePlan.imageSlots.length !== 31) throw new Error(`预期31个图片位，实际${runtimePlan.imageSlots.length}个，已停止`);
if (runtimePlan.imageSlots.some((slot) => !Array.isArray(slot.sourceEvidence) || !slot.sourceEvidence.length)) throw new Error("存在缺少sourceRefs的图片位，已停止");

await writeFile(path.join(reportDirectory, "runtime-image-slots.json"), `${JSON.stringify(runtimePlan.imageSlots, null, 2)}\n`, "utf8");
const capabilityEvents = [];
const finishedByCapability = new Map();
const imageExecution = await runImageSearchSkill({
  root: appRoot,
  slots: runtimePlan.imageSlots,
  existingImages: [],
  sourceMode: "knowledge_only",
  knowledgeBaseUrl: String(process.env.IMAGE_KNOWLEDGE_BASE_URL || "").replace(/\/$/, ""),
  knowledgeScopeNodeIds: String(process.env.IMAGE_KNOWLEDGE_NODE_IDS || "").split(",").map((item) => item.trim()).filter(Boolean),
  knowledgeTopK: Number(process.env.IMAGE_KNOWLEDGE_TOP_K || 5),
  knowledgeTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_TIMEOUT_MS || 120_000),
  knowledgeRequestTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_REQUEST_TIMEOUT_MS || 30_000),
  knowledgePollIntervalMs: Number(process.env.IMAGE_KNOWLEDGE_POLL_INTERVAL_MS || 2_000),
  trustedKnowledgeOrigins: String(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean),
  visionApiKey: process.env.BIGMODEL_API_KEY,
  visionBaseUrl: process.env.BIGMODEL_BASE_URL,
  visionModel: process.env.BIGMODEL_MODEL,
  maxQueriesPerSlot: 4,
  knowledgeQueriesPerSlot: 4,
  downloadsPerSlot: 6,
  visionCandidatesPerSlot: 6,
  concurrency: { slots: 3, search: 3, pages: 3, downloads: 3, vision: 3 },
  onCapabilityCall: (event) => {
    capabilityEvents.push(event);
    if (event.phase !== "finished") return;
    const count = (finishedByCapability.get(event.capabilityId) || 0) + 1;
    finishedByCapability.set(event.capabilityId, count);
    process.stdout.write(`[progress] ${event.capabilityId} #${count} ${event.target?.slotId || event.target || ""} ${event.failed ? "FAILED" : "done"} ${event.durationMs || 0}ms\n`);
  },
});

const resultCounts = Object.fromEntries([...new Set(imageExecution.results.map((item) => item.status))]
  .map((status) => [status, imageExecution.results.filter((item) => item.status === status).length]));
const slotSummary = imageExecution.results.map((item) => {
  const evidence = item.pipelineEvidence?.knowledgeSearch || {};
  const candidates = Array.isArray(item.candidates) ? item.candidates : [];
  return {
    slotId: item.slotId,
    status: item.status,
    technicalStatus: item.technicalStatus || null,
    queriesUsed: item.queriesUsed || [],
    queryPlan: evidence.queryPlan || null,
    attempts: evidence.attempts || [],
    returnedCandidateCount: Array.isArray(evidence.candidates) ? evidence.candidates.length : candidates.length,
    retainedCandidateCount: candidates.length,
    auditedCandidateCount: candidates.filter((candidate) => candidate.audit || candidate.autoReviewStatus === "auto_selected").length,
    selectedCandidateId: item.selected?.candidateId || null,
    selectedFilePath: item.selected?.filePath || null,
    selectedPublicUrl: item.selected?.publicUrl || null,
    matchReason: item.matchReason || null,
    warningCount: item.warnings?.length || 0,
  };
});
const report = {
  createdAt: new Date().toISOString(),
  testKind: "real_excel_saved_planner_31_slots_knowledge_preview_audit_download",
  sourcePath,
  plannerRawPath,
  configuration: {
    sourceMode: "knowledge_only",
    slotCount: runtimePlan.imageSlots.length,
    knowledgeTopK: Number(process.env.IMAGE_KNOWLEDGE_TOP_K || 5),
    maxQueriesPerSlot: 4,
    knowledgeQueriesPerSlot: 4,
    downloadsPerSlot: 6,
    visionCandidatesPerSlot: 6,
    concurrency: { slots: 3, search: 3, pages: 3, downloads: 3, vision: 3 },
  },
  notCalled: ["Planner", "Copy", "Web image search", "Step4 writeback", "Renderer"],
  durationMs: Date.now() - startedAt,
  runtimePlan,
  imageExecution,
  capabilityEvents,
  summary: {
    resultCounts,
    selectedCount: imageExecution.results.filter((item) => item.selected).length,
    retainedCandidateCount: imageExecution.results.reduce((sum, item) => sum + (item.candidates?.length || 0), 0),
    knowledgeActualRequests: imageExecution.metrics?.knowledgeActualRequests || 0,
    knowledgeCandidates: imageExecution.metrics?.knowledgeCandidates || 0,
    previewReturned: imageExecution.metrics?.previewReturned || 0,
    previewAudited: imageExecution.metrics?.previewAudited || 0,
    matchedFileDownloadAttempts: imageExecution.metrics?.matchedFileDownloadAttempts || 0,
    matchedFileDownloadSuccess: imageExecution.metrics?.matchedFileDownloadSuccess || 0,
    originalDownloadSavedCount: imageExecution.metrics?.originalDownloadSavedCount || 0,
    webSearchCalls: imageExecution.metrics?.searchCalls || 0,
  },
  slotSummary,
};
await writeFile(path.join(reportDirectory, "knowledge-image-full-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(path.join(reportDirectory, "knowledge-image-slot-summary.json"), `${JSON.stringify({ createdAt: report.createdAt, durationMs: report.durationMs, summary: report.summary, slots: slotSummary }, null, 2)}\n`, "utf8");
process.stdout.write(`REPORT_DIR=${reportDirectory}\n`);
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
