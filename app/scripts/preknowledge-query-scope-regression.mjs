import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { createProductionDefaultData } from "../src/lib/itineraryRules.js";
import { buildAgentFactBasis, fingerprintFacts, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { buildKnowledgeHierarchy, buildKnowledgeQueryPlan, buildKnowledgeScopePlan, resolveKnowledgeScope } from "../server/knowledge-scope-resolver.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(process.argv.find((value) => value.startsWith("--input="))?.slice(8) || "");
const hierarchySnapshotPath = path.resolve(process.argv.find((value) => value.startsWith("--hierarchy-snapshot="))?.slice(21)
  || path.join(appRoot, "output", "preknowledge-dry-runs", "kenya-8d-2026-09-16T07-48-29-492Z", "report.json"));
if (!sourcePath || !existsSync(sourcePath)) throw new Error("必须通过 --input= 提供存在的真实Excel");
if (!existsSync(hierarchySnapshotPath)) throw new Error("缺少只读知识库层级快照；本脚本禁止联网获取层级");

for (const name of [".env.local"]) {
  const file = path.join(appRoot, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

const startedAt = Date.now();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(appRoot, "output", "preknowledge-dry-runs", `kenya-8d-unified-${stamp}`);
await mkdir(outputDir, { recursive: true });
const workbookBuffer = await readFile(sourcePath);
const parserStartedAt = Date.now();
const imported = await importItineraryWorkbook({
  name: path.basename(sourcePath),
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  arrayBuffer: async () => workbookBuffer.buffer.slice(workbookBuffer.byteOffset, workbookBuffer.byteOffset + workbookBuffer.byteLength),
}, createProductionDefaultData());
const parserMs = Date.now() - parserStartedAt;
const factBasis = buildAgentFactBasis(imported.data, imported.report);

const plannerStartedAt = Date.now();
let lastPlannerPhase = "";
let lastPlannerProgressBucket = -1;
const plannerModelAttempts = [];
let plannerResult;
try {
  plannerResult = await generateAgentPlan({
    project: {
      projectId: `preknowledge-${Date.now()}`,
      inputFingerprint: fingerprintFacts(factBasis),
      factBasis,
      planIds: [],
      confirmationDecisions: [],
    },
    apiKey: process.env.TEXT_MODEL_API_KEY,
    baseUrl: (process.env.TEXT_MODEL_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
    model: process.env.TEXT_MODEL_NAME || "deepseek-v4-flash",
    simpleSkillContract: true,
    onModelAttempt: async (attempt) => {
      plannerModelAttempts.push(attempt);
    },
    onStatus: (event) => {
      const phase = event.provider?.streamPhase || event.status || "planning";
      const progressBucket = Math.floor(Number(event.provider?.receivedContentChars || 0) / 1000);
      if (phase === lastPlannerPhase && progressBucket === lastPlannerProgressBucket) return;
      lastPlannerPhase = phase;
      lastPlannerProgressBucket = progressBucket;
      process.stderr.write(`[planner] ${event.message || event.status} (${phase}${progressBucket > 0 ? `, ${progressBucket}k chars` : ""})\n`);
    },
  });
} catch (error) {
  const failurePath = path.join(outputDir, "planner-failure.json");
  await writeFile(failurePath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    sourcePath,
    error: { code: error?.code || "planning_failed", message: error?.message || String(error), validationErrors: error?.validationErrors || [] },
    attempts: error?.attempts || [],
    guarantees: { knowledgeRequests: 0, downloads: 0, visualAudits: 0, copyCalls: 0, rendererCalls: 0 },
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ failurePath, code: error?.code || "planning_failed", validationErrors: error?.validationErrors || [] }, null, 2)}\n`);
  process.exit(1);
}
const plannerMs = Date.now() - plannerStartedAt;
const runtime = materializeSimpleSkillPlan({ data: imported.data, report: imported.report, agentPlan: plannerResult.plan });
const plannerRawOutput = plannerResult.attempts?.[0]?.rawModelPlan || null;
const plannerRawText = plannerRawOutput ? JSON.stringify(plannerRawOutput, null, 2) : "";
const plannerRawPath = path.join(outputDir, "planner-raw-output.json");
if (plannerRawText) await writeFile(plannerRawPath, `${plannerRawText}\n`, "utf8");
const plannerAttemptRawPath = path.join(outputDir, "planner-model-attempts.json");
await writeFile(plannerAttemptRawPath, `${JSON.stringify(plannerModelAttempts, null, 2)}\n`, "utf8");

const previous = JSON.parse(await readFile(hierarchySnapshotPath, "utf8"));
const fullPaths = new Set();
for (const item of previous.slots || []) {
  if (item.rootScope?.fullPath) fullPaths.add(item.rootScope.fullPath);
  for (const scope of item.scopes || []) if (scope.fullPath) fullPaths.add(scope.fullPath);
}
const nodes = [];
const nodeIds = new Map();
for (const fullPath of fullPaths) {
  const segments = String(fullPath).split("/").map((value) => value.trim()).filter(Boolean);
  let parent = null;
  let key = "";
  for (const segment of segments) {
    key = key ? `${key}/${segment}` : segment;
    if (!nodeIds.has(key)) {
      const nodeId = `snapshot-${nodeIds.size + 1}`;
      nodeIds.set(key, nodeId);
      nodes.push({ node_id: nodeId, formal_name: segment, parent_node_id: parent });
    }
    parent = nodeIds.get(key);
  }
}
const hierarchy = buildKnowledgeHierarchy(nodes);

const slots = runtime.imageSlots.map((slot) => {
  const rootScope = resolveKnowledgeScope(slot, hierarchy);
  const scopePlan = buildKnowledgeScopePlan(slot, rootScope, hierarchy);
  const preScopeQueryPlan = buildKnowledgeQueryPlan(slot, null);
  return {
    slotId: slot.slotId,
    moduleType: slot.moduleType,
    required: slot.required,
    hotel: slot.hotel || "",
    activity: slot.activity || "",
    primaryVisualSubject: slot.primaryVisualSubject || slot.subject || "",
    visualDuty: slot.visualDuty || slot.visualGoal || "",
    location: slot.location || "",
    locationRole: slot.locationRole || "scope_only",
    queryCore: slot.queryCore || {},
    sourceRefs: slot.sourceEvidence || [],
    plannerQueries: [slot.fidelityQuery, ...(slot.alternateQueries || [])].filter(Boolean),
    finalQueriesBeforeScope: preScopeQueryPlan.queries,
    finalQuerySourcesBeforeScope: preScopeQueryPlan.querySteps,
    rootScope: {
      status: rootScope.status,
      fullPath: rootScope.fullPath || null,
      reason: rootScope.reason || null,
      candidates: rootScope.candidates || [],
    },
    scopePlan: {
      blockedReason: scopePlan.blockedReason,
      stopBoundary: scopePlan.stopBoundary,
      scopes: scopePlan.scopes.map((item) => {
        const queryPlan = buildKnowledgeQueryPlan(slot, item.resolution);
        return {
          role: item.role,
          fullPath: item.resolution?.fullPath || null,
          nodeIds: item.resolution?.nodeIds || [],
          sourcePathMode: item.sourcePathMode || null,
          identityAnchors: item.identityAnchors || [],
          queries: queryPlan.queries,
          querySteps: queryPlan.querySteps,
          validationError: queryPlan.validationError || null,
        };
      }),
    },
  };
});

const report = {
  testKind: "real_excel_parser_planner_query_scope_no_knowledge",
  createdAt: new Date().toISOString(),
  sourcePath,
  hierarchySource: { kind: "read_only_previous_snapshot", path: hierarchySnapshotPath, networkRequests: 0 },
  guarantees: { knowledgeRequests: 0, downloads: 0, visualAudits: 0, copyCalls: 0, rendererCalls: 0 },
  timingsMs: { parser: parserMs, planner: plannerMs, total: Date.now() - startedAt },
  parser: {
    dayCount: imported.data.days?.length || 0,
    hotelCount: imported.data.hotels?.length || 0,
    diningCount: imported.data.diningExperiences?.length || 0,
    transportCount: imported.data.transportSummary?.length || 0,
    warnings: imported.report?.warnings || [],
  },
  planner: {
    attempts: plannerResult.attempts.length,
    businessRuns: plannerResult.plan.validation?.plannerBusinessRuns || 1,
    modelRequests: plannerResult.plan.validation?.plannerModelCalls || plannerResult.attempts.length,
    technicalRetryUsed: plannerResult.plan.validation?.technicalRetryUsed === true,
    slotCount: plannerResult.plan.imagePlan?.slots?.length || 0,
    rawOutputPath: plannerRawText ? plannerRawPath : null,
    rawOutputCharacters: plannerRawText.length,
    modelAttemptRawOutputPath: plannerAttemptRawPath,
    modelAttemptRawOutputCharacters: plannerModelAttempts.map((attempt) => String(attempt.rawContent || "").length),
    allSlotsHaveSourceRefs: (plannerResult.plan.imagePlan?.slots || []).every((slot) => Array.isArray(slot.sourceRefs) && slot.sourceRefs.length > 0),
    correctionUsed: plannerResult.plan.validation?.correctionUsed === true,
    firstAttemptErrors: plannerResult.plan.validation?.firstAttemptErrors || [],
  },
  slots,
};
const reportPath = path.join(outputDir, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ reportPath, timingsMs: report.timingsMs, planner: report.planner, guarantees: report.guarantees }, null, 2)}\n`);
