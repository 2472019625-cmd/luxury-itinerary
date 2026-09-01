import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { resolveItineraryImages } from "./image-pipeline.mjs";
import { planImageBlueprint } from "./image-blueprint.mjs";
import { selectCustomerRenderData } from "./customer-render-data.mjs";
import { reviewFinalLayout } from "./final-layout-review.mjs";
import { applyTargetedRevisions, compactForModel, compareDeterministicFacts, mergeRefinement } from "./itinerary-refinement.mjs";
import { normalizeItineraryFacts, validateItineraryFacts } from "../src/lib/itineraryRules.js";
import { reviewCustomerContent } from './content-quality.mjs';
import { COPY_RULE_RUNTIME, COPY_RULE_VERSION } from '../config/copy-rule-runtime.mjs';
import { reviewFinalOutputData } from './final-output-qa.mjs';
import { generationCompletionGate, monotonicProgress } from './workflow-state.mjs';
import { requestDeepSeekJson } from './deepseek-client.mjs';
import { copyTaskQueue } from './copy-task-queue.mjs';
import { generateModularCopy } from './modular-copy-generator.mjs';
import { mergeParallelImageResult } from './image-copy-consistency.mjs';
import { activeGenerationByFingerprint, generationFingerprint } from './generation-dedup.mjs';
import { modelTaskProfile } from '../config/model-task-routing.mjs';
import { buildCopyTargetContext, composeCurrentFinalIssues, finalControlledRepairDecision, isBlockingCopyIssue, isRepairableGeneratedFactIssue, issuesForTarget, mergeTargetRepairIssues, planCopyRepairs, targetScopeFromPath } from './copy-repair.mjs';
import { applySafeCopyCorrections } from './fact-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(root, "..");

function loadEnvFile(name) {
  const file = path.join(root, name);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env.image-search.local");

const clientDir = path.join(root, "dist", "client");
const outputDir = path.join(root, "output", "generated");
const imageAssetDir = path.join(root, "output", "image-assets");
const imageLedgerDir = path.join(root, "output", "image-ledgers");
const imageBlueprintDir = path.join(root, "output", "image-blueprints");
const userImageDir = path.join(imageAssetDir, "user");
const jobDir = path.join(root, ".jobs");
const port = Number(process.env.LUXURY_TRAVEL_PORT || 4173);
const jobs = new Map();
const sensitive = /成本|利润|毛利|供应商底价|采购价|结算价|内部报价|基本房型报价|报价测算逻辑|按\s*\d+\s*人.*?(?:车|房).*?测算/i;
const sensitiveKey = /cost|profit|margin|supplierPrice|purchasePrice|internal|formula|底价|成本|利润|内部|供应商/i;
const bigModelKey = process.env.BIGMODEL_API_KEY;
const bigModelName = process.env.BIGMODEL_MODEL || "glm-5.3-flash";
const bigModelBaseUrl = (process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");
const textModelKey = process.env.TEXT_MODEL_API_KEY;
const textModelName = process.env.TEXT_MODEL_NAME || "deepseek-v4-flash";
const textModelBaseUrl = (process.env.TEXT_MODEL_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const imageSearchKey = process.env.IMAGE_SEARCH_API_KEY;
const imageSearchBaseUrl = (process.env.IMAGE_SEARCH_BASE_URL || "https://api.vveai.com/v1").replace(/\/$/, "");
const imageSearchModel = process.env.IMAGE_SEARCH_MODEL || "gemini-3.6-flash-search";

mkdirSync(outputDir, { recursive: true });
mkdirSync(imageAssetDir, { recursive: true });
mkdirSync(imageLedgerDir, { recursive: true });
mkdirSync(imageBlueprintDir, { recursive: true });
mkdirSync(userImageDir, { recursive: true });
mkdirSync(jobDir, { recursive: true });
for (const name of readdirSync(jobDir)) {
  if (name.endsWith('.json') && !name.includes('/') && !name.includes('\\')) unlinkSync(path.join(jobDir, name));
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function safeCustomerData(value) {
  if (Array.isArray(value)) return value.map(safeCustomerData).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveKey.test(key)).map(([key, item]) => [key, safeCustomerData(item)]).filter(([, item]) => item !== undefined));
  }
  if (typeof value === "string" && sensitive.test(value)) return undefined;
  return value;
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new Error("提交内容超过24MB，请减少内嵌图片后重试");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function requestBuffer(request, maxBytes = 20 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw new Error("图片文件超过20MB"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function requestCopyModel(promptFile, userPayload, maxTokens = 24000, reasoningEffort = "high", options = {}) {
  const systemPrompt = readFileSync(path.join(root, 'prompts', promptFile), 'utf8');
  const profile = options.taskKind ? modelTaskProfile(options.taskKind) : { taskKind: 'legacy', reasoningEffort, thinkingType: 'enabled' };
  return copyTaskQueue.add(() => requestDeepSeekJson({
      apiKey: textModelKey,
      baseUrl: textModelBaseUrl,
      model: textModelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      reasoningEffort: profile.reasoningEffort,
      thinkingType: profile.thinkingType,
      maxTokens,
      onStatus: (status) => {
        if (status?.reason === 'http_429') copyTaskQueue.throttle();
        options.onStatus?.(status);
      },
    }), {
      taskId: options.taskId || promptFile,
      onQueueStatus: (queue) => options.onStatus?.({ streamPhase: queue.state === 'queued' ? 'queued' : undefined, queue }),
    });
}

function deterministicCopySnapshot(data = {}) {
  return JSON.stringify({
    startDate: data.startDate, endDate: data.endDate, dayCount: data.dayCount, adults: data.adults, children: data.children, travelers: data.travelers,
    included: data.included, excluded: data.excluded, cancellation: data.cancellation, totalPrice: data.totalPrice, priceUnit: data.priceUnit,
    hotels: (data.hotels || []).map(({ id, officialName, shortName, region, nights, roomType, mealPlan, status, confirmationStatus, referenceOnly, replacementPolicy }) => ({ id, officialName, shortName, region, nights, roomType, mealPlan, status, confirmationStatus, referenceOnly, replacementPolicy })),
    transportSummary: (data.transportSummary || []).map(({ id, category, serviceLevel, seatCount, model, modelGuaranteed, usageSegments }) => ({ id, category, serviceLevel, seatCount, model, modelGuaranteed, usageSegments })),
    days: (data.days || []).map((day) => ({ date: day.date, routeNodes: day.routeNodes, mealPlan: day.mealPlan, hotel: day.hotel, vehicle: day.vehicle, estimatedTravelTime: day.estimatedTravelTime, activityLevel: day.activityLevel, restStops: day.restStops, overnightType: day.overnightType, spots: (day.spots || []).map(({ id, status, statusLabel, feeBoundary, sourceEvidence }) => ({ id, status, statusLabel, feeBoundary, sourceEvidence })) })),
  });
}

function copyQualityError(message, contentQuality) {
  const error = new Error(message);
  error.contentQuality = contentQuality;
  return error;
}

function uniqueCopyIssues(issues = []) {
  const unique = new Map();
  for (const issue of issues.filter(Boolean)) {
    const key = `${issue.ruleId || issue.ruleIds?.join(',') || 'COPY'}:${issue.path || 'customer'}:${issue.message || ''}`;
    if (!unique.has(key)) unique.set(key, issue);
  }
  return [...unique.values()];
}

function normalizeCopyIssue(item = {}, unresolved = false) {
  const normalized = {
    ...item,
    ruleIds: item.ruleIds || (item.ruleId ? [item.ruleId] : ['COPY-001']),
    severity: item.severity || (unresolved ? 'fact' : 'quality'),
    action: item.action || (unresolved ? 'block' : 'targeted_rewrite'),
  };
  if (isRepairableGeneratedFactIssue(normalized)) return { ...normalized, action: 'safe_fact_fallback', repairable: true };
  return normalized;
}

function pathsOverlap(left = '', right = '') {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function originalDeterministicBaseline(data = {}) {
  if (!data.copySourceFacts) return data;
  return { ...data.copySourceFacts, sourceImportCoverage: data.sourceImportCoverage };
}

async function runTargetedCopyRepairBatch({ currentData, sourceData, deterministicBaseline = sourceData, sourceFacts, mainline = {}, issues = [], jobId, batchName, onStage = () => {} }) {
  const initialIssues = uniqueCopyIssues(issues.map((item) => normalizeCopyIssue(item)));
  const initialPlan = planCopyRepairs(initialIssues);
  const scopePaths = initialPlan.targets.map((target) => target.path);
  const safeStart = applySafeCopyCorrections(currentData, sourceData, { paths: scopePaths });
  const correctedPaths = safeStart.corrections.map((item) => item.path);
  const currentIssues = initialIssues.filter((issue) => !correctedPaths.some((path) => pathsOverlap(path, issue.path)));
  const repairPlan = planCopyRepairs(currentIssues);
  const usages = [];
  const targetRuns = await Promise.all(repairPlan.targets.map(async (target, targetIndex) => {
    let targetData = safeStart.data;
    let remaining = target.issues;
    const acceptedPatches = [];
    const changedPaths = [];
    const attempts = [];
    const reasoningOrder = target.firstReasoning === 'high' ? ['high'] : ['low', 'high'];
    for (const reasoning of reasoningOrder) {
      const started = Date.now();
      const taskKind = reasoning === 'high' ? 'targetedPatchHigh' : 'targetedPatch';
      const targetContext = buildCopyTargetContext(sourceFacts, selectCustomerRenderData(targetData), mainline, { ...target, issues: remaining });
      onStage({ phase: 'brand_review', currentAction: `正在修订 ${target.key}（${reasoning === 'high' ? '高推理' : '低推理'}）`, currentUnit: `${batchName}-${target.key}`, completedUnits: targetIndex, totalUnits: repairPlan.targets.length });
      let response;
      try {
        response = await requestCopyModel('customer-itinerary-target-patch-v1.md', { targetContext }, reasoning === 'high' ? 9000 : 6000, reasoning, { taskKind, taskId: `${jobId}:${batchName}:${target.key}:${reasoning}`, onStatus: (stream) => onStage({ phase: 'brand_review', currentAction: `正在修订 ${target.key}`, currentUnit: `${batchName}-${target.key}`, completedUnits: targetIndex, totalUnits: repairPlan.targets.length, stream }) });
        usages.push({ taskKind, target: target.key, usage: response.usage, attemptUsages: response.attemptUsages || [], requestProfile: response.requestProfile });
      } catch (error) {
        attempts.push({ reasoning, status: 'request_failed', durationMs: Date.now() - started, error: error?.message || String(error), ruleIds: target.ruleIds, ruleVersion: target.ruleVersion });
        remaining = target.issues.map((issue) => ({ ...issue, message: `局部修复调用失败：${error?.message || String(error)}` }));
        continue;
      }
      const payload = response.json && Array.isArray(response.json.patches) && Array.isArray(response.json.unresolvedIssues) ? response.json : { patches: [], unresolvedIssues: [{ ruleId: target.ruleIds[0] || 'COPY-001', path: target.path, message: '局部补丁返回结构无效' }] };
      const rejectedPatches = [];
      for (const candidate of payload.patches) {
        try {
          const applied = applyTargetedRevisions(targetData, { reviewIssues: target.issues, patches: [candidate] });
          const comparison = compareDeterministicFacts(deterministicBaseline, applied.data);
          if (!comparison.preserved) throw new Error('补丁改变了原始确定性事实');
          targetData = applied.data;
          acceptedPatches.push(candidate);
          changedPaths.push(...applied.changedPaths);
        } catch (error) {
          rejectedPatches.push({ ruleId: target.ruleIds[0] || 'COPY-001', path: candidate?.path || target.path, message: `补丁被拒绝：${error.message}`, severity: /事实/.test(error.message) ? 'fact' : 'quality', action: /事实/.test(error.message) ? 'block' : 'targeted_rewrite' });
        }
      }
      const deterministicTargetIssues = issuesForTarget(reviewCustomerContent(targetData, { sourceData }).issues, target);
      let targetReviewIssues = [];
      let targetReviewUnresolved = [];
      try {
        const recheckContext = buildCopyTargetContext(sourceFacts, selectCustomerRenderData(targetData), mainline, { ...target, issues: [...deterministicTargetIssues, ...payload.unresolvedIssues, ...rejectedPatches] });
        const recheckTaskKind = reasoning === 'high' ? 'targetRecheck' : 'targetRecheckLow';
        const recheck = await requestCopyModel('customer-itinerary-brand-reviewer-v1.md', { mode: 'target_recheck', sourceFacts: recheckContext.sourceTarget, firstDraft: recheckContext.currentTarget, deterministicIssues: deterministicTargetIssues, targetContext: recheckContext, copyRules: target.ruleCards }, 6000, reasoning, { taskKind: recheckTaskKind, taskId: `${jobId}:${batchName}-recheck:${target.key}:${reasoning}` });
        if (!recheck.json || !Array.isArray(recheck.json.reviewIssues) || !Array.isArray(recheck.json.unresolvedIssues)) throw new Error('目标复检返回结构无效');
        targetReviewIssues = recheck.json.reviewIssues.map((item) => normalizeCopyIssue(item));
        targetReviewUnresolved = recheck.json.unresolvedIssues.map((item) => normalizeCopyIssue(item, true));
        usages.push({ taskKind: recheckTaskKind, target: target.key, usage: recheck.usage, attemptUsages: recheck.attemptUsages || [], requestProfile: recheck.requestProfile });
      } catch (error) {
        targetReviewIssues = [{ ruleIds: target.ruleIds, ruleId: target.ruleIds[0], path: target.path, message: `目标规则复检失败：${error?.message || String(error)}`, severity: 'quality', action: 'manual_revision' }];
      }
      remaining = uniqueCopyIssues([...deterministicTargetIssues, ...targetReviewIssues, ...targetReviewUnresolved, ...rejectedPatches]);
      attempts.push({ reasoning, status: remaining.length ? 'still_failed' : 'passed', durationMs: Date.now() - started, ruleIds: target.ruleIds, ruleVersion: target.ruleVersion, changedPaths: [...new Set(changedPaths)], remainingIssues: remaining });
      if (!remaining.length) break;
    }
    return { target: { key: target.key, kind: target.kind, index: target.index, path: target.path }, ruleIds: target.ruleIds, ruleVersion: target.ruleVersion, acceptedPatches, changedPaths: [...new Set(changedPaths)], attempts, remainingIssues: remaining };
  }));

  let revisedData = safeStart.data;
  const changedPaths = [];
  const mergeRejected = [];
  for (const run of targetRuns) for (const candidate of run.acceptedPatches) {
    try {
      const target = repairPlan.targets.find((item) => item.key === run.target.key);
      const applied = applyTargetedRevisions(revisedData, { reviewIssues: target.issues, patches: [candidate] });
      const comparison = compareDeterministicFacts(deterministicBaseline, applied.data);
      if (!comparison.preserved) throw new Error('补丁改变了原始确定性事实');
      revisedData = applied.data;
      changedPaths.push(...applied.changedPaths);
    } catch (error) {
      mergeRejected.push({ ruleId: run.ruleIds[0], path: candidate?.path || run.target.path, message: `最终合并拒绝：${error.message}`, severity: /事实/.test(error.message) ? 'fact' : 'quality', action: /事实/.test(error.message) ? 'block' : 'manual_revision' });
    }
  }
  const safeEnd = applySafeCopyCorrections(revisedData, sourceData, { paths: scopePaths });
  return { data: safeEnd.data, blockers: repairPlan.blockers, targetRuns, usages, changedPaths: [...new Set(changedPaths)], mergeRejected, safeCorrections: [...safeStart.corrections, ...safeEnd.corrections], factProvenance: safeEnd.provenance };
}

async function recheckCopyWithBrand(data = {}, jobId = `copy-recheck-${randomUUID()}`) {
  const sourceData = data.copySourceFacts || data;
  const deterministicBaseline = originalDeterministicBaseline(data);
  const safePass = applySafeCopyCorrections(data, sourceData);
  const deterministic = reviewCustomerContent(safePass.data, { sourceData });
  let brandReview = { reviewIssues: [], unresolvedIssues: [] };
  let usage = null;
  try {
    const response = await requestCopyModel('customer-itinerary-brand-reviewer-v1.md', {
      mode: 'final_full', sourceFacts: sourceData, firstDraft: selectCustomerRenderData(safePass.data), deterministicIssues: deterministic.issues,
      copyRules: COPY_RULE_RUNTIME,
    }, 18000, 'high', { taskKind: 'brandReview', taskId: `${jobId}:brand-recheck` });
    if (!response.json || !Array.isArray(response.json.reviewIssues) || !Array.isArray(response.json.unresolvedIssues)) throw new Error('品牌复检返回结构无效');
    brandReview = {
      reviewIssues: response.json.reviewIssues.map((item) => normalizeCopyIssue(item)),
      unresolvedIssues: response.json.unresolvedIssues.map((item) => normalizeCopyIssue(item, true)),
    };
    usage = { usage: response.usage, attemptUsages: response.attemptUsages || [], requestProfile: response.requestProfile };
  } catch (error) {
    brandReview = { reviewIssues: [{ ruleId: 'COPY-001', ruleIds: ['COPY-001'], path: 'customer', message: `品牌复检失败：${error?.message || String(error)}`, severity: 'quality', action: 'manual_revision' }], unresolvedIssues: [] };
  }
  const factComparison = compareDeterministicFacts(deterministicBaseline, safePass.data);
  const issues = uniqueCopyIssues([...deterministic.issues, ...brandReview.reviewIssues, ...brandReview.unresolvedIssues]);
  if (!factComparison.preserved) issues.push({ ruleId: 'COPY-015', ruleIds: ['COPY-011','COPY-014','COPY-015'], path: 'customer', message: '修订结果改变了原始确定性事实', severity: 'fact', action: 'block' });
  const hardIssues = issues.filter((item) => isBlockingCopyIssue(item));
  const passed = factComparison.preserved && issues.length === 0;
  const status = passed ? 'passed' : hardIssues.length ? 'blocked_generation' : 'needs_copy_revision';
  const contentQuality = {
    ...(data.copyQuality || {}), version: '5.1', ruleVersion: COPY_RULE_VERSION, checkedAt: new Date().toISOString(),
    passed, status, needsReview: !passed && !hardIssues.length, blocked: hardIssues.length > 0,
    hardIssueCount: hardIssues.length, remainingIssueCount: issues.length, allIssues: issues,
    safeCorrections: safePass.corrections, factProvenance: safePass.provenance, factComparison, finalReview: deterministic, brandRecheck: brandReview, usage,
  };
  return { data: { ...safePass.data, copyQuality: { version: '5.1', ruleVersion: COPY_RULE_VERSION, passed, status, needsReview: contentQuality.needsReview, blocked: contentQuality.blocked, hardIssueCount: hardIssues.length, remainingIssueCount: issues.length, allIssues: issues, checkedAt: contentQuality.checkedAt } }, contentQuality };
}

async function refineWithTextModel(data, context = {}, onStage = () => {}, jobId = `direct-${randomUUID()}`, options = {}) {
  const sourceFacts = compactForModel(data, context);
  const modular = await generateModularCopy({
    sourceFacts,
    projectRoot,
    jobId,
    requestModel: (promptFile, payload, options = {}) => requestCopyModel(promptFile, payload, options.maxTokens || 12000, 'high', options),
    onStage,
    onMainlineReady: options.onMainlineReady,
    reuseCompleted: options.reuseCompleted !== false,
  });
  const firstMerged = mergeRefinement(data, modular.draft);
  const safeFirstPass = applySafeCopyCorrections(firstMerged.data, data);
  const firstDraft = selectCustomerRenderData(safeFirstPass.data);
  const reviewedFirstDraft = reviewCustomerContent(safeFirstPass.data, { sourceData: data });
  const structuralIssues = [
    ...modular.errors.map((item) => ({ ruleIds: item.ruleIds, code: 'copy_unit_safe_fallback', path: item.dayIndexes?.length ? `days.${item.dayIndexes[0]}` : item.unitId, message: item.message, action: 'targeted_rewrite', severity: 'quality' })),
    ...(!firstMerged.dailyRefinement.accepted ? [{ ruleIds: ['COPY-010'], code: 'daily_copy_safe_fallback', path: 'days', message: `逐日文案结构无效，已保留原始DAY并继续图片流程：${firstMerged.dailyRefinement.errors.join('；') || '模型没有返回完整days数组'}`, action: 'targeted_rewrite', severity: 'quality' }] : []),
    ...(firstMerged.mergeWarnings || []),
  ];
  const initialReview = structuralIssues.length ? {
    ...reviewedFirstDraft,
    passed: false,
    issues: [...structuralIssues, ...reviewedFirstDraft.issues],
  } : reviewedFirstDraft;
  const reviewUsages = [];
  let brandReview = { reviewIssues: [], unresolvedIssues: [] };
  let brandReviewProfile = modelTaskProfile('brandReview');
  onStage({ phase: 'brand_review', currentAction: `正在进行每份成品必经的独立品牌审查`, currentUnit: 'brand-review-full', completedUnits: 0, totalUnits: 1 });
  try {
    const editor = await requestCopyModel('customer-itinerary-brand-reviewer-v1.md', {
      mode: 'full', sourceFacts, firstDraft, deterministicIssues: initialReview.issues,
      copyRules: COPY_RULE_RUNTIME,
    }, 18000, 'high', { taskKind: 'brandReview', taskId: `${jobId}:brand-review-full`, onStatus: (stream) => onStage({ phase: 'brand_review', currentAction: '正在进行独立品牌审查', currentUnit: 'brand-review-full', completedUnits: 0, totalUnits: 1, stream }) });
    if (!editor.json || !Array.isArray(editor.json.reviewIssues) || !Array.isArray(editor.json.unresolvedIssues)) throw new Error('品牌编辑返回结构无效');
    brandReview = editor.json;
    brandReviewProfile = editor.requestProfile;
    reviewUsages.push({ taskKind: 'brandReview', usage: editor.usage, attemptUsages: editor.attemptUsages || [], requestProfile: editor.requestProfile });
  } catch (error) {
    brandReview = { reviewIssues: [], unresolvedIssues: [{ ruleId: 'COPY-001', path: 'customer', message: `独立品牌审查失败：${error?.message || String(error)}`, severity: 'quality', action: 'manual_revision' }] };
  }

  const authoritativeIssues = uniqueCopyIssues([
    ...initialReview.issues.map((item) => normalizeCopyIssue(item)),
    ...brandReview.reviewIssues.map((item) => normalizeCopyIssue(item)),
    ...brandReview.unresolvedIssues.map((item) => normalizeCopyIssue(item, true)),
  ]);
  const repairPlan = planCopyRepairs(authoritativeIssues);
  const targetRuns = await Promise.all(repairPlan.targets.map(async (target, targetIndex) => {
    let targetData = safeFirstPass.data;
    let remaining = target.issues;
    const acceptedPatches = [];
    const changedPaths = [];
    const attempts = [];
    const reasoningOrder = target.firstReasoning === 'high' ? ['high'] : ['low','high'];
    for (const reasoning of reasoningOrder) {
      const started = Date.now();
      const taskKind = reasoning === 'high' ? 'targetedPatchHigh' : 'targetedPatch';
      const targetContext = buildCopyTargetContext(sourceFacts, selectCustomerRenderData(targetData), modular.mainline, { ...target, issues: remaining });
      onStage({ phase: 'brand_review', currentAction: `正在修订 ${target.key}（${reasoning === 'high' ? '高推理' : '低推理'}）`, currentUnit: `repair-${target.key}`, completedUnits: targetIndex, totalUnits: repairPlan.targets.length });
      let response;
      try {
        response = await requestCopyModel('customer-itinerary-target-patch-v1.md', { targetContext }, reasoning === 'high' ? 9000 : 6000, reasoning, { taskKind, taskId: `${jobId}:repair:${target.key}:${reasoning}`, onStatus: (stream) => onStage({ phase: 'brand_review', currentAction: `正在修订 ${target.key}`, currentUnit: `repair-${target.key}`, completedUnits: targetIndex, totalUnits: repairPlan.targets.length, stream }) });
        reviewUsages.push({ taskKind, target: target.key, usage: response.usage, attemptUsages: response.attemptUsages || [], requestProfile: response.requestProfile });
      } catch (error) {
        attempts.push({ reasoning, status: 'request_failed', durationMs: Date.now() - started, error: error?.message || String(error), ruleIds: target.ruleIds, ruleVersion: target.ruleVersion });
        remaining = target.issues.map((issue) => ({ ...issue, message: `局部修复调用失败：${error?.message || String(error)}` }));
        continue;
      }
      const payload = response.json && Array.isArray(response.json.patches) && Array.isArray(response.json.unresolvedIssues) ? response.json : { patches: [], unresolvedIssues: [{ ruleId: target.ruleIds[0] || 'COPY-001', path: target.path, message: '局部补丁返回结构无效' }] };
      const rejectedPatches = [];
      for (const candidate of payload.patches) {
        try {
          const applied = applyTargetedRevisions(targetData, { reviewIssues: target.issues, patches: [candidate] });
          const comparison = compareDeterministicFacts(data, applied.data);
          if (!comparison.preserved) throw new Error('补丁改变了原始确定性事实');
          targetData = applied.data;
          acceptedPatches.push(candidate);
          changedPaths.push(...applied.changedPaths);
        } catch (error) { rejectedPatches.push({ ruleId: target.ruleIds[0] || 'COPY-001', path: candidate?.path || target.path, message: `补丁被拒绝：${error.message}`, severity: /事实/.test(error.message) ? 'fact' : 'quality', action: /事实/.test(error.message) ? 'block' : 'targeted_rewrite' }); }
      }
      const deterministicTargetIssues = issuesForTarget(reviewCustomerContent(targetData, { sourceData: data }).issues, target);
      let targetReviewIssues = [];
      let targetReviewUnresolved = [];
      try {
        const recheckContext = buildCopyTargetContext(sourceFacts, selectCustomerRenderData(targetData), modular.mainline, { ...target, issues: [...deterministicTargetIssues, ...payload.unresolvedIssues, ...rejectedPatches] });
        const recheck = await requestCopyModel('customer-itinerary-brand-reviewer-v1.md', { mode: 'target_recheck', sourceFacts: recheckContext.sourceTarget, firstDraft: recheckContext.currentTarget, deterministicIssues: deterministicTargetIssues, targetContext: recheckContext, copyRules: target.ruleCards }, 6000, 'high', { taskKind: 'targetRecheck', taskId: `${jobId}:recheck:${target.key}:${reasoning}` });
        if (!recheck.json || !Array.isArray(recheck.json.reviewIssues) || !Array.isArray(recheck.json.unresolvedIssues)) throw new Error('目标复检返回结构无效');
        targetReviewIssues = recheck.json.reviewIssues.map((item) => normalizeCopyIssue(item));
        targetReviewUnresolved = recheck.json.unresolvedIssues.map((item) => normalizeCopyIssue(item, true));
        reviewUsages.push({ taskKind: 'targetRecheck', target: target.key, usage: recheck.usage, attemptUsages: recheck.attemptUsages || [], requestProfile: recheck.requestProfile });
      } catch (error) {
        targetReviewIssues = [{ ruleIds: target.ruleIds, ruleId: target.ruleIds[0], path: target.path, message: `目标规则复检失败：${error?.message || String(error)}`, severity: 'quality', action: 'manual_revision' }];
      }
      remaining = uniqueCopyIssues([...deterministicTargetIssues, ...targetReviewIssues, ...targetReviewUnresolved, ...rejectedPatches]);
      attempts.push({ reasoning, status: remaining.length ? 'still_failed' : 'passed', durationMs: Date.now() - started, ruleIds: target.ruleIds, ruleVersion: target.ruleVersion, changedPaths: [...new Set(changedPaths)], remainingIssues: remaining });
      if (!remaining.length) break;
    }
    return { target: { key: target.key, kind: target.kind, index: target.index, path: target.path }, ruleIds: target.ruleIds, ruleVersion: target.ruleVersion, firstReasoning: target.firstReasoning, acceptedPatches, changedPaths: [...new Set(changedPaths)], attempts, remainingIssues: remaining };
  }));

  let revisedData = safeFirstPass.data;
  const allChangedPaths = [];
  const mergeRejected = [];
  for (const run of targetRuns) for (const candidate of run.acceptedPatches) {
    try {
      const target = repairPlan.targets.find((item) => item.key === run.target.key);
      const applied = applyTargetedRevisions(revisedData, { reviewIssues: target.issues, patches: [candidate] });
      revisedData = applied.data;
      allChangedPaths.push(...applied.changedPaths);
    } catch (error) { mergeRejected.push({ ruleId: run.ruleIds[0], path: candidate?.path || run.target.path, message: `最终合并拒绝：${error.message}`, severity: 'quality', action: 'manual_revision' }); }
  }
  const finalSafePass = applySafeCopyCorrections(revisedData, data);
  revisedData = finalSafePass.data;
  const firstFactComparison = compareDeterministicFacts(data, safeFirstPass.data);
  const finalFactComparison = compareDeterministicFacts(data, revisedData);
  const factsPreserved = firstFactComparison.preserved && finalFactComparison.preserved;
  const finalReview = reviewCustomerContent(revisedData, { sourceData: data });
  let finalBrandReview = { reviewIssues: [], unresolvedIssues: [] };
  onStage({ phase: 'brand_review', currentAction: '正在复核最终合并后的客户文案', currentUnit: 'brand-review-final', completedUnits: repairPlan.targets.length, totalUnits: repairPlan.targets.length + 1 });
  try {
    const finalEditor = await requestCopyModel('customer-itinerary-brand-reviewer-v1.md', {
      mode: 'final_full', sourceFacts, firstDraft: selectCustomerRenderData(revisedData), deterministicIssues: finalReview.issues,
      copyRules: COPY_RULE_RUNTIME,
    }, 18000, 'high', { taskKind: 'brandReview', taskId: `${jobId}:brand-review-final`, onStatus: (stream) => onStage({ phase: 'brand_review', currentAction: '正在复核最终合并后的客户文案', currentUnit: 'brand-review-final', completedUnits: repairPlan.targets.length, totalUnits: repairPlan.targets.length + 1, stream }) });
    if (!finalEditor.json || !Array.isArray(finalEditor.json.reviewIssues) || !Array.isArray(finalEditor.json.unresolvedIssues)) throw new Error('最终品牌复核返回结构无效');
    finalBrandReview = finalEditor.json;
    reviewUsages.push({ taskKind: 'brandReviewFinal', usage: finalEditor.usage, attemptUsages: finalEditor.attemptUsages || [], requestProfile: finalEditor.requestProfile });
  } catch (error) {
    finalBrandReview = { reviewIssues: [{ ruleId: 'COPY-001', path: 'customer', message: `最终品牌复核失败：${error?.message || String(error)}`, severity: 'quality', action: 'manual_revision' }], unresolvedIssues: [] };
  }
  const normalizedFinalBrandReview = {
    reviewIssues: finalBrandReview.reviewIssues.map((item) => normalizeCopyIssue(item)),
    unresolvedIssues: finalBrandReview.unresolvedIssues.map((item) => normalizeCopyIssue(item, true)),
  };
  const finalIssuesBeforeRepair = uniqueCopyIssues([...finalReview.issues, ...composeCurrentFinalIssues([], normalizedFinalBrandReview, mergeRejected)]);
  if (!factsPreserved) finalIssuesBeforeRepair.push({ ruleIds: ['COPY-011','COPY-014','COPY-015'], ruleId: 'COPY-015', path: 'customer', message: '最终文案改变了原始确定性事实', severity: 'fact', action: 'block' });

  let finalRepair = { data: revisedData, blockers: [], targetRuns: [], usages: [], changedPaths: [], mergeRejected: [], safeCorrections: [], factProvenance: finalSafePass.provenance };
  const finalRepairDecision = finalControlledRepairDecision(finalIssuesBeforeRepair);
  if (finalRepairDecision.shouldRun) {
    onStage({ phase: 'brand_review', currentAction: `最终审查发现 ${finalIssuesBeforeRepair.length} 项，正在执行最后一次定点修正`, currentUnit: 'final-controlled-repair', completedUnits: 0, totalUnits: 1 });
    finalRepair = await runTargetedCopyRepairBatch({ currentData: revisedData, sourceData: data, sourceFacts, mainline: modular.mainline, issues: finalIssuesBeforeRepair, jobId, batchName: 'final-controlled-repair', onStage });
    revisedData = finalRepair.data;
    reviewUsages.push(...finalRepair.usages);
  }

  const postRepairReview = reviewCustomerContent(revisedData, { sourceData: data });
  let postRepairBrandReview = normalizedFinalBrandReview;
  if (finalRepair.targetRuns.length || finalRepair.safeCorrections.length) {
    onStage({ phase: 'brand_review', currentAction: '正在复检最后一次定点修正结果', currentUnit: 'brand-review-post-repair', completedUnits: 0, totalUnits: 1 });
    try {
      const postRepairEditor = await requestCopyModel('customer-itinerary-brand-reviewer-v1.md', {
        mode: 'final_full', sourceFacts, firstDraft: selectCustomerRenderData(revisedData), deterministicIssues: postRepairReview.issues,
        copyRules: COPY_RULE_RUNTIME,
      }, 18000, 'high', { taskKind: 'brandReview', taskId: `${jobId}:brand-review-post-repair` });
      if (!postRepairEditor.json || !Array.isArray(postRepairEditor.json.reviewIssues) || !Array.isArray(postRepairEditor.json.unresolvedIssues)) throw new Error('最终修正复检返回结构无效');
      postRepairBrandReview = {
        reviewIssues: postRepairEditor.json.reviewIssues.map((item) => normalizeCopyIssue(item)),
        unresolvedIssues: postRepairEditor.json.unresolvedIssues.map((item) => normalizeCopyIssue(item, true)),
      };
      reviewUsages.push({ taskKind: 'brandReviewPostRepair', usage: postRepairEditor.usage, attemptUsages: postRepairEditor.attemptUsages || [], requestProfile: postRepairEditor.requestProfile });
    } catch (error) {
      postRepairBrandReview = { reviewIssues: [{ ruleId: 'COPY-001', ruleIds: ['COPY-001'], path: 'customer', message: `最终修正复检失败：${error?.message || String(error)}`, severity: 'quality', action: 'manual_revision' }], unresolvedIssues: [] };
    }
  }
  const finalFactComparisonAfterRepair = compareDeterministicFacts(data, revisedData);
  const finalFactsPreserved = factsPreserved && finalFactComparisonAfterRepair.preserved;
  const finalUnresolved = uniqueCopyIssues(composeCurrentFinalIssues([], postRepairBrandReview, [...mergeRejected, ...finalRepair.mergeRejected, ...finalRepair.blockers]));
  if (!finalFactsPreserved) finalUnresolved.push({ ruleIds: ['COPY-011','COPY-014','COPY-015'], ruleId: 'COPY-015', path: 'customer', message: '最终文案改变了原始确定性事实', severity: 'fact', action: 'block' });
  const remainingIssues = uniqueCopyIssues([...postRepairReview.issues, ...finalUnresolved]);
  const hardIssues = remainingIssues.filter((item) => isBlockingCopyIssue(item));
  const passed = finalFactsPreserved && remainingIssues.length === 0;
  const status = passed ? 'passed' : hardIssues.length ? 'blocked_generation' : 'needs_copy_revision';
  const contentQuality = {
    version: '5.0', ruleVersion: COPY_RULE_VERSION, checkedAt: new Date().toISOString(),
    promptVersions: ['customer-itinerary-mainline-v1.md','customer-itinerary-module-v1.md','customer-itinerary-brand-reviewer-v1.md','customer-itinerary-target-patch-v1.md'],
    firstDraft, initialReview,
    safeCorrections: [...safeFirstPass.corrections, ...finalSafePass.corrections, ...finalRepair.safeCorrections], factProvenance: finalRepair.factProvenance,
    brandEditor: { reviewProfile: brandReviewProfile, reviewIssues: brandReview.reviewIssues, unresolvedIssues: brandReview.unresolvedIssues, repairTargets: targetRuns, changedPaths: [...new Set([...allChangedPaths, ...finalRepair.changedPaths])], finalReview: finalBrandReview, finalControlledRepair: { ...finalRepairDecision, attempted: finalRepairDecision.shouldRun, targetRuns: finalRepair.targetRuns, postRepairReview: postRepairBrandReview }, revisedDraft: selectCustomerRenderData(revisedData) },
    factComparison: { firstDraft: firstFactComparison, final: finalFactComparison, afterFinalRepair: finalFactComparisonAfterRepair }, factsPreserved: finalFactsPreserved, finalReview: postRepairReview,
    unresolvedIssues: finalUnresolved, allIssues: remainingIssues,
    passed, status, needsReview: !passed && !hardIssues.length, blocked: hardIssues.length > 0,
    hardIssueCount: hardIssues.length, remainingIssueCount: remainingIssues.length,
  };
  revisedData.copySourceFacts = sourceFacts;
  revisedData.copyQuality = { version: '5.0', ruleVersion: COPY_RULE_VERSION, passed, status, needsReview: contentQuality.needsReview, blocked: contentQuality.blocked, hardIssueCount: hardIssues.length, remainingIssueCount: remainingIssues.length, allIssues: remainingIssues, checkedAt: contentQuality.checkedAt, promptVersions: contentQuality.promptVersions };
  return { data: revisedData, imagePlanningData: { ...data, contentVisualMainline: modular.mainline }, contentQuality, dailyRefinement: firstMerged.dailyRefinement, usage: { modules: modular.usages, brandReviews: reviewUsages }, model: textModelName, mainline: modular.mainline, copyUnits: { ...modular.unitSummary, directory: modular.storeDirectory }, parallelImageTask: modular.parallelTask };
}

async function runGeneration(job, data, context = {}) {
  job.status = "generating-copy";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  job.phase = "copy";
  job.currentAction = "正在使用真实行程资料生成客户版文案";
  job.progress = 8;
  try {
    const normalizedFacts = normalizeItineraryFacts(data);
    const refined = await refineWithTextModel(normalizedFacts, context, (update = {}) => {
      job.phase = update.phase || job.phase;
      job.currentAction = update.currentAction || job.currentAction;
      job.copyProgress = {
        currentUnit: update.currentUnit || job.copyProgress?.currentUnit || null,
        completedUnits: Number.isFinite(update.completedUnits) ? update.completedUnits : (job.copyProgress?.completedUnits || 0),
        totalUnits: Number.isFinite(update.totalUnits) ? update.totalUnits : (job.copyProgress?.totalUnits || 0),
      };
      if (update.stream) {
        const clean = Object.fromEntries(Object.entries(update.stream).filter(([, value]) => value !== undefined));
        const unitKey = update.currentUnit || job.copyProgress.currentUnit || 'copy';
        const existing = job.copyStreams?.[unitKey] || {};
        const reset = ['queued', 'waiting'].includes(clean.streamPhase) || (clean.attempt && clean.attempt !== existing.attempt);
        const unitStream = reset ? clean : { ...existing, ...clean };
        job.copyStreams = { ...(job.copyStreams || {}), [unitKey]: unitStream };
        job.copyStream = unitStream;
      }
      const ratio = job.copyProgress.totalUnits ? job.copyProgress.completedUnits / job.copyProgress.totalUnits : 0;
      const target = update.phase === 'brand_review' ? 22 + Math.round(ratio * 3) : 8 + Math.round(ratio * 12);
      job.progress = monotonicProgress(job.progress || 8, Math.min(25, target));
      job.updatedAt = Date.now();
    }, job.id, {
      reuseCompleted: context.disableCopyCache !== true,
      onMainlineReady: async (mainline) => {
        job.parallelStages = { ...(job.parallelStages || {}), blueprint: 'running', images: 'waiting' };
        const planningData = { ...normalizedFacts, contentVisualMainline: mainline };
        const blueprintResult = await planImageBlueprint(planningData, { root, apiKey: textModelKey, baseUrl: textModelBaseUrl, model: textModelName, force: context.disableCopyCache === true });
        const planned = { ...blueprintResult, data: { ...planningData, imageBlueprint: blueprintResult.data.imageBlueprint } };
        job.parallelStages = { ...(job.parallelStages || {}), blueprint: planned.failed ? 'fallback' : 'complete', images: 'running' };
        const resolved = await resolveItineraryImages(planned.data, {
          root, apiKey: bigModelKey, baseUrl: bigModelBaseUrl, model: bigModelName,
          searchApiKey: imageSearchKey, searchBaseUrl: imageSearchBaseUrl, searchModel: imageSearchModel,
          disableCache: context.disableCopyCache === true,
          onProgress: ({ stage = 'searching', current = 0, total = 1, label = '', currentAction = '', stats = {} }) => {
            job.parallelStages = { ...(job.parallelStages || {}), images: stage };
            job.currentLabel = label;
            job.imageCurrentAction = currentAction || label || '正在并行处理图片候选';
            job.stats = stats;
            const completed = Number(stats.resolvedSlots || current);
            const denominator = Math.max(1, Number(stats.slotCount || total));
            job.imageProgress = Math.round(Math.min(1, completed / denominator) * 100);
            if (job.status === 'finalizing-images') {
              job.currentAction = job.imageCurrentAction;
              job.progress = monotonicProgress(job.progress || 26, 26 + Math.round(job.imageProgress * 0.66));
            }
            job.updatedAt = Date.now();
          },
        });
        job.parallelStages = { ...(job.parallelStages || {}), images: 'complete', adoption: 'waiting_for_copy_audit' };
        return { planned, resolved };
      },
    });
    job.status = "finalizing-images";
    job.phase = "images";
    job.currentAction = job.imageCurrentAction || "文案审查已结束，正在等待并行图片搜索与终审";
    job.progress = Math.max(job.progress, 26);
    const parallelImages = await refined.parallelImageTask;
    job.currentAction = "正在执行最终文案—图片一致性检查";
    const planned = parallelImages.planned;
    const consistency = mergeParallelImageResult(refined.data, parallelImages.resolved.data, { factsPreserved: refined.contentQuality.factsPreserved });
    let resolved = { ...parallelImages.resolved, data: consistency.data };
    job.copyImageConsistency = consistency.report;
    job.parallelStages = { ...(job.parallelStages || {}), adoption: consistency.report.passed ? 'complete' : 'partial' };
    job.progress = Math.max(job.progress, 94);
    let finalReview = null;
    try {
      finalReview = await reviewFinalLayout(resolved.data, {
        root, origin: `http://127.0.0.1:${port}`, apiKey: bigModelKey, baseUrl: bigModelBaseUrl, model: bigModelName,
        onProgress: ({ stage, currentAction }) => { job.phase = stage; job.currentAction = currentAction; job.progress = Math.max(job.progress, 96); job.updatedAt = Date.now(); },
      });
      if (finalReview.failedSlotIds.length) {
        job.currentAction = `实际长图发现 ${finalReview.failedSlotIds.length} 个图片位置需要重做`;
        job.progress = 97;
        resolved = await resolveItineraryImages(resolved.data, {
          root, apiKey: bigModelKey, baseUrl: bigModelBaseUrl, model: bigModelName,
          searchApiKey: imageSearchKey, searchBaseUrl: imageSearchBaseUrl, searchModel: imageSearchModel,
          onlySlotIds: finalReview.failedSlotIds,
        });
        const checkedAgain = await reviewFinalLayout(resolved.data, { root, origin: `http://127.0.0.1:${port}`, apiKey: bigModelKey, baseUrl: bigModelBaseUrl, model: bigModelName });
        finalReview = { ...checkedAgain, retriedSlotIds: finalReview.failedSlotIds, firstReviewRunId: finalReview.runId };
      }
    } catch (error) {
      finalReview = { failed: true, error: error?.message || String(error), failedSlotIds: [] };
    }
    const gate = generationCompletionGate({ copy: refined, blueprint: planned.blueprint, images: resolved.summary, finalReview });
    if (!gate.stagesComplete) throw new Error(`完整生成阶段未结束：${gate.missing.join('、')}`);
    job.data = resolved.data;
    job.model = refined.model;
    job.usage = { copy: refined.usage, blueprint: { usage: planned.usage || null, attemptUsages: planned.attemptUsages || [], requestProfile: planned.requestProfile || null } };
    job.contentQuality = refined.contentQuality;
    job.copyUnits = refined.copyUnits;
    job.imageBlueprint = { cached: planned.cached, failed: Boolean(planned.failed), errors: planned.errors || [] };
    job.imageResearch = resolved.summary;
    job.finalLayoutReview = finalReview;
    if (gate.state === 'blocked_generation') {
      job.status = 'blocked';
      job.phase = 'blocked';
      job.currentAction = `已阻止生成：发现 ${refined.contentQuality.hardIssueCount} 项事实、安全或结构问题`;
      job.progress = 98;
    } else if (gate.state === 'needs_copy_revision') {
      job.status = 'needs_copy_revision';
      job.phase = 'needs_copy_revision';
      job.currentAction = `待文案修订：${refined.contentQuality.remainingIssueCount} 项；图片和版面结果已保留`;
      job.progress = 98;
    } else {
      job.status = 'complete';
      job.phase = 'complete';
      job.currentAction = `生成完成；当前有 ${resolved.summary?.failedCount || 0} 个位置缺图`;
      job.progress = 100;
    }
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = "failed";
    job.progress = 0;
    job.error = error?.message || "内容生成失败";
    if (error?.contentQuality) job.contentQuality = error.contentQuality;
  }
}

async function runCopyRepair(job, data, targetPath = '') {
  job.status = 'repairing_copy';
  job.phase = 'brand_review';
  job.progress = 12;
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  job.currentAction = targetPath ? `正在定点修正 ${targetPath}` : '正在修正全部可自动处理的文案问题';
  try {
    const sourceData = data.copySourceFacts || data;
    const deterministicBaseline = originalDeterministicBaseline(data);
    const sourceFacts = data.copySourceFacts || compactForModel(sourceData, {});
    const allIssues = uniqueCopyIssues(data.copyQuality?.allIssues || []);
    const selectedIssues = targetPath ? allIssues.filter((issue) => pathsOverlap(targetPath, issue.path)) : allIssues;
    if (!selectedIssues.length) throw new Error('当前没有可修正的问题，请先重新检查');
    const batch = await runTargetedCopyRepairBatch({
      currentData: data, sourceData, deterministicBaseline, sourceFacts, mainline: data.contentVisualMainline || {}, issues: selectedIssues,
      jobId: job.id, batchName: targetPath ? 'editor-target-repair' : 'editor-repair-all',
      onStage: (update = {}) => {
        job.currentAction = update.currentAction || job.currentAction;
        job.currentUnit = update.currentUnit || job.currentUnit;
        job.progress = monotonicProgress(job.progress, Math.min(82, 18 + Math.round(((update.completedUnits || 0) / Math.max(1, update.totalUnits || 1)) * 64)));
        job.updatedAt = Date.now();
      },
    });
    job.progress = 86;
    job.currentAction = '正在只复检本次修正的目标字段';
    const targetScopes = [...new Set((targetPath ? [targetPath] : selectedIssues.map((issue) => targetScopeFromPath(issue.path).path)).filter(Boolean))];
    const deterministic = reviewCustomerContent(batch.data, { sourceData });
    const deterministicTargetIssues = deterministic.issues.filter((issue) => targetScopes.some((scope) => pathsOverlap(scope, issue.path)));
    const targetRemaining = batch.targetRuns.flatMap((run) => run.remainingIssues || []);
    const refreshedIssues = uniqueCopyIssues([...deterministicTargetIssues, ...targetRemaining, ...batch.blockers, ...batch.mergeRejected]);
    const factComparison = compareDeterministicFacts(deterministicBaseline, batch.data);
    if (!factComparison.preserved) refreshedIssues.push({ ruleId: 'COPY-015', ruleIds: ['COPY-011','COPY-014','COPY-015'], path: 'customer', message: '修订结果改变了原始确定性事实', severity: 'fact', action: 'block' });
    const mergedIssues = mergeTargetRepairIssues(allIssues, targetScopes, uniqueCopyIssues(refreshedIssues));
    const hardIssues = mergedIssues.filter((item) => isBlockingCopyIssue(item));
    const passed = factComparison.preserved && mergedIssues.length === 0;
    const status = passed ? 'passed' : hardIssues.length ? 'blocked_generation' : 'needs_copy_revision';
    const checkedAt = new Date().toISOString();
    job.contentQuality = {
      ...(data.copyQuality || {}), version: '5.2', ruleVersion: COPY_RULE_VERSION, checkedAt,
      passed, status, needsReview: !passed && !hardIssues.length, blocked: hardIssues.length > 0,
      hardIssueCount: hardIssues.length, remainingIssueCount: mergedIssues.length, allIssues: mergedIssues,
      factComparison, finalReview: { ...deterministic, issues: deterministicTargetIssues },
      brandRecheck: { mode: 'target_recheck_only', targetScopes, targetRuns: batch.targetRuns },
      editorRepair: { targetPath: targetPath || null, targetScopes, targetRuns: batch.targetRuns, changedPaths: batch.changedPaths, safeCorrections: batch.safeCorrections, mergeRejected: batch.mergeRejected, blockers: batch.blockers },
    };
    job.data = { ...batch.data, copyQuality: { version: '5.2', ruleVersion: COPY_RULE_VERSION, passed, status, needsReview: job.contentQuality.needsReview, blocked: job.contentQuality.blocked, hardIssueCount: hardIssues.length, remainingIssueCount: mergedIssues.length, allIssues: mergedIssues, checkedAt } };
    job.status = passed ? 'complete' : hardIssues.length ? 'blocked' : 'needs_copy_revision';
    job.phase = job.status;
    job.progress = passed ? 100 : 98;
    job.currentAction = passed ? '目标修正通过，当前文案检查全部完成' : hardIssues.length ? `仍有 ${hardIssues.length} 项事实、费用、安全或结构问题需要处理` : `本次目标已复检；仍有 ${mergedIssues.length} 项普通文案建议，可继续编辑或确认后正式导出`;
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = 'failed';
    job.phase = 'failed';
    job.progress = 0;
    job.error = error?.message || '文案修正失败';
    job.updatedAt = Date.now();
  }
}

async function runSlotResearch(job, data, slotId) {
  job.status = "researching-images"; job.phase = "searching"; job.progress = 12; job.startedAt = Date.now(); job.currentAction = `正在重新搜索：${slotId}`;
  try {
    const resolved = await resolveItineraryImages(data, {
      root, apiKey: bigModelKey, baseUrl: bigModelBaseUrl, model: bigModelName,
      searchApiKey: imageSearchKey, searchBaseUrl: imageSearchBaseUrl, searchModel: imageSearchModel,
      onlySlotIds: [slotId],
      onProgress: ({ stage, label, currentAction, stats = {} }) => { job.phase = stage; job.currentLabel = label; job.currentAction = currentAction; job.stats = stats; job.progress = Math.max(job.progress, stage === "auditing" ? 72 : 35); job.updatedAt = Date.now(); },
    });
    job.status = "complete"; job.phase = "complete"; job.currentAction = "当前位置已完成搜索，可在图片库选择"; job.progress = 100; job.data = resolved.data; job.imageResearch = resolved.summary; job.updatedAt = Date.now();
  } catch (error) {
    job.status = "failed"; job.progress = 0; job.error = error?.message || "单图片位重搜失败"; job.updatedAt = Date.now();
  }
}

function runRender(job, data, options = {}) {
  const dataFile = path.join(jobDir, `${job.id}.json`);
  const outputFile = path.join(outputDir, `${job.id}-itinerary-2000.png`);
  const qaFile = path.join(outputDir, `${job.id}-layout-qa.json`);
  const preflight = reviewFinalOutputData(data, null, options);
  if (!preflight.passed) { job.status = 'failed'; job.progress = 0; job.error = '正式输出检查未通过：' + preflight.issues.map((item) => item.message).join('；'); job.outputQa = preflight; return; }
  writeFileSync(dataFile, JSON.stringify(selectCustomerRenderData(data)), "utf8");
  job.status = "rendering";
  job.progress = 18;
  const child = spawn(process.execPath, [
    path.join(root, "renderer", "render.mjs"),
    "--width=2000",
    "--dataset=workspace",
    `--data-file=${dataFile}`,
    `--output=${outputFile}`,
    `--qa-output=${qaFile}`,
    `--origin=http://127.0.0.1:${port}`,
  ], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  child.on("error", (error) => {
    if (existsSync(dataFile)) unlinkSync(dataFile);
    job.status = "failed"; job.progress = 0; job.error = error?.message || "长图生成失败";
  });
  child.on("close", (code) => {
    if (existsSync(dataFile)) unlinkSync(dataFile);
    if (code === 0 && existsSync(outputFile)) {
      const layoutQa = existsSync(qaFile) ? JSON.parse(readFileSync(qaFile, 'utf8')) : null;
      const outputQa = reviewFinalOutputData(data, layoutQa, options);
      job.outputQa = outputQa;
      if (!outputQa.passed) { job.status = 'failed'; job.progress = 0; job.error = '正式输出检查未通过：' + outputQa.issues.map((item) => item.message).join('；'); return; }
      job.status = "complete";
      job.progress = 100;
      job.downloadUrl = `/generated/${path.basename(outputFile)}`;
      return;
    }
    job.status = "failed";
    job.progress = 0;
    job.error = errors.trim().split("\n").slice(-3).join(" ") || "长图生成失败";
  });
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
};

function streamFile(response, file) {
  response.writeHead(200, { "content-type": contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream" });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, { ok: true, model: textModelName, aiConfigured: Boolean(textModelKey), textModel: textModelName, textModelConfigured: Boolean(textModelKey), imageModel: bigModelName, imageModelConfigured: Boolean(bigModelKey), imagePipeline: process.env.IMAGE_PIPELINE_ENABLED !== "off", imageSearchConfigured: Boolean(imageSearchKey), imageSearchModel });
  }
  if (request.method === "POST" && url.pathname === "/api/ai/refine") {
    try {
      const payload = await requestBody(request);
      if (!payload?.data?.days?.length) return json(response, 400, { error: "没有可生成的逐日行程" });
      const validation = validateItineraryFacts(normalizeItineraryFacts(payload.data));
      if (!validation.valid) return json(response, 400, { error: validation.errors.join("；"), validationErrors: validation.errors });
      const refined = await refineWithTextModel(payload.data, payload.context || {});
      if (payload.includeImages === false) return json(response, 200, refined);
      const resolved = await resolveItineraryImages(refined.data, { root, apiKey: bigModelKey, baseUrl: bigModelBaseUrl, model: bigModelName, searchApiKey: imageSearchKey, searchBaseUrl: imageSearchBaseUrl, searchModel: imageSearchModel });
      return json(response, 200, { ...refined, data: resolved.data, imageResearch: resolved.summary });
    } catch (error) {
      return json(response, 502, { error: error?.message || "DeepSeek 文字生成失败" });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/generate") {
    try {
      const payload = await requestBody(request);
      if (!payload?.data?.days?.length) return json(response, 400, { error: "没有可生成的逐日行程" });
      const normalized = normalizeItineraryFacts(payload.data);
      const validation = validateItineraryFacts(normalized);
      if (!validation.valid) return json(response, 400, { error: validation.errors.join("；"), validationErrors: validation.errors });
      const safeContext = safeCustomerData(payload.context || {});
      const fingerprint = generationFingerprint(safeCustomerData(normalized), safeContext);
      const active = activeGenerationByFingerprint(jobs, fingerprint);
      if (active) return json(response, 202, { ...active, deduplicated: true });
      const job = { id: randomUUID(), kind: "generation", generationFingerprint: fingerprint, status: "queued", phase: "queued", currentAction: "任务已排队，准备生成", progress: 3, stats: {}, createdAt: Date.now(), updatedAt: Date.now() };
      jobs.set(job.id, job);
      json(response, 202, job);
      setImmediate(() => runGeneration(job, safeCustomerData(normalized), safeContext));
    } catch (error) {
      json(response, 400, { error: error?.message || "无法读取生成请求" });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/copy/recheck") {
    try {
      const payload = await requestBody(request);
      if (!payload?.data?.days?.length) return json(response, 400, { error: '缺少可复检的行程数据' });
      return json(response, 200, await recheckCopyWithBrand(safeCustomerData(payload.data)));
    } catch (error) { return json(response, 400, { error: error?.message || '文案复检失败' }); }
  }
  if (request.method === "POST" && url.pathname === "/api/copy/repair") {
    try {
      const payload = await requestBody(request);
      if (!payload?.data?.days?.length) return json(response, 400, { error: '缺少可修正的行程数据' });
      const job = { id: randomUUID(), kind: 'copy-repair', targetPath: payload.targetPath ? String(payload.targetPath) : '', status: 'queued', phase: 'queued', currentAction: '文案修正已排队', progress: 5, createdAt: Date.now(), updatedAt: Date.now() };
      jobs.set(job.id, job);
      json(response, 202, job);
      setImmediate(() => runCopyRepair(job, safeCustomerData(payload.data), job.targetPath));
    } catch (error) { json(response, 400, { error: error?.message || '无法创建文案修正任务' }); }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/render") {
    try {
      const payload = await requestBody(request);
      if (!payload?.data?.days?.length) return json(response, 400, { error: "没有可生成的逐日行程" });
      const job = { id: randomUUID(), status: "queued", progress: 5, createdAt: Date.now() };
      jobs.set(job.id, job);
      json(response, 202, job);
      setImmediate(() => runRender(job, normalizeItineraryFacts(payload.data), { allowCopyReviewPending: payload.options?.allowCopyReviewPending === true }));
    } catch (error) {
      json(response, 400, { error: error?.message || "无法读取生成请求" });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/images/upload") {
    try {
      const buffer = await requestBuffer(request);
      const metadata = await sharp(buffer, { failOn: "warning" }).metadata();
      if (!['jpeg','png','webp'].includes(metadata.format) || !metadata.width || !metadata.height) return json(response, 400, { error: "请选择可正常打开的 JPG、PNG 或 WebP 图片" });
      if (metadata.width < 300 || metadata.height < 200 || metadata.width * metadata.height > 50_000_000) return json(response, 400, { error: "上传图片尺寸不适合客户成品（至少300×200，且不超过5000万像素）" });
      const extension = metadata.format === 'jpeg' ? '.jpg' : '.' + metadata.format;
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const name = sha256.slice(0, 24) + extension;
      const file = path.join(userImageDir, name);
      if (!existsSync(file)) writeFileSync(file, buffer);
      return json(response, 200, { src: '/image-assets/user/' + name, sha256, width: metadata.width, height: metadata.height });
    } catch (error) { return json(response, 400, { error: error?.message || "图片上传失败" }); }
  }
  if (request.method === "POST" && url.pathname === "/api/images/research-slot") {
    try {
      const payload = await requestBody(request);
      if (!payload?.data?.days?.length || !payload?.slotId) return json(response, 400, { error: "缺少行程数据或图片位" });
      const job = { id: randomUUID(), kind: "image-slot-research", slotId: String(payload.slotId), status: "queued", phase: "queued", currentAction: "单图片位重搜已排队", progress: 5, stats: {}, createdAt: Date.now(), updatedAt: Date.now() };
      jobs.set(job.id, job); json(response, 202, job);
      setImmediate(() => runSlotResearch(job, safeCustomerData(payload.data), String(payload.slotId)));
    } catch (error) { json(response, 400, { error: error?.message || "无法创建单图片位重搜任务" }); }
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const job = jobs.get(url.pathname.slice("/api/jobs/".length));
    return job ? json(response, 200, { ...job, elapsedMs: Date.now() - (job.startedAt || job.createdAt) }) : json(response, 404, { error: "生成任务不存在或已过期" });
  }
  if (request.method === "GET" && url.pathname.startsWith("/generated/")) {
    const name = path.basename(decodeURIComponent(url.pathname));
    const file = path.join(outputDir, name);
    if (existsSync(file)) return streamFile(response, file);
    response.writeHead(404).end("Not found");
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/image-assets/")) {
    const relative = decodeURIComponent(url.pathname.slice("/image-assets/".length));
    const file = path.resolve(imageAssetDir, relative);
    if (file.startsWith(imageAssetDir) && existsSync(file)) return streamFile(response, file);
    response.writeHead(404).end("Not found");
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/image-ledgers/")) {
    const id = path.basename(decodeURIComponent(url.pathname));
    const file = path.join(imageLedgerDir, `${id}-image-sources.json`);
    if (existsSync(file)) return streamFile(response, file);
    return json(response, 404, { error: "图片来源记录不存在" });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/image-blueprints/")) {
    const id = path.basename(decodeURIComponent(url.pathname));
    const file = path.join(imageBlueprintDir, `${id}-image-blueprint.json`);
    if (existsSync(file)) return streamFile(response, file);
    return json(response, 404, { error: "图片蓝图不存在" });
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405).end("Method not allowed");
    return;
  }
  const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
  const candidate = path.resolve(clientDir, relative);
  const file = candidate.startsWith(clientDir) && existsSync(candidate) ? candidate : path.join(clientDir, "index.html");
  if (!existsSync(file)) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("请先运行 npm run build");
    return;
  }
  streamFile(response, file);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`奢游行程生成工具：http://127.0.0.1:${port}/`);
});
