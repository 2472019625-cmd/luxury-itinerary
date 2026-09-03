import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { runSimplePipeline } from "../server/simple-pipeline-executor.mjs";
import { SIMPLE_PIPELINE_DEFAULT_ORIGIN } from "../server/simple-fixed-modules.mjs";
import { copyRequestJson, createWorkbookFile, imageAdapters, plannerRequestJson } from "../tests/helpers/simple-pipeline-fixture.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(appRoot, "..");
const evidenceDir = path.join(workspaceRoot, "audit", "evidence", "2026-09-03-simple-pipeline-integration");
const origin = process.argv.find((item) => item.startsWith("--origin="))?.slice("--origin=".length) || SIMPLE_PIPELINE_DEFAULT_ORIGIN;
await mkdir(evidenceDir, { recursive: true });

const events = [];
const result = await runSimplePipeline({
  sourceFile: createWorkbookFile(),
  root: appRoot,
  storeRoot: path.join(evidenceDir, "projects"),
  origin,
  plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
  copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson() },
  imageOptions: { visionApiKey: "fixture", visionBaseUrl: "https://vision.invalid", visionModel: "fixture", sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1, adapters: imageAdapters({ appRoot }) },
  onEvent: (event) => events.push(event),
});
const layoutQa = result.outputPath ? JSON.parse(await readFile(path.join(path.dirname(result.outputPath), "layout-qa.json"), "utf8")) : null;
const outputMetadata = result.outputPath ? await sharp(result.outputPath).metadata() : null;
const summary = { generatedAt: new Date().toISOString(), origin, result, outputMetadata, layoutQa, events };
await writeFile(path.join(evidenceDir, "full-chain-smoke-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ projectId: result.projectId, pipelineStatus: result.pipelineStatus, outputPath: result.outputPath, timingsMs: result.timingsMs, callCounts: result.callCounts, concurrency: result.concurrency, legacyEvidence: result.legacyEvidence }, null, 2));
