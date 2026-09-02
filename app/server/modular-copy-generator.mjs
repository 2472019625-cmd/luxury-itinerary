import { COPY_GENERATION_CONFIG } from "../config/copy-generation.mjs";
import { createCopyUnitStore } from "./copy-unit-store.mjs";

const DAY_BATCH_LIMIT = 10;
const DAY_INPUT_CHAR_LIMIT = 60_000;
const list = (value) => Array.isArray(value) ? value : [];

function safeDay(day = {}) {
  return {
    index: day.index,
    theme: day.theme || `DAY ${Number(day.index) + 1}`,
    description: day.description || "",
    spots: list(day.spots).map((spot) => ({ id: spot.id, description: spot.description || spot.experience || "" })),
    dayNotices: list(day.dayNotices).slice(0, 1),
  };
}

function actionMap(plan = {}) {
  return new Map(list(plan.modules).map((item) => [item.moduleId, item.contentAction || (item.decision === "hide" ? "hide" : "generate")]));
}

function dayActions(plan = {}, days = []) {
  const roles = list(plan.dayRoles);
  const numeric = roles.map((item) => Number(item.index)).filter(Number.isInteger);
  const oneBased = numeric.length > 0 && !numeric.includes(0) && numeric.includes(days.length);
  const result = new Map();
  for (const role of roles) {
    const index = Number(role.index) - (oneBased ? 1 : 0);
    if (Number.isInteger(index) && index >= 0 && index < days.length && ["preserve", "optimize", "generate"].includes(role.contentAction)) result.set(index, role.contentAction);
  }
  return result;
}

function deriveMainline(sourceFacts, plan = {}) {
  const dayRoles = list(plan.dayRoles).length ? plan.dayRoles : list(sourceFacts.days).map((day) => ({ index: day.index, role: day.theme || list(day.routeNodes).join(" → ") || `DAY ${Number(day.index) + 1}`, differenceFromAdjacent: "按当天事实保持差异" }));
  return {
    journeyPromise: plan.summary?.contentTheme || `${sourceFacts.destination || "本次目的地"}的真实行程与从容衔接`,
    narrativeArc: dayRoles.map((item) => item.role).filter(Boolean),
    moduleGoals: Object.fromEntries(list(plan.modules).map((item) => [item.moduleId, item.reason])),
    dayRoles: dayRoles.map((item) => ({ index: Number(item.index), contentRole: item.role || item.contentRole, differenceFromAdjacent: item.differenceFromAdjacent || "", sourceEvidence: item.sourceRefs || [] })),
    visualRoles: list(plan.imagePlan?.slots).filter((slot) => /^day:\d+$/.test(slot.role || "")).map((slot) => ({ index: Number(slot.role.split(":")[1]) - 1, primary: slot.visualDuty || slot.searchIntent, secondary: slot.differentiation || "", avoidRepeat: [], sourceEvidence: [] })),
    sourceEvidence: [],
    generatedBy: "trip_planner",
  };
}

export function buildSourceContentPlacement(sourceFacts = {}, plan = {}) {
  const actions = actionMap(plan);
  const action = (moduleId) => actions.get(moduleId) || "generate";
  const entries = [];
  const add = (sourceRef, targetModule, targetField, hasContent = true) => { if (hasContent) entries.push({ sourceRef, targetModule, targetField, action: action(targetModule) }); };
  add("title/subtitle/highlights", "global", "title/subtitle/highlights", Boolean(sourceFacts.title || sourceFacts.subtitle || list(sourceFacts.currentHighlights).length));
  list(sourceFacts.hotels).forEach((hotel, index) => add(`hotels.${index}`, "hotels", `hotels.${index}`, Boolean(hotel.officialName || hotel.shortName)));
  list(sourceFacts.diningExperiences).forEach((_item, index) => add(`diningExperiences.${index}`, "dining", `diningExperiences.${index}`));
  list(sourceFacts.transportSummary).forEach((_item, index) => add(`transportSummary.${index}`, "transport", `transportSummary.${index}`));
  list(sourceFacts.days).forEach((day, index) => {
    add(`days.${index}.routeNodes`, "days", `days.${index}.routeNodes`, list(day.routeNodes).length > 0);
    add(`days.${index}.estimatedTravelTime`, "transport", `days.${index}.estimatedTravelTime`, Boolean(day.estimatedTravelTime));
    add(`days.${index}.hotel`, "hotels", `days.${index}.hotel`, Boolean(day.hotel));
    add(`days.${index}.mealPlan`, "days", `days.${index}.mealPlan`, Boolean(day.mealPlan));
    add(`days.${index}.spots`, "days", `days.${index}.spots`, list(day.spots).length > 0);
    add(`days.${index}.description`, "days", `days.${index}.description`, Boolean(day.description));
  });
  add("notes", "notes", "notes", list(sourceFacts.notes).length > 0);
  add("included", "expenses", "includedCustomer", list(sourceFacts.included).length > 0);
  add("excluded", "expenses", "excludedCustomer", list(sourceFacts.excluded).length > 0);
  add("cancellation", "expenses", "cancellationCustomer", list(sourceFacts.cancellation).length > 0);
  return { version: "content-placement-v1", compiledBy: "program", plannerHints: list(plan.contentPlacement), entries };
}

export function splitDayBatches(days = []) {
  if (!days.length) return [];
  const totalChars = JSON.stringify(days).length;
  if (days.length <= DAY_BATCH_LIMIT && totalChars <= DAY_INPUT_CHAR_LIMIT) return [{ days, splitReason: null }];
  const groups = [];
  let current = [];
  for (const day of days) {
    const candidate = [...current, day];
    if (current.length && (candidate.length > DAY_BATCH_LIMIT || JSON.stringify(candidate).length > DAY_INPUT_CHAR_LIMIT)) {
      groups.push({ days: current, splitReason: days.length > DAY_BATCH_LIMIT ? `DAY数量超过${DAY_BATCH_LIMIT}` : `预计输入超过${DAY_INPUT_CHAR_LIMIT}字符` });
      current = [day];
    } else current = candidate;
  }
  if (current.length) groups.push({ days: current, splitReason: days.length > DAY_BATCH_LIMIT ? `DAY数量超过${DAY_BATCH_LIMIT}` : `预计输入超过${DAY_INPUT_CHAR_LIMIT}字符` });
  return groups;
}

function preservedOutput(type, sourceFacts, days = []) {
  if (type === "global") return { title: sourceFacts.title, subtitle: sourceFacts.subtitle, highlights: sourceFacts.currentHighlights || [] };
  if (type === "hotels") return { hotels: sourceFacts.hotels || [], evidenceMap: {} };
  if (type === "dining") return { diningExperiences: sourceFacts.diningExperiences || [], evidenceMap: {} };
  if (type === "transport") return { transportSummary: sourceFacts.transportSummary || [], evidenceMap: {} };
  if (type === "closing") return {
    notes: sourceFacts.notes || [],
    expenseCopy: {
      included: list(sourceFacts.included).map((original, index) => ({ index, text: sourceFacts.currentCustomerExpenseCopy?.included?.[index] || original })),
      excluded: list(sourceFacts.excluded).map((original, index) => ({ index, text: sourceFacts.currentCustomerExpenseCopy?.excluded?.[index] || original })),
      cancellation: list(sourceFacts.cancellation).map((original, index) => ({ index, text: sourceFacts.currentCustomerExpenseCopy?.cancellation?.[index] || original })),
    }, evidenceMap: {},
  };
  return { days: days.map(safeDay), evidenceMap: {} };
}

function unitPayload(type, sourceFacts, mainline, days = [], applicableRuleCards = [], placement = null, visibleSubmodules = []) {
  const common = { destination: sourceFacts.destination, startDate: sourceFacts.startDate, endDate: sourceFacts.endDate, dayCount: sourceFacts.dayCount, adults: sourceFacts.adults, children: sourceFacts.children, travelers: sourceFacts.travelers };
  const base = { unitType: type, applicableRuleCards, contentPlacement: placement, visibleSubmodules };
  if (type === "global") return { ...base, facts: { ...common, sourcePosterHighlights: sourceFacts.sourcePosterHighlights, currentHighlights: sourceFacts.currentHighlights, days: list(sourceFacts.days).map(({ index, date, city, routeNodes, theme, spots }) => ({ index, date, city, routeNodes, theme, spots })) }, mainline, expectedShape: { title: "", subtitle: "", highlights: [""] } };
  if (type === "hotels") return { ...base, facts: { ...common, hotels: sourceFacts.hotels, days: list(sourceFacts.days).map(({ index, date, city, routeNodes, hotel }) => ({ index, date, city, routeNodes, hotel })) }, mainline, expectedShape: { hotels: [], evidenceMap: {} } };
  if (type === "dining") return { ...base, facts: { ...common, diningExperiences: sourceFacts.diningExperiences, days: list(sourceFacts.days).map(({ index, mealPlan, spots }) => ({ index, mealPlan, spots })) }, mainline, expectedShape: { diningExperiences: [], evidenceMap: {} } };
  if (type === "transport") return { ...base, facts: { ...common, transportSummary: sourceFacts.transportSummary, days: list(sourceFacts.days).map(({ index, date, city, routeNodes, vehicle, estimatedTravelTime }) => ({ index, date, city, routeNodes, vehicle, estimatedTravelTime })) }, mainline, expectedShape: { transportSummary: [], evidenceMap: {} } };
  if (type === "closing") return { ...base, facts: { ...common, notes: sourceFacts.notes, included: sourceFacts.included, excluded: sourceFacts.excluded, cancellation: sourceFacts.cancellation, authoritativeFacts: sourceFacts.authoritativeFacts, importPendingConfirmations: sourceFacts.importPendingConfirmations }, mainline, expectedShape: { notes: [{ title: "分类标题", items: ["逐条提醒"], tone: "gold" }], expenseCopy: { included: [{ index: 0, text: "客户表达" }], excluded: [{ index: 0, text: "客户表达" }], cancellation: [{ index: 0, text: "客户表达" }] }, evidenceMap: {} } };
  return { ...base, unitType: "days", facts: { ...common, days }, mainline: { journeyPromise: mainline.journeyPromise, narrativeArc: mainline.narrativeArc, dayRoles: mainline.dayRoles, visualRoles: mainline.visualRoles }, expectedShape: { days: days.map((day) => ({ index: day.index, theme: "", description: "", spots: list(day.spots).map((spot) => ({ id: spot.id, description: "" })), dayNotices: [] })), evidenceMap: {} } };
}

function unitOutputError(unit, output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return "返回结果不是对象";
  if (unit.type === "global" && (typeof output.title !== "string" || typeof output.subtitle !== "string" || !Array.isArray(output.highlights))) return "全局文案缺少title/subtitle/highlights";
  if (unit.type === "hotels" && !Array.isArray(output.hotels)) return "酒店批次缺少hotels数组";
  if (unit.type === "dining" && !Array.isArray(output.diningExperiences)) return "餐饮批次缺少diningExperiences数组";
  if (unit.type === "transport" && !Array.isArray(output.transportSummary)) return "交通批次缺少transportSummary数组";
  if (unit.type === "closing" && (!Array.isArray(output.notes) || !output.expenseCopy || typeof output.expenseCopy !== "object")) return "收尾批次缺少notes或expenseCopy";
  if (unit.type === "days") {
    if (!Array.isArray(output.days)) return "DAY批次缺少days数组";
    const expected = unit.days.map((day) => Number(day.index));
    const actual = output.days.map((day) => Number(day?.index));
    if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((index) => !actual.includes(index))) return "DAY批次编号缺失、重复或越界";
  }
  return null;
}

async function requestValidatedModule(requestModel, unit, input, options) {
  const responses = [];
  for (let technicalAttempt = 1; technicalAttempt <= 2; technicalAttempt += 1) {
    const payload = technicalAttempt === 1 ? input : { ...input, technicalCorrection: { reason: responses.at(-1).error, instruction: "只修正JSON结构、稳定ID和缺失字段，不重新规划业务内容。" } };
    const response = await requestModel("customer-itinerary-module-v1.md", payload, options);
    const output = response.json && !Array.isArray(response.json) ? response.json : null;
    const error = unitOutputError(unit, output);
    responses.push({ response, output, error });
    if (!error) return { ...response, json: output, technicalAttemptCount: technicalAttempt };
  }
  const failure = new Error(`${unit.id} 连续两次返回非法模块结构：${responses.at(-1).error}`);
  failure.code = "invalid_module_output";
  throw failure;
}

export async function generateModularCopy({ sourceFacts, businessPlan = {}, requestModel, projectRoot, jobId, onStage = () => {}, onMainlineReady, reuseCompleted = true, ruleCardsFor = () => [], storeFactory = createCopyUnitStore }) {
  const store = storeFactory(projectRoot, jobId);
  const errors = [];
  const usages = [];
  const startedAt = new Date().toISOString();
  const mainline = deriveMainline(sourceFacts, businessPlan);
  const placement = buildSourceContentPlacement(sourceFacts, businessPlan);
  const mainlineInput = { summary: businessPlan.summary, dayRoles: businessPlan.dayRoles, imagePlan: businessPlan.imagePlan };
  store.save({ id: "mainline", type: "mainline", ruleVersion: COPY_GENERATION_CONFIG.version }, mainlineInput, { status: "complete", attempts: 0, startedAt, completedAt: new Date().toISOString(), recovery: { reason: "compiled_from_trip_planner" }, output: mainline });
  store.save({ id: "content-placement", type: "placement", ruleVersion: COPY_GENERATION_CONFIG.version }, { sourceFacts, modules: businessPlan.modules, plannerHints: businessPlan.contentPlacement }, { status: "complete", attempts: 0, startedAt, completedAt: new Date().toISOString(), recovery: { reason: "deterministic_content_placement" }, output: placement });
  onStage({ phase: "copy_mainline", currentAction: "已复用轻量规划并完成原文归位", currentUnit: "mainline", completedUnits: 1, totalUnits: 1, recovered: true });
  const parallelTask = onMainlineReady ? Promise.resolve(onMainlineReady(mainline)) : null;

  const actions = actionMap(businessPlan);
  const specs = [];
  const addModule = (id, type, moduleId, hasContent = true, extra = {}) => {
    const action = actions.get(moduleId) || "generate";
    if (hasContent && action !== "hide") specs.push({ id, type, moduleId, action, ...extra });
  };
  addModule("global", "global", "global");
  addModule("hotels", "hotels", "hotels", list(sourceFacts.hotels).length > 0);
  addModule("dining", "dining", "dining", list(sourceFacts.diningExperiences).length > 0);
  addModule("transport", "transport", "transport", list(sourceFacts.transportSummary).length > 0);
  const dayAction = actions.get("days") || "generate";
  if (dayAction !== "hide") {
    const perDay = dayActions(businessPlan, sourceFacts.days || []);
    const preservedDays = list(sourceFacts.days).filter((day, index) => dayAction === "preserve" || perDay.get(Number(day.index ?? index)) === "preserve");
    const targetDays = list(sourceFacts.days).filter((day) => !preservedDays.includes(day));
    if (preservedDays.length) specs.push({ id: "days-preserved", type: "days", moduleId: "days", action: "preserve", days: preservedDays, dayIndexes: preservedDays.map((day) => day.index) });
    splitDayBatches(targetDays).forEach((group, index) => specs.push({ id: group.splitReason ? `days-${index + 1}` : "days-all", type: "days", moduleId: "days", action: dayAction === "preserve" ? "preserve" : dayAction, days: group.days, dayIndexes: group.days.map((day) => day.index), splitReason: group.splitReason }));
  }
  const closingActions = [actions.get("notes") || "generate", actions.get("expenses") || "generate"];
  if (closingActions.some((action) => action !== "hide")) specs.push({ id: "closing", type: "closing", moduleId: "notes_expenses", action: closingActions.every((action) => action === "preserve" || action === "hide") ? "preserve" : closingActions.includes("generate") ? "generate" : "optimize", visibleSubmodules: ["notes", "expenses"].filter((id, index) => closingActions[index] !== "hide") });

  let completedUnits = 0;
  onStage({ phase: "copy_modules", currentAction: `正在处理文案批次 0/${specs.length}`, completedUnits, totalUnits: specs.length, mainline });
  const results = await Promise.all(specs.map(async (unit) => {
    const input = unitPayload(unit.type, sourceFacts, mainline, unit.days, ruleCardsFor(unit.type), placement.entries.filter((item) => unit.moduleId === "notes_expenses" ? unit.visibleSubmodules.includes(item.targetModule) : item.targetModule === unit.moduleId), unit.visibleSubmodules);
    const unitStartedAt = new Date().toISOString();
    const persistedUnit = { ...unit, ruleVersion: COPY_GENERATION_CONFIG.version };
    try {
      const reusable = reuseCompleted ? store.loadReusable(persistedUnit, input) : null;
      if (reusable || unit.action === "preserve") {
        const output = reusable?.record.output || preservedOutput(unit.type, sourceFacts, unit.days);
        completedUnits += 1;
        const file = store.save(persistedUnit, input, { status: "complete", attempts: 0, startedAt: unitStartedAt, completedAt: new Date().toISOString(), model: reusable?.record.model, usage: null, recovery: { reason: reusable ? "reused_completed_unit" : "preserved_source_copy" }, recoveredFrom: reusable?.file, output });
        onStage({ phase: "copy_modules", currentAction: `${unit.id} 已${reusable ? "恢复" : "直接保留"}（${completedUnits}/${specs.length}）`, currentUnit: unit.id, completedUnits, totalUnits: specs.length, recovered: true });
        return { unit, output, file, recovered: true };
      }
      const response = await requestValidatedModule(requestModel, unit, input, { taskKind: "copyModule", taskId: `${jobId}:${unit.id}`, maxTokens: unit.type === "days" ? 16_000 : 9_000, onStatus: (stream) => onStage({ phase: "copy_modules", currentAction: `正在生成 ${unit.id}`, currentUnit: unit.id, completedUnits, totalUnits: specs.length, stream }) });
      const output = response.json && !Array.isArray(response.json) ? response.json : {};
      completedUnits += 1;
      usages.push({ unitId: unit.id, taskKind: "copyModule", usage: response.usage || null, attemptUsages: response.attemptUsages || [], requestProfile: response.requestProfile, splitReason: unit.splitReason || null });
      const file = store.save(persistedUnit, input, { status: "complete", startedAt: unitStartedAt, completedAt: new Date().toISOString(), model: response.model, usage: response.usage, attemptUsages: response.attemptUsages, requestProfile: response.requestProfile, recovery: response.recovery, output });
      onStage({ phase: "copy_modules", currentAction: `${unit.id} 已完成（${completedUnits}/${specs.length}）`, currentUnit: unit.id, completedUnits, totalUnits: specs.length });
      return { unit, output, file };
    } catch (error) {
      if (error?.code === "storage_write_failed") throw error;
      completedUnits += 1;
      const fallback = preservedOutput(unit.type, sourceFacts, unit.days);
      errors.push({ unitId: unit.id, dayIndexes: unit.dayIndexes || [], ruleIds: unit.type === "days" ? ["COPY-006", "COPY-010"] : ["COPY-001"], message: `${unit.id} 生成失败，已保留该批次确定性原文：${error.message}` });
      const file = store.save(persistedUnit, input, { status: "fallback", startedAt: unitStartedAt, completedAt: new Date().toISOString(), error: error.message, output: fallback });
      onStage({ phase: "copy_modules", currentAction: `${unit.id} 已安全回退（${completedUnits}/${specs.length}）`, currentUnit: unit.id, completedUnits, totalUnits: specs.length });
      return { unit, output: fallback, file };
    }
  }));

  const outputFor = (type) => results.filter((item) => item.unit.type === type).map((item) => item.output);
  const global = outputFor("global")[0] || preservedOutput("global", sourceFacts);
  const hotels = outputFor("hotels")[0] || (actions.get("hotels") === "hide" ? { hotels: [] } : preservedOutput("hotels", sourceFacts));
  const dining = outputFor("dining")[0] || (actions.get("dining") === "hide" ? { diningExperiences: [] } : preservedOutput("dining", sourceFacts));
  const transport = outputFor("transport")[0] || (actions.get("transport") === "hide" ? { transportSummary: [] } : preservedOutput("transport", sourceFacts));
  const closing = outputFor("closing")[0] || preservedOutput("closing", sourceFacts);
  const dayOutputs = outputFor("days");
  const dayByIndex = new Map(list(sourceFacts.days).map((day) => [Number(day.index), safeDay(day)]));
  for (const day of dayOutputs.flatMap((item) => list(item.days))) dayByIndex.set(Number(day.index), day);
  const days = [...dayByIndex.values()].sort((a, b) => Number(a.index) - Number(b.index));
  const evidenceMap = Object.assign({}, global.evidenceMap, hotels.evidenceMap, dining.evidenceMap, transport.evidenceMap, closing.evidenceMap, ...dayOutputs.map((item) => item.evidenceMap || {}));
  return {
    draft: { ...global, ...hotels, ...dining, ...transport, ...closing, days, evidenceMap },
    mainline, placement, errors, usages,
    unitFiles: results.map((item) => item.file),
    unitSummary: { completed: specs.length - errors.length, fallback: errors.length, total: specs.length, dayBatchCount: results.filter((item) => item.unit.type === "days" && item.unit.action !== "preserve").length, preservedDayCount: results.filter((item) => item.unit.type === "days" && item.unit.action === "preserve").reduce((sum, item) => sum + item.unit.days.length, 0), splitReasons: [...new Set(results.map((item) => item.unit.splitReason).filter(Boolean))] },
    storeDirectory: store.directory, parallelTask,
  };
}
