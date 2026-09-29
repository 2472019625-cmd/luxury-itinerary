import { buildKnowledgeQueryPlan } from "./knowledge-scope-resolver.mjs";
import { resolveScenePreference } from "./image-scene-preferences.mjs";
import { buildAgentFactBasis, repairTransportOverviewPose, repairHotelRepresentativeChoice } from "./agent-trip-planner.mjs";

const REPAIRABLE_QUERY_ISSUES = new Set([
  "invalid_image_search_queries", "image_fidelity_query_missing",
  "image_alternate_queries_invalid", "scope_only_location_in_query",
]);
const clean = value => typeof value === "string" ? value.trim() : "";

// Only editor-initiated searches call this. The immutable automatic plan and
// all candidate identity, fact, technical and deduplication checks stay intact.
export function prepareExplicitImageSearchSlot(slot, { plan } = {}) {
  const target = { ...slot, userLocked: false };
  const issues = Array.isArray(slot.plannerValidationIssues) ? slot.plannerValidationIssues : [];
  if (!(slot.plannerSlotStatus === "unresolved" || slot.needsUserAction === true)) return target;
  const duplicate = issues.some(issue => issue.code === "duplicate_visual_responsibility");
  const ambiguous = issues.some(issue => issue.code === "ambiguous_visual_subject");
  let preference = ambiguous ? resolveScenePreference(slot) : null;
  if (ambiguous && !preference && slot.moduleType === "transport") {
    // Use the saved binding and confirmed input, never a role guessed from the
    // slot label or generated copy. Filtering in buildAgentFactBasis may change
    // array positions, so recover the original source index explicitly.
    const binding = plan?.slotBindings?.[slot.slotId];
    if (binding?.module === "transport" && Number.isInteger(binding.itemIndex) && binding.itemIndex >= 0
      && slot.sourceEvidence?.includes(`transport.${binding.itemIndex}`)) {
      const facts = buildAgentFactBasis(plan.preparedData);
      const transport = facts.transport.find(item => item.sourceIndex === binding.itemIndex);
      const repair = transport && repairTransportOverviewPose({ ...slot, role: "transport:1" },
        { ...facts, transport: [transport] }, { allowCoreActionChoices: true });
      if (repair) preference = { reason: "transport_overview_pose", primaryVisualSubject: repair.primaryVisualSubject,
        queryCore: repair.queryCore, posePreference: { action: slot.queryCore.action, actionEn: slot.queryCore.actionEn },
        sourceRef: `transport.${binding.itemIndex}` };
    }
  }
  if (ambiguous && !preference && slot.moduleType === "hotel") {
    const binding = plan?.slotBindings?.[slot.slotId];
    if (binding?.module === "hotel" && Number.isInteger(binding.itemIndex) && binding.itemIndex >= 0
      && slot.sourceEvidence?.includes(`hotels.${binding.itemIndex}`)) {
      const facts = buildAgentFactBasis(plan.preparedData);
      const hotel = facts.hotels.find(item => item.sourceIndex === binding.itemIndex);
      const repair = hotel && repairHotelRepresentativeChoice({ ...slot, role: "hotel:1" }, { ...facts, hotels: [hotel] });
      if (repair) preference = { reason: "hotel_representative_choice", primaryVisualSubject: repair.primaryVisualSubject,
        queryCore: repair.queryCore };
    }
  }
  if ((!duplicate && !preference) || (ambiguous && !preference)
    || issues.some(issue => issue.code !== "duplicate_visual_responsibility"
      && !(issue.code === "ambiguous_visual_subject" && preference)
      && !REPAIRABLE_QUERY_ISSUES.has(issue.code))) return target;
  if (!clean(slot.queryCore?.subject) || !clean(slot.location)
    || !["scope_only", "visual_identity"].includes(slot.locationRole)
    || typeof slot.exactIdentityRequired !== "boolean"
    || slot.exactIdentityRequired && !clean(slot.queryCore?.identity)) return target;
  // Rebuild from the established Core; a fact-backed transport overview can
  // demote ordinary poses to preferences, but never an experience action.
  const queryCore = preference?.queryCore || slot.queryCore;
  const queryPlan = buildKnowledgeQueryPlan(preference
    ? { ...slot, queryCore, fidelityQuery: "", alternateQueries: [], searchIntent: [] } : slot, null);
  if (queryPlan.validationError || queryPlan.queries.length < 2) return target;
  return {
    ...target,
    queryCore,
    fidelityQuery: queryPlan.queries[0], alternateQueries: queryPlan.queries.slice(1), searchIntent: queryPlan.queries,
    ...(preference ? { primaryVisualSubject: preference.primaryVisualSubject,
      subject: preference.primaryVisualSubject, activity: preference.primaryVisualSubject,
      visualContext: { ...slot.visualContext, primaryVisualSubject: preference.primaryVisualSubject } } : {}),
    plannerSlotStatus: "user_requested", needsUserAction: false,
    manualSearchOverride: {
      reason: preference?.reason || "duplicate_visual_responsibility",
      originalPlannerStatus: slot.plannerSlotStatus, originalIssueCodes: issues.map(issue => issue.code),
      ...(preference ? { originalPrimaryVisualSubject: slot.primaryVisualSubject,
        ...(preference.posePreference ? { originalQueryCore: slot.queryCore, posePreference: preference.posePreference, sourceRef: preference.sourceRef } : {}),
        ...(preference.backgroundPreference ? { backgroundPreference: preference.backgroundPreference } : {}),
        ...(preference.supportingPreference ? { supportingPreference: preference.supportingPreference } : {}) } : {}),
    },
  };
}
