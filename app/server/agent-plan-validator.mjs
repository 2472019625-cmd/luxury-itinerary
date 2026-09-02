import { AGENT_CAPABILITY_BY_ID, AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_ID_SET, AGENT_RULE_PROFILE_VERSION, CHECKPOINT_IDS, GLOBAL_HARD_RULE_IDS } from "../config/agent-rule-profile.mjs";
import { AGENT_TASK_ROUTES } from "../config/agent-task-routing.mjs";

const forbiddenRuntimeValue = /(?:127\.0\.0\.1:4173|localhost:4173|\b98%\b|completed_empty|预算耗尽.*留空)/i;
const asArray = (value) => Array.isArray(value) ? value : [];
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const sameJson = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));

function error(code, path, message) {
  return { code, path, message };
}

function dependencyErrors(tasks) {
  const errors = [];
  const ids = new Set(tasks.map((task) => task.taskId));
  const graph = new Map(tasks.map((task) => [task.taskId, asArray(task.dependsOn)]));
  for (const task of tasks) {
    for (const dependency of asArray(task.dependsOn)) {
      if (!ids.has(dependency)) errors.push(error("schema_invalid", `tasks.${task.taskId}.dependsOn`, `依赖任务 ${dependency} 不存在`));
      if (dependency === task.taskId) errors.push(error("schema_invalid", `tasks.${task.taskId}.dependsOn`, "任务不能依赖自己"));
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) { errors.push(error("schema_invalid", "tasks.dependsOn", `任务依赖形成环：${id}`)); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) || []) if (graph.has(next)) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return errors;
}

function parallelWriteErrors(tasks) {
  const errors = [];
  const graph = new Map(tasks.map((task) => [task.taskId, asArray(task.dependsOn)]));
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) || []).some((next) => reaches(next, target, seen));
  };
  const overlaps = (left, right) => left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`) || left.startsWith(`${right}[`) || right.startsWith(`${left}[`);
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const left = tasks[leftIndex];
      const right = tasks[rightIndex];
      if (left.parallelGroup !== right.parallelGroup || !overlaps(left.targetPath, right.targetPath)) continue;
      if (reaches(left.taskId, right.taskId) || reaches(right.taskId, left.taskId)) continue;
      errors.push(error("schema_invalid", `tasks.${left.taskId}|${right.taskId}.targetPath`, `并行任务写入路径冲突：${left.targetPath} / ${right.targetPath}`));
    }
  }
  return errors;
}

function targetAllowed(targetPath, allowedTargets) {
  return allowedTargets.some((prefix) => targetPath === prefix || targetPath.startsWith(`${prefix}.`) || targetPath.startsWith(`${prefix}[`));
}

export function validateAgentPlan(plan, context) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { valid: false, errors: [error("schema_invalid", "$", "计划必须是对象")] };
  if (plan.flowKind !== "agent_v1") errors.push(error("schema_invalid", "flowKind", "flowKind 必须为 agent_v1"));
  if (plan.executionEnabled !== false) errors.push(error("capability_unauthorized", "executionEnabled", "当前阶段执行开关必须固定关闭"));
  if (plan.status !== "plan_only") errors.push(error("schema_invalid", "status", "计划状态必须为 plan_only"));
  if (plan.runtime?.port !== 4174) errors.push(error("schema_invalid", "runtime.port", "智能体规划服务必须使用独立端口 4174"));
  if (plan.ruleProfileVersion !== AGENT_RULE_PROFILE_VERSION) errors.push(error("schema_invalid", "ruleProfileVersion", "规则版本与项目快照不一致"));
  if (plan.capabilityConfigVersion !== AGENT_CAPABILITY_VERSION) errors.push(error("schema_invalid", "capabilityConfigVersion", "能力版本与项目快照不一致"));
  if (!nonEmpty(plan.promptVersion)) errors.push(error("schema_invalid", "promptVersion", "缺少提示词版本"));
  if (plan.inputFingerprint !== context.inputFingerprint) errors.push(error("fact_conflict", "inputFingerprint", "计划输入指纹与当前资料不一致"));
  if (!sameJson(plan.factBasis, context.factBasis)) errors.push(error("fact_conflict", "factBasis", "计划改写了确定性行程事实"));
  const serialized = JSON.stringify(plan);
  if (forbiddenRuntimeValue.test(serialized)) errors.push(error("capability_unauthorized", "$", "计划引用了固定流程端口、98%或缺图留空旧口径"));

  const globalRules = new Set(asArray(plan.globalRuleIds));
  for (const id of GLOBAL_HARD_RULE_IDS) if (!globalRules.has(id)) errors.push(error("rule_coverage_missing", "globalRuleIds", `缺少全局硬规则 ${id}`));
  for (const id of globalRules) if (!AGENT_RULE_ID_SET.has(id)) errors.push(error("rule_coverage_missing", "globalRuleIds", `引用了不存在的规则 ${id}`));

  const tasks = asArray(plan.tasks);
  if (!tasks.length) errors.push(error("schema_invalid", "tasks", "计划必须包含动态任务"));
  const taskIds = new Set();
  const covered = new Set();
  for (const [index, task] of tasks.entries()) {
    const path = `tasks.${index}`;
    if (!nonEmpty(task.taskId) || taskIds.has(task.taskId)) errors.push(error("schema_invalid", `${path}.taskId`, "任务 ID 缺失或重复"));
    taskIds.add(task.taskId);
    const route = AGENT_TASK_ROUTES[task.taskType];
    if (["image_strategy", "image_slot_plan"].includes(task.taskType)) errors.push(error("capability_unauthorized", `${path}.taskType`, "图片规划必须由 trip_planner 在整程规划时完成"));
    if (!route) { errors.push(error("capability_unauthorized", `${path}.taskType`, `未发布任务类型 ${task.taskType || "(空)"}`)); continue; }
    if (!nonEmpty(task.title) || !nonEmpty(task.objective) || !nonEmpty(task.expectedResult)) errors.push(error("schema_invalid", path, "任务缺少标题、目标或预期结果"));
    if (!nonEmpty(task.targetPath) || !targetAllowed(task.targetPath, route.allowedTargets)) errors.push(error("capability_unauthorized", `${path}.targetPath`, `目标路径不在 ${task.taskType} 白名单`));
    if (task.invocationMode !== "plan_only" || task.status !== "planned") errors.push(error("capability_unauthorized", path, "后续任务只能是 planned/plan_only"));
    if (!nonEmpty(task.parallelGroup)) errors.push(error("schema_invalid", `${path}.parallelGroup`, "缺少并行组"));
    if (!nonEmpty(task.failurePolicy)) errors.push(error("schema_invalid", `${path}.failurePolicy`, "缺少失败处理"));
    if (!Number.isInteger(task.retryLimit) || task.retryLimit < 0 || task.retryLimit > 1) errors.push(error("budget_exhausted", `${path}.retryLimit`, "重试次数必须为 0 或 1"));
    const capabilities = asArray(task.capabilityIds);
    if (!capabilities.length) errors.push(error("capability_unauthorized", `${path}.capabilityIds`, "任务缺少能力"));
    for (const id of capabilities) {
      if (["target_patcher", "image_blueprint"].includes(id)) errors.push(error("capability_unauthorized", `${path}.capabilityIds`, `${id} 已从智能体能力目录移除`));
      const config = AGENT_CAPABILITY_BY_ID.get(id);
      if (!config || !route.capabilityIds.includes(id) || !config.taskTypes.includes(task.taskType)) errors.push(error("capability_unauthorized", `${path}.capabilityIds`, `${id} 未授权给 ${task.taskType}`));
    }
    const budgetKeys = capabilities.map((id) => AGENT_CAPABILITY_BY_ID.get(id)?.budgetKey).filter(Boolean);
    if (!budgetKeys.includes(task.budgetKey)) errors.push(error("budget_exhausted", `${path}.budgetKey`, `预算键 ${task.budgetKey || "(空)"} 不属于任务能力`));
    const rules = new Set(asArray(task.requiredRuleIds));
    for (const id of route.requiredRuleIds) if (!rules.has(id)) errors.push(error("rule_coverage_missing", `${path}.requiredRuleIds`, `${task.taskType} 缺少必需规则 ${id}`));
    for (const id of rules) if (!AGENT_RULE_ID_SET.has(id)) errors.push(error("rule_coverage_missing", `${path}.requiredRuleIds`, `引用了不存在的规则 ${id}`));
    const checkpoints = new Set(asArray(task.checkpointIds));
    if (!route.checkpoints.some((id) => checkpoints.has(id))) errors.push(error("rule_coverage_missing", `${path}.checkpointIds`, `${task.taskType} 未覆盖所属安全检查点`));
    for (const id of checkpoints) {
      if (!CHECKPOINT_IDS.includes(id)) errors.push(error("rule_coverage_missing", `${path}.checkpointIds`, `未知安全检查点 ${id}`));
      covered.add(id);
    }
  }
  errors.push(...dependencyErrors(tasks));
  errors.push(...parallelWriteErrors(tasks));
  for (const id of CHECKPOINT_IDS) if (!covered.has(id)) errors.push(error("rule_coverage_missing", "checkpointCoverage", `整份计划未覆盖 ${id}`));
  if (tasks.length === 20 && tasks.every((task, index) => task.taskId === `T${String(index + 1).padStart(2, "0")}`)) errors.push(error("schema_invalid", "tasks", "T01—T20 只能作为检查点，不能复制为固定展示任务"));

  const slots = asArray(plan.imagePlan?.slots);
  const requiredRoles = ["cover", ...context.factBasis.hotels.map((_, index) => `hotel:${index + 1}`), ...Array.from({ length: context.factBasis.dayCount }, (_, index) => `day:${index + 1}`)];
  for (const role of requiredRoles) {
    const matching = slots.filter((slot) => slot.role === role && slot.required === true);
    if (matching.length !== 1) errors.push(error("rule_coverage_missing", "imagePlan.slots", `必需主图角色 ${role} 必须且只能规划 1 个`));
  }
  if (asArray(plan.capabilityCallStats).some((item) => item.actualCalls > 0 && !["source_parser", "trip_planner"].includes(item.capabilityId))) errors.push(error("capability_unauthorized", "capabilityCallStats", "检测到未授权能力真实调用"));
  return { valid: errors.length === 0, errors };
}

export function compactValidationErrors(errors) {
  return errors.slice(0, 30).map(({ code, path, message }) => ({ code, path, message }));
}
