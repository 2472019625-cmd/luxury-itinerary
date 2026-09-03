import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildImageConstraints, runImageSearchSkill } from "../server/simple-image-skill.mjs";

const slot = (id, overrides = {}) => ({ slotId: id, moduleType: "day", required: true, location: "塞伦盖蒂", activity: "全天游猎", subject: "草原环境与游猎行动", visualGoal: "表现进入草原后的环境建立", visualContext: { dayRole: "环境建立", avoid: ["与相邻 DAY 相同机位"] }, copyTargetId: `copy-${id}`, aspectRatio: "16:9", userLocked: false, ...overrides });

test("多 slot 单批次并发处理，多 query 且单 slot 失败不影响其他 slot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-skill-"));
  const files = new Map();
  let searchActive = 0;
  let searchPeak = 0;
  let colorIndex = 0;
  const events = [];
  try {
    const adapters = {
      searchWeb: async ({ query }) => {
        searchActive += 1; searchPeak = Math.max(searchPeak, searchActive);
        await new Promise((resolve) => setTimeout(resolve, 8));
        searchActive -= 1;
        if (query.includes("失败目标")) throw new Error("provider unavailable");
        if (query.includes("空目标")) return [];
        return [{ title: query, pageUrl: `https://example.com/${encodeURIComponent(query)}`, officialHint: false }];
      },
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => [{ ...page, imageUrl: `${page.pageUrl}/image.jpg`, alt: page.title }],
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        colorIndex += 1;
        const filePath = path.join(directory, `${colorIndex}.jpg`);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30 * colorIndex, g: 80, b: 120 } } }).jpeg().toFile(filePath);
        files.set(candidate.imageUrl, filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${colorIndex}.jpg`, sha256: `hash-${colorIndex}`, width: 1200, height: 800 };
      },
      auditCandidates: async ({ candidates }) => candidates.map((_, index) => ({ index, score: 90 - index })),
      validateCandidate: async ({ candidate }) => ({ pass: true, actualSubject: candidate.alt, subjectMatch: true, placeMatch: true, sourceSupportsIdentity: false, watermark: false, hardRejectCode: "none", reason: "地点、活动和主体匹配" }),
    };
    const result = await runImageSearchSkill({
      root,
      slots: [slot("day-1"), slot("day-empty", { subject: "空目标", visualGoal: "空目标" }), slot("day-failed", { subject: "失败目标", visualGoal: "失败目标" })],
      searchApiKey: "search-key", searchBaseUrl: "https://search.example/v1", searchModel: "search-model",
      visionApiKey: "vision-key", visionBaseUrl: "https://vision.example/v1", visionModel: "vision-model",
      concurrency: { slots: 3, search: 3, pages: 3, downloads: 3, vision: 2 }, adapters,
      onCapabilityCall: (event) => events.push(event),
    });
    assert.equal(result.metrics.businessBatches, 1);
    assert.ok(result.results[0].queriesUsed.length >= 2);
    assert.equal(result.results[0].status, "success");
    assert.equal(result.results[1].status, "not_found");
    assert.equal(result.results[2].status, "failed");
    assert.ok(searchPeak > 1);
    assert.ok(result.metrics.concurrencyPeak.slots > 1);
    assert.equal(result.metrics.searchCalls, 6);
    assert.ok(result.results[0].constraints.mustHave.some((item) => item.includes("塞伦盖蒂")));
    assert.ok(result.results[0].constraints.forbid.includes("AI 生成图"));
    assert.deepEqual([...new Set(events.map((event) => event.capabilityId))].sort(), ["image_search", "visual_judgment"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Planner 提供 mustHave 时拒绝旧接口", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-contract-"));
  try {
    const result = await runImageSearchSkill({ root, slots: [{ ...slot("old-slot"), mustHave: ["旧字段"] }] });
    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].warnings.join(" "), /不得提供 mustHave/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("没有真实视觉判断时不得默认通过", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-no-vision-"));
  try {
    let index = 0;
    const result = await runImageSearchSkill({
      root, slots: [slot("no-vision")], searchApiKey: "search-key", searchModel: "search-model",
      adapters: {
        searchWeb: async ({ query }) => [{ title: query, pageUrl: "https://example.com/page" }],
        searchCommonsImages: async () => [],
        extractPageImages: async (page) => [{ ...page, imageUrl: "https://example.com/image.jpg" }],
        downloadCandidate: async (candidate, { directory, publicPrefix }) => {
          index += 1; const filePath = path.join(directory, `${index}.jpg`);
          await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#335577" } }).jpeg().toFile(filePath);
          return { ...candidate, filePath, publicUrl: `${publicPrefix}/${index}.jpg`, sha256: `no-vision-${index}`, width: 1200, height: 800 };
        },
      },
    });
    assert.equal(result.results[0].status, "needs_user_action");
    assert.equal(result.results[0].technicalStatus, "visual_judgment_unavailable");
    assert.equal(result.results[0].selected, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("约束由 Image Skill 内部基于 slot 事实构建", () => {
  const constraints = buildImageConstraints(slot("constraints", { hotel: "Example Lodge" }));
  assert.ok(constraints.mustHave.includes("酒店身份：Example Lodge"));
  assert.ok(constraints.prefer.some((item) => item.includes("视觉职责")));
  assert.ok(constraints.forbid.includes("明显水印"));
});
