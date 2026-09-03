import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const slots = [
  {
    slotId: "smoke:day:grumeti-walking-night-safari", moduleType: "day", required: true,
    location: "Singita Grumeti Serengeti Tanzania", activity: "walking safari or night game drive", subject: "walking safari or night game drive",
    visualGoal: "真实呈现格鲁梅蒂保护区徒步游猎或夜间游猎体验，不以酒店室内替代",
    visualContext: { status: "optional_paid", differenceFromAdjacent: "区别于普通日间乘车游猎", avoid: ["酒店室内", "普通客房"] },
    copyTargetId: "smoke-copy-day-walking", aspectRatio: "16:9", userLocked: false,
  },
  {
    slotId: "smoke:day:maasai-village", moduleType: "day", required: true,
    location: "Serengeti Tanzania", activity: "Maasai village cultural visit", subject: "Maasai village cultural visit",
    visualGoal: "真实呈现塞伦盖蒂地区马赛村落文化参访，不以普通草原动物图替代",
    visualContext: { status: "optional_paid", differenceFromAdjacent: "文化体验而非普通游猎", avoid: ["摆拍影棚", "其他地区无关部族"] },
    copyTargetId: "smoke-copy-day-maasai", aspectRatio: "16:9", userLocked: false,
  },
  {
    slotId: "smoke:day:grumeti-anti-poaching", moduleType: "day", required: true,
    location: "Singita Grumeti Serengeti Tanzania", activity: "anti-poaching observation post visit", subject: "anti-poaching observation post",
    visualGoal: "真实呈现格鲁梅蒂反偷猎观察站或其现场工作场景，不以帐篷室内替代",
    visualContext: { status: "optional_paid", differenceFromAdjacent: "保护工作观察而非普通游猎", avoid: ["酒店室内", "帐篷客房"] },
    copyTargetId: "smoke-copy-day-anti-poaching", aspectRatio: "16:9", userLocked: false,
  },
];

const requestedSlot = process.argv.find((item) => item.startsWith("--slot="))?.slice("--slot=".length);
const selectedSlots = requestedSlot === "anti-poaching" ? slots.filter((slot) => slot.slotId.includes("anti-poaching")) : slots;
if (!selectedSlots.length) throw new Error(`未知 targeted slot：${requestedSlot}`);
const capabilityEvents = [];
const startedAt = Date.now();
const result = await runImageSearchSkill({
  root: appRoot,
  slots: selectedSlots,
  searchApiKey: process.env.IMAGE_SEARCH_API_KEY,
  searchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL,
  searchModel: process.env.IMAGE_SEARCH_MODEL,
  visionApiKey: process.env.BIGMODEL_API_KEY,
  visionBaseUrl: process.env.BIGMODEL_BASE_URL,
  visionModel: process.env.BIGMODEL_MODEL,
  sourcePagesPerSlot: 6,
  downloadsPerSlot: 10,
  visionCandidatesPerSlot: 4,
  concurrency: { slots: 3, search: 2, pages: 4, downloads: 3, vision: 1 },
  onCapabilityCall: (event) => capabilityEvents.push(event),
});

const report = {
  createdAt: new Date().toISOString(),
  branch: "agent/simple-skill-pipeline-v1",
  scope: requestedSlot === "anti-poaching" ? "anti-poaching targeted real image slot; no Excel, Planner, Copy, Program or Renderer" : "three targeted real image slots; no Excel, Planner, Copy, Program or Renderer",
  wallClockMs: Date.now() - startedAt,
  result,
  capabilityEvents: capabilityEvents.filter((event) => event.phase === "finished"),
};
const output = `${JSON.stringify(report, null, 2)}\n`;
const evidenceArg = process.argv.find((item) => item.startsWith("--evidence="));
if (evidenceArg) {
  const evidencePath = path.resolve(appRoot, evidenceArg.slice("--evidence=".length));
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, output, "utf8");
}
process.stdout.write(output);
