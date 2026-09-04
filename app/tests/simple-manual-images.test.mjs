import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";
import { buildSimpleManualImagePayload, chooseSimpleImageCandidate, researchSimpleImageSlot, uploadSimpleImage } from "../server/simple-manual-images.mjs";

async function fixture({ hardOnly = false, oneSlot = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-manual-images-"));
  const store = new AgentPlanStore(path.join(root, "output", "simple-pipeline", "projects"));
  const projectId = "project-manual-images";
  const planId = "plan-manual-images";
  const executionRunId = "run-manual-images";
  const preparedData = {
    title: "测试行程",
    subtitle: "",
    destination: "坦桑尼亚",
    dayCount: 1,
    startDate: "2026-10-01",
    endDate: "2026-10-01",
    adults: 2,
    children: 0,
    travelers: 2,
    heroImage: "",
    hotels: [],
    transportSummary: [],
    days: [{ id: "day-1", date: "2026-10-01", routeNodes: ["塞伦盖蒂"], city: "塞伦盖蒂", mealPlan: {}, hotel: "", vehicle: "", estimatedTravelTime: "", overnightType: "none", spots: [{ id: "spot-1", name: "游猎", status: "included", statusLabel: "已包含", feeBoundary: "included", sourceEvidence: [], images: [] }] }],
    highlights: [], included: [], excluded: [], cancellation: [], pendingConfirmations: [], notes: [{ title: "提示", items: ["测试"] }],
  };
  const coverSlot = { slotId: "image:cover:primary", moduleType: "cover", required: true, location: "坦桑尼亚", subject: "草原飞机", visualGoal: "草原飞机", userLocked: false };
  const daySlot = { slotId: "image:day:1:primary", moduleType: "day", required: true, location: "塞伦盖蒂", subject: "游猎", visualGoal: "游猎", userLocked: false };
  const imageSlots = oneSlot ? [coverSlot] : [coverSlot, daySlot];
  const candidate = { candidateId: "candidate-selectable", localUrl: "/image-assets/test/selectable.jpg", sourceTitle: "测试候选", actualSubject: "真实草原飞机", hardJudgment: { locationMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: false } };
  const hardCandidate = { candidateId: "candidate-hard", localUrl: "/image-assets/test/hard.jpg", sourceTitle: "错误候选", actualSubject: "酒店泳池", rejection: "subject_mismatch", rejectionReason: "酒店泳池不能冒充活动图", hardJudgment: { locationMatch: true, activityMatch: false, subjectMatch: false, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: false } };
  const coverResult = { slotId: coverSlot.slotId, status: "needs_user_action", selected: null, candidates: [candidate, hardCandidate], technicalStatus: "no_eligible_candidate", manualAction: { originalVisualTarget: { location: "坦桑尼亚", subject: "草原飞机" }, selectableCandidates: hardOnly ? [] : [candidate], rejectedCandidates: [hardCandidate], userRequiredActions: ["choose_existing_candidate", "upload_real_image", "explicit_single_slot_search"] } };
  const dayResult = { slotId: daySlot.slotId, status: "needs_user_action", selected: null, candidates: [], technicalStatus: "no_eligible_candidate", manualAction: { originalVisualTarget: { location: "塞伦盖蒂", subject: "游猎" }, selectableCandidates: [], rejectedCandidates: [], userRequiredActions: ["upload_real_image", "explicit_single_slot_search"] } };
  const imageResults = oneSlot ? [coverResult] : [coverResult, dayResult];
  store.createProject({ projectId, flowKind: "simple_skill_v1", status: "partial", currentStage: "剩余图片人工补齐", progress: 75, activePlanId: null, planIds: [], executionRunIds: [], activeExecutionRunId: null, inputFingerprint: "fingerprint" });
  store.activatePlan(projectId, { planId, preparedData, copyTasks: [], imageSlots, slotBindings: { "image:cover:primary": { module: "cover", fieldPath: "heroImage", imageIndex: 0, required: true }, "image:day:1:primary": { module: "day", dayIndex: 0, spotIndex: 0, fieldPath: "days.0.spots.0.images.0", imageIndex: 0, required: true } } });
  store.saveExecutionRun(projectId, { executionRunId, projectId, planId, inputFingerprint: "fingerprint", flowKind: "simple_skill_v1", status: "partial", progress: 75, executionEnabled: false, currentStage: "剩余图片人工补齐", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  store.saveFinalResult(projectId, executionRunId, { projectId, pipelineStatus: "partial", copyExecution: { status: "success", results: [], metrics: { modelCalls: 0 } }, imageExecution: { status: "needs_user_action", results: imageResults, metrics: { automaticFollowupRounds: 0 } }, unresolvedItems: imageSlots.map((slot) => ({ kind: "image", id: slot.slotId, status: "needs_user_action", required: true, requiredAction: "needs_user_action", selectableCandidateIds: slot.slotId === coverSlot.slotId && !hardOnly ? [candidate.candidateId] : [] })), renderStatus: "blocked_by_required_items", outputPath: null, data: preparedData, manualImageCompletion: { slotIds: imageSlots.map((slot) => slot.slotId), plannerModelCalls: 0, copyModelCalls: 0, rendererCalls: 0 } });
  return { root, store, projectId, executionRunId, candidate, hardCandidate };
}

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

test("硬拒绝候选不能人工采用", async (t) => {
  const value = await fixture({ hardOnly: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.hardCandidate.candidateId, render: async () => assert.fail("不应启动 Renderer") }), /不能采用/);
});

test("人工采用只写回目标 slot，剩余 required 未清零时不启动 Renderer", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let rendererCalls = 0;
  const payload = await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render: async () => { rendererCalls += 1; return { status: "success", outputPath: "unused", rendererCalls: 1 }; } });
  assert.equal(rendererCalls, 0);
  assert.equal(payload.pipelineStatus, "partial");
  assert.equal(payload.unresolvedRequiredCount, 1);
  assert.equal(payload.project.data.heroImage, value.candidate.localUrl);
  assert.equal(payload.imageReview.slots.find((item) => item.slotId === "image:cover:primary").status, "human_selected");
  assert.deepEqual(payload.project.data.days[0].spots[0].images, []);
});

test("最后一个 required 上传补齐后直接启动 Renderer 并完成", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render: async () => assert.fail("首槽不应启动 Renderer") });
  const buffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#61754b" } }).jpeg().toBuffer();
  let rendererCalls = 0;
  const payload = await uploadSimpleImage({ ...value, slotId: "image:day:1:primary", dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`, fileName: "day-1.jpg", render: async () => { rendererCalls += 1; return { status: "success", outputPath: path.join(value.root, "final-2000.png"), rendererCalls: 1, durationMs: 5 }; } });
  assert.equal(rendererCalls, 1);
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
    render: async () => assert.fail("重搜未补齐时不应启动 Renderer"),
  });
  assert.deepEqual(receivedSlots, ["image:cover:primary"]);
  assert.equal(payload.pipelineStatus, "partial");
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  assert.equal(final.imageExecution.metrics.automaticFollowupRounds, 0);
  assert.equal(final.manualImageCompletion.plannerModelCalls, 0);
  assert.equal(final.manualImageCompletion.copyModelCalls, 0);
});
