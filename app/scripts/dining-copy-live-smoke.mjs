import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { runCopyWriterSkill } from "../server/simple-copy-skill.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");
const envRoot = path.resolve(process.env.SOURCE_ENV_ROOT || appRoot);

for (const name of [".env.local", ".env.image-search.local"]) {
  const file = path.join(envRoot, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

const workbookPath = process.env.REAL_TEST_XLSX;
if (!workbookPath || !existsSync(workbookPath)) throw new Error("REAL_TEST_XLSX 未指向可用的真实 Excel");
for (const key of ["TEXT_MODEL_API_KEY", "TEXT_MODEL_BASE_URL", "TEXT_MODEL_NAME", "IMAGE_SEARCH_API_KEY", "IMAGE_SEARCH_BASE_URL"]) {
  if (!process.env[key]) throw new Error(`缺少真实测试配置：${key}`);
}

const workbookBuffer = readFileSync(workbookPath);
const workbookFile = {
  name: path.basename(workbookPath),
  arrayBuffer: async () => workbookBuffer.buffer.slice(workbookBuffer.byteOffset, workbookBuffer.byteOffset + workbookBuffer.byteLength),
};
const imported = await importItineraryWorkbook(workbookFile, {});
const sourceData = imported.data;
const agentPlan = {
  projectId: "dining-copy-live-smoke",
  selectedHighlights: [],
  modules: [
    { moduleId: "dining", decision: "show", contentAction: "optimize" },
    { moduleId: "hotels", decision: "hide", contentAction: "hide" },
    { moduleId: "transport", decision: "hide", contentAction: "hide" },
    { moduleId: "days", decision: "show", contentAction: "optimize" },
    { moduleId: "notes", decision: "show", contentAction: "optimize" },
    { moduleId: "expenses", decision: "show", contentAction: "preserve" },
  ],
  dayRoles: (sourceData.days || []).map((_day, index) => ({ index, role: `DAY ${index + 1}`, differenceFromAdjacent: "仅用于构造餐饮Copy任务", contentAction: "optimize" })),
  imagePlan: { visualStory: "本次不执行图片任务", slots: [] },
};

const planStartedAt = Date.now();
const plan = materializeSimpleSkillPlan({ data: sourceData, report: imported.report, agentPlan });
const diningTasks = plan.copyTasks.filter((task) => task.moduleType === "dining");
const events = [];
const runStartedAt = Date.now();
const result = await runCopyWriterSkill({
  itineraryContext: plan.itineraryContext,
  tasks: diningTasks,
  apiKey: process.env.TEXT_MODEL_API_KEY,
  baseUrl: process.env.TEXT_MODEL_BASE_URL,
  model: process.env.TEXT_MODEL_NAME,
  researchApiKey: process.env.IMAGE_SEARCH_API_KEY,
  researchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL,
  researchModel: process.env.IMAGE_SEARCH_MODEL || "gemini-3.7-flash-search",
  onCapabilityCall: (event) => events.push({ ...event, at: new Date().toISOString() }),
});
const completedAt = Date.now();

const sourceByPath = new Map((sourceData.diningExperiences || []).map((item, index) => [`diningExperiences.${index}.editorialCopy`, item]));
const researchByTarget = new Map((result.researchResults || []).map((item) => [item.targetId, item]));
const output = {
  createdAt: new Date().toISOString(),
  workbook: workbookPath,
  scope: "Parser preparation -> Dining Facts Research -> Dining Copy only",
  excludedStages: ["Planner model", "Hotel Copy", "DAY Copy", "Image", "Knowledge Image", "Web Image", "Renderer", "Export"],
  timings: {
    preparationMs: runStartedAt - planStartedAt,
    wallClockMs: completedAt - runStartedAt,
    researchCumulativeMs: result.metrics?.researchMs || 0,
    copyCumulativeMs: result.metrics?.modelMs || 0,
  },
  metrics: result.metrics,
  status: result.status,
  diningCount: diningTasks.length,
  researchRequestCount: diningTasks.filter((task) => task.researchRequest).length,
  items: diningTasks.map((task) => {
    const source = sourceByPath.get(task.targetPath) || {};
    const copyResult = result.results.find((item) => item.targetId === task.targetId);
    const research = researchByTarget.get(task.targetId);
    return {
      targetId: task.targetId,
      title: source.title || task.facts?.title || "",
      officialName: source.officialName || task.facts?.officialName || "",
      location: source.location || task.facts?.location || "",
      sourceEvidence: source.sourceEvidence || task.facts?.sourceEvidence || [],
      researchRequested: Boolean(task.researchRequest),
      researchRequest: task.researchRequest || null,
      researchStatus: research?.status || "not_requested",
      verifiedFacts: research?.verifiedFacts || [],
      rejectedFacts: (research?.rejected || []).map(({ category, fact, sourceUrl, reason }) => ({ category, fact, sourceUrl, reason })),
      categoryOutcomes: research?.categoryOutcomes || [],
      copyStatus: copyResult?.status || "missing",
      editorialCopy: copyResult?.value || "",
      warnings: copyResult?.warnings || [],
      error: copyResult?.error || null,
    };
  }),
  capabilityCalls: events.filter((event) => event.phase === "finished").map((event) => ({
    capabilityId: event.capabilityId,
    entityName: event.entityName || null,
    status: event.status || null,
    verifiedFactCount: event.verifiedFactCount ?? null,
    durationMs: event.durationMs ?? null,
    failed: Boolean(event.failed),
    reason: event.reason || null,
  })),
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(projectRoot, "outputs", "dining-copy-live-smoke", stamp);
mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, "report.json");
writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputFile, ...output }, null, 2)}\n`);
