import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildSimpleManualImagePayload, chooseSimpleImageCandidate, researchSimpleImageSlot, uploadSimpleImage } from "../server/simple-manual-images.mjs";
import { mergeManualImagePayload } from '../src/lib/manualImageState.js';

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
  const secondPromise = chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: value.hardCandidate.candidateId, manualConfirmed: true, render });
  // Release only once the second binding has really been committed.
  while (value.store.getFinalResult(value.projectId, value.executionRunId).manualImageCompletion.version < 2) await new Promise(resolve => setTimeout(resolve, 5));
  release();
  const second = await secondPromise;
  assert.equal(second.project.data.heroImage, value.candidate.localUrl);
  assert.equal(second.project.data.days[0].spots[0].images[0].src, value.hardCandidate.localUrl);
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
  assert.equal(candidates.find((item) => item.candidateId === value.hardCandidate.candidateId).status, "hard_rejected");
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

test("人工确认可覆盖审核判断，跨位移动并保留证据", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const render = async ({ mode }) => ({ status: 'success', mode, outputPath: 'draft.png' });
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).project.data.imageCandidates.find(c => c.candidateId === value.hardCandidate.candidateId).manualSelectable, true);
  await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.hardCandidate.candidateId, manualConfirmed: true, render });
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: value.hardCandidate.candidateId, render }), /未确认/);
  const payload = await chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: value.hardCandidate.candidateId, manualConfirmed: true, render });
  assert.equal(payload.project.data.heroImage, '');
  assert.equal(payload.project.data.days[0].spots[0].images[0].src, value.hardCandidate.localUrl);
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[1].selected;
  assert.equal(saved.rejection, 'subject_mismatch');
  assert.equal(saved.userSelected, true);
  assert.equal(saved.humanDecision.riskConfirmed, true);
  assert.deepEqual(saved.humanDecision.movedFrom, ['image:cover:primary']);
});

test("人工确认不能使用损坏文件且不修改项目", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(path.join(value.root, 'output/image-assets/test/hard.jpg'), 'not an image');
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.hardCandidate.candidateId, manualConfirmed: true, render: async () => assert.fail('不可渲染') }), /损坏/);
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
