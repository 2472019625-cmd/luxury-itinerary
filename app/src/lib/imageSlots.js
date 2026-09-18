const cleanId = (value, fallback) => String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || fallback;

function dayBindingSpot(data, binding) {
  const spots = data.days?.[binding.dayIndex]?.spots || [];
  if (binding.spotId) {
    const byId = spots.find((spot) => String(spot.id || "") === String(binding.spotId));
    if (byId) return byId;
  }
  return spots[binding.spotIndex] || null;
}

function imageArray(item) {
  if (Array.isArray(item?.images)) return item.images;
  if (item?.image) return [{ src: typeof item.image === "string" ? item.image : item.image.src, focus: item.focus || item.image.focus }];
  return [];
}

function definition(base, imageIndex, role, ratio = "16:9") {
  return { ...base, slotId: `${base.slotBase}:${role}`, imageIndex, role, ratio, maxImages: 1, allowEmpty: true };
}

export function buildLayoutImageSlots(data = {}) {
  if (data.simpleImageSlotBindings) {
    const { simpleImageSlotBindings, ...legacyData } = data;
    const existing = new Map(buildLayoutImageSlots(legacyData).map(slot => [slot.fieldPath, slot]));
    return Object.entries(simpleImageSlotBindings).map(([slotId, binding]) => {
      const sourceSpot = binding.module === 'day' ? dayBindingSpot(data, binding) : null;
      const spotId = binding.module === 'day' && binding.useSpotCopy !== false ? String(binding.spotId || sourceSpot?.id || '') || null : null;
      const title = binding.cardTitle || (binding.module === 'day' && binding.useSpotCopy === false ? '行程体验' : existing.get(binding.fieldPath)?.label) || '行程图片';
      const subject = binding.editorPrimaryVisualSubject || binding.visualSubject || existing.get(binding.fieldPath)?.purpose || '';
      const editorState = binding.editorImageStatus ? `${binding.editorImageStatus} · ${binding.editorImageRequired ? '必需' : '可选'}` : '';
      return {
        ...existing.get(binding.fieldPath), ...binding, slotId, spotId,
        label: binding.module === 'day' && editorState ? `${title}${subject && subject !== title ? `｜${subject}` : ''}\n${editorState}` : title,
        purpose: subject,
        itemIndex: binding.module === "day" ? binding.dayIndex : binding.itemIndex,
        ratio: existing.get(binding.fieldPath)?.ratio || "16:9", maxImages: 1, allowEmpty: true,
      };
    });
  }
  const slots = [definition({ slotBase: "cover", module: "cover", fieldPath: "heroImage", dayIndex: null, adjacentText: `${data.title || ""} ${data.subtitle || ""} ${data.destination || ""}`.trim(), label: "封面主图", purpose: "代表整趟旅程的目的地主视觉" }, 0, "hero", "5:3")];
  (data.hotels || []).forEach((item, index) => {
    const id = cleanId(item.id, `hotel-${index + 1}`);
    slots.push(definition({ slotBase: `hotel:${id}`, module: "hotel", itemIndex: index, fieldPath: `hotels.${index}.images.0`, dayIndex: null, adjacentText: `${item.officialName || ""} ${item.shortName || ""} ${item.region || ""} ${item.editorialCopy || ""}`.trim(), label: item.shortName || item.officialName || `酒店${index + 1}`, purpose: "证明酒店值得入住的真实空间" }, 0, "primary", "16:9"));
  });
  (data.diningExperiences || []).forEach((item, index) => {
    const id = cleanId(item.id, `dining-${index + 1}`);
    const base = { slotBase: `dining:${id}`, module: "dining", itemIndex: index, dayIndex: Number.isInteger(item.sourceDay) ? item.sourceDay : null, adjacentText: `${item.title || ""} ${item.officialName || ""} ${item.location || ""} ${item.editorialCopy || ""}`.trim(), label: item.title || `餐饮${index + 1}` };
    slots.push(definition({ ...base, fieldPath: `diningExperiences.${index}.images.0`, purpose: "展示真实用餐环境与体验" }, 0, "scene", "16:9"));
    if (item.layout === "wide" && item.composite) slots.push(definition({ ...base, fieldPath: `diningExperiences.${index}.images.1`, purpose: "展示与环境不同的餐食或服务细节" }, 1, "detail", "16:9"));
  });
  (data.transportSummary || []).forEach((item, index) => {
    const lowValue = /普通|接机|送机|机场接送|入住|退房|自由活动/i.test(`${item.category || ""} ${item.serviceLevel || ""}`) && !String(item.model || "").trim();
    if (lowValue) return;
    const id = cleanId(item.id, `transport-${index + 1}`);
    const business = /商务|business|\bvan\b|v[ -]?class/i.test(`${item.category || ""} ${item.model || ""}`);
    const base = { slotBase: `transport:${id}`, module: "transport", itemIndex: index, dayIndex: null, adjacentText: `${item.category || ""} ${item.model || ""} ${item.serviceLevel || ""} ${(item.usageSegments || []).join(" ")} ${item.editorialCopy || ""}`.trim(), label: item.category || `交通${index + 1}` };
    slots.push(definition({ ...base, fieldPath: `transportSummary.${index}.images.0`, purpose: business ? "清楚展示交通工具外观" : "清楚展示正确交通工具" }, 0, business ? "exterior" : "primary", "16:9"));
    if (business) slots.push(definition({ ...base, fieldPath: `transportSummary.${index}.images.1`, purpose: "展示舒适整洁且与外观不同的内部空间" }, 1, "interior", "16:9"));
  });
  (data.days || []).forEach((day, dayIndex) => {
    const daySlots = [];
    const returnOrTransfer = ['inflight', 'none'].includes(day.overnightType) || /返程|转场|接机|送机|抵达/.test(`${day.theme || ''} ${day.description || ''}`);
    const rich = (day.spots || []).length >= 3 || /日出|游猎|徒步|热气球|文化|观星|船|潜水/.test(`${day.description || ''}`) && (day.spots || []).length >= 2;
    const hasGroundedDayContext = String(day.description || '').trim().length >= 12;
    const target = Math.min(4, !hasGroundedDayContext ? (day.spots || []).length : returnOrTransfer ? Math.min(2, Math.max(1, (day.spots || []).length)) : rich ? Math.max(3, (day.spots || []).length) : Math.max(2, (day.spots || []).length));
    (day.spots || []).forEach((spot, spotIndex) => {
      const dayId = cleanId(day.id, `day-${dayIndex + 1}`);
      const spotId = cleanId(spot.id || spot.name, `spot-${spotIndex + 1}`);
      const base = { slotBase: `day:${dayId}:spot:${spotId}`, module: "day", itemIndex: dayIndex, spotId: spot.id || null, spotIndex, dayIndex, adjacentText: `${day.theme || ""} ${day.description || ""} ${(day.routeNodes || []).join(" ")} ${day.vehicle || ""} ${day.estimatedTravelTime || ""} ${JSON.stringify(day.mealPlan || {})} ${day.hotel || ""} ${spot.name || ""} ${spot.description || spot.experience || ""}`.trim(), label: `DAY ${dayIndex + 1} · ${spot.name || `体验${spotIndex + 1}`}` };
      daySlots.push(definition({ ...base, fieldPath: `days.${dayIndex}.spots.${spotIndex}.images.0`, purpose: returnOrTransfer ? "展示当日转场或收束动作（transition）" : "展示当天核心体验的环境或行动主体（environment/action）" }, 0, "primary", "16:9"));
      if (spot.composite) daySlots.push(definition({ ...base, fieldPath: `days.${dayIndex}.spots.${spotIndex}.images.1`, purpose: "展示同一复合体验中不同的行动或细节主体" }, 1, "detail", "16:9"));
    });
    for (let index = 0; daySlots.length < target && index < (day.spots || []).length; index += 1) {
      const spot = day.spots[index];
      const primary = daySlots.find((slot) => slot.spotIndex === index);
      if (!primary || daySlots.some((slot) => slot.spotIndex === index && slot.imageIndex === 1)) continue;
      daySlots.push(definition({ ...primary, slotBase: primary.slotId.replace(/:[^:]+$/, ''), fieldPath: `days.${dayIndex}.spots.${index}.images.1`, purpose: "以不同主体补充当天体验的行动或细节，不得与主图重复" }, 1, "detail", "16:9"));
    }
    slots.push(...daySlots.slice(0, target));
  });
  return slots.slice(0, 48);
}

export function getSlotImage(data, slot) {
  if (slot.module === "cover") return data.heroImage ? { src: data.heroImage, focus: data.heroFocus || "50% 50%" } : null;
  const collections = { hotel: data.hotels, dining: data.diningExperiences, transport: data.transportSummary };
  const item = slot.module === "day" ? dayBindingSpot(data, slot) : collections[slot.module]?.[slot.itemIndex];
  return imageArray(item)[slot.imageIndex] || null;
}

export function setSlotImage(data, slot, image) {
  if (slot.module === "cover") { data.heroImage = image?.src || ""; data.heroFocus = image?.focus || "50% 50%"; return; }
  const collections = { hotel: data.hotels, dining: data.diningExperiences, transport: data.transportSummary };
  const item = slot.module === "day" ? dayBindingSpot(data, slot) : collections[slot.module]?.[slot.itemIndex];
  if (!item) return;
  const images = imageArray(item).map((value) => typeof value === "string" ? { src: value } : value);
  if (data.simpleImageSlotBindings && slot.module === "day") {
    // Stable indices are part of the persisted binding, including empty optional slots.
    images[slot.imageIndex] = image?.src ? image : null;
    item.images = images;
  } else {
    if (image?.src) images[slot.imageIndex] = image; else images.splice(slot.imageIndex, 1);
    item.images = images.filter((value) => value?.src);
  }
  delete item.image; delete item.focus;
}

export function findSlotById(data, slotId) { return buildLayoutImageSlots(data).find((slot) => slot.slotId === slotId) || null; }

export function listImagePlacements(data) {
  return buildLayoutImageSlots(data).map((slot) => ({ slot, image: getSlotImage(data, slot) })).filter((item) => item.image?.src);
}

export function moveImageToSlot(data, targetSlotId, sourceSlotId, image, source = "user_selection") {
  const next = structuredClone(data);
  const target = findSlotById(next, targetSlotId);
  const origin = sourceSlotId ? findSlotById(next, sourceSlotId) : null;
  if (!target || !image?.src) return next;
  if (origin && origin.slotId !== target.slotId) setSlotImage(next, origin, null);
  setSlotImage(next, target, image);
  const lockedAt = Date.now();
  next.imageLocks = { ...(next.imageLocks || {}), [target.slotId]: { source, candidateId: image.candidateId, lockedAt } };
  if (origin && origin.slotId !== target.slotId) next.imageLocks[origin.slotId] = { source: "user_moved_out", lockedAt };
  return next;
}
