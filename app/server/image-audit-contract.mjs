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

// Reconcile the model's descriptive evidence with its booleans at the shared
// adoption gate. Archive imagery is valid when the target actually presents
// history; it cannot illustrate a current transfer or live experience merely
// because the vehicle/activity category is similar.
export function visualSemanticConflict(slot = {}, audit = {}, candidate = {}) {
  const core = slot.minimumVisualProof || slot.core || slot.queryCore || {};
  const target = [core.subject || slot.subject || slot.primaryVisualSubject, core.action].filter(Boolean).join(" ");
  const historicalTarget = /历史(?:展示|照片|档案|回顾|博物馆)|档案(?:展示|图片|照片)|博物馆|展览|旧照|老照片|historical\s+(?:display|exhibit|photo|image)|history\s+(?:display|exhibit|museum)|archive\s+(?:display|photo|image)|museum|exhibit/i.test(target);
  if (historicalTarget) return null;
  // All current itinerary subjects, including meals, need this check. An
  // activity allow-list missed breakfast and lets unrelated context exempt it.
  if (!target) return null;
  const described = `${audit.actualSubject || ""} ${audit.reason || ""}`;
  const imageBoundText = [candidate.knowledgeMatchedFile?.filename, candidate.knowledgePreview?.filename, candidate.imageTitle, candidate.alt, candidate.caption, candidate.structuredImageText].filter(Boolean).join(" ");
  const archiveEvidence = /历史(?:照|照片|影像|图片|幻灯片|档案)|档案(?:照|照片|影像|图片)|老照片|旧照|(?:照片|影像|胶片|幻灯片|photo|image|slide|film).{0,16}(?:18|19)\d{2}(?:年|年代|s\b)|(?:18|19)\d{2}(?:年|年代|s\b).{0,16}(?:照片|影像|胶片|幻灯片|photo|image|slide|film)|archiv(?:e|al)\s+(?:photo|image|film|slide)|historical\s+(?:photo|image|slide|film)|vintage\s+(?:photo|slide|film)|slide\s+(?:film|photo)/i;
  const affirmativeDescription = described.replace(/(?:不是|并非|非|not\s+(?:an?\s+)?|isn't\s+(?:an?\s+)?)(?:历史照片|历史影像|档案照片|老照片|旧照|historical\s+(?:photo|image|slide)|archive\s+(?:photo|image))/gi, "");
  if (archiveEvidence.test(affirmativeDescription)) return "wrong_activity";
  // An explicit date for the depicted event differs from an old building's
  // construction year or a classic vehicle's model year in a modern photo.
  const datedScene = /^(?:(?:拍摄于|摄于|taken in|photographed in)\s*)?(?:18|19)\d{2}(?:年代|年|s\b)(?!\s*(?:代|车型|款|式|建于|建成|修建|生产|制造|model\b))/i;
  if (datedScene.test(String(audit.actualSubject || "").trim())) return "wrong_activity";
  if (archiveEvidence.test(imageBoundText) || /(?:late|early|mid)[-_ ]?(?:18|19)\d{2}\b/i.test(imageBoundText)) return "needs_user_judgment";
  return null;
}
