import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopyTaskQueue } from "../server/copy-task-queue.mjs";
import { COPY_GENERATION_CONFIG } from "../config/copy-generation.mjs";
import { generateModularCopy } from "../server/modular-copy-generator.mjs";
import { mergeParallelImageResult } from "../server/image-copy-consistency.mjs";
import { activeGenerationByFingerprint, generationFingerprint } from "../server/generation-dedup.mjs";
import { modelTaskProfile, MODEL_TASK_PROFILES } from "../config/model-task-routing.mjs";

test("all copy work shares a queue whose initial concurrency is exactly two", async () => {
  assert.equal(COPY_GENERATION_CONFIG.initialConcurrency, 2);
  assert.equal(COPY_GENERATION_CONFIG.maximumConcurrency, 3);
  assert.equal(COPY_GENERATION_CONFIG.dayGroupSize, 3);
  const queue = new CopyTaskQueue();
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 7 }, (_, index) => queue.add(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }, { taskId: `task-${index}` })));
  assert.equal(peak, 2);
  assert.equal(queue.peakActive, 2);
});

test("routes high reasoning to mainline, brand review and small complex target repairs", () => {
  assert.deepEqual(modelTaskProfile("mainline"), { taskKind: "mainline", reasoningEffort: "high", thinkingType: "enabled" });
  assert.deepEqual(modelTaskProfile("brandReview"), { taskKind: "brandReview", reasoningEffort: "high", thinkingType: "enabled" });
  for (const taskKind of ["copyModule", "imageBlueprint", "targetedPatch"]) assert.equal(MODEL_TASK_PROFILES[taskKind].reasoningEffort, "low");
  assert.equal(MODEL_TASK_PROFILES.targetedPatchHigh.reasoningEffort, 'high');
  assert.equal(MODEL_TASK_PROFILES.targetRecheck.reasoningEffort, 'high');
  assert.equal(MODEL_TASK_PROFILES.mechanicalRepair.thinkingType, "disabled");
});

test("the shared queue throttles new copy requests to one after a rate limit", async () => {
  const queue = new CopyTaskQueue();
  queue.throttle(60_000);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 4 }, () => queue.add(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
  })));
  queue.restore();
  assert.equal(peak, 1);
  assert.equal(queue.concurrency, COPY_GENERATION_CONFIG.initialConcurrency);
});

test("duplicate submissions with the same facts reuse the active generation job", () => {
  const fingerprint = generationFingerprint({ destination: "坦桑尼亚" }, { requests: "慢节奏" });
  const active = { id: "active-job", kind: "generation", generationFingerprint: fingerprint, status: "generating-copy" };
  const jobs = new Map([[active.id, active], ["old", { id: "old", kind: "generation", generationFingerprint: fingerprint, status: "complete" }]]);
  assert.equal(activeGenerationByFingerprint(jobs, fingerprint), active);
  active.status = "failed";
  assert.equal(activeGenerationByFingerprint(jobs, fingerprint), undefined);
});

test("parallel image results are adopted only after deterministic facts pass the final copy check", () => {
  const base = { title: "测试3天2晚定制游", subtitle: "真实路线", destination: "测试地", heroImage: "", hotels: [], diningExperiences: [], transportSummary: [], days: [{ id: "day-1", theme: "进入山谷", description: "沿真实路线进入山谷", routeNodes: ["A", "B"], overnightType: "hotel", spots: [{ id: "valley", name: "山谷", description: "步行观察", images: [] }] }] };
  const imageData = structuredClone(base);
  imageData.heroImage = "/image-assets/run/cover.jpg";
  imageData.days[0].spots[0].images = [{ src: "/image-assets/run/day.jpg" }];
  imageData.imageReview = { slots: [] };
  const accepted = mergeParallelImageResult(base, imageData, { factsPreserved: true });
  assert.equal(accepted.data.heroImage, "/image-assets/run/cover.jpg");
  assert.equal(accepted.data.days[0].spots[0].images[0].src, "/image-assets/run/day.jpg");
  assert.equal(accepted.report.passed, true);
  const rejected = mergeParallelImageResult(base, imageData, { factsPreserved: false });
  assert.equal(rejected.data.heroImage, "");
  assert.equal(rejected.data.days[0].spots[0].images.length, 0);
  assert.equal(rejected.report.invalidatedSlotIds.length, 2);
});

test("modular generation groups DAYs by three, preserves completed units, and saves sanitized results", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "lux-copy-"));
  const sourceFacts = {
    destination: "测试目的地", dayCount: 7, days: Array.from({ length: 7 }, (_, index) => ({ index, date: `2026-09-${String(index + 1).padStart(2, "0")}`, routeNodes: [`地点${index}`], theme: `原主题${index}`, description: `原文${index}`, spots: [{ id: `spot-${index}`, name: `体验${index}`, description: `体验原文${index}` }] })),
    hotels: [], diningExperiences: [], transportSummary: [], included: ["住宿"], excluded: ["机票"], cancellation: [], sourcePosterHighlights: [], currentHighlights: [], authoritativeFacts: [], importPendingConfirmations: [],
  };
  const calls = [];
  const requestModel = async (prompt, payload, options) => {
    calls.push({ prompt, unitType: payload.unitType, dayIndexes: payload.facts?.days?.map((day) => day.index), taskId: options.taskId, taskKind: options.taskKind });
    if (prompt.includes("mainline")) return { json: { journeyPromise: "真实主线", narrativeArc: [], moduleGoals: {}, dayRoles: [], visualRoles: [], sourceEvidence: [] } };
    if (payload.unitType === "days" && payload.facts.days[0].index === 3) throw new Error("DAY组模拟失败");
    if (payload.unitType === "days") return { json: { days: payload.facts.days.map((day) => ({ index: day.index, theme: `意义${day.index}`, description: `客户文案${day.index}`, spots: day.spots.map((spot) => ({ id: spot.id, description: spot.description })), dayNotices: [] })), evidenceMap: {} } };
    if (payload.unitType === "global") return { json: { title: "测试目的地7天6晚定制游", subtitle: "真实路线", highlights: ["从容衔接：按真实路线安排"] } };
    if (payload.unitType === "closing") return { json: { notes: [], expenseCopy: { included: [{ index: 0, text: "住宿安排" }], excluded: [{ index: 0, text: "国际机票" }], cancellation: [] } } };
    return { json: {} };
  };
  const result = await generateModularCopy({ sourceFacts, requestModel, projectRoot, jobId: "job-test", onMainlineReady: async () => { calls.push({ prompt: "parallel-images-started" }); return { ok: true }; } });
  assert.equal(calls[1].prompt, "parallel-images-started");
  assert.equal(calls.find((call) => call.prompt.includes("mainline")).taskKind, "mainline");
  assert.equal(calls.find((call) => call.unitType === "global").taskKind, "copyModule");
  const dayCalls = calls.filter((call) => call.unitType === "days");
  assert.deepEqual(dayCalls.map((call) => call.dayIndexes), [[0, 1, 2], [3, 4, 5], [6]]);
  assert.equal(result.draft.days.length, 7);
  assert.equal(result.draft.days[0].description, "客户文案0");
  assert.equal(result.draft.days[3].description, "原文3");
  assert.equal(result.unitSummary.fallback, 1);
  const files = readdirSync(result.storeDirectory).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 14);
  const saved = files.map((name) => JSON.parse(readFileSync(path.join(result.storeDirectory, name), "utf8")));
  assert.equal(saved.filter((record) => record.type === "day").length, 7);
  assert.equal(saved.some((record) => JSON.stringify(record).includes("API Key")), false);
  assert.equal(saved.some((record) => "reasoning_content" in record), false);

  let unexpectedCalls = 0;
  const recovered = await generateModularCopy({
    sourceFacts,
    projectRoot,
    jobId: "job-recovered",
    requestModel: async () => { unexpectedCalls += 1; throw new Error("仅未完成单元允许再次尝试"); },
  });
  assert.equal(unexpectedCalls, 1);
  assert.equal(recovered.draft.days[0].description, "客户文案0");
  assert.equal(recovered.draft.days[3].description, "原文3");
  const recoveredMainline = JSON.parse(readFileSync(path.join(projectRoot, "workspace", "jobs", "job-recovered", "copy-units", "mainline.json"), "utf8"));
  assert.equal(recoveredMainline.recovery.reason, "reused_completed_unit");
});
