import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AgentPlanStore } from '../../server/agent-plan-store.mjs';
export async function fixture({ hardOnly = false, oneSlot = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-manual-images-"));
  await mkdir(path.join(root, 'output/image-assets/test'), { recursive: true });
  const jpeg = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#61754b' } }).jpeg().toBuffer();
  for (const name of ['selectable.jpg', 'hard.jpg']) await writeFile(path.join(root, 'output/image-assets/test', name), jpeg);
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
