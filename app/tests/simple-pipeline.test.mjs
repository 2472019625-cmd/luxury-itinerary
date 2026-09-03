import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSimplePipeline } from "../server/simple-pipeline-executor.mjs";
import { APPROVED_PAYMENT } from "../server/simple-fixed-modules.mjs";
import { copyRequestJson, createWorkbookFile, imageAdapters, plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");

test("完整链路并行调用两个 Skill，隔离单项失败并阻止必需缺图进入100%", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rendererCalls = 0;
  const result = await runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: appRoot,
    storeRoot: path.join(root, "projects"),
    plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
    copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson({ failTargetId: "copy:day:2" }) },
    imageOptions: {
      visionApiKey: "fixture", visionBaseUrl: "https://vision.invalid", visionModel: "fixture",
      sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1,
      adapters: imageAdapters({ appRoot, failMatcher: (query) => /Angama Amboseli/.test(query) || /草原飞机/.test(query) }),
    },
    adapters: { render: async () => { rendererCalls += 1; return { status: "success", outputPath: "should-not-render.png", rendererCalls: 1 }; } },
  });
  assert.equal(result.concurrency.copyImage.parallel, true);
  assert.equal(result.callCounts.copyModelCalls, 1);
  assert.equal(result.callCounts.copyBusinessBatches, 1);
  assert.equal(result.callCounts.imageBusinessBatches, 1);
  assert.ok(result.plannerResult.copyTaskCount > 3);
  assert.ok(result.plannerResult.imageSlotCount > 3);
  assert.equal(result.copyExecution.results.find((item) => item.targetId === "copy:day:2").status, "failed");
  assert.equal(result.copyExecution.results.find((item) => item.targetId === "copy:day:1").status, "success");
  assert.equal(result.writeback.copy.find((item) => item.targetId === "copy:day:1").targetPath, "days.0.description");
  assert.ok(result.writeback.images.some((item) => item.status === "written"));
  assert.ok(result.writeback.images.some((item) => item.status === "removed_optional"));
  assert.ok(result.unresolvedItems.some((item) => item.kind === "image" && item.required));
  assert.notEqual(result.pipelineStatus, "complete");
  assert.equal(result.renderStatus, "blocked_by_required_items");
  assert.equal(rendererCalls, 0);
  assert.equal(result.legacyEvidence.clear, true);
  assert.equal(result.legacyEvidence.invoked.length, 0);
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
    copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson() },
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
  assert.deepEqual(receivedData.payment, APPROVED_PAYMENT);
  assert.ok(result.plannerResult.warnings.some((item) => item.code === "product_highlight_material_insufficient"));
});

test("原始资料没有 notes 且必需生成失败时不得渲染或完成", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-notes-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rendererCalls = 0;
  const result = await runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: appRoot,
    storeRoot: path.join(root, "projects"),
    plannerOptions: { apiKey: "fixture", baseUrl: "https://planner.invalid", model: "fixture", requestJson: plannerRequestJson() },
    copyOptions: { apiKey: "fixture", baseUrl: "https://copy.invalid", model: "fixture", requestJson: copyRequestJson({ failTargetId: "copy:notes:travel-preparation" }) },
    imageOptions: { visionApiKey: "fixture", visionBaseUrl: "https://vision.invalid", visionModel: "fixture", sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1, adapters: imageAdapters({ appRoot }) },
    adapters: { render: async () => { rendererCalls += 1; return { status: "success", outputPath: "should-not-render.png", rendererCalls: 1 }; } },
  });
  assert.notEqual(result.pipelineStatus, "complete");
  assert.equal(result.renderStatus, "blocked_by_required_items");
  assert.equal(rendererCalls, 0);
  assert.ok(result.unresolvedItems.some((item) => item.id === "copy:notes:travel-preparation" && item.required));
});
