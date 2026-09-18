export const HARD_REJECTION_CODES = new Set([
  "wrong_hotel",
  "wrong_location",
  "wrong_activity",
  "wrong_transport_type",
  "wrong_subject",
  "subject_not_clear",
  "watermark",
  "ai_generated",
  "low_quality_unusable",
  "non_photographic",
  "broken",
  "forbid",
  "knowledge_source_path_mismatch",
]);

const LEGACY_HARD_REJECTION_CODE_MAP = Object.freeze({
  hotel_identity_mismatch: "wrong_hotel",
  place_mismatch: "wrong_location",
  activity_mismatch: "wrong_activity",
  key_action_missing: "wrong_activity",
  subject_mismatch: "wrong_subject",
  technical_unusable: "low_quality_unusable",
  low_resolution: "low_quality_unusable",
  low_quality: "low_quality_unusable",
});

export function normalizeHardRejectCode(code) {
  const value = String(code || "none").trim().toLowerCase();
  return LEGACY_HARD_REJECTION_CODE_MAP[value] || value;
}

export function isHardRejectionCode(code) {
  return HARD_REJECTION_CODES.has(normalizeHardRejectCode(code));
}

export function candidateQualification(candidate = {}) {
  if (candidate.qualificationStatus === "rejected") return "rejected";
  if (candidate.qualificationStatus === "eligible") return "eligible";
  if (candidate.autoRejected === true) return "rejected";
  if (isHardRejectionCode(candidate.rejection || candidate.hardJudgment?.hardRejectCode)) return "rejected";
  if (candidate.hardJudgment?.eligible === true || candidate.eligible === true) return "eligible";
  return "unreviewed";
}

export function isHardRejectedCandidate(candidate = {}) {
  return candidateQualification(candidate) === "rejected";
}
