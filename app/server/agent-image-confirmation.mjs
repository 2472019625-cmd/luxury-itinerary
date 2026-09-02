import { moveImageToSlot } from "../src/lib/imageSlots.js";
import { recordImageDecision } from "../src/lib/imageDecisions.js";

const list = (value) => Array.isArray(value) ? value : [];

export function imageConfirmationChoices(data = {}, slotId) {
  const candidates = list(data.imageCandidates)
    .filter((item) => item.slotId === slotId && item.status === "manual_review" && item.adoptable === true && item.hardRejectCode === "none" && item.terminalAudit?.subjectMatch !== false && item.terminalAudit?.placeMatch !== false)
    .sort((left, right) => Number(right.terminalAudit?.relevance || right.baseScore || 0) - Number(left.terminalAudit?.relevance || left.baseScore || 0))
    .slice(0, 3);
  return [
    ...candidates.map((item, index) => ({
      choiceId: `use_image_candidate:${item.candidateId}`,
      label: `采用候选 ${index + 1}`,
      recommended: false,
      reason: item.reason || item.terminalAudit?.reason || "无明确硬伤，但需人工确认是否适合当前版位。",
      previewUrl: item.localPreviewUrl,
      sourcePage: item.sourcePage,
      candidateId: item.candidateId,
    })),
    { choiceId: `wait_for_image:${slotId}`, label: "暂不采用，继续等待", recommended: candidates.length > 0, reason: "保持项目和候选证据，不让必需位留空。" },
  ];
}

export function enrichPendingImageConfirmations(confirmations = [], data = {}) {
  return confirmations.map((confirmation) => {
    if (confirmation.category !== "图片" || confirmation.status !== "pending") return confirmation;
    const slotId = confirmation.imageSlotId || String(confirmation.choices?.find((item) => String(item.choiceId).startsWith("wait_for_image:"))?.choiceId || "").slice("wait_for_image:".length);
    if (!slotId) return confirmation;
    return { ...confirmation, imageSlotId: slotId, question: `必需图片位 ${slotId} 尚未自动通过，请看图确认候选或继续等待。`, choices: imageConfirmationChoices(data, slotId) };
  });
}

export function applyRuntimeImageConfirmations(imageResult = {}, confirmations = []) {
  let data = structuredClone(imageResult.data || {});
  let appliedCount = 0;
  for (const confirmation of confirmations) {
    const selected = String(confirmation.selectedChoiceId || "");
    if (confirmation.status !== "resolved" || !selected.startsWith("use_image_candidate:")) continue;
    const candidateId = selected.slice("use_image_candidate:".length);
    const slotId = confirmation.imageSlotId;
    const candidate = list(data.imageCandidates).find((item) => item.candidateId === candidateId && item.slotId === slotId);
    if (!candidate || candidate.status !== "manual_review" || candidate.adoptable !== true || !candidate.localPreviewUrl) throw new Error(`图片候选不可采用：${slotId}`);
    const image = { src: candidate.localPreviewUrl, focus: "50% 50%", sourcePage: candidate.sourcePage || "", candidateId };
    data = moveImageToSlot(data, slotId, null, image, "runtime_confirmation");
    recordImageDecision(data, { slotId, action: "accept_manual_candidate", source: "runtime_confirmation", candidateId });
    data.imageCandidates = list(data.imageCandidates).map((item) => item.slotId === slotId ? { ...item, selected: item.candidateId === candidateId, requiresDecision: false, humanDecision: item.candidateId === candidateId ? "accepted" : item.humanDecision } : item);
    data.imageReview = {
      ...(data.imageReview || {}),
      slots: list(data.imageReview?.slots).map((item) => item.slotId === slotId ? { ...item, status: "user_locked", stopReason: "user_confirmed_candidate", selectedCandidateIds: [candidateId] } : item),
    };
    appliedCount += 1;
  }
  const pendingCount = list(data.imageReview?.slots).filter((item) => item.status === "manual_review").length;
  if (data.imageReview) data.imageReview = { ...data.imageReview, pendingCount, stats: { ...(data.imageReview.stats || {}), manualReview: pendingCount, manualReviewSlots: pendingCount } };
  if (data.imageResearch) data.imageResearch = { ...data.imageResearch, pendingReviewCount: pendingCount, stats: { ...(data.imageResearch.stats || {}), manualReview: pendingCount, manualReviewSlots: pendingCount } };
  return { ...imageResult, data, appliedCount, pendingCount };
}
