import { randomUUID } from "node:crypto";
import { AGENT_CAPABILITY_BY_ID, AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";

export const EXECUTION_CONFIG_VERSION = "agent-execution-v2";
export const EXECUTION_ENABLED = true;

export const EXECUTION_STAGES = Object.freeze([
  { id: "planning", label: "整程规划", weight: 8, taskTypes: ["project_setup", "source_intake", "fact_review", "confirmation", "journey_strategy", "module_strategy"] },
  { id: "verification", label: "事实核验", weight: 12, taskTypes: ["web_verification"] },
  { id: "copy", label: "文案生成", weight: 25, taskTypes: ["copy_global", "copy_hotel_transport", "copy_day_group", "copy_closing", "targeted_copy_repair"] },
  { id: "brand_review", label: "品牌审查", weight: 8, taskTypes: ["copy_review"] },
  { id: "images", label: "图片处理", weight: 30, taskTypes: ["image_search_plan", "visual_review", "image_placement", "image_gap_resolution"] },
  { id: "render", label: "成品渲染", weight: 12, taskTypes: ["layout_render"] },
  { id: "final_checks", label: "最终检查", weight: 5, taskTypes: ["final_qa", "completion_gate", "control", "persistence"] },
]);

const allowedDependencyStates = new Set(["succeeded", "user_resolved", "user_accepted_suggestion", "not_applicable", "removed_optional"]);
const finishedStates = new Set([...allowedDependencyStates, "failed", "cancelled"]);
const succeededStates = new Set(allowedDependencyStates);
const stageForTaskType = (taskType) => EXECUTION_STAGES.find((stage) => stage.taskTypes.includes(taskType))?.id || "final_checks";

function taskProgress(plan, run) {
  let percent = 0;
  const stages = EXECUTION_STAGES.map((stage) => {
    const taskIds = plan.tasks.filter((task) => stage.taskTypes.includes(task.taskType)).map((task) => task.taskId);
    const taskRuns = taskIds.map((taskId) => run.taskRuns.find((item) => item.taskId === taskId)).filter(Boolean);
    const completed = taskRuns.filter((item) => succeededStates.has(item.status)).length;
    const ratio = taskRuns.length ? completed / taskRuns.length : 1;
    percent += stage.weight * ratio;
    const hasRunning = taskRuns.some((item) => item.status === "running");
    const hasWaiting = taskRuns.some((item) => item.status === "waiting_confirmation");
    const hasFailed = taskRuns.some((item) => item.status === "failed");
    return { id: stage.id, label: stage.label, weight: stage.weight, totalTasks: taskRuns.length, completedTasks: completed, status: completed === taskRuns.length ? "complete" : hasFailed ? "failed" : hasWaiting ? "waiting_confirmation" : hasRunning ? "running" : "pending" };
  });
  const completionPassed = run.status === "complete" && run.taskRuns.every((item) => succeededStates.has(item.status));
  return { percent: completionPassed ? 100 : Math.min(99, Math.floor(percent)), completedTasks: run.taskRuns.filter((item) => succeededStates.has(item.status)).length, totalTasks: run.taskRuns.length, stages };
}

export function appendExecutionEvent(run, event, now = new Date().toISOString()) {
  const events = Array.isArray(run.events) ? run.events : [];
  return {
    ...run,
    updatedAt: now,
    events: [...events, { eventId: randomUUID(), seq: events.length + 1, at: now, type: event.type || "status", stage: event.stage || null, taskId: event.taskId || null, status: event.status || run.status, message: event.message || "", waitingReason: event.waitingReason || null, metrics: event.metrics || null }],
  };
}

export function createExecutionRun(project, plan, now = new Date().toISOString()) {
  if (!project || !plan || project.activePlanId !== plan.planId) throw new Error("执行只能读取项目 activePlanId 对应计划");
  if (project.inputFingerprint !== plan.inputFingerprint) throw new Error("项目与计划输入指纹不一致");
  if (plan.ruleProfileVersion !== AGENT_RULE_PROFILE_VERSION || plan.capabilityConfigVersion !== AGENT_CAPABILITY_VERSION) throw new Error("计划版本与当前发布配置不一致");
  if (plan.status !== "plan_only" || plan.executionEnabled !== false) throw new Error("规划记录必须保持不可执行证明");
  const run = {
    executionRunId: randomUUID(), projectId: project.projectId, planId: plan.planId, inputFingerprint: plan.inputFingerprint,
    configVersion: EXECUTION_CONFIG_VERSION, executionEnabled: true,
    authorization: { scope: "active_plan", planId: plan.planId, authorizedAt: now },
    status: "pending", createdAt: now, updatedAt: now, startedAt: null, endedAt: null, error: null,
    taskRuns: plan.tasks.map((task) => ({ taskId: task.taskId, taskType: task.taskType, stage: stageForTaskType(task.taskType), status: "pending", capabilityIds: [...task.capabilityIds], startedAt: null, endedAt: null, resultRef: null, evidenceRefs: [], retryCount: 0, error: null })),
    capabilityCallStats: [...new Set(plan.tasks.flatMap((task) => task.capabilityIds))].map((capabilityId) => ({ capabilityId, actualCalls: 0, retries: 0, failures: 0, durationMs: 0, usage: null, estimatedCost: null })),
    progress: null, events: [],
  };
  const initialized = appendExecutionEvent(run, { type: "run_created", stage: "planning", status: "pending", message: "执行运行已获授权，等待开始" }, now);
  return { ...initialized, progress: taskProgress(plan, initialized) };
}

export function readyExecutionTasks(plan, run) {
  const state = new Map(run.taskRuns.map((item) => [item.taskId, item.status]));
  return plan.tasks.filter((task) => state.get(task.taskId) === "pending" && task.dependsOn.every((dependency) => allowedDependencyStates.has(state.get(dependency))));
}

export function readyParallelGroups(plan, run) {
  return Object.entries(readyExecutionTasks(plan, run).reduce((groups, task) => { (groups[task.parallelGroup] ||= []).push(task.taskId); return groups; }, {})).map(([parallelGroup, taskIds]) => ({ parallelGroup, taskIds }));
}

export function assertCapabilityRoute(task, capabilityId, run) {
  if (!run?.executionEnabled || run.planId !== run.authorization?.planId || !EXECUTION_ENABLED) throw new Error("执行运行未获得有效授权");
  if (!task.capabilityIds.includes(capabilityId)) throw new Error(`${capabilityId} 不属于任务 ${task.taskId}`);
  const capability = AGENT_CAPABILITY_BY_ID.get(capabilityId);
  if (!capability || !capability.taskTypes.includes(task.taskType)) throw new Error(`${capabilityId} 未授权给 ${task.taskType}`);
  if (!capability.actualInvocationAllowed) throw new Error(`${capabilityId} 当前禁止真实调用`);
  return capability;
}

export function transitionExecutionTask(plan, run, taskId, status, details = {}, now = new Date().toISOString()) {
  const task = plan.tasks.find((item) => item.taskId === taskId);
  const current = run.taskRuns.find((item) => item.taskId === taskId);
  if (!task || !current) throw new Error(`执行任务不存在：${taskId}`);
  const taskRuns = run.taskRuns.map((item) => item.taskId === taskId ? { ...item, status, startedAt: item.startedAt || (status === "running" ? now : null), endedAt: finishedStates.has(status) ? now : null, resultRef: details.resultRef ?? item.resultRef, evidenceRefs: details.evidenceRefs ? [...item.evidenceRefs, ...details.evidenceRefs] : item.evidenceRefs, retryCount: details.retryCount ?? item.retryCount, error: details.error ?? (succeededStates.has(status) ? null : item.error) } : item);
  let runStatus = status === "waiting_confirmation" ? "waiting_confirmation" : status === "failed" ? "failed" : run.status === "pending" ? "running" : run.status;
  if (taskRuns.every((item) => succeededStates.has(item.status))) runStatus = "complete";
  const updated = { ...run, status: runStatus, startedAt: run.startedAt || now, endedAt: runStatus === "complete" ? now : null, taskRuns };
  const withEvent = appendExecutionEvent(updated, { type: "task_status", taskId, stage: stageForTaskType(task.taskType), status, message: details.message || task.title, waitingReason: details.waitingReason, metrics: details.metrics }, now);
  return { ...withEvent, progress: taskProgress(plan, withEvent) };
}

export function recordCapabilityCall(plan, run, capabilityId, details = {}, now = new Date().toISOString()) {
  const capabilityCallStats = run.capabilityCallStats.map((item) => item.capabilityId === capabilityId ? { ...item, actualCalls: item.actualCalls + 1, retries: item.retries + (details.retry ? 1 : 0), failures: item.failures + (details.failed ? 1 : 0), durationMs: item.durationMs + Math.max(0, Number(details.durationMs) || 0), usage: details.usage || item.usage, estimatedCost: details.estimatedCost ?? item.estimatedCost } : item);
  const updated = appendExecutionEvent({ ...run, capabilityCallStats }, { type: "capability_call", taskId: details.taskId, stage: details.stage, status: details.failed ? "failed" : "complete", message: details.message || `${capabilityId} 调用完成`, metrics: { capabilityId, durationMs: details.durationMs || 0, usage: details.usage || null, retry: Boolean(details.retry) } }, now);
  return { ...updated, progress: taskProgress(plan, updated) };
}

export function cancelExecutionRun(plan, run, now = new Date().toISOString()) {
  if (["cancelled", "complete"].includes(run.status)) return run;
  const cancelled = { ...run, status: "cancelled", endedAt: now, error: null, taskRuns: run.taskRuns.map((task) => ["pending", "running", "waiting_confirmation"].includes(task.status) ? { ...task, status: "cancelled", endedAt: now } : task) };
  const withEvent = appendExecutionEvent(cancelled, { type: "run_cancelled", status: "cancelled", message: "用户已取消生成，已有项目和证据已保留" }, now);
  return { ...withEvent, progress: taskProgress(plan, withEvent) };
}
