import { COPY_GENERATION_CONFIG } from "../config/copy-generation.mjs";
import { createCopyUnitStore } from "./copy-unit-store.mjs";

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function safeDay(day = {}) {
  return {
    index: day.index,
    theme: day.theme || `DAY ${Number(day.index) + 1}`,
    description: day.description || "",
    spots: (day.spots || []).map((spot) => ({ id: spot.id, description: spot.description || spot.experience || "" })),
    dayNotices: Array.isArray(day.dayNotices) ? day.dayNotices.slice(0, 1) : [],
  };
}

function fallbackMainline(sourceFacts) {
  return {
    journeyPromise: `${sourceFacts.destination || "本次旅程"}的真实行程与从容衔接`,
    narrativeArc: [],
    moduleGoals: { global: "准确呈现整程价值", hospitality: "说明住宿与交通的路线价值", closing: "清楚说明费用和行前边界" },
    dayRoles: (sourceFacts.days || []).map((day) => ({ index: day.index, contentRole: day.theme || day.routeNodes?.join(" → ") || `DAY ${day.index + 1}`, differenceFromAdjacent: "事实不足，保持简洁", sourceEvidence: [] })),
    visualRoles: (sourceFacts.days || []).map((day) => ({ index: day.index, primary: day.routeNodes?.join(" → ") || day.city || "当天真实行程", secondary: "", avoidRepeat: [], sourceEvidence: [] })),
    sourceEvidence: [],
  };
}

function unitPayload(type, sourceFacts, mainline, days = [], applicableRuleCards = []) {
  const common = { destination: sourceFacts.destination, startDate: sourceFacts.startDate, endDate: sourceFacts.endDate, dayCount: sourceFacts.dayCount, adults: sourceFacts.adults, children: sourceFacts.children, travelers: sourceFacts.travelers };
  if (type === "global") return { unitType: type, applicableRuleCards, facts: { ...common, sourcePosterHighlights: sourceFacts.sourcePosterHighlights, currentHighlights: sourceFacts.currentHighlights, days: sourceFacts.days.map(({ index, date, city, routeNodes, theme, spots }) => ({ index, date, city, routeNodes, theme, spots })) }, mainline, expectedShape: { title: "", subtitle: "", highlights: [""] } };
  if (type === "hospitality") return { unitType: type, applicableRuleCards, facts: { ...common, hotels: sourceFacts.hotels, diningExperiences: sourceFacts.diningExperiences, transportSummary: sourceFacts.transportSummary, days: sourceFacts.days.map(({ index, date, city, routeNodes, hotel, vehicle, estimatedTravelTime }) => ({ index, date, city, routeNodes, hotel, vehicle, estimatedTravelTime })) }, mainline, expectedShape: { hotels: [], diningExperiences: [], transportSummary: [], evidenceMap: {} } };
  if (type === "closing") return { unitType: type, applicableRuleCards, facts: { ...common, included: sourceFacts.included, excluded: sourceFacts.excluded, cancellation: sourceFacts.cancellation, authoritativeFacts: sourceFacts.authoritativeFacts, importPendingConfirmations: sourceFacts.importPendingConfirmations }, mainline, expectedShape: { notes: [{ title: "分类标题", items: ["逐条提醒"], tone: "gold" }], expenseCopy: { included: [{ index: 0, text: "客户表达" }], excluded: [{ index: 0, text: "客户表达" }], cancellation: [{ index: 0, text: "客户表达" }] }, evidenceMap: {} } };
  return { unitType: "days", applicableRuleCards, facts: { ...common, days }, mainline: { journeyPromise: mainline.journeyPromise, narrativeArc: mainline.narrativeArc, dayRoles: mainline.dayRoles, visualRoles: mainline.visualRoles }, expectedShape: { days: days.map((day) => ({ index: day.index, theme: "", description: "", spots: (day.spots || []).map((spot) => ({ id: spot.id, description: "" })), dayNotices: [] })), evidenceMap: {} } };
}

export async function generateModularCopy({ sourceFacts, requestModel, projectRoot, jobId, onStage = () => {}, onMainlineReady, reuseCompleted = true, ruleCardsFor = () => [] }) {
  const store = createCopyUnitStore(projectRoot, jobId);
  const errors = [];
  const usages = [];
  const startedAt = new Date().toISOString();
  onStage({ phase: "copy_mainline", currentAction: "正在建立整程内容与视觉主线", completedUnits: 0, totalUnits: 1 });
  let mainline = fallbackMainline(sourceFacts);
  const mainlineUnit = { id: "mainline", type: "mainline", ruleVersion: COPY_GENERATION_CONFIG.version };
  const mainlineInput = { sourceFacts, applicableRuleCards: ruleCardsFor("mainline") };
  const reusableMainline = reuseCompleted ? store.loadReusable(mainlineUnit, mainlineInput) : null;
  try {
    if (reusableMainline) {
      mainline = reusableMainline.record.output;
      store.save(mainlineUnit, mainlineInput, { status: "complete", attempts: 0, startedAt, completedAt: new Date().toISOString(), model: reusableMainline.record.model, usage: null, recovery: { reason: "reused_completed_unit" }, recoveredFrom: reusableMainline.file, output: mainline });
      onStage({ phase: "copy_mainline", currentAction: "已恢复整程内容与视觉主线", currentUnit: "mainline", completedUnits: 1, totalUnits: 1, recovered: true });
    } else {
      const response = await requestModel("customer-itinerary-mainline-v1.md", mainlineInput, { taskKind: "mainline", taskId: `${jobId}:mainline`, maxTokens: 9000, onStatus: (stream) => onStage({ phase: "copy_mainline", currentAction: "正在建立整程内容与视觉主线", currentUnit: "mainline", stream }) });
      if (response.json && !Array.isArray(response.json)) mainline = response.json;
      usages.push({ unitId: "mainline", taskKind: "mainline", usage: response.usage || null, attemptUsages: response.attemptUsages || [], requestProfile: response.requestProfile });
      store.save(mainlineUnit, mainlineInput, { status: "complete", startedAt, completedAt: new Date().toISOString(), model: response.model, usage: response.usage, attemptUsages: response.attemptUsages, requestProfile: response.requestProfile, recovery: response.recovery, output: mainline });
    }
  } catch (error) {
    errors.push({ unitId: "mainline", ruleIds: ["COPY-001", "IMG-001"], message: `整程主线调用失败，已使用确定性安全主线：${error.message}` });
    store.save({ id: "mainline", type: "mainline", ruleVersion: COPY_GENERATION_CONFIG.version }, { sourceFacts }, { status: "fallback", startedAt, completedAt: new Date().toISOString(), error: error.message });
  }
  const parallelTask = onMainlineReady ? Promise.resolve(onMainlineReady(mainline)) : null;

  const dayGroups = chunks(sourceFacts.days || [], COPY_GENERATION_CONFIG.dayGroupSize);
  const specs = [
    { id: "global", type: "global" },
    { id: "hospitality", type: "hospitality" },
    ...dayGroups.map((days, index) => ({ id: `days-${index + 1}`, type: "days", days, dayIndexes: days.map((day) => day.index) })),
    { id: "closing", type: "closing" },
  ];
  let completedUnits = 0;
  onStage({ phase: "copy_modules", currentAction: `正在生成文案模块 0/${specs.length}`, completedUnits, totalUnits: specs.length, mainline });
  const results = await Promise.all(specs.map(async (unit) => {
    const input = unitPayload(unit.type, sourceFacts, mainline, unit.days, ruleCardsFor(unit.type));
    const unitStartedAt = new Date().toISOString();
    const persistedUnit = { ...unit, ruleVersion: COPY_GENERATION_CONFIG.version };
    try {
      const reusable = reuseCompleted ? store.loadReusable(persistedUnit, input) : null;
      if (reusable) {
        const output = reusable.record.output;
        completedUnits += 1;
        const file = store.save(persistedUnit, input, { status: "complete", attempts: 0, startedAt: unitStartedAt, completedAt: new Date().toISOString(), model: reusable.record.model, usage: null, recovery: { reason: "reused_completed_unit" }, recoveredFrom: reusable.file, output });
        if (unit.type === "days") for (const day of output.days || []) store.save({ id: `day-${Number(day.index) + 1}`, type: "day", dayIndexes: [day.index], parentUnitId: unit.id, ruleVersion: COPY_GENERATION_CONFIG.version }, { groupInput: input, dayIndex: day.index }, { status: "complete", attempts: 0, startedAt: unitStartedAt, completedAt: new Date().toISOString(), model: reusable.record.model, recovery: { reason: "reused_completed_unit" }, recoveredFrom: reusable.file, output: day });
        onStage({ phase: "copy_modules", currentAction: `${unit.id} 已恢复（${completedUnits}/${specs.length}）`, currentUnit: unit.id, completedUnits, totalUnits: specs.length, recovered: true });
        return { unit, output, file, recovered: true };
      }
      const response = await requestModel("customer-itinerary-module-v1.md", input, { taskKind: "copyModule", taskId: `${jobId}:${unit.id}`, maxTokens: unit.type === "days" ? 12000 : 9000, onStatus: (stream) => onStage({ phase: "copy_modules", currentAction: `正在生成 ${unit.id}`, currentUnit: unit.id, completedUnits, totalUnits: specs.length, stream }) });
      const output = response.json && !Array.isArray(response.json) ? response.json : {};
      completedUnits += 1;
      usages.push({ unitId: unit.id, taskKind: "copyModule", usage: response.usage || null, attemptUsages: response.attemptUsages || [], requestProfile: response.requestProfile });
      const file = store.save(persistedUnit, input, { status: "complete", startedAt: unitStartedAt, completedAt: new Date().toISOString(), model: response.model, usage: response.usage, attemptUsages: response.attemptUsages, requestProfile: response.requestProfile, recovery: response.recovery, output });
      if (unit.type === "days") for (const day of output.days || []) store.save({ id: `day-${Number(day.index) + 1}`, type: "day", dayIndexes: [day.index], parentUnitId: unit.id, ruleVersion: COPY_GENERATION_CONFIG.version }, { groupInput: input, dayIndex: day.index }, { status: "complete", startedAt: unitStartedAt, completedAt: new Date().toISOString(), model: response.model, usage: response.usage, attemptUsages: response.attemptUsages, requestProfile: response.requestProfile, recovery: response.recovery, output: day });
      onStage({ phase: "copy_modules", currentAction: `${unit.id} 已完成（${completedUnits}/${specs.length}）`, currentUnit: unit.id, completedUnits, totalUnits: specs.length });
      return { unit, output, file };
    } catch (error) {
      completedUnits += 1;
      const fallback = unit.type === "days" ? { days: unit.days.map(safeDay), evidenceMap: {} } : {};
      errors.push({ unitId: unit.id, dayIndexes: unit.dayIndexes || [], ruleIds: unit.type === "days" ? ["COPY-006", "COPY-010"] : ["COPY-001"], message: `${unit.id} 生成失败，已保留该模块确定性原文：${error.message}` });
      const completedAt = new Date().toISOString();
      const file = store.save(persistedUnit, input, { status: "fallback", startedAt: unitStartedAt, completedAt, error: error.message, output: fallback });
      if (unit.type === "days") for (const day of fallback.days) store.save({ id: `day-${Number(day.index) + 1}`, type: "day", dayIndexes: [day.index], parentUnitId: unit.id, ruleVersion: COPY_GENERATION_CONFIG.version }, { groupInput: input, dayIndex: day.index }, { status: "fallback", startedAt: unitStartedAt, completedAt, error: error.message, output: day });
      onStage({ phase: "copy_modules", currentAction: `${unit.id} 已安全回退（${completedUnits}/${specs.length}）`, currentUnit: unit.id, completedUnits, totalUnits: specs.length });
      return { unit, output: fallback, file };
    }
  }));

  const byType = (type) => results.filter((item) => item.unit.type === type);
  const global = byType("global")[0]?.output || {};
  const hospitality = byType("hospitality")[0]?.output || {};
  const closing = byType("closing")[0]?.output || {};
  const days = byType("days").flatMap((item) => Array.isArray(item.output.days) ? item.output.days : item.unit.days.map(safeDay)).sort((a, b) => Number(a.index) - Number(b.index));
  const evidenceMap = Object.assign({}, global.evidenceMap, hospitality.evidenceMap, closing.evidenceMap, ...byType("days").map((item) => item.output.evidenceMap || {}));
  return {
    draft: { ...global, ...hospitality, ...closing, days, evidenceMap },
    mainline,
    errors,
    usages,
    unitFiles: results.map((item) => item.file),
    unitSummary: { completed: specs.length - errors.filter((item) => item.unitId !== "mainline").length, fallback: errors.filter((item) => item.unitId !== "mainline").length, total: specs.length, dayGroupSize: COPY_GENERATION_CONFIG.dayGroupSize },
    storeDirectory: store.directory,
    parallelTask,
  };
}
