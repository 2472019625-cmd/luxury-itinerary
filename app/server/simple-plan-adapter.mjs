import { randomUUID } from "node:crypto";

const stringSchema = Object.freeze({ type: "string", minLength: 1 });
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
  data.days = Array.isArray(data.days) ? data.days : [];
  data.days.forEach((_day, index) => ensureDaySpot(data, index));

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
    relevantContext: { ...itineraryContext, dayRole: dayRole(agentPlan, index), adjacentDays: [data.days[index - 1], data.days[index + 1]].filter(Boolean).map((item) => ({ theme: item.theme, routeNodes: item.routeNodes, description: item.description })) },
    layoutHints: { placement: "day_detail", dayIndex: index, ordinaryDaySoftMaxChars: 220, transferDaySoftMaxChars: 130, sentenceCountReference: 5 }, required: true,
  })));

  const imageSlots = [];
  const slotBindings = {};
  const addSlot = (value, binding) => { imageSlots.push(value); slotBindings[value.slotId] = binding; };
  addSlot(slot({
    slotId: "image:cover:primary", moduleType: "cover", required: true,
    location: clean(data.destination), subject: clean(data.destination),
    visualGoal: clean(agentPlan.imagePlan?.visualStory) || `呈现${data.destination || "本次目的地"}最具代表性的整程主视觉，并为标题保留空间`,
    visualContext: { destination: data.destination, productTheme: agentPlan.summary?.visualTheme || "", avoid: [] },
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
    const primarySpot = day.spots[0];
    const role = dayRole(agentPlan, index);
    const slotId = `image:day:${index + 1}:primary`;
    addSlot(slot({
      slotId, moduleType: "day", required: true,
      location: clean((day.routeNodes || []).at(-1) || day.city), activity: clean(primarySpot?.name || day.theme), subject: clean(primarySpot?.name || day.theme),
      visualGoal: role.differenceFromAdjacent ? `${day.theme || `DAY ${index + 1}`}的核心体验；${role.differenceFromAdjacent}` : `展示 DAY ${index + 1} 在${(day.routeNodes || []).at(-1) || day.city || "当日地点"}的核心真实体验，并与相邻 DAY 形成视觉差异`,
      visualContext: { dayIndex: index, dayRole: role.role || "", routeNodes: day.routeNodes || [], activity: primarySpot?.name || "", sourceExperience: primarySpot?.description || day.description, adjacentVisualResponsibilities: [dayRole(agentPlan, index - 1).role, dayRole(agentPlan, index + 1).role].filter(Boolean), avoid: [] },
      copyTargetId: `copy:day:${index + 1}`, aspectRatio: "16:9", userLocked: Boolean(data.imageLocks?.[slotId]),
    }), { module: "day", dayIndex: index, spotIndex: 0, fieldPath: `days.${index}.spots.0.images.0`, imageIndex: 0, required: true });
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
    dayRoles: agentPlan.dayRoles || [],
    copyTasks,
    imageSlots,
    slotBindings,
    itineraryContext,
    preparedData: data,
  };
}
