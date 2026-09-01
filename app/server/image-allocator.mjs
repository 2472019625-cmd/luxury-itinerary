import { buildLayoutImageSlots, setSlotImage } from "../src/lib/imageSlots.js";

const list = (value) => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];

export function buildImageSlots(data, { includeLocked = false } = {}) {
  const blueprintById = new Map((data.imageBlueprint?.slots || []).map((item) => [item.slotId, item]));
  const locked = data.imageLocks || {};
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return buildLayoutImageSlots(data).map((layout, order) => {
    const plan = blueprintById.get(layout.slotId);
    if (!plan || plan.useImage === false || (!includeLocked && locked[layout.slotId])) return null;
    const query = plan.searchQueries?.[0]?.query || "";
    return {
      ...layout,
      key: layout.slotId,
      order,
      location: plan.location || "",
      brand: plan.brand || "",
      subject: plan.subject || layout.label,
      context: layout.adjacentText,
      query,
      queries: list(plan.searchQueries).map((item) => typeof item === "string" ? item : item.query).filter(Boolean),
      visualRequirement: plan.visualGoal || layout.purpose,
      mustHave: list(plan.mustHave),
      prefer: list(plan.prefer),
      forbid: list(plan.forbid),
      sourcePriority: list(plan.sourcePriority),
      fallbackPlan: list(plan.fallbackPlan),
      priority: plan.priority || "medium",
      imageCount: 1,
      apply(next, images) { setSlotImage(next, layout, images[0]); },
    };
  }).filter(Boolean).sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1) || a.order - b.order);
}

export function applySelections(data, selections) {
  const next = structuredClone(data);
  for (const { slot, images } of selections) slot.apply(next, images);
  const changed = new Set(selections.map((item) => item.slot.slotId));
  const newRecords = selections.flatMap(({ slot, records }) => records.map((record) => ({ slot: slot.slotId, slotId: slot.slotId, label: slot.label, query: slot.query, visualRequirement: slot.visualRequirement, ...record })));
  next.imageSourceLedger = [...(data.imageSourceLedger || []).filter((item) => !changed.has(item.slotId || item.slot)), ...newRecords];
  return next;
}
