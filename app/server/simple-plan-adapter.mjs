import { randomUUID } from "node:crypto";

const stringSchema = Object.freeze({ type: "string", minLength: 1 });
const subtitleSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 76 });
const hotelProofPointsSchema = Object.freeze({ type: "array", minItems: 0, maxItems: 3, items: { type: "string", minLength: 1 } });
const transportUsageLabelSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 80 });
const transportFeaturesSchema = Object.freeze({ type: "array", minItems: 0, maxItems: 3, items: { type: "string", minLength: 1 } });
const diningCopySchema = Object.freeze({ type: "string", minLength: 12, maxLength: 96 });
const dayNoticeSchema = Object.freeze({ type: "string", minLength: 8, maxLength: 90 });
const notesSchema = Object.freeze({
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["title", "items"],
    properties: {
      title: { type: "string", minLength: 1 },
      icon: { type: "string", minLength: 1 },
      tone: { enum: ["gold", "warning"] },
      items: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    },
    additionalProperties: false,
  },
});
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const unique = (values) => [...new Set(values.map(clean).filter(Boolean))];

function actionByModule(agentPlan = {}) {
  return new Map((agentPlan.modules || []).map((item) => [item.moduleId, {
    visible: item.decision !== "hide",
    action: item.contentAction || "generate",
  }]));
}

function statusFacts(value) {
  if (Array.isArray(value)) return value.map(statusFacts);
  if (!value || typeof value !== "object") return value;
  return { sourceState: "structured", ...Object.fromEntries(Object.entries(value).filter(([key]) => /status|included|optional|pending|reservation|confirm|feeBoundary/i.test(key)).map(([key, item]) => [key, statusFacts(item)])) };
}

function copyTask({ targetId, targetPath, moduleType, facts, plannerGoal, relevantContext, layoutHints, outputSchema = stringSchema, researchRequest, required = true }) {
  return {
    targetId,
    targetPath,
    moduleType,
    facts,
    factStatuses: statusFacts(facts),
    plannerGoal,
    relevantContext,
    outputSchema: structuredClone(outputSchema),
    ...(researchRequest ? { researchRequest: structuredClone(researchRequest) } : {}),
    layoutHints,
    required,
  };
}

function slot({ slotId, moduleType, required, location = "", hotel = "", activity = "", subject = "", visualGoal, visualContext, copyTargetId, aspectRatio = "16:9", userLocked = false }) {
  return { slotId, moduleType, required, location, hotel, activity, subject, visualGoal, visualContext, copyTargetId, aspectRatio, userLocked };
}

function dayRole(agentPlan, index) {
  return (agentPlan.dayRoles || []).find((item) => Number(item.index) === index) || {};
}

function hotelCopyFacts(hotel = {}) {
  const { editorialCopy: _editorialCopy, proofPoints: _proofPoints, images: _images, ...facts } = hotel;
  return {
    ...facts,
    sourceEvidence: unique(facts.sourceEvidence || []),
    lodgingIdentityEvidence: unique((facts.sourceEvidence || []).filter((item) => /^DAY \d+ 住宿：/.test(clean(item)))),
    supplierHotelContext: unique((facts.sourceEvidence || []).filter((item) => !/^DAY \d+ 住宿：/.test(clean(item)))),
  };
}

function diningCopyGuidance(item = {}) {
  const name = clean(`${item.title || ""} ${item.officialName || ""}`);
  if (/Sundowner|落日酒会/i.test(name)) return "产品化参考句：喝一杯 Sundowner，让黄昏时的短暂停留成为游猎与晚间安排之间的品饮体验。可直接采用或轻量改写，不扩写额外分句；不增加具体酒水、服务配置或旅程总结。";
  if (/星空(?:晚宴|晚餐)/.test(name)) return "产品化参考句：在天际甲板享用星空晚宴，让这顿晚餐拥有不同于普通餐厅的用餐环境。可直接采用或轻量改写，不扩写额外分句；不增加其他天象、布置或服务配置。";
  if (/酒窖|品酒/.test(name)) return "产品化参考句：在私人酒窖慢慢品酒，为当天增加一段节奏更缓的品鉴体验。可直接采用或轻量改写，不扩写额外分句；不增加人员、藏酒配置、具体酒款、酒款品质或包含承诺，不在总览正文重复局部收费。";
  if (/Bush\s*Breakfast|丛林早餐|野外早餐/i.test(name)) return "产品化参考句：把早餐安排到野外，让清晨的自然体验延续到用餐。可直接采用或轻量改写，不扩写额外分句；不增加布置、制作、热饮、周边动植物或菜单。";
  if (/百兽宴|Carnivore/i.test(name)) return "产品化参考句：晚餐品尝非洲“百兽宴”的特色烤肉，让这顿饭以明确的非洲风味区别于普通晚餐。可直接采用或轻量改写，不扩写额外分句；不增加菜品数量、座席、上菜、切割、烹饪或服务流程，也不追加整程收尾。";
  if (item.officialName || /餐厅|烤肉/.test(name)) return "产品化参考句须从 sourceEvidence 已确认的餐饮类型、风味或品尝重点切入，并说明它与普通用餐的直接差异。只写一个完整句子；不增加菜品数量、座席、上菜、切割、烹饪或服务流程，也不追加整程收尾。";
  return "先解释已确认的餐饮类型、品饮内容或用餐方式，再说明它与普通三餐的差异及一个直接客户价值；不新增可独立核验的现场配置。";
}

function officialDomainsFromHotel(hotel = {}) {
  return unique([
    ...(Array.isArray(hotel.officialDomains) ? hotel.officialDomains : []),
    hotel.officialDomain,
    hotel.website,
    hotel.officialUrl,
  ].map((value) => {
    const candidate = clean(value);
    if (!candidate) return "";
    try { return new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname; } catch { return candidate; }
  }));
}

function hotelResearchRequest(hotel = {}) {
  const entityName = clean(hotel.officialName || hotel.shortName);
  if (!entityName) return null;
  const officialDomains = officialDomainsFromHotel(hotel);
  return {
    researchType: "official_entity_facts",
    entityName,
    categories: ["空间与设计", "景观与环境", "公共空间与居停方式"],
    ...(officialDomains.length ? { officialDomains } : {}),
  };
}

function transportEvidencePattern(item = {}) {
  const identity = clean([item.category, item.serviceLevel, item.model].join(" "));
  if (/飞机|航班|航空/.test(identity)) return /飞机|航班|航空|机票/;
  if (/越野|游猎|4\s*[x×*]\s*4/i.test(identity)) return /越野|游猎车|4\s*[x×*]\s*4/i;
  if (/商务|轿车|接送|专车|mpv/i.test(identity)) return /商务|市区[^。；]*车|机场[^。；]*车|接送/i;
  return new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function transportSupportingFacts(report = {}, item = {}) {
  const pattern = transportEvidencePattern(item);
  return unique((report.cellCoverage || []).map((cell) => clean(cell?.raw)).filter((raw) => raw && pattern.test(raw)));
}

function transportDayContexts(data = {}, item = {}) {
  const dayNumbers = unique([...(item.usageSegments || []), ...(item.sourceEvidence || [])]
    .flatMap((value) => [...clean(value).matchAll(/DAY\s*(\d+)/gi)].map((match) => match[1])))
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  return dayNumbers.map((dayNumber) => {
    const day = data.days?.[dayNumber - 1] || {};
    return {
      dayNumber,
      routeNodes: day.routeNodes || [],
      city: day.city || "",
      activities: (day.spots || []).map((spot) => spot.name).filter(Boolean),
      vehicle: day.vehicle || "",
    };
  });
}

function transportScopeBoundary(item = {}) {
  const identity = clean([item.category, item.serviceLevel, item.model].join(" "));
  if (/飞机|航班|航空/.test(identity)) return "保留原始航段的成对起讫关系，不把航点压成无关系的地点列表";
  if (/越野|游猎|4\s*[x×*]\s*4/i.test(identity)) return "只概括园区、保护区及游猎场景，优先使用真实区域名称";
  if (/商务|轿车|接送|专车|mpv/i.test(identity)) return "混合交通日只概括城市与机场服务，不把草原飞机或越野车承担的保护区及跨区路段归入商务车";
  return "只概括当前交通类别可以从来源中明确归属的使用范围";
}

function enrichTransportConfiguration(data = {}, report = {}) {
  data.transportSummary = (data.transportSummary || []).map((item) => {
    const supportingFacts = transportSupportingFacts(report, item);
    const identity = clean([item.category, item.serviceLevel].join(" "));
    const normalized = { ...item, usageLabel: clean(item.usageLabel), features: Array.isArray(item.features) ? item.features : [] };
    if (item.seatCount || !/越野|游猎|4\s*[x×*]\s*4/i.test(identity)) return normalized;
    const seatCount = supportingFacts.map((fact) => Number(fact.match(/(\d+)\s*座(?=[^。；]*(?:4\s*[x×*]\s*4|越野))/i)?.[1])).find((value) => Number.isInteger(value) && value > 0);
    return seatCount ? { ...normalized, seatCount } : normalized;
  });
}

function spotActivityPattern(name = "") {
  const text = clean(name);
  if (/游猎|safari/i.test(text)) return /游猎|safari|game\s*drive/i;
  if (/徒步|步行|walking/i.test(text)) return /徒步|步行|walking/i;
  if (/热气球|balloon/i.test(text)) return /热气球|balloon/i;
  if (/部落|村落|社区|马赛/i.test(text)) return /部落|村落|社区|马赛/i;
  if (/观景|观察站|参访|参观/i.test(text)) return /观景|观察站|参访|参观/i;
  return null;
}

function scopeSpotEvidence(value, spotName) {
  const text = clean(value);
  if (!text) return "";
  if (/酒店|营地|lodge|camp|篝火|泳池|躺椅|客房|套房/i.test(clean(spotName))) return text;
  const activityPattern = spotActivityPattern(spotName);
  const clauses = text.split(/[，,。；;]/).map(clean).filter(Boolean);
  const scoped = clauses.filter((clause) => {
    const isLodgingScene = /酒店|营地|lodge|camp|篝火|泳池|躺椅|客房|套房/i.test(clause);
    return !isLodgingScene || activityPattern?.test(clause);
  });
  return scoped.join("；") || clean(spotName);
}

function spotCopyFacts(spot = {}) {
  return {
    name: spot.name,
    description: scopeSpotEvidence(spot.description, spot.name),
    status: spot.status,
    statusLabel: spot.statusLabel,
    feeBoundary: spot.feeBoundary,
    optional: spot.optional,
    sourceEvidence: unique((spot.sourceEvidence || []).map((item) => scopeSpotEvidence(item, spot.name)).filter(Boolean)),
  };
}

function dayFactText(day = {}) {
  return unique([day.theme, day.city, day.description, ...(day.routeNodes || []), ...(day.spots || []).flatMap((spot) => [spot.name, spot.description, ...(spot.sourceEvidence || [])])]).join("；");
}

function removeFalseNoSafari(value, day) {
  const sourceHasSafari = /游猎|safari/i.test(dayFactText(day));
  const claim = clean(value);
  if (!sourceHasSafari || !/(?:无|没有|不含|未安排)[^，。；]{0,10}(?:游猎|safari)/i.test(claim)) return claim;
  const corrected = clean(claim.replace(/(?:无|没有|不含|未安排)[^，。；]{0,10}(?:游猎|safari)(?:活动)?/gi, "抵达后包含已确认游猎内容"));
  return corrected || "抵达后包含原始资料明确的游猎内容";
}

function normalizedDayRoles(agentPlan, days) {
  return days.map((day, index) => {
    const role = dayRole(agentPlan, index);
    return {
      ...role,
      index,
      role: removeFalseNoSafari(role.role || day.theme || `DAY ${index + 1}`, day),
      differenceFromAdjacent: removeFalseNoSafari(role.differenceFromAdjacent || "按当天全部真实事实与相邻 DAY 区分", day),
      contentAction: role.contentAction || "optimize",
      sourceRefs: Array.isArray(role.sourceRefs) ? role.sourceRefs : [],
    };
  });
}

function longestSharedRun(left, right) {
  const a = clean(left).toLowerCase();
  const b = clean(right).toLowerCase();
  let best = 0;
  for (let start = 0; start < a.length; start += 1) {
    for (let end = start + 2; end <= a.length; end += 1) if (b.includes(a.slice(start, end))) best = Math.max(best, end - start);
  }
  return best;
}

function selectPrimaryDaySpot(day, role = {}, plannedSlot = {}) {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  if (!spots.length) return { spot: null, spotIndex: 0 };
  const plannedSubject = clean(role.primaryVisualSubject || plannedSlot.primaryVisualSubject);
  if (plannedSubject) {
    const plannedIndex = spots.findIndex((spot) => {
      const facts = clean([spot.name, spot.description, ...(spot.sourceEvidence || [])].join(" "));
      return facts.includes(plannedSubject) || plannedSubject.includes(clean(spot.name));
    });
    if (plannedIndex >= 0) return { spot: spots[plannedIndex], spotIndex: plannedIndex };
  }
  const distinction = clean([role.differenceFromAdjacent, role.role, plannedSlot.differentiation, plannedSlot.visualDuty].join(" "));
  const ranked = spots.map((spot, spotIndex) => ({ spot, spotIndex, score: Math.max(longestSharedRun(spot.name, distinction), longestSharedRun(spot.description, distinction)) }));
  ranked.sort((a, b) => b.score - a.score || Number(b.spot.status === "included") - Number(a.spot.status === "included") || a.spotIndex - b.spotIndex);
  return ranked[0];
}

function geographicDayLocation(day = {}, hotelNames = [], fallback = "") {
  const hotelKeys = unique([day.hotel, day.hotelShortName, day.hotelOfficialName, ...hotelNames]).map((item) => clean(item).toLowerCase());
  const nodes = unique(day.routeNodes || []).filter((node) => !hotelKeys.some((hotel) => hotel && (clean(node).toLowerCase() === hotel || clean(node).toLowerCase().includes(hotel))));
  const geographic = nodes.filter((node) => !/机场|airport|酒店|lodge|camp|resort/i.test(node));
  return clean(geographic.at(-1) || nodes.at(-1) || day.city || fallback);
}

// Image geography deliberately does not change Copy's existing context.
function imageDayLocation(day, hotels, fallback) {
  const lodging = hotels.find((hotel) => [hotel.officialName, hotel.shortName].some((name) => name && [day.hotel, day.hotelOfficialName, day.hotelShortName].includes(name)));
  const hotelNames = new Set(hotels.flatMap(hotel => [hotel.officialName, hotel.shortName]).filter(Boolean));
  const isPlace = (value) => value && !hotelNames.has(value) && !/夜间|游猎|星空|观星|入住|退房|接送|送机|离境|sundowner|westgate|safari|酒店|营地|hotel|lodge|camp|体验|晚宴|早餐|热气球|观景台|博物馆|长颈鹿中心|机场/i.test(value);
  const nodes = unique(day.routeNodes || []).filter(isPlace);
  const regions = nodes.filter(value => /公园|保护区|核心区|地区|national park|reserve|conservancy/i.test(value));
  const cities = unique(String(day.city || '').split(/[\n·→✈🚗-]+/u).map(value => clean(value).replace(/^抵达/, '').replace(/全天游猎$/, ''))).filter(isPlace);
  return clean(regions.at(-1) || cities.at(-1) || nodes.at(-1) || (isPlace(lodging?.region) && lodging.region) || fallback);
}

function plannedImageSlot(agentPlan = {}, role) {
  return (agentPlan.imagePlan?.slots || []).find((item) => item.role === role) || {};
}

function ensureDaySpot(data, index) {
  const day = data.days[index];
  if (Array.isArray(day.spots) && day.spots.length) return;
  const subject = clean(day.theme || day.city || `DAY ${index + 1}`);
  day.spots = [{
    id: `day-${index + 1}-primary`,
    name: subject,
    description: clean(day.description),
    status: "pending",
    statusLabel: "待确认",
    feeBoundary: "pending",
    sourceEvidence: unique([day.description, ...(day.routeNodes || [])]),
    images: [],
  }];
}

function dayNoticeBasis(day = {}, index = 0) {
  const confirmedDescription = clean(day.sourceEvidence?.description) || clean(day.description);
  const confirmedSpotFacts = (day.spots || []).flatMap((spot) => {
    const sourceFacts = (spot.sourceEvidence || []).map(clean).filter(Boolean);
    return [spot.name, ...(sourceFacts.length ? sourceFacts : [spot.description])];
  });
  const rawSource = clean([
    day.sourceEvidence?.route,
    confirmedDescription,
    day.sourceEvidence?.vehicle,
    day.vehicle,
    day.estimatedTravelTime,
    ...(day.routeNodes || []),
  ].join(" "));
  const source = clean([
    day.sourceEvidence?.route,
    confirmedDescription,
    day.sourceEvidence?.vehicle,
    day.vehicle,
    day.estimatedTravelTime,
    ...(day.routeNodes || []),
    ...confirmedSpotFacts,
  ].join(" "));
  const evidence = unique([
    day.sourceEvidence?.route,
    day.sourceEvidence?.description,
    day.sourceEvidence?.vehicle,
    day.estimatedTravelTime,
    ...(day.spots || []).flatMap((spot) => spot.sourceEvidence || []),
  ]).map((item) => `DAY ${index + 1}：${item}`);
  const optionalSpot = (day.spots || []).find((spot) => ["optional_paid", "reservation_required", "pending"].includes(spot.status));
  if (/热气球/.test(source)) return { type: "optional_early_experience", adviceScope: "若客户考虑参加当天热气球体验，提醒提前确认安排并为较早开始的节奏做准备；不得新增集合时间、价格或天气保证。", evidence };
  if (/草原飞机|轻型飞机|内陆(?:段)?航班|小飞机/.test(rawSource)) return { type: "light_aircraft_baggage", adviceScope: "提醒把随身必需品优先整理好，具体行李要求只写出票后由定制师协助核对；不得新增材质、尺寸或重量数字。", evidence };
  if (/徒步|步行\s*(?:Safari|游猎)/i.test(source)) return { type: "walking_footwear", adviceScope: "提醒当天选择适合行走的鞋与便于活动的穿着，不扩展路线难度、里程或装备规格。", evidence };
  if (/夜间游猎|夜游|观星|星空床|户外淋浴/.test(source)) return { type: "night_experience_layer", adviceScope: "提醒为夜间户外体验准备可增减的衣物，不新增具体温度或天气结论。", evidence };
  const duration = day.estimatedTravelTime?.match(/(\d+(?:\.\d+)?)/)?.[1];
  if (duration && Number(duration) >= 4) return { type: "long_transfer", adviceScope: "基于已有真实车程，提醒把途中常用物品放在随手可取的位置，让长距离移动更从容；可以引用已有时长，不新增停靠或服务承诺。", evidence };
  if (/雪山|乞力马扎罗|日出|观景台/.test(source)) return { type: "weather_sensitive_view", adviceScope: "提醒景观体验受当天能见度影响，行程中保持从容弹性；不得保证天气、日出或景观出现。", evidence };
  if (optionalSpot) return { type: "optional_experience_confirmation", adviceScope: `仅提醒如希望参加“${clean(optionalSpot.name)}”，建议提前与定制师确认；必须保留${optionalSpot.statusLabel || optionalSpot.status}状态，不得改成已包含或已预订。`, evidence: unique([...evidence, ...(optionalSpot.sourceEvidence || []).map((item) => `DAY ${index + 1}：${item}`)]) };
  return null;
}

function prepareDayNotice(data, index) {
  const day = data.days[index];
  day.dayNotices = Array.isArray(day.dayNotices) ? day.dayNotices.slice(0, 1) : [];
  if (day.dayNotices[0]?.text) return null;
  const basis = dayNoticeBasis(day, index);
  if (!basis) {
    day.dayNotices = [];
    return null;
  }
  day.dayNotices = [{
    type: "tip",
    text: "",
    sourceKind: "copy_from_confirmed_day_facts",
    basisType: basis.type,
    sourceEvidence: basis.evidence,
  }];
  return basis;
}

export function materializeSimpleSkillPlan({ data: sourceData = {}, report = {}, agentPlan = {} } = {}) {
  const data = structuredClone(sourceData);
  const moduleActions = actionByModule(agentPlan);
  const visible = (moduleId, fallback = true) => moduleActions.has(moduleId) ? moduleActions.get(moduleId).visible : fallback;
  const moduleVisibility = {
    global: true,
    hotels: visible("hotels", (data.hotels || []).length > 0),
    dining: visible("dining", (data.diningExperiences || []).length > 0),
    transport: visible("transport", (data.transportSummary || []).length > 0),
    days: true,
    notes: true,
    expenses: true,
  };
  if (!moduleVisibility.hotels) data.hotels = [];
  if (!moduleVisibility.dining) data.diningExperiences = [];
  if (!moduleVisibility.transport) data.transportSummary = [];
  enrichTransportConfiguration(data, report);
  data.notes = Array.isArray(data.notes) ? data.notes : [];
  data.days = Array.isArray(data.days) ? data.days : [];
  data.days.forEach((_day, index) => ensureDaySpot(data, index));
  const dayNoticeBases = data.days.map((_day, index) => prepareDayNotice(data, index));
  const normalizedRoles = normalizedDayRoles(agentPlan, data.days);
  const effectiveAgentPlan = { ...agentPlan, dayRoles: normalizedRoles };

  const itineraryContext = {
    destination: data.destination,
    dates: { startDate: data.startDate, endDate: data.endDate, dayCount: data.days.length },
    travelers: { travelers: data.travelers, adults: data.adults, children: data.children },
    sourcePosterHighlights: (agentPlan.factBasis?.sourcePosterHighlights || data.sourcePosterHighlights || []).flatMap((item) => clean(item).split(/\r?\n/).map(clean)).filter(Boolean),
    officialProductValues: agentPlan.factBasis?.officialProductValues || [],
    plannerSummary: agentPlan.summary || {},
    moduleVisibility,
    sourceWarnings: report.warnings || [],
  };
  const copyTasks = [];
  copyTasks.push(copyTask({
    targetId: "copy:cover:title", targetPath: "title", moduleType: "cover",
    facts: { currentTitle: data.title, destination: data.destination, dayCount: data.days.length },
    plannerGoal: "在不改变目的地和天数事实的前提下，形成准确、可单行阅读的产品标题。",
    relevantContext: itineraryContext, layoutHints: { placement: "cover", singleLinePreferred: true }, required: true,
  }));
  const primaryJourneyAnchors = unique([
    ...(agentPlan.selectedHighlights || []).map((item) => clean(typeof item === "string" ? item : item?.sourceText)),
    ...normalizedRoles.flatMap((item) => [item.role, item.differenceFromAdjacent]),
  ]).slice(0, 3);
  copyTasks.push(copyTask({
    targetId: "copy:cover:subtitle", targetPath: "subtitle", moduleType: "cover_subtitle",
    facts: {
      currentSubtitle: data.subtitle,
      destination: data.destination,
      dayCount: data.days.length,
      journeyTheme: clean(agentPlan.summary?.contentTheme),
      primaryJourneyAnchors,
    },
    plannerGoal: "写一条整程销售叙事。优先从 Planner 整程主题和 2—3 个最有辨识度的真实锚点中选择内容，体现这条产品的核心体验组合与旅行结果；不要把全部地点、酒店、交通和卖点拼成清单，也不要写通用品牌口号。原 Parser subtitle 仅作兜底参考。",
    relevantContext: itineraryContext, layoutHints: { placement: "cover", singleLinePreferred: true }, outputSchema: subtitleSchema, required: true,
  }));

  if (!Array.isArray(agentPlan.selectedHighlights)) {
    const error = new Error("Planner 未返回冻结契约要求的 selectedHighlights");
    error.code = "planner_highlights_contract_missing";
    throw error;
  }
  if (agentPlan.selectedHighlights.length > 7) {
    const error = new Error("Planner 返回超过7条产品亮点，必须先在规划阶段完成排序和同义合并，Program不得静默截断");
    error.code = "planner_highlights_capacity_exceeded";
    throw error;
  }
  const selectedHighlights = agentPlan.selectedHighlights.map((item) => typeof item === "string" ? { sourceText: clean(item), sourceType: "source_designated", sourceRefs: [], selectionReason: "Planner已确定" } : item).filter((item) => clean(item?.sourceText));
  const warnings = selectedHighlights.length < 5 ? [{
    code: "product_highlight_material_insufficient",
    message: `真实资料仅支持 ${selectedHighlights.length} 条产品亮点，少于目标范围 5—7 条；已保留真实亮点，不虚构补足。`,
    actualCount: selectedHighlights.length,
    targetRange: { min: 5, max: 7 },
  }] : [];
  data.highlights = selectedHighlights.map((item) => clean(item.sourceText));
  selectedHighlights.forEach((selection, index) => copyTasks.push(copyTask({
    targetId: `copy:highlight:${index + 1}`, targetPath: `highlights.${index}`, moduleType: "product_highlight",
    facts: { selectedByPlanner: selection.sourceText, sourceType: selection.sourceType, sourceRefs: selection.sourceRefs || [], selectionReason: selection.selectionReason || "" },
    plannerGoal: "只写 Planner 已确定的这一条亮点，输出短标题加具体客户价值说明；一条只解释一个购买理由，不得为了饱满再叠加其他独立卖点，也不得新增、删除、换序或重新选择亮点。",
    relevantContext: itineraryContext, layoutHints: { placement: "highlights", itemIndex: index }, required: true,
  })));

  data.hotels.forEach((hotel, index) => {
    const researchRequest = hotelResearchRequest(hotel);
    const facts = hotelCopyFacts(hotel);
    copyTasks.push(copyTask({
      targetId: `copy:hotel:${hotel.id || index + 1}`, targetPath: `hotels.${index}.editorialCopy`, moduleType: "hotel",
      facts,
      plannerGoal: "写 2—4 句直接、易读的酒店产品介绍，全文最多采用 2 个有辨识度的住宿事实。第一句说明这是什么酒店、位于哪里；随后分别说明所选特点带来的客户住宿价值；最多一句轻量说明它在整程中的产品角色。每句话只承担一个主要功能，少用长并列句，不用比喻、拟人、抽象奢华形容或情绪化收尾。准确保留来源语义，例如“设计灵感来自”不能改成“由其改建”。verifiedFacts 只是候选素材，不要求全部进入正文，不做官网摘要或设施清单。若 verifiedFacts 为 0，只能使用 supplierHotelContext 中明确属于当前酒店的事实；资料不足时保持克制，不得以泛化酒店介绍或产品角色替代真实事实。",
      relevantContext: itineraryContext, layoutHints: { placement: "hotel_card", itemIndex: index }, researchRequest, required: true,
    }));
    copyTasks.push(copyTask({
      targetId: `copy:hotel:${hotel.id || index + 1}:proof-points`, targetPath: `hotels.${index}.proofPoints`, moduleType: "hotel_proof_points",
      facts,
      plannerGoal: "输出 2—3 个真实、具体、可快速理解的短标签，不写完整说明句。优先选择来源中的准确地点或保护区名称、明确景观、空间类型、真实数量及直接住宿价值；不得自行添加评价性修饰，不使用抽象修辞包装事实，不重复 editorialCopy 的完整句子，不以“位于、拥有、提供、配备”开头。verifiedFacts 为 0 但 supplierHotelContext 明确提供了酒店自身的欢迎仪式、空间或餐饮体验时，仍可从这些来源事实选择标签。每项优先 4—10 个中文字，约 14 字以上通常说明过长。若事实只支持 0—1 个标签，按真实数量返回并在 warnings 明确酒店事实不足，不得凑满。",
      relevantContext: itineraryContext, layoutHints: { placement: "hotel_card_proof_points", itemIndex: index }, outputSchema: hotelProofPointsSchema, researchRequest, required: true,
    }));
  });
  data.diningExperiences.forEach((item, index) => copyTasks.push(copyTask({
    targetId: `copy:dining:${item.id || index + 1}`, targetPath: `diningExperiences.${index}.editorialCopy`, moduleType: "dining",
    facts: {
      id: item.id,
      title: item.title,
      officialName: item.officialName,
      sourceEvidence: item.sourceEvidence || [],
      copyGuidance: diningCopyGuidance(item),
    },
    plannerGoal: "优先写一个完整短句；只有来源包含两个必须分别表达的餐饮信息时才写两句。采用“餐饮动作或内容 → 已确认的体验方式/场景 → 与普通用餐的直接差异或价值”的产品句式。第一句必须以吃、喝、品、早餐、晚餐或明确餐饮类型为语义主体；优先直接采用 facts.copyGuidance 的产品化参考句，确需贴合 title 或 sourceEvidence 时只做轻量改写。Dining 不承担当天或整趟旅程的收束职责：餐饮内容、体验方式、场景和直接价值写清后立即结束，不总结一天，不告别地点，也不为旅程收尾。即使移除场景和氛围修饰，正文仍必须让客户看懂餐饮内容、体验方式和差异。允许味觉、品饮、场景和氛围表达，也允许基于已确认体验做通常语义范围内的自然动作展开，不要求 sourceEvidence 出现完全相同原句；但不能先写风景再补餐饮。不得借用本批其他 Dining target 的事实。卡片已单独展示 title、location 与 status，正文不重复 DAY 编号、完整 title、officialName、地点名和状态标签。局部升级收费只保留在 sourceEvidence，不进入总览正文，也不得暗示升级消费已包含；不新增会改变费用、订单或履约理解的具体硬事实。",
    relevantContext: itineraryContext, layoutHints: { placement: "dining_card", itemIndex: index }, outputSchema: diningCopySchema, required: false,
  })));
  data.transportSummary.forEach((item, index) => {
    const facts = {
      ...item,
      supportingSourceFacts: transportSupportingFacts(report, item),
      dayContexts: transportDayContexts(data, item),
      scopeBoundary: transportScopeBoundary(item),
    };
    copyTasks.push(copyTask({
      targetId: `copy:transport:${item.id || index + 1}:usage`, targetPath: `transportSummary.${index}.usageLabel`, moduleType: "transport_usage",
      facts,
      plannerGoal: "把内部 usageSegments、supportingSourceFacts 与 dayContexts 概括成一条客户可见使用范围，回答这项交通主要用在哪里。严格遵守 facts.scopeBoundary：商务车只写城市与机场服务；越野车优先写真实园区/保护区名称；草原飞机保留真实航段的成对起讫关系。选择 2—4 个范围，用“ · ”分隔；不输出 DAY 编号，不把活动标题或酒店名当作范围，也不新增事实。",
      relevantContext: itineraryContext, layoutHints: { placement: "transport_card_scope", itemIndex: index }, outputSchema: transportUsageLabelSchema, required: false,
    }));
    copyTasks.push(copyTask({
      targetId: `copy:transport:${item.id || index + 1}`, targetPath: `transportSummary.${index}.editorialCopy`, moduleType: "transport",
      facts,
      plannerGoal: "只写一段客户价值正文，围绕当前交通配置最重要的一个价值，解释它为什么让整趟旅行更舒服、更顺畅或更适合游猎。严格遵守 facts.scopeBoundary，不把混合交通日中由其他交通承担的路段归给当前交通。不要重复使用范围、产品名称和角色标签，不写交通工具百科。没有来源时不要自行补座位空间、动力、准时性、车型能力、包含状态或精确节省时间。",
      relevantContext: itineraryContext, layoutHints: { placement: "transport_card", itemIndex: index }, required: false,
    }));
    copyTasks.push(copyTask({
      targetId: `copy:transport:${item.id || index + 1}:features`, targetPath: `transportSummary.${index}.features`, moduleType: "transport_features",
      facts,
      plannerGoal: "输出 2—3 个短配置价值点，只选择 category、serviceLevel、seatCount、usageSegments、supportingSourceFacts 与 dayContexts 能直接支持且客户一眼能理解的信息。每条尽量把配置翻译成客户价值，例如开顶结构说明观察或摄影更方便；可表达有来源的承载数量、真实使用方式、明确段数或跨区移动价值。不得补写未确认车型、行李规则、包含状态、人员配比或一般交通百科。事实不足时按真实数量返回，不得凑数。",
      relevantContext: itineraryContext, layoutHints: { placement: "transport_card_proof_points", itemIndex: index }, outputSchema: transportFeaturesSchema, required: false,
    }));
  });
  data.days.forEach((day, index) => {
    const role = dayRole(effectiveAgentPlan, index);
    const adjacentDays = [data.days[index - 1], data.days[index + 1]].filter(Boolean).map((item) => ({ theme: item.theme, routeNodes: item.routeNodes, description: item.description }));
    copyTasks.push(copyTask({
      targetId: `copy:day:${index + 1}:theme`, targetPath: `days.${index}.theme`, moduleType: "day_theme",
      facts: { date: day.date, city: day.city, routeNodes: day.routeNodes || [], spots: (day.spots || []).map((spot) => ({ name: spot.name, status: spot.status, statusLabel: spot.statusLabel })), hotel: day.hotel, vehicle: day.vehicle },
      plannerGoal: `从 DAY role、相邻日差异与当天真实体验中，只选择最值得记住的 1 个主记忆点，必要时带 1 个辅助点，写成标题式短句。Theme 是客户钩子，不是当天总结，不解释整程推进逻辑，不要求覆盖所有体验；“抵达、转场、返程”等动作只有与当天独特体验或旅行变化结合时才可成为主题。`,
      relevantContext: { ...itineraryContext, dayRole: role, adjacentDays },
      layoutHints: { placement: "day_theme", dayIndex: index, singleLinePreferred: true }, required: true,
    }));
    copyTasks.push(copyTask({
      targetId: `copy:day:${index + 1}`, targetPath: `days.${index}.description`, moduleType: "day",
      facts: day,
      plannerGoal: `站在高端定制旅行产品经理视角，从当天真实事实中选择 1 个主体验、最多 1 个辅助体验，写成顺畅的客户叙事。结构字段负责保存完整路线、餐食、住宿、交通、Spot 与状态，正文不需要逐项复述。与相邻 DAY 保持真实重点差异，说明最核心的体验如何发生、为什么值得；不要为了事实完整把当天所有活动全部塞进正文。`,
      relevantContext: { ...itineraryContext, dayRole: role, adjacentDays },
      layoutHints: { placement: "day_detail", dayIndex: index, ordinaryDaySoftMaxChars: 220, transferDaySoftMaxChars: 130, sentenceCountReference: 5 }, required: true,
    }));
    const noticeBasis = dayNoticeBases[index];
    if (noticeBasis) copyTasks.push(copyTask({
      targetId: `copy:day:${index + 1}:notice`, targetPath: `days.${index}.dayNotices.0.text`, moduleType: "day_notice",
      facts: {
        date: day.date,
        routeNodes: day.routeNodes || [],
        vehicle: day.vehicle || "",
        estimatedTravelTime: day.estimatedTravelTime || "",
        activityLevel: day.activityLevel || "",
        applicableSignal: noticeBasis.type,
        sourceEvidence: noticeBasis.evidence,
        factBoundary: "只能依据上述当天事实生成一条准备建议；不得新增政策、费用、包含状态、预约状态、服务承诺、精确时间、设施、行李重量数字或动物出现保证。",
      },
      plannerGoal: `生成最多一条与当天具体体验高度相关的实用贴士。${noticeBasis.adviceScope} 语言简短、服务型，像定制师提前想到的提醒；不写警告、命令或全程通用注意事项。若无法形成真实且有帮助的提醒，应返回 needs_input，不得用泛化句凑数。`,
      relevantContext: { destination: data.destination, dayNumber: index + 1 },
      layoutHints: { placement: "day_notice", dayIndex: index, maxItems: 1 }, outputSchema: dayNoticeSchema, required: false,
    }));
    (day.spots || []).forEach((spot, spotIndex) => copyTasks.push(copyTask({
      targetId: `copy:day:${index + 1}:spot:${spot.id || spotIndex + 1}:description`, targetPath: `days.${index}.spots.${spotIndex}.description`, moduleType: "day_spot",
      facts: spotCopyFacts(spot),
      plannerGoal: `只写当前 Spot。用 1—2 句说明这项体验怎么发生、为什么值得。不得总结整天，不得借入酒店、餐食、交通或其他 Spot。若当前事实不足以形成新的差异，保持简洁，不为了区别相邻日而制造细节；不得改写名称、正式状态、费用边界或来源证据。`,
      relevantContext: {
        destination: data.destination,
        dayNumber: index + 1,
        geographicContext: geographicDayLocation(day, data.hotels.flatMap((hotel) => [hotel.officialName, hotel.shortName]), data.destination),
        status: { status: spot.status, statusLabel: spot.statusLabel, feeBoundary: spot.feeBoundary, optional: spot.optional },
        spotOccurrence: {
          dayNumber: index + 1,
          ordinal: data.days.slice(0, index + 1).flatMap((item) => item.spots || []).filter((item) => clean(item.name) === clean(spot.name)).length,
          total: data.days.flatMap((item) => item.spots || []).filter((item) => clean(item.name) === clean(spot.name)).length,
        },
        adjacentSameNameSpotSummary: data.days.flatMap((item, otherDayIndex) => (item.spots || [])
          .filter((itemSpot) => otherDayIndex !== index && clean(itemSpot.name) === clean(spot.name))
          .map((itemSpot) => ({ dayNumber: otherDayIndex + 1, description: clean(itemSpot.description) }))),
      },
      layoutHints: { placement: "day_experience_card", dayIndex: index, spotIndex }, required: true,
    })));
  });
  if (!Array.isArray(data.notes) || data.notes.length === 0) {
    copyTasks.push({
      ...copyTask({
        targetId: "copy:notes:travel-preparation",
        targetPath: "notes",
        moduleType: "notes",
        facts: {
          destination: data.destination,
          dates: { startDate: data.startDate, endDate: data.endDate, dayCount: data.days.length },
          travelers: { travelers: data.travelers, adults: data.adults, children: data.children },
          routeNodes: unique(data.days.flatMap((day) => day.routeNodes || [])),
          activities: unique(data.days.flatMap((day) => (day.spots || []).map((spot) => spot.name))),
          transportCategories: unique((data.transportSummary || []).map((item) => item.category)),
          dayFacts: data.days.map((day, index) => ({ index, theme: day.theme, routeNodes: day.routeNodes || [], activities: (day.spots || []).map((spot) => spot.name), overnightType: day.overnightType })),
          factBoundary: {
            authoritativeCurrentFacts: [],
            noSourceMeansDoNotAdd: ["证件有效期或空白页要求", "具体签证或健康证明要求", "行李材质、尺寸或重量规则", "小费习惯或金额", "固定确认期限", "供应商资质与尚未配置的服务承诺"],
            permittedServiceLanguage: "仅可说明定制师会在出票或出发前协助按最新正式信息核对，不得宣称已经确认或保证处理全部变数",
          },
        },
        plannerGoal: "生成每份行程固定必需的暖心旅行提醒，定位为“这些细节定制师已经提前替客户想到，也会协助确认”。按真实相关性选择服务型标题。每条先说明服务团队提前考虑或将协助核对什么，再给客户一个具体准备动作；需要临近出发确认时明确由定制师协助，不把责任单独推给客户。保留必要的入境、健康、行李与活动安全事实，但改写为安心建议，不写命令、免责或营销软文。facts.factBoundary 是硬事实边界：authoritativeCurrentFacts 为空，因此不得输出任何具体证件有效期、签证/疫苗/健康证明要求、行李材质/尺寸/重量规则、小费习惯或固定确认期限；只能说明相应要求会由定制师在出票或出发前按最新正式信息协助核对。不得声称已经掌握输入中没有的客户偏好、健康情况或纪念日，也不得承诺未配置的顾问服务、供应商资质、布置或全部项目已确认。",
        relevantContext: itineraryContext,
        layoutHints: { placement: "closing_notes", compact: true },
        required: true,
      }),
      outputSchema: notesSchema,
    });
  }

  const imageSlots = [];
  const slotBindings = {};
  const addSlot = (value, binding) => { imageSlots.push(value); slotBindings[value.slotId] = binding; };
  const coverPlan = plannedImageSlot(effectiveAgentPlan, "cover");
  const coverSubject = clean(coverPlan.primaryVisualSubject) || clean(data.destination);
  addSlot(slot({
    slotId: "image:cover:primary", moduleType: "cover", required: true,
    location: clean(data.destination), subject: coverSubject,
    visualGoal: `只以${coverSubject || data.destination || "本次目的地代表性场景"}作为封面唯一核心视觉焦点，并为标题保留清晰空间`,
    visualContext: { destination: data.destination, productTheme: agentPlan.summary?.visualTheme || "", journeyVisualStory: clean(agentPlan.imagePlan?.visualStory), singleFocus: true, avoid: [] },
    copyTargetId: "copy:cover:title", aspectRatio: "5:3", userLocked: Boolean(data.imageLocks?.["image:cover:primary"]),
  }), { module: "cover", fieldPath: "heroImage", imageIndex: 0, required: true });

  data.hotels.forEach((hotel, index) => {
    const slotId = `image:hotel:${hotel.id || index + 1}:primary`;
    const copyTargetId = `copy:hotel:${hotel.id || index + 1}`;
    addSlot(slot({ slotId, moduleType: "hotel", required: true, location: clean(hotel.region), hotel: clean(hotel.officialName), subject: clean(hotel.officialName), visualGoal: `确认并展示${hotel.officialName || hotel.shortName}最能体现真实住宿品质的代表性空间`, visualContext: { region: hotel.region, hotelPositioning: hotel.selectionReason || "", signatureExperience: hotel.signatureExperience || "", avoid: [] }, copyTargetId, aspectRatio: "16:9", userLocked: Boolean(data.imageLocks?.[slotId]) }), { module: "hotel", itemIndex: index, fieldPath: `hotels.${index}.images.0`, imageIndex: 0, required: true });
  });
  data.diningExperiences.forEach((item, index) => {
    const slotId = `image:dining:${item.id || index + 1}:primary`;
    addSlot(slot({ slotId, moduleType: "dining", required: false, location: clean(item.location), activity: clean(item.title), subject: clean(item.officialName || item.title), visualGoal: `展示${item.title || "特色餐饮"}真实的用餐形态、环境与体验氛围`, visualContext: { location: item.location, experience: item.title, status: item.status || item.feeBoundary || "", avoid: [] }, copyTargetId: `copy:dining:${item.id || index + 1}`, aspectRatio: "16:9", userLocked: Boolean(data.imageLocks?.[slotId]) }), { module: "dining", itemIndex: index, fieldPath: `diningExperiences.${index}.images.0`, imageIndex: 0, required: false });
  });
  data.transportSummary.forEach((item, index) => {
    const slotId = `image:transport:${item.id || index + 1}:primary`;
    addSlot(slot({ slotId, moduleType: "transport", required: false, location: clean(item.location || data.destination), activity: clean(item.category), subject: clean(item.modelGuaranteed ? item.model : item.category), visualGoal: `准确展示${item.category || "本次主要交通方式"}及其真实移动体验，不形成未确认车型承诺`, visualContext: { destination: data.destination, category: item.category, serviceLevel: item.serviceLevel, usageLabel: item.usageLabel, modelGuaranteed: item.modelGuaranteed === true ? "已确认车型" : "车型未保证", avoid: [] }, copyTargetId: `copy:transport:${item.id || index + 1}`, aspectRatio: "16:9", userLocked: Boolean(data.imageLocks?.[slotId]) }), { module: "transport", itemIndex: index, fieldPath: `transportSummary.${index}.images.0`, imageIndex: 0, required: false });
  });
  data.days.forEach((day, index) => {
    const role = dayRole(effectiveAgentPlan, index);
    const planned = (effectiveAgentPlan.imagePlan?.slots || []).filter((item) => item.role === `day:${index + 1}` || String(item.role || "").startsWith(`day:${index + 1}:`));
    const ordered = [...planned].sort((a, b) => Number(b.required === true) - Number(a.required === true));
    if (ordered.length > 4) throw new Error(`DAY ${index + 1} 图片位超过4个，请在 Planner 中收敛辅助视觉`);
    const imageIndices = new Map();
    (ordered.length ? ordered : [{}]).forEach((dayPlan, visualIndex) => {
    const primarySubject = clean(dayPlan.primaryVisualSubject) || clean(role.primaryVisualSubject) || clean(selectPrimaryDaySpot(day, role, {}).spot?.name || day.theme);
    // A storage binding is not a semantic fallback: never replace the planned subject.
    const normalizedSubject = primarySubject.toLowerCase().replace(/\s+/g, '');
    const matchedIndex = (day.spots || []).findIndex((spot) => clean(spot.name).toLowerCase().replace(/\s+/g, '') === normalizedSubject);
    const spotIndex = matchedIndex >= 0 ? matchedIndex : 0;
    const referencedIndices = [...new Set((dayPlan.sourceRefs || []).flatMap(ref => {
      const match = String(ref).replace(/^factBasis\./, '').replace(/\[(\d+)\]/g, '.$1').match(/^days\.(\d+)\.spots\.(\d+)(?:\.|$)/);
      return match && Number(match[1]) === index && day.spots?.[Number(match[2])] ? [Number(match[2])] : [];
    }))];
    const primarySpot = matchedIndex >= 0 ? day.spots[matchedIndex] : referencedIndices.length === 1 ? day.spots[referencedIndices[0]] : null;
    const imageIndex = imageIndices.get(spotIndex) || 0;
    imageIndices.set(spotIndex, imageIndex + 1);
    const location = imageDayLocation(day, data.hotels, data.destination);
    const status = clean(primarySpot?.status || primarySpot?.feeBoundary);
    const statusLabel = clean(primarySpot?.statusLabel || (status === "optional_paid" ? "自费可选" : status === "included" ? "已包含" : status ? "待确认" : ""));
    const optionalBoundary = ["optional_paid", "reservation_required", "pending"].includes(status) ? `；该视觉重点为${statusLabel}，不得暗示已包含` : "";
    const required = visualIndex === 0;
    const slotId = `image:day:${index + 1}:${required ? "primary" : `supporting:${visualIndex}`}`;
    const visualCopyPath = `simpleImageSlotBindings.${slotId.replace(/:/g, '_')}`;
    copyTasks.push(copyTask({
      targetId: `copy:visual:${slotId}`, targetPath: visualCopyPath, moduleType: 'visual_card',
      facts: { visualSubject: primarySubject, daySourceFacts: dayFactText(day), sourceEvidence: dayPlan.sourceRefs || role.sourceRefs || [], experiences: (day.spots || []).map(spotCopyFacts), matchedSpot: matchedIndex >= 0 ? spotCopyFacts(primarySpot) : null, status, statusLabel, feeBoundary: primarySpot?.feeBoundary || '' },
      plannerGoal: '为当前视觉体验返回{cardTitle,cardDescription}。cardTitle是短、直接的客户体验名称，不是图片画面提示词，不写姿态、构图、光线等非核心细节。cardDescription写1—2句怎么体验、为什么值得，只使用本日真实事实，不总结整天，不复制泛化Spot全文，不新增事实或费用承诺。有准确匹配Spot时优先复用其适合本体验的短描述。卡片不显示状态标签，但描述不得暗示未购买体验已包含。',
      relevantContext: { dayRole: role.role, visualSubject: primarySubject, otherVisualSubjects: ordered.map(item => item.primaryVisualSubject).filter(item => item !== primarySubject) },
      layoutHints: { placement: 'visual_card', slotId }, outputSchema: { type: 'object', required: ['cardTitle', 'cardDescription'], additionalProperties: false, properties: { cardTitle: { type: 'string', minLength: 2, maxLength: 48 }, cardDescription: { type: 'string', minLength: 12, maxLength: 160 } } }, required,
    }));
    addSlot({ ...slot({
      slotId, moduleType: "day", required,
      location, activity: primarySubject, subject: primarySubject,
      visualGoal: unique([dayPlan.visualDuty, dayPlan.differentiation || role.differenceFromAdjacent, primarySubject]).join("；") + optionalBoundary,
      visualContext: { dayIndex: index, dayRole: role.role || "", differenceFromAdjacent: role.differenceFromAdjacent || "", routeNodes: day.routeNodes || [], geographicLocation: location, primaryVisualSubject: primarySubject, allActivities: (day.spots || []).map((spot) => ({ name: spot.name, description: spot.description, status: spot.status, statusLabel: spot.statusLabel, feeBoundary: spot.feeBoundary })), experienceStatus: status, statusLabel, feeBoundary: primarySpot?.feeBoundary || "", sourceExperience: primarySpot?.description || day.description, daySourceFacts: dayFactText(day), adjacentVisualResponsibilities: [dayRole(effectiveAgentPlan, index - 1).role, dayRole(effectiveAgentPlan, index + 1).role].filter(Boolean), avoid: [] },
      copyTargetId: `copy:day:${index + 1}`, aspectRatio: "16:9", userLocked: Boolean(data.imageLocks?.[slotId]),
    }), primaryVisualSubject: primarySubject, searchIntent: dayPlan.searchIntent || "", sourceEvidence: dayPlan.sourceRefs || role.sourceRefs || [], visualTier: required ? "primary" : "supporting", removable: !required }, { module: "day", dayIndex: index, itemIndex: index, spotIndex, fieldPath: `days.${index}.spots.${spotIndex}.images.${imageIndex}`, imageIndex, required, visualSubject: primarySubject, useSpotCopy: matchedIndex >= 0 });
    });
  });

  data.simpleImageSlotBindings = structuredClone(slotBindings);
  for (const binding of Object.values(data.simpleImageSlotBindings)) {
    if (binding.module !== 'day' || binding.useSpotCopy !== false) continue;
    binding.description = '';
    const context = imageSlots.find(item => item.moduleType === 'day' && item.visualContext.dayIndex === binding.dayIndex && item.subject === binding.visualSubject)?.visualContext;
    binding.status = context?.experienceStatus || 'pending';
    binding.statusLabel = context?.statusLabel || '待确认';
    binding.feeBoundary = context?.feeBoundary || binding.status;
    binding.reminder = '';
  }

  if (imageSlots.length > 48) {
    const error = new Error(`图片位共 ${imageSlots.length} 个，超过技术安全上限 48；不得静默截断`);
    error.code = "image_slot_capacity_exceeded";
    error.excessSlotIds = imageSlots.slice(48).map((item) => item.slotId);
    throw error;
  }
  const copyTargetIds = new Set(copyTasks.map((item) => item.targetId));
  const missingLinks = imageSlots.filter((item) => !copyTargetIds.has(item.copyTargetId));
  if (missingLinks.length) throw new Error(`图片位缺少有效 copyTargetId：${missingLinks.map((item) => item.slotId).join(", ")}`);

  return {
    planId: randomUUID(),
    projectId: agentPlan.projectId,
    flowKind: "simple_skill_v1",
    sourceAgentPlanId: agentPlan.planId || null,
    inputFingerprint: agentPlan.inputFingerprint || null,
    createdAt: new Date().toISOString(),
    moduleVisibility,
    plannerSummary: agentPlan.summary || {},
    warnings,
    dayRoles: normalizedRoles,
    copyTasks,
    imageSlots,
    slotBindings,
    itineraryContext,
    preparedData: data,
  };
}
