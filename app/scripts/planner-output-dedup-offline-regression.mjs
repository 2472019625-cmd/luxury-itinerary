import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { createProductionDefaultData } from "../src/lib/itineraryRules.js";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { buildKnowledgeQueryPlan } from "../server/knowledge-scope-resolver.mjs";
import { fillPlannerImageDeterministicFields } from "../server/agent-trip-planner.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");
const sourcePath = process.argv.find((value) => value.startsWith("--input="))?.slice(8);
const rawPath = process.argv.find((value) => value.startsWith("--planner-raw="))?.slice(14)
  || path.join(repoRoot, "audit", "evidence", "planner-output-dedup-baseline", "planner-attempt-2-raw.txt");
const outputPath = process.argv.find((value) => value.startsWith("--output="))?.slice(9)
  || path.join(appRoot, "output", "planner-output-dedup", "before.json");
const simulateCompact = process.argv.includes("--simulate-compact");
if (!sourcePath) throw new Error("缺少 --input=真实Excel路径");

const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const workbookBuffer = await readFile(sourcePath);
const imported = await importItineraryWorkbook({
  name: path.basename(sourcePath),
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  arrayBuffer: async () => workbookBuffer.buffer.slice(workbookBuffer.byteOffset, workbookBuffer.byteOffset + workbookBuffer.byteLength),
}, createProductionDefaultData());
const rawText = await readFile(rawPath, "utf8");
const originalRawPlan = JSON.parse(rawText);
const strippedRawPlan = structuredClone(originalRawPlan);
if (simulateCompact) for (const slot of strippedRawPlan.imagePlan?.slots || []) {
  delete slot.slotId;
  delete slot.label;
  delete slot.required;
  delete slot.removable;
}
const rawPlan = simulateCompact ? fillPlannerImageDeterministicFields(strippedRawPlan, {
  hotels: imported.data.hotels || [],
  diningExperiences: imported.data.diningExperiences || [],
  transport: imported.data.transportSummary || [],
  days: imported.data.days || [],
}) : originalRawPlan;
const runtime = materializeSimpleSkillPlan({ data: imported.data, report: imported.report, agentPlan: rawPlan });
const copyPayload = runtime.copyTasks.map((task) => ({
  targetId: task.targetId,
  targetPath: task.targetPath,
  moduleType: task.moduleType,
  facts: task.facts,
  factStatuses: task.factStatuses,
  relevantContext: task.relevantContext,
  layoutHints: task.layoutHints,
  required: task.required,
}));
const imagePayload = runtime.imageSlots.map((slot) => {
  const queryPlan = buildKnowledgeQueryPlan(slot, null);
  return {
    ...slot,
    finalQueriesBeforeScope: queryPlan.queries,
    finalQueryStepsBeforeScope: queryPlan.querySteps,
    binding: runtime.slotBindings[slot.slotId],
  };
});
const report = {
  createdAt: new Date().toISOString(),
  mode: simulateCompact ? "simulated_compact" : "before",
  guarantees: { plannerModelRequests: 0, knowledgeRequests: 0, copyModelRequests: 0, downloads: 0, visualAudits: 0, rendererCalls: 0 },
  sourcePath,
  rawPath,
  rawCharacters: rawText.length,
  simulatedCompactCharacters: JSON.stringify(strippedRawPlan).length,
  parser: {
    days: imported.data.days?.length || 0,
    hotels: imported.data.hotels?.length || 0,
    dining: imported.data.diningExperiences?.length || 0,
    transport: imported.data.transportSummary?.length || 0,
  },
  plannerSlots: rawPlan.imagePlan?.slots || [],
  copyPayload,
  imagePayload,
  hashes: { copyPayload: hash(copyPayload), imagePayload: hash(imagePayload), slotBindings: hash(runtime.slotBindings) },
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, rawCharacters: report.rawCharacters, slotCount: imagePayload.length, copyHash: report.hashes.copyPayload, imageHash: report.hashes.imagePayload }, null, 2)}\n`);
