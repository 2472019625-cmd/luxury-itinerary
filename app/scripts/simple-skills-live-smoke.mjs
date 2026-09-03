import { existsSync, readFileSync } from "node:fs";
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

const mode = process.argv[2] || "all";
const report = {};

if (["all", "copy"].includes(mode)) {
  const events = [];
  const result = await runCopyWriterSkill({
    itineraryContext: { destination: "肯尼亚", dayCount: 2, journeyTheme: "从草原初见到深入观察" },
    tasks: [
      { targetId: "highlight-1", moduleType: "product_highlight", targetPath: "highlights.0", outputSchema: { type: "string", minLength: 8 }, facts: { sourceType: "source_designated", statement: "草原飞机串联核心保护区，减少长距离陆路转场" }, factStatuses: { statement: "confirmed" }, plannerGoal: "短标题加客户价值，忠实表达交通设计对整程节奏的改善", relevantContext: { destination: "肯尼亚" } },
      { targetId: "day-1", moduleType: "day", targetPath: "days.0.description", outputSchema: { type: "string", minLength: 12 }, facts: { route: "内罗毕—安博塞利", activity: "抵达后进入保护区游猎", hotel: "安博塞利区域营地" }, factStatuses: { route: "confirmed", activity: "included", hotel: "confirmed" }, plannerGoal: "说明当天如何从抵达过渡到草原初见", relevantContext: { dayRole: "整程环境建立" } },
    ],
    apiKey: process.env.TEXT_MODEL_API_KEY,
    baseUrl: process.env.TEXT_MODEL_BASE_URL,
    model: process.env.TEXT_MODEL_NAME,
    onCapabilityCall: (event) => events.push(event),
  });
  report.copy = { status: result.status, resultStatuses: result.results.map((item) => ({ targetId: item.targetId, status: item.status, errorCode: item.error?.code || null })), metrics: result.metrics, capabilityCalls: events.filter((item) => item.phase === "finished").map((item) => ({ capabilityId: item.capabilityId, durationMs: item.durationMs, attemptCount: item.attemptCount, failed: Boolean(item.failed) })) };
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
    onCapabilityCall: (event) => events.push(event),
  });
  report.image = { status: result.status, resultStatuses: result.results.map((item) => ({ slotId: item.slotId, status: item.status, queriesUsed: item.queriesUsed.length, technicalStatus: item.technicalStatus })), metrics: result.metrics, capabilityCalls: events.filter((item) => item.phase === "finished").map((item) => ({ capabilityId: item.capabilityId, target: item.target, durationMs: item.durationMs, attemptCount: item.attemptCount, failed: Boolean(item.failed) })) };
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
