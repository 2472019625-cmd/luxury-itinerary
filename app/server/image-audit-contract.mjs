// Shared by the model response boundary and the automatic adoption gate.
export const IMAGE_AUDIT_BOOLEAN_FIELDS = Object.freeze([
  "locationMatch", "visibleLocationConflict", "hotelIdentityMatch", "visibleIdentityConflict",
  "activityMatch", "coreActionMatch", "subjectMatch", "coreSubjectMatch", "identityMatch",
  "subjectClear", "subjectLargeEnough", "subjectPrimary", "transportTypeMatch",
  "watermarkFree", "nonAI", "photographic", "technicalUsable", "eligible",
]);
export const IMAGE_AUDIT_SCORE_FIELDS = Object.freeze(["score", "relevance", "luxury", "cleanliness", "composition"]);

export function missingVisualJudgmentFields(audit = {}) {
  return [
    ...["candidateId", "actualSubject"].filter(field => typeof audit?.[field] !== "string" || !audit[field].trim()),
    ...IMAGE_AUDIT_BOOLEAN_FIELDS.filter(field => typeof audit?.[field] !== "boolean"),
    ...IMAGE_AUDIT_SCORE_FIELDS.filter(field => !Number.isFinite(audit?.[field])),
    ...(!["exact", "exact_match", "representative", "mismatch"].includes(audit?.matchLevel) ? ["matchLevel"] : []),
    ...(typeof audit?.hardRejectCode !== "string" ? ["hardRejectCode"] : []),
  ];
}

export function completeVisualJudgment(audit) {
  return Boolean(audit && audit.auditContract?.complete !== false && missingVisualJudgmentFields(audit).length === 0);
}
