import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCopyWriterSkill } from "../server/simple-copy-skill.mjs";
import { runImageSearchSkill } from "../server/simple-image-skill.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env.local", ".env.image-search.local"]) {
  const file = path.join(appRoot, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

const args = process.argv.slice(2);
const mode = args.find((arg) => ["copy", "image", "all"].includes(arg)) || "all";
const evidenceIndex = args.indexOf("--evidence");
const evidenceArg = args.find((arg) => arg.startsWith("--evidence="));
const evidencePath = evidenceArg ? evidenceArg.slice("--evidence=".length) : evidenceIndex >= 0 ? args[evidenceIndex + 1] : null;
const report = { date: new Date().toISOString(), branch: "agent/simple-skill-pipeline-v1", mode };
const runtimeEvents = [];

if (["all", "copy"].includes(mode)) {
  const events = [];
  const result = await runCopyWriterSkill({
    itineraryContext: { destination: "肯尼亚", dayCount: 3, journeyTheme: "从草原初见到深入观察" },
    tasks: [
      { targetId: "day-1", moduleType: "day", targetPath: "days.0.description", outputSchema: { type: "string", minLength: 12 }, facts: { route: "内罗毕—安博塞利", activity: "抵达后进入保护区游猎", hotel: "安博塞利区域营地" }, factStatuses: { route: "confirmed", activity: "included", hotel: "confirmed" }, plannerGoal: "说明当天如何从抵达过渡到草原初见", relevantContext: { dayRole: "整程环境建立" } },
      { targetId: "day-2", moduleType: "day", targetPath: "days.1.description", outputSchema: { type: "string", minLength: 12 }, facts: { location: "安博塞利", activity: "全天游猎" }, factStatuses: { location: "confirmed", activity: "included" }, plannerGoal: "表现全天深入观察及其在整程中的推进", relevantContext: { dayRole: "深入观察", previousDay: "抵达并初见草原" } },
      { targetId: "day-3", moduleType: "day", targetPath: "days.2.description", outputSchema: { type: "string", minLength: 12 }, facts: { route: "安博塞利—内罗毕", activity: "返程与城市衔接" }, factStatuses: { route: "confirmed", activity: "included" }, plannerGoal: "清楚表达转场和节奏收束，不虚构途中体验", relevantContext: { dayRole: "转场衔接" } },
    ],
    apiKey: process.env.TEXT_MODEL_API_KEY,
    baseUrl: process.env.TEXT_MODEL_BASE_URL,
    model: process.env.TEXT_MODEL_NAME,
    onCapabilityCall: (event) => { events.push(event); runtimeEvents.push(event); },
  });
  report.copy = { status: result.status, targetCount: result.results.length, resultStatuses: result.results.map((item) => ({ targetId: item.targetId, status: item.status, errorCode: item.error?.code || null })), metrics: result.metrics, capabilityCalls: events.filter((item) => item.phase === "finished").map((item) => ({ capabilityId: item.capabilityId, durationMs: item.durationMs, attemptCount: item.attemptCount, failed: Boolean(item.failed) })) };
}

if (["all", "image"].includes(mode)) {
  const events = [];
  const result = await runImageSearchSkill({
    root: appRoot,
    slots: [
      { slotId: "cover:hero", moduleType: "cover", required: true, location: "肯尼亚", subject: "东非草原环境", visualGoal: "建立肯尼亚草原目的地识别和整程开场感", visualContext: { dayRole: "整程封面", keyExperiences: ["草原保护区", "游猎"], avoid: ["具体酒店替代目的地封面"] }, copyTargetId: "subtitle", aspectRatio: "16:9", userLocked: false },
      { slotId: "hotel:gran-melia-arusha:primary", moduleType: "hotel", required: true, location: "Arusha, Tanzania", hotel: "Gran Melia Arusha", subject: "酒店真实公共空间或花园景观", visualGoal: "展示酒店整体住宿质感和真实空间", visualContext: { dayRole: "住宿总览", keyExperiences: ["花园环境", "公共空间"], avoid: ["其他 Melia 酒店"] }, copyTargetId: "hotel-gran-melia-copy", aspectRatio: "16:9", userLocked: false },
    ],
    searchApiKey: process.env.IMAGE_SEARCH_API_KEY,
    searchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL,
    searchModel: process.env.IMAGE_SEARCH_MODEL,
    visionApiKey: process.env.BIGMODEL_API_KEY,
    visionBaseUrl: process.env.BIGMODEL_BASE_URL,
    visionModel: process.env.BIGMODEL_MODEL,
    onCapabilityCall: (event) => { events.push(event); runtimeEvents.push(event); },
  });
  report.image = { status: result.status, slotCount: result.results.length, resultStatuses: result.results.map((item) => ({ slotId: item.slotId, status: item.status, queriesUsed: item.queriesUsed.length, technicalStatus: item.technicalStatus, durationMs: item.durationMs })), metrics: result.metrics, capabilityCalls: events.filter((item) => item.phase === "finished").map((item) => ({ capabilityId: item.capabilityId, target: item.target, durationMs: item.durationMs, attemptCount: item.attemptCount, failed: Boolean(item.failed) })) };
}

function verifyLegacyIsolation() {
  const entryFiles = ["server/simple-copy-skill.mjs", "server/simple-image-skill.mjs"];
  const forbiddenChecks = {
    brandReviewer: /(?:from\s+["'][^"']*brand[^"']*review|\brunBrandReview\s*\()/i,
    reviewDecision: /(?:from\s+["'][^"']*review-decision|\bdecideAgentReviewFindings\s*\()/i,
    findingPackage: /\b(?:build|create|submit)FindingPackage\s*\(/i,
    automaticCopyRegeneration: /\brunAgentCopyPipeline\s*\(/i,
    automaticSecondImageSearch: /\bresolveItineraryImages\s*\(/i,
    targetedImageResearch: /\b(?:retryImageSlots|prepareTargetedImageRetry|runTargetedImageResearch)\s*\(/i,
    stageBudgetBusinessLoop: /\brunWithinStageBudget\s*\(/i,
  };
  const sources = {};
  const pending = entryFiles.map((file) => path.join(appRoot, file));
  while (pending.length) {
    const absoluteFile = pending.pop();
    const relativeFile = path.relative(appRoot, absoluteFile).replace(/\\/g, "/");
    if (sources[relativeFile] || !absoluteFile.startsWith(appRoot) || !existsSync(absoluteFile)) continue;
    const source = readFileSync(absoluteFile, "utf8");
    sources[relativeFile] = source;
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      const imported = path.resolve(path.dirname(absoluteFile), match[1]);
      pending.push(path.extname(imported) ? imported : `${imported}.mjs`);
    }
  }
  const checkedFiles = Object.keys(sources).sort();
  const staticMatches = Object.fromEntries(Object.entries(forbiddenChecks).map(([name, pattern]) => [name, checkedFiles.filter((file) => pattern.test(sources[file]))]));
  const allowedCapabilities = new Set(["copy_writer", "image_search", "visual_judgment"]);
  const unexpectedCapabilities = [...new Set(runtimeEvents.map((event) => event.capabilityId).filter((id) => !allowedCapabilities.has(id)))];
  const runtimeAssertions = {
    copySingleBusinessCall: !report.copy || (report.copy.metrics.businessBatches === 1 && report.copy.metrics.modelCalls === 1),
    copyNoBusinessRegeneration: !report.copy || report.copy.metrics.modelCalls <= 1,
    imageSingleBusinessRound: !report.image || (report.image.metrics.businessBatches === 1 && report.image.metrics.automaticFollowupRounds === 0),
    imageOneProviderCallPerSlotAtMost: !report.image || report.image.metrics.searchCalls <= report.image.slotCount,
    noUnexpectedCapabilities: unexpectedCapabilities.length === 0,
  };
  const invoked = Object.fromEntries(Object.keys(forbiddenChecks).map((name) => [name, staticMatches[name].length > 0]));
  if (!runtimeAssertions.copyNoBusinessRegeneration) invoked.automaticCopyRegeneration = true;
  if (!runtimeAssertions.imageSingleBusinessRound || !runtimeAssertions.imageOneProviderCallPerSlotAtMost) invoked.automaticSecondImageSearch = true;
  return { passed: Object.values(invoked).every((value) => value === false) && Object.values(runtimeAssertions).every(Boolean), method: "递归扫描两个新 Skill 入口的本地依赖图，并核对本次真实运行能力事件与批次计数", entryFiles, checkedFiles, staticMatches, runtimeAssertions, unexpectedCapabilities, legacyPathsInvoked: invoked };
}

report.legacyPathVerification = verifyLegacyIsolation();
report.beforeOptimization = {
  source: "2026-09-03 已记录真实基准",
  copy: { targetCount: 2, modelCalls: 1, durationMs: 8318 },
  image: { slotCount: 2, searchCalls: 4, commonsCalls: 4, pageExtractionCalls: 14, downloadAttempts: 24, initialVisionCalls: 2, terminalVisionCalls: 1, durationMs: 228744 },
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (evidencePath) {
  const absoluteEvidencePath = path.isAbsolute(evidencePath) ? evidencePath : path.resolve(appRoot, evidencePath);
  mkdirSync(path.dirname(absoluteEvidencePath), { recursive: true });
  writeFileSync(absoluteEvidencePath, output, "utf8");
}
process.stdout.write(output);
