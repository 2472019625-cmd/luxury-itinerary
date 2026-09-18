import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyTaskQueue } from "./copy-task-queue.mjs";
import { requestDeepSeekJson } from "./deepseek-client.mjs";
import { COPY_FACTS_RESEARCH_MODEL, runCopyFactsResearch, validateCopyResearchRequest } from "./simple-copy-facts-research.mjs";

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

export function normalizeCopyValueForSchema(value, schema = {}) {
  const normalized = structuredClone(value);
  const warnings = [];
  if (!Array.isArray(normalized) || schema?.type !== "array" || schema?.items?.type !== "object" || schema.items.additionalProperties !== false || Object.hasOwn(schema.items.properties || {}, "warnings")) {
    return { value: normalized, warnings };
  }
  for (const item of normalized) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !Object.hasOwn(item, "warnings")) continue;
    const itemWarnings = Array.isArray(item.warnings) ? item.warnings : [item.warnings];
    warnings.push(...itemWarnings.map((entry) => String(entry || "").trim()).filter(Boolean));
    delete item.warnings;
  }
  const toneEnum = schema.items.properties?.tone?.enum;
  if (Array.isArray(toneEnum) && toneEnum.length) {
    for (const item of normalized) {
      if (!item || typeof item !== "object" || Array.isArray(item) || !Object.hasOwn(item, "tone") || toneEnum.includes(item.tone)) continue;
      const invalidTone = String(item.tone || "").trim() || "空值";
      item.tone = toneEnum.includes("gold") ? "gold" : toneEnum[0];
      warnings.push(`Notes tone“${invalidTone}”不在字段契约中，已使用展示默认值“${item.tone}”。`);
    }
  }
  return { value: normalized, warnings: [...new Set(warnings)] };
}

function copyText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(copyText).join("\n");
  return "";
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sourceIncludes(source, value) {
  return clean(source).toLowerCase().includes(clean(value).toLowerCase());
}

const VISUAL_SUBJECT_CONCEPTS = Object.freeze([
  /(?:大象|象群|elephants?)/i,
  /(?:花豹|豹类|leopards?)/i,
  /(?:猎豹|cheetahs?)/i,
  /(?:狮群|狮子|lions?)/i,
  /(?:角马|wildebeest)/i,
  /(?:非洲五霸|五霸|big five|predator safari|掠食者)/i,
  /(?:迁徙|渡河|river crossing|migration)/i,
  /(?:长颈鹿|giraffes?)/i,
  /(?:热气球|hot air balloon|balloon safari)/i,
  /(?:星空床|星空寝|star bed|sleep[ -]?out|outdoor bed)/i,
  /(?:徒步(?:游猎|safari)?|walking safari)/i,
  /(?:夜间游猎|night safari|night game drive)/i,
  /(?:观景台|观景山|viewpoint|observation hill)/i,
  /(?:欢迎仪式|文化欢迎|welcome ceremony|cultural welcome|maasai welcome)/i,
  /(?:博物馆|museum|长颈鹿中心|giraffe centre|giraffe center)/i,
  /(?:酒窖|品酒|wine cellar|wine tasting|丛林早餐|bush breakfast|星空晚宴|starlit dinner|sundowner)/i,
  /(?:草原飞机|小型飞机|light aircraft|bush plane|airstrip)/i,
]);

export function validateVisualCardSubjectRetention(value, task = {}) {
  if (task.moduleType !== "visual_card" || !value || typeof value !== "object") return [];
  const subject = clean(task.facts?.titleCoreSubject || task.facts?.visualSubject);
  const title = clean(value.cardTitle);
  if (!subject || !title) return [];
  const subjectConcepts = VISUAL_SUBJECT_CONCEPTS.filter((pattern) => pattern.test(subject));
  if (subjectConcepts.length && !subjectConcepts.some((pattern) => pattern.test(title))) {
    return [`Visual Card 标题“${title}”丢失了明确视觉主体“${subject}”，不能退化成泛化游猎或体验名称`];
  }
  return [];
}

export function validateCopyCommitments(value, task = {}) {
  const output = task.moduleType === 'visual_card' && value && typeof value === 'object' ? copyText([value.cardTitle, value.cardDescription]) : copyText(value);
  if (!output) return [];
  const source = JSON.stringify({
    facts: task.facts || {},
    factStatuses: task.factStatuses || {},
    verifiedFacts: task.verifiedFacts || task.facts?.verifiedFacts || [],
  });
  const errors = [];
  if (task.moduleType === 'visual_card' && task.facts?.entityDisplayName) {
    const title = clean(value?.cardTitle);
    const displayName = clean(task.facts.entityDisplayName);
    if (!title.includes(displayName)) errors.push(`Visual Card 标题必须原样使用已确认实体展示名“${displayName}”`);
  }
  errors.push(...validateVisualCardSubjectRetention(value, task));
  for (const match of output.matchAll(/(?:^|[^\d])((?:[01]?\d|2[0-3])[:：][0-5]\d)[^，。；]{0,12}(?:准时|固定|必须|安排|出发|集合)/g)) {
    const hasConfirmedTime = sourceIncludes(source, match[1]) && /confirmed|已确认|确定|固定|准时|departureTime|startTime/i.test(source);
    if (!hasConfirmedTime) errors.push(`固定钟点承诺“${match[1]}”没有订单或已核验依据`);
  }
  for (const match of output.matchAll(/(?:必须|务必|至少)?\s*(提前\s*\d+\s*(?:天|日|小时|个月|月|周))[^，。；]{0,12}(?:预约|预订|确认|申请)/g)) {
    const hasMandatoryLeadTime = sourceIncludes(source, match[1]) && /reservation_required|必须|务必|至少|required|mandatory/i.test(source);
    if (!hasMandatoryLeadTime) errors.push(`强制预约时限“${clean(match[1])}”没有订单或已核验依据`);
  }
  for (const match of output.matchAll(/(?:必须|务必|需|需要)\s*(?:提前)?[^，。；]{0,8}(?:预约|预订|确认|申请)/g)) {
    const claim = clean(match[0]);
    if (!sourceIncludes(source, claim) && !/reservation_required|mandatory|required|必须预约|需预约/i.test(source)) errors.push(`强制预约要求“${claim}”没有订单或已核验依据`);
  }
  const guaranteedOutcome = /(?:保证|确保|一定|必然|百分之百|100%)[^，。；]{0,28}(?:看到|遇到|观察到|出现|狮子|花豹|猎豹|大象|动物|迁徙|渡河|晴天|升级|包场)|(?:看到|遇到|观察到)[^，。；]{0,20}(?:是必然|有保证|百分之百|100%)/g;
  for (const match of output.matchAll(guaranteedOutcome)) if (!sourceIncludes(source, match[0])) errors.push(`保证性结果“${clean(match[0])}”没有订单或已核验依据`);
  for (const match of output.matchAll(/(?:零距离|近距离接触)[^，。；]{0,16}(?:动物|野生环境|自然|生命)/g)) if (!sourceIncludes(source, match[0])) errors.push(`具体接近程度承诺“${clean(match[0])}”没有订单或已核验依据`);
  const credentialClaim = /(?:国家|国际|官方|协会|机构)?(?:认证|持证|注册)?\s*(?:特级|高级|一级|二级|金牌|首席|专家级)[^，。；]{0,8}(?:向导|导览员|追踪员|领队|司机|专家)/g;
  for (const match of output.matchAll(credentialClaim)) if (!sourceIncludes(source, match[0])) errors.push(`具体人员资质承诺“${clean(match[0])}”没有订单或已核验依据`);
  const pricedClaim = /(?:费用|价格|售价|需支付|加价)[^，。；]{0,12}(\d[\d,.]*\s*(?:元|美元|美金|USD|CNY|RMB))/gi;
  for (const match of output.matchAll(pricedClaim)) if (!sourceIncludes(source, match[1])) errors.push(`具体金额承诺“${clean(match[1])}”没有订单或已核验依据`);
  if (String(task.moduleType || "").toLowerCase() === "day_notice") {
    const sensitiveNumber = /\d+(?:\.\d+)?\s*(?:公斤|千克|kg|厘米|cm|毫米|mm|英寸|寸|个月|月有效期|页空白页)/gi;
    for (const match of output.matchAll(sensitiveNumber)) if (!sourceIncludes(source, match[0])) errors.push(`今日贴士中的具体政策或规格数字“${clean(match[0])}”没有原始或权威事实依据`);
  }
  const orderIncludedClaim = /(?:本次|此行|该活动|当前报价|行程)[^，。；]{0,18}(?:已包含|已含|免费|已预订|已确认|保证提供|保证使用)[^，。；]{0,24}/g;
  for (const match of output.matchAll(orderIncludedClaim)) {
    const claim = clean(match[0]);
    const isIncludedClaim = /已包含|已含|免费/.test(claim);
    const hasExactClaim = sourceIncludes(source, claim);
    const committedObject = clean(claim.replace(/^.*?(?:已包含|已含|免费|已预订|已确认|保证提供|保证使用)/, ""));
    const hasObjectEvidence = !committedObject || sourceIncludes(source, committedObject);
    const hasMatchingStatus = isIncludedClaim
      ? /"status":"included"|"included":true|已包含|已含/i.test(source)
      : /"status":"(?:confirmed|booked)"|"booked":true|已预订|guaranteed/i.test(source);
    if (!hasExactClaim && !(hasMatchingStatus && hasObjectEvidence)) errors.push(`订单包含或确认承诺“${claim}”没有确定性订单依据`);
  }
  const bookedRoomOrVehicle = /(?:本次|此行|客人|您|为您)[^，。；]{0,12}(?:已安排|将入住|升级为|保证使用)[^，。；]{0,24}(?:房|套房|帐篷|车型|车辆|飞机|船)/g;
  for (const match of output.matchAll(bookedRoomOrVehicle)) if (!sourceIncludes(source, match[0])) errors.push(`具体房型或交通履约承诺“${clean(match[0])}”没有确定性订单依据`);
  return errors;
}

// 保留旧导出名，避免已有调用方中断；语义已收窄为“承诺边界检查”。
export const validateCopyGrounding = validateCopyCommitments;

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
  if (task.researchRequest) errors.push(...validateCopyResearchRequest(task.researchRequest).map((error) => `researchRequest: ${error}`));
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

function copyBatchKind(task = {}) {
  if (task.moduleType === 'visual_card') return 'days';
  if (String(task.moduleType || "").toLowerCase() === "notes" || String(task.targetPath || "") === "notes") return "notes";
  if (String(task.moduleType || "").toLowerCase() === "day" || /^days\.\d+\./.test(String(task.targetPath || ""))) return "days";
  return "global";
}

export function partitionCopyTasks(tasks = []) {
  const groups = new Map([["global", []], ["days", []], ["notes", []]]);
  for (const task of tasks) groups.get(copyBatchKind(task)).push(task);
  return [...groups.entries()].filter(([, batchTasks]) => batchTasks.length).map(([batchKind, batchTasks]) => ({ batchKind, tasks: batchTasks }));
}

export async function runCopyWriterSkill({
  itineraryContext = {},
  tasks = [],
  apiKey,
  baseUrl,
  model,
  reasoningEffort = "medium",
  requestJson = requestDeepSeekJson,
  researchApiKey = apiKey,
  researchBaseUrl = baseUrl,
  researchModel = COPY_FACTS_RESEARCH_MODEL,
  researchFacts = runCopyFactsResearch,
  requestResearch,
  fetchResearchSource,
  signal,
  onStatus,
  onCapabilityCall,
} = {}) {
  const startedAt = Date.now();
  const batchId = randomUUID();
  if (!Array.isArray(tasks) || !tasks.length) {
    return { batchId, status: "needs_input", results: [], researchResults: [], warnings: [{ code: "tasks_required", message: "Copy Skill 需要非空 tasks[]" }], metrics: { businessBatches: 0, physicalBatches: 0, modelCalls: 0, transportAttempts: 0, researchCalls: 0, researchTransportAttempts: 0, automaticBusinessRetryRounds: 0, durationMs: Date.now() - startedAt } };
  }

  const seen = new Set();
  const validTasks = [];
  const resultById = new Map();
  const emitTaskProgress = () => onCapabilityCall?.({
    phase: "task_progress",
    capabilityId: "copy_task_progress",
    batchId,
    completedTasks: Math.min(tasks.length, resultById.size),
    totalTasks: tasks.length,
  });
  for (const [index, task] of tasks.entries()) {
    const resultKey = task?.targetId || `invalid-${index}`;
    const errors = validateCopyTask(task);
    if (seen.has(task?.targetId)) errors.push("targetId 重复");
    if (task?.targetId) seen.add(task.targetId);
    if (errors.length) resultById.set(resultKey, interfaceFailure(task, errors));
    else validTasks.push(task);
  }
  emitTaskProgress();

  let modelCalls = 0;
  let transportAttempts = 0;
  let modelMs = 0;
  let researchCalls = 0;
  let researchTransportAttempts = 0;
  let researchMs = 0;
  const warnings = [];
  const researchResultById = new Map();
  const researchCache = new Map();
  const writerTaskById = new Map();
  const researchWarningById = new Map();
  await Promise.all(validTasks.map(async (task) => {
    if (!task.researchRequest) {
      writerTaskById.set(task.targetId, task);
      return;
    }
    const cacheKey = JSON.stringify(task.researchRequest);
    let researchPromise = researchCache.get(cacheKey);
    if (!researchPromise) {
      researchCalls += 1;
      researchPromise = (async () => {
        const callId = randomUUID();
        const callStartedAt = Date.now();
        onCapabilityCall?.({ phase: "started", capabilityId: "copy_facts_research", callId, batchId, researchType: task.researchRequest.researchType, entityName: task.researchRequest.entityName });
        try {
          const result = await researchFacts({
            researchRequest: task.researchRequest,
            apiKey: researchApiKey,
            baseUrl: researchBaseUrl,
            model: researchModel,
            requestResearch,
            fetchSource: fetchResearchSource,
            signal,
          });
          researchTransportAttempts += result.attemptUsages?.length || 1;
          researchMs += Date.now() - callStartedAt;
          onCapabilityCall?.({ phase: "finished", capabilityId: "copy_facts_research", callId, batchId, researchType: task.researchRequest.researchType, entityName: task.researchRequest.entityName, status: result.status, verifiedFactCount: result.verifiedFacts?.length || 0, durationMs: Date.now() - callStartedAt, usage: result.usage || null });
          return result;
        } catch (error) {
          researchTransportAttempts += error?.attemptUsages?.length || 1;
          researchMs += Date.now() - callStartedAt;
          onCapabilityCall?.({ phase: "finished", capabilityId: "copy_facts_research", callId, batchId, researchType: task.researchRequest.researchType, entityName: task.researchRequest.entityName, failed: true, reason: error?.message || String(error), durationMs: Date.now() - callStartedAt });
          throw error;
        }
      })();
      researchCache.set(cacheKey, researchPromise);
    }
    try {
      const research = await researchPromise;
      researchResultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, ...research });
      writerTaskById.set(task.targetId, {
        ...task,
        facts: {
          ...task.facts,
          verifiedFacts: research.verifiedFacts || [],
          factsResearchOutcome: {
            status: research.status,
            verifiedFactCount: research.verifiedFacts?.length || 0,
            zeroFactBoundary: research.verifiedFacts?.length ? null : "禁止依赖模型常识新增酒店设施、设计、景观或服务；只能选择当前 task 中已有的供应商事实，资料不足时保持克制或返回事实不足 warning。",
          },
        },
        factStatuses: { ...task.factStatuses, externalFacts: research.status, externalFactCount: research.verifiedFacts?.length || 0 },
        verifiedFacts: { researchType: research.researchType, entityName: research.entityName, verifiedFacts: research.verifiedFacts || [] },
      });
      if (research.status !== "success") {
        const message = `${research.entityName} 酒店官方事实研究未成功；Copy 只能使用原始供应商资料中明确属于该酒店的事实，资料不足时保持克制，不以产品角色或泛化酒店介绍填充。`;
        researchWarningById.set(task.targetId, message);
        warnings.push({ code: "copy_facts_not_found", targetId: task.targetId, message });
      }
    } catch (error) {
      researchResultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, researchType: task.researchRequest.researchType, entityName: task.researchRequest.entityName, status: "failed", verifiedFacts: [], error: { code: error?.code || "copy_facts_research_failed", message: error?.message || String(error) } });
      resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: error?.code || "copy_facts_research_failed", message: error?.message || String(error) }, warnings: [] });
    }
  }));
  emitTaskProgress();

  const writerTasks = validTasks.map((task) => writerTaskById.get(task.targetId)).filter(Boolean);
  const physicalBatches = partitionCopyTasks(writerTasks);
  await Promise.all(physicalBatches.map(async ({ batchKind, tasks: batchTasks }) => {
    const callId = randomUUID();
    const callStartedAt = Date.now();
    onCapabilityCall?.({ phase: "started", capabilityId: "copy_writer", callId, batchId, batchKind, targetCount: batchTasks.length });
    try {
      const modelStartedAt = Date.now();
      const response = await copyTaskQueue.add(() => requestJson({
        apiKey,
        baseUrl,
        model,
        messages: [
          { role: "system", content: `${skillPrompt}\n\n## Runtime response contract\n只处理输入 tasks，不新增、删除、重排或重新规划任务。只输出 JSON 对象：{"results":[{"targetId":"与输入一致","targetPath":"与输入一致","value":"严格符合该任务 outputSchema 的值","warnings":[]}]}；targetId 与 targetPath 必须和输入完全一致，一个任务无法完成时仍保留其他任务结果。\nverifiedFacts 只能支持实体客观事实，不能推断本订单房型、包含项、价格、保证车型、已预订服务或正式状态。\n固定钟点、保证性结果、明确人员资质等级、强制预约要求或期限、具体金额、订单包含或已预订状态，以及具体房型或车型履约，必须有当前 task 的订单事实或 verifiedFacts 支持。\n不得返回 Reviewer、finding、自动改写或 retry 决策。` },
          { role: "user", content: JSON.stringify({ itineraryContext, batchKind, tasks: batchTasks }) },
        ],
        reasoningEffort,
        maxTokens: Math.min(20_000, Math.max(4_000, batchTasks.length * 1_200)),
        emptyContentRetries: 1,
        signal,
        onStatus,
      }), { taskId: `simple-copy:${batchId}:${batchKind}` });
      modelMs += Date.now() - modelStartedAt;
      const attempts = response.attemptUsages?.length || response.usage?.attempt_count || 1;
      modelCalls += attempts;
      transportAttempts += attempts;
      const returned = Array.isArray(response.json?.results) ? response.json.results : [];
      const returnedById = new Map(returned.map((item) => [item?.targetId, item]));
      for (const task of batchTasks) {
        const item = returnedById.get(task.targetId);
        if (!item) {
          resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "target_result_missing", message: "模型未返回该 targetId" }, warnings: [] });
          continue;
        }
        if (item.targetPath !== task.targetPath) {
          resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "target_path_mismatch", message: "返回 targetPath 与 Planner 任务不一致" }, warnings: item.warnings || [] });
          continue;
        }
        const normalized = normalizeCopyValueForSchema(item.value, task.outputSchema);
        const resultWarnings = [...new Set([...(Array.isArray(item.warnings) ? item.warnings : []), ...normalized.warnings, researchWarningById.get(task.targetId)].filter(Boolean))];
        const schemaErrors = validateCopyValue(normalized.value, task.outputSchema);
        if (schemaErrors.length) {
          resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "invalid_output_schema", message: schemaErrors.join("；"), fields: schemaErrors }, warnings: resultWarnings });
          continue;
        }
        const commitmentErrors = validateCopyCommitments(normalized.value, task);
        if (commitmentErrors.length) {
          resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "unsupported_copy_commitment", message: commitmentErrors.join("；"), fields: commitmentErrors }, warnings: resultWarnings });
          continue;
        }
        resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "success", value: normalized.value, warnings: resultWarnings });
      }
      const extraIds = returned.map((item) => item?.targetId).filter((id) => id && !seen.has(id));
      if (extraIds.length) warnings.push({ code: "unexpected_targets_ignored", message: `已忽略非 Planner 任务：${extraIds.join(", ")}` });
      onCapabilityCall?.({ phase: "finished", capabilityId: "copy_writer", callId, batchId, batchKind, targetCount: batchTasks.length, durationMs: Date.now() - callStartedAt, attemptCount: attempts, usage: response.usage || null });
    } catch (error) {
      modelMs += Date.now() - callStartedAt;
      const attempts = error?.attemptUsages?.length || 1;
      modelCalls += attempts;
      transportAttempts += attempts;
      for (const task of batchTasks) resultById.set(task.targetId, { targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: error?.code || "copy_request_failed", message: error?.message || String(error) }, warnings: [] });
      onCapabilityCall?.({ phase: "finished", capabilityId: "copy_writer", callId, batchId, batchKind, targetCount: batchTasks.length, durationMs: Date.now() - callStartedAt, attemptCount: attempts, failed: true, reason: error?.message || String(error) });
    } finally {
      emitTaskProgress();
    }
  }));

  emitTaskProgress();
  const results = tasks.map((task, index) => resultById.get(task?.targetId || `invalid-${index}`)).filter(Boolean);
  const researchResults = tasks.map((task) => researchResultById.get(task?.targetId)).filter(Boolean);
  return { batchId, status: batchStatus(results), results, researchResults, warnings, metrics: { businessBatches: physicalBatches.length, physicalBatches: physicalBatches.length, modelCalls, transportAttempts, researchCalls, researchTransportAttempts, automaticBusinessRetryRounds: 0, reasoningEffort, modelMs, researchMs, durationMs: Date.now() - startedAt } };
}
