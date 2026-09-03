import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyTaskQueue } from "./copy-task-queue.mjs";
import { requestDeepSeekJson } from "./deepseek-client.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillPrompt = readFileSync(path.join(workspaceRoot, "skills", "copy-writer", "SKILL.md"), "utf8");
const requiredTaskFields = ["targetId", "moduleType", "facts", "factStatuses", "plannerGoal", "relevantContext", "targetPath", "outputSchema"];

function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function schemaTypes(schema = {}) {
  return Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
}

export function validateCopyValue(value, schema = {}, pathLabel = "value") {
  const errors = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${pathLabel} 的 outputSchema 不是对象`];
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((option) => validateCopyValue(value, option, pathLabel).length === 0)) errors.push(`${pathLabel} 不符合 anyOf 中的任一结构`);
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((option) => validateCopyValue(value, option, pathLabel).length === 0).length !== 1) errors.push(`${pathLabel} 不符合唯一 oneOf 结构`);
  if (Object.hasOwn(schema, "const") && value !== schema.const) errors.push(`${pathLabel} 不等于约定常量`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) errors.push(`${pathLabel} 不在约定枚举中`);
  const types = schemaTypes(schema);
  const matchesType = (type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  };
  if (types.length && !types.some(matchesType)) {
    errors.push(`${pathLabel} 类型应为 ${types.join("|")}`);
    return errors;
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${pathLabel} 短于 minLength`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${pathLabel} 长于 maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${pathLabel} 不符合 pattern`);
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${pathLabel} 小于 minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${pathLabel} 大于 maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${pathLabel} 少于 minItems`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${pathLabel} 多于 maxItems`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateCopyValue(item, schema.items, `${pathLabel}.${index}`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${pathLabel}.${key} 缺失`);
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateCopyValue(value[key], childSchema, `${pathLabel}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${pathLabel}.${key} 不在 outputSchema 中`);
    }
  }
  return errors;
}

export function validateCopyTask(task = {}) {
  const missing = requiredTaskFields.filter((field) => !present(task[field]));
  const errors = missing.map((field) => `缺少 ${field}`);
  if (present(task.targetPath) && !/^[A-Za-z][A-Za-z0-9_]*(?:\.(?:[A-Za-z][A-Za-z0-9_]*|\d+))*$/.test(task.targetPath)) errors.push("targetPath 不是精确点路径");
  if (present(task.outputSchema) && (typeof task.outputSchema !== "object" || Array.isArray(task.outputSchema))) errors.push("outputSchema 不是 JSON Schema 对象");
  const highlight = String(task.moduleType || "").toLowerCase().includes("highlight") || /^highlights\.\d+$/.test(String(task.targetPath || ""));
  if (highlight) {
    if (!/^highlights\.\d+$/.test(String(task.targetPath || ""))) errors.push("产品亮点 targetPath 必须指向 highlights.<index>");
    if (!present(task.facts) || !present(task.plannerGoal)) errors.push("产品亮点缺少 Planner 已确定的卖点事实或写作目标");
  }
  return errors;
}

function batchStatus(results) {
  const statuses = new Set(results.map((item) => item.status));
  if (statuses.size === 1 && statuses.has("success")) return "success";
  if (statuses.has("success")) return "partial_success";
  if (statuses.has("needs_input") && !statuses.has("failed")) return "needs_input";
  return "failed";
}

function interfaceFailure(task, errors) {
  const isHighlight = String(task?.moduleType || "").toLowerCase().includes("highlight") || String(task?.targetPath || "").startsWith("highlights.");
  return {
    targetId: task?.targetId || null,
    targetPath: task?.targetPath || null,
    status: "needs_input",
    error: { code: isHighlight ? "invalid_highlight_contract" : "invalid_copy_task_contract", message: errors.join("；"), fields: errors },
    warnings: [],
  };
}

export async function runCopyWriterSkill({
  itineraryContext = {},
  tasks = [],
  apiKey,
  baseUrl,
  model,
  reasoningEffort = "medium",
  requestJson = requestDeepSeekJson,
  signal,
  onStatus,
  onCapabilityCall,
} = {}) {
  const startedAt = Date.now();
  const batchId = randomUUID();
  if (!Array.isArray(tasks) || !tasks.length) {
    return { batchId, status: "needs_input", results: [], warnings: [{ code: "tasks_required", message: "Copy Skill 需要非空 tasks[]" }], metrics: { businessBatches: 1, modelCalls: 0, transportAttempts: 0, durationMs: Date.now() - startedAt } };
  }

  const seen = new Set();
  const validTasks = [];
  const resultById = new Map();
  for (const [index, task] of tasks.entries()) {
    const resultKey = task?.targetId || `invalid-${index}`;
    const errors = validateCopyTask(task);
    if (seen.has(task?.targetId)) errors.push("targetId 重复");
    if (task?.targetId) seen.add(task.targetId);
    if (errors.length) resultById.set(resultKey, interfaceFailure(task, errors));
    else validTasks.push(task);
  }

  let modelCalls = 0;
  let transportAttempts = 0;
  let modelMs = 0;
  const warnings = [];
  if (validTasks.length) {
    const callId = randomUUID();
    const callStartedAt = Date.now();
    onCapabilityCall?.({ phase: "started", capabilityId: "copy_writer", callId, batchId, targetCount: validTasks.length });
    try {
      modelCalls += 1;
      const modelStartedAt = Date.now();
      const response = await copyTaskQueue.add(() => requestJson({
        apiKey,
        baseUrl,
        model,
        messages: [
          { role: "system", content: `${skillPrompt}\n\n## Runtime response contract\n只处理输入 tasks，不新增、删除、重排或重新规划任务。只输出 JSON 对象：{"results":[{"targetId":"与输入一致","targetPath":"与输入一致","value":"严格符合该任务 outputSchema 的值","warnings":[]}]}。一个任务无法完成时仍保留其他任务结果；不得返回 Reviewer、finding 或 retry 决策。` },
          { role: "user", content: JSON.stringify({ itineraryContext, tasks: validTasks }) },
        ],
        reasoningEffort,
        maxTokens: Math.min(20_000, Math.max(4_000, validTasks.length * 1_200)),
        emptyContentRetries: 0,
        signal,
        onStatus,
      }), { taskId: `simple-copy:${batchId}` });
      modelMs += Date.now() - modelStartedAt;
      transportAttempts = response.attemptUsages?.length || response.usage?.attempt_count || 1;
      const returned = Array.isArray(response.json?.results) ? response.json.results : [];
      const returnedById = new Map(returned.map((item) => [item?.targetId, item]));
      for (const task of validTasks) {
        const item = returnedById.get(task.targetId);
        if (!item) {
          resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "target_result_missing", message: "模型未返回该 targetId" }, warnings: [] });
          continue;
        }
        if (item.targetPath !== task.targetPath) {
          resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "target_path_mismatch", message: "返回 targetPath 与 Planner 任务不一致" }, warnings: item.warnings || [] });
          continue;
        }
        const schemaErrors = validateCopyValue(item.value, task.outputSchema);
        if (schemaErrors.length) {
          resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "invalid_output_schema", message: schemaErrors.join("；"), fields: schemaErrors }, warnings: item.warnings || [] });
          continue;
        }
        resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "success", value: item.value, warnings: Array.isArray(item.warnings) ? item.warnings : [] });
      }
      const extraIds = returned.map((item) => item?.targetId).filter((id) => id && !seen.has(id));
      if (extraIds.length) warnings.push({ code: "unexpected_targets_ignored", message: `已忽略非 Planner 任务：${extraIds.join(", ")}` });
      onCapabilityCall?.({ phase: "finished", capabilityId: "copy_writer", callId, batchId, targetCount: validTasks.length, durationMs: Date.now() - callStartedAt, attemptCount: transportAttempts, usage: response.usage || null });
    } catch (error) {
      modelMs += Date.now() - callStartedAt;
      transportAttempts = error?.attemptUsages?.length || Math.max(1, transportAttempts);
      for (const task of validTasks) resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: error?.code || "copy_request_failed", message: error?.message || String(error) }, warnings: [] });
      onCapabilityCall?.({ phase: "finished", capabilityId: "copy_writer", callId, batchId, targetCount: validTasks.length, durationMs: Date.now() - callStartedAt, attemptCount: transportAttempts, failed: true, reason: error?.message || String(error) });
    }
  }

  const results = tasks.map((task, index) => resultById.get(task?.targetId || `invalid-${index}`)).filter(Boolean);
  return { batchId, status: batchStatus(results), results, warnings, metrics: { businessBatches: 1, modelCalls, transportAttempts, reasoningEffort, modelMs, durationMs: Date.now() - startedAt } };
}
