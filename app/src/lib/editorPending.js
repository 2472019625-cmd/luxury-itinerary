export const HOTEL_FACT_FIELDS = Object.freeze([
  { key: "location", label: "位置" },
  { key: "rooms", label: "客房" },
  { key: "design", label: "设计" },
  { key: "facilities", label: "设施" },
]);

export function hotelFactPendingItems(hotels = []) {
  return hotels.flatMap((hotel, hotelIndex) => {
    const missingFields = HOTEL_FACT_FIELDS.filter(({ key }) => {
      const row = (hotel.factRows || []).find((item) => item?.key === key);
      return !String(row?.text || "").trim() && row?.status !== "confirmed_empty";
    });
    if (!missingFields.length) return [];
    return [{ kind: "hotel_fact", id: `hotel:${hotel.id || hotelIndex}`, required: false,
      targetPath: `hotels.${hotelIndex}.factRows`, hotelIndex, missingFields,
      label: hotel.shortName || hotel.officialName || `酒店 ${hotelIndex + 1}`,
      message: `缺少 ${missingFields.map((field) => field.label).join("、")}；可填写已核实的信息，或确认留空。` }];
  });
}

export function pendingCategory(item, imageReview = { slots: [] }) {
  if (item.kind === "hotel_fact") return "酒店信息";
  if (item.kind === "copy") return "文案";
  if (item.kind === "image") {
    const review = imageReview.slots?.find((slot) => slot.slotId === (item.slotId || item.id));
    return review?.selectableCandidateIds?.length > 0 ? "图片需确认" : "图片未找到";
  }
  if (item.kind === "renderer") return "成品生成";
  return "其他待处理";
}

export function groupPendingItems(items = [], imageReview = { slots: [] }) {
  const groups = new Map();
  for (const item of items) {
    const category = pendingCategory(item, imageReview);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }
  return [...groups].map(([label, entries]) => ({ label, entries }));
}

export function pendingItemsBlockDownload(items = []) {
  return items.some(item => item.blocking !== false);
}

export function daySpotIssueSelection(data, dayIndex, spotIndex) {
  const spot = data.days?.[dayIndex]?.spots?.[spotIndex];
  if (!spot) return null;
  const entry = Object.entries(data.simpleImageSlotBindings || {}).find(([, binding]) => {
    if (binding.module !== "day" || binding.useSpotCopy === false) return false;
    const match = binding.fieldPath?.match(/^days\.(\d+)\.spots\.(\d+)\.images\.(\d+)$/);
    if (!match || Number(match[1]) !== dayIndex) return false;
    return binding.spotId ? binding.spotId === spot.id : Number(match[2]) === spotIndex;
  });
  return { module: "days", itemIndex: dayIndex, subItemIndex: spotIndex, imageIndex: entry?.[1].imageIndex || 0,
    spotId: spot.id || null, slotId: entry?.[0] || null };
}
