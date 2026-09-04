import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { applySimpleSkillResults } from "./simple-pipeline-writeback.mjs";
import { runSimpleRenderer } from "./simple-renderer.mjs";

const MIME_EXTENSIONS = Object.freeze({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" });
const SLOT_LABELS = Object.freeze({
  "image:cover:primary": "封面主图 · 坦桑尼亚草原飞机",
  "image:hotel:imported-hotel-2:primary": "酒店主图 · Singita Sabora Tented Camp",
  "image:day:2:primary": "DAY 2 主图 · 塞伦盖蒂西部游猎",
  "image:day:3:primary": "DAY 3 主图 · 徒步 / 夜间游猎",
  "image:day:6:primary": "DAY 6 主图 · 反偷猎 / ranger patrol",
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

function manualSlotIds(result) {
  const saved = result.manualImageCompletion?.slotIds;
  if (Array.isArray(saved) && saved.length) return saved;
  return (result.unresolvedItems || []).filter((item) => item.kind === "image" && item.required && item.status === "needs_user_action").map((item) => item.id);
}

function moduleName(slotId) {
  if (slotId.includes(":cover:")) return "封面";
  if (slotId.includes(":hotel:")) return "臻选下榻";
  const match = slotId.match(/:day:(\d+):/);
  return match ? `DAY ${match[1]}` : "每日行程";
}

function candidatePool(imageResult = {}) {
  return uniqueCandidates([
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
  return {
    ...candidate,
    slotId,
    pipelineSlotId: slotId,
    fieldPath: binding?.fieldPath || "",
    localPreviewUrl: candidate.localUrl || candidate.publicUrl || "",
    status: canSelect ? "manual_review" : "hard_rejected",
    adoptable: canSelect,
    libraryEligible: canSelect,
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
  if (selectableIds(result, imageResult).has(candidate.candidateId)) return true;
  if (candidate.candidateId === imageResult.selected?.candidateId) return true;
  const hard = candidate.hardJudgment;
  return !candidate.rejection && hard?.eligible === true && hard.locationMatch !== false && hard.hotelIdentityMatch !== false && hard.activityMatch !== false && hard.subjectMatch !== false && hard.watermarkFree !== false && hard.nonAI !== false && hard.photographic !== false && hard.technicalUsable !== false;
}

function assertPlannedImageSlot(context, slotId) {
  const slot = context.plan.imageSlots.find((item) => item.slotId === slotId);
  if (!slot) throw Object.assign(new Error("该图片位不在当前计划中"), { code: "slot_not_in_plan" });
  return slot;
}

export function buildSimpleManualImagePayload(store, projectId) {
  const { project, run, plan, result } = projectContext(store, projectId);
  const resultById = new Map((result.imageExecution?.results || []).map((item) => [item.slotId, item]));
  const slots = manualSlotIds(result).map((slotId) => {
    const imageResult = resultById.get(slotId) || { slotId, status: "needs_user_action", candidates: [] };
    const selectables = selectableIds(result, imageResult);
    const binding = plan.slotBindings?.[slotId];
    const candidates = candidatePool(imageResult).map((candidate) => frontendCandidate(candidate, slotId, binding, selectables.has(candidate.candidateId)));
    const planned = plan.imageSlots.find((item) => item.slotId === slotId);
    return {
      slotId,
      module: moduleName(slotId),
      label: SLOT_LABELS[slotId] || slotId,
      status: imageResult.status === "success" ? (imageResult.selected?.userProvided ? "uploaded" : imageResult.selected?.userSelected ? "human_selected" : "auto_selected") : "manual_review",
      required: true,
      originalVisualTarget: imageResult.manualAction?.originalVisualTarget || (planned ? { location: planned.location, hotel: planned.hotel, activity: planned.activity, subject: planned.subject, visualGoal: planned.visualGoal } : null),
      currentResult: imageResult.manualAction?.currentSearchFallbackResult || { technicalStatus: imageResult.technicalStatus, matchReason: imageResult.matchReason },
      candidateCount: candidates.length,
      selectableCandidateIds: [...selectables],
      userRequiredActions: imageResult.manualAction?.userRequiredActions || ["upload_real_image", "explicit_single_slot_search"],
      candidates,
    };
  });
  const imageCandidates = uniqueCandidates((result.imageExecution?.results || []).flatMap((imageResult) => {
    const binding = plan.slotBindings?.[imageResult.slotId];
    return candidatePool(imageResult).map((candidate) => frontendCandidate(candidate, imageResult.slotId, binding, candidateCanBeSelected(result, imageResult, candidate)));
  }));
  const unresolvedRequired = (result.unresolvedItems || []).filter((item) => item.required);
  const canEnterFinal = unresolvedRequired.length === 0 && Boolean(result.outputPath);
  const outputUrl = result.outputPath ? `/api/simple/projects/${projectId}/output` : null;
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
      data: { ...result.data, imageCandidates, imageReview: { slots }, simpleImageSlotBindings: plan.slotBindings || {}, requiredImageGate: { unresolvedSlotIds: unresolvedRequired.filter((item) => item.kind === "image").map((item) => item.id), passed: unresolvedRequired.length === 0 } },
    },
    executionRunId: run.executionRunId,
    pipelineStatus: result.pipelineStatus,
    outputPath: result.outputPath || null,
    outputUrl,
    unresolvedRequiredCount: unresolvedRequired.length,
    unresolvedRequiredSlotIds: unresolvedRequired.map((item) => item.id),
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

async function persistResult({ store, root, project, run, plan, result, imageExecution, action, render = runSimpleRenderer }) {
  const writeback = applySimpleSkillResults({
    preparedData: plan.preparedData,
    copyTasks: plan.copyTasks,
    copyExecution: result.copyExecution,
    imageSlots: plan.imageSlots,
    slotBindings: plan.slotBindings,
    imageExecution,
  });
  let renderResult = { status: "blocked_by_required_items", outputPath: null, rendererCalls: 0, durationMs: 0 };
  if (!writeback.requiredUnresolved.length) renderResult = await render({ data: writeback.data, projectId: project.projectId, root });
  if (!writeback.requiredUnresolved.length && renderResult.status !== "success") {
    writeback.unresolvedItems.push({ kind: "renderer", id: "renderer:2000", status: renderResult.status || "failed", required: true, error: renderResult.error || { code: "renderer_failed", message: "2000px Renderer 未通过" } });
  }
  const unresolvedRequired = writeback.unresolvedItems.filter((item) => item.required);
  const complete = renderResult.status === "success" && unresolvedRequired.length === 0;
  const pipelineStatus = complete ? "complete" : "partial";
  const now = new Date().toISOString();
  const nextResult = {
    ...result,
    pipelineStatus,
    imageExecution,
    writeback: { copy: writeback.copyWriteback, images: writeback.imageWriteback },
    unresolvedItems: writeback.unresolvedItems,
    renderStatus: renderResult.status,
    outputPath: renderResult.outputPath || null,
    data: writeback.data,
    render: renderResult,
    manualImageCompletion: {
      ...(result.manualImageCompletion || {}),
      slotIds: manualSlotIds(result),
      lastAction: action,
      updatedAt: now,
      plannerModelCalls: 0,
      copyModelCalls: 0,
      automaticImageFollowupRounds: 0,
      rendererCalls: Number(result.manualImageCompletion?.rendererCalls || 0) + Number(renderResult.rendererCalls || 0),
    },
  };
  store.saveFinalResult(project.projectId, run.executionRunId, nextResult);
  store.saveEvidence(project.projectId, run.executionRunId, `manual-image-${Date.now()}`, { ...action, pipelineStatus, unresolvedRequired: unresolvedRequired.map((item) => item.id), rendererStatus: renderResult.status, savedAt: now });
  const nextRun = { ...run, status: pipelineStatus, progress: complete ? 100 : 75, executionEnabled: false, currentStage: complete ? "完成" : "剩余图片人工补齐", updatedAt: now };
  store.updateExecutionRun(project.projectId, nextRun);
  store.updateProject(project.projectId, { status: pipelineStatus, currentStage: nextRun.currentStage, progress: nextRun.progress, outputPath: renderResult.outputPath || null });
  return buildSimpleManualImagePayload(store, project.projectId);
}

export async function chooseSimpleImageCandidate({ store, root, projectId, slotId, candidateId, render } = {}) {
  const context = projectContext(store, projectId);
  assertPlannedImageSlot(context, slotId);
  const imageResults = context.result.imageExecution?.results || [];
  const current = imageResults.find((item) => item.slotId === slotId);
  if (!current) throw Object.assign(new Error("该图片位没有已保存结果"), { code: "slot_result_missing" });
  const candidate = selectedCandidate(current, candidateId);
  if (!candidateCanBeSelected(context.result, current, candidate)) throw Object.assign(new Error("该候选存在硬拒绝或未列入人工可选范围，不能采用"), { code: "candidate_not_selectable" });
  if (!candidate?.localUrl) throw Object.assign(new Error("候选缺少已保存的本地图片"), { code: "candidate_file_missing" });
  const nextCurrent = {
    ...current,
    status: "success",
    matchLevel: "user_selected_candidate",
    selected: { ...candidate, localUrl: candidate.localUrl, userSelected: true, selectedAt: new Date().toISOString() },
    actualSubject: candidate.actualSubject || current.actualSubject,
    matchReason: "用户从已保存候选中明确采用",
    technicalStatus: "user_selected_existing_candidate",
    manualAction: { ...(current.manualAction || {}), resolvedBy: "choose_existing_candidate", selectedCandidateId: candidateId, resolvedAt: new Date().toISOString() },
  };
  const imageExecution = { ...context.result.imageExecution, results: imageResults.map((item) => item.slotId === slotId ? nextCurrent : item), metrics: { ...(context.result.imageExecution?.metrics || {}), automaticFollowupRounds: 0 } };
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, store, root, imageExecution, render, action: { type: "choose_existing_candidate", slotId, candidateId } });
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

export async function uploadSimpleImage({ store, root, projectId, slotId, dataUrl, fileName, render } = {}) {
  const context = projectContext(store, projectId);
  assertPlannedImageSlot(context, slotId);
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
  const current = imageResults.find((item) => item.slotId === slotId);
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
  const imageExecution = { ...context.result.imageExecution, results: imageResults.map((item) => item.slotId === slotId ? nextCurrent : item), metrics: { ...(context.result.imageExecution?.metrics || {}), automaticFollowupRounds: 0 } };
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, store, root, imageExecution, render, action: { type: "upload_real_image", slotId, candidateId: candidate.candidateId, fileName: fileName || null } });
}

export async function researchSimpleImageSlot({ store, root, projectId, slotId, runImage, imageOptions = {}, render } = {}) {
  const context = projectContext(store, projectId);
  const slot = assertPlannedImageSlot(context, slotId);
  if (typeof runImage !== "function") throw new Error("单槽图片搜索能力未配置");
  const previousResults = context.result.imageExecution?.results || [];
  const existingImages = previousResults.filter((item) => item.slotId !== slotId && item.status === "success" && item.selected).map((item) => ({ ...item.selected, src: item.selected.localUrl, slotId: item.slotId }));
  const searched = await runImage({ root, slots: [slot], existingImages, ...imageOptions });
  const returned = searched.results?.find((item) => item.slotId === slotId) || { slotId, status: "not_found", selected: null, candidates: [], technicalStatus: "missing_skill_result", warnings: ["单槽搜索未返回结果"] };
  const previous = previousResults.find((item) => item.slotId === slotId) || {};
  const priorCandidates = candidatePool(previous);
  const mergedCandidates = uniqueCandidates([...priorCandidates, ...(returned.candidates || [])]);
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
  return persistResult({ ...context, store, root, imageExecution, render, action: { type: "explicit_single_slot_search", slotId, requestId: randomUUID() } });
}
