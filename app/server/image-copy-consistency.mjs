import { buildLayoutImageSlots, getSlotImage, setSlotImage } from "../src/lib/imageSlots.js";

const PIPELINE_FIELDS = ["imageBlueprint", "imageReview", "imageFailures", "imageCandidates", "imageSourceLedger", "imageResearch"];

export function mergeParallelImageResult(finalCopyData, imageData, { factsPreserved = false } = {}) {
  const next = structuredClone(finalCopyData);
  const targetSlots = new Map(buildLayoutImageSlots(next).map((slot) => [slot.slotId, slot]));
  const sourceSlots = buildLayoutImageSlots(imageData);
  const invalidatedSlotIds = [];
  const mergedSlotIds = [];
  for (const sourceSlot of sourceSlots) {
    const image = getSlotImage(imageData, sourceSlot);
    if (!image?.src) continue;
    const target = targetSlots.get(sourceSlot.slotId);
    if (!target || !factsPreserved) {
      invalidatedSlotIds.push(sourceSlot.slotId);
      continue;
    }
    setSlotImage(next, target, image);
    mergedSlotIds.push(sourceSlot.slotId);
  }
  for (const field of PIPELINE_FIELDS) if (imageData?.[field] !== undefined) next[field] = structuredClone(imageData[field]);
  if (invalidatedSlotIds.length) {
    next.imageFailures = [
      ...(next.imageFailures || []).filter((item) => !invalidatedSlotIds.includes(item.slotId || item.slot)),
      ...invalidatedSlotIds.map((slotId) => ({ slotId, slot: slotId, stage: "copy_image_consistency", reason: "最终文案与并行搜索时的确定性上下文不一致，已取消自动采用", action: "manual_upload_required" })),
    ];
  }
  const report = {
    version: "1.0",
    checkedAt: new Date().toISOString(),
    factsPreserved,
    checkedSlots: sourceSlots.length,
    mergedSlotIds,
    invalidatedSlotIds,
    passed: factsPreserved && invalidatedSlotIds.length === 0,
  };
  next.copyImageConsistency = report;
  delete next.contentVisualMainline;
  return { data: next, report };
}
