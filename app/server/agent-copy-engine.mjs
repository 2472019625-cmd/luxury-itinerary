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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptCache = new Map();
const promptText = (file) => {
  if (!/^[a-z0-9-]+\.md$/i.test(file)) throw new Error("文案提示词文件名非法");
  if (!promptCache.has(file)) promptCache.set(file, readFileSync(path.join(appRoot, "prompts", file), "utf8"));
  return promptCache.get(file);
};

const normalizeIssue = (item = {}, unresolved = false) => ({
  ...item,
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

function selectCustomerCopy(data = {}) {
  return {
    title: data.title,
    subtitle: data.subtitle,
    highlights: data.highlights,
    hotels: data.hotels,
    diningExperiences: data.diningExperiences,
    transportSummary: data.transportSummary,
    days: data.days,
    notes: data.notes,
    includedCustomer: data.includedCustomer,
    excludedCustomer: data.excludedCustomer,
    cancellationCustomer: data.cancellationCustomer,
  };
}

function pathCovered(issuePath, patchPath) {
  const left = String(issuePath || "");
  const right = String(patchPath || "");
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`) || (left === "expenses" && /^(includedCustomer|excludedCustomer|cancellationCustomer)/.test(right));
}

export function createAgentCopyModelRequester({ apiKey, baseUrl, model, requestJson = requestDeepSeekJson, signal, onStatus }) {
  return async (promptFile, payload, options = {}) => requestJson({
    apiKey,
    baseUrl,
    model,
    messages: [{ role: "system", content: promptText(promptFile) }, { role: "user", content: JSON.stringify(payload) }],
    reasoningEffort: options.reasoningEffort || "high",
    maxTokens: options.maxTokens || 12_000,
    emptyContentRetries: 1,
    signal,
    onStatus: options.onStatus || onStatus,
  });
}

export async function runAgentCopyPipeline({ sourceData, projectRoot, executionRunId, modelConfig, requestJson = requestDeepSeekJson, signal, onStage = () => {} }) {
  const sourceFacts = compactForModel(sourceData);
  const requestModel = createAgentCopyModelRequester({ ...modelConfig, requestJson, signal });
  const modular = await generateModularCopy({
    sourceFacts,
    projectRoot,
    jobId: executionRunId,
    requestModel: (promptFile, payload, options = {}) => requestModel(promptFile, payload, { ...options, reasoningEffort: "high" }),
    onStage,
    reuseCompleted: false,
    ruleCardsFor: copyUnitRuleCards,
  });
  if (modular.errors.length) {
    const failure = new Error("文案模块存在模型失败或安全回退，不能作为智能体完成结果");
    failure.code = "copy_unit_failed";
    failure.details = modular.errors;
    throw failure;
  }
  const merged = mergeRefinement(sourceData, modular.draft);
  if (!merged.dailyRefinement.accepted || merged.mergeWarnings?.length) {
    const failure = new Error("文案模块结构或费用映射未通过确定性合并检查");
    failure.code = "copy_merge_failed";
    failure.details = [...(merged.dailyRefinement.errors || []), ...(merged.mergeWarnings || [])];
    throw failure;
  }
  let currentData = merged.data;
  const initialDeterministic = reviewCustomerContent(currentData, { sourceData });
  onStage({ phase: "brand_review", currentAction: "正在进行每份成品唯一一次品牌审查", completedUnits: 0, totalUnits: 1 });
  const reviewStarted = Date.now();
  const brandResponse = await requestModel("customer-itinerary-brand-reviewer-v1.md", {
    mode: "full",
    sourceFacts,
    firstDraft: selectCustomerCopy(currentData),
    deterministicIssues: initialDeterministic.issues,
    copyRules: copyUnitRuleCards("brand_review"),
  }, { reasoningEffort: "high", maxTokens: 18_000 });
  if (!Array.isArray(brandResponse.json?.reviewIssues) || !Array.isArray(brandResponse.json?.unresolvedIssues)) throw new Error("品牌审查返回结构无效");
  const brandIssues = [
    ...brandResponse.json.reviewIssues.map((item) => normalizeIssue(item)),
    ...brandResponse.json.unresolvedIssues.map((item) => normalizeIssue(item, true)),
  ];
  const allIssues = uniqueIssues([...initialDeterministic.issues.map((item) => normalizeIssue(item)), ...brandIssues]);
  const repairPlan = planCopyRepairs(allIssues);
  const targetRuns = [];
  for (const target of repairPlan.targets) {
    if (signal?.aborted) throw new DOMException("生成已取消", "AbortError");
    const targetContext = buildCopyTargetContext(sourceFacts, selectCustomerCopy(currentData), modular.mainline, target);
    onStage({ phase: "copy_target_regeneration", currentAction: `正在重新生成 ${target.key}`, currentUnit: target.key, completedUnits: targetRuns.length, totalUnits: repairPlan.targets.length });
    const started = Date.now();
    const response = await requestModel("agent-copy-target-regenerate-v1.md", { targetContext }, { reasoningEffort: target.firstReasoning === "high" ? "high" : "medium", maxTokens: 9_000 });
    const payload = response.json;
    if (!Array.isArray(payload?.patches) || !Array.isArray(payload?.unresolvedIssues)) throw new Error(`目标 ${target.key} 重新生成结构无效`);
    const applied = applyTargetedRevisions(currentData, { reviewIssues: target.issues, patches: payload.patches });
    const factComparison = compareDeterministicFacts(sourceData, applied.data);
    if (!factComparison.preserved) throw new Error(`目标 ${target.key} 重新生成改变了确定性事实`);
    const unhandled = target.issues.filter((issue) => !payload.patches.some((patch) => pathCovered(issue.path, patch.path)));
    const unresolvedIssues = uniqueIssues([...payload.unresolvedIssues.map((item) => normalizeIssue(item, true)), ...unhandled]);
    currentData = applied.data;
    targetRuns.push({ target: { key: target.key, path: target.path }, capabilityId: "copy_writer", attempts: 1, durationMs: Date.now() - started, usage: response.usage || null, changedPaths: applied.changedPaths, unresolvedIssues });
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
    contentQuality: { passed, factsPreserved: finalFactComparison.preserved, initialDeterministic, brandReview: brandResponse.json, brandReviewCallCount: 1, brandReviewDurationMs: Date.now() - reviewStarted, targetRuns, finalDeterministic, remainingIssues, ruleVersion: COPY_RULE_RUNTIME[0]?.version || null },
    usage: { modules: modular.usages, brandReview: brandResponse.usage || null, targetRegeneration: targetRuns.map((item) => item.usage) },
    model: brandResponse.model,
  };
}
