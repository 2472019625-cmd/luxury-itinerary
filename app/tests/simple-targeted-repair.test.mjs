import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fixture } from "./support/manual-image-fixture.mjs";
import { researchSimpleImageSlots } from "../server/simple-manual-images.mjs";
import { retrySimpleCopyTarget, retrySimpleCopyTargets, retrySimpleRenderer } from "../server/simple-targeted-repair.mjs";
import { mergeTargetedRepairPayload } from "../src/lib/manualImageState.js";

test("单项文案重试只执行目标 task，并保留其他内容与阻塞项", async (t) => {
  const value = await fixture({ includeCopyFailure:true });
  t.after(() => rm(value.root, { recursive:true, force:true }));
  const before = value.store.getFinalResult(value.projectId, value.executionRunId);
  before.data.title = "定制师已经修改的标题";
  value.store.saveFinalResult(value.projectId, value.executionRunId, before);
  let receivedTasks = [];
  const payload = await retrySimpleCopyTarget({
    ...value,
    targetId:"copy:day:1",
    runCopy:async ({ tasks }) => {
      receivedTasks = tasks.map((item) => item.targetId);
      return { status:"success", results:[{ targetId:"copy:day:1", targetPath:"days.0.description", status:"success", value:"只重写后的当天文案", warnings:[] }], metrics:{ modelCalls:1, researchCalls:0 } };
    },
    render:async ({ mode }) => ({ status:"success", mode, outputPath:"targeted-draft.png", rendererCalls:1 }),
  });
  assert.deepEqual(receivedTasks, ["copy:day:1"]);
  assert.equal(payload.project.data.days[0].description, "只重写后的当天文案");
  assert.equal(payload.project.data.title, "定制师已经修改的标题");
  assert.equal(payload.blockingItems.some((item) => item.id === "copy:day:1"), false);
  assert.equal(payload.blockingItems.filter((item) => item.kind === "image").length, 2);
  assert.equal(payload.canEnterFinal, false);
});

test("单项文案重试失败时只保留该项问题，不覆盖原文案", async (t) => {
  const value = await fixture({ includeCopyFailure:true });
  t.after(() => rm(value.root, { recursive:true, force:true }));
  const payload = await retrySimpleCopyTarget({
    ...value,
    targetId:"copy:day:1",
    runCopy:async () => ({ status:"failed", results:[{ targetId:"copy:day:1", targetPath:"days.0.description", status:"failed", error:{ code:"copy_request_failed", message:"仍然失败" } }], metrics:{ modelCalls:1 } }),
    render:async ({ mode }) => ({ status:"success", mode, outputPath:"targeted-draft.png", rendererCalls:1 }),
  });
  assert.equal(payload.project.data.days[0].description, "原来的当天文案");
  assert.equal(payload.blockingItems.find((item) => item.id === "copy:day:1")?.action, "retry_copy");
});

test("最终排版单项复检只在其他必需项完成后开放下载", async (t) => {
  const value = await fixture({ oneSlot:true });
  t.after(() => rm(value.root, { recursive:true, force:true }));
  const current = value.store.getFinalResult(value.projectId, value.executionRunId);
  current.unresolvedItems = [{ kind:"renderer", id:"renderer:2000", status:"failed", required:true, error:{ code:"renderer_failed", message:"测试失败" } }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, current);
  const payload = await retrySimpleRenderer({
    ...value,
    render:async ({ mode }) => ({ status:"success", mode, outputPath:"final-2000.png", rendererCalls:1 }),
  });
  assert.equal(payload.repair.status, "success");
  assert.equal(payload.unresolvedRequiredCount, 0);
  assert.equal(payload.canEnterFinal, true);
  assert.match(payload.outputUrl, /\/output$/);
});

test("单项返回只合并目标文案，不回滚等待期间的其他编辑", () => {
  const current = { manualVersion:1, project:{ data:{ title:"刚改的标题", days:[{ description:"旧文案", theme:"刚改的主题" }], simpleImageSlotBindings:{} } } };
  const incoming = { manualVersion:2, repair:{ kind:"copy", status:"success", targetPath:"days.0.description" }, project:{ data:{ title:"服务器旧标题", days:[{ description:"新文案", theme:"服务器旧主题" }], simpleImageSlotBindings:{} } } };
  const merged = mergeTargetedRepairPayload(current, incoming);
  assert.equal(merged.project.data.days[0].description, "新文案");
  assert.equal(merged.project.data.days[0].theme, "刚改的主题");
  assert.equal(merged.project.data.title, "刚改的标题");
});

test("失败文案批量重试一次提交全部目标，部分成功只写回成功项并只渲染一次", async (t) => {
  const value = await fixture({ copyFailureCount:2 });
  t.after(() => rm(value.root, { recursive:true, force:true }));
  let receivedTasks = [];
  let renderCalls = 0;
  const payload = await retrySimpleCopyTargets({
    ...value,
    runCopy:async ({ tasks }) => {
      receivedTasks = tasks.map((item) => item.targetId);
      return { status:"partial_success", results:[
        { targetId:"copy:day:1", targetPath:"days.0.description", status:"success", value:"批量生成后的当天文案", warnings:[] },
        { targetId:"copy:day:1:theme", targetPath:"days.0.theme", status:"failed", error:{ code:"copy_request_failed", message:"主题仍失败" } },
      ], metrics:{ modelCalls:2, researchCalls:0 } };
    },
    render:async ({ mode }) => { renderCalls += 1; return { status:"success", mode, outputPath:"batch-draft.png", rendererCalls:1 }; },
  });
  assert.deepEqual(receivedTasks, ["copy:day:1", "copy:day:1:theme"]);
  assert.equal(renderCalls, 1);
  assert.equal(payload.project.data.days[0].description, "批量生成后的当天文案");
  assert.equal(payload.project.data.days[0].theme, "原来的当天主题");
  assert.deepEqual(payload.repair.successfulTargets, [{ targetId:"copy:day:1", targetPath:"days.0.description" }]);
  assert.deepEqual(payload.repair.failedTargetIds, ["copy:day:1:theme"]);
  assert.equal(payload.blockingItems.some((item) => item.id === "copy:day:1"), false);
  assert.equal(payload.blockingItems.some((item) => item.id === "copy:day:1:theme"), true);
});

test("批量文案返回只合并成功字段，保留等待期间的其他人工编辑", () => {
  const current = { manualVersion:1, project:{ data:{ title:"人工标题", days:[{ description:"旧文案", theme:"人工主题" }], simpleImageSlotBindings:{} } } };
  const incoming = { manualVersion:2, repair:{ kind:"copy_batch", status:"partial_success", successfulTargets:[{ targetId:"copy:day:1", targetPath:"days.0.description" }], failedTargetIds:["copy:day:1:theme"] }, project:{ data:{ title:"服务器标题", days:[{ description:"批量新文案", theme:"服务器旧主题" }], simpleImageSlotBindings:{} } } };
  const merged = mergeTargetedRepairPayload(current, incoming);
  assert.equal(merged.project.data.days[0].description, "批量新文案");
  assert.equal(merged.project.data.days[0].theme, "人工主题");
  assert.equal(merged.project.data.title, "人工标题");
});

test("缺图批量重搜一次提交全部图片位并只保存渲染一次", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive:true, force:true }));
  let receivedSlots = [];
  let renderCalls = 0;
  const selected = { ...value.candidate, hardJudgment:{ ...value.candidate.hardJudgment, eligible:true }, autoReviewStatus:"approved" };
  const payload = await researchSimpleImageSlots({
    ...value,
    runImage:async ({ slots }) => {
      receivedSlots = slots.map((item) => item.slotId);
      return { status:"partial_success", results:[
        { slotId:"image:cover:primary", status:"success", selected, candidates:[selected], technicalStatus:"selected" },
        { slotId:"image:day:1:primary", status:"not_found", selected:null, candidates:[], technicalStatus:"no_eligible_candidate" },
      ] };
    },
    render:async ({ mode }) => { renderCalls += 1; return { status:"success", mode, outputPath:"batch-image-draft.png", rendererCalls:1 }; },
  });
  assert.deepEqual(receivedSlots, ["image:cover:primary", "image:day:1:primary"]);
  assert.equal(renderCalls, 1);
  assert.deepEqual(payload.repair.successfulSlotIds, ["image:cover:primary"]);
  assert.deepEqual(payload.repair.failedSlotIds, ["image:day:1:primary"]);
  assert.equal(payload.blockingItems.some((item) => item.id === "image:cover:primary"), false);
  assert.equal(payload.blockingItems.some((item) => item.id === "image:day:1:primary"), true);
});
