import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const arg = (name, fallback = "") => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const projectId = arg("project", "889f7349-8b6c-4efe-b037-9268e0662aa6");
const planId = arg("plan", "f903bfe6-a43a-4517-946c-990992236a58");
const projectRoot = path.join(appRoot, "output", "simple-pipeline", "projects", projectId);
const storedPlan = JSON.parse(readFileSync(path.join(projectRoot, "plans", `${planId}.json`), "utf8"));
const sourceData = JSON.parse(readFileSync(path.join(projectRoot, "inputs", "source-data.json"), "utf8"));

const plannedDaySlots = storedPlan.imageSlots.filter((slot) => slot.moduleType === "day").map((slot) => {
  const match = slot.slotId.match(/^image:day:(\d+):(primary|supporting:(\d+))$/);
  return {
    role: match?.[2] === "primary" ? `day:${match[1]}` : `day:${match?.[1]}:supporting:${match?.[3]}`,
    primaryVisualSubject: slot.primaryVisualSubject || slot.subject,
    searchIntent: slot.searchIntent,
    sourceRefs: slot.sourceEvidence || [],
    required: slot.required,
    visualDuty: slot.visualGoal,
    differentiation: slot.visualContext?.differenceFromAdjacent || "",
  };
});
const sourceAgentPlan = {
  projectId: storedPlan.projectId,
  planId: storedPlan.sourceAgentPlanId,
  inputFingerprint: storedPlan.inputFingerprint,
  summary: storedPlan.plannerSummary,
  selectedHighlights: (storedPlan.preparedData.highlights || []).map((sourceText) => ({ sourceText })),
  dayRoles: storedPlan.dayRoles,
  imagePlan: { slots: plannedDaySlots },
};
const runtimePlan = materializeSimpleSkillPlan({ data: sourceData.data, report: sourceData.report, agentPlan: sourceAgentPlan });
const requestedSlotIds = arg("slots").split(",").map((item) => item.trim()).filter(Boolean);
const runtimeSlots = requestedSlotIds.length ? runtimePlan.imageSlots.filter((slot) => requestedSlotIds.includes(slot.slotId)) : runtimePlan.imageSlots;
if (!runtimeSlots.length) throw new Error("--slots 未匹配到任何图片位");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDirectory = path.join(appRoot, "output", "image-only-benchmarks", `current-rules-topk5-${timestamp}`);
mkdirSync(reportDirectory, { recursive: true });
const capabilityEvents = [];
const startedAt = Date.now();
const imageExecution = await runImageSearchSkill({
  root: appRoot,
  slots: runtimeSlots,
  existingImages: [],
  sourceMode: "knowledge_only",
  knowledgeBaseUrl: String(process.env.IMAGE_KNOWLEDGE_BASE_URL || "").replace(/\/$/, ""),
  knowledgeScopeNodeIds: String(process.env.IMAGE_KNOWLEDGE_NODE_IDS || "").split(",").map((item) => item.trim()).filter(Boolean),
  knowledgeTopK: 5,
  knowledgeTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_TIMEOUT_MS || 120_000),
  knowledgeRequestTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_REQUEST_TIMEOUT_MS || 30_000),
  knowledgePollIntervalMs: Number(process.env.IMAGE_KNOWLEDGE_POLL_INTERVAL_MS || 2_000),
  trustedKnowledgeOrigins: String(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean),
  searchApiKey: process.env.IMAGE_SEARCH_API_KEY,
  searchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL,
  searchModel: process.env.IMAGE_SEARCH_MODEL,
  visionApiKey: process.env.BIGMODEL_API_KEY,
  visionBaseUrl: process.env.BIGMODEL_BASE_URL,
  visionModel: process.env.BIGMODEL_MODEL,
  maxQueriesPerSlot: 2,
  sourcePagesPerSlot: 4,
  downloadsPerSlot: 6,
  visionCandidatesPerSlot: 6,
  concurrency: { slots: 3, search: 3, pages: 3, downloads: 3, vision: 3 },
  onCapabilityCall: (event) => {
    capabilityEvents.push(event);
    if (event.phase === "finished") process.stdout.write(`finished ${event.capabilityId} ${event.target?.slotId || event.target || ""} ${event.durationMs || 0}ms\n`);
  },
});
const endedAt = Date.now();

const resultCounts = Object.fromEntries([...new Set(imageExecution.results.map((item) => item.status))].map((status) => [status, imageExecution.results.filter((item) => item.status === status).length]));
const report = {
  createdAt: new Date().toISOString(),
  testKind: "isolated_image_only_current_rules",
  reused: { projectId, planId, inputFingerprint: storedPlan.inputFingerprint, parser: true, planner: true, copy: true },
  notCalled: ["Parser", "Planner", "Copy", "Renderer", "Web image search"],
  configuration: { sourceMode: "knowledge_only", topK: 5, maxQueriesPerSlot: 2, downloadsPerSlot: 6, visionCandidatesPerSlot: 6, concurrency: { slots: 3, search: 3, pages: 3, downloads: 3, vision: 3 } },
  durationMs: endedAt - startedAt,
  runtimePlan,
  imageExecution,
  capabilityEvents,
  summary: {
    slotCount: runtimeSlots.length,
    resultCounts,
    selectedCount: imageExecution.results.filter((item) => item.selected).length,
    retainedCandidateCount: imageExecution.results.reduce((sum, item) => sum + (item.candidates?.length || 0), 0),
    knowledgeOnlyVerified: imageExecution.metrics?.knowledgeOnlyVerified === true,
    concurrencyPeak: imageExecution.metrics?.concurrencyPeak,
  },
};
writeFileSync(path.join(reportDirectory, "image-only-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(reportDirectory, "summary.json"), `${JSON.stringify({ createdAt: report.createdAt, durationMs: report.durationMs, configuration: report.configuration, summary: report.summary, metrics: imageExecution.metrics }, null, 2)}\n`, "utf8");
writeFileSync(path.join(reportDirectory, "runtime-image-slots.json"), `${JSON.stringify(runtimePlan.imageSlots, null, 2)}\n`, "utf8");
process.stdout.write(`REPORT_DIR=${reportDirectory}\n`);
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
