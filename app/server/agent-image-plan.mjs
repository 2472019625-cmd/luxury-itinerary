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
