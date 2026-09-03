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
      searchWebBatch: async ({ queries }) => {
        searchActive += 1; searchPeak = Math.max(searchPeak, searchActive);
        await new Promise((resolve) => setTimeout(resolve, 8));
        searchActive -= 1;
        if (queries.some((query) => query.includes("失败目标"))) throw new Error("provider unavailable");
        if (queries.some((query) => query.includes("空目标"))) return [];
        return [{ title: queries.join(" | "), pageUrl: `https://example.com/${encodeURIComponent(queries[0])}`, officialHint: false }];
      },
      searchCommonsImages: async (query) => { if (query.includes("失败目标")) throw new Error("commons unavailable"); return []; },
      extractPageImages: async (page) => [{ ...page, imageUrl: `${page.pageUrl}/image.jpg`, alt: page.title }],
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        colorIndex += 1;
        const filePath = path.join(directory, `${colorIndex}.jpg`);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30 * colorIndex, g: 80, b: 120 } } }).jpeg().toFile(filePath);
        files.set(candidate.imageUrl, filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${colorIndex}.jpg`, sha256: `hash-${colorIndex}`, width: 1200, height: 800 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate, index) => ({ index, score: 90 - index, pass: true, actualSubject: candidate.alt, subjectMatch: true, placeMatch: true, sourceSupportsIdentity: false, watermark: false, hardRejectCode: "none", reason: "地点、活动和主体匹配" })),
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
    assert.equal(result.metrics.searchCalls, 3);
    assert.equal(result.metrics.batchVisionCalls, 1);
    assert.equal(result.metrics.topConfirmationCalls, 0);
    assert.equal(result.metrics.automaticFollowupRounds, 0);
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
        searchWebBatch: async ({ queries }) => [{ title: queries.join(" "), pageUrl: "https://example.com/page" }],
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

test("连续相似 DAY 在真实 Skill 入口使用 visualGoal 与 visualContext 形成可区分搜索目标", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-similar-days-"));
  const slots = [
    slot("day-1", { location: "安博塞利", visualGoal: "以开阔草原和远山建立首日环境", visualContext: { dayRole: "环境建立", keyExperiences: ["安博塞利保护区", "全天游猎"], avoid: ["相邻 DAY 同义画面"] } }),
    slot("day-2", { location: "塞伦盖蒂中部", visualGoal: "表现深入草原后的行动感与空间纵深", visualContext: { dayRole: "深入观察", keyExperiences: ["塞伦盖蒂中部", "全天游猎"], avoid: ["相邻 DAY 同义画面"] } }),
    slot("day-3", { location: "恩戈罗恩戈罗", visualGoal: "表现火山口地貌中的游猎环境", visualContext: { dayRole: "地貌转换", keyExperiences: ["恩戈罗恩戈罗火山口", "全天游猎"], avoid: ["相邻 DAY 同义画面"] } }),
  ];
  const captured = new Map();
  try {
    const result = await runImageSearchSkill({
      root,
      slots,
      searchApiKey: "search-key",
      searchModel: "search-model",
      adapters: {
        searchWebBatch: async ({ queries }) => { captured.set(queries.find((query) => /安博塞利|塞伦盖蒂中部|恩戈罗恩戈罗/.test(query)).match(/安博塞利|塞伦盖蒂中部|恩戈罗恩戈罗/)?.[0], queries); return []; },
        searchCommonsImages: async () => [],
      },
    });
    assert.equal(result.metrics.searchCalls, 3);
    assert.equal(captured.size, 3);
    const querySets = [...captured.values()];
    assert.equal(new Set(querySets.map((queries) => queries.join("\n"))).size, 3);
    assert.match(captured.get("安博塞利").join(" "), /环境建立/);
    assert.match(captured.get("塞伦盖蒂中部").join(" "), /深入观察/);
    assert.match(captured.get("恩戈罗恩戈罗").join(" "), /地貌转换/);
    assert.doesNotMatch(querySets.flat().join(" "), /狮子|大象|日出|黄昏|热气球/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("酒店 slot 不搜索 Commons，普通 slot 每批最多一次", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-sources-"));
  let commonsCalls = 0;
  try {
    const result = await runImageSearchSkill({
      root,
      slots: [slot("hotel", { moduleType: "hotel", hotel: "Example Lodge", subject: "酒店公共空间" }), slot("day")],
      searchApiKey: "search-key", searchModel: "search-model",
      adapters: {
        searchWebBatch: async () => [],
        searchCommonsImages: async () => { commonsCalls += 1; return []; },
      },
    });
    assert.equal(commonsCalls, 1);
    assert.equal(result.metrics.commonsCalls, 1);
    assert.equal(result.metrics.searchCalls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
