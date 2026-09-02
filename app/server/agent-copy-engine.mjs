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

const HARD_SEVERITIES = new Set(["fact", "safety", "structure"]);
const SOFT_ONLY_CODES = new Set(["day_overlong", "day_fact_dump", "day_thin", "day_no_value", "day_no_progression", "day_no_scene", "day_no_action_scene", "day_near_duplicate", "hotel_thin", "hotel_route_value", "hotel_scene", "hotel_facility_dump", "subtitle_generic", "subtitle_too_long", "highlight_incomplete", "notes_item_overlong"]);
const NON_REPAIRABLE_HARD_CODES = new Set(["fee_included_count_mismatch", "fee_excluded_count_mismatch", "fee_source_coverage_mismatch", "source_coverage_missing", "source_transport_coverage_missing", "transport_module_missing", "days_missing", "experience_status_missing", "deterministic_fact_changed"]);
const HARD_REASON = /事实(?:错误|冲突|无依据)|无依据(?:承诺|保证)|费用(?:错误|冲突)|履约|状态错误|内部信息|内部术语|结构缺失|无法阅读|版面溢出|安全风险|确定性事实/;

function issueRuleIds(item = {}) {
  return [...new Set([...(Array.isArray(item.ruleIds) ? item.ruleIds : []), item.ruleId].filter(Boolean))];
}

export function isHardBrandIssue(item = {}) {
  if (SOFT_ONLY_CODES.has(item.code)) return false;
  if (HARD_SEVERITIES.has(item.severity) || item.action === "block" || item.unresolved === true) return true;
  const claimedHard = ["hard", "硬问题"].includes(String(item.issueLevel || item.level || "").toLowerCase());
  return claimedHard && issueRuleIds(item).length > 0 && Boolean(item.sourceBasis || item.originalBasis) && HARD_REASON.test(`${item.message || ""} ${item.impact || ""}`);
}

const normalizeIssue = (item = {}, unresolved = false) => {
  const path = normalizeCustomerCopyPath(item.path || item.modificationScope);
  const provisional = { ...item, path, unresolved, ruleIds: issueRuleIds(item).length ? issueRuleIds(item) : ["COPY-001"], severity: item.severity || (unresolved ? "fact" : "quality"), action: item.action || item.suggestedAction || (unresolved ? "block" : "targeted_rewrite") };
  const hard = isHardBrandIssue(provisional);
  return {
    ...provisional,
    issueLevel: hard ? "hard" : "optimization",
    targetModule: item.targetModule || path.split(".")[0] || "global",
    sourceBasis: item.sourceBasis || item.originalBasis || "品牌审核判断",
    suggestedAction: item.suggestedAction || provisional.action,
    modificationScope: item.modificationScope || path,
    severity: hard ? provisional.severity : "quality",
    action: hard ? provisional.action : "suggest_only",
  };
};

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

function preservedCopyTargets(businessPlan = {}, sourceData = {}) {
  const targets = [];
  const modulePaths = { global: ["title", "subtitle", "highlights"], hotels: ["hotels"], dining: ["diningExperiences"], transport: ["transportSummary"], days: ["days"], notes: ["notes"], expenses: ["expenses"] };
  for (const module of businessPlan.modules || []) if (module.contentAction === "preserve") for (const path of modulePaths[module.moduleId] || [module.moduleId]) targets.push({ path, reason: module.reason || "规划判断直接保留", confirmedByUser: false });
  const roles = Array.isArray(businessPlan.dayRoles) ? businessPlan.dayRoles : [];
  const numeric = roles.map((item) => Number(item.index)).filter(Number.isInteger);
  const oneBased = numeric.length > 0 && !numeric.includes(0) && numeric.includes(Number(sourceData.dayCount || sourceData.days?.length || 0));
  for (const role of roles) if (role.contentAction === "preserve") {
    const index = Number(role.index) - (oneBased ? 1 : 0);
    if (Number.isInteger(index) && index >= 0) targets.push({ path: `days.${index}`, reason: role.reason || "规划判断直接保留", confirmedByUser: Boolean(role.confirmedByUser) });
  }
  for (const decision of sourceData.copyPreservationDecisions || []) if (decision?.confirmedByUser && decision.path) targets.push({ path: normalizeCustomerCopyPath(decision.path), reason: decision.reason || "用户明确确认保留", confirmedByUser: true, confirmedAt: decision.confirmedAt || null });
  return targets;
}

function issueHitsPreservedTarget(issue, preservedTargets) {
  return preservedTargets.some((target) => pathCovered(issue.path, target.path));
}

export function partitionAgentBrandIssues(issues = [], preservedTargets = []) {
  const hardIssues = [];
  const optimizationSuggestions = [];
  for (const issue of issues.map((item) => normalizeIssue(item, item.unresolved === true))) {
    if (isHardBrandIssue(issue)) hardIssues.push({ ...issue, lockOverride: issueHitsPreservedTarget(issue, preservedTargets), preservation: preservedTargets.find((target) => pathCovered(issue.path, target.path)) || null });
    else if (!issueHitsPreservedTarget(issue, preservedTargets)) optimizationSuggestions.push(issue);
  }
  return { hardIssues: uniqueIssues(hardIssues), optimizationSuggestions: uniqueIssues(optimizationSuggestions) };
}

export function planAgentHardRepairs(hardIssues = []) {
  const blockers = [];
  const repairable = [];
  for (const issue of hardIssues) {
    if (issue.unresolved || NON_REPAIRABLE_HARD_CODES.has(issue.code) || !issue.path || issue.path === "customer") blockers.push(issue);
    else repairable.push({ ...issue, severity: "quality", action: "targeted_rewrite", issueLevel: "hard" });
  }
  const planned = planCopyRepairs(repairable);
  return { blockers: uniqueIssues([...blockers, ...planned.blockers]), targets: planned.targets };
}

function brandReviewStructureError(value) {
  if (!Array.isArray(value?.reviewIssues) || !Array.isArray(value?.unresolvedIssues)) return "缺少reviewIssues或unresolvedIssues数组";
  for (const item of [...value.reviewIssues, ...value.unresolvedIssues]) {
    if (!item || typeof item !== "object" || !item.path || !item.targetModule || !item.issueLevel || !issueRuleIds(item).length || !item.sourceBasis || !item.suggestedAction || !item.modificationScope) return "审核问题缺少目标模块、问题级别、规则、原始依据、建议动作或修改范围";
  }
  if (value.unresolvedIssues.some((item) => !["hard", "硬问题"].includes(String(item.issueLevel)))) return "unresolvedIssues只能包含硬问题";
  return null;
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
  const preservedTargets = preservedCopyTargets(businessPlan, sourceData);
  const brandInput = {
    mode: "full",
    sourceFacts,
    hiddenModules,
    preservedTargets,
    firstDraft: selectCustomerCopy(currentData, hiddenModules),
    deterministicIssues: initialDeterministic.issues,
    copyRules: copyUnitRuleCards("brand_review"),
  };
  const brandUnit = { id: "brand-review", type: "brand_review", ruleVersion: checkpointRuleVersion };
  const reusableBrand = checkpointStore.loadReusable(brandUnit, brandInput);
  const brandResponse = reusableBrand ? { json: reusableBrand.record.output, usage: null, model: reusableBrand.record.model, reused: true } : await requestStructuredTwice(requestModel, "customer-itinerary-brand-reviewer-v1.md", brandInput, { capabilityId: "brand_reviewer", taskId: `${executionRunId}:brand-review`, reasoningEffort: "high", maxTokens: 18_000 }, brandReviewStructureError, "品牌审查");
  checkpointStore.save(brandUnit, brandInput, { status: "complete", attempts: reusableBrand ? 0 : 1, startedAt: new Date(reviewStarted).toISOString(), completedAt: new Date().toISOString(), model: brandResponse.model, usage: brandResponse.usage, recovery: reusableBrand ? { reason: "reused_completed_brand_review" } : null, recoveredFrom: reusableBrand?.file, output: brandResponse.json });
  const brandIssues = [
    ...brandResponse.json.reviewIssues.map((item) => normalizeIssue(item)),
    ...brandResponse.json.unresolvedIssues.map((item) => normalizeIssue(item, true)),
  ];
  const initialPartition = partitionAgentBrandIssues(initialDeterministic.issues, preservedTargets);
  const brandPartition = partitionAgentBrandIssues(brandIssues, preservedTargets);
  const repairPlan = planAgentHardRepairs(uniqueIssues([...initialPartition.hardIssues, ...brandPartition.hardIssues]));
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
  const finalPartition = partitionAgentBrandIssues(finalDeterministic.issues, preservedTargets);
  const remainingIssues = uniqueIssues([
    ...repairPlan.blockers,
    ...targetRuns.flatMap((item) => item.unresolvedIssues),
    ...finalPartition.hardIssues,
  ]);
  const optimizationSuggestions = uniqueIssues([...initialPartition.optimizationSuggestions, ...brandPartition.optimizationSuggestions, ...finalPartition.optimizationSuggestions]);
  const passed = finalFactComparison.preserved && remainingIssues.length === 0;
  currentData.copySourceFacts = sourceFacts;
  currentData.copyQuality = { version: "agent-copy-v2-hard-vs-suggestion", passed, status: passed ? optimizationSuggestions.length ? "passed_with_suggestions" : "passed" : "blocked_generation", hardIssueCount: remainingIssues.length, suggestionCount: optimizationSuggestions.length, remainingIssueCount: remainingIssues.length, allIssues: remainingIssues, optimizationSuggestions, checkedAt: new Date().toISOString() };
  return {
    data: currentData,
    mainline: modular.mainline,
    contentPlacement: modular.placement,
    contentQuality: { passed, factsPreserved: finalFactComparison.preserved, preservedTargets, initialDeterministic, brandReview: brandResponse.json, brandReviewCallCount: 1, brandReviewReused: Boolean(reusableBrand), brandReviewDurationMs: Date.now() - reviewStarted, targetRuns, repairBatchCount: repairBatches.length, repairTargetCount: repairPlan.targets.length, finalDeterministic, remainingIssues, optimizationSuggestions, ruleVersion: COPY_RULE_RUNTIME[0]?.version || null },
    usage: { modules: modular.usages, brandReview: brandResponse.usage || null, targetRegeneration: targetRuns.map((item) => item.usage) },
    model: brandResponse.model,
  };
}
