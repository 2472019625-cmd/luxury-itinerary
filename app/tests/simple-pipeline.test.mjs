import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSimplePipeline, statusFor } from "../server/simple-pipeline-executor.mjs";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { applySimpleSkillResults } from "../server/simple-pipeline-writeback.mjs";
import { APPROVED_PAYMENT } from "../server/simple-fixed-modules.mjs";
import { copyRequestJson, copyResearchFacts, createWorkbookFile, imageAdapters, plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");

test("完整链路隔离单项失败，必需项未齐时仍生成可编辑草稿但不进入100%", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rendererCalls = 0;
  const result = await runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: appRoot,
    storeRoot: path.join(root, "projects"),
    plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
    copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson({ failTargetId: "copy:day:2" }), researchFacts: copyResearchFacts },
    imageOptions: {
      visionApiKey: "fixture", visionBaseUrl: "https://vision.invalid", visionModel: "fixture",
      sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1,
      adapters: imageAdapters({ appRoot, failMatcher: (query) => /Angama Amboseli/.test(query) || /草原飞机/.test(query) }),
    },
    adapters: { render: async ({ mode }) => { rendererCalls += 1; assert.equal(mode, "draft"); return { status: "success", mode, outputPath: "editable-draft.png", rendererCalls: 1 }; } },
  });
  assert.equal(result.concurrency.copyImage.parallel, true);
  assert.equal(result.callCounts.copyModelCalls, 3);
  assert.equal(result.callCounts.copyBusinessBatches, 3);
  assert.equal(result.callCounts.imageBusinessBatches, 1);
  assert.ok(result.plannerResult.copyTaskCount > 3);
  assert.ok(result.plannerResult.imageSlotCount > 3);
  assert.equal(result.copyExecution.results.find((item) => item.targetId === "copy:day:2").status, "failed");
  assert.equal(result.copyExecution.results.find((item) => item.targetId === "copy:day:1").status, "success");
  assert.equal(result.writeback.copy.find((item) => item.targetId === "copy:day:1").targetPath, "days.0.description");
  assert.ok(result.writeback.images.some((item) => item.status === "written"));
  assert.ok(result.writeback.images.some((item) => item.status === "removed_optional"));
  assert.ok(result.unresolvedItems.some((item) => item.kind === "image" && item.required));
  assert.equal(result.pipelineStatus, "partial");
  assert.equal(result.renderStatus, "success");
  assert.equal(result.render.mode, "draft");
  assert.equal(rendererCalls, 1);
  assert.equal(result.legacyEvidence.clear, true);
  assert.equal(result.legacyEvidence.invoked.length, 0);
  assert.equal(result.legacyEvidence.automaticCopyRegenerationRounds, 0);
  assert.ok(result.warnings.some((item) => item.code === "product_highlight_material_insufficient"));
  const saved = JSON.parse(await readFile(path.join(root, "projects", result.projectId, result.finalResultRef), "utf8"));
  assert.equal(saved.pipelineStatus, result.pipelineStatus);
  assert.equal(saved.data.days[0].description, "当天沿既定路线展开真实活动，在明确的交通、用餐与住宿安排中形成独立体验重点。");
});

test("全部必需单元满足时进入 Renderer，并只在真实渲染成功后写100%", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "synthetic-2000.png");
  let receivedData;
  const result = await runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: appRoot,
    storeRoot: path.join(root, "projects"),
    plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
    copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson(), researchFacts: copyResearchFacts },
    imageOptions: { visionApiKey: "fixture", visionBaseUrl: "https://vision.invalid", visionModel: "fixture", sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1, adapters: imageAdapters({ appRoot }) },
    adapters: { render: async ({ data }) => { receivedData = data; await writeFile(outputPath, "2000px-render-fixture"); return { status: "success", outputPath, rendererCalls: 1, durationMs: 5 }; } },
  });
  assert.equal(result.pipelineStatus, "complete");
  assert.equal(result.renderStatus, "success");
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.callCounts.rendererCalls, 1);
  assert.equal(result.unresolvedItems.length, 0);
  assert.ok(receivedData.heroImage.startsWith("/assets/placeholders/"));
  assert.ok(receivedData.hotels.every((hotel) => hotel.images?.[0]?.src));
  assert.ok(receivedData.days.every((day) => day.spots?.[0]?.images?.[0]?.src));
  assert.ok(receivedData.notes.length > 0);
  assert.equal(result.writeback.copy.find((item) => item.targetId === "copy:notes:travel-preparation").status, "written");
  const coverExecution = result.imageExecution.results.find((item) => item.slotId === "image:cover:primary");
  const coverWriteback = result.writeback.images.find((item) => item.slotId === "image:cover:primary");
  assert.equal(coverExecution.selected.candidateId, coverWriteback.candidateId);
  assert.equal(coverExecution.selected.localUrl, coverWriteback.src);
  assert.equal(coverExecution.selected.actualSubject, coverExecution.candidates.find((item) => item.candidateId === coverExecution.selected.candidateId).actualSubject);
  assert.deepEqual(receivedData.payment, APPROVED_PAYMENT);
  assert.ok(result.plannerResult.warnings.some((item) => item.code === "product_highlight_material_insufficient"));
});

test("取消信号在内容制作后阻止写回、渲染和完成态持久化", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let rendererCalls = 0;
  await assert.rejects(runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: appRoot,
    storeRoot: path.join(root, "projects"),
    signal: controller.signal,
    plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
    adapters: {
      runCopy: async () => { controller.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
      runImage: async () => ({ status: "success", results: [], metrics: { businessBatches: 0, durationMs: 0 } }),
      render: async () => { rendererCalls += 1; return { status: "success", outputPath: "must-not-render.png", rendererCalls: 1 }; },
    },
  }), (error) => error?.name === "AbortError" && error?.code === "pipeline_cancelled");
  assert.equal(rendererCalls, 0);
});

test("正式版面检查未通过时自动保留可编辑草稿而不是卡住", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-render-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modes = [];
  const result = await runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: appRoot,
    storeRoot: path.join(root, "projects"),
    plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
    copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson(), researchFacts: copyResearchFacts },
    imageOptions: { visionApiKey: "fixture", visionBaseUrl: "https://vision.invalid", visionModel: "fixture", sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1, adapters: imageAdapters({ appRoot }) },
    adapters: { render: async ({ mode }) => {
      modes.push(mode);
      return mode === "final"
        ? { status: "blocked", mode, outputPath: null, rendererCalls: 1, qa: { issues: [{ code: "text_overflow" }] } }
        : { status: "success", mode, outputPath: "editable-draft.png", rendererCalls: 1 };
    } },
  });
  assert.deepEqual(modes, ["final", "draft"]);
  assert.equal(result.pipelineStatus, "partial");
  assert.equal(result.renderStatus, "success");
  assert.equal(result.render.mode, "draft");
  assert.equal(result.outputPath, "editable-draft.png");
  assert.equal(result.callCounts.rendererCalls, 2);
  assert.ok(result.unresolvedItems.some((item) => item.kind === "renderer"));
});

test("原始资料没有 notes 且必需生成失败时只生成草稿，不得完成", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-notes-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rendererCalls = 0;
  const result = await runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: appRoot,
    storeRoot: path.join(root, "projects"),
    plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
    copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson({ failTargetId: "copy:notes:travel-preparation" }), researchFacts: copyResearchFacts },
    imageOptions: { visionApiKey: "fixture", visionBaseUrl: "https://vision.invalid", visionModel: "fixture", sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1, adapters: imageAdapters({ appRoot }) },
    adapters: { render: async ({ mode }) => { rendererCalls += 1; assert.equal(mode, "draft"); return { status: "success", mode, outputPath: "editable-draft.png", rendererCalls: 1 }; } },
  });
  assert.notEqual(result.pipelineStatus, "complete");
  assert.equal(result.renderStatus, "success");
  assert.equal(rendererCalls, 1);
  assert.ok(result.unresolvedItems.some((item) => item.id === "copy:notes:travel-preparation" && item.required));
});

test("required Copy/system failure 优先于图片 needs_user_action", () => {
  const imageIssue = { kind: "image", id: "image:day:2:primary", status: "needs_user_action", required: true, requiredAction: "needs_user_action" };
  assert.equal(statusFor([imageIssue], "blocked_by_required_items"), "awaiting_user_action");
  assert.equal(statusFor([{ kind: "copy", id: "copy:day:2", status: "failed", required: true }, imageIssue], "blocked_by_required_items"), "partial");
  assert.equal(statusFor([{ kind: "image", id: "image:day:2:primary", status: "failed", required: true }], "blocked_by_required_items"), "partial");
});

test("可选图片位因 Planner unresolved 时仍保留给 Step4，不按普通缺图移除", () => {
  const slotId = "image:day:1:supporting:1";
  const imageSlots = [{
    slotId,
    required: false,
    plannerSlotStatus: "unresolved",
    needsUserAction: true,
    plannerValidationIssues: [{ code: "duplicate_visual_responsibility", message: "视觉职责重复" }],
  }];
  const slotBindings = { [slotId]: { module: "cover", fieldPath: "heroImage", imageIndex: 0, required: false } };
  const result = applySimpleSkillResults({
    preparedData: { heroImage: null, hotels: [], diningExperiences: [], transportSummary: [], days: [], simpleImageSlotBindings: slotBindings },
    imageSlots,
    slotBindings,
    imageExecution: { results: [{ slotId, status: "needs_user_action", technicalStatus: "planner_slot_unresolved", plannerValidationIssues: imageSlots[0].plannerValidationIssues }] },
  });
  assert.equal(result.unresolvedItems.length, 1);
  assert.equal(result.unresolvedItems[0].required, false);
  assert.equal(result.unresolvedItems[0].technicalStatus, "planner_slot_unresolved");
  assert.equal(result.imageWriteback[0].status, "needs_user_action");
});

test("Image Slot 使用地理位置、单一封面焦点和全日事实选择DAY视觉主体", () => {
  const regularDay = (index) => ({ theme: "塞伦盖蒂西部", city: "塞伦盖蒂西部", routeNodes: ["塞伦盖蒂西部", "Singita Sabora Tented Camp"], hotel: "Singita Sabora Tented Camp", description: "独立包车敞篷越野游猎", spots: [{ id: `safari-${index}`, name: "塞伦盖蒂西部游猎", description: "独立包车敞篷越野游猎", status: "included", statusLabel: "已包含", feeBoundary: "included", images: [] }] });
  const days = Array.from({ length: 6 }, (_, index) => regularDay(index));
  days[0] = { ...regularDay(0), routeNodes: ["乞力马扎罗国际机场", "塞伦盖蒂西部", "Singita Faru Faru Lodge"], hotel: "Singita Faru Faru Lodge", description: "乘草原飞机抵达后开始敞篷越野游猎，追踪非洲五霸", spots: [{ id: "arrival", name: "草原飞机抵达", description: "抵达后开始敞篷越野游猎", status: "included", statusLabel: "已包含", feeBoundary: "included", images: [] }] };
  days[5] = { ...regularDay(5), description: "游猎日，可自费参观格鲁梅蒂反偷猎观察站", spots: [...regularDay(5).spots, { id: "anti-poaching", name: "反偷猎观察站参访", description: "可自费参观格鲁梅蒂反偷猎观察站", status: "optional_paid", statusLabel: "自费可选", feeBoundary: "excluded", images: [] }] };
  const agentPlan = {
    planId: "plan-fixture",
    summary: { visualTheme: "野奢草原" },
    modules: [],
    selectedHighlights: [],
    dayRoles: days.map((_day, index) => ({ index, role: index === 0 ? "抵达并进入保护区" : "游猎日", differenceFromAdjacent: index === 0 ? "交通衔接为主，无游猎活动" : index === 5 ? "新增反偷猎观察站选项" : `DAY ${index + 1}真实节奏`, contentAction: "optimize", sourceRefs: [`days.${index}`] })),
    imagePlan: { visualStory: "机场、飞机、酒店、动物、帐篷、日落与返程全部同时出现", slots: [{ role: "cover", primaryVisualSubject: "塞伦盖蒂草原游猎" }] },
  };
  const plan = materializeSimpleSkillPlan({ data: { title: "坦桑尼亚6日", destination: "坦桑尼亚", hotels: [{ id: "faru", officialName: "Singita Faru Faru Lodge", shortName: "Faru Faru", region: "塞伦盖蒂西部", images: [] }, { id: "sabora", officialName: "Singita Sabora Tented Camp", shortName: "Sabora", region: "塞伦盖蒂西部", images: [] }], diningExperiences: [], transportSummary: [], notes: [], days }, report: {}, agentPlan });
  const cover = plan.imageSlots.find((item) => item.slotId === "image:cover:primary");
  const day1 = plan.imageSlots.find((item) => item.slotId === "image:day:1:primary");
  const day6 = plan.imageSlots.find((item) => item.slotId === "image:day:6:primary");
  assert.equal(cover.subject, "塞伦盖蒂草原游猎");
  assert.match(cover.visualGoal, /唯一核心视觉焦点/);
  assert.doesNotMatch(cover.visualGoal, /机场、飞机、酒店/);
  assert.equal(day1.location, "塞伦盖蒂西部");
  assert.doesNotMatch(plan.dayRoles[0].differenceFromAdjacent, /无游猎/);
  assert.match(plan.dayRoles[0].differenceFromAdjacent, /包含已确认游猎/);
  assert.equal(day6.location, "塞伦盖蒂西部");
  assert.equal(day6.subject, "反偷猎观察站参访");
  assert.equal(day6.visualContext.experienceStatus, "optional_paid");
  assert.match(day6.visualGoal, /自费可选/);
  assert.equal(plan.slotBindings[day6.slotId].spotIndex, 1);
  assert.equal(plan.slotBindings[day6.slotId].fieldPath, "days.5.spots.1.images.0");
});
