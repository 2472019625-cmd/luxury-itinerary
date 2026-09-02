import { randomUUID } from "node:crypto";
import { AGENT_CAPABILITY_BY_ID, AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";

export const EXECUTION_CONFIG_VERSION = "agent-execution-v1";
export const EXECUTION_ENABLED = false;
const allowedDependencyStates = new Set(["succeeded", "user_resolved", "user_accepted_suggestion", "not_applicable", "removed_optional"]);

export function createExecutionRun(project, plan, now = new Date().toISOString()) {
  if (!project || !plan || project.activePlanId !== plan.planId) throw new Error("执行只能读取项目 activePlanId 对应计划");
  if (project.inputFingerprint !== plan.inputFingerprint) throw new Error("项目与计划输入指纹不一致");
  if (plan.ruleProfileVersion !== AGENT_RULE_PROFILE_VERSION || plan.capabilityConfigVersion !== AGENT_CAPABILITY_VERSION) throw new Error("计划版本与当前发布配置不一致");
  if (plan.status !== "plan_only" || plan.executionEnabled !== false) throw new Error("规划记录必须保持不可执行证明");
  return {
    executionRunId: randomUUID(), projectId: project.projectId, planId: plan.planId, inputFingerprint: plan.inputFingerprint,
    configVersion: EXECUTION_CONFIG_VERSION, executionEnabled: false, status: "execution_disabled",
    createdAt: now, startedAt: null, endedAt: now, error: { code: "execution_not_enabled", message: "执行能力尚未开放" },
    taskRuns: plan.tasks.map((task) => ({ taskId: task.taskId, status: "pending", capabilityIds: [...task.capabilityIds], startedAt: null, endedAt: null, resultRef: null, evidenceRefs: [], retryCount: 0, error: null })),
    capabilityCallStats: [...new Set(plan.tasks.flatMap((task) => task.capabilityIds))].map((capabilityId) => ({ capabilityId, actualCalls: 0 })),
  };
}

export function readyExecutionTasks(plan, run) {
  const state = new Map(run.taskRuns.map((item) => [item.taskId, item.status]));
  return plan.tasks.filter((task) => state.get(task.taskId) === "pending" && task.dependsOn.every((dependency) => allowedDependencyStates.has(state.get(dependency))));
}

export function readyParallelGroups(plan, run) {
  return Object.entries(readyExecutionTasks(plan, run).reduce((groups, task) => { (groups[task.parallelGroup] ||= []).push(task.taskId); return groups; }, {})).map(([parallelGroup, taskIds]) => ({ parallelGroup, taskIds }));
}

export function assertCapabilityRoute(task, capabilityId) {
  if (!task.capabilityIds.includes(capabilityId)) throw new Error(`${capabilityId} 不属于任务 ${task.taskId}`);
  const capability = AGENT_CAPABILITY_BY_ID.get(capabilityId);
  if (!capability || !capability.taskTypes.includes(task.taskType)) throw new Error(`${capabilityId} 未授权给 ${task.taskType}`);
  if (!EXECUTION_ENABLED || !capability.actualInvocationAllowed || !task.executionAuthorized) throw new Error("执行能力尚未开放");
  return capability;
}

export function cancelExecutionRun(run, now = new Date().toISOString()) {
  if (["cancelled", "complete"].includes(run.status)) return run;
  return { ...run, status: "cancelled", endedAt: now, error: null, taskRuns: run.taskRuns.map((task) => ["pending", "running"].includes(task.status) ? { ...task, status: "cancelled", endedAt: now } : task) };
}

