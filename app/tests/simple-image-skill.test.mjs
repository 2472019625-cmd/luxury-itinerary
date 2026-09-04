import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildControlledFallbackPlan, buildImageConstraints, buildImageQueries, runImageSearchSkill } from "../server/simple-image-skill.mjs";
import { judgeCandidatesBatch } from "../server/image-audit.mjs";

const slot = (id, overrides = {}) => ({ slotId: id, moduleType: "day", required: true, location: "塞伦盖蒂", activity: "全天游猎", subject: "草原环境与游猎行动", visualGoal: "表现进入草原后的环境建立", visualContext: { dayRole: "环境建立", avoid: ["与相邻 DAY 相同机位"] }, copyTargetId: `copy-${id}`, aspectRatio: "16:9", userLocked: false, ...overrides });

async function runAuditedFixture(t, slotInput, { candidateCount = 1, judgments }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-hard-match-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return runImageSearchSkill({
    root,
    slots: [slotInput],
    searchApiKey: "search-key",
    searchModel: "search-model",
    visionApiKey: "vision-key",
    visionBaseUrl: "https://vision.example/v1",
    visionModel: "vision-model",
    sourcePagesPerSlot: 1,
    downloadsPerSlot: candidateCount,
    visionCandidatesPerSlot: candidateCount,
    adapters: {
      searchWebBatch: async () => [{ title: "受控候选页", pageUrl: "https://example.com/page", officialHint: true }],
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => Array.from({ length: candidateCount }, (_, index) => ({ ...page, fixtureIndex: index, imageUrl: `${page.pageUrl}/candidate-${index + 1}.jpg` })),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const number = candidate.fixtureIndex + 1;
        const filePath = path.join(directory, `candidate-${number}.jpg`);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30 * number, g: 90, b: 120 } } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/candidate-${number}.jpg`, sha256: `controlled-hash-${number}`, width: 1200, height: 800 };
      },
      judgeCandidatesBatch: async ({ candidates }) => judgments(candidates),
    },
  });
}

async function runLayeredFixture(t, {
  slotInput = slot("layered", { location: "Singita Grumeti Serengeti Tanzania", activity: "anti-poaching observation post visit", subject: "anti-poaching observation post" }),
  exactCandidates = [{ name: "exact-pool", actualSubject: "酒店泳池", semanticScore: 25 }],
  fallbackCandidates = [{ name: "fallback-ranger", actualSubject: "Grumeti ranger patrol team carrying field equipment", semanticScore: 30 }],
  exactEligible = false,
  fallbackAudit = {},
  events = [],
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-layered-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloadIndex = 0;
  return runImageSearchSkill({
    root, slots: [slotInput], searchApiKey: "search", searchModel: "search-model",
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "vision-model",
    sourcePagesPerSlot: 1, downloadsPerSlot: 4, visionCandidatesPerSlot: 4,
    adapters: {
      searchWebBatch: async ({ queries }) => {
        const fallback = queries.some((query) => /ranger led|ranger patrol|game scout|Maasai cultural|Maasai people|night reserve|balloon flight/i.test(query));
        events.push(fallback ? "fallback_search" : "exact_search");
        return [{ title: fallback ? "Fallback activity page" : "Exact activity page", pageUrl: `https://example.com/${fallback ? "fallback" : "exact"}` }];
      },
      searchCommonsImages: async () => [],
      extractPageImages: async (page, options) => {
        const fallback = page.pageUrl.endsWith("/fallback");
        events.push(fallback ? "fallback_semantic_extract" : "exact_semantic_extract");
        if (!fallback) assert.match(options.semanticTerms.join(" "), /anti-poaching observation post/i);
        return (fallback ? fallbackCandidates : exactCandidates).map((candidate) => ({ ...page, imageUrl: `${page.pageUrl}/${candidate.name}.jpg`, alt: candidate.actualSubject, semanticScore: candidate.semanticScore || 0 }));
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloadIndex += 1;
        const filePath = path.join(directory, `layer-${downloadIndex}.jpg`);
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: { r: 30 * downloadIndex, g: 80, b: 110 } } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/layer-${downloadIndex}.jpg`, sha256: `layer-hash-${downloadIndex}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ slot: judgedSlot, candidates }) => {
        const fallback = /ranger patrol|conservation work|Maasai cultural|wilderness walking|hot air balloon/i.test(judgedSlot.activity || "");
        events.push(fallback ? "fallback_visual" : "exact_visual");
        return candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          actualSubject: candidate.alt,
          locationMatch: fallback ? fallbackAudit.locationMatch ?? true : true,
          hotelIdentityMatch: true,
          activityMatch: fallback ? fallbackAudit.activityMatch ?? true : exactEligible,
          subjectMatch: fallback ? fallbackAudit.subjectMatch ?? true : exactEligible,
          watermarkFree: true,
          nonAI: fallbackAudit.nonAI ?? true,
          photographic: fallbackAudit.photographic ?? true,
          technicalUsable: true,
          eligible: fallback ? fallbackAudit.eligible ?? true : exactEligible,
          hardRejectCode: "none",
          score: 92,
          reason: candidate.alt,
        }));
      },
    },
  });
}

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
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate, index) => ({ candidateId: candidate.candidateId, score: 90 - index, actualSubject: candidate.alt, locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", reason: "地点、活动和主体匹配" })),
    };
    const result = await runImageSearchSkill({
      root,
      slots: [slot("day-1"), slot("day-empty", { activity: "空目标", subject: "空目标", visualGoal: "空目标" }), slot("day-failed", { activity: "失败目标", subject: "失败目标", visualGoal: "失败目标" })],
      searchApiKey: "search-key", searchBaseUrl: "https://search.example/v1", searchModel: "search-model",
      visionApiKey: "vision-key", visionBaseUrl: "https://vision.example/v1", visionModel: "vision-model",
      concurrency: { slots: 3, search: 3, pages: 3, downloads: 3, vision: 2 }, adapters,
      onCapabilityCall: (event) => events.push(event),
    });
    assert.equal(result.metrics.businessBatches, 1);
    assert.ok(result.results[0].queriesUsed.length >= 2);
    assert.equal(result.results[0].status, "success");
    assert.ok(result.results[0].selected.candidateId.startsWith("candidate-"));
    assert.equal(result.results[0].selected.candidateId, result.results[0].candidates[0].candidateId);
    assert.equal(result.results[1].status, "not_found");
    assert.equal(result.results[2].status, "failed");
    assert.ok(searchPeak > 1);
    assert.ok(result.metrics.concurrencyPeak.slots > 1);
    assert.equal(result.metrics.searchCalls, 4);
    assert.equal(result.metrics.technicalRetries.search, 1);
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

test("连续相似 DAY 的搜索 query 只保留地点和核心主体，差异上下文留给筛选", async () => {
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
    assert.doesNotMatch(querySets.flat().join(" "), /环境建立|深入观察|地貌转换|相邻 DAY/);
    assert.ok(querySets.flat().every((query) => query.length <= 120));
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

test("官方 Gallery 命中后补取酒店落地页，并优先下载可确认酒店身份的主体图", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-hotel-gallery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extractedPages = [];
  const downloadedUrls = [];
  let index = 0;
  const result = await runImageSearchSkill({
    root,
    slots: [slot("image:hotel:sabora:primary", { moduleType:"hotel", location:"Grumeti Reserve Tanzania", hotel:"Singita Sabora Tented Camp", activity:"", subject:"可确认 Singita Sabora Tented Camp 身份的帐篷营地、客房或公共空间" })],
    searchApiKey:"search-key", searchModel:"search-model", visionApiKey:"vision-key", visionBaseUrl:"https://vision.example/v1", visionModel:"vision-model",
    sourcePagesPerSlot:2, downloadsPerSlot:2, visionCandidatesPerSlot:2,
    adapters: {
      searchWebBatch: async () => [{ title:"Singita Sabora Gallery", pageUrl:"https://singita.com/lodge/singita-sabora-tented-camp/gallery", officialHint:true, searchRank:1 }],
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => {
        extractedPages.push(page.pageUrl);
        if (/gallery\/?$/.test(page.pageUrl)) return [{ ...page, imageUrl:"https://images.ctfassets.net/demo/moon-with-lilies.jpg?w=2400", alt:"Moon with lilies", semanticText:"moon with lilies atmosphere" }];
        return [
          { ...page, imageUrl:"https://images.ctfassets.net/demo/moon-with-lilies.jpg?w=2400", alt:"Moon with lilies", semanticText:"moon with lilies atmosphere" },
          { ...page, imageUrl:"https://images.ctfassets.net/demo/sabora-tented-suite-exterior.jpg?w=2400", alt:"Singita Sabora tented suite exterior", semanticText:"Singita Sabora Tented Camp guest tent exterior" },
          { ...page, imageUrl:"https://images.ctfassets.net/demo/sabora-lounge.jpg?w=2400", alt:"Singita Sabora lounge", semanticText:"Singita Sabora Tented Camp public lounge interior" },
        ];
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloadedUrls.push(candidate.imageUrl);
        index += 1;
        const filePath = path.join(directory, `hotel-${index}.jpg`);
        await sharp({ create:{ width:1600, height:1000, channels:3, background:{ r:60 * index, g:90, b:110 } } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl:`${publicPrefix}/hotel-${index}.jpg`, sha256:`hotel-${index}`, width:1600, height:1000 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => ({ candidateId:candidate.candidateId, actualSubject:candidate.alt, locationMatch:true, hotelIdentityMatch:true, activityMatch:true, subjectMatch:true, watermarkFree:true, nonAI:true, photographic:true, technicalUsable:true, eligible:true, hardRejectCode:"none", score:95, reason:"官方酒店主体空间" })),
    },
  });
  assert.deepEqual(extractedPages, ["https://singita.com/lodge/singita-sabora-tented-camp/", "https://singita.com/lodge/singita-sabora-tented-camp/gallery"]);
  assert.equal(result.results[0].pipelineEvidence.officialSourcePages, 2);
  assert.ok(result.results[0].pipelineEvidence.officialExtractedCandidates >= 4);
  assert.equal(downloadedUrls.length, 2);
  assert.ok(downloadedUrls.every((url) => /suite|lounge/.test(url)));
  assert.equal(result.results[0].status, "success");
  assert.match(result.results[0].selected.imageUrl, /suite|lounge/);
});

test("DAY2酒店室内与DAY6帐篷室内均不能通过游猎视觉职责", async (t) => {
  for (const [id, actualSubject] of [["day-2", "Faru Faru 酒店室内休息区"], ["day-6", "Sabora 帐篷内部客厅"]]) {
    const result = await runAuditedFixture(t, slot(id, { activity: id === "day-6" ? "反偷猎观察站参访" : "塞伦盖蒂西部游猎", subject: id === "day-6" ? "反偷猎观察站参访" : "塞伦盖蒂西部游猎" }), {
      judgments: (candidates) => candidates.map((candidate) => ({ candidateId: candidate.candidateId, actualSubject, locationMatch: true, hotelIdentityMatch: true, activityMatch: false, subjectMatch: false, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 88, reason: "地点可能相关，但实际主体是住宿室内，不承担目标活动职责" })),
    });
    assert.equal(result.results[0].status, "not_found");
    assert.equal(result.results[0].selected, null);
    assert.equal(result.results[0].candidates[0].rejection, "activity_mismatch");
    assert.equal(result.results[0].candidates[0].hardJudgment.activityMatch, false);
  }
});

test("封面按candidateId绑定同一视觉记录与本地文件，不受判断返回顺序影响", async (t) => {
  const result = await runAuditedFixture(t, slot("cover", { moduleType: "cover", location: "坦桑尼亚", activity: "", subject: "塞伦盖蒂草原雄狮", visualGoal: "以草原雄狮作为唯一封面焦点", aspectRatio: "5:3" }), {
    candidateCount: 2,
    judgments: (candidates) => [
      { candidateId: candidates[1].candidateId, actualSubject: "塞伦盖蒂草原雄狮", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 96, reason: "主体与封面职责一致" },
      { candidateId: candidates[0].candidateId, actualSubject: "酒店室内", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: false, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: false, hardRejectCode: "subject_mismatch", score: 20, reason: "主体不符" },
    ],
  });
  const selected = result.results[0].selected;
  const selectedRecord = result.results[0].candidates.find((candidate) => candidate.candidateId === selected.candidateId);
  assert.equal(result.results[0].status, "success");
  assert.equal(selected.actualSubject, "塞伦盖蒂草原雄狮");
  assert.equal(selected.localUrl, selectedRecord.localUrl);
  assert.equal(selected.actualSubject, selectedRecord.actualSubject);
  assert.equal(selected.hardJudgment.eligible, true);
  assert.match(selected.localUrl, /candidate-2\.jpg$/);
});

test("真实批量视觉请求和返回都以candidateId为硬契约", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-audit-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await Promise.all([1, 2].map(async (number) => {
    const filePath = path.join(root, `${number}.jpg`);
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 20 * number, g: 80, b: 140 } } }).jpeg().toFile(filePath);
    return { candidateId: `candidate-fixed-${number}`, filePath, pageUrl: `https://example.com/${number}`, title: `候选${number}`, officialHint: true };
  }));
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments: [
      { candidateId: "candidate-fixed-2", actualSubject: "游猎车与草原", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 95 },
      { candidateId: "unknown", actualSubject: "未知", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 99 },
      { candidateId: "candidate-fixed-1", actualSubject: "酒店室内", locationMatch: true, hotelIdentityMatch: true, activityMatch: false, subjectMatch: false, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: false, hardRejectCode: "activity_mismatch", score: 20 },
    ] }) } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const judgments = await judgeCandidatesBatch({ slot: { label: "DAY2", module: "day", context: "塞伦盖蒂", subject: "游猎", visualGoal: "游猎职责", mustHave: ["地点：塞伦盖蒂", "活动：游猎", "主体：游猎"], prefer: [], forbid: [] }, candidates: files, apiKey: "key", baseUrl: "https://vision.invalid", model: "model" });
  const promptText = requestBody.messages[0].content.find((item) => item.type === "text").text;
  assert.match(promptText, /candidateId=candidate-fixed-1/);
  assert.match(promptText, /locationMatch/);
  assert.match(promptText, /eligible/);
  assert.match(promptText, /photographic/);
  assert.deepEqual(judgments.map((item) => item.candidateId), ["candidate-fixed-2", "candidate-fixed-1"]);
});

test("搜索 query 不拼接 visualGoal、differenceFromAdjacent 或 DAY 长文", () => {
  const queries = buildImageQueries(slot("walking", {
    location: "Singita Grumeti",
    activity: "walking night safari",
    subject: "walking night safari",
    visualGoal: "这是一段很长的视觉目标，不得进入搜索词",
    visualContext: { differenceFromAdjacent: "与前后日不同的冗长说明", daySourceFacts: "整段 DAY 文案" },
  }));
  assert.match(queries.join(" "), /Singita Grumeti walking night safari/);
  assert.doesNotMatch(queries.join(" "), /很长|前后日|整段 DAY/);
});

test("搜索非法JSON类技术错误以完全相同 query 重试一次", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-search-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const result = await runImageSearchSkill({
    root, slots: [slot("retry", { location: "Singita Grumeti", activity: "walking safari", subject: "walking safari" })],
    searchApiKey: "key", searchModel: "model",
    adapters: {
      searchWebBatch: async ({ queries }) => { seen.push([...queries]); if (seen.length === 1) throw new SyntaxError("Gemini 搜索未返回可解析的 JSON"); return []; },
      searchCommonsImages: async () => [],
    },
  });
  assert.equal(result.metrics.searchCalls, 3);
  assert.equal(result.metrics.technicalRetries.search, 1);
  assert.equal(result.metrics.automaticFollowupRounds, 0);
  assert.deepEqual(seen[0], seen[1]);
  assert.notDeepEqual(seen[1], seen[2]);
  assert.equal(result.results[0].pipelineEvidence.controlledFallback.entered, true);
  assert.equal(result.results[0].status, "not_found");
});

test("地图主图与坦桑尼亚位置冲突图即使其他判断为true也硬拒绝", async (t) => {
  for (const [id, actualSubject, photographic, expected] of [
    ["day-map", "DAY7 草原飞机返程路线地图", false, "non_photographic"],
    ["transport-china", "中国内蒙古呼伦贝尔机场的草原飞机照片", true, "place_mismatch"],
  ]) {
    const result = await runAuditedFixture(t, slot(id, { moduleType: id.startsWith("transport") ? "transport" : "day", location: "坦桑尼亚", activity: "草原飞机返程", subject: "草原飞机" }), {
      judgments: (candidates) => candidates.map((candidate) => ({ candidateId: candidate.candidateId, actualSubject, locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 95, reason: actualSubject })),
    });
    assert.equal(result.results[0].status, "not_found");
    assert.equal(result.results[0].candidates[0].rejection, expected);
  }
});

test("徒步游猎不能被酒店泳池木栈道人物照冒充", async (t) => {
  const result = await runAuditedFixture(t, slot("walking-pool", { location: "Singita Grumeti", activity: "walking safari", subject: "walking safari" }), {
    judgments: (candidates) => candidates.map((candidate) => ({ candidateId: candidate.candidateId, actualSubject: "酒店泳池边木栈道上的服务员", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 95, reason: "泳池边酒店服务场景" })),
  });
  assert.equal(result.results[0].status, "not_found");
  assert.equal(result.results[0].candidates[0].rejection, "activity_mismatch");
});

test("DAY primary 明确活动不能被模型误判为合格的酒店空间冒充", async (t) => {
  for (const [activity, actualSubject] of [
    ["塞伦盖蒂西部游猎", "酒店泳池躺椅与遮阳伞休闲区"],
    ["草原飞机返程", "营地 lounge 与餐厅"],
    ["马赛文化体验", "豪华客房与卧室"],
    ["反偷猎观察站参访", "帐篷室内起居空间"],
  ]) {
    const result = await runAuditedFixture(t, slot(`guard-${activity}`, { activity, subject: activity }), {
      judgments: (candidates) => candidates.map((candidate) => ({ candidateId: candidate.candidateId, actualSubject, locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 99, reason: "模型误判为可用" })),
    });
    assert.equal(result.results[0].status, "not_found", activity);
    assert.equal(result.results[0].candidates[0].rejection, "activity_mismatch", activity);
  }
});

test("活动语义相关候选优先消耗有限下载名额", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-semantic-ranking-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const downloadedUrls = [];
  const result = await runImageSearchSkill({
    root,
    slots: [slot("semantic", { location: "Singita Grumeti", activity: "anti-poaching observation post", subject: "anti-poaching observation post" })],
    searchApiKey: "key", searchModel: "model", visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1,
    adapters: {
      searchWebBatch: async () => [{ title: "Anti-poaching activity", pageUrl: "https://example.com/activity", officialHint: true }],
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => [
        { ...page, imageUrl: "https://example.com/pool.jpg", alt: "large pool", highResHint: true, semanticScore: 0, genericActivityPenalty: 36 },
        { ...page, imageUrl: "https://example.com/ranger.jpg", alt: "ranger at observation post", semanticScore: 70, semanticMatches: ["ranger", "observation post"], genericActivityPenalty: 0 },
      ],
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloadedUrls.push(candidate.imageUrl);
        const filePath = path.join(directory, "ranger.jpg");
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#556644" } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/ranger.jpg`, sha256: "semantic-ranger", width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => ({ candidateId: candidate.candidateId, actualSubject: "反偷猎巡护员位于观察站", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 96, reason: "活动主体匹配" })),
    },
  });
  assert.deepEqual(downloadedUrls, ["https://example.com/ranger.jpg"]);
  assert.equal(result.results[0].pipelineEvidence.semanticRelevantCandidates, 1);
  assert.equal(result.results[0].selected.semanticScore, 70);
  assert.deepEqual(result.results[0].selected.semanticMatches, ["ranger", "observation post"]);
});

test("精确活动图合格时记录 exact_match 且不进入 fallback", async (t) => {
  const events = [];
  const result = await runLayeredFixture(t, {
    exactCandidates: [{ name: "exact-post", actualSubject: "Grumeti anti-poaching observation post with game scouts", semanticScore: 70 }],
    exactEligible: true,
    events,
  });
  const item = result.results[0];
  assert.equal(item.status, "success");
  assert.equal(item.matchLevel, "exact_match");
  assert.equal(item.selected.matchLevel, "exact_match");
  assert.equal(item.pipelineEvidence.exactMatchSuccess, true);
  assert.equal(item.pipelineEvidence.controlledFallback.entered, false);
  assert.deepEqual(events, ["exact_search", "exact_semantic_extract", "exact_visual"]);
});

test("精确层按搜索、语义邻近提图、视觉判断顺序完成后才进入 controlled fallback", async (t) => {
  const events = [];
  const result = await runLayeredFixture(t, { events });
  assert.deepEqual(events, ["exact_search", "exact_semantic_extract", "exact_visual", "fallback_search", "fallback_semantic_extract", "fallback_visual"]);
  assert.equal(result.results[0].pipelineEvidence.semanticExtractionCompleted, true);
  assert.equal(result.results[0].pipelineEvidence.visualJudgmentCompleted, true);
  assert.equal(result.results[0].pipelineEvidence.controlledFallback.entered, true);
});

test("精确层无合格图时允许同保护区同主题真实摄影作为 controlled fallback", async (t) => {
  const result = await runLayeredFixture(t);
  const item = result.results[0];
  assert.equal(item.status, "success");
  assert.equal(item.matchLevel, "controlled_fallback");
  assert.equal(item.selected.matchLevel, "controlled_fallback");
  assert.equal(item.fallbackReason, "exact_activity_image_not_found");
  assert.equal(item.selected.fallbackReason, "exact_activity_image_not_found");
  assert.match(item.fallbackTheme, /ranger patrol/);
  assert.match(item.actualSubject, /ranger patrol/);
  assert.match(item.fallbackAllowedBecause, /目标地点.*体验主题.*真实摄影/);
  assert.deepEqual(item.originalExactTarget, { location: "Singita Grumeti Serengeti Tanzania", activity: "anti-poaching observation post visit", subject: "anti-poaching observation post" });
  assert.equal(result.metrics.automaticFollowupRounds, 0);
  assert.equal(result.metrics.businessBatches, 1);
});

test("酒店空间、非摄影、地点冲突和无关草原均不能成为 controlled fallback", async (t) => {
  const rejected = [
    ["pool", "酒店泳池与躺椅", {}, "activity_mismatch"],
    ["room", "豪华酒店客房与卧室", {}, "activity_mismatch"],
    ["restaurant", "酒店餐厅和 lounge", {}, "activity_mismatch"],
    ["map", "Grumeti anti-poaching observation post 路线地图示意图", { photographic: false }, "non_photographic"],
    ["wrong-place", "中国内蒙古呼伦贝尔 ranger patrol 活动照片", {}, "place_mismatch"],
    ["plain-savanna", "塞伦盖蒂普通草原风景，没有人物或保护活动", {}, "fallback_theme_mismatch"],
  ];
  for (const [name, actualSubject, fallbackAudit, expected] of rejected) {
    const result = await runLayeredFixture(t, { fallbackCandidates: [{ name, actualSubject }], fallbackAudit });
    const item = result.results[0];
    assert.equal(item.status, "not_found", name);
    assert.equal(item.selected, null, name);
    assert.equal(item.matchLevel, null, name);
    assert.equal(item.pipelineEvidence.controlledFallback.entered, true, name);
    assert.ok(item.candidates.some((candidate) => candidate.rejection === expected), `${name}: ${expected}`);
  }
});

test("controlled fallback 无技术候选时最终为 not_found 且不增加业务 round", async (t) => {
  const result = await runLayeredFixture(t, { exactCandidates: [], fallbackCandidates: [] });
  const item = result.results[0];
  assert.equal(item.status, "not_found");
  assert.equal(item.matchLevel, null);
  assert.equal(item.pipelineEvidence.controlledFallback.entered, true);
  assert.equal(item.pipelineEvidence.controlledFallback.evidence.visualJudgmentCompleted, true);
  assert.match(item.matchReason, /均无合格候选/);
  assert.equal(result.metrics.automaticFollowupRounds, 0);
  assert.equal(result.metrics.businessBatches, 1);
});

test("controlled fallback 只为 DAY primary 生成，不适用于 cover 或 hotel", () => {
  const exact = { location: "Serengeti", activity: "walking safari", subject: "walking safari" };
  assert.equal(buildControlledFallbackPlan(slot("cover", { ...exact, moduleType: "cover" })), null);
  assert.equal(buildControlledFallbackPlan(slot("hotel", { ...exact, moduleType: "hotel" })), null);
  assert.equal(buildControlledFallbackPlan(slot("image:day:1:secondary", exact)), null);
  assert.match(buildControlledFallbackPlan(slot("image:day:1:primary", exact)).fallbackTheme, /wilderness walking/);
});
