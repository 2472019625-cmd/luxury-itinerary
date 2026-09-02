import { findSlotById, setSlotImage } from './imageSlots.js';

export const IMAGE_REVIEW_STATE = Object.freeze({
  AUTO_APPROVED: "auto_approved",
  MANUAL_REVIEW: "manual_review",
  HARD_REJECTED: "hard_rejected",
});

export const IMAGE_MODULE_POLICY = Object.freeze({
  cover: { relevance: 80, luxury: 72, cleanliness: 75, composition: 70 },
  hotel: { relevance: 78, luxury: 70, cleanliness: 75, composition: 66 },
  dining: { relevance: 82, luxury: 68, cleanliness: 78, composition: 65 },
  transport: { relevance: 82, luxury: 58, cleanliness: 72, composition: 62 },
  day: { relevance: 82, luxury: 58, cleanliness: 70, composition: 62 },
});

const HARD_CODES = new Set(["watermark", "subject_mismatch", "place_mismatch", "broken", "low_resolution", "low_quality", "duplicate", "forbid"]);

export function classifyImageCandidate({ slot = {}, candidate = {}, audit = {}, duplicate = false, technicalFailure = "" }) {
  const modulePolicy = IMAGE_MODULE_POLICY[slot.module] || IMAGE_MODULE_POLICY.day;
  const code = duplicate ? "duplicate" : technicalFailure ? "broken" : String(audit.hardRejectCode || "none");
  const officialHotelIdentity = slot.module === "hotel" && candidate.officialHint && audit.subjectMatch !== false;
  const hardPlaceMismatch = audit.placeMatch === false && !officialHotelIdentity;
  const hardSubjectMismatch = audit.subjectMatch === false;
  const hard = duplicate || technicalFailure || audit.watermark === true || ["broken", "low_resolution", "low_quality", "forbid"].includes(code) || hardPlaceMismatch || hardSubjectMismatch;
  if (hard) return { state: IMAGE_REVIEW_STATE.HARD_REJECTED, adoptable: false, reason: technicalFailure || audit.reason || `命中硬拒绝：${code}`, hardRejectCode: HARD_CODES.has(code) ? code : "forbid" };

  const placeSupported = audit.placeMatch === true || officialHotelIdentity || audit.sourceSupportsIdentity === true;
  const auto = audit.pass === true && audit.subjectMatch === true && placeSupported && audit.watermark === false
    && Number(audit.relevance || 0) >= modulePolicy.relevance
    && Number(audit.luxury || 0) >= modulePolicy.luxury
    && Number(audit.cleanliness || 0) >= modulePolicy.cleanliness
    && Number(audit.composition || 0) >= modulePolicy.composition;
  if (auto) return { state: IMAGE_REVIEW_STATE.AUTO_APPROVED, adoptable: true, reason: audit.reason || "满足模块自动通过标准", hardRejectCode: "none" };
  return { state: IMAGE_REVIEW_STATE.MANUAL_REVIEW, adoptable: true, reason: audit.reason || "没有明确硬伤，但未达到自动通过标准", hardRejectCode: "none" };
}

export function applyImageToSlot(data, slotId, images) {
  const next = structuredClone(data);
  const normalized = images.map((image) => typeof image === "string" ? { src: image, focus: "50% 50%" } : { focus: "50% 50%", ...image });
  const stableSlot = findSlotById(next, slotId);
  if (stableSlot) { setSlotImage(next, stableSlot, normalized[0] || null); return next; }
  if (slotId === "cover") { next.heroImage = normalized[0]?.src || ""; next.heroFocus = normalized[0]?.focus || "50% 50%"; return next; }
  const parts = String(slotId).split(":");
  if (parts[0] === "hotels") {
    const index = (next.hotels || []).findIndex((item, i) => String(item.id || i) === parts[1]);
    if (index >= 0) next.hotels[index].images = normalized;
  } else if (parts[0] === "dining" || parts[0] === "transport") {
    const collection = parts[0] === "dining" ? next.diningExperiences : next.transportSummary;
    const index = (collection || []).findIndex((item, i) => String(item.id || i) === parts[1]);
    if (index >= 0) { delete collection[index].image; collection[index].images = normalized; }
  } else if (parts[0] === "days") {
    const day = next.days?.[Number(parts[1])];
    const spot = day?.spots?.[Number(parts[3])];
    if (spot) { delete spot.image; spot.images = normalized; }
  }
  return next;
}

export function pendingImageReviewSlots(review) {
  return (review?.slots || []).filter((slot) => slot.status === "manual_review" || slot.status === "processing");
}
