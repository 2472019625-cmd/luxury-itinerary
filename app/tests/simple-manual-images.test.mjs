import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildSimpleManualImagePayload, chooseSimpleImageCandidate, researchSimpleImageSlot, saveSimpleDayEditor, uploadSimpleImage } from "../server/simple-manual-images.mjs";
import { mergeManualImagePayload } from '../src/lib/manualImageState.js';
import { buildLayoutImageSlots } from '../src/lib/imageSlots.js';
import { createManualDayCard } from '../src/lib/dayEditorState.js';

import { fixture } from './support/manual-image-fixture.mjs';

test("保存先于慢 Renderer 返回；新版本不被旧渲染覆盖", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const render = async ({ mode }) => { if (++calls === 1) await wait; return { status: 'success', mode, outputPath: `render-${calls}.png` }; };
  const first = await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render, deferRender: true });
  assert.equal(first.renderPending, true);
  assert.equal(first.canEnterFinal, false);
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).project.data.heroImage, value.candidate.localUrl);
  const uploadBuffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: '#8b6f47' } }).jpeg().toBuffer();
  const secondPromise = uploadSimpleImage({ ...value, slotId: 'image:day:1:primary', dataUrl: `data:image/jpeg;base64,${uploadBuffer.toString('base64')}`, fileName: 'day-safe.jpg', render });
  // Release only once the second binding has really been committed.
  while (value.store.getFinalResult(value.projectId, value.executionRunId).manualImageCompletion.version < 2) await new Promise(resolve => setTimeout(resolve, 5));
  release();
  const second = await secondPromise;
  assert.equal(second.project.data.heroImage, value.candidate.localUrl);
  assert.match(second.project.data.days[0].spots[0].images[0].src, /^\/image-assets\/simple-manual-/);
  assert.equal(second.manualVersion, 2);
  assert.equal(second.canEnterFinal, true);
});

test("后台重搜保留等待期间的新选择，合并候选并反馈新增数", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const render = async ({ mode }) => ({ status: 'success', mode, outputPath: 'test.png' });
  const searching = researchSimpleImageSlot({ ...value, slotId: 'image:cover:primary', render, runImage: async () => { await wait; return { results: [{ slotId: 'image:cover:primary', status: 'not_found', candidates: [{ candidateId: 'new', localUrl: '/image-assets/test/new.jpg' }] }] }; } });
  await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render });
  release();
  const result = await searching;
  assert.equal(result.newCandidateCount, 1);
  assert.equal(result.project.data.heroImage, value.candidate.localUrl);
  assert.ok(result.project.data.imageCandidates.some(item => item.candidateId === 'new'));
});

test("Renderer 异常不丢图片；保存异常必须抛出", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render: async () => { throw new Error('render offline'); } });
  assert.equal(result.project.data.heroImage, value.candidate.localUrl);
  assert.equal(result.renderPending, false);
  assert.equal(result.canEnterFinal, false);
  value.store.saveFinalResult = () => { throw new Error('disk full'); };
  await assert.rejects(chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId }), /disk full/);
});

test("返回图片载荷保留等待期间文案，丢弃迟到的旧版本", async () => {
  const current = { manualVersion: 2, project: { data: { title: '正在编辑的标题', heroImage: 'old', days: [] } } };
  const incoming = { manualVersion: 3, project: { data: { title: '服务器旧标题', heroImage: 'new', simpleImageSlotBindings: { cover: { module: 'cover', fieldPath: 'heroImage' } } } } };
  const next = mergeManualImagePayload(current, incoming);
  assert.equal(next.project.data.title, '正在编辑的标题');
  assert.equal(next.project.data.heroImage, 'new');
  assert.equal(mergeManualImagePayload(next, { ...incoming, manualVersion: 1 }), next);
});

test("前端载荷展示人工图片位，并只开放明确可选候选", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.pipelineStatus, "partial");
  assert.equal(payload.unresolvedRequiredCount, 2);
  assert.equal(payload.canEnterEditor, true);
  assert.equal(payload.canEnterFinal, false);
  assert.equal(payload.project.data.requiredImageGate.passed, false);
  assert.equal(payload.project.data.simpleImageSlotBindings["image:cover:primary"].fieldPath, "heroImage");
  assert.equal(payload.imageReview.slots.length, 2);
  const candidates = payload.imageReview.slots[0].candidates;
  assert.equal(candidates.find((item) => item.candidateId === value.candidate.candidateId).status, "manual_review");
  const hardCandidate = candidates.find((item) => item.candidateId === value.hardCandidate.candidateId);
  assert.equal(hardCandidate.status, "hard_rejected");
  assert.equal(hardCandidate.autoReviewStatus, "auto_rejected");
  assert.equal(hardCandidate.manualOnly, true);
  assert.ok(hardCandidate.localPreviewUrl);
});

test("Step4 保留全部已规划 DAY 图片位并区分可选缺图状态", async (t) => {
  const value = await fixture({ includeOptionalDay: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.unresolvedRequiredCount, 2);
  assert.equal(payload.imageReview.slots.length, 3);
  const optional = payload.imageReview.slots.find((slot) => slot.slotId === "image:day:1:supporting:1");
  assert.equal(optional.required, false);
  assert.equal(optional.primaryVisualSubject, "花豹追踪");
  assert.equal(optional.status, "not_found");
  assert.match(payload.project.data.simpleImageSlotBindings[optional.slotId].editorImageStatus, /未找到图片/);
  assert.match(buildLayoutImageSlots(payload.project.data).find((slot) => slot.slotId === optional.slotId).label, /花豹追踪.*未找到图片.*可选/s);
});

test("Step4 区分候选待选、硬拒绝、审核超时和审核中", async (t) => {
  const value = await fixture({ includeOptionalDay: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  let result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const optional = result.imageExecution.results.find((item) => item.slotId === "image:day:1:supporting:1");
  optional.candidates = [{ ...value.hardCandidate, candidateId: "optional-hard" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  let payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === optional.slotId).status, "auto_rejected");
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === "image:cover:primary").status, "candidate_waiting");

  result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.imageExecution.results.find((item) => item.slotId === optional.slotId).candidates = [{ ...value.candidate, candidateId: "optional-timeout", reviewTimeout: true, autoReviewStatus: "review_timeout" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === optional.slotId).status, "review_timeout");

  result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.imageExecution.results.find((item) => item.slotId === optional.slotId).candidates = [{ ...value.candidate, candidateId: "optional-pending", autoReviewStatus: "audit_pending" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === optional.slotId).status, "audit_pending");
});

test("图片异步返回不会覆盖用户已编辑的视觉卡标题和说明", () => {
  const current = { manualVersion: 1, project: { data: { heroImage: "", days: [], simpleImageSlotBindings: { slot: { module: "day", fieldPath: "days.0.spots.0.images.0", cardTitle: "客户修改后的标题", cardDescription: "客户修改后的说明" } } } } };
  const incoming = { manualVersion: 2, project: { data: { heroImage: "", days: [], simpleImageSlotBindings: { slot: { module: "day", fieldPath: "days.0.spots.0.images.0", cardTitle: "服务端旧标题", cardDescription: "服务端旧说明", visualSubject: "花豹追踪" } }, imageReview: { slots: [] } } } };
  const merged = mergeManualImagePayload(current, incoming);
  assert.equal(merged.project.data.simpleImageSlotBindings.slot.cardTitle, "客户修改后的标题");
  assert.equal(merged.project.data.simpleImageSlotBindings.slot.cardDescription, "客户修改后的说明");
  assert.equal(merged.project.data.simpleImageSlotBindings.slot.visualSubject, "花豹追踪");
});

test("硬拒绝候选未经风险确认不能人工采用", async (t) => {
  const value = await fixture({ hardOnly: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.hardCandidate.candidateId, render: async () => assert.fail("不应启动 Renderer") }), /不能采用/);
});

test("人工采用只写回目标 slot，剩余 required 未清零时更新可编辑草稿", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let rendererCalls = 0;
  const payload = await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render: async ({ mode }) => { rendererCalls += 1; assert.equal(mode, "draft"); return { status: "success", mode, outputPath: "editable-draft.png", rendererCalls: 1 }; } });
  assert.equal(rendererCalls, 1);
  assert.equal(payload.pipelineStatus, "partial");
  assert.equal(payload.unresolvedRequiredCount, 1);
  assert.equal(payload.draftRendered, true);
  assert.equal(payload.project.data.heroImage, value.candidate.localUrl);
  assert.equal(payload.imageReview.slots.find((item) => item.slotId === "image:cover:primary").status, "human_selected");
  assert.deepEqual(payload.project.data.days[0].spots[0].images, []);
});

test("人工确认可采用非硬拒绝的待判断候选，跨位移动并保留证据", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const render = async ({ mode }) => ({ status: 'success', mode, outputPath: 'draft.png' });
  const uncertain = { ...value.hardCandidate, candidateId: 'candidate-uncertain', rejection: 'needs_user_judgment', autoRejected: false, hardJudgment: { ...value.hardCandidate.hardJudgment, activityMatch: true, subjectMatch: true } };
  const current = value.store.getFinalResult(value.projectId, value.executionRunId);
  current.imageExecution.results[0].candidates.push(uncertain);
  value.store.saveFinalResult(value.projectId, value.executionRunId, current);
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).project.data.imageCandidates.find(c => c.candidateId === value.hardCandidate.candidateId).manualSelectable, false);
  await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: uncertain.candidateId, manualConfirmed: true, render });
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: uncertain.candidateId, render }), /未确认/);
  const payload = await chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: uncertain.candidateId, manualConfirmed: true, render });
  assert.equal(payload.project.data.heroImage, '');
  assert.equal(payload.project.data.days[0].spots[0].images[0].src, uncertain.localUrl);
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[1].selected;
  assert.equal(saved.rejection, 'needs_user_judgment');
  assert.equal(saved.userSelected, true);
  assert.equal(saved.humanDecision.riskConfirmed, true);
  assert.deepEqual(saved.humanDecision.movedFrom, ['image:cover:primary']);
});

test("人工选择不能使用损坏文件且不修改项目", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(path.join(value.root, 'output/image-assets/test/selectable.jpg'), 'not an image');
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render: async () => assert.fail('不可渲染') }), /损坏/);
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[0].selected, null);
});

test("最后一个 required 上传补齐后直接启动 Renderer 并完成", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const modes = [];
  const render = async ({ mode }) => { modes.push(mode); return { status: "success", mode, outputPath: path.join(value.root, mode === "draft" ? "draft-2000.png" : "final-2000.png"), rendererCalls: 1, durationMs: 5 }; };
  await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render });
  const buffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#61754b" } }).jpeg().toBuffer();
  const payload = await uploadSimpleImage({ ...value, slotId: "image:day:1:primary", dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`, fileName: "day-1.jpg", render });
  assert.deepEqual(modes, ["draft", "final"]);
  assert.equal(payload.pipelineStatus, "complete");
  assert.equal(payload.unresolvedRequiredCount, 0);
  assert.equal(payload.canEnterFinal, true);
  assert.equal(payload.project.progress, 100);
  assert.equal(payload.imageReview.slots.find((item) => item.slotId === "image:day:1:primary").status, "uploaded");
  assert.match(payload.project.data.days[0].spots[0].images[0].src, /^\/image-assets\/simple-manual-/);
});

test("人工新增体验卡片先保存为空草稿，上传后才进入客户卡片", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const initial = buildSimpleManualImagePayload(value.store, value.projectId);
  const data = structuredClone(initial.project.data);
  const slotId = "manual:day:1:spot-manual:primary";
  createManualDayCard(data, 0, { spotId: "spot-manual", slotId });
  const bindings = Object.fromEntries(Object.entries(data.simpleImageSlotBindings).filter(([, binding]) => binding.module === "day" && binding.dayIndex === 0));
  const render = async ({ mode }) => ({ status: "success", mode, outputPath: `${mode}.png`, rendererCalls: 1 });
  let payload = await saveSimpleDayEditor({ ...value, dayIndex: 0, day: data.days[0], bindings, included: data.included, excluded: data.excluded, pendingConfirmations: data.pendingConfirmations, render });
  const manualSlot = payload.imageReview.slots.find((slot) => slot.slotId === slotId);
  assert.equal(manualSlot.required, false);
  assert.deepEqual(manualSlot.userRequiredActions, ["upload_real_image"]);
  assert.equal(payload.project.data.days[0].spots.find((spot) => spot.id === "spot-manual").images.length, 0);

  const buffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#9b7a3a" } }).jpeg().toBuffer();
  payload = await uploadSimpleImage({ ...value, slotId, dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`, fileName: "manual-card.jpg", render });
  const manualSpot = payload.project.data.days[0].spots.find((spot) => spot.id === "spot-manual");
  assert.match(manualSpot.images[0].src, /^\/image-assets\/simple-manual-/);
  assert.equal(payload.project.data.simpleImageSlotBindings[slotId].manualEditorCard, true);
});

test("用户主动单槽重搜只调用一个 slot，automaticFollowupRounds 保持 0", async (t) => {
  const value = await fixture({ oneSlot: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  let receivedSlots = [];
  const payload = await researchSimpleImageSlot({
    ...value,
    slotId: "image:cover:primary",
    runImage: async ({ slots }) => { receivedSlots = slots.map((item) => item.slotId); return { status: "needs_user_action", results: [{ slotId: slots[0].slotId, status: "not_found", selected: null, candidates: [], technicalStatus: "no_eligible_candidate", matchReason: "没有合格候选" }], metrics: { automaticFollowupRounds: 0 } }; },
    render: async ({ mode }) => ({ status: "success", mode, outputPath: "editable-draft.png", rendererCalls: 1 }),
  });
  assert.deepEqual(receivedSlots, ["image:cover:primary"]);
  assert.equal(payload.pipelineStatus, "partial");
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  assert.equal(final.imageExecution.metrics.automaticFollowupRounds, 0);
  assert.equal(final.manualImageCompletion.plannerModelCalls, 0);
  assert.equal(final.manualImageCompletion.copyModelCalls, 0);
});
