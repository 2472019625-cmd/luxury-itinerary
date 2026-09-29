import { buildKnowledgeQueryPlan } from "./knowledge-scope-resolver.mjs";
import { visualSubjectPolicyIssue } from "./visual-subject-policy.mjs";

const REPAIRABLE_QUERY_ISSUES = new Set([
  "invalid_image_search_queries", "image_fidelity_query_missing",
  "image_alternate_queries_invalid", "scope_only_location_in_query",
]);
const choice = /或者|或|二选一|\bor\b|\//i;
const clean = value => typeof value === "string" ? value.trim() : "";
const compact = value => clean(value).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const words = value => [...segmenter.segment(clean(value).normalize("NFKC").toLowerCase())]
  .filter(part => part.isWordLike).map(part => part.segment);

function containsCoreWords(value, corePart) {
  const expected = words(corePart), actual = words(value);
  let cursor = -1;
  return expected.length > 0 && expected.every(word => {
    cursor = actual.indexOf(word, cursor + 1);
    return cursor >= 0;
  });
}

// Manual requests can reconstruct queries from the already chosen Core. A
// location phrase may interrupt the Chinese action, so check the complete Core
// again AFTER removing that phrase. Never pick an alternative subject/action.
function explicitScenePreference(slot) {
  const core = slot.queryCore || {};
  const values = [core.subject, core.action, core.identity, core.subjectEn, core.actionEn, core.identityEn].map(clean);
  if (slot.exactIdentityRequired !== false || slot.locationRole !== "scope_only"
    || !values[0] || values.some(value => choice.test(value))) return null;
  const visual = clean(slot.primaryVisualSubject);
  const languages = [{ subject: values[0], action: values[1] },
    ...(values[3] && (!values[1] || values[4]) ? [{ subject: values[3], action: values[4] }] : [])];
  const preservesCore = remaining => !choice.test(remaining) && !visualSubjectPolicyIssue(remaining, core)
    && languages.some(({ subject, action }) => containsCoreWords(remaining, subject)
      && (!action || compact(remaining).includes(compact(action)) || containsCoreWords(remaining, action)));
  const validAlternatives = text => {
    const alternatives = text.split(choice).map(clean);
    return alternatives.length >= 2 && alternatives.length <= 3
      && alternatives.every(part => part && part.length <= 30 && !/[，,；;。!?！？]/.test(part));
  };
  for (const marker of [...visual.matchAll(/背景(?:为|是|可为)|位于|在|\b(?:against|in|on|at)\s+/gi)].reverse()) {
    const start = marker.index, bodyStart = start + marker[0].length;
    const tail = visual.slice(bodyStart);
    const ends = [...new Set([
      visual.length,
      ...[...tail.matchAll(/[，,；;。]/g)].map(match => bodyStart + match.index),
      ...[...tail.matchAll(/[上中内旁边里外下]/g)].map(match => bodyStart + match.index + 1),
    ])].sort((a, b) => a - b);
    for (const end of ends) {
      const background = visual.slice(bodyStart, end).trim();
      if (!validAlternatives(background)) continue;
      const remaining = `${visual.slice(0, start)}${visual.slice(end)}`.trim();
      if (!preservesCore(remaining)) continue;
      return { reason: "non_core_background_choice", backgroundPreference: background,
        primaryVisualSubject: [values[0], values[1]].filter(Boolean).join(" ") };
    }
  }
  // A separate supporting clause can offer choices (e.g. passengers boarding
  // or disembarking) while the complete plane/runway Core precedes it. Remove
  // the whole preference, never select a branch or remove part of the Core.
  // A leading "or" is a whole-scene alternative and deliberately fails.
  for (const marker of visual.matchAll(/[，,]/g)) {
    const remaining = visual.slice(0, marker.index).trim();
    const detail = visual.slice(marker.index + 1).trim();
    if (!preservesCore(remaining) || !validAlternatives(detail) || visualSubjectPolicyIssue(detail, core)) continue;
    const coreSubjectInDetail = [values[0], values[3]].filter(Boolean).some(subject => containsCoreWords(detail, subject));
    if (coreSubjectInDetail) continue;
    return { reason: "non_core_supporting_choice", supportingPreference: detail,
      primaryVisualSubject: [values[0], values[1]].filter(Boolean).join(" ") };
  }
  return null;
}

// Only editor-initiated searches call this. The immutable automatic plan and
// all candidate identity, fact, technical and deduplication checks stay intact.
export function prepareExplicitImageSearchSlot(slot) {
  const target = { ...slot, userLocked: false };
  const issues = Array.isArray(slot.plannerValidationIssues) ? slot.plannerValidationIssues : [];
  if (!(slot.plannerSlotStatus === "unresolved" || slot.needsUserAction === true)) return target;
  const duplicate = issues.some(issue => issue.code === "duplicate_visual_responsibility");
  const ambiguous = issues.some(issue => issue.code === "ambiguous_visual_subject");
  const preference = ambiguous ? explicitScenePreference(slot) : null;
  if ((!duplicate && !preference) || (ambiguous && !preference)
    || issues.some(issue => issue.code !== "duplicate_visual_responsibility"
      && !(issue.code === "ambiguous_visual_subject" && preference)
      && !REPAIRABLE_QUERY_ISSUES.has(issue.code))) return target;
  if (!clean(slot.queryCore?.subject) || !clean(slot.location)
    || !["scope_only", "visual_identity"].includes(slot.locationRole)
    || typeof slot.exactIdentityRequired !== "boolean"
    || slot.exactIdentityRequired && !clean(slot.queryCore?.identity)) return target;
  // For a soft choice, regenerate both languages from the unchanged Core
  // rather than reusing a query that may omit the necessary action.
  const queryPlan = buildKnowledgeQueryPlan(preference
    ? { ...slot, fidelityQuery: "", alternateQueries: [], searchIntent: [] } : slot, null);
  if (queryPlan.validationError || queryPlan.queries.length < 2) return target;
  return {
    ...target,
    fidelityQuery: queryPlan.queries[0], alternateQueries: queryPlan.queries.slice(1), searchIntent: queryPlan.queries,
    ...(preference ? { primaryVisualSubject: preference.primaryVisualSubject,
      subject: preference.primaryVisualSubject, activity: preference.primaryVisualSubject,
      visualContext: { ...slot.visualContext, primaryVisualSubject: preference.primaryVisualSubject } } : {}),
    plannerSlotStatus: "user_requested", needsUserAction: false,
    manualSearchOverride: {
      reason: preference?.reason || "duplicate_visual_responsibility",
      originalPlannerStatus: slot.plannerSlotStatus, originalIssueCodes: issues.map(issue => issue.code),
      ...(preference ? { originalPrimaryVisualSubject: slot.primaryVisualSubject,
        ...(preference.backgroundPreference ? { backgroundPreference: preference.backgroundPreference } : {}),
        ...(preference.supportingPreference ? { supportingPreference: preference.supportingPreference } : {}) } : {}),
    },
  };
}
