import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COPY_RULE_RUNTIME } from "../config/copy-rule-runtime.mjs";
import { requestDeepSeekJson } from "./deepseek-client.mjs";
import { compactForModel, mergeRefinement, applyTargetedRevisions, compareDeterministicFacts } from "./itinerary-refinement.mjs";
import { generateModularCopy } from "./modular-copy-generator.mjs";
import { reviewCustomerContent } from "./content-quality.mjs";
import { buildCopyTargetContext, planCopyRepairs } from "./copy-repair.mjs";
import { copyUnitRuleCards } from "./agent-rule-cards.mjs";
import { copyTaskQueue } from "./copy-task-queue.mjs";
import { createCopyUnitStore } from "./copy-unit-store.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptCache = new Map();
const promptText = (file) => {
  if (!/^[a-z0-9-]+\.md$/i.test(file)) throw new Error("文案提示词文件名非法");
  if (!promptCache.has(file)) promptCache.set(file, readFileSync(path.join(appRoot, "prompts", file), "utf8"));
  return promptCache.get(file);
};

export function normalizeCustomerCopyPath(value) {
  let path = String(value || "").trim().replace(/^\$\./, "");
  for (const prefix of ["firstDraft.", "customerCopy.", "currentDraft.", "data."]) if (path.startsWith(prefix)) path = path.slice(prefix.length);
  return path;
}

const normalizeIssue = (item = {}, unresolved = false) => ({
  ...item,
  path: normalizeCustomerCopyPath(item.path),
  ruleIds: item.ruleIds || (item.ruleId ? [item.ruleId] : ["COPY-001"]),
  severity: item.severity || (unresolved ? "fact" : "quality"),
  action: item.action || (unresolved ? "block" : "targeted_rewrite"),
});

function uniqueIssues(items = []) {
  const unique = new Map();
  for (const item of items.filter(Boolean)) {
    const key = `${(item.ruleIds || []).join("/")}:${item.path || "customer"}:${item.code || ""}:${item.message || ""}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function selectCustomerCopy(data = {}, hiddenModules = []) {
  const hidden = new Set(hiddenModules);
  return {
    title: data.title,
    subtitle: data.subtitle,
    highlights: data.highlights,
    hotels: hidden.has("hotels") ? [] : data.hotels,
    diningExperiences: hidden.has("dining") ? [] : data.diningExperiences,
    transportSummary: hidden.has("transport") ? [] : data.transportSummary,
    days: data.days,
    notes: data.notes,
    includedCustomer: hidden.has("expenses") ? [] : data.includedCustomer,
    excludedCustomer: hidden.has("expenses") ? [] : data.excludedCustomer,
    cancellationCustomer: hidden.has("expenses") ? [] : data.cancellationCustomer,
  };
}

function repairBatchKey(target = {}) {
  if (target.kind === "day") return "days";
  if (target.kind === "hotel") return "hotels";
  if (target.kind === "dining") return "dining";
  if (target.kind === "transport") return "transport";
  if (["notes", "expenses"].includes(target.kind)) return "closing";
  return "global";
}

export function groupRepairTargets(targets = []) {
  const groups = new Map();
  for (const target of targets) {
    const key = repairBatchKey(target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }
  return [...groups.entries()].map(([key, batchTargets]) => ({ key, targets: batchTargets }));
}

function applyHiddenModuleDecisions(data, hiddenModules = []) {
  const hidden = new Set(hiddenModules);
  const next = { ...data };
  if (hidden.has("hotels")) next.hotels = [];
  if (hidden.has("dining")) next.diningExperiences = [];
  if (hidden.has("transport")) next.transportSummary = [];
  if (hidden.has("expenses")) Object.assign(next, { showExpenseSection: false, includedCustomer: [], excludedCustomer: [], cancellationCustomer: [] });
  return next;
}

async function requestStructuredTwice(requestModel, promptFile, input, options, validate, label) {
  let lastReason = "结构不符合要求";
  for (let technicalAttempt = 1; technicalAttempt <= 2; technicalAttempt += 1) {
    const payload = technicalAttempt === 1 ? input : { ...input, technicalCorrection: { reason: lastReason, instruction: "只修正JSON结构、字段路径和缺失数组，不新增业务判断，也不重新审查其他内容。" } };
    const response = await requestModel(promptFile, payload, options);
    lastReason = validate(response.json);
    if (!lastReason) return { ...response, technicalAttemptCount: technicalAttempt };
  }
  const failure = new Error(`${label}连续两次返回非法结构：${lastReason}`);
  failure.code = "invalid_model_output";
  throw failure;
}

function pathCovered(issuePath, patchPath) {
  const left = String(issuePath || "");
  const right = String(patchPath || "");
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`) || (left === "expenses" && /^(includedCustomer|excludedCustomer|cancellationCustomer)/.test(right));
}

export function createAgentCopyModelRequester({ apiKey, baseUrl, model, requestJson = requestDeepSeekJson, signal, onStatus, onCapabilityCall }) {
  return async (promptFile, payload, options = {}) => copyTaskQueue.add(async () => {
    const callId = randomUUID();
    const capabilityId = options.capabilityId || "copy_writer";
    const started = Date.now();
    onCapabilityCall?.({ phase: "started", callId, capabilityId, taskId: options.taskId || promptFile, stage: capabilityId === "brand_reviewer" ? "brand_review" : "copy", target: options.taskId || promptFile });
    try {
      const response = await requestJson({
      apiKey,
      baseUrl,
      model,
      messages: [{ role: "system", content: promptText(promptFile) }, { role: "user", content: JSON.stringify(payload) }],
      reasoningEffort: options.reasoningEffort || "high",
      maxTokens: options.maxTokens || 12_000,
      emptyContentRetries: 1,
      signal,
      onStatus: (status) => {
        if (status?.reason === "http_429") copyTaskQueue.throttle();
        (options.onStatus || onStatus)?.(status);
      },
      });
      onCapabilityCall?.({ phase: "finished", callId, capabilityId, taskId: options.taskId || promptFile, stage: capabilityId === "brand_reviewer" ? "brand_review" : "copy", target: options.taskId || promptFile, durationMs: Date.now() - started, usage: response.usage || null, attemptCount: response.attemptUsages?.length || response.usage?.attempt_count || 1 });
      return response;
    } catch (error) {
      onCapabilityCall?.({ phase: "finished", callId, capabilityId, taskId: options.taskId || promptFile, stage: capabilityId === "brand_reviewer" ? "brand_review" : "copy", target: options.taskId || promptFile, durationMs: Date.now() - started, failed: error?.name !== "AbortError", cancelled: error?.name === "AbortError", attemptCount: error?.attemptUsages?.length || 1, reason: error?.message });
      throw error;
    }
  }, {
      taskId: options.taskId || promptFile,
      onQueueStatus: (queue) => (options.onStatus || onStatus)?.({ streamPhase: queue.state === "queued" ? "queued" : undefined, queue }),
    });
}

export async function runAgentCopyPipeline({ sourceData, businessPlan = {}, projectRoot, executionRunId, modelConfig, requestJson = requestDeepSeekJson, signal, onStage = () => {}, onCapabilityCall, hiddenModules = [] }) {
  const sourceFacts = compactForModel(sourceData);
  const requestModel = createAgentCopyModelRequester({ ...modelConfig, requestJson, signal, onCapabilityCall });
  const modular = await generateModularCopy({
    sourceFacts,
    businessPlan,
    projectRoot,
    jobId: executionRunId,
    requestModel: (promptFile, payload, options = {}) => requestModel(promptFile, payload, { ...options, reasoningEffort: "high" }),
    onStage,
    reuseCompleted: true,
    ruleCardsFor: copyUnitRuleCards,
  });
  if (modular.errors.length) {
    const failure = new Error("文案模块存在模型失败或安全回退，不能作为智能体完成结果");
    failure.code = "copy_unit_failed";
    failure.details = modular.errors;
    throw failure;
  }
  const merged = mergeRefinement(sourceData, modular.draft);
  const expensesHidden = hiddenModules.includes("expenses");
  const mergeWarnings = (merged.mergeWarnings || []).filter((item) => !(expensesHidden && /^(?:includedCustomer|excludedCustomer|cancellationCustomer|expenses)/.test(String(item.path || ""))));
  if (!merged.dailyRefinement.accepted || mergeWarnings.length) {
    const failure = new Error("文案模块结构或费用映射未通过确定性合并检查");
    failure.code = "copy_merge_failed";
    failure.details = [...(merged.dailyRefinement.errors || []), ...mergeWarnings];
    throw failure;
  }
  let currentData = applyHiddenModuleDecisions(merged.data, hiddenModules);
  const initialDeterministic = reviewCustomerContent(currentData, { sourceData });
  onStage({ phase: "brand_review", currentAction: "正在进行每份成品唯一一次品牌审查", completedUnits: 0, totalUnits: 1 });
  const reviewStarted = Date.now();
  const checkpointStore = createCopyUnitStore(projectRoot, executionRunId);
  const checkpointRuleVersion = COPY_RULE_RUNTIME[0]?.version || "copy-rules";
  const brandInput = {
    mode: "full",
    sourceFacts,
    hiddenModules,
    firstDraft: selectCustomerCopy(currentData, hiddenModules),
    deterministicIssues: initialDeterministic.issues,
    copyRules: copyUnitRuleCards("brand_review"),
  };
  const brandUnit = { id: "brand-review", type: "brand_review", ruleVersion: checkpointRuleVersion };
  const reusableBrand = checkpointStore.loadReusable(brandUnit, brandInput);
  const brandResponse = reusableBrand ? { json: reusableBrand.record.output, usage: null, model: reusableBrand.record.model, reused: true } : await requestStructuredTwice(requestModel, "customer-itinerary-brand-reviewer-v1.md", brandInput, { capabilityId: "brand_reviewer", taskId: `${executionRunId}:brand-review`, reasoningEffort: "high", maxTokens: 18_000 }, (value) => !Array.isArray(value?.reviewIssues) || !Array.isArray(value?.unresolvedIssues) ? "缺少reviewIssues或unresolvedIssues数组" : null, "品牌审查");
  checkpointStore.save(brandUnit, brandInput, { status: "complete", attempts: reusableBrand ? 0 : 1, startedAt: new Date(reviewStarted).toISOString(), completedAt: new Date().toISOString(), model: brandResponse.model, usage: brandResponse.usage, recovery: reusableBrand ? { reason: "reused_completed_brand_review" } : null, recoveredFrom: reusableBrand?.file, output: brandResponse.json });
  const brandIssues = [
    ...brandResponse.json.reviewIssues.map((item) => normalizeIssue(item)),
    ...brandResponse.json.unresolvedIssues.map((item) => normalizeIssue(item, true)),
  ];
  const allIssues = uniqueIssues([...initialDeterministic.issues.map((item) => normalizeIssue(item)), ...brandIssues]);
  const repairPlan = planCopyRepairs(allIssues);
  const targetRuns = [];
  const repairBatches = groupRepairTargets(repairPlan.targets);
  for (const batch of repairBatches) {
    if (signal?.aborted) throw new DOMException("生成已取消", "AbortError");
    const targetContexts = batch.targets.map((target) => buildCopyTargetContext(sourceFacts, selectCustomerCopy(currentData, hiddenModules), modular.mainline, target));
    onStage({ phase: "copy_target_regeneration", currentAction: `正在批量重新生成 ${batch.key} 模块`, currentUnit: batch.key, completedUnits: targetRuns.length, totalUnits: repairBatches.length });
    const started = Date.now();
    const repairInput = { batchKey: batch.key, targetContexts };
    const repairUnit = { id: `repair-${batch.key}`, type: "target_regeneration", ruleVersion: checkpointRuleVersion };
    const reusableRepair = checkpointStore.loadReusable(repairUnit, repairInput);
    const response = reusableRepair ? { json: reusableRepair.record.output, usage: null, model: reusableRepair.record.model, reused: true } : await requestStructuredTwice(requestModel, "agent-copy-target-regenerate-v1.md", repairInput, { capabilityId: "copy_writer", taskId: `${executionRunId}:repair-${batch.key}`, reasoningEffort: batch.targets.some((target) => target.firstReasoning === "high") ? "high" : "medium", maxTokens: 14_000 }, (value) => !Array.isArray(value?.patches) || !Array.isArray(value?.unresolvedIssues) ? "缺少patches或unresolvedIssues数组" : null, `${batch.key}模块批量重新生成`);
    const payload = response.json;
    const patches = payload.patches.map((item) => ({ ...item, path: normalizeCustomerCopyPath(item.path) }));
    const batchIssues = batch.targets.flatMap((target) => target.issues);
    checkpointStore.save(repairUnit, repairInput, { status: "complete", attempts: reusableRepair ? 0 : 1, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), model: response.model, usage: response.usage, recovery: reusableRepair ? { reason: "reused_completed_repair_batch" } : null, recoveredFrom: reusableRepair?.file, output: { ...payload, patches } });
    const applied = applyTargetedRevisions(currentData, { reviewIssues: batchIssues, patches });
    const factComparison = compareDeterministicFacts(sourceData, applied.data);
    if (!factComparison.preserved) throw new Error(`${batch.key} 模块重新生成改变了确定性事实`);
    const unhandled = batchIssues.filter((issue) => !patches.some((patch) => pathCovered(issue.path, patch.path)));
    const unresolvedIssues = uniqueIssues([...payload.unresolvedIssues.map((item) => normalizeIssue(item, true)), ...unhandled]);
    currentData = applied.data;
    targetRuns.push({ batchKey: batch.key, targets: batch.targets.map((target) => ({ key: target.key, path: target.path })), target: { key: `module:${batch.key}`, path: batch.key }, capabilityId: "copy_writer", attempts: reusableRepair ? 0 : 1, reused: Boolean(reusableRepair), durationMs: Date.now() - started, usage: response.usage || null, changedPaths: applied.changedPaths, unresolvedIssues });
  }
  const finalFactComparison = compareDeterministicFacts(sourceData, currentData);
  const finalDeterministic = reviewCustomerContent(currentData, { sourceData });
  const remainingIssues = uniqueIssues([
    ...repairPlan.blockers,
    ...targetRuns.flatMap((item) => item.unresolvedIssues),
    ...finalDeterministic.issues,
  ]);
  const passed = finalFactComparison.preserved && remainingIssues.length === 0;
  currentData.copySourceFacts = sourceFacts;
  currentData.copyQuality = { version: "agent-copy-v1", passed, status: passed ? "passed" : "needs_copy_revision", remainingIssueCount: remainingIssues.length, allIssues: remainingIssues, checkedAt: new Date().toISOString() };
  return {
    data: currentData,
    mainline: modular.mainline,
    contentPlacement: modular.placement,
    contentQuality: { passed, factsPreserved: finalFactComparison.preserved, initialDeterministic, brandReview: brandResponse.json, brandReviewCallCount: 1, brandReviewReused: Boolean(reusableBrand), brandReviewDurationMs: Date.now() - reviewStarted, targetRuns, repairBatchCount: repairBatches.length, repairTargetCount: repairPlan.targets.length, finalDeterministic, remainingIssues, ruleVersion: COPY_RULE_RUNTIME[0]?.version || null },
    usage: { modules: modular.usages, brandReview: brandResponse.usage || null, targetRegeneration: targetRuns.map((item) => item.usage) },
    model: brandResponse.model,
  };
}
