import { buildLayoutImageSlots } from "../src/lib/imageSlots.js";

const clean = (value) => typeof value === "string" ? value.trim() : "";
const list = (value) => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];

function agentRoleForLayout(slot) {
  if (slot.module === "cover") return "cover";
  if (slot.module === "hotel") return `hotel:${slot.itemIndex + 1}`;
  if (slot.module === "day") return `day:${slot.dayIndex + 1}`;
  if (slot.module === "dining") return `dining:${slot.itemIndex + 1}`;
  if (slot.module === "transport") return `transport:${slot.itemIndex + 1}`;
  return null;
}

function queriesFor(slot, plan, data) {
  const intents = list(plan?.searchIntent || plan?.searchIntents || plan?.queries).map((item) => clean(typeof item === "string" ? item : item?.query)).filter(Boolean);
  const destination = clean(data.destination);
  const subject = clean(plan?.subject || plan?.label || slot.label);
  const grounded = intents.length ? intents : [`${destination} ${subject} official photos`, `${destination} ${subject} travel photography`];
  return grounded.slice(0, 3).map((query) => ({ query: query.slice(0, 180) }));
}

export function materializeAgentImageBlueprint(data, imagePlan = {}, meta = {}) {
  const layoutSlots = buildLayoutImageSlots(data);
  const byRole = new Map(list(imagePlan.slots).map((slot) => [slot.role, slot]));
  const firstDaySlot = new Set();
  const requiredSlotIds = [];
  const removedOptionalSlotIds = [];
  const slots = layoutSlots.map((layout) => {
    const role = agentRoleForLayout(layout);
    const planned = byRole.get(role) || null;
    const firstForDay = layout.module === "day" && !firstDaySlot.has(layout.dayIndex);
    if (firstForDay) firstDaySlot.add(layout.dayIndex);
    const required = layout.module === "cover" || layout.module === "hotel" || firstForDay;
    const useImage = required || planned?.required === false && planned?.removable === false;
    if (required) requiredSlotIds.push(layout.slotId);
    else if (!useImage) removedOptionalSlotIds.push(layout.slotId);
    return {
      slotId: layout.slotId,
      agentRole: role,
      useImage,
      required,
      removable: !required,
      reason: useImage ? clean(planned?.visualDuty || planned?.reason) || "承担该模块的主要视觉证明" : "非必需图片位已从本次成品计划移除并交由版式自动重排",
      location: clean(planned?.location || data.destination),
      brand: clean(planned?.brand),
      subject: clean(planned?.subject || planned?.label || layout.label),
      visualGoal: clean(planned?.visualDuty || planned?.differentiation || layout.purpose),
      mustHave: list(planned?.mustHave),
      prefer: list(planned?.prefer),
      forbid: list(planned?.forbid),
      sourcePriority: ["official", "reputable_public", "commons"],
      fallbackPlan: list(planned?.fallbackPlan || ["broader verified location view", "relevant environment without unsupported specific claims"]),
      priority: required ? "high" : "low",
      searchQueries: queriesFor(layout, planned, data),
      sourceEvidence: [],
    };
  });
  return {
    version: "agent-image-plan-v1",
    journeyStrategy: { positioning: clean(imagePlan.visualStory), visualKeywords: list(imagePlan.visualKeywords), avoidRepetition: list(imagePlan.avoidRepetition) },
    slots,
    meta: { generatedBy: "trip_planner", independentModelCalls: 0, planId: meta.planId || null, materializedAt: new Date().toISOString(), requiredSlotIds, removedOptionalSlotIds },
  };
}

export function evaluateAgentImageCompletion(data) {
  const blueprintSlots = list(data.imageBlueprint?.slots).filter((slot) => slot.useImage !== false);
  const reviews = new Map(list(data.imageReview?.slots).map((slot) => [slot.slotId, slot]));
  const required = blueprintSlots.filter((slot) => slot.required === true);
  const missingRequired = required.filter((slot) => reviews.get(slot.slotId)?.status !== "auto_selected" && reviews.get(slot.slotId)?.status !== "user_locked").map((slot) => ({ slotId: slot.slotId, status: reviews.get(slot.slotId)?.status || "empty" }));
  const pendingRequired = missingRequired.filter((item) => item.status === "manual_review");
  const emptyRequired = missingRequired.filter((item) => item.status !== "manual_review");
  return { passed: missingRequired.length === 0, requiredCount: required.length, completedRequiredCount: required.length - missingRequired.length, missingRequired, pendingRequired, emptyRequired, removedOptionalSlotIds: data.imageBlueprint?.meta?.removedOptionalSlotIds || [] };
}

export function prepareTargetedImageRetry(data, slotIds = []) {
  const requested = new Set(slotIds);
  const next = structuredClone(data);
  const coverAnchors = [...new Set(list(next.days).flatMap((day) => list(day.spots).map((spot) => clean(spot?.name))).filter((name) => name && !/抵达|返程|回国|阿鲁沙/.test(name)))].slice(0, 4);
  next.imageBlueprint = {
    ...(next.imageBlueprint || {}),
    slots: list(next.imageBlueprint?.slots).map((slot) => {
      if (!requested.has(slot.slotId)) return slot;
      const relatedDay = list(next.days).find((day) => String(slot.slotId).startsWith(`day:${day.id}:`));
      const confirmedDayHotel = clean(relatedDay?.hotel);
      const subject = clean(slot.subject);
      const location = clean(slot.location || next.destination);
      const brand = clean(slot.brand);
      const visualGoal = clean(slot.visualGoal);
      const existing = list(slot.searchQueries).map((item) => clean(typeof item === "string" ? item : item?.query)).filter(Boolean);
      const primary = slot.slotId === "cover:hero"
        ? `${location} ${coverAnchors.join(" ")} luxury safari landscape wildlife sunrise`
        : slot.slotId.startsWith("hotel:")
          ? `${subject} ${location} official gallery exterior view`
          : confirmedDayHotel ? `${confirmedDayHotel} official gallery exterior landscape` : brand ? `${brand} ${location} official gallery` : `${location} ${subject} ${visualGoal} travel photography`;
      const secondary = slot.slotId === "cover:hero" ? `${location} destination panorama nature official tourism` : `${location} ${visualGoal} official tourism high resolution`;
      const refined = [
        primary,
        secondary,
        ...existing,
      ].map((query) => query.replace(/\s+/g, " ").trim().slice(0, 180)).filter(Boolean);
      const unique = [...new Set(refined)];
      const mustHave = slot.slotId === "cover:hero"
        ? [`画面必须对应本行程核心场景之一：${coverAnchors.join("、") || location}`]
        : slot.slotId.startsWith("hotel:") ? [`画面必须是${subject}本体或其可核验官方景观`] : confirmedDayHotel ? [`画面应匹配${visualGoal || subject}；首选场景缺失时，只允许以当天确认入住酒店${confirmedDayHotel}的官方图作为人工确认备选`] : [visualGoal || subject].filter(Boolean);
      return { ...slot, mustHave, searchQueries: unique.slice(0, 3).map((query) => ({ query })), retryReason: "previous_candidates_mismatched_or_unverified" };
    }),
  };
  return next;
}
