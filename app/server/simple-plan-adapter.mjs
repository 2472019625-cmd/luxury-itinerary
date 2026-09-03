import { randomUUID } from "node:crypto";

const stringSchema = Object.freeze({ type: "string", minLength: 1 });
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

function copyTask({ targetId, targetPath, moduleType, facts, plannerGoal, relevantContext, layoutHints, required = true }) {
  return {
    targetId,
    targetPath,
    moduleType,
    facts,
    factStatuses: statusFacts(facts),
    plannerGoal,
    relevantContext,
    outputSchema: { ...stringSchema },
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
  data.notes = Array.isArray(data.notes) ? data.notes : [];
  data.days = Array.isArray(data.days) ? data.days : [];
  data.days.forEach((_day, index) => ensureDaySpot(data, index));
  const normalizedRoles = normalizedDayRoles(agentPlan, data.days);
  const effectiveAgentPlan = { ...agentPlan, dayRoles: normalizedRoles };

  const itineraryContext = {
    destination: data.destination,
    dates: { startDate: data.startDate, endDate: data.endDate, dayCount: data.days.length },
    travelers: { travelers: data.travelers, adults: data.adults, children: data.children },
    sourcePosterHighlights: data.sourcePosterHighlights || [],
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
    plannerGoal: "只写 Planner 已确定的这一条亮点，输出短标题加具体客户价值说明；不得新增、删除、换序或重新选择亮点。",
    relevantContext: itineraryContext, layoutHints: { placement: "highlights", itemIndex: index }, required: true,
  })));

  data.hotels.forEach((hotel, index) => copyTasks.push(copyTask({
    targetId: `copy:hotel:${hotel.id || index + 1}`, targetPath: `hotels.${index}.editorialCopy`, moduleType: "hotel",
    facts: hotel,
    plannerGoal: "写出酒店级别、地点、住宿质感及最值得期待的真实空间、景观或体验，建立整程住宿品质感。",
    relevantContext: itineraryContext, layoutHints: { placement: "hotel_card", itemIndex: index }, required: true,
  })));
  data.diningExperiences.forEach((item, index) => copyTasks.push(copyTask({
    targetId: `copy:dining:${item.id || index + 1}`, targetPath: `diningExperiences.${index}.editorialCopy`, moduleType: "dining",
    facts: item,
    plannerGoal: "写出真实特色餐饮类型、场景、氛围与期待价值，并保留正式状态。",
    relevantContext: itineraryContext, layoutHints: { placement: "dining_card", itemIndex: index }, required: false,
  })));
  data.transportSummary.forEach((item, index) => copyTasks.push(copyTask({
    targetId: `copy:transport:${item.id || index + 1}`, targetPath: `transportSummary.${index}.editorialCopy`, moduleType: "transport",
    facts: item,
    plannerGoal: "写出主要交通类别、真实配置、舒适度、时间效率与整体移动品质；不得承诺未确认车型。",
    relevantContext: itineraryContext, layoutHints: { placement: "transport_card", itemIndex: index }, required: false,
  })));
  data.days.forEach((day, index) => copyTasks.push(copyTask({
    targetId: `copy:day:${index + 1}`, targetPath: `days.${index}.description`, moduleType: "day",
    facts: day,
    plannerGoal: `写清 DAY ${index + 1} 今天具体经历什么、为什么值得，以及如何承接整程；保留所有事实与状态。`,
    relevantContext: { ...itineraryContext, dayRole: dayRole(effectiveAgentPlan, index), adjacentDays: [data.days[index - 1], data.days[index + 1]].filter(Boolean).map((item) => ({ theme: item.theme, routeNodes: item.routeNodes, description: item.description })) },
    layoutHints: { placement: "day_detail", dayIndex: index, ordinaryDaySoftMaxChars: 220, transferDaySoftMaxChars: 130, sentenceCountReference: 5 }, required: true,
  })));
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
        },
        plannerGoal: "生成每份行程固定必需的旅行准备与注意事项。按本次已确认目的地、路线、活动和旅客事实选择实际相关类别，使用温和、具体、可执行的服务型语气；时效信息无正式来源时只作行前核验提示，不虚构政策、天气、健康或安全结论。",
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
    addSlot(slot({ slotId, moduleType: "transport", required: false, activity: clean(item.category), subject: clean(item.modelGuaranteed ? item.model : item.category), visualGoal: `准确展示${item.category || "本次主要交通方式"}及其真实移动体验，不形成未确认车型承诺`, visualContext: { category: item.category, serviceLevel: item.serviceLevel, usageLabel: item.usageLabel, modelGuaranteed: item.modelGuaranteed === true ? "已确认车型" : "车型未保证", avoid: [] }, copyTargetId: `copy:transport:${item.id || index + 1}`, aspectRatio: "16:9", userLocked: Boolean(data.imageLocks?.[slotId]) }), { module: "transport", itemIndex: index, fieldPath: `transportSummary.${index}.images.0`, imageIndex: 0, required: false });
  });
  data.days.forEach((day, index) => {
    const role = dayRole(effectiveAgentPlan, index);
    const dayPlan = plannedImageSlot(effectiveAgentPlan, `day:${index + 1}`);
    const { spot: primarySpot, spotIndex } = selectPrimaryDaySpot(day, role, dayPlan);
    const primarySubject = clean(primarySpot?.name || role.primaryVisualSubject || day.theme);
    const location = geographicDayLocation(day, data.hotels.flatMap((hotel) => [hotel.officialName, hotel.shortName]), data.destination);
    const status = clean(primarySpot?.status || primarySpot?.feeBoundary || "included");
    const statusLabel = clean(primarySpot?.statusLabel || (status === "optional_paid" ? "自费可选" : status === "included" ? "已包含" : "待确认"));
    const optionalBoundary = ["optional_paid", "reservation_required", "pending"].includes(status) ? `；该视觉重点为${statusLabel}，不得暗示已包含` : "";
    const slotId = `image:day:${index + 1}:primary`;
    addSlot(slot({
      slotId, moduleType: "day", required: true,
      location, activity: primarySubject, subject: primarySubject,
      visualGoal: `以${primarySubject}作为 DAY ${index + 1} 的真实主要视觉职责；${role.differenceFromAdjacent || "与相邻 DAY 保持真实差异"}${optionalBoundary}`,
      visualContext: { dayIndex: index, dayRole: role.role || "", differenceFromAdjacent: role.differenceFromAdjacent || "", routeNodes: day.routeNodes || [], geographicLocation: location, primaryVisualSubject: primarySubject, allActivities: (day.spots || []).map((spot) => ({ name: spot.name, description: spot.description, status: spot.status, statusLabel: spot.statusLabel, feeBoundary: spot.feeBoundary })), experienceStatus: status, statusLabel, feeBoundary: primarySpot?.feeBoundary || "", sourceExperience: primarySpot?.description || day.description, daySourceFacts: dayFactText(day), adjacentVisualResponsibilities: [dayRole(effectiveAgentPlan, index - 1).role, dayRole(effectiveAgentPlan, index + 1).role].filter(Boolean), avoid: [] },
      copyTargetId: `copy:day:${index + 1}`, aspectRatio: "16:9", userLocked: Boolean(data.imageLocks?.[slotId]),
    }), { module: "day", dayIndex: index, spotIndex, fieldPath: `days.${index}.spots.${spotIndex}.images.0`, imageIndex: 0, required: true });
  });

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
