import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CAPABILITIES, AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION, GLOBAL_HARD_RULE_IDS } from "../config/agent-rule-profile.mjs";
import { requestDeepSeekJson } from "./deepseek-client.mjs";
import { compactValidationErrors, validateAgentPlan } from "./agent-plan-validator.mjs";
import { compileAgentExecutionPlan, filterImagePlanForModules } from "./agent-plan-compiler.mjs";
import { validateReviewDecisionBatch } from "./agent-review-decision.mjs";

export const AGENT_PROMPT_VERSION = "agent-trip-planner-v2-light-business";
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(path.resolve(moduleDir, "../prompts/agent-trip-planner-v1.md"), "utf8");
const reviewDecisionPrompt = readFileSync(path.resolve(moduleDir, "../prompts/agent-review-decision-v1.md"), "utf8");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function fingerprintFacts(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

const cleanText = (value) => typeof value === "string" ? value.trim() : "";
const unique = (values) => [...new Set(values.filter(Boolean))];

export function buildAgentFactBasis(data = {}, report = {}) {
  const days = Array.isArray(data.days) ? data.days : [];
  const hotels = (Array.isArray(data.hotels) ? data.hotels : []).map((hotel, index) => ({
    id: cleanText(hotel.id) || `hotel-${index + 1}`,
    name: cleanText(hotel.officialName || hotel.name || hotel.title),
    nights: Number(hotel.nights) || null,
    region: cleanText(hotel.region) || null,
    currentCopy: cleanText(hotel.editorialCopy) || null,
    status: hotel.status || hotel.confirmationStatus || null,
    roomType: cleanText(hotel.roomType) || null,
    mealPlan: cleanText(hotel.mealPlan) || null,
    selectionReason: cleanText(hotel.selectionReason) || null,
    signatureExperience: cleanText(hotel.signatureExperience) || null,
  })).filter((hotel) => hotel.name);
  return {
    destination: cleanText(data.destination) || "待确认目的地",
    dayCount: Number(data.dayCount) || days.length,
    startDate: cleanText(data.startDate) || null,
    endDate: cleanText(data.endDate) || null,
    travelerCount: Number(data.travelers || data.adults) || null,
    hotels,
    transport: (Array.isArray(data.transportSummary) ? data.transportSummary : []).map((item, index) => ({ id: cleanText(item.id) || `transport-${index + 1}`, category: cleanText(item.category || item.title || item.label), serviceLevel: cleanText(item.serviceLevel), model: cleanText(item.model) || null, modelGuaranteed: item.modelGuaranteed === true, usageLabel: cleanText(item.usageLabel) || null, features: item.features || [], status: item.status || null, currentCopy: cleanText(item.editorialCopy || item.description) })).filter((item) => item.category).slice(0, 20),
    diningExperiences: (Array.isArray(data.diningExperiences) ? data.diningExperiences : []).map((item, index) => ({ id: cleanText(item.id) || `dining-${index + 1}`, name: cleanText(item.title || item.officialName), officialName: cleanText(item.officialName) || null, location: cleanText(item.location) || null, status: item.status || item.feeBoundary || null, currentCopy: cleanText(item.editorialCopy) })).filter((item) => item.name).slice(0, 20),
    coreExperiences: unique([...(Array.isArray(data.highlights) ? data.highlights : []), ...days.map((day) => cleanText(day.title || day.route))]).slice(0, 24),
    days: days.map((day, index) => ({
      day: index + 1,
      date: cleanText(day.date) || null,
      route: cleanText(day.route || day.title) || (Array.isArray(day.routeNodes) ? day.routeNodes.map(cleanText).filter(Boolean).join(" → ") : null),
      routeNodes: Array.isArray(day.routeNodes) ? day.routeNodes.map(cleanText).filter(Boolean) : [],
      hotel: cleanText(day.hotel) || null,
      meals: cleanText(day.meals) || null,
      mealPlan: day.mealPlan || null,
      experience: cleanText(day.description || day.experience) || null,
      vehicle: cleanText(day.vehicle) || null,
      overnightType: day.overnightType || null,
      spots: (day.spots || []).map((spot) => ({ id: spot.id || null, name: cleanText(spot.name), description: cleanText(spot.description || spot.experience), status: spot.status || null, statusLabel: spot.statusLabel || null, feeBoundary: spot.feeBoundary || null, reminder: cleanText(spot.reminder) || null })),
    })),
    expenses: { included: data.included || [], excluded: data.excluded || [], cancellation: data.cancellation || [], pendingConfirmations: data.pendingConfirmations || [], totalPrice: data.totalPrice ?? null, priceUnit: data.priceUnit || null },
    sourceCoverage: {
      workbookName: cleanText(report.workbookName),
      sheetCount: Array.isArray(report.sheetNames) ? report.sheetNames.length : null,
      warnings: (Array.isArray(report.warnings) ? report.warnings : []).map(cleanText).filter(Boolean),
      unrecognizedFields: (Array.isArray(report.unrecognizedFields) ? report.unrecognizedFields : []).map(cleanText).filter(Boolean).slice(0, 30),
    },
    sourcePosterHighlights: (Array.isArray(data.sourcePosterHighlights) ? data.sourcePosterHighlights : []).map(cleanText).filter(Boolean).slice(0, 20),
  };
}

function assemblePlan(raw, context, previousPlanId, callStats) {
  const now = new Date().toISOString();
  const compiled = compileAgentExecutionPlan(raw, context);
  const tasks = compiled.tasks;
  const imagePlan = filterImagePlanForModules(raw?.imagePlan || { visualStory: "", slots: [] }, compiled.modules);
  return {
    planId: randomUUID(),
    projectId: context.projectId,
    planVersion: (context.previousPlanVersion || 0) + 1,
    previousPlanId: previousPlanId || null,
    flowKind: "agent_v1",
    executionEnabled: false,
    status: "plan_only",
    inputFingerprint: context.inputFingerprint,
    createdAt: now,
    validatedAt: null,
    ruleProfileVersion: AGENT_RULE_PROFILE_VERSION,
    capabilityConfigVersion: AGENT_CAPABILITY_VERSION,
    promptVersion: AGENT_PROMPT_VERSION,
    runtime: { port: 4174, namespace: "agent_v1" },
    globalRuleIds: [...GLOBAL_HARD_RULE_IDS],
    summary: raw?.summary,
    selectedHighlights: Array.isArray(raw?.selectedHighlights) ? raw.selectedHighlights : [],
    factBasis: context.factBasis,
    dayRoles: Array.isArray(raw?.dayRoles) ? raw.dayRoles : [],
    contentPlacement: Array.isArray(raw?.contentPlacement) ? raw.contentPlacement : [],
    modules: compiled.modules,
    copyPlan: compiled.copyPlan,
    webVerification: Array.isArray(raw?.webVerification) ? raw.webVerification : [],
    imagePlan,
    tasks,
    checkpointCoverage: [...new Set(tasks.flatMap((task) => Array.isArray(task.checkpointIds) ? task.checkpointIds : []))],
    confirmations: Array.isArray(raw?.confirmations) ? raw.confirmations : [],
    adjustments: Array.isArray(raw?.adjustments) ? raw.adjustments : [],
    validation: { passed: false, correctionUsed: false, errors: [] },
    capabilityCallStats: AGENT_CAPABILITIES.map((item) => ({ capabilityId: item.id, actualCalls: callStats[item.id] || 0, plannedTasks: tasks.filter((task) => task.capabilityIds?.includes(item.id)).length })),
  };
}

export async function generateAgentPlan({ project, apiKey, baseUrl, model, requestJson = requestDeepSeekJson, onStatus, signal, simpleSkillContract = false }) {
  const factBasis = project.factBasis;
  const context = { projectId: project.projectId, inputFingerprint: project.inputFingerprint, factBasis, previousPlanVersion: project.planIds?.length || 0 };
  const sharedInput = {
    factBasis,
    preflightDecisions: project.confirmationDecisions || [],
    inputFingerprint: project.inputFingerprint,
    versions: { ruleProfileVersion: AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion: AGENT_CAPABILITY_VERSION, promptVersion: AGENT_PROMPT_VERSION },
    globalHardRuleIds: GLOBAL_HARD_RULE_IDS,
    allowedModuleActions: ["preserve", "optimize", "generate", "hide"],
    planningLimits: { summaryMaxChars: 500, itemMaxChars: 240, noFinalCustomerCopy: true, noTechnicalTaskGraph: true },
  };
  const callStats = { source_parser: 1, trip_planner: 0 };
  const attempts = [];
  const simpleContractPrompt = "simple-skill-pipeline 额外接口：在原有 JSON 字段之外返回 selectedHighlights 数组。每项只含 sourceText、sourceType(source_designated|official_product|planner_derived)、sourceRefs、selectionReason，不写最终客户文案。你必须在本次规划中最终确定实际采用的亮点集合：优先来源指定亮点，其次正式产品级亮点，前两类不足目标时才补充整程级购买理由；目标5—7条，真实事实不足时允许少于5条并在 selectionReason 说明素材不足。不得把普通DAY细节拔高。";
  let raw;
  let firstErrors = [];
  for (let index = 0; index < 2; index += 1) {
    callStats.trip_planner += 1;
    onStatus?.({ status: "planning", message: index === 0 ? "正在制定轻量业务规划" : "正在按安全检查结果收敛业务规划" });
    const systemMessages = [{ role: "system", content: prompt }, ...(simpleSkillContract ? [{ role: "system", content: simpleContractPrompt }] : [])];
    const messages = index === 0
      ? [...systemMessages, { role: "user", content: JSON.stringify(sharedInput) }]
      : [...systemMessages, { role: "user", content: JSON.stringify({ ...sharedInput, correctionRequest: { errors: compactValidationErrors(firstErrors), previousPlan: raw, instruction: "只修正列出的结构和安全问题；保留事实与仍然有效的动态规划。" } }) }];
    const attemptStartedAt = new Date().toISOString();
    let response;
    try {
      response = await requestJson({ apiKey, baseUrl, model, messages, reasoningEffort: "high", maxTokens: 12000, timeoutMs: 180_000, emptyContentRetries: 1, signal, onStatus: (event) => onStatus?.({ status: "planning", message: "规划模型正在返回紧凑业务计划", provider: { streamPhase: event.streamPhase, receivedContentChars: event.receivedContentChars } }) });
    } catch (error) {
      attempts.push({ attemptId: randomUUID(), index: index + 1, createdAt: attemptStartedAt, completedAt: new Date().toISOString(), status: "failed", rawModelPlan: null, validation: null, model, usage: null, attemptUsages: error.attemptUsages || [], error: error.message });
      error.attempts = attempts;
      throw error;
    }
    callStats.trip_planner += Math.max(0, Number(response.attemptUsages?.length || 1) - 1);
    raw = response.json;
    const plan = assemblePlan(raw, context, project.activePlanId, callStats);
    onStatus?.({ status: "checking", message: "正在检查规则、权限、依赖与图片位" });
    const validation = validateAgentPlan(plan, context);
    attempts.push({ attemptId: randomUUID(), index: index + 1, createdAt: new Date().toISOString(), rawModelPlan: raw, validation, model: response.model, usage: response.usage || null });
    if (validation.valid) {
      const completed = { ...plan, validatedAt: new Date().toISOString(), validation: { passed: true, correctionUsed: index === 1, errors: [], firstAttemptErrors: compactValidationErrors(firstErrors) }, adjustments: index === 1 ? [...plan.adjustments, ...compactValidationErrors(firstErrors).map((item) => ({ issue: item.message, change: "规划器已按该项安全检查修正并重新通过校验" }))] : plan.adjustments };
      return { plan: completed, attempts };
    }
    firstErrors = validation.errors;
  }
  const failure = new Error("规划经过一次目标修正后仍未通过安全检查");
  failure.code = "planning_failed";
  failure.validationErrors = compactValidationErrors(firstErrors);
  failure.attempts = attempts;
  throw failure;
}

export async function decideAgentReviewFindings({ packet, apiKey, baseUrl, model, requestJson = requestDeepSeekJson, onStatus, signal }) {
  if (!packet?.findings?.length) return { packet, decision: { summary: "本批次没有审核问题，无需调用总智能体", decisions: [] }, validation: { valid: true, errors: [], decisions: [] }, callCount: 0, durationMs: 0, usage: null, model: null };
  onStatus?.({ status: "review_decision", message: `正在统一判断 ${packet.findings.length} 个审核结果` });
  const started = Date.now();
  let response;
  let technicalAttempts = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    technicalAttempts = attempt;
    try {
      response = await requestJson({
        apiKey,
        baseUrl,
        model,
        messages: [{ role: "system", content: reviewDecisionPrompt }, { role: "user", content: JSON.stringify(packet) }],
        reasoningEffort: "high",
        maxTokens: 8_000,
        timeoutMs: 60_000,
        emptyContentRetries: 0,
        signal,
        onStatus: (event) => onStatus?.({ status: "review_decision", message: attempt === 1 ? "总智能体正在返回本批次受控决定" : "首次技术调用失败，正在进行唯一一次技术重试", provider: { streamPhase: event.streamPhase, receivedContentChars: event.receivedContentChars } }),
      });
      break;
    } catch (error) {
      if (error?.name === "AbortError" || attempt === 2) {
        error.reviewDecisionTechnicalAttempts = technicalAttempts;
        throw error;
      }
    }
  }
  const validation = validateReviewDecisionBatch(packet, response.json);
  if (!validation.valid) {
    const error = new Error("总智能体的审核决定未通过权限和范围检查");
    error.code = "review_decision_invalid";
    error.details = validation.errors;
    error.rawDecision = response.json;
    throw error;
  }
  return { packet, decision: response.json, validation, callCount: technicalAttempts + Math.max(0, Number(response.attemptUsages?.length || 1) - 1), durationMs: Date.now() - started, usage: response.usage || null, model: response.model || model };
}
