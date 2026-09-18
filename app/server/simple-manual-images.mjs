import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { applySimpleSkillResults } from "./simple-pipeline-writeback.mjs";
import { runSimpleRenderer } from "./simple-renderer.mjs";
import { getSlotImage, setSlotImage } from "../src/lib/imageSlots.js";

const MIME_EXTENSIONS = Object.freeze({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" });
const manualRenders = new Map();
const SLOT_LABELS = Object.freeze({
  "image:cover:primary": "封面主图 · 坦桑尼亚草原飞机",
  "image:hotel:imported-hotel-2:primary": "酒店主图 · Singita Sabora Tented Camp",
  "image:day:2:primary": "DAY 2 主图 · 塞伦盖蒂西部游猎",
  "image:day:3:primary": "DAY 3 主图 · 徒步 / 夜间游猎",
  "image:day:6:primary": "DAY 6 主图 · 反偷猎 / ranger patrol",
});
const SLOT_STATUS_LABELS = Object.freeze({
  auto_selected: "已自动选图",
  human_selected: "已人工采用",
  uploaded: "已上传",
  candidate_waiting: "有候选待选择",
  audit_pending: "候选审核中",
  auto_rejected: "候选审核未通过",
  review_timeout: "候选审核超时",
  processing: "正在处理",
  not_found: "未找到图片",
});

function uniqueCandidates(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.candidateId || item?.localUrl || item?.imageUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectContext(store, projectId) {
  const project = store.getProject(projectId);
  const run = project?.activeExecutionRunId ? store.getExecutionRun(projectId, project.activeExecutionRunId) : null;
  const plan = project?.activePlanId ? store.getPlan(projectId, project.activePlanId) : null;
  const result = run ? store.getFinalResult(projectId, run.executionRunId) : null;
  if (!project || !run || !plan || !result) throw Object.assign(new Error("Simple Pipeline 项目缺少当前计划、执行记录或 final-result"), { code: "simple_project_incomplete" });
  if (project.flowKind !== "simple_skill_v1" || run.flowKind !== "simple_skill_v1") throw Object.assign(new Error("目标不是 Simple Pipeline 项目"), { code: "wrong_project_flow" });
  return { project, run, plan, result };
}

function manualSlotIds(result, plan = {}) {
  const saved = result.manualImageCompletion?.slotIds;
  return [...new Set([
    ...(Array.isArray(saved) ? saved : []),
    ...(result.unresolvedItems || []).filter((item) => item.kind === "image").map((item) => item.id),
    ...(plan.imageSlots || []).filter((slot) => slot.moduleType === "day").map((slot) => slot.slotId),
    ...Object.entries(result.data?.simpleImageSlotBindings || {}).filter(([, binding]) => binding.manualEditorCard === true).map(([slotId]) => slotId),
  ].filter(Boolean))];
}

function unresolvedNotices(items = []) {
  const groups = new Map();
  for (const item of items) {
    let label = "其他生成问题";
    if (item.kind === "image") label = "图片待补充";
    else if (/^hotels\./.test(item.targetPath || "")) label = "酒店文案待处理";
    else if (/^transportSummary\./.test(item.targetPath || "")) label = "交通文案待处理";
    else if (/^days\./.test(item.targetPath || "")) label = "每日行程文案待处理";
    else if (item.kind === "copy") label = "其他文案待处理";
    const group = groups.get(label) || { label, count: 0, ids: [] };
    group.count += 1;
    group.ids.push(item.id);
    groups.set(label, group);
  }
  return [...groups.values()].map((group) => ({ ...group, message: `${group.label} ${group.count} 项` }));
}

function copyLocation(targetPath = "", data = {}) {
  let match = targetPath.match(/^days\.(\d+)\.(theme|description|dayNotices\.0\.text)$/);
  if (match) return `DAY ${String(Number(match[1]) + 1).padStart(2, "0")} · ${{ theme: "每日主题", description: "今日行程", "dayNotices.0.text": "今日贴士" }[match[2]]}`;
  match = targetPath.match(/^days\.(\d+)\.spots\.(\d+)\.description$/);
  if (match) return `DAY ${String(Number(match[1]) + 1).padStart(2, "0")} · ${data.days?.[Number(match[1])]?.spots?.[Number(match[2])]?.name || `体验 ${Number(match[2]) + 1}`}`;
  match = targetPath.match(/^hotels\.(\d+)\.(editorialCopy|proofPoints)$/);
  if (match) return `${data.hotels?.[Number(match[1])]?.shortName || data.hotels?.[Number(match[1])]?.officialName || `酒店 ${Number(match[1]) + 1}`} · ${match[2] === "proofPoints" ? "酒店卖点" : "酒店介绍"}`;
  match = targetPath.match(/^diningExperiences\.(\d+)\.editorialCopy$/);
  if (match) return `${data.diningExperiences?.[Number(match[1])]?.name || `特色餐饮 ${Number(match[1]) + 1}`} · 体验介绍`;
  match = targetPath.match(/^transportSummary\.(\d+)\.(usageLabel|editorialCopy|features)$/);
  if (match) return `${data.transportSummary?.[Number(match[1])]?.category || `交通 ${Number(match[1]) + 1}`} · ${{ usageLabel: "使用场景", editorialCopy: "交通介绍", features: "交通特点" }[match[2]]}`;
  match = targetPath.match(/^highlights\.(\d+)$/);
  if (match) return `产品亮点 ${Number(match[1]) + 1}`;
  if (targetPath === "title") return "封面标题";
  if (targetPath === "subtitle") return "封面副标题";
  if (targetPath === "notes") return "行前提示";
  return "客户行程文案";
}

function imageLocation(item = {}, data = {}, plan = {}) {
  const binding = data.simpleImageSlotBindings?.[item.id] || plan.slotBindings?.[item.id] || {};
  const planned = (plan.imageSlots || []).find((slot) => slot.slotId === item.id) || {};
  if (binding.module === "cover" || item.id.includes(":cover:")) return "封面主图";
  if (binding.module === "hotel" || item.id.includes(":hotel:")) {
    const hotel = data.hotels?.[binding.itemIndex ?? Number(String(binding.fieldPath || "").match(/^hotels\.(\d+)/)?.[1])];
    return `${hotel?.shortName || hotel?.officialName || "酒店"} · 主图`;
  }
  if (binding.module === "day" || item.id.includes(":day:")) {
    const idDay = Number(item.id.match(/:day:(\d+):/)?.[1]);
    const dayIndex = Number.isInteger(binding.dayIndex) ? binding.dayIndex : Number.isFinite(idDay) ? idDay - 1 : 0;
    const spot = data.days?.[dayIndex]?.spots?.find((value) => value.id && value.id === binding.spotId) || data.days?.[dayIndex]?.spots?.[binding.spotIndex];
    const subject = spot?.name || planned.primaryVisualSubject || planned.subject || binding.cardTitle || "体验图片";
    return `DAY ${String(dayIndex + 1).padStart(2, "0")} · ${subject}`;
  }
  if (binding.module === "transport") return `${data.transportSummary?.[binding.itemIndex]?.category || "交通"} · 图片`;
  return planned.primaryVisualSubject || planned.subject || "行程图片";
}

function blockingItems(items = [], data = {}, plan = {}) {
  return items.filter((item) => item.required).map((item) => {
    if (item.kind === "copy") return { kind: "copy", id: item.id, targetPath: item.targetPath || "", label: copyLocation(item.targetPath, data), message: "这段文案尚未生成完成，可以只重新生成这一项。", action: "retry_copy" };
    if (item.kind === "image") return { kind: "image", id: item.id, slotId: item.id, label: imageLocation(item, data, plan), message: "这张必需图片尚未补齐，可重新搜索、选择或上传。", action: "handle_image" };
    if (item.kind === "renderer") return { kind: "renderer", id: item.id, label: "2000px 高清成品", message: "内容已经齐全，但最后排版检查尚未通过。", action: "retry_renderer" };
    return { kind: item.kind || "confirmation", id: item.id, targetPath: item.targetPath || "", label: "生成前确认信息", message: "这项客户信息需要先确认，不能由系统自动改写。", action: "review_facts" };
  });
}

function moduleName(slotId) {
  if (slotId.includes(":cover:")) return "封面";
  if (slotId.includes(":hotel:")) return "臻选下榻";
  const match = slotId.match(/:day:(\d+):/);
  return match ? `DAY ${match[1]}` : "每日行程";
}

function candidatePool(imageResult = {}) {
  return uniqueCandidates([
    ...(imageResult.selected ? [imageResult.selected] : []),
    ...(imageResult.manualAction?.rejectedCandidates || []),
    ...(imageResult.manualAction?.selectableCandidates || []),
    ...(imageResult.candidates || []),
  ]);
}

function selectableIds(result, imageResult) {
  const unresolved = (result.unresolvedItems || []).find((item) => item.id === imageResult.slotId);
  return new Set([
    ...(unresolved?.selectableCandidateIds || []),
    ...(imageResult.manualAction?.selectableCandidates || []).map((item) => item.candidateId),
  ].filter(Boolean));
}

function frontendCandidate(candidate, slotId, binding, canSelect) {
  const hard = candidate.hardJudgment || {};
  const hardRejected = isHardRejectedCandidate(candidate);
  const reviewTimeout = candidate.reviewTimeout === true || candidate.autoReviewStatus === "review_timeout";
  return {
    ...candidate,
    slotId,
    pipelineSlotId: slotId,
    fieldPath: binding?.fieldPath || "",
    localPreviewUrl: candidate.localUrl || candidate.publicUrl || "",
    status: hardRejected ? "hard_rejected" : "manual_review",
    autoReviewStatus: hardRejected ? "auto_rejected" : reviewTimeout ? "review_timeout" : candidate.autoReviewStatus || (canSelect ? "not_auto_selected" : "manual_only"),
    autoRejected: hardRejected,
    reviewTimeout,
    notAutoSelected: candidate.selected !== true,
    manualOnly: candidate.selected !== true,
    adoptable: canSelect && !hardRejected,
    libraryEligible: canSelect && !hardRejected,
    manualSelectable: Boolean(candidate.localUrl?.startsWith('/image-assets/')) && !hardRejected,
    reason: candidate.rejectionReason || candidate.matchReason || candidate.reason || "暂无审核说明",
    terminalAudit: {
      relevance: hard.subjectMatch === true && hard.activityMatch !== false ? "主体相符" : "主体不符",
      luxury: "—",
      cleanliness: hard.watermarkFree === false ? "有水印" : "无明显水印",
      composition: hard.technicalUsable === false ? "技术不可用" : "技术可用",
      subjectMatch: hard.subjectMatch,
      placeMatch: hard.locationMatch,
    },
  };
}

function candidateCanBeSelected(result, imageResult, candidate) {
  if (!candidate?.candidateId || !(candidate.localUrl || candidate.publicUrl)) return false;
  if (isHardRejectedCandidate(candidate)) return false;
  if (selectableIds(result, imageResult).has(candidate.candidateId)) return true;
  if (candidate.candidateId === imageResult.selected?.candidateId) return true;
  const hard = candidate.hardJudgment;
  return !candidate.rejection && hard?.eligible === true && hard.locationMatch !== false && hard.hotelIdentityMatch !== false && hard.activityMatch !== false && hard.subjectMatch !== false && hard.watermarkFree !== false && hard.nonAI !== false && hard.photographic !== false && hard.technicalUsable !== false;
}

function slotReviewStatus(imageResult = {}, candidates = []) {
  if (imageResult.status === "success") return imageResult.selected?.userProvided ? "uploaded" : imageResult.selected?.userSelected ? "human_selected" : "auto_selected";
  const hardRejected = candidates.filter((candidate) => candidate.autoRejected || candidate.status === "hard_rejected");
  const auditPending = candidates.some((candidate) => ["processing", "audit_pending", "pending"].includes(candidate.autoReviewStatus));
  const reviewTimeout = candidates.some((candidate) => candidate.reviewTimeout || candidate.autoReviewStatus === "review_timeout") || /review.*timeout|audit.*timeout/i.test(`${imageResult.status || ""} ${imageResult.technicalStatus || ""}`);
  if (auditPending) return "audit_pending";
  if (candidates.length && hardRejected.length === candidates.length) return "auto_rejected";
  if (candidates.length) return reviewTimeout ? "review_timeout" : "candidate_waiting";
  if (reviewTimeout) return "review_timeout";
  if (imageResult.status === "processing") return "processing";
  return "not_found";
}

function assertPlannedImageSlot(context, slotId) {
  const slot = context.plan.imageSlots.find((item) => item.slotId === slotId);
  if (!slot) throw Object.assign(new Error("该图片位不在当前计划中"), { code: "slot_not_in_plan" });
  return slot;
}

function editableImageBinding(context, slotId) {
  const planned = context.plan.imageSlots.find((item) => item.slotId === slotId);
  const binding = context.result.data?.simpleImageSlotBindings?.[slotId] || context.plan.slotBindings?.[slotId];
  if (planned) return { planned, binding, manualEditorCard: false };
  if (binding?.module === "day" && binding.manualEditorCard === true) return { planned: null, binding, manualEditorCard: true };
  throw Object.assign(new Error("该图片位不属于当前可编辑卡片"), { code: "slot_not_editable" });
}

export function buildSimpleManualImagePayload(store, projectId) {
  const { project, run, plan, result } = projectContext(store, projectId);
  const resultById = new Map((result.imageExecution?.results || []).map((item) => [item.slotId, item]));
  const slots = manualSlotIds(result, plan).map((slotId) => {
    const imageResult = resultById.get(slotId) || { slotId, status: "needs_user_action", candidates: [] };
    const selectables = selectableIds(result, imageResult);
    const binding = result.data?.simpleImageSlotBindings?.[slotId] || plan.slotBindings?.[slotId];
    const candidates = candidatePool(imageResult).map((candidate) => frontendCandidate(candidate, slotId, binding, selectables.has(candidate.candidateId)));
    const planned = plan.imageSlots.find((item) => item.slotId === slotId);
    return {
      slotId,
      module: moduleName(slotId),
      label: binding?.cardTitle || planned?.primaryVisualSubject || planned?.subject || SLOT_LABELS[slotId] || slotId,
      primaryVisualSubject: planned?.primaryVisualSubject || planned?.subject || planned?.activity || "",
      status: slotReviewStatus(imageResult, candidates),
      required: planned ? planned.required !== false : binding?.required === true,
      originalVisualTarget: imageResult.manualAction?.originalVisualTarget || (planned ? { location: planned.location, hotel: planned.hotel, activity: planned.activity, subject: planned.subject, visualGoal: planned.visualGoal } : null),
      currentResult: imageResult.manualAction?.currentSearchFallbackResult || { technicalStatus: imageResult.technicalStatus, matchReason: imageResult.matchReason },
      candidateCount: candidates.length,
      selectableCandidateIds: [...selectables],
      userRequiredActions: imageResult.manualAction?.userRequiredActions || (binding?.manualEditorCard ? ["upload_real_image"] : ["upload_real_image", "explicit_single_slot_search"]),
      candidates,
    };
  });
  const imageCandidates = uniqueCandidates((result.imageExecution?.results || []).flatMap((imageResult) => {
    const binding = result.data?.simpleImageSlotBindings?.[imageResult.slotId] || plan.slotBindings?.[imageResult.slotId];
    return candidatePool(imageResult).map((candidate) => frontendCandidate(candidate, imageResult.slotId, binding, candidateCanBeSelected(result, imageResult, candidate)));
  }));
  const unresolvedRequired = (result.unresolvedItems || []).filter((item) => item.required);
  const canEnterFinal = unresolvedRequired.length === 0 && Boolean(result.outputPath);
  const outputUrl = canEnterFinal ? `/api/simple/projects/${projectId}/output` : null;
  const notices = unresolvedNotices(result.unresolvedItems || []);
  const blockers = blockingItems(result.unresolvedItems || [], result.data || {}, plan);
  const draftRendered = result.renderStatus === "success" && result.render?.mode === "draft";
  const reviewBySlotId = new Map(slots.map((slot) => [slot.slotId, slot]));
  const editorBindings = Object.fromEntries(Object.entries(result.data?.simpleImageSlotBindings || plan.slotBindings || {}).map(([slotId, binding]) => {
    const review = reviewBySlotId.get(slotId);
    if (!review || binding.module !== "day") return [slotId, binding];
    return [slotId, {
      ...binding,
      editorImageStatus: SLOT_STATUS_LABELS[review.status] || "等待处理",
      editorImageRequired: review.required,
      editorPrimaryVisualSubject: review.primaryVisualSubject,
    }];
  }));
  return {
    project: {
      id: project.projectId,
      projectId: project.projectId,
      title: result.data?.title || project.source?.name || "Simple Pipeline 行程",
      workflowStage: result.pipelineStatus,
      status: project.status,
      currentStage: project.currentStage,
      progress: project.progress,
      versions: outputUrl ? [{ id: `simple-${run.executionRunId}`, name: `${result.data?.title || "行程"} · 2000px 正式成品`, createdAt: Date.parse(result.completedAt || result.updatedAt || project.updatedAt || new Date().toISOString()), downloadUrl: outputUrl }] : [],
      data: { ...result.data, imageCandidates, imageReview: { slots }, simpleImageSlotBindings: editorBindings, generationIssues: result.unresolvedItems || [], requiredImageGate: { unresolvedSlotIds: unresolvedRequired.filter((item) => item.kind === "image").map((item) => item.id), passed: unresolvedRequired.filter((item) => item.kind === "image").length === 0 } },
    },
    executionRunId: run.executionRunId,
    manualRevision: result.manualImageCompletion?.revision || null,
    manualVersion: result.manualImageCompletion?.version || 0,
    renderPending: result.renderStatus === "pending_manual_render",
    pipelineStatus: result.pipelineStatus,
    outputPath: result.outputPath || null,
    outputUrl,
    unresolvedRequiredCount: unresolvedRequired.length,
    unresolvedRequiredSlotIds: unresolvedRequired.map((item) => item.id),
    unresolvedCopyCount: (result.unresolvedItems || []).filter((item) => item.kind === "copy").length,
    unresolvedImageCount: (result.unresolvedItems || []).filter((item) => item.kind === "image").length,
    unresolvedNotices: notices,
    blockingItems: blockers,
    draftRendered,
    canEnterEditor: true,
    canEnterFinal,
    imageReview: { slots },
    metrics: {
      plannerModelCalls: 0,
      copyModelCalls: 0,
      automaticImageFollowupRounds: 0,
    },
  };
}

function selectedCandidate(imageResult, candidateId) {
  return candidatePool(imageResult).find((item) => item.candidateId === candidateId) || null;
}

async function persistResult({ store, root, project, run, plan, result, imageExecution, action, render = runSimpleRenderer, deferRender = false }) {
  const affected = new Set([...(action.slotIds || []), action.slotId, ...(action.humanDecision?.movedFrom || [])].filter(Boolean));
  const explicitSearch = action.type === "explicit_single_slot_search" || action.type === "explicit_multi_slot_search";
  if (action.type === "explicit_single_slot_search" && result.imageExecution?.results?.find(item => item.slotId === action.slotId)?.selected) affected.clear();
  const writeback = applySimpleSkillResults({
    preparedData: result.data || plan.preparedData,
    copyTasks: [],
    copyExecution: result.copyExecution,
    imageSlots: plan.imageSlots.filter(slot => affected.has(slot.slotId)).map(slot => ({ ...slot, userLocked: false })),
    slotBindings: plan.slotBindings,
    imageExecution,
  });
  writeback.copyWriteback = result.writeback?.copy || [];
  writeback.unresolvedItems.push(...(result.unresolvedItems || []).filter(item => item.kind !== "renderer" && !(item.kind === "image" && affected.has(item.id))));
  writeback.data.simpleImageSlotBindings ||= plan.slotBindings;
  for (const slotId of affected) {
    if (action.type === "editor_day_update") continue;
    const selected = imageExecution.results.find(item => item.slotId === slotId)?.selected;
    const binding = plan.slotBindings[slotId];
    if (selected && binding) {
      const image = getSlotImage(writeback.data, binding);
      if (image) setSlotImage(writeback.data, binding, { ...image, userProvided: Boolean(selected.userProvided), userSelected: Boolean(selected.userSelected) });
    }
    if (!explicitSearch) writeback.data.imageLocks = { ...writeback.data.imageLocks, [slotId]: { source: slotId !== action.slotId ? "user_moved_out" : action.type === "upload_real_image" ? "user_upload" : "user_selection", candidateId: selected?.candidateId || null, lockedAt: Date.now() } };
  }
  writeback.requiredUnresolved = writeback.unresolvedItems.filter(item => item.required);
  const revision = randomUUID();
  const pending = { ...result, data: writeback.data, imageExecution, unresolvedItems: writeback.unresolvedItems, outputPath: null, pipelineStatus: "partial", renderStatus: "pending_manual_render", manualImageCompletion: { ...result.manualImageCompletion, revision, version: Number(result.manualImageCompletion?.version || 0) + 1, slotIds: manualSlotIds(result, plan), lastAction: action } };
  // Save the binding before export verification; stale output must not be downloadable.
  store.saveFinalResult(project.projectId, run.executionRunId, pending);
  store.updateProject(project.projectId, { status: "partial", progress: 90, currentStage: "图片已保存，正在检查成品", outputPath: null });
  const key = path.resolve(root, project.projectId);
  const finish = async () => {
  if (store.getFinalResult(project.projectId, run.executionRunId)?.manualImageCompletion?.revision !== revision) return;
  const safeRender = async (input) => {
    try { return await render(input); }
    catch (error) { return { status: "failed", error: { code: "manual_render_failed", message: error.message } }; }
  };
  const renderMode = writeback.requiredUnresolved.length ? "draft" : "final";
  let renderResult = await safeRender({ data: writeback.data, projectId: project.projectId, root, mode: renderMode });
  if (renderMode === "final" && renderResult.status !== "success") {
    const finalAttempt = renderResult;
    writeback.unresolvedItems.push({ kind: "renderer", id: "renderer:2000", status: finalAttempt.status || "failed", required: true, error: finalAttempt.error || { code: "renderer_failed", message: "正式成品版面检查未通过" } });
    renderResult = await safeRender({ data: writeback.data, projectId: project.projectId, root, mode: "draft" });
    renderResult = { ...renderResult, mode: "draft", rendererCalls: Number(finalAttempt.rendererCalls || 0) + Number(renderResult.rendererCalls || 0), finalAttempt };
  }
  renderResult.mode ||= renderMode;
  if (renderResult.status !== "success" && !writeback.unresolvedItems.some((item) => item.kind === "renderer")) {
    writeback.unresolvedItems.push({ kind: "renderer", id: "renderer:2000", status: renderResult.status || "failed", required: true, error: renderResult.error || { code: "renderer_failed", message: "2000px Renderer 未通过" } });
  }
  const unresolvedRequired = writeback.unresolvedItems.filter((item) => item.required);
  const complete = renderResult.status === "success" && unresolvedRequired.length === 0;
  const pipelineStatus = complete ? "complete" : "partial";
  const now = new Date().toISOString();
  const nextResult = {
    ...pending,
    pipelineStatus,
    imageExecution,
    writeback: { copy: writeback.copyWriteback, images: writeback.imageWriteback },
    unresolvedItems: writeback.unresolvedItems,
    renderStatus: renderResult.status,
    outputPath: renderResult.outputPath || null,
    data: writeback.data,
    render: renderResult,
    manualImageCompletion: {
      ...pending.manualImageCompletion,
      revision,
      slotIds: manualSlotIds(result, plan),
      lastAction: action,
      updatedAt: now,
      plannerModelCalls: 0,
      copyModelCalls: 0,
      automaticImageFollowupRounds: 0,
      rendererCalls: Number(result.manualImageCompletion?.rendererCalls || 0) + Number(renderResult.rendererCalls || 0),
    },
  };
  if (store.getFinalResult(project.projectId, run.executionRunId)?.manualImageCompletion?.revision !== revision) return;
  store.saveFinalResult(project.projectId, run.executionRunId, nextResult);
  store.saveEvidence(project.projectId, run.executionRunId, `manual-image-${Date.now()}`, { ...action, pipelineStatus, unresolvedRequired: unresolvedRequired.map((item) => item.id), rendererStatus: renderResult.status, savedAt: now });
  const nextRun = { ...run, status: pipelineStatus, progress: complete ? 100 : 90, executionEnabled: false, currentStage: complete ? "完成" : "可编辑草稿", updatedAt: now };
  store.updateExecutionRun(project.projectId, nextRun);
  store.updateProject(project.projectId, { status: pipelineStatus, currentStage: nextRun.currentStage, progress: nextRun.progress, outputPath: renderResult.outputPath || null });
  };
  const job = (manualRenders.get(key) || Promise.resolve()).catch(() => {}).then(finish);
  manualRenders.set(key, job);
  job.catch(error => console.error("Manual image verification failed:", error.message)).finally(() => { if (manualRenders.get(key) === job) manualRenders.delete(key); });
  if (!deferRender) await job;
  return buildSimpleManualImagePayload(store, project.projectId);
}

const HARD_REJECTION_CODES = new Set([
  "wrong_hotel", "wrong_location", "wrong_activity", "wrong_transport_type", "wrong_subject",
  "watermark", "ai_generated", "subject_not_clear", "subject_too_small", "subject_not_primary",
  "low_quality_unusable", "non_photographic", "broken", "forbid",
  "hotel_identity_mismatch", "place_mismatch", "activity_mismatch", "subject_mismatch",
  "technical_unusable", "low_resolution", "low_quality",
]);

function isHardRejectedCandidate(candidate = {}) {
  return candidate.autoRejected === true || HARD_REJECTION_CODES.has(String(candidate.rejection || candidate.hardJudgment?.hardRejectCode || ""));
}

export async function chooseSimpleImageCandidate({ store, root, projectId, slotId, candidateId, manualConfirmed = false, render, deferRender = false } = {}) {
  let context = projectContext(store, projectId);
  assertPlannedImageSlot(context, slotId);
  let imageResults = context.result.imageExecution?.results || [];
  let current = imageResults.find((item) => item.slotId === slotId);
  if (!current) throw Object.assign(new Error("该图片位没有已保存结果"), { code: "slot_result_missing" });
  const source = imageResults.find((item) => selectedCandidate(item, candidateId));
  const candidate = source && selectedCandidate(source, candidateId);
  if (!candidate) throw Object.assign(new Error("当前项目中找不到该候选"), { code: "candidate_not_found" });
  if (isHardRejectedCandidate(candidate)) throw Object.assign(new Error("该候选命中硬拒绝条件，不能采用"), { code: "candidate_hard_rejected" });
  const overridesAutomaticJudgment = source.slotId !== slotId || !candidateCanBeSelected(context.result, current, candidate);
  if (overridesAutomaticJudgment && !manualConfirmed) throw Object.assign(new Error("未确认图片风险，不能采用"), { code: "manual_confirmation_required" });
  try {
    if (!candidate.localUrl?.startsWith('/image-assets/')) throw new Error('missing local asset');
    const assets = await realpath(path.join(root, 'output', 'image-assets'));
    const file = await realpath(path.resolve(assets, decodeURIComponent(candidate.localUrl.slice('/image-assets/'.length))));
    const relative = path.relative(assets, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside assets');
    const info = await stat(file);
    if (!info.isFile() || !info.size || info.size > 14 * 1024 * 1024) throw new Error('invalid size');
    const options = { failOn: 'warning', limitInputPixels: 40000000 };
    const metadata = await sharp(file, options).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('invalid format');
    await sharp(file, options).raw().toBuffer();
  } catch {
    throw Object.assign(new Error('图片文件缺失、损坏或无法安全解码，请重新上传'), { code: 'candidate_file_unusable' });
  }
  context = projectContext(store, projectId);
  imageResults = context.result.imageExecution?.results || [];
  current = imageResults.find(item => item.slotId === slotId);
  const movedFrom = imageResults.filter((item) => item.slotId !== slotId && item.selected?.localUrl === candidate.localUrl).map((item) => item.slotId);
  const humanDecision = { action: movedFrom.length ? 'move' : 'adopt', decidedAt: new Date().toISOString(), targetSlotId: slotId, sourceSlotId: source.slotId, movedFrom, riskConfirmed: manualConfirmed, overridesAutomaticJudgment, originalRejection: candidate.rejection || null, originalRisk: candidate.rejectionReason || candidate.matchReason || candidate.reason || '' };
  const nextCurrent = {
    ...current,
    status: "success",
    matchLevel: "user_selected_candidate",
    selected: { ...candidate, localUrl: candidate.localUrl, userSelected: true, humanDecision, selectedAt: new Date().toISOString() },
    actualSubject: candidate.actualSubject || current.actualSubject,
    matchReason: "用户从已保存候选中明确采用",
    technicalStatus: "user_selected_existing_candidate",
    manualAction: { ...(current.manualAction || {}), resolvedBy: "choose_existing_candidate", selectedCandidateId: candidateId, resolvedAt: new Date().toISOString() },
  };
  const nextResults = imageResults.map((item) => item.slotId === slotId ? nextCurrent : movedFrom.includes(item.slotId) ? { ...item, status: 'needs_user_action', selected: null, candidates: candidatePool(item), matchReason: '图片已由用户移动至其他位置', manualAction: { ...item.manualAction, movedTo: slotId, humanDecision } } : item);
  const imageExecution = { ...context.result.imageExecution, results: nextResults, metrics: { ...(context.result.imageExecution?.metrics || {}), automaticFollowupRounds: 0 } };
  for (const item of nextResults.filter((item) => movedFrom.includes(item.slotId))) store.saveTaskResult(projectId, context.run.executionRunId, `image-${item.slotId.replace(/[^a-zA-Z0-9_-]/g, '-')}`, item);
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, store, root, imageExecution, render, deferRender, action: { type: "choose_existing_candidate", slotId, candidateId, humanDecision } });
}

export async function rejectSimpleImageCandidate({ store, root, projectId, slotId, candidateId, render } = {}) {
  const context = projectContext(store, projectId);
  const imageResults = context.result.imageExecution?.results || [];
  const current = imageResults.find((item) => item.slotId === slotId);
  const allowed = current ? selectableIds(context.result, current) : new Set();
  if (!allowed.has(candidateId)) throw Object.assign(new Error("该候选不可执行人工拒绝"), { code: "candidate_not_selectable" });
  const manualAction = current.manualAction || {};
  const selectableCandidates = (manualAction.selectableCandidates || []).filter((item) => item.candidateId !== candidateId);
  const rejected = selectedCandidate(current, candidateId);
  const nextCurrent = { ...current, manualAction: { ...manualAction, selectableCandidates, rejectedCandidates: uniqueCandidates([...(manualAction.rejectedCandidates || []), rejected ? { ...rejected, userDecision: "rejected", userDecidedAt: new Date().toISOString() } : null].filter(Boolean)) } };
  const imageExecution = { ...context.result.imageExecution, results: imageResults.map((item) => item.slotId === slotId ? nextCurrent : item), metrics: { ...(context.result.imageExecution?.metrics || {}), automaticFollowupRounds: 0 } };
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, store, root, imageExecution, render, action: { type: "reject_existing_candidate", slotId, candidateId } });
}

export async function saveSimpleDayEditor({ store, root, projectId, dayIndex, day, bindings = {}, included, excluded, pendingConfirmations, render, deferRender = false } = {}) {
  const context = projectContext(store, projectId);
  const index = Number(dayIndex);
  if (!Number.isInteger(index) || index < 0 || !context.result.data?.days?.[index]) throw Object.assign(new Error("目标日期不存在"), { code: "day_not_found" });
  if (!Array.isArray(day?.spots) || day.spots.length > 30) throw Object.assign(new Error("体验卡片数据无效"), { code: "day_spots_invalid" });

  const currentData = context.result.data;
  const currentDay = currentData.days[index];
  const currentSpots = new Map((currentDay.spots || []).map((spot) => [String(spot.id || ""), spot]));
  const seen = new Set();
  const spots = day.spots.map((spot) => {
    const id = String(spot?.id || "").trim();
    if (!id || seen.has(id)) throw Object.assign(new Error("体验卡片缺少稳定 ID 或存在重复 ID"), { code: "spot_id_invalid" });
    seen.add(id);
    const previous = currentSpots.get(id);
    if (!previous && spot.userProvided !== true) throw Object.assign(new Error("新增体验卡片必须标记为人工创建"), { code: "manual_spot_invalid" });
    const text = (value, max) => String(value || "").slice(0, max);
    return {
      ...(previous || {}),
      ...spot,
      id,
      name: text(spot.name, 120) || "新体验卡片",
      description: text(spot.description || spot.experience, 2000),
      reminder: text(spot.reminder, 800),
      images: Array.isArray(previous?.images) ? previous.images : [],
      sourceEvidence: previous?.sourceEvidence || spot.sourceEvidence || [],
      userProvided: previous?.userProvided === true || spot.userProvided === true,
    };
  });

  const allCurrentBindings = currentData.simpleImageSlotBindings || context.plan.slotBindings || {};
  const currentDayBindings = Object.fromEntries(Object.entries(allCurrentBindings).filter(([, binding]) => binding.module === "day" && binding.dayIndex === index));
  for (const [slotId, binding] of Object.entries(currentDayBindings)) {
    if (binding.manualEditorCard !== true && !bindings[slotId]) throw Object.assign(new Error("Planner 图片位不能从编辑器中删除"), { code: "planned_slot_missing" });
  }

  const nextDayBindings = {};
  for (const [slotId, incoming] of Object.entries(bindings || {})) {
    const previous = currentDayBindings[slotId];
    const isManual = previous?.manualEditorCard === true || incoming?.manualEditorCard === true;
    if (!previous && (!isManual || !slotId.startsWith(`manual:day:${index + 1}:`))) throw Object.assign(new Error("只能新增人工体验卡片图片位"), { code: "manual_slot_invalid" });
    if (incoming?.module !== "day" || Number(incoming.dayIndex) !== index) throw Object.assign(new Error("图片位与当前日期不一致"), { code: "slot_day_mismatch" });
    const useSpotCopy = incoming.useSpotCopy !== false;
    const stableSpotId = String(incoming.spotId || previous?.spotId || "");
    const stableSpotIndex = stableSpotId ? spots.findIndex((spot) => spot.id === stableSpotId) : -1;
    const spotIndex = useSpotCopy && stableSpotIndex >= 0 ? stableSpotIndex : Number(incoming.spotIndex ?? previous?.spotIndex);
    if (spotIndex < 0 || !spots[spotIndex]) throw Object.assign(new Error("图片位找不到对应体验卡片"), { code: "slot_spot_missing" });
    const imageIndex = isManual ? 0 : Number.isInteger(Number(previous?.imageIndex)) ? Number(previous.imageIndex) : Number(incoming.imageIndex || 0);
    nextDayBindings[slotId] = {
      ...(previous || {}),
      ...incoming,
      module: "day",
      dayIndex: index,
      itemIndex: index,
      spotId: useSpotCopy ? spots[spotIndex].id : undefined,
      spotIndex,
      imageIndex,
      fieldPath: `days.${index}.spots.${spotIndex}.images.${imageIndex}`,
      useSpotCopy,
      required: isManual ? false : previous?.required !== false,
      manualEditorCard: isManual,
      editorImageRequired: isManual ? false : incoming.editorImageRequired,
    };
  }

  const nextData = structuredClone(currentData);
  nextData.days[index] = { ...currentDay, ...day, spots };
  nextData.simpleImageSlotBindings = {
    ...Object.fromEntries(Object.entries(allCurrentBindings).filter(([, binding]) => !(binding.module === "day" && binding.dayIndex === index))),
    ...nextDayBindings,
  };
  if (Array.isArray(included)) nextData.included = included;
  if (Array.isArray(excluded)) nextData.excluded = excluded;
  if (Array.isArray(pendingConfirmations)) nextData.pendingConfirmations = pendingConfirmations;

  const liveManualSlotIds = new Set(Object.entries(nextData.simpleImageSlotBindings).filter(([, binding]) => binding.manualEditorCard === true).map(([slotId]) => slotId));
  const currentResults = context.result.imageExecution?.results || [];
  const imageResults = currentResults.filter((item) => !allCurrentBindings[item.slotId]?.manualEditorCard || liveManualSlotIds.has(item.slotId));
  for (const slotId of liveManualSlotIds) {
    if (!imageResults.some((item) => item.slotId === slotId)) imageResults.push({ slotId, status: "needs_user_action", selected: null, candidates: [], technicalStatus: "manual_card_waiting_upload", manualAction: { userRequiredActions: ["upload_real_image"] } });
  }
  const imageExecution = { ...context.result.imageExecution, results: imageResults };
  return persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution, render, deferRender, action: { type: "editor_day_update", slotId: `editor:day:${index + 1}`, dayIndex: index } });
}

export async function uploadSimpleImage({ store, root, projectId, slotId, dataUrl, fileName, render, deferRender = false } = {}) {
  let context = projectContext(store, projectId);
  editableImageBinding(context, slotId);
  const match = String(dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw Object.assign(new Error("仅支持 JPEG、PNG 或 WebP 图片"), { code: "upload_format_invalid" });
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 14 * 1024 * 1024) throw Object.assign(new Error("图片文件为空或超过 14MB"), { code: "upload_size_invalid" });
  const metadata = await sharp(buffer, { failOn: "warning" }).metadata();
  const contentType = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : metadata.format === "webp" ? "image/webp" : "";
  if (!MIME_EXTENSIONS[contentType]) throw Object.assign(new Error("图片无法解码或格式不受支持"), { code: "upload_decode_failed" });
  if ((metadata.width || 0) < 900 || (metadata.height || 0) < 500) throw Object.assign(new Error("图片分辨率不足，至少需要 900×500"), { code: "upload_resolution_low" });
  const ratio = metadata.width / metadata.height;
  if (ratio < 0.65 || ratio > 3.2) throw Object.assign(new Error("图片比例不适合行程主图"), { code: "upload_ratio_invalid" });
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const assetDirName = `simple-manual-${projectId}`;
  const assetDir = path.join(root, "output", "image-assets", assetDirName);
  const assetName = `${sha256.slice(0, 20)}${MIME_EXTENSIONS[contentType]}`;
  await mkdir(assetDir, { recursive: true });
  await writeFile(path.join(assetDir, assetName), buffer, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  context = projectContext(store, projectId);
  const editable = editableImageBinding(context, slotId);
  const candidate = {
    candidateId: `user-${sha256.slice(0, 20)}`,
    localUrl: `/image-assets/${assetDirName}/${assetName}`,
    sourceTitle: fileName || "用户上传图片",
    actualSubject: `用户上传：${fileName || "已授权真实图片"}`,
    width: metadata.width,
    height: metadata.height,
    sha256,
    userProvided: true,
    uploadedAt: new Date().toISOString(),
  };
  const imageResults = context.result.imageExecution?.results || [];
  const current = imageResults.find((item) => item.slotId === slotId) || (editable.manualEditorCard ? { slotId, status: "needs_user_action", selected: null, candidates: [], manualAction: { userRequiredActions: ["upload_real_image"] } } : null);
  if (!current) throw Object.assign(new Error("该图片位没有已保存结果"), { code: "slot_result_missing" });
  const nextCurrent = {
    ...current,
    status: "success",
    matchLevel: "user_uploaded",
    selected: candidate,
    actualSubject: candidate.actualSubject,
    matchReason: "用户主动上传并确认用于当前图片位",
    technicalStatus: "user_uploaded_valid_image",
    manualAction: { ...(current.manualAction || {}), resolvedBy: "upload_real_image", selectedCandidateId: candidate.candidateId, resolvedAt: new Date().toISOString() },
  };
  const nextData = structuredClone(context.result.data);
  setSlotImage(nextData, editable.binding, { src: candidate.localUrl, focus: "50% 50%", userProvided: true, sourceTitle: candidate.sourceTitle, sha256 });
  if (nextData.simpleImageSlotBindings?.[slotId]) nextData.simpleImageSlotBindings[slotId].editorImageStatus = "已上传";
  const imageExecution = { ...context.result.imageExecution, results: imageResults.some((item) => item.slotId === slotId) ? imageResults.map((item) => item.slotId === slotId ? nextCurrent : item) : [...imageResults, nextCurrent], metrics: { ...(context.result.imageExecution?.metrics || {}), automaticFollowupRounds: 0 } };
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution, render, deferRender, action: { type: "upload_real_image", slotId, candidateId: candidate.candidateId, fileName: fileName || null } });
}

export async function researchSimpleImageSlot({ store, root, projectId, slotId, runImage, imageOptions = {}, render, deferRender = false } = {}) {
  let context = projectContext(store, projectId);
  const slot = assertPlannedImageSlot(context, slotId);
  if (typeof runImage !== "function") throw new Error("单槽图片搜索能力未配置");
  let previousResults = context.result.imageExecution?.results || [];
  const existingImages = previousResults.filter((item) => item.slotId !== slotId && item.status === "success" && item.selected).map((item) => ({ ...item.selected, src: item.selected.localUrl, slotId: item.slotId }));
  const searched = await runImage({ root, slots: [slot], existingImages, ...imageOptions });
  context = projectContext(store, projectId);
  previousResults = context.result.imageExecution?.results || [];
  if (searched.status === "failed" || searched.results?.some(item => item.slotId === slotId && item.status === "failed")) throw new Error("搜索失败，请重试");
  const returned = searched.results?.find((item) => item.slotId === slotId) || { slotId, status: "not_found", selected: null, candidates: [], technicalStatus: "missing_skill_result", warnings: ["单槽搜索未返回结果"] };
  const previous = previousResults.find((item) => item.slotId === slotId) || {};
  const priorCandidates = candidatePool(previous);
  const mergedCandidates = uniqueCandidates([...priorCandidates, ...candidatePool(returned)]);
  const preserveExistingSelection = previous.status === "success" && previous.selected;
  const nextCurrent = returned.status === "success" && !preserveExistingSelection ? {
    ...previous,
    ...returned,
    requestKind: "user_requested_single_slot_search",
    candidates: mergedCandidates,
    manualAction: { ...(previous.manualAction || {}), lastExplicitSearchAt: new Date().toISOString() },
  } : preserveExistingSelection ? {
    ...previous,
    candidates: mergedCandidates,
    requestKind: "user_requested_single_slot_search",
    manualAction: {
      ...(previous.manualAction || {}),
      currentSearchFallbackResult: { previousStatus: returned.status, technicalStatus: returned.technicalStatus, matchReason: returned.matchReason, queriesUsed: returned.queriesUsed, sourceEvidence: returned.sourceEvidence, pipelineEvidence: returned.pipelineEvidence },
      selectableCandidates: uniqueCandidates([...(previous.manualAction?.selectableCandidates || []), ...(returned.status === "success" && returned.selected ? [returned.selected] : [])]),
      lastExplicitSearchAt: new Date().toISOString(),
      preservedExistingSelection: true,
    },
  } : {
    ...previous,
    ...returned,
    status: "needs_user_action",
    requestKind: "user_requested_single_slot_search",
    candidates: mergedCandidates,
    manualAction: {
      ...(previous.manualAction || {}),
      currentSearchFallbackResult: { previousStatus: returned.status, technicalStatus: returned.technicalStatus, matchReason: returned.matchReason, queriesUsed: returned.queriesUsed, sourceEvidence: returned.sourceEvidence, pipelineEvidence: returned.pipelineEvidence },
      rejectedCandidates: uniqueCandidates([...(previous.manualAction?.rejectedCandidates || []), ...mergedCandidates]),
      lastExplicitSearchAt: new Date().toISOString(),
    },
  };
  const imageExecution = {
    ...context.result.imageExecution,
    results: previousResults.map((item) => item.slotId === slotId ? nextCurrent : item),
    metrics: {
      ...(context.result.imageExecution?.metrics || {}),
      explicitUserSingleSlotSearches: Number(context.result.imageExecution?.metrics?.explicitUserSingleSlotSearches || 0) + 1,
      automaticFollowupRounds: 0,
    },
  };
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  const payload = await persistResult({ ...context, store, root, imageExecution, render, deferRender, action: { type: "explicit_single_slot_search", slotId, requestId: randomUUID() } });
  payload.newCandidateCount = mergedCandidates.filter(item => (item.localUrl || item.publicUrl) && !priorCandidates.some(old => old.candidateId === item.candidateId || (old.localUrl || old.publicUrl) === (item.localUrl || item.publicUrl))).length;
  return payload;
}

export async function researchSimpleImageSlots({ store, root, projectId, slotIds, runImage, imageOptions = {}, render, deferRender = false } = {}) {
  let context = projectContext(store, projectId);
  if (typeof runImage !== "function") throw new Error("批量图片搜索能力未配置");
  const unresolvedIds = new Set((context.result.unresolvedItems || []).filter((item) => item.kind === "image" && item.required !== false).map((item) => item.id));
  const requestedIds = [...new Set((slotIds?.length ? slotIds : [...unresolvedIds]).map(String))].filter((slotId) => unresolvedIds.has(slotId));
  const previousById = new Map((context.result.imageExecution?.results || []).map((item) => [item.slotId, item]));
  const retryIds = requestedIds.filter((slotId) => !(previousById.get(slotId)?.status === "success" && previousById.get(slotId)?.selected));
  if (!retryIds.length) throw Object.assign(new Error("当前没有需要重新搜索的缺图位置"), { code: "image_slots_not_unresolved" });
  const slots = retryIds.map((slotId) => assertPlannedImageSlot(context, slotId));
  const existingImages = (context.result.imageExecution?.results || []).filter((item) => !retryIds.includes(item.slotId) && item.status === "success" && item.selected).map((item) => ({ ...item.selected, src: item.selected.localUrl, slotId: item.slotId }));
  const searched = await runImage({ root, slots, existingImages, ...imageOptions });

  context = projectContext(store, projectId);
  const previousResults = context.result.imageExecution?.results || [];
  const returnedById = new Map((searched.results || []).map((item) => [item.slotId, item]));
  const nextById = new Map(previousResults.map((item) => [item.slotId, item]));
  const now = new Date().toISOString();
  for (const slotId of retryIds) {
    const previous = nextById.get(slotId) || {};
    const returned = returnedById.get(slotId) || { slotId, status: "not_found", selected: null, candidates: [], technicalStatus: "missing_skill_result", warnings: ["批量搜索未返回结果"] };
    const priorCandidates = candidatePool(previous);
    const mergedCandidates = uniqueCandidates([...priorCandidates, ...candidatePool(returned)]);
    const preserveExistingSelection = previous.status === "success" && previous.selected;
    const nextCurrent = returned.status === "success" && returned.selected && !preserveExistingSelection ? {
      ...previous,
      ...returned,
      requestKind: "user_requested_multi_slot_search",
      candidates: mergedCandidates,
      manualAction: { ...(previous.manualAction || {}), lastExplicitSearchAt: now },
    } : preserveExistingSelection ? {
      ...previous,
      candidates: mergedCandidates,
      requestKind: "user_requested_multi_slot_search",
      manualAction: { ...(previous.manualAction || {}), lastExplicitSearchAt: now, preservedExistingSelection: true },
    } : {
      ...previous,
      ...returned,
      status: "needs_user_action",
      selected: null,
      requestKind: "user_requested_multi_slot_search",
      candidates: mergedCandidates,
      manualAction: {
        ...(previous.manualAction || {}),
        currentSearchFallbackResult: { previousStatus: returned.status, technicalStatus: returned.technicalStatus, matchReason: returned.matchReason, queriesUsed: returned.queriesUsed, sourceEvidence: returned.sourceEvidence, pipelineEvidence: returned.pipelineEvidence },
        rejectedCandidates: uniqueCandidates([...(previous.manualAction?.rejectedCandidates || []), ...mergedCandidates]),
        lastExplicitSearchAt: now,
      },
    };
    nextById.set(slotId, nextCurrent);
    store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  }
  const nextResults = [...previousResults.map((item) => nextById.get(item.slotId) || item), ...retryIds.filter((slotId) => !previousResults.some((item) => item.slotId === slotId)).map((slotId) => nextById.get(slotId))];
  const imageExecution = {
    ...context.result.imageExecution,
    status: searched.status === "success" && retryIds.every((slotId) => nextById.get(slotId)?.status === "success") ? "success" : "needs_user_action",
    results: nextResults,
    metrics: {
      ...(context.result.imageExecution?.metrics || {}),
      explicitUserMultiSlotSearches: Number(context.result.imageExecution?.metrics?.explicitUserMultiSlotSearches || 0) + 1,
      automaticFollowupRounds: 0,
    },
  };
  const payload = await persistResult({ ...context, store, root, imageExecution, render, deferRender, action: { type: "explicit_multi_slot_search", slotIds: retryIds, requestId: randomUUID() } });
  const successfulSlotIds = retryIds.filter((slotId) => nextById.get(slotId)?.status === "success" && nextById.get(slotId)?.selected);
  payload.repair = { kind: "image_batch", status: successfulSlotIds.length === retryIds.length ? "success" : successfulSlotIds.length ? "partial_success" : "failed", slotIds: retryIds, successfulSlotIds, failedSlotIds: retryIds.filter((slotId) => !successfulSlotIds.includes(slotId)) };
  return payload;
}
