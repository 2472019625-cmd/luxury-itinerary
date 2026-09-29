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
import { resolveScenePreference } from "./image-scene-preferences.mjs";
import { visualSubjectPolicyIssue } from "./visual-subject-policy.mjs";
import { highlightToText } from "../src/lib/highlightDisplay.js";
import { SLOT_VISUAL_CONTRACT, buildDayVisualCoverageTasks } from "./planner-visual-contract.mjs";

export const AGENT_PROMPT_VERSION = "agent-trip-planner-v13-explicit-day-coverage";
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
  const transportScope = (item) => {
    const dayNumbers = [...(item.usageSegments || []), ...(item.sourceEvidence || [])]
      .map((entry) => Number(/\bDAY\s*(\d+)\b/i.exec(cleanText(entry))?.[1]))
      .filter((number) => Number.isInteger(number) && number > 0 && number <= days.length);
    if (!dayNumbers.length) return null;
    const matched = [...new Set(dayNumbers)].map((number) => days[number - 1]);
    const locations = unique(matched.flatMap((day) => Array.isArray(day.routeNodes) ? day.routeNodes.map(cleanText).filter(Boolean) : []));
    if (locations.length === 1) return locations[0];
    const country = cleanText(data.country || data.destination);
    return country && country.length <= 20 && !/[\d→+＋、，,;；\/｜|]/u.test(country) ? country : null;
  };
  const hotels = (Array.isArray(data.hotels) ? data.hotels : []).map((hotel, index) => ({
    sourceIndex: index,
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
    transport: (Array.isArray(data.transportSummary) ? data.transportSummary : []).map((item, index) => ({ sourceIndex: index, id: cleanText(item.id) || `transport-${index + 1}`, category: cleanText(item.category || item.title || item.label), serviceLevel: cleanText(item.serviceLevel), model: cleanText(item.model) || null, modelGuaranteed: item.modelGuaranteed === true, usageLabel: cleanText(item.usageLabel) || null, usageSegments: item.usageSegments || [], scopeLocation: transportScope(item), features: item.features || [], status: item.status || null, currentCopy: cleanText(item.editorialCopy || item.description) })).filter((item) => item.category).slice(0, 20),
    diningExperiences: (Array.isArray(data.diningExperiences) ? data.diningExperiences : []).map((item, index) => ({ sourceIndex: index, id: cleanText(item.id) || `dining-${index + 1}`, name: cleanText(item.title || item.officialName), officialName: cleanText(item.officialName) || null, location: cleanText(item.location) || null, status: item.status || item.feeBoundary || null, currentCopy: cleanText(item.editorialCopy) })).filter((item) => item.name).slice(0, 20),
    coreExperiences: unique([...(Array.isArray(data.highlights) ? data.highlights.map(highlightToText) : []), ...days.map((day) => cleanText(day.title || day.route))]).slice(0, 24),
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
      if (slot.exactIdentityRequired === false) errors.push(slotError(roleLabel, "hotel_identity_required", `${slot.role}展示具体预订酒店，不能省略不可替代身份约束`));
      const hotelNames = [slot.label, hotel.officialName, hotel.shortName, hotel.name].map(cleanText).filter(Boolean);
      const subjectKey = primaryVisualSubject.toLocaleLowerCase("en").replace(/[\s\-–—_,，.。·:：'’\"“”()（）/\\]+/g, "");
      if (subjectKey && hotelNames.some((name) => name.toLocaleLowerCase("en").replace(/[\s\-–—_,，.。·:：'’\"“”()（）/\\]+/g, "") === subjectKey)) {
        errors.push(slotError(roleLabel, "hotel_visual_subject_unspecified", `${slot.role}.primaryVisualSubject 不能只写酒店名“${primaryVisualSubject}”；必须选择一个实际可见的酒店画面，例如外观、客房、公共空间或资料明确的特色设施`));
      }
      const specificVisual = hotelSpecificVisualDisposition(slot, factBasis);
      if (specificVisual) errors.push(slotError(roleLabel, specificVisual.code, specificVisual.message));
    }
    const queries = queryValues(slot);
    const queryValidation = validatePlannerSearchIntent(queries);
    if (!queryValidation.valid) errors.push(slotError(roleLabel, "invalid_image_search_queries", `${roleLabel} 的Planner Query不合格：${queryValidation.errors.join("；")}`));
    if (enforceUnifiedContract) {
      if (typeof slot.exactIdentityRequired !== "boolean") errors.push(slotError(roleLabel, "image_exact_identity_invalid", `${roleLabel}.exactIdentityRequired必须是boolean，不得按名称或类型推断`));
      if (slot.exactIdentityRequired === true && !cleanText(slot.queryCore?.identity)) errors.push(slotError(roleLabel, "image_exact_identity_missing", `${roleLabel}要求具体身份，但queryCore.identity为空`));
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
    // A per-person/night price is a commercial status note, not an A/B visual
    // choice. Keep the original text and facts; only exclude that unit slash
    // from the visual-alternative check.
    const visualChoiceText = primaryVisualSubject.replace(/\d[\d,.]*\s*(?:美金|美元|人民币|元|USD|CNY)?\s*\/\s*(?:人|位|晚|天|间|车)/gi, "");
    if ([visualChoiceText, ...Object.values(slot.queryCore || {})].some((value) => /或|或者|二选一|\bor\b|\//i.test(cleanText(value)))) errors.push(slotError(roleLabel, "ambiguous_visual_subject", `${roleLabel}的视觉描述或Core包含替代项；必须明确核心目标，只有可证明的代表空间或非核心背景选择可局部归一`));
    const branchConflict = conflictingVisualQueryBranch(slot, visualChoiceText, queries);
    if (branchConflict) errors.push(slotError(roleLabel, "visual_query_branch_conflict", `${roleLabel}的查询“${branchConflict.query}”指向另一画面主体“${branchConflict.alternative}”，与queryCore.subject“${branchConflict.coreSubject}”冲突；不能选第一支或继续搜索`));
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
  if (Object.keys(factBasis || {}).length) {
    const coverage = reconcilePlannerImageCandidates(plan, factBasis);
    for (const position of coverage.positions) {
      if (position.status === "missing_required") errors.push(slotError(position.role, "image_search_plan_missing", `必需位置 ${position.role} 缺少Planner图片搜索计划`));
      if (position.status === "missing_optional") errors.push(slotError(position.role, "image_optional_plan_unaccounted", `可选位置 ${position.role} 未规划且未明确省略`));
      if (position.status === "duplicate") errors.push(slotError(position.role, "image_slot_role_duplicate", `${position.role} 被重复规划`));
      if (position.status === "conflict") errors.push(slotError(position.role, "image_optional_omission_conflict", `${position.role} 同时已规划且声明省略`));
    }
    for (const role of coverage.unexpectedRoles) errors.push(slotError(role, "image_slot_role_unknown", `Planner输出了不属于原始事实候选位置的role：${role || "(空)"}`));
    for (const role of coverage.invalidOmissions) errors.push(slotError(role, "image_optional_omission_invalid", `仅可明确省略原始事实中的可选图片位置：${role}`));
    if (plan.imagePlan?.omittedOptionalRoles !== undefined && !Array.isArray(plan.imagePlan.omittedOptionalRoles)) {
      errors.push({ code: "image_optional_omission_invalid", path: "imagePlan.omittedOptionalRoles", message: "omittedOptionalRoles必须是role数组" });
    }
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
      required: deterministic.required,
      removable: deterministic.removable,
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

// These positions come from parsed facts and layout obligations, before the
// Planner chooses any visual. DAY supporting pictures remain Planner-selected
// from actual day evidence rather than one mechanically assigned per Spot.
export function buildPlannerImageCandidates(factBasis = {}) {
  const candidates = [{ role: "cover", sourceKey: "destination", slotId: "image:cover:primary", required: true, removable: false }];
  for (const [index, hotel] of (factBasis.hotels || []).entries()) candidates.push({
    role: `hotel:${index + 1}`, sourceKey: `hotels.${Number.isInteger(hotel.sourceIndex) ? hotel.sourceIndex : index}`, slotId: `image:hotel:${hotel.id || index + 1}:primary`, required: true, removable: false,
  });
  for (const [index, dining] of (factBasis.diningExperiences || []).entries()) candidates.push({
    role: `dining:${index + 1}`, sourceKey: `diningExperiences.${Number.isInteger(dining.sourceIndex) ? dining.sourceIndex : index}`, slotId: `image:dining:${dining.id || index + 1}:primary`, required: false, removable: true,
  });
  for (const [index, transport] of (factBasis.transport || []).entries()) candidates.push({
    role: `transport:${index + 1}`, sourceKey: `transport.${Number.isInteger(transport.sourceIndex) ? transport.sourceIndex : index}`, slotId: `image:transport:${transport.id || index + 1}:primary`, required: false, removable: true,
  });
  for (const [index] of (factBasis.days || []).entries()) candidates.push({
    role: `day:${index + 1}`, sourceKey: `days.${index}`, slotId: `image:day:${index + 1}:primary`, required: true, removable: false,
  });
  return candidates;
}

export function reconcilePlannerImageCandidates(plan = {}, factBasis = {}) {
  const slots = Array.isArray(plan.imagePlan?.slots) ? plan.imagePlan.slots : [];
  const omissions = Array.isArray(plan.imagePlan?.omittedOptionalRoles) ? plan.imagePlan.omittedOptionalRoles : [];
  const candidates = buildPlannerImageCandidates(factBasis);
  const positions = candidates.map((candidate) => {
    const plannedCount = slots.filter((slot) => slot.role === candidate.role).length;
    const omitted = omissions.includes(candidate.role);
    const status = plannedCount > 1 ? "duplicate" : plannedCount && omitted ? "conflict"
      : plannedCount ? "planned" : omitted && !candidate.required ? "omitted_optional"
        : candidate.required ? "missing_required" : "missing_optional";
    return { ...candidate, status };
  });
  const knownRoles = new Set(candidates.map((candidate) => candidate.role));
  const dayCount = (factBasis.days || []).length;
  const isAllowedSupporting = (role) => {
    const match = /^day:(\d+):supporting:([1-3])$/.exec(cleanText(role));
    return match && Number(match[1]) >= 1 && Number(match[1]) <= dayCount;
  };
  return {
    positions,
    unexpectedRoles: slots.map((slot) => cleanText(slot.role)).filter((role) => !knownRoles.has(role) && !isAllowedSupporting(role)),
    invalidOmissions: omissions.filter((role) => !candidates.some((candidate) => candidate.role === role && !candidate.required)),
  };
}

function dayVisualCoverage(plan = {}, factBasis = {}) {
  const slots = Array.isArray(plan.imagePlan?.slots) ? plan.imagePlan.slots : [];
  return (factBasis.days || []).map((_, dayIndex) => {
    const prefix = `day:${dayIndex + 1}`;
    const planned = slots.filter((slot) => slot.role === prefix || slot.role?.startsWith(`${prefix}:supporting:`));
    const unresolved = planned.filter((slot) => slot.plannerSlotStatus === "unresolved" || slot.needsUserAction === true);
    return {
      dayIndex,
      roles: planned.map((slot) => slot.role),
      plannedCount: planned.length,
      searchableCount: planned.length - unresolved.length,
      unresolvedRoles: unresolved.map((slot) => slot.role),
      sourceRefs: planned.map((slot) => ({ role: slot.role, refs: Array.isArray(slot.sourceRefs) ? slot.sourceRefs : [] })),
      visualDuties: planned.map((slot) => ({ role: slot.role, duty: cleanText(slot.visualDuty), differentiation: cleanText(slot.differentiation) })),
    };
  });
}

const visualChoicePattern = /或者|或|二选一|\bor\b|\//i;
const visualWordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
const visualWords = (value) => [...visualWordSegmenter.segment(cleanText(value).normalize("NFKC").toLowerCase())]
  .filter((part) => part.isWordLike).map((part) => part.segment);

// Diagnose an explicit cross-branch query only when the Core subject is
// literally one side of an A/B visual. This is deliberately narrower than
// semantic similarity: another language or synonym cannot be declared wrong
// by text alone, and a genuine choice still stays unresolved either way.
function conflictingVisualQueryBranch(slot, visual, queries) {
  if (/^hotel:\d+$/.test(cleanText(slot.role))) return null; // ordinary same-hotel representative spaces have a separate controlled repair
  const coreSubject = cleanText(slot.queryCore?.subject);
  if (!coreSubject || visualChoicePattern.test(coreSubject)) return null;
  const normalizedCore = visualKey(coreSubject);
  for (const marker of visual.matchAll(/或者|或|二选一|\bor\b|\//gi)) {
    const left = visual.slice(0, marker.index).trim();
    const right = visual.slice(marker.index + marker[0].length).trim();
    const leftIsCore = visualKey(left).endsWith(normalizedCore);
    const rightIsCore = visualKey(right).startsWith(normalizedCore);
    if (leftIsCore === rightIsCore) continue;
    const alternative = leftIsCore ? visualWords(right)[0] : visualWords(left).at(-1);
    if (!alternative || visualKey(alternative).length < 2 || visualKey(alternative) === normalizedCore) continue;
    const query = queries.find((candidate) => visualKey(candidate).includes(visualKey(alternative)));
    if (query) return { query, alternative, coreSubject };
  }
  return null;
}
function includesWordSequence(words, expected) {
  return expected.length > 0 && words.some((_, index) => expected.every((word, offset) => words[index + offset] === word));
}

// These are the four existing hotel representative categories, not an entity
// alias dictionary. Unknown qualifiers (room types, exclusive facilities, etc.)
// deliberately do not match and remain specific-scene decisions.
const hotelRepresentativeCategories = [
  ["exterior", /^(?:(?:城市酒店|酒店|营地|度假村)?(?:建筑外观|建筑|外观)|(?:(?:(?:city\s+)?hotel|camp|resort)\s+)?(?:building\s+exterior|building|exterior))$/i],
  ["suite", /^(?:(?:城市酒店|酒店|营地|度假村)?(?:套房|客房)|(?:(?:(?:city\s+)?hotel|camp|resort)\s+)?(?:suites?|(?:guest\s*)?rooms?))$/i],
  ["pool", /^(?:(?:城市酒店|酒店|营地|度假村)?(?:游泳池|泳池)|(?:(?:(?:city\s+)?hotel|camp|resort)\s+)?(?:swimming\s+)?pools?)$/i],
  ["main_areas", /^(?:(?:城市酒店|酒店|营地|度假村)?(?:公共空间|公共区域|大堂(?:公共区域|公共空间)?)|(?:(?:(?:city\s+)?hotel|camp|resort)\s+)?(?:public\s+(?:spaces?|areas?)|lobb(?:y|ies)))$/i],
];
const splitVisualChoices = (value) => cleanText(value).split(/或者|或|二选一|\bor\b|\//i).map(cleanText);
const visualKey = (value) => cleanText(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function ordinaryHotelCategoryText(value) {
  // Only these generic presentation modifiers are removable. Room classes,
  // private facilities, booked views, actions and another hotel name must
  // stay in the text and fail the four-category representative parser.
  return cleanText(value).replace(/^的(?=\p{L})/u, "")
    .replace(/^(?:(?:现代|当代|都市|城市)\s*)+/u, "")
    .replace(/^(?:(?:modern|contemporary|urban|city)\s+)+/i, "").trim();
}
const hotelCategory = (value) => hotelRepresentativeCategories.find(([, pattern]) => pattern.test(ordinaryHotelCategoryText(value)))?.[0];
const ordinaryViewPreference = /(?:城市|天际线|山脉?|海洋?|湖泊?|河流?|草原|花园|公园|自然)(?:景观|视野)$|\b(?:city|skyline|mountain|ocean|sea|lake|river|savanna|garden|park|landscape)\s+views?$/i;

function hotelVisualCategory(value) {
  const neutral = cleanText(value).replace(/(?:现代|真实|代表性|整体|画面)/g, "")
    .replace(/\b(?:modern|real|representative)\b/gi, "").trim();
  const direct = hotelCategory(neutral) || hotelCategory(neutral.replace(/空间$/, ""));
  if (direct) return { category: direct, preference: "" };
  const preference = ordinaryViewPreference.exec(neutral);
  if (!preference) return null;
  const category = hotelCategory(neutral.slice(0, preference.index).trim());
  return category === "suite" ? { category, preference: preference[0] } : null;
}

function ordinarySingleHotelSpace(value) {
  const text = cleanText(value);
  const chinese = /^(?:(?:现代|当代|都市|城市|奢华|豪华|帐篷|营地|酒店|度假村|开放式|公共|普通|标准|建筑|的)\s*)*(?:建筑外观|外观|建筑|套房|客房|房间|帐篷套房|游泳池|泳池|大堂|公共空间|公共休息区|休息区)(?:内部|室内|空间|场景)?$/u;
  const english = /^(?:(?:modern|contemporary|urban|city|luxury|tented|camp|hotel|resort|open|public|standard|building)\s+)*(?:building exterior|exterior|building|suite|guest room|room|swimming pool|pool|lobby|public space|public lounge|lounge)(?:\s+(?:interior|inside|space))?$/i;
  return chinese.test(text) || english.test(text);
}

function hotelSpecificVisualDisposition(slot, factBasis = {}) {
  const role = /^hotel:(\d+)$/.exec(cleanText(slot.role));
  const hotel = role && (factBasis.hotels || [])[Number(role[1]) - 1];
  const hotelName = cleanText(hotel?.name || hotel?.officialName);
  const visual = cleanText(slot.primaryVisualSubject);
  const core = slot.queryCore || {};
  const visualWithoutPrice = visual.replace(/\d[\d,.]*\s*(?:美金|美元|人民币|元|USD|CNY)?\s*\/\s*(?:人|位|晚|天|间|车)/gi, "");
  if (!hotelName || !visual || visualChoicePattern.test(visualWithoutPrice)
    || [core.subject, core.action, core.identity].some((value) => visualChoicePattern.test(cleanText(value)))) return null;
  const coreIdentity = cleanText(core.identity);
  const coreSubject = cleanText(core.subject);
  const visualStartsWithHotel = visual.toLocaleLowerCase("en").startsWith(hotelName.toLocaleLowerCase("en"));
  const visualDetail = visualStartsWithHotel ? visual.slice(hotelName.length).trim().replace(/^的/u, "") : visual;
  const ordinaryCore = !cleanText(core.action) && !cleanText(core.actionEn) && (hotelCategory(coreSubject) || /^(?:酒店代表性空间|representative hotel space)$/i.test(coreSubject));
  const ordinaryVisual = hotelVisualCategory(visualDetail);
  if (ordinaryCore && ordinaryVisual && coreIdentity === hotelName) return null;
  // A single ordinary hotel space may legitimately be described with more
  // texture than the four A/B representative categories. Only a concrete
  // room class, private facility or action is eligible for this repair; an
  // unrecognized but otherwise ordinary hotel photo is left unchanged.
  const specificScene = cleanText(core.action) || cleanText(core.actionEn)
    || /房型|私人|私家|专属|独享|总统|专用|(?:private|exclusive|presidential|room\s*type|booked)\b/i.test(`${visualDetail} ${coreSubject}`)
    || (/(?:套房|客房|房间|泳池|游泳池|\b(?:suite|room|pool|villa)\b)/i.test(coreSubject)
      && !ordinarySingleHotelSpace(coreSubject));
  if (!specificScene) return null;

  const sourceText = (factBasis.days || []).flatMap((day) => [day.experience, ...(day.spots || []).map((spot) => `${cleanText(spot.name)} ${cleanText(spot.description)}`)])
    .map(cleanText).filter(Boolean);
  const subjectKey = visualKey(coreSubject);
  const actionKey = visualKey(`${cleanText(core.action)} ${cleanText(core.actionEn)}`);
  const specificWords = unique(visualWords(`${coreSubject} ${cleanText(core.action)}`).filter((word) =>
    visualKey(word).length >= 2 && !/^(?:酒店|营地|公共|区域|外观|空间|客房|套房|房型|体验)$/u.test(word)));
  const supportsTargetDetail = (value) => {
    const key = visualKey(value);
    return Boolean(key && (subjectKey.length >= 4 && key.includes(subjectKey)
      || actionKey.length >= 4 && key.includes(actionKey)
      || specificWords.filter((word) => key.includes(visualKey(word))).length >= 2));
  };
  const explicitDayPromise = sourceText.some((text) => text.split(/[。！？\n]/u).some((sentence) =>
    sentence.toLocaleLowerCase("en").includes(hotelName.toLocaleLowerCase("en"))
      && supportsTargetDetail(sentence)));
  const hotelPromise = (/(?:房型|客房|套房|房间|\b(?:room|suite|villa)\b)/i.test(coreSubject) && cleanText(hotel.roomType))
    || [hotel.signatureExperience, hotel.selectionReason].some(supportsTargetDetail);
  const otherKnownHotel = (factBasis.hotels || []).some((item) => item !== hotel && cleanText(item.name)
    && visual.toLocaleLowerCase("en").includes(cleanText(item.name).toLocaleLowerCase("en")));
  const joinedHotelSpaces = /(?:与|和|及|以及|\band\b|&)/i.test(coreSubject)
    && [/(?:建筑|外观|\b(?:building|exterior)\b)/i, /(?:客房|套房|房间|\b(?:room|suite)\b)/i,
      /(?:泳池|游泳池|\bpool\b)/i, /(?:公共空间|公共区域|大堂|\b(?:public\s+(?:space|area)|lobby)\b)/i]
      .filter((pattern) => pattern.test(coreSubject)).length >= 2;
  const anotherNamedProperty = /(?:和|与|及|以及|\band\b|&)\s*[\p{L}][\p{L} .'-]{0,80}(?:\b(?:Hotel|Lodge|Camp|Resort)\b|酒店|营地|度假村)/iu.test(visualDetail);
  const identitySuffix = coreIdentity.startsWith(hotelName) ? coreIdentity.slice(hotelName.length).trim() : "";
  const identityUnsafe = !coreIdentity.startsWith(hotelName)
    || (identitySuffix && (/(?:酒店|营地|度假村|\b(?:hotel|lodge|camp|resort)\b)/i.test(identitySuffix)
      || ![visual, coreSubject].some((value) => visualKey(value).includes(visualKey(identitySuffix)))));
  const unsafe = !visualStartsWithHotel || identityUnsafe || otherKnownHotel || joinedHotelSpaces || anotherNamedProperty
    || visualSubjectPolicyIssue(visual, core);
  if (hotelPromise || explicitDayPromise || unsafe) return {
    code: "hotel_specific_visual_source_unconfirmed",
    message: `${slot.role}选择了具体房型、设施或动作，但酒店身份、专属来源或本次承诺不能由结构化酒店事实安全确认；保留原目标等待处理，不降级为代表图`,
  };
  return {
    code: "hotel_specific_visual_unbound",
    message: `${slot.role}把没有酒店专属来源承诺的具体房型、设施或动作作为必需主图目标；仅归一为同一酒店代表空间，不改原始DAY体验`,
  };
}

function repairUnboundHotelSpecificVisual(slot, factBasis = {}) {
  if (hotelSpecificVisualDisposition(slot, factBasis)?.code !== "hotel_specific_visual_unbound") return null;
  const role = /^hotel:(\d+)$/.exec(cleanText(slot.role));
  const hotelName = cleanText((factBasis.hotels || [])[Number(role[1]) - 1]?.name);
  const queryCore = { ...slot.queryCore, subject: "酒店代表性空间", action: "", identity: hotelName,
    subjectEn: "representative hotel space", actionEn: "", identityEn: hotelName };
  const primaryVisualSubject = `${hotelName} 酒店代表性空间`;
  const queries = buildKnowledgeQueryPlan({ ...slot, moduleType: "hotel", hotel: hotelName, queryCore, primaryVisualSubject }, null).queries;
  return { primaryVisualSubject, queryCore, fidelityQuery: queries[0], alternateQueries: queries.slice(1), searchIntent: queries,
    repair: { code: "hotel_unbound_specific_visual_normalized", message: "酒店主图缺少专属房型或设施的酒店来源承诺，已恢复同店代表空间与完整酒店身份", originalPrimaryVisualSubject: slot.primaryVisualSubject, originalQueryCore: slot.queryCore, primaryVisualSubject } };
}

export function repairHotelRepresentativeChoice(slot, factBasis) {
  const hotelRole = /^hotel:(\d+)$/.exec(cleanText(slot.role));
  const hotel = hotelRole && (factBasis.hotels || [])[Number(hotelRole[1]) - 1];
  const core = slot.queryCore || {};
  if (!hotel || slot.exactIdentityRequired !== true || !cleanText(core.identity)
    || [core.identity, core.identityEn, core.action, core.actionEn].some((value) => visualChoicePattern.test(cleanText(value)))
    || cleanText(core.action) || cleanText(core.actionEn)) return null;
  const identityNames = unique([core.identity, core.identityEn].map(cleanText));
  const factNames = [hotel.name, hotel.officialName, hotel.shortName].map(visualKey).filter(Boolean);
  if (!factNames.includes(visualKey(core.identity))) return null;
  const stripIdentity = (value) => {
    let result = cleanText(value);
    for (const identity of [...identityNames].sort((a, b) => b.length - a.length)) {
      if (result.toLowerCase().startsWith(identity.toLowerCase())) return result.slice(identity.length).trim();
    }
    return result;
  };
  const subjects = [core.subject, core.subjectEn].map(stripIdentity).filter(Boolean);
  const categorySets = subjects.map((subject) => splitVisualChoices(subject).map(hotelCategory));
  const alreadyRepresentative = subjects.length > 0 && subjects.every((subject) => /^(?:酒店代表性空间|representative hotel space)$/i.test(subject));
  if (!alreadyRepresentative && (!categorySets.length || categorySets.some((items) => items.length < 1 || items.length > 4 || items.some((item) => !item)))) return null;
  const sameCategories = (items) => unique(items).sort().join("|") === unique(categorySets[0]).sort().join("|");
  if (!alreadyRepresentative && !categorySets.every(sameCategories)) return null;
  const singleCoreCategory = !alreadyRepresentative && categorySets[0].length === 1 ? categorySets[0][0] : "";
  let visual = cleanText(slot.primaryVisualSubject);
  for (const identity of identityNames.sort((a, b) => b.length - a.length)) {
    visual = visual.replaceAll(identity, "");
  }
  // Permit only neutral presentation wording around those category names.
  // An unbound second entity or a named/private facility is not neutral.
  const visualCategories = splitVisualChoices(visual).map(part => {
    // Canonical representative Core permits generic lodging presentation;
    // named rooms, private facilities and other entities still fail parsing.
    const neutral = alreadyRepresentative ? part.trim().replace(/^(?:(?:帐篷)?(?:营地|度假)?酒店|帐篷营地|营地|度假村)的?/, "") : part;
    if (alreadyRepresentative && /^(?:代表性空间|representative (?:hotel )?space)$/i.test(neutral)) {
      return { category: "representative", preference: "" };
    }
    return hotelVisualCategory(neutral);
  });
  if (visualCategories.length < 2 || visualCategories.length > 4 || visualCategories.some((item) => !item)) return null;
  const categoryNames = visualCategories.map((item) => item.category);
  if (!alreadyRepresentative && (singleCoreCategory
    ? !categoryNames.includes(singleCoreCategory) || unique(categoryNames).length < 2
    : !sameCategories(categoryNames))) return null;
  if (cleanText(hotel.roomType) && categoryNames.includes("suite")) return null;
  const preferences = visualCategories.map((item) => item.preference).filter(Boolean);
  const sourceClaimsView = preferences.some((preference) => [hotel.currentCopy, hotel.selectionReason, hotel.signatureExperience]
    .some((fact) => visualKey(fact).includes(visualKey(preference))));
  if (sourceClaimsView) return null;
  const queryCore = { ...core, subject: "酒店代表性空间", ...(cleanText(core.subjectEn) ? { subjectEn: "representative hotel space" } : {}) };
  const primaryVisualSubject = `${cleanText(core.identity)} 酒店代表性空间`;
  const queries = buildKnowledgeQueryPlan({ ...slot, moduleType: "hotel", hotel: core.identity, queryCore, primaryVisualSubject }, null).queries;
  return { primaryVisualSubject, queryCore, fidelityQuery: queries[0], alternateQueries: queries.slice(1), searchIntent: queries,
    repair: { code: "hotel_representative_choice_resolved", message: "已按同一酒店代表图的既有空间类别归一，完整身份与硬门槛不变", originalPrimaryVisualSubject: slot.primaryVisualSubject, originalQueryCore: core, originalQueries: [slot.fidelityQuery, ...(slot.alternateQueries || [])], primaryVisualSubject, allowedCategories: unique(categoryNames), ...(preferences.length ? { softViewPreferences: preferences } : {}) } };
}

function repairBackgroundWithExistingQueries(slot) {
  const core = slot.queryCore || {};
  const values = [core.subject, core.action, core.identity, core.subjectEn, core.actionEn, core.identityEn].map(cleanText);
  if (slot.exactIdentityRequired !== false || !values[0] || values.some((value) => visualChoicePattern.test(value))) return null;
  const queries = [cleanText(slot.fidelityQuery), ...(slot.alternateQueries || []).map(cleanText)];
  if (!validatePlannerSearchIntent(queries).valid || queries.some((query) => visualChoicePattern.test(query))) return null;
  const languages = [{ subject: values[0], action: values[1] }, ...(values[3] && (!values[1] || values[4]) ? [{ subject: values[3], action: values[4] }] : [])];
  const supportsCore = (value, language) => [language.subject, language.action].filter(Boolean)
    .every((part) => includesWordSequence(visualWords(value), visualWords(part)));
  const supportsSubject = (value, { subject }) => {
    const words = visualWords(value);
    const expected = visualWords(subject);
    if (includesWordSequence(words, expected)) return true;
    // Chinese noun compounds may include an extra function word (商务用车 /
    // 商务车). Require ordered multiword coverage and the same head noun;
    // this does not translate synonyms or infer a missing action.
    let cursor = -1;
    const matched = expected.filter((word) => {
      const at = words.indexOf(word, cursor + 1);
      if (at < 0) return false;
      cursor = at;
      return true;
    });
    return expected.length >= 2 && matched.length >= 2 && matched.length * 3 >= expected.length * 2
      && matched.at(-1) === expected.at(-1);
  };
  if (!queries.some((query) => languages.some((language) => supportsCore(query, language)))
    || !queries.every((query) => languages.some((language) => supportsSubject(query, language)))) return null;
  const preference = resolveScenePreference(slot);
  if (!preference) return null;
  return { primaryVisualSubject: preference.primaryVisualSubject, repair: {
    code: "background_visual_choice_resolved", message: "保留结构化主体动作和有效原查询，仅移除非核心画面偏好",
    originalPrimaryVisualSubject: slot.primaryVisualSubject, ...preference } };
}

function repairBackgroundVisualChoice(slot) {
  const existing = repairBackgroundWithExistingQueries(slot);
  if (existing) return existing;
  // Synonymous transfer queries need not repeat the action verb literally,
  // but every existing query must still refer to the selected subject.
  const subjects = [slot.queryCore?.subject, slot.queryCore?.subjectEn].filter(Boolean).flatMap(visualWords)
    .filter(word => word.length >= 2);
  const originalQueries = [slot.fidelityQuery, ...(slot.alternateQueries || [])].map(cleanText).filter(Boolean);
  if (originalQueries.some(query => visualChoicePattern.test(query)
    || !visualWords(query).some(word => subjects.includes(word)))) return null;
  const preference = resolveScenePreference(slot);
  if (!preference) return null;
  const queries = buildKnowledgeQueryPlan({ ...slot, primaryVisualSubject: preference.primaryVisualSubject,
    fidelityQuery: "", alternateQueries: [], searchIntent: [] }, null);
  if (queries.validationError || queries.queries.length < 2) return null;
  return { primaryVisualSubject: preference.primaryVisualSubject,
    fidelityQuery: queries.queries[0], alternateQueries: queries.queries.slice(1), searchIntent: queries.queries,
    repair: { code: "background_visual_choice_resolved", message: "保留完整结构化主体动作，仅移除非核心画面偏好",
      originalPrimaryVisualSubject: slot.primaryVisualSubject, ...preference } };
}

function repairEquivalentVisualChoice(slot) {
  const core = slot.queryCore || {};
  const fields = [core.subject, core.action, core.identity, core.subjectEn, core.actionEn, core.identityEn].map(cleanText);
  if (typeof slot.exactIdentityRequired !== "boolean" || (slot.exactIdentityRequired && !fields[2])
    || !fields[0] || fields.some((field) => visualChoicePattern.test(field))) return null;
  const alternatives = cleanText(slot.primaryVisualSubject).split(/或者|或|二选一|\bor\b|\//i).map(cleanText);
  if (alternatives.length < 2 || alternatives.length > 3 || alternatives.some((part) => !part)) return null;
  const queries = [cleanText(slot.fidelityQuery), ...(Array.isArray(slot.alternateQueries) ? slot.alternateQueries.map(cleanText) : [])];
  if (!validatePlannerSearchIntent(queries).valid || queries.some((query) => visualChoicePattern.test(query))) return null;
  const identities = unique([fields[2], fields[5]]).map(visualWords);
  const languages = [{ subject: fields[0], action: fields[1] },
    ...(fields[3] && (!fields[1] || fields[4]) ? [{ subject: fields[3], action: fields[4] }] : [])]
    .map(({ subject, action }) => ({ subject: visualWords(subject), action: visualWords(action) }));
  const supports = (value, { subject, action }, full = false, branch = false) => {
    const words = visualWords(value);
    if (action.length && !includesWordSequence(words, action)) return false;
    if (full) return includesWordSequence(words, subject)
      && (slot.exactIdentityRequired !== true || identities.some((identity) => includesWordSequence(words, identity)));
    // A shared generic word alone cannot prove that two choices are the same
    // subject. Accept only a complete multiword Core, or its ordered fragments
    // ending at the subject itself (never a different facility/action suffix).
    if (subject.length < 2) return false;
    if (!branch && includesWordSequence(words, subject)) return true;
    const withoutContext = [...words];
    for (const context of [...identities, action].filter((part) => part.length)) {
      for (let index = withoutContext.length - context.length; index >= 0; index -= 1) {
        if (context.every((word, offset) => withoutContext[index + offset] === word)) withoutContext.splice(index, context.length);
      }
    }
    let cursor = -1;
    const matched = subject.filter((word) => {
      const index = withoutContext.indexOf(word, cursor + 1);
      if (index < 0) return false;
      cursor = index;
      return true;
    });
    return matched.length >= 2 && matched.length * 3 >= subject.length * 2
      && matched.at(-1) === withoutContext.at(-1);
  };
  if (!languages.some((language) => alternatives.every((part) => supports(part, language, false, true)))) return null;
  if (!queries.every((query) => languages.some((language) => supports(query, language)))) return null;
  const supportingQuery = queries.find((query) => languages.some((language) => supports(query, language, true)));
  if (!supportingQuery) return null;
  const primaryVisualSubject = unique([slot.exactIdentityRequired === true ? fields[2] : "", fields[0], fields[1]]).join(" ");
  if (visualSubjectPolicyIssue(primaryVisualSubject, core)) return null;
  return { primaryVisualSubject, repair: {
    code: "equivalent_visual_choice_resolved",
    message: "已按Planner明确且由原查询共同佐证的同一主体与动作消解画面二选一描述",
    originalPrimaryVisualSubject: slot.primaryVisualSubject,
    primaryVisualSubject,
    supportingQuery,
  } };
}

export function repairTransportOverviewPose(slot, factBasis, { allowCoreActionChoices = false } = {}) {
  const role = /^transport:(\d+)$/.exec(cleanText(slot.role));
  const transport = role && (factBasis.transport || [])[Number(role[1]) - 1];
  if (!transport || slot.exactIdentityRequired !== false || slot.locationRole !== "scope_only") return null;
  const core = slot.queryCore || {};
  if (!/飞机|aircraft|plane/i.test(`${transport.category} ${transport.serviceLevel}`)
    || !/飞机|aircraft|plane/i.test(cleanText(core.subject))
    || [core.subject, core.identity, core.subjectEn, core.identityEn].some((value) => visualChoicePattern.test(cleanText(value)))) return null;
  const visual = cleanText(slot.primaryVisualSubject);
  if (allowCoreActionChoices && visualSubjectPolicyIssue(visual, core)) return null;
  const ordinaryPose = /(?:起飞|降落|起降|停靠|停放|飞行中|飞行|空中|跑道|taking[ -]?off|landing|parked|flying|in[ -]?flight|airstrip|runway)/i;
  // A single Chinese scene can have ordinary pose alternatives in its English
  // Core. Automatic and manual callers use the same fact-backed recovery.
  const choiceText = allowCoreActionChoices && !visualChoicePattern.test(visual)
    ? [core.action, core.actionEn].map(cleanText).find((value) => visualChoicePattern.test(value)) || visual
    : visual;
  const choices = splitVisualChoices(choiceText);
  if (choices.length !== 2 || !choices.every((part) => ordinaryPose.test(part))
    || !/飞机|aircraft|plane/i.test(visual)
    || /专属机场|private\s+airport|航站楼|terminal|直升机|热气球|船只?|商务车|越野车|helicopter|balloon|boat/i.test(`${visual} ${core.subject} ${core.identity}`)) return null;
  const sourceDays = (transport.usageSegments || []).flatMap((entry) => {
    const number = Number(/\bDAY\s*(\d+)\b/i.exec(cleanText(entry))?.[1]);
    return Number.isInteger(number) && number > 0 ? [(factBasis.days || [])[number - 1]] : [];
  }).filter(Boolean);
  if (!sourceDays.length) return null;
  if (allowCoreActionChoices && (transport.modelGuaranteed || cleanText(transport.model))) return null;
  const sourceFacts = sourceDays.flatMap((day) => [day.experience, day.vehicle,
    ...(allowCoreActionChoices ? (day.spots || []).flatMap((spot) => [spot.name, spot.description]) : []),
  ]).filter(Boolean).join(" ");
  const sourceDetails = allowCoreActionChoices ? [transport.currentCopy, ...(transport.features || [])].filter(Boolean).join(" ") : "";
  if (/航拍|空中观光|观景飞行|低空飞越|起飞|降落|停靠|停放|飞行中|scenic[ -]?flight|aerial[ -]?tour|taking[ -]?off|landing|parked/i.test(`${sourceFacts} ${transport.usageLabel || ""} ${sourceDetails}`)
    || /航拍体验|空中观光|观景飞行|低空飞越|scenic[ -]?flight|aerial[ -]?tour/i.test(visual)
    || allowCoreActionChoices && /航拍|空中观光|观景飞行|低空飞越|起降体验|scenic[ -]?flight|aerial[ -]?tour/i.test(`${visual} ${slot.visualGoal || ""}`)) return null;
  const onlyOrdinaryMotion = (value) => !cleanText(value).replace(/(?:在|于)?[^或\s]{0,16}?(?:跑道)(?:上)?/gu, "")
    .replace(/\b(?:on|at)\s+(?:a\s+)?(?:[a-z-]+\s+){0,3}(?:airstrip|runway)\b/gi, "")
    .replace(/起飞|降落|起降|停靠|停放|飞行中|飞行|空中|taking[ -]?off|landing|parked|flying|in[ -]?flight|flight/gi, "")
    .replace(/或者|或|\bor\b|[\s,，.。/\-]+/gi, "");
  if (!onlyOrdinaryMotion(core.action) || !onlyOrdinaryMotion(core.actionEn)) return null;
  const subject = /(?:在|于).*(?:跑道|airstrip|runway)|\b(?:on|at)\s+(?:a\s+)?(?:dirt\s+)?(?:airstrip|runway)/i.test(cleanText(core.subject))
    ? cleanText(transport.serviceLevel || transport.category) : cleanText(core.subject);
  const queryCore = { ...core, subject, subjectEn: cleanText(core.subjectEn).replace(/\s+\b(?:on|at)\s+(?:a\s+)?(?:dirt\s+)?(?:airstrip|runway).*$/i, ""), action: "", actionEn: "" };
  const primaryVisualSubject = subject;
  if (visualSubjectPolicyIssue(primaryVisualSubject, queryCore)) return null;
  const queryPlan = buildKnowledgeQueryPlan({ ...slot, queryCore, primaryVisualSubject }, null);
  if (queryPlan.validationError || queryPlan.queries.length < 2) return null;
  return { primaryVisualSubject, queryCore, fidelityQuery: queryPlan.queries[0], alternateQueries: queryPlan.queries.slice(1, 4), searchIntent: queryPlan.queries.slice(0, 4),
    repair: { code: "transport_overview_pose_normalized", message: "交通概览保留原始飞机类型，普通跑道或空中姿态只作表现偏好", originalPrimaryVisualSubject: slot.primaryVisualSubject, originalQueryCore: structuredClone(core), primaryVisualSubject } };
}

function boundVisualSource(slot, factBasis) {
  const role = /^(day|dining|hotel|transport):(\d+)(?::supporting:\d+)?$/.exec(cleanText(slot.role));
  if (!role && slot.role !== "cover") return false;
  const sourceKey = role && ({ day: "days", dining: "diningExperiences", hotel: "hotels", transport: "transport" })[role[1]];
  const item = role && factBasis[sourceKey]?.[Number(role[2]) - 1];
  if (role && !item) return false;
  const prefix = role && `${sourceKey}.${item.sourceIndex ?? Number(role[2]) - 1}`;
  return (Array.isArray(slot.sourceRefs) ? slot.sourceRefs : []).some(ref => {
    if (typeof ref !== "string" || !/^(days|hotels|diningExperiences|transport)\.\d+(?:\.[\w]+)*$/.test(ref)) return false;
    if (prefix && ref !== prefix && !ref.startsWith(`${prefix}.`)) return false;
    // References use original source indices; filtered fact arrays need mapping.
    const [key, index, ...parts] = ref.split(".");
    let value = key === "days" ? factBasis.days?.[Number(index)]
      : factBasis[key]?.find((entry, position) => (entry.sourceIndex ?? position) === Number(index));
    for (const part of parts) value = value && Object.hasOwn(value, part) ? value[part] : undefined;
    return value != null && value !== "" && (!Array.isArray(value) || value.length > 0);
  });
}

function repairCrossModuleDuplicate(slot, first, factBasis, slots) {
  const isDay = target => /^day:\d+(?::supporting:\d+)?$/.test(target.role);
  // Do not manufacture extra same-day scenes or collapse hotel spaces. This
  // recovery serves a DAY and an existing cover/module with the same Core.
  if (!first || isDay(slot) === isDay(first)
    || !boundVisualSource(slot, factBasis) || !boundVisualSource(first, factBasis)) return null;
  const day = /^(day:\d+):supporting:/.exec(slot.role);
  const coreKey = target => [target.queryCore?.identity, target.queryCore?.subject, target.queryCore?.action].map(visualKey).filter(Boolean).join("|");
  if (day && slots.some(other => other !== slot && (other.role === day[1] || other.role.startsWith(`${day[1]}:supporting:`))
    && coreKey(other) === coreKey(slot))) return null;
  const queries = buildKnowledgeQueryPlan(slot, null);
  if (queries.validationError || queries.queries.length < 2) return null;
  return { code: "cross_module_distinct_photo_search", message: "保留已确认核心目标，跨模块分别搜索不同照片；沿用全局文件与近似图去重",
    conflictingRole: first.role, corePreserved: true, requireDistinctPhoto: true };
}

function completePlannerObjectEnd(source, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) return -1;
      if (!stack.length) return index + 1;
    }
  }
  return -1;
}

export function recoverCompletePlannerImageSlots(attemptContents = []) {
  let best = [];
  for (const content of attemptContents) {
    const source = String(content || "").slice(0, 250_000);
    const planMatch = /"imagePlan"\s*:\s*\{/.exec(source);
    if (!planMatch) continue;
    const planBodyStart = planMatch.index + planMatch[0].length;
    const slotsMatch = /"slots"\s*:\s*\[/.exec(source.slice(planBodyStart));
    if (!slotsMatch) continue;
    const arrayAt = planBodyStart + slotsMatch.index + slotsMatch[0].length - 1;
    const slots = [];
    const seen = new Set();
    let cursor = arrayAt + 1;
    while (cursor < source.length && slots.length < 80) {
      while (/[\s,]/.test(source[cursor] || "")) cursor += 1;
      if (source[cursor] !== "{") break;
      const end = completePlannerObjectEnd(source, cursor);
      if (end < 0) break;
      try {
        const slot = JSON.parse(source.slice(cursor, end));
        const role = cleanText(slot?.role);
        if (/^(?:cover|(?:hotel|dining|transport):\d+|day:\d+(?::supporting:\d+)?)$/.test(role) && !seen.has(role)) {
          slots.push(slot);
          seen.add(role);
        }
      } catch { /* Malformed slot is never reconstructed from guesses. */ }
      cursor = end;
    }
    if (slots.length > best.length) best = slots;
  }
  return best;
}

function applyPlannerFailOpen(plan, validationErrors = [], factBasis = {}) {
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

  const omittedEmptyRoles = new Set();
  const candidates = new Map(buildPlannerImageCandidates(factBasis).map(item => [item.role, item]));
  const plannedSlots = next.imagePlan?.slots || [];
  const omissions = new Set(next.imagePlan?.omittedOptionalRoles || []);
  const keptSlots = [];
  const dayCounts = new Map();
  const suppressedSlots = [];
  for (const slot of next.imagePlan?.slots || []) {
    const candidate = candidates.get(slot.role);
    const core = slot.queryCore || {};
    if (candidate && candidate.required === false && omissions.has(slot.role) && !slot.userLocked && slot.required !== true
      && plannedSlots.filter(item => item.role === slot.role).length === 1
      && [core.subject, core.action, core.identity, core.subjectEn, core.actionEn, core.identityEn,
        slot.fidelityQuery, ...(slot.alternateQueries || []), ...(slot.searchIntent || [])].every(value => !cleanText(value))) {
      omittedEmptyRoles.add(slot.role);
      repairs.push({ role: slot.role, repairs: [{ code: "empty_omitted_optional_slot_removed",
        message: "遵从显式可选位省略声明，移除没有检索目标的空任务", originalSlot: structuredClone(slot) }] });
      continue;
    }
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
    let repaired = { ...slot };
    const visualRepair = issues.some((issue) => issue.code === "ambiguous_visual_subject")
      ? repairHotelRepresentativeChoice(slot, factBasis) || (boundVisualSource(slot, factBasis) ? repairBackgroundVisualChoice(slot) : null) || repairEquivalentVisualChoice(slot)
        || (boundVisualSource(slot, factBasis) ? repairTransportOverviewPose(slot, factBasis, { allowCoreActionChoices: true }) : null)
      : issues.some((issue) => issue.code === "hotel_specific_visual_unbound") ? repairUnboundHotelSpecificVisual(slot, factBasis) : null;
    if (visualRepair) {
      const { repair, ...fields } = visualRepair;
      Object.assign(repaired, fields);
      localRepairs.push(repair);
    }
    const transportRole = /^transport:(\d+)$/.exec(cleanText(role));
    const scopeLocation = transportRole && cleanText((factBasis.transport || [])[Number(transportRole[1]) - 1]?.scopeLocation);
    const scopeRepair = issues.some((issue) => issue.code === "image_location_missing")
      && repaired.locationRole === "scope_only" && !cleanText(repaired.location) && scopeLocation;
    if (scopeRepair) {
      repaired.location = scopeLocation;
      localRepairs.push({ code: "transport_scope_location_restored", message: "仅从该交通项对应DAY路线及已确认目的地恢复检索Scope", location: scopeLocation });
    }
    let unresolved = issues.some((issue) => !QUERY_REPAIRABLE_CODES.has(issue.code) && issue.code !== "invalid_supporting_visual"
      && !(issue.code === "ambiguous_visual_subject" && visualRepair)
      && !(issue.code === "image_location_missing" && scopeRepair)
      && !(issue.code === "hotel_specific_visual_unbound" && visualRepair?.repair.code === "hotel_unbound_specific_visual_normalized"));

    if (issues.some((issue) => issue.code === "invalid_supporting_visual") && String(role).includes(":supporting:")) {
      repaired.required = false;
      repaired.removable = true;
      localRepairs.push({ code: "supporting_flags_normalized", message: "已确定性恢复为可移除、非必需辅助图片位" });
    }

    if (issues.some((issue) => QUERY_REPAIRABLE_CODES.has(issue.code))) {
      const querySlot = ["hotel_representative_choice_resolved", "hotel_unbound_specific_visual_normalized"].includes(visualRepair?.repair.code)
        ? { ...repaired, moduleType: "hotel", hotel: repaired.queryCore.identity } : repaired;
      const queryPlan = buildKnowledgeQueryPlan(querySlot, null);
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

  // Local repairs may make two formerly different strings the same target.
  // Recheck only that invariant; never trigger a second planning request.
  const repairedTargets = new Map();
  for (const slot of next.imagePlan.slots) {
    const key = [slot.queryCore?.identity, slot.queryCore?.subject, slot.queryCore?.action].map(visualKey).filter(Boolean).join("|");
    if (!key) continue;
    const first = repairedTargets.get(key);
    if (first && (slot.plannerLocalRepairs.length || first.plannerLocalRepairs.length)
      && !slot.plannerValidationIssues.some((issue) => issue.code === "duplicate_visual_responsibility")) {
      slot.plannerSlotStatus = "unresolved";
      slot.needsUserAction = true;
      slot.plannerValidationIssues.push({ code: "duplicate_visual_responsibility", message: "局部归一后与已有图片位承担相同核心视觉职责", conflictingRole: first.role });
      unresolvedRoles.add(slot.role);
    } else if (!first) repairedTargets.set(key, slot);
  }

  // A repeated Core across a DAY and another module is a composition concern,
  // not a reason to skip all retrieval. Only release this specific issue after
  // repairs have passed the same slot validator; retain every other blocker.
  const remainingErrors = validateSimpleDayVisuals(next, factBasis);
  for (const slot of next.imagePlan.slots) {
    const duplicates = slot.plannerValidationIssues.filter(issue => issue.code === "duplicate_visual_responsibility");
    if (!duplicates.length || slot.userLocked
      || remainingErrors.some(issue => issue.code !== "duplicate_visual_responsibility" && issue.slotRoles?.includes(slot.role))
      || slot.plannerValidationIssues.some(issue => !["duplicate_visual_responsibility", ...QUERY_REPAIRABLE_CODES, "invalid_supporting_visual"].includes(issue.code))) continue;
    const duplicateRepairs = duplicates.map(issue => repairCrossModuleDuplicate(slot, next.imagePlan.slots.find(other => other.role === issue.conflictingRole), factBasis, next.imagePlan.slots));
    if (duplicateRepairs.some(repair => !repair)) continue;
    slot.plannerLocalRepairs.push(...duplicateRepairs);
    slot.plannerSlotStatus = "locally_repaired";
    slot.needsUserAction = false;
    unresolvedRoles.delete(slot.role);
    const entry = repairs.find(item => item.role === slot.role);
    if (!entry) repairs.push({ role: slot.role, repairs: slot.plannerLocalRepairs });
  }

  for (const issue of validationErrors) {
    if (["image_search_plan_missing", "image_optional_plan_unaccounted", "image_slot_role_duplicate", "image_optional_omission_conflict"].includes(issue.code)) {
      for (const role of issue.slotRoles || []) if (!omittedEmptyRoles.has(role)) unresolvedRoles.add(role);
    }
  }
  return { plan: next, repairs, unresolvedSlotRoles: [...unresolvedRoles] };
}

// Used by the isolated slot-repair POC to run the exact same deterministic
// validation and local repairs as the normal single-pass Planner output.
// It does not call a model or persist a plan.
export function materializeAgentPlanForSlotRepair(raw, project) {
  const factBasis = project.factBasis;
  const context = { projectId: project.projectId, inputFingerprint: project.inputFingerprint, factBasis, previousPlanVersion: project.planIds?.length || 0 };
  const plan = assemblePlan(raw, context, project.activePlanId, { source_parser: 1, trip_planner: 1 });
  const validation = validateAgentPlan(plan, context);
  validation.errors.push(...validateSimpleHighlightSelection(raw, factBasis));
  validation.errors.push(...validateSimpleDayVisuals(plan, factBasis));
  validation.valid = validation.errors.length === 0;
  const failOpen = applyPlannerFailOpen(plan, validation.errors, factBasis);
  return {
    plan: { ...failOpen.plan, validation: { passed: validation.valid, failOpen: !validation.valid, errors: compactPlannerErrors(validation.errors), unresolvedSlotRoles: failOpen.unresolvedSlotRoles, localRepairs: failOpen.repairs } },
    validation,
  };
}

export async function generateAgentPlan({ project, apiKey, baseUrl, model, requestJson = requestDeepSeekJson, onStatus, onModelAttempt, signal, simpleSkillContract = false }) {
  const factBasis = project.factBasis;
  const context = { projectId: project.projectId, inputFingerprint: project.inputFingerprint, factBasis, previousPlanVersion: project.planIds?.length || 0 };
  const sharedInput = {
    factBasis,
    ...(simpleSkillContract ? { imageCandidateSlots: buildPlannerImageCandidates(factBasis), dayVisualCoverageTasks: buildDayVisualCoverageTasks(factBasis) } : {}),
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
  const dayVisualPrompt = "DAY 图片继续只使用 imagePlan.slots。每个 DAY 保留一个role为day:N的主视觉；结构上允许0—3个role为day:N:supporting:1等的辅助视觉；0只适用于事实确无第二个合理画面，不是普通日默认值。不要输出slotId、label、required或removable，这些属性由程序根据role补齐。普通核心体验日默认规划2张不同职责的图，事实丰富且职责不同可规划3—4张；转场、返程日规划1—2张，资料确实只有一个合理画面时可只保留主图；不得用抽象的抵达、送机离境、入住、用餐体验或自由活动充当画面。有限图片位内按以下顺序选择：独家或稀缺体验；来源明确的景点、设施或活动；有强视觉主体的动物、地标、自然事件或特色体验；能够与同日其他画面形成真实差异的场景；普通全天、清晨、傍晚游猎只在没有更高价值真实视觉时作为兜底。此顺序按字段语义通用判断，不绑定国家、项目或DAY。每个slot必须选定一个明确场景，禁止A或B、A/B和两个独立体验；同一真实画面可以包含多个自然共现主体。两个不同场景值得展示时拆成两个slot，每天最多4张。primaryVisualSubject只写真正需要入镜的主体和动作。命名地点只是搜索范围时写入location并设locationRole=scope_only；只有地点、地标、建筑、入口、标牌或实体本身必须入镜时才设locationRole=visual_identity并允许Query保留名称。主题可以来自完整experience，不要求与Spot同名。主视觉与dayRoles主线一致，辅助图只能补充主线。每个slot分别输出fidelityQuery和1—3条alternateQueries，中文精准词在前，必要英文同义表达在后；不能照抄primaryVisualSubject长句，不能写时间氛围、姿态构图、图片职责或泛词。两条准确Query已经足够；sourceRefs指向当天原始事实。";
  const visualSelectionChecklist = "单次规划的逐位最终检查：先从该图片位的原始事实选定唯一一个Core主体、必要动作及身份，再写primaryVisualSubject、queryCore和全部Query；这几处必须始终指向同一张画面。若原文列举多个可选主体或活动，只选其中一个作为本位目标；另一个只有具备独立来源和不同职责时才可另建辅助位。图片里的设备、光源、特定设施或动物必须能由sourceRefs指向的原始事实支持，不凭常识添加。alternateQueries只能改用同一目标的同义搜索表达，绝不可切换成另一主体或动作。dayRoles的主视觉与对应day:N主图必须一致。输出前发现任一视觉句保留二选一，或任一Query跨到另一分支，就在本次规划内部按事实重新确定目标并改正整个位；不要把矛盾留给搜索，也不要增加第二次规划调用。";
  const visualCoveragePrompt = '输出前逐日复核视觉覆盖，不得把允许辅助图误解为默认每天仅一个主图。资料确实只有一个合理画面时可选1个；普通核心体验日默认2个；事实丰富且有3—4个独立合理视觉职责时可规划3—4个；只有2个合理画面时规划2个；转场、返程日按真实内容选择1—2个，分别写成primary与supporting，而非合并进一个泛化游猎主题。不同主体、必要动作或可见场景具有独立职责时分别规划，不把多个真实画面压成泛化主题。纯返程或简单送机只需一个收尾视觉，不强迫补足。禁止以接送、入住或重复场景凑数。用现有visualDuty/differentiation说明选择价值和覆盖范围；只保留单图时在这两个既有字段中简述事实限制；sourceRefs优先精确引用对应days.N.spots.M或当日事实摘录，便于保留原费用状态，不新增schema。';
  callStats.trip_planner = 1;
  onStatus?.({ status: "planning", message: "正在制定单次轻量业务规划" });
  const dayNumbering = (project.factBasis?.days || []).map((day, i) => `DAY${i + 1}: dayRoles.index=${i}; imagePlan主图role=day:${i + 1}; 辅助role=day:${i + 1}:supporting:1等；只消费factBasis.days[${i}]。`).join('\n');
  const identityPrompt = "每个imagePlan.slots图片位保留boolean字段exactIdentityRequired。唯一含义：true只在如果不是queryCore.identity指向的这个具体实体，即使画面主体和动作都对，也会造成事实错误时成立；图片必须证明该具体身份。反事实检查：去掉这个具体身份以后，主体和必要动作仍然正确的图片能否完成当前图片位的主要展示任务？能则必须false；只有换成别的实体会把明确承诺的唯一地点、建筑、机构本体或实体专属体验错误展示为目标实体时才true。原始行程地点必须准确，不等于照片必须证明唯一地点身份；地点只是体验发生背景、Scope或搜索context，主要展示的是主体+动作时必须false。主体正确、动作正确、交通类别正确均不等于具体实体身份必需；identity非空、地点明确、locationRole=visual_identity也都不是true的依据。不得靠固定关键词、实体类型或地点名称判断。true时queryCore.identity必须明确目标身份，已有identityEn尽量保留正式英文名称。此字段只判断图片身份是否不可替代，不改变原始地点、画面、Query或来源；不要新增解释字段、第二次调用或其他输出结构。";
  const identityDecisionPrompt = "填写exactIdentityRequired前，先在本次规划内区分两个独立问题（不输出推理或新增字段）：①主体与必要动作必须正确，这要求同一种画面/体验，不要求唯一地点身份；②具体实体是否不可替代，这才决定该boolean。事件、自然现象、活动场面及其营销名称不是唯一实体身份；不得把行程主卖点的重要程度当成身份必需性。若主体动作仍正确，只是照片无法证明发生在那个命名地点，不能据此填true。独立酒店模块展示的就是预订的具体酒店，换成另一家会造成事实错误，因此必须true并填写该酒店正式identity。实体专属体验按是否必须属于该实体判断，不能仅因发生于酒店就设true。完成后逐图片位复核这两个问题，保持主体/动作、地点和身份分开；不按国家、动物、活动或品牌词表判断。";
  const identityOutputChecklist = '最终输出 JSON 前逐个遍历 imagePlan.slots，包含 cover、每个 hotel/dining/transport、每个 day:N 主图和每个 supporting：每一个 slot 对象都必须显式写出 "exactIdentityRequired": true 或 "exactIdentityRequired": false。不得省略、使用 null/字符串，也不得只在前几个 slot 输出该字段。先按上面的反事实判断决定每个值，不按 role、locationRole 或 identity 是否非空机械填充；输出完成后再次检查 imagePlan.slots.length 与此布尔字段出现次数完全相同。';
  const visualTargetPrompt = '视觉目标契约澄清：前文单一画面与禁止A或B约束的是Core主体、必要动作和不可替代身份，不能把理想描述的背景、光线、构图选择提升为硬条件。请在本次输出中直接保持queryCore明确，非核心背景只作表现偏好。独立hotel:N代表图已有外观、套房、泳池、公共空间候选池：若职责是展示这家酒店的真实代表空间，queryCore.subject写酒店代表性空间，action为空，identity是正式酒店身份且exactIdentityRequired=true；primaryVisualSubject可表达代表空间偏好，不能要求每种空间同框。只有客户文案明确承诺并需要图片证明某一特定房型、专属设施或体验时，Core才保留该具体主体与动作，不能归为代表图；DAY、餐饮和交通不得借酒店代表图规则放宽。真正不同Core主体、动作或身份的二选一仍不得输出，不能靠选第一个或删掉限定来解决。此澄清只使用现有字段，不新增输出字段、模型调用或备用画面。';
  const candidateSlotPrompt = '图片位置契约：用户输入的imageCandidateSlots由原始事实和版面预先确定，每项有稳定role、sourceKey、slotId及required/removable。你只决定画面，不改编号、来源或必要性；每个required=true候选必须在imagePlan.slots中恰好规划一次。sourceRefs必须引用候选的原始sourceKey，不能在事实数组过滤空行后自行重编号。可选的dining:N、transport:N只有确实无独立展示价值时才可不规划，并把对应role明确写入imagePlan.omittedOptionalRoles；没有省略时也输出空数组。不能同时规划又省略同一role，不能省略必需位。未写在omittedOptionalRoles的可选候选也须规划，遗漏不能冒充主动取舍。DAY辅助视觉可从当天真实事实另外选择0—3个；0—3是结构范围，普通核心体验日默认另选一个有独立职责的辅助位，不机械为每个Spot创建图片位。';
  const compactOutputPrompt = '只输出一个完整、紧凑的 JSON 对象，顶层先写 imagePlan，再写其他字段；不加 Markdown、解释、重复事实、冗长 rationale 或未定义字段。保留契约要求的所有字段和全部图片位；每个说明字段只写必要短句，sourceRefs只写可追溯路径。不要靠省略 slot、queryCore、Query 或 exactIdentityRequired 缩短输出。输出结束前确认整个对象闭合。';
  const systemMessages = [{ role: 'system', content: [prompt, ...(simpleSkillContract ? [simpleContractPrompt, dayVisualPrompt, visualCoveragePrompt, identityPrompt, identityDecisionPrompt, visualTargetPrompt, candidateSlotPrompt, '最终检查：不能只返回最低必需图片集合。请先逐日识别有事实支持、彼此不同的高价值场景，再把所选集合完整写入imagePlan.slots；辅助视觉是正式计划的一部分，不要仅在dayRole文字中提到却省略slot。DAY编号从1开始，只有数组index从0开始，严禁day:0、漏日或跨日借用。以下映射必须逐行覆盖：', dayNumbering, identityOutputChecklist, visualSelectionChecklist, SLOT_VISUAL_CONTRACT] : []), compactOutputPrompt].join('\n\n') }];
  const plannerPromptFingerprint = createHash("sha256").update(systemMessages[0].content).digest("hex");
  const messages = [...systemMessages, { role: "user", content: JSON.stringify(sharedInput) }];
  const retryMessages = [...systemMessages, { role: "user", content: `${JSON.stringify(sharedInput)}\n\n技术补救：上次响应没有形成完整合法JSON。本次直接输出完整紧凑JSON对象，不写推理、前言或代码块；优先保证全部必需图片位及其完整字段，非图片说明简短。` }];
  const attemptStartedAt = new Date().toISOString();
  let raw;
  let response = null;
  let plannerSystemError = null;
  let plannerAttemptUsages = [];
  try {
    response = await requestJson({ apiKey, baseUrl, model, messages, retryMessages, reasoningEffort: "high", thinkingType: "disabled", maxTokens: 30000, timeoutMs: 180_000, emptyContentRetries: 1, allowSyntaxRepair: true, onModelAttempt, signal, onStatus: (event) => onStatus?.({ status: "planning", message: event.streamPhase === "retrying" ? "首次未取得完整规划，正在补取紧凑JSON" : "规划模型正在返回单次业务计划", provider: { streamPhase: event.streamPhase, receivedContentChars: event.receivedContentChars } }) });
    plannerAttemptUsages = Array.isArray(response.attemptUsages) ? response.attemptUsages : [];
    raw = response.json;
  } catch (error) {
    plannerAttemptUsages = Array.isArray(error?.attemptUsages) ? error.attemptUsages : [];
    plannerSystemError = { code: error?.code || "planner_system_failure", message: error?.message || String(error) };
    raw = fallbackPlannerRaw(factBasis, plannerSystemError.code);
    if (plannerSystemError.code === "planner_json_invalid") raw.imagePlan.slots = recoverCompletePlannerImageSlots(error?.attemptContents);
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
  const failOpen = applyPlannerFailOpen(plan, validation.errors, factBasis);
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
      ...(simpleSkillContract ? { imagePositionCoverage: reconcilePlannerImageCandidates(failOpen.plan, factBasis) } : {}),
      ...(simpleSkillContract ? { dayVisualCoverage: dayVisualCoverage(failOpen.plan, factBasis), plannerPromptFingerprint } : {}),
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
