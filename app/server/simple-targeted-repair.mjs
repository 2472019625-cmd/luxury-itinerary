import { randomUUID } from "node:crypto";
import { applySimpleSkillResults } from "./simple-pipeline-writeback.mjs";
import { runCopyWriterSkill } from "./simple-copy-skill.mjs";
import { runSimpleRenderer } from "./simple-renderer.mjs";
import { buildSimpleManualImagePayload } from "./simple-manual-images.mjs";

const activeRepairs = new Map();

function contextFor(store, projectId) {
  const project = store.getProject(projectId);
  const run = project?.activeExecutionRunId ? store.getExecutionRun(projectId, project.activeExecutionRunId) : null;
  const plan = project?.activePlanId ? store.getPlan(projectId, project.activePlanId) : null;
  const result = run ? store.getFinalResult(projectId, run.executionRunId) : null;
  if (!project || !run || !plan || !result) throw Object.assign(new Error("项目缺少当前计划或执行结果"), { code: "simple_project_incomplete" });
  if (project.flowKind !== "simple_skill_v1" || run.flowKind !== "simple_skill_v1") throw Object.assign(new Error("目标不是 Simple Pipeline 项目"), { code: "wrong_project_flow" });
  return { project, run, plan, result };
}

function repairVersion(result = {}) {
  return Number(result.manualImageCompletion?.version || 0);
}

function aggregateCopyStatus(results = []) {
  const statuses = new Set(results.map((item) => item.status));
  if (statuses.size === 1 && statuses.has("success")) return "success";
  if (statuses.has("success")) return "partial_success";
  if (statuses.has("needs_input") && !statuses.has("failed")) return "needs_input";
  return "failed";
}

function rendererIssue(renderResult = {}) {
  return {
    kind: "renderer",
    id: "renderer:2000",
    status: renderResult.status || "failed",
    required: true,
    error: renderResult.error || { code: "renderer_failed", message: "正式成品版面检查未通过" },
  };
}

async function safeRender(render, input) {
  try { return await render(input); }
  catch (error) { return { status: "failed", mode: input.mode, outputPath: null, rendererCalls: 1, error: { code: "renderer_failed", message: error.message || String(error) } }; }
}

function saveResultState({ store, project, run, result, renderResult, unresolvedItems, action, copyExecution = result.copyExecution }) {
  const required = unresolvedItems.filter((item) => item.required);
  const complete = renderResult.status === "success" && renderResult.mode === "final" && required.length === 0;
  const pipelineStatus = complete ? "complete" : "partial";
  const now = new Date().toISOString();
  const nextResult = {
    ...result,
    pipelineStatus,
    copyExecution,
    unresolvedItems,
    renderStatus: renderResult.status,
    render: renderResult,
    outputPath: renderResult.outputPath || null,
    updatedAt: now,
    manualImageCompletion: {
      ...(result.manualImageCompletion || {}),
      revision: randomUUID(),
      version: repairVersion(result) + 1,
      lastAction: action,
      updatedAt: now,
      copyModelCalls: Number(result.manualImageCompletion?.copyModelCalls || 0) + Number(action.copyModelCalls || 0),
      rendererCalls: Number(result.manualImageCompletion?.rendererCalls || 0) + Number(renderResult.rendererCalls || 0),
    },
  };
  store.saveFinalResult(project.projectId, run.executionRunId, nextResult);
  store.saveEvidence(project.projectId, run.executionRunId, `targeted-repair-${Date.now()}`, {
    type: action.type,
    targetId: action.targetId || null,
    targetPath: action.targetPath || null,
    status: complete ? "complete" : "partial",
    unresolvedRequired: required.map((item) => item.id),
    savedAt: now,
  });
  const nextRun = { ...run, status: pipelineStatus, progress: complete ? 100 : 90, executionEnabled: false, currentStage: complete ? "完成" : "可编辑草稿", updatedAt: now };
  store.updateExecutionRun(project.projectId, nextRun);
  store.updateProject(project.projectId, { status: pipelineStatus, progress: nextRun.progress, currentStage: nextRun.currentStage, outputPath: nextResult.outputPath });
  return nextResult;
}

async function renderAfterRepair({ store, root, project, run, result, unresolvedItems, action, render, copyExecution }) {
  const required = unresolvedItems.filter((item) => item.required);
  const mode = required.length ? "draft" : "final";
  let renderResult = await safeRender(render, { data: result.data, projectId: project.projectId, root, mode });
  const nextUnresolved = unresolvedItems.filter((item) => item.kind !== "renderer");
  if (mode === "final" && renderResult.status !== "success") {
    const failedFinal = renderResult;
    nextUnresolved.push(rendererIssue(failedFinal));
    renderResult = await safeRender(render, { data: result.data, projectId: project.projectId, root, mode: "draft" });
    renderResult = { ...renderResult, mode: "draft", finalAttempt: failedFinal, rendererCalls: Number(failedFinal.rendererCalls || 0) + Number(renderResult.rendererCalls || 0) };
  } else if (renderResult.status !== "success") {
    nextUnresolved.push(rendererIssue(renderResult));
  }
  return saveResultState({ store, project, run, result, renderResult, unresolvedItems: nextUnresolved, action, copyExecution });
}

async function exclusive(projectId, operation) {
  if (activeRepairs.has(projectId)) throw Object.assign(new Error("当前项目已有一项内容正在处理，请完成后再试"), { code: "repair_in_progress" });
  const promise = operation();
  activeRepairs.set(projectId, promise);
  try { return await promise; }
  finally { if (activeRepairs.get(projectId) === promise) activeRepairs.delete(projectId); }
}

async function retryCopyTargets({ store, root, projectId, targetIds, copyOptions = {}, runCopy = runCopyWriterSkill, render = runSimpleRenderer, single = false } = {}) {
  return exclusive(projectId, async () => {
    const initial = contextFor(store, projectId);
    const unresolvedCopy = (initial.result.unresolvedItems || []).filter((item) => item.kind === "copy" && item.required !== false);
    const requestedIds = [...new Set((targetIds?.length ? targetIds : unresolvedCopy.map((item) => item.id)).map(String))];
    const unresolvedIds = new Set(unresolvedCopy.map((item) => item.id));
    const retryIds = requestedIds.filter((id) => unresolvedIds.has(id));
    if (!retryIds.length) throw Object.assign(new Error(single ? "这项文案已经完成，无需重新生成" : "当前没有需要重新生成的失败文案"), { code: "copy_target_not_unresolved" });
    const taskById = new Map((initial.plan.copyTasks || []).map((item) => [item.targetId, item]));
    const tasks = retryIds.map((id) => taskById.get(id));
    if (tasks.some((task) => !task)) throw Object.assign(new Error("当前计划中找不到对应的文案任务"), { code: "copy_target_not_planned" });
    const expectedVersion = repairVersion(initial.result);
    const execution = await runCopy({ itineraryContext: initial.plan.itineraryContext, tasks, ...copyOptions });
    const current = contextFor(store, projectId);
    if (repairVersion(current.result) !== expectedVersion) throw Object.assign(new Error("处理期间项目内容已经更新，请重新发起处理"), { code: "repair_result_stale" });

    const writeback = applySimpleSkillResults({
      preparedData: current.result.data,
      copyTasks: tasks,
      copyExecution: execution,
      imageSlots: [],
      slotBindings: current.plan.slotBindings,
      imageExecution: { results: [] },
    });
    const previousCopyResults = current.result.copyExecution?.results || [];
    const returnedById = new Map((execution.results || []).map((item) => [item.targetId, item]));
    const returned = tasks.map((task) => returnedById.get(task.targetId) || { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "copy_result_missing", message: "本次未返回文案结果" } });
    const retryIdSet = new Set(retryIds);
    const copyResults = [...previousCopyResults.filter((item) => !retryIdSet.has(item.targetId)), ...returned];
    const copyExecution = {
      ...(current.result.copyExecution || {}),
      status: aggregateCopyStatus(copyResults),
      results: copyResults,
      metrics: {
        ...(current.result.copyExecution?.metrics || {}),
        modelCalls: Number(current.result.copyExecution?.metrics?.modelCalls || 0) + Number(execution.metrics?.modelCalls || 0),
        researchCalls: Number(current.result.copyExecution?.metrics?.researchCalls || 0) + Number(execution.metrics?.researchCalls || 0),
      },
    };
    const unresolvedItems = [
      ...(current.result.unresolvedItems || []).filter((item) => item.kind !== "renderer" && !(item.kind === "copy" && retryIdSet.has(item.id))),
      ...writeback.unresolvedItems,
    ];
    const nextResult = { ...current.result, data: writeback.data, copyExecution, outputPath: null };
    for (const item of returned) store.saveTaskResult(projectId, current.run.executionRunId, `copy-${item.targetId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, item);
    const successfulTargets = tasks.filter((task) => !writeback.unresolvedItems.some((item) => item.kind === "copy" && item.id === task.targetId)).map((task) => ({ targetId: task.targetId, targetPath: task.targetPath }));
    const successfulIds = new Set(successfulTargets.map((item) => item.targetId));
    const failedTargetIds = retryIds.filter((id) => !successfulIds.has(id));
    const action = { type: single ? "retry_single_copy_target" : "retry_failed_copy_targets", targetId: single ? retryIds[0] : null, targetPath: single ? tasks[0].targetPath : null, targetIds: retryIds, targetPaths: successfulTargets.map((item) => item.targetPath), copyModelCalls: Number(execution.metrics?.modelCalls || 0) };
    await renderAfterRepair({ store, root, project: current.project, run: current.run, result: nextResult, unresolvedItems, copyExecution, render, action });
    const status = failedTargetIds.length === 0 ? "success" : successfulTargets.length ? "partial_success" : "failed";
    return { ...buildSimpleManualImagePayload(store, projectId), repair: single
      ? { kind: "copy", targetId: retryIds[0], targetPath: tasks[0].targetPath, status }
      : { kind: "copy_batch", status, targetIds: retryIds, successfulTargets, failedTargetIds } };
  });
}

export async function retrySimpleCopyTarget(options = {}) {
  return retryCopyTargets({ ...options, targetIds: [options.targetId], single: true });
}

export async function retrySimpleCopyTargets(options = {}) {
  return retryCopyTargets({ ...options, single: false });
}

export async function retrySimpleRenderer({ store, root, projectId, render = runSimpleRenderer } = {}) {
  return exclusive(projectId, async () => {
    const current = contextFor(store, projectId);
    const otherRequired = (current.result.unresolvedItems || []).filter((item) => item.required && item.kind !== "renderer");
    if (otherRequired.length) throw Object.assign(new Error("请先补齐文案、图片或客户信息，再重新检查成品"), { code: "renderer_prerequisites_missing" });
    const pending = { ...current.result, pipelineStatus: "partial", outputPath: null, renderStatus: "pending_targeted_render" };
    store.saveFinalResult(projectId, current.run.executionRunId, pending);
    store.updateProject(projectId, { status: "partial", progress: 95, currentStage: "正在重新检查成品", outputPath: null });
    const renderResult = await safeRender(render, { data: current.result.data, projectId, root, mode: "final" });
    const unresolvedItems = (current.result.unresolvedItems || []).filter((item) => item.kind !== "renderer");
    if (renderResult.status !== "success") unresolvedItems.push(rendererIssue(renderResult));
    const saved = saveResultState({ store, project: current.project, run: current.run, result: current.result, renderResult, unresolvedItems, action: { type: "retry_final_renderer" } });
    return { ...buildSimpleManualImagePayload(store, projectId), repair: { kind: "renderer", targetId: "renderer:2000", status: saved.pipelineStatus === "complete" ? "success" : "failed" } };
  });
}
