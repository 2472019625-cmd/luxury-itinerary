const FLIGHT_OVERNIGHT = /^(?:飞机|飞机上|航班|返程航班|夜航|机上)$/i;
const NO_OVERNIGHT = /^(?:无住宿|不住宿|无需住宿|行程结束|返程结束|—|-)$/i;
const AIRPORT = /机场|航站楼|airport/i;
const RESERVATION_REQUIRED = /需(?:要)?提前预约|须提前预约|预约后|预约制/i;
const PENDING_CONFIRMATION = /待确认|尚未确认|以最终确认|视情况|按.*安排/i;
const INTERNAL_CONTENT = /成本|利润|毛利|供应商底价|采购价|结算价|内部报价|基本房型报价|报价测算逻辑|加价倍率|内部备注/i;
const TIME_SENSITIVE = /签证|疫苗|健康申报|入境|海关|检疫|黄热病|安全政策/i;

export const EXPERIENCE_STATUS = Object.freeze({
  INCLUDED: "included",
  OPTIONAL_PAID: "optional_paid",
  RESERVATION_REQUIRED: "reservation_required",
  PENDING: "pending",
});

export const EXPERIENCE_STATUS_LABELS = Object.freeze({
  [EXPERIENCE_STATUS.INCLUDED]: "已包含",
  [EXPERIENCE_STATUS.OPTIONAL_PAID]: "自费可选",
  [EXPERIENCE_STATUS.RESERVATION_REQUIRED]: "需提前预约",
  [EXPERIENCE_STATUS.PENDING]: "待确认",
});

function cleanText(value) {
  return String(value ?? "").replace(/\r/g, "").replace(/[\t\u00a0]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function stableTextId(value) {
  let hash = 2166136261;
  for (const char of cleanText(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function spotEvidence(spot = {}) {
  const supplied = Array.isArray(spot.sourceEvidence) ? spot.sourceEvidence.filter(Boolean) : [];
  if (supplied.length) return supplied;
  return unique([spot.name, spot.description || spot.experience]).slice(0, 2);
}

export function inferExperienceStatus(spot = {}) {
  if (Object.values(EXPERIENCE_STATUS).includes(spot.status)) return spot.status;
  if (spot.included === true || spot.confirmedIncluded === true) return EXPERIENCE_STATUS.INCLUDED;
  const source = cleanText(`${spot.status || ""} ${spot.statusLabel || ""} ${spot.name || ""} ${spot.description || spot.experience || ""} ${spot.reminder || ""}`);
  if (spot.optional === true || /自费|可选|费用不含|另行付费/i.test(source)) return EXPERIENCE_STATUS.OPTIONAL_PAID;
  if (RESERVATION_REQUIRED.test(source)) return EXPERIENCE_STATUS.RESERVATION_REQUIRED;
  if (spot.confirmed === false || PENDING_CONFIRMATION.test(source)) return EXPERIENCE_STATUS.PENDING;
  return EXPERIENCE_STATUS.INCLUDED;
}

export function normalizeExperienceSpot(spot = {}, dayIndex = 0, spotIndex = 0) {
  const status = inferExperienceStatus(spot);
  const evidence = spotEvidence(spot);
  const name = cleanText(spot.name) || `第${spotIndex + 1}项体验`;
  return {
    ...spot,
    id: cleanText(spot.id) || `day-${dayIndex + 1}-spot-${stableTextId(`${name}|${evidence.join("|")}`)}`,
    name,
    description: cleanText(spot.description || spot.experience),
    status,
    statusLabel: EXPERIENCE_STATUS_LABELS[status],
    feeBoundary: status === EXPERIENCE_STATUS.OPTIONAL_PAID ? "excluded" : status === EXPERIENCE_STATUS.PENDING ? "pending" : "included",
    sourceEvidence: evidence,
    images: Array.isArray(spot.images) ? spot.images : spot.image ? [{ src: spot.image }] : [],
  };
}

function withoutExperience(list, name) {
  const target = normalizeName(name);
  return (list || []).filter((item) => normalizeName(itemText(item).split(/[：:]/)[0]) !== target);
}

export function synchronizeExperienceStatus(data, dayIndex, spotIndex, status) {
  if (!Object.values(EXPERIENCE_STATUS).includes(status)) throw new Error('不支持的体验状态');
  const spot = data.days?.[dayIndex]?.spots?.[spotIndex];
  if (!spot) throw new Error('体验不存在');
  Object.assign(spot, normalizeExperienceSpot({ ...spot, status }, dayIndex, spotIndex));
  data.included = withoutExperience(data.included, spot.name);
  data.excluded = withoutExperience(data.excluded, spot.name);
  data.pendingConfirmations = withoutExperience(data.pendingConfirmations, spot.name);
  if (status === EXPERIENCE_STATUS.OPTIONAL_PAID) data.excluded.push(`${spot.name}：自费可选，费用以最终预订确认为准`);
  else if (status === EXPERIENCE_STATUS.PENDING) data.pendingConfirmations.push(`${spot.name}：待确认`);
  else data.included.push(`${spot.name}：${status === EXPERIENCE_STATUS.RESERVATION_REQUIRED ? '已包含，需提前预约' : '已包含'}`);
  return spot;
}

export function removeExperienceReferences(data, name) {
  data.included = withoutExperience(data.included, name);
  data.excluded = withoutExperience(data.excluded, name);
  data.pendingConfirmations = withoutExperience(data.pendingConfirmations, name);
}

function dateParts(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDays(date, count) {
  const value = dateParts(date);
  if (!value) return null;
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function inclusiveDayCount(startDate, endDate) {
  const start = dateParts(startDate);
  const end = dateParts(endDate);
  if (!start || !end) return null;
  return Math.round((end - start) / 86400000) + 1;
}

export function mapDaysFromStart(data, startDate = data?.startDate) {
  const next = structuredClone(data || {});
  next.startDate = startDate || null;
  next.days = (next.days || []).map((day, index) => ({ ...day, date: startDate ? addDays(startDate, index) : day.date || null }));
  next.dayCount = next.days.length;
  return next;
}

export function formatTravelerCount(data = {}) {
  const adults = Number.isFinite(Number(data.adults)) && data.adults !== "" && data.adults != null ? Number(data.adults) : null;
  const children = Number.isFinite(Number(data.children)) && data.children !== "" && data.children != null ? Number(data.children) : 0;
  if (adults != null && adults > 0) return `${adults}位成人${children > 0 ? ` / ${children}位儿童` : ""}`;
  const travelers = Number.isFinite(Number(data.travelers)) && data.travelers !== "" && data.travelers != null ? Number(data.travelers) : null;
  if (travelers != null && travelers > 0) return `${travelers}位`;
  return "待确认";
}

export function isUsableFinalImageSource(value) {
  const source = cleanText(value);
  return Boolean(source && (/^\/(?!\/)/.test(source) || /^data:image\//i.test(source) || /^blob:/i.test(source)));
}

export function splitRouteNodes(value) {
  const withoutTravel = cleanText(value)
    .replace(/(?:大门间)?(?:车程|飞行|航程|乘车|用时|预计)\s*(?:约)?\s*\d+(?:\.\d+)?\s*(?:小时|分钟)/gi, " ")
    .replace(/\(.*?(?:车程|飞行|航程|小时|分钟).*?\)/gi, " ");
  return unique(withoutTravel
    .split(/(?:→|—|－|-|至|✈|\/|\||｜|\n)+/)
    .map((item) => item.replace(/^(?:抵达|前往|乘车前往|飞往|返回)\s*/, "").replace(/[，,；;。]+$/g, "").trim())
    .filter((item) => item && !/^(?:车程|飞行|航程|约?\d)/.test(item)))
    .slice(0, 6);
}

export function extractTravelTime(...values) {
  const source = values.map(cleanText).join(" ");
  const match = source.match(/(?:大门间)?(?:车程|飞行|航程|乘车|用时|预计)\s*(?:约)?\s*\d+(?:\.\d+)?\s*(?:小时|分钟)/i);
  return match ? match[0].replace(/\s+/g, "") : "待确认";
}

export function inferActivityLevel(day = {}) {
  const source = cleanText(`${day.theme || ""} ${day.description || ""} ${(day.routeNodes || []).join(" ")}`);
  if (/登山|攀登|长距离徒步|全天徒步|高强度/.test(source)) return "较高";
  if (/全天游猎|游猎|迁徙|追踪|浮潜|潜水|骑行|徒步|热气球|博物馆|参观/.test(source)) return "适中";
  return "轻松";
}

function sentenceFor(source, pattern) {
  return cleanText(source).split(/[。！？!？\n]+/).find((sentence) => pattern.test(sentence)) || "";
}

export function buildCoreSpots(day = {}) {
  const description = cleanText(day.description);
  const descriptionParts = description.split(/[；;，,]/).map(cleanText).filter(Boolean);
  const optionalParts = descriptionParts.filter((part) => /自费|另行付费/.test(part));
  const includedDescription = descriptionParts.filter((part) => !/自费|另行付费/.test(part)).join("，") || description;
  const nodes = (day.routeNodes?.length ? day.routeNodes : splitRouteNodes(day.city)).filter((node) => !AIRPORT.test(node));
  const destination = nodes.at(-1) || "";
  const spots = [];
  const push = (name, pattern) => {
    const cleanName = cleanText(name);
    if (!cleanName || spots.some((item) => item.name === cleanName)) return;
    const sourceSentence = sentenceFor(includedDescription, pattern) || includedDescription;
    spots.push({ name: cleanName, description: sourceSentence, sourceEvidence: [sourceSentence], images: [] });
  };

  if (/迁徙|天国之渡|马拉河/.test(`${destination} ${description}`)) {
    push(/马拉河/.test(`${destination} ${description}`) ? "马拉河大迁徙" : `${destination}迁徙追踪`, /迁徙|天国之渡|马拉河/);
  } else if (/草原飞机|飞往|国际航班/.test(`${day.vehicle || ""} ${description}`) && /返程|结束|离开/.test(description)) {
    push("草原飞机返程", /草原飞机|飞往|国际航班|返程/);
  } else if (/游猎|Safari/i.test(description)) {
    push(`${destination || "当日"}${/游猎/.test(destination) ? "" : "游猎"}`, /游猎|五霸|动物/);
  } else if (/草原飞机|飞往|国际航班|返程/.test(`${day.vehicle || ""} ${description}`)) {
    push(/返程|结束|离开/.test(description) ? "草原飞机返程" : "草原飞机抵达", /草原飞机|飞往|国际航班|返程/);
  } else if (destination) {
    push(destination, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  if (/日出/.test(description)) push(`${nodes[0] || destination}日出`, /日出/);
  if (/观星|星空/.test(description)) push("营地观星", /观星|星空/);
  optionalParts.forEach((part) => {
    let name = /热气球/i.test(part) ? "清晨热气球 Safari"
      : /马赛部落/.test(part) ? "马赛部落参访"
      : /反偷猎观察站/.test(part) ? "反偷猎观察站参访"
      : /徒步|夜间游猎/.test(part) ? "保护区徒步与夜间游猎"
      : part.replace(/^.*?(?:自费|另行付费)(?:参加|参观|体验|选择)?/, "").replace(/[，。；].*$/, "").slice(0, 24);
    name = cleanText(name) || "自费可选体验";
    if (!spots.some((item) => item.name === name)) spots.push({ name, description: part, status: EXPERIENCE_STATUS.OPTIONAL_PAID, optional: true, sourceEvidence: [part], images: [] });
  });
  return spots.slice(0, 4);
}

export function inferOvernightType(day = {}, index = 0, dayCount = 1) {
  if (["hotel", "inflight", "none"].includes(day.overnightType)) return day.overnightType;
  const hotel = cleanText(day.hotel || day.hotelShortName);
  if (FLIGHT_OVERNIGHT.test(hotel) || /夜航|机上过夜/.test(`${day.theme || ""} ${day.description || ""}`)) return "inflight";
  if (NO_OVERNIGHT.test(hotel)) return "none";
  if (!hotel && index === dayCount - 1 && /返程|行程结束|国际航班/.test(`${day.theme || ""} ${day.description || ""}`)) return "none";
  return "hotel";
}

export function normalizeDayFacts(day = {}, index = 0, dayCount = 1) {
  const routeNodes = splitRouteNodes(day.routeNodes?.length ? day.routeNodes.join(" → ") : day.city || "");
  const next = {
    ...day,
    routeNodes,
    estimatedTravelTime: day.estimatedTravelTime || extractTravelTime(day.city, day.description),
    activityLevel: day.activityLevel || inferActivityLevel({ ...day, routeNodes }),
  };
  next.overnightType = inferOvernightType(next, index, dayCount);
  if (next.overnightType !== "hotel") {
    if (next.overnightType === "inflight" && !next.overnightLabel) next.overnightLabel = "返程航班";
    next.hotel = "";
    next.hotelShortName = "";
    next.hotelOfficialName = "";
  }
  if (!next.spots?.length) next.spots = buildCoreSpots(next);
  next.spots = (next.spots || []).map((spot, spotIndex) => normalizeExperienceSpot(spot, index, spotIndex));
  if (next.overnightType === "hotel" && next.hotel && routeNodes.length < 6) {
    const hotelName = cleanText(next.hotelShortName || next.hotel);
    if (hotelName && !routeNodes.some((node) => normalizeName(node) === normalizeName(hotelName))) next.routeNodes = [...routeNodes, hotelName];
  }
  return next;
}

function normalizeName(value) {
  return cleanText(value).toLowerCase().replace(/[\s·|:：,，.。/\\_-]+/g, "");
}

export function normalizeItineraryFacts(data = {}, { mapDates = true } = {}) {
  let next = structuredClone(data);
  const dayCount = next.days?.length || 0;
  next.days = (next.days || []).map((day, index) => normalizeDayFacts(day, index, dayCount));
  next.hotels = (next.hotels || []).map((hotel) => {
    const stayDays = next.days.map((day, index) => ({ day, index })).filter(({ day }) => {
      const names = [day.hotel, day.hotelShortName, day.hotelOfficialName].map(normalizeName).filter(Boolean);
      const hotelNames = [hotel.officialName, hotel.shortName].map(normalizeName).filter(Boolean);
      return names.some((name) => hotelNames.some((hotelName) => name.includes(hotelName) || hotelName.includes(name)));
    });
    const firstStay = stayDays[0];
    const routeAnchor = firstStay?.day.routeNodes?.filter((node) => normalizeName(node) !== normalizeName(hotel.officialName) && normalizeName(node) !== normalizeName(hotel.shortName)).at(-1);
    const fallback = [
      firstStay?.index === 0 && "抵达首晚舒适休整",
      Number(hotel.nights) > 1 && `${hotel.nights}晚连住更从容`,
      routeAnchor && `${routeAnchor}行程衔接`,
    ].filter(Boolean);
    return { ...hotel, proofPoints: compactProofPoints(hotel.proofPoints, fallback) };
  });
  next.dayCount = dayCount;
  if (mapDates && next.startDate) next = mapDaysFromStart(next, next.startDate);
  const excluded = Array.isArray(next.excluded) ? next.excluded : [];
  const pendingConfirmations = Array.isArray(next.pendingConfirmations) ? next.pendingConfirmations : [];
  for (const [dayIndex, day] of next.days.entries()) {
    for (const spot of day.spots || []) {
      if (spot.status === EXPERIENCE_STATUS.OPTIONAL_PAID && !excluded.some((item) => cleanText(typeof item === "string" ? item : item?.name || item?.text).includes(spot.name))) {
        excluded.push(`${spot.name}：自费可选，费用以最终预订确认为准`);
      }
      if (spot.status === EXPERIENCE_STATUS.PENDING && !pendingConfirmations.some((item) => cleanText(typeof item === "string" ? item : item?.name || item?.text).includes(spot.name))) {
        pendingConfirmations.push(`DAY ${dayIndex + 1} ${spot.name}：待确认`);
      }
    }
  }
  next.excluded = excluded;
  next.pendingConfirmations = pendingConfirmations;
  next.transportSummary = (next.transportSummary || []).map((item) => ({
    ...item,
    modelGuaranteed: item.modelGuaranteed === true && Boolean((item.sourceEvidence || []).length || item.confirmedByUser),
    modelDisplay: item.model ? (item.modelGuaranteed === true && Boolean((item.sourceEvidence || []).length || item.confirmedByUser) ? item.model : `${item.model}（同等级参考）`) : "",
  }));
  return next;
}

function itemText(value) {
  return cleanText(typeof value === "string" ? value : value?.name || value?.text || value?.title);
}

function containsItem(list, name) {
  const target = normalizeName(name);
  return (list || []).some((item) => {
    const value = normalizeName(itemText(item).split(/[：:]/)[0]);
    return target && value && value === target;
  });
}

export function classifyItineraryIssues(data = {}) {
  const issues = [];
  const add = (classification, code, message, path = "") => issues.push({ classification, code, message, path });
  const days = data.days || [];
  if (!days.length) add("blocker", "days_missing", "没有可生成的逐日行程", "days");
  if (data.dayCount && Number(data.dayCount) !== days.length) add("blocker", "day_count_conflict", `出行天数为${data.dayCount}天，但逐日行程共有${days.length}天`, "dayCount");
  if (data.startDate && data.endDate) {
    const span = inclusiveDayCount(data.startDate, data.endDate);
    if (span !== days.length) add("blocker", "date_span_conflict", `出发至返程按自然日共${span}天，与${days.length}天行程不一致；如返程次日落地，请单独确认回程抵达日`, "endDate");
  } else if (!data.startDate || !data.endDate) {
    add("needs_confirmation", "dates_missing", "出发或返程日期待确认；确认前不会由 AI 猜测。", "startDate");
  }
  if (data.startDate) days.forEach((day, index) => {
    const expected = addDays(data.startDate, index);
    if (day.date && day.date !== expected) add("blocker", "day_date_conflict", `DAY ${index + 1} 日期应为 ${expected}，当前为 ${day.date}`, `days.${index}.date`);
  });
  if (!Number(data.adults || data.travelers)) add("needs_confirmation", "travelers_missing", "出行人数待确认。", "adults");

  const sourceCoverage = data.sourceImportCoverage || {};
  const sourceIncluded = Array.isArray(sourceCoverage.included) ? sourceCoverage.included.map((item) => cleanText(item?.text || item)).filter(Boolean) : [];
  const currentIncluded = Array.isArray(data.included) ? data.included.map(itemText).filter(Boolean) : [];
  if (sourceIncluded.length && currentIncluded.length !== sourceIncluded.length) {
    add("blocker", "included_source_count_mismatch", `原文件有${sourceIncluded.length}项费用包含，当前结构化结果为${currentIncluded.length}项，禁止静默生成`, "included");
  } else if (sourceIncluded.some((item) => !currentIncluded.some((current) => normalizeName(current) === normalizeName(item)))) {
    add("blocker", "included_source_item_missing", "费用包含没有逐项覆盖原文件内容", "included");
  }
  const sourceDailyTransport = Array.isArray(sourceCoverage.dailyTransport) ? sourceCoverage.dailyTransport : [];
  for (const item of sourceDailyTransport) {
    const dayIndex = Number(item?.dayIndex);
    const current = cleanText(days[dayIndex]?.vehicle);
    const expected = cleanText(item?.text);
    if (!current) add("blocker", "daily_transport_source_missing", `原文件DAY ${dayIndex + 1}存在交通安排，但结构化结果为空`, `days.${dayIndex}.vehicle`);
    else if (expected && normalizeName(current) !== normalizeName(expected)) add("blocker", "daily_transport_source_mismatch", `DAY ${dayIndex + 1}交通没有保持原文件事实`, `days.${dayIndex}.vehicle`);
  }
  if (sourceDailyTransport.length && !(data.transportSummary || []).length) {
    add("blocker", "transport_summary_source_missing", "原文件存在每日交通，但全程交通模块为空", "transportSummary");
  }

  (data.hotels || []).forEach((hotel, hotelIndex) => {
    const actualNights = days.filter((day) => day.overnightType === "hotel" && [day.hotel, day.hotelShortName, day.hotelOfficialName].some((name) => {
      const left = normalizeName(name); const right = normalizeName(hotel.officialName || hotel.shortName);
      return left && right && (left.includes(right) || right.includes(left));
    })).length;
    if (actualNights && Number(hotel.nights) && actualNights !== Number(hotel.nights)) add("blocker", "hotel_nights_conflict", `${hotel.shortName || hotel.officialName} 标注${hotel.nights}晚，但逐日住宿对应${actualNights}晚`, `hotels.${hotelIndex}.nights`);
    if (!hotel.officialName) add("needs_confirmation", "hotel_name_missing", `第${hotelIndex + 1}项住宿正式名称待确认`, `hotels.${hotelIndex}.officialName`);
  });

  (data.transportSummary || []).forEach((item, index) => {
    if (item.modelGuaranteed === true && !(item.sourceEvidence || []).length && !item.confirmedByUser) add("blocker", "vehicle_guarantee_without_evidence", `${item.model || item.category || `第${index + 1}项交通`}缺少指定车型的确认依据`, `transportSummary.${index}.modelGuaranteed`);
    const travelers = Number(data.adults || data.travelers || 0) + Number(data.children || 0);
    if (travelers > 0 && Number(item.seatCount) > 0 && Number(item.seatCount) < travelers) add('blocker', 'transport_capacity_conflict', `${item.category || `第${index + 1}项交通`}仅${item.seatCount}座，少于${travelers}位出行人`, `transportSummary.${index}.seatCount`);
  });

  days.forEach((day, dayIndex) => (day.spots || []).forEach((spot, spotIndex) => {
    const inIncluded = containsItem(data.included, spot.name);
    const inExcluded = containsItem(data.excluded, spot.name);
    const inPending = containsItem(data.pendingConfirmations, spot.name);
    if (spot.status === EXPERIENCE_STATUS.INCLUDED && inExcluded) add("blocker", "included_excluded_conflict", `${spot.name} 同时显示已包含和费用不含`, `days.${dayIndex}.spots.${spotIndex}.status`);
    if (spot.status === EXPERIENCE_STATUS.OPTIONAL_PAID && inIncluded) add("blocker", "optional_included_conflict", `${spot.name} 标为自费可选但同时进入费用包含`, `days.${dayIndex}.spots.${spotIndex}.status`);
    if (spot.status === EXPERIENCE_STATUS.PENDING && !inPending) add("needs_confirmation", "pending_not_synchronized", `${spot.name} 为待确认，但待确认清单尚未同步`, `days.${dayIndex}.spots.${spotIndex}.status`);
  }));

  const customerText = JSON.stringify({ title: data.title, subtitle: data.subtitle, highlights: data.highlights, hotels: data.hotels, days: data.days, included: data.included, excluded: data.excluded, notes: data.notes, priceNotes: data.priceNotes });
  if (INTERNAL_CONTENT.test(customerText)) add("blocker", "internal_content_leak", "客户内容包含成本、利润或供应商内部信息", "customerData");
  (data.notes || []).forEach((note, index) => {
    const value = typeof note === 'string' ? note : cleanText(`${note?.title || ''} ${(note?.items || []).join(' ')}`);
    if (TIME_SENSITIVE.test(value) && (!note?.verifiedAt || !note?.sourceUrl) && !/以出发时官方要求为准/.test(value)) add("needs_confirmation", "time_sensitive_unverified", `注意事项第${index + 1}项属于时效信息，需记录权威来源和复核日期，或使用保守表达`, `notes.${index}`);
  });
  return issues;
}

export function validateItineraryFacts(data = {}) {
  const issues = classifyItineraryIssues(data);
  const errors = issues.filter((item) => item.classification === "blocker").map((item) => item.message);
  return { valid: errors.length === 0, errors, issues, needsConfirmation: issues.filter((item) => item.classification === "needs_confirmation"), warnings: issues.filter((item) => item.classification === "warning") };
}

export function compactProofPoints(points, fallback = []) {
  const candidates = [...(Array.isArray(points) ? points : []), ...fallback]
    .flatMap((point) => cleanText(point).split(/[。；;，,、|｜]+/))
    .map((point) => point.replace(/^(?:坐落于|位于|拥有|提供|可享|毗邻)/, "").replace(/(?:的选择|的安排|体验感十足)$/, "").trim())
    .filter((point) => point.length >= 4 && !/^(?:国际品牌管理|服务稳定可靠|高端度假酒店|帐篷营地体验|品质服务|奢华体验)$/.test(point))
    .map((point) => {
      if (/火山口.*日出/.test(point)) return "火山口日出视野";
      if (/Serena/i.test(point)) return "Serena品牌服务";
      if (/梅鲁山/.test(point)) return "梅鲁山脚度假";
      if (/大象.*泉水/.test(point)) return "大象泉水命名";
      if (/塔兰吉雷.*核心/.test(point)) return "塔兰吉雷核心区";
      if (/塞伦盖蒂.*奢华/.test(point)) return "塞伦盖蒂奢华品牌";
      if (/马拉河.*黄金/.test(point)) return "马拉河黄金位置";
      let compact = [...point].slice(0, 10).join("").replace(/[A-Za-z]+$/, "").replace(/[的与和及为可更]$/, "").trim();
      return compact.length >= 4 ? compact : point;
    });
  return unique(candidates).slice(0, 3);
}

export function createProductionDefaultData() {
  return {
    title: "新的深度定制游", subtitle: "", destination: "", dayCount: 0,
    startDate: null, endDate: null, adults: null, children: 0, travelers: null,
    heroImage: "", heroFocus: "50% 50%", sourcePosterHighlights: [], highlights: [],
    hotels: [], diningExperiences: [], transportSummary: [], days: [],
    included: [], excluded: [], cancellation: [], pendingConfirmations: [], priceNotes: [], totalPrice: null, priceUnit: "元 / 人起",
    notes: [], showBookingSection: true, showSecuritySection: true, showPaymentSection: true,
    hotelReplacementPolicy: "酒店与房型以正式确认为准；如遇满房，将由定制师提前沟通同等级替代方案。",
    transportDisclaimer: "用车以约定车辆等级与座位数为履约标准；具体品牌及型号以当地实际调度为准。",
  };
}
