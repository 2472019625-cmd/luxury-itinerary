import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CAPABILITIES, AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION, CHECKPOINT_IDS, GLOBAL_HARD_RULE_IDS } from "../config/agent-rule-profile.mjs";
import { AGENT_TASK_ROUTES } from "../config/agent-task-routing.mjs";
import { requestDeepSeekJson } from "./deepseek-client.mjs";
import { compactValidationErrors, validateAgentPlan } from "./agent-plan-validator.mjs";

export const AGENT_PROMPT_VERSION = "agent-trip-planner-v1";
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(path.resolve(moduleDir, "../prompts/agent-trip-planner-v1.md"), "utf8");

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
  })).filter((hotel) => hotel.name);
  return {
    destination: cleanText(data.destination) || "待确认目的地",
    dayCount: Number(data.dayCount) || days.length,
    startDate: cleanText(data.startDate) || null,
    endDate: cleanText(data.endDate) || null,
    travelerCount: Number(data.travelers || data.adults) || null,
    hotels,
    transport: (Array.isArray(data.transportSummary) ? data.transportSummary : []).map((item) => cleanText(item.title || item.label || item.description || item)).filter(Boolean).slice(0, 20),
    coreExperiences: unique([...(Array.isArray(data.highlights) ? data.highlights : []), ...days.map((day) => cleanText(day.title || day.route))]).slice(0, 24),
    days: days.map((day, index) => ({
      day: index + 1,
      date: cleanText(day.date) || null,
      route: cleanText(day.route || day.title) || null,
      hotel: cleanText(day.hotel) || null,
      meals: cleanText(day.meals) || null,
      experience: cleanText(day.description || day.experience) || null,
    })),
    sourceCoverage: {
      workbookName: cleanText(report.workbookName),
      sheetCount: Array.isArray(report.sheetNames) ? report.sheetNames.length : null,
      warnings: (Array.isArray(report.warnings) ? report.warnings : []).map(cleanText).filter(Boolean),
      unrecognizedFields: (Array.isArray(report.unrecognizedFields) ? report.unrecognizedFields : []).map(cleanText).filter(Boolean).slice(0, 30),
    },
  };
}

function routingForModel() {
  return Object.entries(AGENT_TASK_ROUTES).map(([taskType, route]) => ({ taskType, ...route }));
}

function capabilitiesForModel() {
  return AGENT_CAPABILITIES.map(({ id, mutablePaths, taskTypes, reasoningPolicy, budgetKey, retryLimit }) => ({ id, mutablePaths, taskTypes, reasoningPolicy, budgetKey, retryLimit }));
}

function assemblePlan(raw, context, previousPlanId, callStats) {
  const now = new Date().toISOString();
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
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
    factBasis: raw?.factBasis,
    modules: Array.isArray(raw?.modules) ? raw.modules : [],
    copyPlan: raw?.copyPlan || { groups: [] },
    webVerification: Array.isArray(raw?.webVerification) ? raw.webVerification : [],
    imagePlan: raw?.imagePlan || { visualStory: "", slots: [] },
    tasks,
    checkpointCoverage: [...new Set(tasks.flatMap((task) => Array.isArray(task.checkpointIds) ? task.checkpointIds : []))],
    confirmations: Array.isArray(raw?.confirmations) ? raw.confirmations : [],
    adjustments: Array.isArray(raw?.adjustments) ? raw.adjustments : [],
    validation: { passed: false, correctionUsed: false, errors: [] },
    capabilityCallStats: AGENT_CAPABILITIES.map((item) => ({ capabilityId: item.id, actualCalls: callStats[item.id] || 0, plannedTasks: tasks.filter((task) => task.capabilityIds?.includes(item.id)).length })),
  };
}

export async function generateAgentPlan({ project, apiKey, baseUrl, model, requestJson = requestDeepSeekJson, onStatus, signal }) {
  const factBasis = project.factBasis;
  const context = { projectId: project.projectId, inputFingerprint: project.inputFingerprint, factBasis, previousPlanVersion: project.planIds?.length || 0 };
  const sharedInput = {
    factBasis,
    preflightDecisions: project.confirmationDecisions || [],
    inputFingerprint: project.inputFingerprint,
    versions: { ruleProfileVersion: AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion: AGENT_CAPABILITY_VERSION, promptVersion: AGENT_PROMPT_VERSION },
    globalHardRuleIds: GLOBAL_HARD_RULE_IDS,
    checkpointIds: CHECKPOINT_IDS,
    taskRoutes: routingForModel(),
    capabilities: capabilitiesForModel(),
    executionEnabled: false,
  };
  const callStats = { source_parser: 1, trip_planner: 0 };
  const attempts = [];
  let raw;
  let firstErrors = [];
  for (let index = 0; index < 2; index += 1) {
    callStats.trip_planner += 1;
    onStatus?.({ status: "planning", message: index === 0 ? "正在制定动态任务计划" : "正在按安全检查结果修正规划" });
    const messages = index === 0
      ? [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(sharedInput) }]
      : [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify({ ...sharedInput, correctionRequest: { errors: compactValidationErrors(firstErrors), previousPlan: raw, instruction: "只修正列出的结构和安全问题；保留事实与仍然有效的动态规划。" } }) }];
    const response = await requestJson({ apiKey, baseUrl, model, messages, reasoningEffort: "high", maxTokens: 30000, emptyContentRetries: 1, signal, onStatus: (event) => onStatus?.({ status: "planning", message: "规划模型正在返回结构化计划", provider: { streamPhase: event.streamPhase, receivedContentChars: event.receivedContentChars } }) });
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
