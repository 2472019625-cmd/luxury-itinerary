import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CAPABILITIES, AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION, GLOBAL_HARD_RULE_IDS } from "../config/agent-rule-profile.mjs";
import { publicSheyouProductValues } from "../config/sheyou-product-values.mjs";
import { requestDeepSeekJson } from "./deepseek-client.mjs";
import { validateAgentPlan } from "./agent-plan-validator.mjs";
import { compileAgentExecutionPlan, filterImagePlanForModules } from "./agent-plan-compiler.mjs";
import { validateReviewDecisionBatch } from "./agent-review-decision.mjs";
import { buildKnowledgeQueryPlan, cleanupPlannerQueryScope, validatePlannerSearchIntent } from "./knowledge-scope-resolver.mjs";
import { visualSubjectPolicyIssue } from "./visual-subject-policy.mjs";

export const AGENT_PROMPT_VERSION = "agent-trip-planner-v3-single-pass-fail-open";
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

function posterHighlightLines(values = []) {
  return unique(values.flatMap((value) => cleanText(value).split(/\r?\n/).map(cleanText)).filter(Boolean));
}

export function validateSimpleHighlightSelection(raw = {}, factBasis = {}) {
  const errors = [];
  const selected = Array.isArray(raw.selectedHighlights) ? raw.selectedHighlights : [];
  const sourceDesignated = new Set(posterHighlightLines(factBasis.sourcePosterHighlights));
  const officialProducts = new Set((factBasis.officialProductValues || []).map((item) => cleanText(item?.sourceText)).filter(Boolean));
  const allowedTypes = new Set(["source_designated", "official_product", "planner_derived"]);
  if (!Array.isArray(raw.selectedHighlights)) return [{ code: "selected_highlights_missing", message: "simple-skill-pipeline 必须返回 selectedHighlights" }];
  if (selected.length > 7) errors.push({ code: "selected_highlights_overflow", message: "产品亮点超过7条，Planner必须先排序和合并" });
  for (const [index, item] of selected.entries()) {
    const sourceText = cleanText(item?.sourceText);
    const sourceType = cleanText(item?.sourceType);
    if (!sourceText || !allowedTypes.has(sourceType)) errors.push({ code: "selected_highlight_invalid", message: `产品亮点 ${index + 1} 缺少有效 sourceText/sourceType` });
    else if (sourceType === "source_designated" && !sourceDesignated.has(sourceText)) errors.push({ code: "source_highlight_untraceable", message: `来源指定亮点无法追溯：${sourceText}` });
    else if (sourceType === "official_product" && !officialProducts.has(sourceText)) errors.push({ code: "official_product_untraceable", message: `正式服务亮点不在已确认候选中：${sourceText}` });
    else if (sourceType === "planner_derived") {
      const dayRefs = (Array.isArray(item?.sourceRefs) ? item.sourceRefs : []).map(cleanText).filter((ref) => /(?:^|\b)day(?:s)?[-.:[\] ]?\d+/i.test(ref));
      if (dayRefs.length === 1) errors.push({ code: "ordinary_day_highlight_promoted", message: `不能用单个 DAY 体验补产品亮点：${sourceText}` });
    }
  }
  const selectedSourceCount = selected.filter((item) => item?.sourceType === "source_designated" && sourceDesignated.has(cleanText(item?.sourceText))).length;
  const requiredSourceCount = Math.min(7, sourceDesignated.size);
  if (selectedSourceCount < requiredSourceCount) errors.push({ code: "source_highlight_priority_missing", message: "Planner 未先保留原始报价单已指定的产品亮点" });
  const selectedOfficialCount = selected.filter((item) => item?.sourceType === "official_product" && officialProducts.has(cleanText(item?.sourceText))).length;
  const requiredOfficialCount = Math.min(officialProducts.size, Math.max(0, 5 - requiredSourceCount));
  if (selectedOfficialCount < requiredOfficialCount) {
    errors.push({ code: "official_product_priority_missing", message: "来源指定亮点不足5条时，必须先从已确认奢游服务价值中选择，不能直接用DAY体验补足" });
  }
  return errors;
}

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
      estimatedTravelTime: cleanText(day.estimatedTravelTime) || null,
      movementPaceDescriptor: cleanText(day.movementPaceDescriptor) || null,
      activityLevel: cleanText(day.activityLevel) || null,
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
    sourcePosterHighlights: posterHighlightLines(Array.isArray(data.sourcePosterHighlights) ? data.sourcePosterHighlights : []).slice(0, 20),
    officialProductValues: publicSheyouProductValues(),
  };
}

export function validateSimpleDayVisuals(plan, factBasis = {}) {
  const errors = [];
  const counts = new Map();
  const slots = plan.imagePlan?.slots || [];
  const enforceUnifiedContract = Object.keys(factBasis || {}).length > 0;
  const visualFingerprints = new Map();
  const normalizedVisual = (value) => cleanText(value).toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, "");
  const queryValues = (slot = {}) => {
    const hasUnifiedQueries = "fidelityQuery" in slot || "alternateQueries" in slot;
    if (hasUnifiedQueries) return [cleanText(slot.fidelityQuery), ...(Array.isArray(slot.alternateQueries) ? slot.alternateQueries.map(cleanText) : [])].filter(Boolean);
    return Array.isArray(slot.searchIntent) ? slot.searchIntent.map(cleanText).filter(Boolean) : cleanText(slot.searchIntent) ? [cleanText(slot.searchIntent)] : [];
  };
  const isAbstractVisual = (slot = {}) => {
    const coreSubject = cleanText(slot.queryCore?.subject || slot.primaryVisualSubject).replace(/\s+/g, "");
    return /^(?:(?:机场)?(?:抵达|到达|送机|接机|离境|返程|转场|入住|退房|用餐体验|自由活动|送别)){1,3}(?:场景|体验|安排)?$/i.test(coreSubject)
      || /^(?:airport\s*)?(?:arrival|departure|send[- ]?off|transfer|check[- ]?in|check[- ]?out|dining experience|free time)$/i.test(cleanText(slot.queryCore?.subject || slot.primaryVisualSubject));
  };
  const slotError = (slotRole, code, message, extra = {}) => ({ code, path: "imagePlan.slots", message, slotRoles: [slotRole].filter(Boolean), ...extra });
  for (const slot of slots) {
    const primaryVisualSubject = cleanText(slot.primaryVisualSubject);
    const roleLabel = slot.role || slot.slotId || "图片位";
    if (!primaryVisualSubject) errors.push(slotError(roleLabel, "image_visual_subject_missing", `${roleLabel} 缺少明确的 primaryVisualSubject；必须说明图片里真正要看到的单一主体和动作`));
    const hotelRole = /^hotel:(\d+)$/.exec(String(slot.role || ""));
    if (hotelRole) {
      const hotel = (factBasis.hotels || [])[Number(hotelRole[1]) - 1] || {};
      const hotelNames = [slot.label, hotel.officialName, hotel.shortName, hotel.name].map(cleanText).filter(Boolean);
      const subjectKey = primaryVisualSubject.toLocaleLowerCase("en").replace(/[\s\-–—_,，.。·:：'’\"“”()（）/\\]+/g, "");
      if (subjectKey && hotelNames.some((name) => name.toLocaleLowerCase("en").replace(/[\s\-–—_,，.。·:：'’\"“”()（）/\\]+/g, "") === subjectKey)) {
        errors.push(slotError(roleLabel, "hotel_visual_subject_unspecified", `${slot.role}.primaryVisualSubject 不能只写酒店名“${primaryVisualSubject}”；必须选择一个实际可见的酒店画面，例如外观、客房、公共空间或资料明确的特色设施`));
      }
    }
    const queries = queryValues(slot);
    const queryValidation = validatePlannerSearchIntent(queries);
    if (!queryValidation.valid) errors.push(slotError(roleLabel, "invalid_image_search_queries", `${roleLabel} 的Planner Query不合格：${queryValidation.errors.join("；")}`));
    if (enforceUnifiedContract) {
      if (!cleanText(slot.queryCore?.subject)) errors.push(slotError(roleLabel, "image_visible_subject_missing", `${roleLabel} 缺少queryCore.subject；Planner必须明确真正入镜主体`));
      if (!cleanText(slot.location)) errors.push(slotError(roleLabel, "image_location_missing", `${roleLabel} 缺少location；Planner必须明确Scope地点`));
      if (!["scope_only", "visual_identity"].includes(slot.locationRole)) errors.push(slotError(roleLabel, "image_location_role_invalid", `${roleLabel}.locationRole必须是scope_only或visual_identity`));
      if (!cleanText(slot.fidelityQuery)) errors.push(slotError(roleLabel, "image_fidelity_query_missing", `${roleLabel} 缺少第一条画面保真fidelityQuery`));
      if (!Array.isArray(slot.alternateQueries) || slot.alternateQueries.length < 1 || slot.alternateQueries.length > 3) errors.push(slotError(roleLabel, "image_alternate_queries_invalid", `${roleLabel}.alternateQueries必须提供1—3条同画面搜索Query`));
      if (slot.locationRole === "scope_only") {
        const leaked = queries.find((query) => cleanupPlannerQueryScope(query, slot).scopeCleanup);
        if (leaked) errors.push(slotError(roleLabel, "scope_only_location_in_query", `${roleLabel}把仅用于Scope的地点或身份写进Query：${leaked}`));
      }
    }
    if (isAbstractVisual(slot)) errors.push(slotError(roleLabel, "abstract_visual_subject", `${roleLabel}只描述了抵达、离境、接送、入住或用餐等抽象事件；必须改成一张能够直接拍出来的具体主体与动作`));
    if (/或|或者|二选一|\bor\b|\//i.test(primaryVisualSubject)) errors.push(slotError(roleLabel, "ambiguous_visual_subject", `${roleLabel}.primaryVisualSubject 当前值“${primaryVisualSubject}”仍然是A或B；必须选定一个具体画面`));
    const subjectIssue = visualSubjectPolicyIssue(primaryVisualSubject, slot.queryCore);
    if (subjectIssue) errors.push(slotError(roleLabel, "composite_visual_subject", `${roleLabel}.primaryVisualSubject 当前值“${primaryVisualSubject}”合并了多个可独立找图的画面；必须保留一个或拆成独立图片位`));
    const coreFingerprint = [slot.queryCore?.identity, slot.queryCore?.subject, slot.queryCore?.action].map(normalizedVisual).filter(Boolean).join("|");
    const visualFingerprint = coreFingerprint || normalizedVisual(primaryVisualSubject);
    if (visualFingerprint) {
      const existingRole = visualFingerprints.get(visualFingerprint);
      if (existingRole) errors.push(slotError(roleLabel, "duplicate_visual_responsibility", `${existingRole}与${roleLabel}承担了完全相同的可见主体、动作和身份；同一体验跨模块时必须规划不同视觉画面`, { conflictingRole: existingRole }));
      else visualFingerprints.set(visualFingerprint, roleLabel);
    }
    const match = /^day:(\d+)(?::supporting:\d+)?$/.exec(slot.role || "");
    if (!match) continue;
    const day = match[1];
    counts.set(day, (counts.get(day) || 0) + 1);
    if (String(slot.role || "").includes("supporting") && (slot.required !== false || slot.removable !== true)) errors.push(slotError(roleLabel, "invalid_supporting_visual", `${slot.role} 辅助图必须可移除且非必需`));
  }
  for (const [day, count] of counts) if (count > 4) errors.push({ code: "day_visual_overflow", path: "imagePlan.slots", message: `DAY ${day} 最多4个视觉点，不得平均覆盖所有Spot` });
  const requiredSearchRoles = Object.keys(factBasis || {}).length ? [
    "cover",
    ...(factBasis.hotels || []).map((_, index) => `hotel:${index + 1}`),
    ...(factBasis.diningExperiences || []).map((_, index) => `dining:${index + 1}`),
    ...(factBasis.transport || []).map((_, index) => `transport:${index + 1}`),
    ...(factBasis.days || []).map((_, index) => `day:${index + 1}`),
  ] : [];
  for (const role of requiredSearchRoles) {
    if (!slots.some((slot) => slot.role === role)) errors.push(slotError(role, "image_search_plan_missing", `缺少 ${role} 的Planner图片搜索计划、画面主体、locationRole和2—4条Query`));
  }
  return errors;
}

function deterministicPlannerSlotFields(role, factBasis = {}) {
  const hotel = /^hotel:(\d+)$/.exec(role);
  const dining = /^dining:(\d+)$/.exec(role);
  const transport = /^transport:(\d+)$/.exec(role);
  const day = /^day:(\d+)$/.exec(role);
  const supporting = /^day:(\d+):supporting:(\d+)$/.exec(role);
  if (role === "cover") return { slotId: "planner:cover", label: "封面", required: true, removable: false };
  if (hotel) {
    const item = (factBasis.hotels || [])[Number(hotel[1]) - 1] || {};
    return { slotId: `planner:${role}`, label: cleanText(item.officialName || item.shortName || item.name) || `酒店 ${hotel[1]}`, required: true, removable: false };
  }
  if (dining) {
    const item = (factBasis.diningExperiences || [])[Number(dining[1]) - 1] || {};
    return { slotId: `planner:${role}`, label: cleanText(item.title || item.officialName || item.name) || `特色餐饮 ${dining[1]}`, required: false, removable: true };
  }
  if (transport) {
    const item = (factBasis.transport || [])[Number(transport[1]) - 1] || {};
    return { slotId: `planner:${role}`, label: cleanText(item.category || item.title || item.label) || `交通 ${transport[1]}`, required: false, removable: true };
  }
  if (day) return { slotId: `planner:${role}`, label: `DAY ${day[1]}`, required: true, removable: false };
  if (supporting) return { slotId: `planner:${role}`, label: `DAY ${supporting[1]} 辅助视觉 ${supporting[2]}`, required: false, removable: true };
  return null;
}

export function fillPlannerImageDeterministicFields(raw = {}, factBasis = {}) {
  const next = structuredClone(raw);
  if (!Array.isArray(next.imagePlan?.slots)) return next;
  next.imagePlan.slots = next.imagePlan.slots.map((slot) => {
    const role = cleanText(slot?.role);
    const deterministic = deterministicPlannerSlotFields(role, factBasis);
    if (!deterministic) return slot;
    return {
      ...deterministic,
      ...slot,
      slotId: cleanText(slot.slotId) || deterministic.slotId,
      label: cleanText(slot.label) || deterministic.label,
      required: typeof slot.required === "boolean" ? slot.required : deterministic.required,
      removable: typeof slot.removable === "boolean" ? slot.removable : deterministic.removable,
    };
  });
  return next;
}

function assemblePlan(raw, context, previousPlanId, callStats) {
  const now = new Date().toISOString();
  const normalizedRaw = fillPlannerImageDeterministicFields(raw, context.factBasis);
  const compiled = compileAgentExecutionPlan(normalizedRaw, context);
  const tasks = compiled.tasks;
  const imagePlan = filterImagePlanForModules(normalizedRaw?.imagePlan || { visualStory: "", slots: [] }, compiled.modules);
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
    summary: normalizedRaw?.summary,
    selectedHighlights: Array.isArray(normalizedRaw?.selectedHighlights) ? normalizedRaw.selectedHighlights : [],
    factBasis: context.factBasis,
    dayRoles: Array.isArray(normalizedRaw?.dayRoles) ? normalizedRaw.dayRoles : [],
    contentPlacement: Array.isArray(normalizedRaw?.contentPlacement) ? normalizedRaw.contentPlacement : [],
    modules: compiled.modules,
    copyPlan: compiled.copyPlan,
    webVerification: Array.isArray(normalizedRaw?.webVerification) ? normalizedRaw.webVerification : [],
    imagePlan,
    tasks,
    checkpointCoverage: [...new Set(tasks.flatMap((task) => Array.isArray(task.checkpointIds) ? task.checkpointIds : []))],
    confirmations: Array.isArray(normalizedRaw?.confirmations) ? normalizedRaw.confirmations : [],
    adjustments: Array.isArray(normalizedRaw?.adjustments) ? normalizedRaw.adjustments : [],
    validation: { passed: false, correctionUsed: false, errors: [] },
    capabilityCallStats: AGENT_CAPABILITIES.map((item) => ({ capabilityId: item.id, actualCalls: callStats[item.id] || 0, plannedTasks: tasks.filter((task) => task.capabilityIds?.includes(item.id)).length })),
  };
}

const QUERY_REPAIRABLE_CODES = new Set([
  "invalid_image_search_queries",
  "image_fidelity_query_missing",
  "image_alternate_queries_invalid",
  "scope_only_location_in_query",
]);

function compactPlannerErrors(errors = []) {
  return errors.slice(0, 60).map(({ code, path, message, slotRoles, conflictingRole }) => ({
    code,
    path,
    message,
    ...(Array.isArray(slotRoles) && slotRoles.length ? { slotRoles } : {}),
    ...(conflictingRole ? { conflictingRole } : {}),
  }));
}

function fallbackPlannerRaw(factBasis = {}, reason = "planner_system_failure") {
  const sourceSelections = posterHighlightLines(factBasis.sourcePosterHighlights).map((sourceText) => ({ sourceText, sourceType: "source_designated", sourceRefs: [], selectionReason: "原始资料已指定" }));
  const officialSelections = (factBasis.officialProductValues || []).map((item) => ({ sourceText: cleanText(item?.sourceText), sourceType: "official_product", sourceRefs: item?.sourceRefs || [], selectionReason: "已确认产品价值" })).filter((item) => item.sourceText);
  const selectedHighlights = [...sourceSelections];
  for (const item of officialSelections) if (selectedHighlights.length < 5 && !selectedHighlights.some((existing) => existing.sourceText === item.sourceText)) selectedHighlights.push(item);
  return {
    summary: {
      contentTheme: `${factBasis.destination || "本次目的地"}行程内容`,
      visualTheme: "图片位等待人工确认",
      planningRationale: `Planner单次调用未形成完整可用计划（${reason}）；已保留原始事实并将无法确定的图片位交给Step4。`,
    },
    modules: [],
    dayRoles: (factBasis.days || []).map((day, index) => ({ index, role: cleanText(day.route) || `DAY ${index + 1}`, differenceFromAdjacent: "", primaryVisualSubject: "", contentAction: "optimize", sourceRefs: [`days.${index}`] })),
    contentPlacement: [],
    webVerification: [],
    imagePlan: { visualStory: "", slots: [] },
    selectedHighlights: selectedHighlights.slice(0, 7),
    confirmations: [],
    adjustments: [],
  };
}

function applyPlannerFailOpen(plan, validationErrors = []) {
  const next = structuredClone(plan);
  const repairs = [];
  const unresolvedRoles = new Set();
  const issuesByRole = new Map();
  for (const issue of validationErrors) {
    for (const role of issue.slotRoles || []) {
      if (!issuesByRole.has(role)) issuesByRole.set(role, []);
      issuesByRole.get(role).push(issue);
    }
  }

  const keptSlots = [];
  const dayCounts = new Map();
  const suppressedSlots = [];
  for (const slot of next.imagePlan?.slots || []) {
    const dayMatch = /^day:(\d+)(?::supporting:\d+)?$/.exec(String(slot.role || ""));
    if (dayMatch) {
      const count = dayCounts.get(dayMatch[1]) || 0;
      dayCounts.set(dayMatch[1], count + 1);
      if (count >= 4 && String(slot.role || "").includes(":supporting:")) {
        suppressedSlots.push({ ...slot, plannerSlotStatus: "unresolved", needsUserAction: true, plannerValidationIssues: [{ code: "day_visual_overflow", message: `DAY ${dayMatch[1]} 超出4张上限，该可选图片位未进入自动搜索` }] });
        unresolvedRoles.add(slot.role);
        continue;
      }
    }
    keptSlots.push(slot);
  }
  next.imagePlan = { ...(next.imagePlan || {}), slots: keptSlots, ...(suppressedSlots.length ? { suppressedSlots } : {}) };

  next.imagePlan.slots = next.imagePlan.slots.map((slot) => {
    const role = slot.role || slot.slotId || "图片位";
    const issues = issuesByRole.get(role) || [];
    const localRepairs = [];
    let unresolved = issues.some((issue) => !QUERY_REPAIRABLE_CODES.has(issue.code) && issue.code !== "invalid_supporting_visual");
    let repaired = { ...slot };

    if (issues.some((issue) => issue.code === "invalid_supporting_visual") && String(role).includes(":supporting:")) {
      repaired.required = false;
      repaired.removable = true;
      localRepairs.push({ code: "supporting_flags_normalized", message: "已确定性恢复为可移除、非必需辅助图片位" });
    }

    if (issues.some((issue) => QUERY_REPAIRABLE_CODES.has(issue.code))) {
      const queryPlan = buildKnowledgeQueryPlan(repaired, null);
      if (queryPlan.queries.length >= 2 && !queryPlan.validationError) {
        repaired.fidelityQuery = queryPlan.queries[0];
        repaired.alternateQueries = queryPlan.queries.slice(1, 4);
        repaired.searchIntent = queryPlan.queries.slice(0, 4);
        localRepairs.push({ code: "queries_locally_repaired", message: "已仅使用Planner拆好的主体、动作和身份完成Query清洗", querySteps: queryPlan.querySteps });
      } else {
        unresolved = true;
      }
    }

    if (unresolved) unresolvedRoles.add(role);
    if (localRepairs.length) repairs.push({ role, repairs: localRepairs });
    return {
      ...repaired,
      plannerSlotStatus: unresolved ? "unresolved" : localRepairs.length ? "locally_repaired" : "ready",
      needsUserAction: unresolved,
      plannerValidationIssues: issues.map(({ code, message, conflictingRole }) => ({ code, message, ...(conflictingRole ? { conflictingRole } : {}) })),
      plannerLocalRepairs: localRepairs,
    };
  });

  for (const issue of validationErrors) {
    if (issue.code === "image_search_plan_missing") for (const role of issue.slotRoles || []) unresolvedRoles.add(role);
  }
  return { plan: next, repairs, unresolvedSlotRoles: [...unresolvedRoles] };
}

export async function generateAgentPlan({ project, apiKey, baseUrl, model, requestJson = requestDeepSeekJson, onStatus, onModelAttempt, signal, simpleSkillContract = false }) {
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
  const simpleContractPrompt = "simple-skill-pipeline 额外接口：在原有 JSON 字段之外返回 selectedHighlights 数组。每项只含 sourceText、sourceType(source_designated|official_product|planner_derived)、sourceRefs、selectionReason，不写最终客户文案。你必须在本次规划中最终确定实际采用的亮点集合：第一优先逐条读取 factBasis.sourcePosterHighlights；第二优先只能从 factBasis.officialProductValues 选择奢游已确认服务/产品价值，sourceText 必须原样引用对应候选；前两类仍不足5条时才补充整程级购买理由。目标5—7条，真实事实不足时允许少于5条并在 selectionReason 说明素材不足。不得把普通DAY细节拔高，也不得把 DAY 中的自费热气球标成 official_product。图片规划必须读取封面、每个酒店、每个独立餐饮、每种交通和每个 DAY 的完整事实；对应role使用cover、hotel:N、dining:N、transport:N、day:N。Planner是图片画面的唯一决定者；每个图片位在同一次Planner调用内必须返回primaryVisualSubject、location、locationRole、queryCore、fidelityQuery和alternateQueries。locationRole只能是scope_only或visual_identity。queryCore只用subject/action/identity/subjectEn/actionEn/identityEn：subject是真正必须入镜的通用可见主体，action是定义画面的关键动作且静态画面可为空，identity只供Scope和身份审核。fidelityQuery是一条简短可搜索的第一条画面保真Query，alternateQueries是1—3条同画面的补充Query，合计2—4条；第一条不要求与queryCore逐字相同，同义表达不得因文字差异被改写。locationRole=scope_only时地点和目录身份不得进入任何Query；若地标、实体或命名身份本身必须入镜，必须改成locationRole=visual_identity，而不是一边写scope_only一边把身份留在Query。普通时间、氛围、构图和费用状态不得进入Query。两条准确Query已经足够，不得凑满四条。以上按字段语义通用执行，不得针对国家、动物、酒店、景点或当前案例建立专用词表。dayRoles.primaryVisualSubject只能选已有真实活动并结合differenceFromAdjacent，不能机械取spots[0]或虚构差异；徒步/夜游、文化体验和真实存在的可选活动都可以承担DAY主视觉，自费/可选/待确认体验成为视觉重点时必须保留状态。封面只能有一个核心焦点。DAY、酒店、餐饮、交通和封面每个slot都只能是一张具体可拍画面，禁止A或B、抽象抵达/离境/用餐概念或两个独立体验。输出前以queryCore.identity+subject+action为每个slot生成视觉职责键并全量去重；封面与DAY、独立模块与DAY也不能重复。同一体验跨模块存在时，必须选择不同的可见主体或动作，若DAY已有其他真实高价值画面则优先改用该画面，不能只改primaryVisualSubject或Query措辞。原始资料明确写有游猎时不得判断为无游猎。";
  const dayVisualPrompt = "DAY 图片继续只使用 imagePlan.slots。每个 DAY 保留一个role为day:N的主视觉；允许0—3个role为day:N:supporting:1等的辅助视觉。不要输出slotId、label、required或removable，这些属性由程序根据role补齐。普通体验日根据真实视觉价值选择2—4个不同视觉点，内容少则1—2个，纯返程日只保留一个具体可拍的收尾主视觉；不得用抽象的抵达、送机离境、入住、用餐体验或自由活动充当画面。有限图片位内按以下顺序选择：独家或稀缺体验；来源明确的景点、设施或活动；有强视觉主体的动物、地标、自然事件或特色体验；能够与同日其他画面形成真实差异的场景；普通全天、清晨、傍晚游猎只在没有更高价值真实视觉时作为兜底。此顺序按字段语义通用判断，不绑定国家、项目或DAY。每个slot必须选定一个明确场景，禁止A或B、A/B和两个独立体验；同一真实画面可以包含多个自然共现主体。两个不同场景值得展示时拆成两个slot，每天最多4张。primaryVisualSubject只写真正需要入镜的主体和动作。命名地点只是搜索范围时写入location并设locationRole=scope_only；只有地点、地标、建筑、入口、标牌或实体本身必须入镜时才设locationRole=visual_identity并允许Query保留名称。主题可以来自完整experience，不要求与Spot同名。主视觉与dayRoles主线一致，辅助图只能补充主线。每个slot分别输出fidelityQuery和1—3条alternateQueries，中文精准词在前，必要英文同义表达在后；不能照抄primaryVisualSubject长句，不能写时间氛围、姿态构图、图片职责或泛词。两条准确Query已经足够；sourceRefs指向当天原始事实。";
  const visualCoveragePrompt = '输出前逐日复核视觉覆盖，不得把允许辅助图误解为默认每天仅一个主图。只有一个真正高价值视觉点可选1个；普通体验日通常1—2个；完整experience中存在多个明确、差异化、高价值体验时必须选择2—4个，分别写成primary与supporting，而非合并进一个泛化游猎主题。若当日真实资料同时有象群与雪山、Observation Hill、步行Safari、夜间游猎，这四种画面应分别规划；示例不是事实，其他线路不得照搬。纯返程或简单送机只需一个收尾视觉，不强迫补足。禁止以接送、入住或重复场景凑数。用现有visualDuty/differentiation说明选择价值和覆盖范围；sourceRefs优先精确引用对应days.N.spots.M或当日事实摘录，便于保留原费用状态，不新增schema。';
  callStats.trip_planner = 1;
  onStatus?.({ status: "planning", message: "正在制定单次轻量业务规划" });
  const dayNumbering = (project.factBasis?.days || []).map((day, i) => `DAY${i + 1}: dayRoles.index=${i}; imagePlan主图role=day:${i + 1}; 辅助role=day:${i + 1}:supporting:1等；只消费factBasis.days[${i}]。`).join('\n');
  const systemMessages = [{ role: 'system', content: [prompt, ...(simpleSkillContract ? [simpleContractPrompt, dayVisualPrompt, visualCoveragePrompt, '最终检查：不能只返回最低必需图片集合。请先逐日识别有事实支持、彼此不同的高价值场景，再把所选集合完整写入imagePlan.slots；辅助视觉是正式计划的一部分，不要仅在dayRole文字中提到却省略slot。DAY编号从1开始，只有数组index从0开始，严禁day:0、漏日或跨日借用。以下映射必须逐行覆盖：', dayNumbering] : [])].join('\n\n') }];
  const messages = [...systemMessages, { role: "user", content: JSON.stringify(sharedInput) }];
  const attemptStartedAt = new Date().toISOString();
  let raw;
  let response = null;
  let plannerSystemError = null;
  let plannerAttemptUsages = [];
  try {
    response = await requestJson({ apiKey, baseUrl, model, messages, reasoningEffort: "high", maxTokens: 30000, timeoutMs: 180_000, emptyContentRetries: 1, allowSyntaxRepair: true, onModelAttempt, signal, onStatus: (event) => onStatus?.({ status: "planning", message: event.streamPhase === "retrying" ? "首次未取得完整规划，正在关闭深度思考后补取最终答案" : "规划模型正在返回单次业务计划", provider: { streamPhase: event.streamPhase, receivedContentChars: event.receivedContentChars } }) });
    plannerAttemptUsages = Array.isArray(response.attemptUsages) ? response.attemptUsages : [];
    raw = response.json;
  } catch (error) {
    plannerAttemptUsages = Array.isArray(error?.attemptUsages) ? error.attemptUsages : [];
    plannerSystemError = { code: error?.code || "planner_system_failure", message: error?.message || String(error) };
    raw = fallbackPlannerRaw(factBasis, plannerSystemError.code);
  }
  const plannerModelCalls = Math.max(1, plannerAttemptUsages.length || 1);
  callStats.trip_planner = plannerModelCalls;

  if (!Array.isArray(raw.selectedHighlights)) raw.selectedHighlights = [];
  if (raw.selectedHighlights.length > 7) raw.selectedHighlights = raw.selectedHighlights.slice(0, 7);
  const plan = assemblePlan(raw, context, project.activePlanId, callStats);
  onStatus?.({ status: "checking", message: "正在本地检查并隔离有问题的图片位" });
  const validation = validateAgentPlan(plan, context);
  if (simpleSkillContract) {
    validation.errors.push(...validateSimpleHighlightSelection(raw, factBasis));
    validation.errors.push(...validateSimpleDayVisuals(plan, factBasis));
  }
  if (plannerSystemError) validation.errors.unshift({ code: plannerSystemError.code, path: "$", message: plannerSystemError.message });
  validation.valid = validation.errors.length === 0;
  const failOpen = applyPlannerFailOpen(plan, validation.errors);
  const compactErrors = compactPlannerErrors(validation.errors);
  const completed = {
    ...failOpen.plan,
    validatedAt: new Date().toISOString(),
    validation: {
      passed: validation.valid,
      failOpen: !validation.valid,
      correctionUsed: false,
      plannerBusinessRuns: 1,
      plannerModelCalls,
      technicalRetryUsed: plannerModelCalls > 1,
      errors: compactErrors,
      unresolvedSlotRoles: failOpen.unresolvedSlotRoles,
      localRepairs: failOpen.repairs,
      ...(plannerSystemError ? { plannerSystemError } : {}),
    },
  };
  attempts.push({ attemptId: randomUUID(), index: 1, createdAt: attemptStartedAt, completedAt: new Date().toISOString(), status: plannerSystemError ? "failed_open" : "completed", rawModelPlan: raw, parseResult: response?.parseResult || null, validation: { ...validation, failOpen: !validation.valid, unresolvedSlotRoles: failOpen.unresolvedSlotRoles }, model: response?.model || model, usage: response?.usage || null, attemptUsages: plannerAttemptUsages });
  return { plan: completed, attempts };
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
