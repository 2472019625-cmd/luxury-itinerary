import { findSlotById, setSlotImage } from './imageSlots.js';
import { isNonPhotographicMedia } from './imageMedia.js';

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

export function canManuallyChooseImageCandidate(candidate = {}) {
  if (isNonPhotographicMedia(candidate.hardJudgment)) return false;
  const hasPreview = Boolean(candidate.userProvided || candidate.localPreviewUrl || candidate.previewUrl || candidate.localUrl || candidate.publicUrl);
  const hardRejected = candidate.status === IMAGE_REVIEW_STATE.HARD_REJECTED
    || candidate.autoRejected === true
    || candidate.qualificationStatus === "rejected";
  return hasPreview && (!hardRejected || canConfirmModelApprovedProgramRejection(candidate));
}

// Only the two observed contradictions may be resolved by an explicit human
// decision. This does not change automatic qualification or trust UI flags.
export function canConfirmModelApprovedProgramRejection(candidate = {}) {
  const audit = candidate.hardJudgment || {};
  if (isNonPhotographicMedia(audit)) return false;
  if (candidate.modelDecision?.eligible !== true || audit.auditEvidenceVersion !== 2
    || audit.auditContract?.complete !== true
    || audit.visibleIdentityConflict !== false || audit.visibleLocationConflict !== false
    || !['coreSubjectMatch', 'subjectMatch', 'coreActionMatch', 'activityMatch', 'subjectClear',
      'identityMatch', 'hotelIdentityMatch', 'transportTypeMatch', 'watermarkFree', 'nonAI', 'photographic', 'technicalUsable']
      .every(field => audit[field] === true)) return false;
  const codes = [candidate.rejection, audit.hardRejectCode].filter(code => code && code !== 'none');
  if (!codes.length || !codes.every(code => ['wrong_location', 'non_photographic'].includes(code))) return false;
  const identity = audit.identityEvidence?.status;
  if (!['supported', 'not_required'].includes(identity)) return false;
  if (identity === 'supported' && audit.locationMatch !== true) return false;
  return !codes.includes('wrong_location') || audit.locationMatch === true || identity === 'not_required';
}

export function canRecommendImageCandidateForSlot(candidate = {}, targetSlot = {}) {
  if (!canManuallyChooseImageCandidate(candidate)) return false;
  return imageCandidateMatchesSlot(candidate, targetSlot);
}

function imageCandidateMatchesSlot(candidate, targetSlot) {
  const sameTarget = candidate.targetFingerprint && targetSlot.targetFingerprint && candidate.targetFingerprint === targetSlot.targetFingerprint;
  if (candidate.fieldPath) return candidate.fieldPath === targetSlot.fieldPath || Boolean(sameTarget);
  const candidateSlotId = candidate.pipelineSlotId || candidate.slotId;
  const targetSlotId = targetSlot.pipelineSlotId || targetSlot.slotId;
  if (candidateSlotId && targetSlotId && candidateSlotId === targetSlotId) return true;
  return Boolean(sameTarget);
}

export function modelApprovedImageNotice(candidate = {}) {
  // Missing historical evidence is unknown. Never infer model approval from
  // free-form reasons, scores, source credibility or an incomplete review.
  const approved = candidate.modelDecision
    ? candidate.modelDecision.eligible === true
    : candidate.hardJudgment?.eligible === true;
  const hardRejected = candidate.status === IMAGE_REVIEW_STATE.HARD_REJECTED
    || candidate.autoRejected === true || candidate.qualificationStatus === 'rejected';
  if (!approved || !hardRejected && candidate.qualificationStatus !== 'unreviewed') return null;
  const code = candidate.rejection || candidate.hardJudgment?.hardRejectCode;
  const reasons = {
    wrong_hotel: '酒店身份不符合当前位置要求', wrong_location: '地点不符合当前位置要求',
    wrong_subject: '核心主体不符合要求', wrong_activity: '必要动作不符合要求',
    wrong_transport_type: '交通类别不符合要求', knowledge_source_path_mismatch: '知识库来源路径不符合检索范围',
    watermark: '图片含水印', ai_generated: '图片真实性检查未通过', non_photographic: '图片不是实景摄影',
    broken: '图片无法正常读取', low_quality_unusable: '图片技术可用性检查未通过',
    subject_not_clear: '核心主体无法可靠识别', forbid: '图片命中禁止使用条件',
    duplicate: '图片与已用素材重复', duplicate_sha256: '图片与已用素材重复', duplicate_perceptual: '图片与已用素材近似重复',
  };
  const reason = reasons[code] || (candidate.hardJudgment?.auditContract?.complete === false
    ? '审核信息不完整或存在矛盾，尚未通过采用检查'
    : candidate.hardJudgment?.identityEvidence?.status === 'insufficient'
      ? '必要实体身份缺少可核对的依据'
      : candidate.originalDownloadStatus === 'failed'
        ? '原图获取或尺寸检查未通过'
        : candidate.reason || candidate.matchReason || '尚未通过采用检查');
  return { label: hardRejected ? '模型认可 · 采用检查未通过' : '模型认可 · 待人工确认', reason };
}

export function canDisplayImageCandidate(candidate = {}) {
  return canManuallyChooseImageCandidate(candidate)
    || Boolean(candidate.localPreviewUrl && modelApprovedImageNotice(candidate));
}

export function canDisplayImageCandidateForSlot(candidate = {}, targetSlot = {}) {
  return canDisplayImageCandidate(candidate) && imageCandidateMatchesSlot(candidate, targetSlot);
}

const HARD_CODES = new Set(["watermark", "subject_mismatch", "place_mismatch", "broken", "low_resolution", "low_quality", "duplicate", "forbid"]);

export function auditReasonHasIdentityMismatch(reason = "") {
  return /来源品牌.{0,40}(?:与|并非).{0,40}(?:不一致|不同|需人工确认)|(?:不支持|无法支持).{0,24}(?:目标)?(?:酒店|品牌)身份|无法确认.{0,32}(?:目标品牌|目标酒店)|并非.{0,24}(?:目标品牌|目标酒店)/.test(String(reason));
}

export function classifyImageCandidate({ slot = {}, candidate = {}, audit = {}, duplicate = false, technicalFailure = "" }) {
  const modulePolicy = IMAGE_MODULE_POLICY[slot.module] || IMAGE_MODULE_POLICY.day;
  const code = duplicate ? "duplicate" : technicalFailure ? "broken" : String(audit.hardRejectCode || "none");
  const officialHotelIdentity = slot.module === "hotel" && candidate.officialHint && audit.subjectMatch !== false;
  const hardPlaceMismatch = audit.placeMatch === false && !officialHotelIdentity;
  const hardSubjectMismatch = audit.subjectMatch === false;
  const clearlyIrrelevant = Number.isFinite(Number(audit.relevance)) && Number(audit.relevance) < 50;
  const identityMismatch = auditReasonHasIdentityMismatch(audit.reason);
  const hard = duplicate || technicalFailure || audit.watermark === true || ["broken", "low_resolution", "low_quality", "forbid"].includes(code) || hardPlaceMismatch || hardSubjectMismatch || clearlyIrrelevant || identityMismatch;
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
