import { compactProofPoints, normalizeExperienceSpot, normalizeItineraryFacts } from "../src/lib/itineraryRules.js";
import { filterDiningExperiences } from "./refinement-rules.mjs";
import { normalizeLegacyNotesForDisplay, validateNotesSchema } from "../src/lib/notesSchema.js";

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(/[\n；;]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function compactHotel(hotel = {}) {
  return {
    id: hotel.id, officialName: hotel.officialName, shortName: hotel.shortName, region: hotel.region,
    nights: hotel.nights, roomType: hotel.roomType, mealPlan: hotel.mealPlan,
    status: hotel.status, confirmationStatus: hotel.confirmationStatus ?? hotel.confirmed,
    referenceOnly: hotel.referenceOnly, replacementPolicy: hotel.replacementPolicy,
    editorialCopy: hotel.editorialCopy, proofPoints: hotel.proofPoints, sourceEvidence: hotel.sourceEvidence || [],
  };
}

function compactTransport(item = {}) {
  return {
    id: item.id, category: item.category, serviceLevel: item.serviceLevel, seatCount: item.seatCount,
    model: item.model, modelGuaranteed: item.modelGuaranteed === true,
    usageSegments: item.usageSegments, features: item.features, editorialCopy: item.editorialCopy, sourceEvidence: item.sourceEvidence || [],
  };
}

export function compactForModel(data = {}, context = {}) {
  return {
    title: data.title, subtitle: data.subtitle, destination: data.destination,
    startDate: data.startDate, endDate: data.endDate, dayCount: data.dayCount || data.days?.length,
    adults: data.adults, children: data.children, travelers: data.travelers,
    customerPreferences: context.customerPreferences || data.customerPreferences || data.preferences || [],
    specialRequests: context.specialRequests || data.specialRequests || context.requirements || "",
    importPendingConfirmations: data.pendingConfirmations || data.importPendingConfirmations || [],
    sourcePosterHighlights: data.sourcePosterHighlights || [], currentHighlights: data.highlights || [],
    included: data.included || [], excluded: data.excluded || [], cancellation: data.cancellation || [],
    currentCustomerExpenseCopy: {
      included: data.includedCustomer || [], excluded: data.excludedCustomer || [], cancellation: data.cancellationCustomer || [],
    },
    hotels: (data.hotels || []).map(compactHotel),
    diningExperiences: data.diningExperiences || [],
    transportSummary: (data.transportSummary || []).map(compactTransport),
    days: (data.days || []).map((day, index) => ({
      index, date: day.date, city: day.city, routeNodes: day.routeNodes, theme: day.theme,
      description: day.description, mealPlan: day.mealPlan, hotel: day.hotel, vehicle: day.vehicle,
      estimatedTravelTime: day.estimatedTravelTime, activityLevel: day.activityLevel,
      restStops: day.restStops, overnightType: day.overnightType,
      spots: (day.spots || []).map(({ id, name, description, experience, status, statusLabel, feeBoundary, optional, confirmed, included, sourceEvidence, reminder }) => ({ id, name, description, experience, status, statusLabel, feeBoundary, optional, confirmed, included, sourceEvidence, reminder })),
    })),
    totalPrice: data.totalPrice, priceUnit: data.priceUnit, priceNotes: data.priceNotes,
    sourceCoverage: data.sourceImportCoverage ? {
      workbookName: data.sourceImportCoverage.workbookName,
      includedCount: asList(data.sourceImportCoverage.included).length,
      excludedCount: asList(data.sourceImportCoverage.excluded).length,
      dailyTransportCount: asList(data.sourceImportCoverage.dailyTransport).length,
    } : null,
    authoritativeFacts: (data.authoritativeFacts || []).map(({ statement, sourceUrl, verifiedAt }) => ({ statement, sourceUrl, verifiedAt })),
  };
}

function mergeExpenseItems(source, edits, label, targetPath) {
  const safeEdits = Array.isArray(edits) ? edits : [];
  const byIndex = new Map();
  for (const item of safeEdits) {
    const index = Number(item?.index);
    if (Number.isInteger(index) && index >= 0 && index < source.length && !byIndex.has(index)) byIndex.set(index, String(item?.text || '').trim());
  }
  const warnings = [];
  const values = source.map((original, index) => {
    const value = byIndex.get(index);
    if (value) return value;
    warnings.push({ ruleIds: ['COPY-014'], code: 'expense_copy_safe_fallback', path: `${targetPath}.${index}`, message: `${label}第${index + 1}项未获得合法客户表达，已保留原始确定性费用并等待局部改写`, action: 'targeted_rewrite', severity: 'quality' });
    return original;
  });
  if (safeEdits.length !== source.length || byIndex.size !== source.length) {
    const covered = new Set(warnings.map((item) => item.path));
    source.forEach((_item, index) => {
      const path = `${targetPath}.${index}`;
      if (!covered.has(path) && safeEdits.length !== source.length) warnings.push({ ruleIds: ['COPY-014'], code: 'expense_copy_structure_mismatch', path, message: `${label}客户表达数量或索引未与确定性费用逐项对应，当前值已安全保留`, action: 'targeted_rewrite', severity: 'quality' });
    });
  }
  return { values, warnings };
}

export function validateDailyRefinement(sourceDays = [], refinedDays) {
  const errors = [];
  if (!Array.isArray(refinedDays)) return { valid: false, errors: ["模型没有返回逐日行程"] };
  const indexes = refinedDays.map((day) => Number(day?.index));
  if (refinedDays.length !== sourceDays.length) errors.push("模型返回的天数与原行程不一致");
  if (new Set(indexes).size !== indexes.length) errors.push("模型返回了重复的 DAY 编号");
  const expected = sourceDays.map((_, index) => index);
  if (indexes.some((index) => !Number.isInteger(index) || !expected.includes(index)) || expected.some((index) => !indexes.includes(index))) errors.push("模型返回的 DAY 编号缺失或越界");
  return { valid: errors.length === 0, errors };
}

function evidenceText(value) {
  if (typeof value === "string") return value.trim();
  return String(value?.text || "").trim();
}

function deterministicFacts(data = {}) {
  return {
    destination: data.destination, startDate: data.startDate, endDate: data.endDate, dayCount: data.dayCount,
    adults: data.adults, children: data.children, travelers: data.travelers,
    included: data.included, excluded: data.excluded, cancellation: data.cancellation,
    totalPrice: data.totalPrice, priceUnit: data.priceUnit,
    hotels: (data.hotels || []).map(({ id, officialName, shortName, region, nights, roomType, mealPlan, status, confirmationStatus, referenceOnly, replacementPolicy, sourceEvidence }) => ({ id, officialName, shortName, region, nights, roomType, mealPlan, status, confirmationStatus, referenceOnly, replacementPolicy, sourceEvidence })),
    transportSummary: (data.transportSummary || []).map(({ id, category, serviceLevel, seatCount, model, modelGuaranteed, usageSegments, sourceEvidence }) => ({ id, category, serviceLevel, seatCount, model, modelGuaranteed, usageSegments, sourceEvidence })),
    days: (data.days || []).map((day) => ({
      date: day.date, city: day.city, routeNodes: day.routeNodes, mealPlan: day.mealPlan, hotel: day.hotel,
      vehicle: day.vehicle, estimatedTravelTime: day.estimatedTravelTime, activityLevel: day.activityLevel,
      restStops: day.restStops, overnightType: day.overnightType,
      spots: (day.spots || []).map(({ id, name, status, statusLabel, feeBoundary, sourceEvidence }) => ({ id, name, status, statusLabel, feeBoundary, sourceEvidence })),
    })),
    sourceImportCoverage: data.sourceImportCoverage,
  };
}

export function compareDeterministicFacts(source = {}, result = {}) {
  const sourceNormalized = normalizeItineraryFacts(source);
  const resultNormalized = normalizeItineraryFacts(result);
  const expected = deterministicFacts(sourceNormalized);
  const actual = deterministicFacts(resultNormalized);
  return { preserved: JSON.stringify(expected) === JSON.stringify(actual), expected, actual };
}

const TARGETED_PATH = /^(?:title|subtitle|highlights|highlights\.\d+|hotels\.\d+\.(?:editorialCopy|proofPoints)|diningExperiences\.\d+\.editorialCopy|transportSummary\.\d+\.editorialCopy|days\.\d+\.(?:theme|description|dayNotices|spots\.\d+\.description)|notes|notes\.\d+|notes\.\d+\.(?:title|items)|includedCustomer\.\d+|excludedCustomer\.\d+|cancellationCustomer\.\d+)$/;

function pathParts(path) {
  return String(path || '').split('.').filter(Boolean).map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function setAtPath(target, path, value) {
  const parts = pathParts(path);
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (cursor?.[part] == null) throw new Error(`局部重写路径不存在：${path}`);
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = structuredClone(value);
}

function issueCoversPath(issuePath, patchPath) {
  const coarse = { customer: 'customer', expenses: 'expenses', hotels: 'hotels', days: 'days', notes: 'notes', transportSummary: 'transportSummary', diningExperiences: 'diningExperiences' };
  const normalized = coarse[issuePath] ?? String(issuePath || '');
  return Boolean(normalized) && (patchPath === normalized || patchPath.startsWith(`${normalized}.`) || normalized.startsWith(`${patchPath}.`));
}

export function applyTargetedRevisions(data, review = {}) {
  if (!Array.isArray(review.reviewIssues) || !Array.isArray(review.patches)) throw new Error('品牌编辑必须返回reviewIssues和patches数组');
  const next = structuredClone(data);
  const changedPaths = [];
  const evidence = { ...(next.copyEvidence || {}) };
  for (const patch of review.patches) {
    const path = String(patch?.path || '');
    if (!TARGETED_PATH.test(path)) throw new Error(`品牌编辑试图修改非文案字段：${path || '空路径'}`);
    if (!review.reviewIssues.some((item) => issueCoversPath(item?.path, path))) throw new Error(`品牌编辑修改了未命中模块：${path}`);
    let patchValue = patch.value;
    if (path === 'notes') {
      const validation = validateNotesSchema(patchValue);
      if (!validation.valid) throw new Error(`注意事项补丁结构非法：${validation.errors.join('；')}`);
    }
    if (/^notes\.\d+$/.test(path) && patchValue && typeof patchValue === 'object' && !Array.isArray(patchValue)) {
      const index = Number(path.split('.')[1]);
      const current = next.notes?.[index] || {};
      patchValue = { ...current, title: String(patchValue.title || current.title || ''), items: asList(patchValue.items).length ? asList(patchValue.items) : asList(current.items) };
      const validation = validateNotesSchema([patchValue]);
      if (!validation.valid) throw new Error(`注意事项补丁结构非法：${validation.errors.join('；')}`);
    }
    if (/^notes\.\d+\.items$/.test(path) && (!Array.isArray(patchValue) || patchValue.some((item) => typeof item !== 'string' || !item.trim()))) throw new Error('注意事项items必须是非空字符串数组');
    if (/^notes\.\d+\.title$/.test(path) && (typeof patchValue !== 'string' || !patchValue.trim())) throw new Error('注意事项title必须是非空字符串');
    setAtPath(next, path, patchValue);
    evidence[path] = Array.isArray(patch.evidence) ? patch.evidence.map(evidenceText).filter(Boolean) : [];
    changedPaths.push(path);
  }
  next.copyEvidence = evidence;
  return { data: next, changedPaths };
}

function mergeSpots(sourceDay, copyDay, dayIndex) {
  if (!Array.isArray(copyDay.spots)) return sourceDay.spots;
  const sourceIds = (sourceDay.spots || []).map((spot) => spot.id).filter(Boolean).sort();
  const copyIds = copyDay.spots.map((spot) => spot.id).filter(Boolean).sort();
  if (JSON.stringify(sourceIds) !== JSON.stringify(copyIds)) throw new Error(`DAY ${dayIndex + 1} 的体验ID集合与原始确定性事实不一致`);
  return copyDay.spots.map((copy, spotIndex) => {
    const match = (sourceDay.spots || []).find((spot) => copy.id && spot.id === copy.id);
    if (!match) throw new Error(`DAY ${dayIndex + 1} 的体验不在原始确定性体验中，不能由文案模型新增`);
    return normalizeExperienceSpot({
      ...match,
      name: match.name,
      description: copy.description || match.description,
      sourceEvidence: match.sourceEvidence,
      status: match.status,
      statusLabel: match.statusLabel,
      feeBoundary: match.feeBoundary,
      images: match.images || [],
    }, dayIndex, spotIndex);
  });
}

function mergeDays(sourceDays, refinedDays) {
  const validation = validateDailyRefinement(sourceDays, refinedDays);
  if (!validation.valid) return { days: sourceDays, accepted: false, errors: validation.errors };
  try {
    const byIndex = new Map(refinedDays.map((day) => [Number(day.index), day]));
    const days = sourceDays.map((day, index) => {
      const copy = byIndex.get(index);
      return {
        ...day,
        theme: copy.theme || day.theme,
        routeNodes: day.routeNodes?.length ? day.routeNodes : asList(copy.routeNodes),
        estimatedTravelTime: day.estimatedTravelTime && day.estimatedTravelTime !== "待确认" ? day.estimatedTravelTime : copy.estimatedTravelTime || day.estimatedTravelTime,
        activityLevel: day.activityLevel || copy.activityLevel,
        restStops: day.restStops,
        overnightType: day.overnightType || copy.overnightType,
        spots: mergeSpots(day, copy, index),
        description: copy.description || day.description,
        dayNotices: Array.isArray(copy.dayNotices) ? copy.dayNotices.slice(0, 1) : day.dayNotices,
      };
    });
    return { days, accepted: true, errors: [] };
  } catch (error) {
    return { days: sourceDays, accepted: false, errors: [error.message] };
  }
}

export function mergeRefinement(data, refinement = {}) {
  const next = structuredClone(data);
  next.notes = normalizeLegacyNotesForDisplay(next.notes);
  const mergeWarnings = [];
  const generatedTitle = typeof refinement.title === "string" ? refinement.title.trim() : "";
  if (generatedTitle && generatedTitle.length <= 24 && /\d+天\d+晚/.test(generatedTitle) && /(?:定制游|深度游|Safari定制游)/i.test(generatedTitle) && !/\d+人|定制团|私家团/.test(generatedTitle)) next.title = generatedTitle;
  else next.title = `${data.destination || "目的地"}${data.days.length}天${Math.max(0, data.days.length - 1)}晚顶奢深度定制游`;
  if (typeof refinement.subtitle === "string") next.subtitle = refinement.subtitle;
  delete next.travelerLabel;
  if (Array.isArray(refinement.highlights)) {
    const highlights = refinement.highlights.map((item) => typeof item === "string" ? item : item?.title && (item.description || item.copy || item.value) ? `${item.title}：${item.description || item.copy || item.value}` : item?.title || "").filter(Boolean).slice(0, 6);
    if (highlights.length) next.highlights = highlights;
  }
  if (Array.isArray(refinement.hotels)) next.hotels = (next.hotels || []).map((hotel, index) => {
    const copy = refinement.hotels.find((item) => item.id === hotel.id) || refinement.hotels[index];
    return copy ? { ...hotel, editorialCopy: copy.editorialCopy || hotel.editorialCopy, proofPoints: compactProofPoints(copy.proofPoints, hotel.proofPoints) } : hotel;
  });
  const daily = Array.isArray(refinement.days) ? mergeDays(next.days || [], refinement.days) : { days: next.days || [], accepted: false, errors: [] };
  next.days = daily.days;
  if (Array.isArray(refinement.diningExperiences)) {
    const allowed = filterDiningExperiences(data, refinement.diningExperiences);
    next.diningExperiences = (next.diningExperiences || []).map((source, index) => {
      const copy = allowed.find((item) => item.id && item.id === source.id) || allowed[index];
      return copy ? { ...source, editorialCopy: copy.editorialCopy || source.editorialCopy } : source;
    }).slice(0, 8);
  }
  if (Array.isArray(refinement.transportSummary)) next.transportSummary = (next.transportSummary || []).map((source, index) => {
    const copy = refinement.transportSummary.find((item) => item.id && item.id === source.id) || refinement.transportSummary[index];
    return copy ? { ...source, editorialCopy: copy.editorialCopy || source.editorialCopy } : source;
  }).slice(0, 5);
  if (Array.isArray(refinement.notes)) {
    const proposedNotes = refinement.notes.slice(0, 7);
    const validation = validateNotesSchema(proposedNotes);
    if (validation.valid) next.notes = proposedNotes.map((item) => ({ ...item, title: String(item.title).trim(), items: item.items.map((entry) => String(entry).trim()).filter(Boolean), tone: item.tone || 'gold' }));
    else mergeWarnings.push({ ruleIds: ['COPY-013'], code: 'notes_invalid_structure', path: 'notes', message: `新生成注意事项结构非法，已拒绝采用：${validation.errors.join('；')}`, action: 'block', severity: 'structure' });
  }
  const expenseCopy = refinement.expenseCopy || {};
  const included = mergeExpenseItems(asList(data.included), expenseCopy.included, '费用包含', 'includedCustomer');
  const excluded = mergeExpenseItems(asList(data.excluded), expenseCopy.excluded, '费用不含', 'excludedCustomer');
  const cancellation = mergeExpenseItems(asList(data.cancellation), expenseCopy.cancellation, '退改政策', 'cancellationCustomer');
  next.includedCustomer = included.values;
  next.excludedCustomer = excluded.values;
  next.cancellationCustomer = cancellation.values;
  mergeWarnings.push(...included.warnings, ...excluded.warnings, ...cancellation.warnings);
  if (Array.isArray(refinement.imagePlan)) next.imagePlan = refinement.imagePlan;
  if (refinement.evidenceMap && typeof refinement.evidenceMap === 'object') next.copyEvidence = structuredClone(refinement.evidenceMap);
  next.diningSectionTitle = "特色餐饮";
  return { data: normalizeItineraryFacts(next), dailyRefinement: daily, mergeWarnings };
}
