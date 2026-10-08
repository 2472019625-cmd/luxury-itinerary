import { buildKnowledgeQueryPlan, validatePlannerSearchIntent } from "./knowledge-scope-resolver.mjs";
import { repairFactBoundWildlifeChoice, repairFactBoundDepartureVisual, repairSafariAnimalChoice, repairCommonVisualSubject, repairStarBedFacilityVisual } from "./image-fact-bound-recovery.mjs";
import { buildAgentFactBasis, repairSimpleVisualChoice, repairBusinessTransferBackground, repairBusinessTransferOverview, repairTransportOverviewPose, repairHotelRepresentativeChoice, repairFactBoundAnimalChoice, repairKnownImageSearchTarget } from "./agent-trip-planner.mjs";

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
  const binding = plan?.slotBindings?.[slot.slotId];
  if (!slot.userLocked && binding && issues.some(issue => issue.code === 'ambiguous_visual_subject')
    && issues.every(issue => issue.code === 'ambiguous_visual_subject' || REPAIRABLE_QUERY_ISSUES.has(issue.code))) {
    const facts = buildAgentFactBasis(plan.preparedData);
    const key = { hotel: 'hotels', dining: 'diningExperiences', transport: 'transport' }[binding.module];
    const index = key && facts[key]?.findIndex((item, position) => (item.sourceIndex ?? position) === binding.itemIndex);
    const role = binding.module === 'cover' ? 'cover' : binding.module === 'day' && Number.isInteger(binding.dayIndex) && binding.dayIndex >= 0
      ? `day:${binding.dayIndex + 1}` : key && index >= 0 ? `${binding.module}:${index + 1}` : '';
    const repair = role && binding.module === slot.moduleType && repairSimpleVisualChoice({ ...slot, role, sourceRefs: slot.sourceEvidence }, facts);
    if (repair) {
      const { repair: evidence, ...fields } = repair;
      const originalQueries = [slot.fidelityQuery, ...(slot.alternateQueries || [])];
      const keepQueries = issues.every(issue => issue.code === 'ambiguous_visual_subject')
        && JSON.stringify(fields.queryCore || slot.queryCore) === JSON.stringify(slot.queryCore)
        && validatePlannerSearchIntent(originalQueries).valid;
      const queryPlan = keepQueries ? { queries: originalQueries } : buildKnowledgeQueryPlan({ ...slot, ...fields }, null);
      if (!queryPlan.validationError && queryPlan.queries.length >= 2) return {
        ...target, ...fields, subject: fields.primaryVisualSubject, activity: fields.primaryVisualSubject,
        fidelityQuery: queryPlan.queries[0], alternateQueries: queryPlan.queries.slice(1), searchIntent: queryPlan.queries,
        visualContext: { ...slot.visualContext, primaryVisualSubject: fields.primaryVisualSubject },
        plannerSlotStatus: 'user_requested', needsUserAction: false,
        plannerLocalRepairs: [...(slot.plannerLocalRepairs || []), evidence],
        manualSearchOverride: { reason: evidence.code, originalPlannerStatus: slot.plannerSlotStatus,
          originalIssueCodes: issues.map(issue => issue.code), recoveryRepair: evidence },
      };
    }
  }
  if (slot.moduleType === 'day' && !slot.userLocked && binding?.module === 'day'
    && Number.isInteger(binding.dayIndex) && binding.dayIndex >= 0
    && issues.every(issue => REPAIRABLE_QUERY_ISSUES.has(issue.code) || issue.code === 'duplicate_visual_responsibility')) {
    const repair = repairStarBedFacilityVisual({ ...slot, role: `day:${binding.dayIndex + 1}`, sourceRefs: slot.sourceEvidence }, buildAgentFactBasis(plan.preparedData));
    if (repair) {
      const { repair: evidence, ...fields } = repair;
      return { ...target, ...fields, subject: fields.primaryVisualSubject, activity: fields.primaryVisualSubject,
        visualContext: { ...slot.visualContext, primaryVisualSubject: fields.primaryVisualSubject },
        plannerSlotStatus: 'user_requested', needsUserAction: false,
        plannerLocalRepairs: [...(slot.plannerLocalRepairs || []), evidence],
        manualSearchOverride: { reason: 'star_bed_facility_visual', originalPlannerStatus: slot.plannerSlotStatus,
          originalIssueCodes: issues.map(issue => issue.code), recoveryRepair: evidence } };
    }
  }
  if (slot.moduleType === "transport" && binding?.module === "transport" && Number.isInteger(binding.itemIndex) && binding.itemIndex >= 0
    && slot.sourceEvidence?.includes(`transport.${binding.itemIndex}`)
    && issues.every(issue => REPAIRABLE_QUERY_ISSUES.has(issue.code) || issue.code === "duplicate_visual_responsibility")) {
    const facts = buildAgentFactBasis(plan.preparedData);
    const transport = facts.transport.find(item => item.sourceIndex === binding.itemIndex);
    const repair = transport && repairBusinessTransferOverview({ ...slot, role: "transport:1", sourceRefs: slot.sourceEvidence }, { ...facts, transport: [transport] });
    if (repair) {
      const { repair: evidence, ...fields } = repair;
      return { ...target, ...fields, subject: fields.primaryVisualSubject, activity: fields.primaryVisualSubject,
        visualContext: { ...slot.visualContext, primaryVisualSubject: fields.primaryVisualSubject },
        plannerSlotStatus: "user_requested", needsUserAction: false,
        plannerLocalRepairs: [...(slot.plannerLocalRepairs || []), evidence],
        manualSearchOverride: { reason: "business_transfer_overview", originalPlannerStatus: slot.plannerSlotStatus,
          originalIssueCodes: issues.map(issue => issue.code), vocabularyRepair: evidence } };
    }
  }
  if (!(slot.plannerSlotStatus === "unresolved" || slot.needsUserAction === true)) return target;
  const duplicate = issues.some(issue => issue.code === "duplicate_visual_responsibility");
  // An event label is a valid discovery query on explicit user request.
  // Preserve its meaning and all candidate checks; do not invent a vehicle,
  // venue or action merely to satisfy automatic composition planning.
  const descriptive = issues.some(issue => issue.code === "abstract_visual_subject");
  const queryOnly = issues.length > 0 && issues.every(issue => REPAIRABLE_QUERY_ISSUES.has(issue.code));
  const ambiguous = issues.some(issue => issue.code === "ambiguous_visual_subject");
  // General non-Core preferences were handled above through the shared,
  // source-bound contract. Do not reinterpret them through an unbound fallback.
  let preference = null;
  if (ambiguous && !preference && slot.moduleType === "day") {
    const binding = plan?.slotBindings?.[slot.slotId];
    if (binding?.module === 'day' && Number.isInteger(binding.dayIndex) && binding.dayIndex >= 0
      && slot.sourceEvidence?.some(ref => ref === `days.${binding.dayIndex}` || ref.startsWith(`days.${binding.dayIndex}.`))) {
      const facts = buildAgentFactBasis(plan.preparedData);
      const priorAnimalRepair = slot.plannerLocalRepairs?.find(item => ['fact_bound_animal_choice_resolved', 'fact_bound_wildlife_choice_resolved', 'safari_animal_choice_resolved', 'safari_continuation_visual_resolved', 'common_animal_subject_resolved', 'common_entity_view_resolved'].includes(item.code));
      const originalAnimalVisual = priorAnimalRepair?.originalPrimaryVisualSubject;
      const input = { ...slot, userLocked: target.userLocked, role: `day:${binding.dayIndex + 1}`, sourceRefs: slot.sourceEvidence,
        ...(priorAnimalRepair?.originalQueryCore ? { queryCore: priorAnimalRepair.originalQueryCore } : {}),
        primaryVisualSubject: originalAnimalVisual || slot.primaryVisualSubject };
      const repair = repairFactBoundAnimalChoice(input, facts, { allowAlternatives: true }) || repairFactBoundWildlifeChoice(input, facts) || repairSafariAnimalChoice(input, facts) || repairCommonVisualSubject(input, facts) || repairKnownImageSearchTarget(input, facts);
      if (repair) preference = { reason: repair.repair.code === "known_search_target_normalized" ? "known_search_target" : /^common_/.test(repair.repair.code) ? 'common_visual_subject' : 'fact_bound_animal_choice',
        primaryVisualSubject: repair.primaryVisualSubject, queryCore: repair.queryCore,
        animalSubjectOptions: repair.animalSubjectOptions, animalActionOptions: repair.animalActionOptions,
        locationRole: repair.locationRole, animalQueries: repair.animalSubjectOptions || /^(?:safari_|common_)/.test(repair.repair.code) ? repair.searchIntent : null,
        recoveryRepair: /^(?:safari_|common_)/.test(repair.repair.code) ? repair.repair : null,
        vocabularyRepair: repair.repair.code === "known_search_target_normalized" ? repair.repair : null };
    }
  }
  if (ambiguous && slot.moduleType === "transport") {
    // Prefer the same fact-bound overview used by automatic planning when
    // available; otherwise retain the established background preference.
    // Use the saved binding and confirmed input, never a role guessed from the
    // slot label or generated copy. Filtering in buildAgentFactBasis may change
    // array positions, so recover the original source index explicitly.
    const binding = plan?.slotBindings?.[slot.slotId];
    if (binding?.module === "transport" && Number.isInteger(binding.itemIndex) && binding.itemIndex >= 0
      && slot.sourceEvidence?.includes(`transport.${binding.itemIndex}`)) {
      const facts = buildAgentFactBasis(plan.preparedData);
      const transport = facts.transport.find(item => item.sourceIndex === binding.itemIndex);
      const input = { ...slot, userLocked: target.userLocked, role: "transport:1", sourceRefs: slot.sourceEvidence };
      const repair = transport && (repairBusinessTransferBackground(input, { ...facts, transport: [transport] }) || repairTransportOverviewPose(input,
        { ...facts, transport: [transport] }, { allowCoreActionChoices: true })
        || repairKnownImageSearchTarget(input, { ...facts, transport: [transport] }));
      if (repair) preference = { reason: repair.repair.code === "business_transfer_background_resolved" ? "business_transfer_background" : repair.repair.code === "known_search_target_normalized" ? "known_search_target" : "transport_overview_pose", primaryVisualSubject: repair.primaryVisualSubject,
        queryCore: repair.queryCore, posePreference: { action: slot.queryCore.action, actionEn: slot.queryCore.actionEn },
        ...(repair.repair.code === "business_transfer_background_resolved" ? { searchIntent: repair.searchIntent, recoveryRepair: repair.repair } : {}),
        vocabularyRepair: repair.repair.code === "known_search_target_normalized" ? repair.repair : null,
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
  if (descriptive && !preference && slot.moduleType === "day" && slot.visualTier !== "supporting"
    && !/supporting/.test(slot.slotId || "") && binding?.module === "day" && Number.isInteger(binding.dayIndex)) {
    const repair = repairFactBoundDepartureVisual({ ...target, role: `day:${binding.dayIndex + 1}`, sourceRefs: slot.sourceEvidence }, buildAgentFactBasis(plan.preparedData));
    if (repair) preference = { reason: "fact_bound_departure_visual", ...repair, animalQueries: repair.searchIntent };
  }
  if ((!duplicate && !preference && !descriptive && !queryOnly) || (ambiguous && !preference)
    || issues.some(issue => issue.code !== "duplicate_visual_responsibility"
      && issue.code !== "abstract_visual_subject"
      && !(issue.code === "ambiguous_visual_subject" && preference)
      && !(issue.code === "visual_query_branch_conflict" && (preference?.animalSubjectOptions || ['safari_continuation_visual_resolved','common_animal_subject_resolved','common_entity_view_resolved','business_transfer_background_resolved'].includes(preference?.recoveryRepair?.code)))
      && !REPAIRABLE_QUERY_ISSUES.has(issue.code))) return target;
  if (!clean(slot.queryCore?.subject) || !clean(slot.location)
    || !["scope_only", "visual_identity"].includes(slot.locationRole)
    || typeof slot.exactIdentityRequired !== "boolean"
    || slot.exactIdentityRequired && !clean(slot.queryCore?.identity)) return target;
  // Rebuild from the established Core; a fact-backed transport overview can
  // demote ordinary poses to preferences, but never an experience action.
  const queryCore = preference?.queryCore || slot.queryCore;
  const repairedQueries = preference?.searchIntent || preference?.animalQueries;
  const queryPlan = repairedQueries ? { queries: repairedQueries } : buildKnowledgeQueryPlan(preference
    ? { ...slot, queryCore, fidelityQuery: "", alternateQueries: [], searchIntent: [] } : slot, null);
  if (queryPlan.validationError || queryPlan.queries.length < 2) return target;
  return {
    ...target,
    queryCore,
    ...(preference?.locationRole ? { locationRole: preference.locationRole } : {}),
    ...(preference?.recoveryRepair ? { animalSubjectOptions: preference.animalSubjectOptions, animalActionOptions: preference.animalActionOptions,
      plannerLocalRepairs: [...(slot.plannerLocalRepairs || []), preference.recoveryRepair] } : {}),
    ...(preference?.animalSubjectOptions ? { animalSubjectOptions: preference.animalSubjectOptions } : {}),
    ...(preference?.animalActionOptions ? { animalActionOptions: preference.animalActionOptions } : {}),
    ...(preference?.sourceRefs ? { sourceEvidence: preference.sourceRefs } : {}),
    fidelityQuery: queryPlan.queries[0], alternateQueries: queryPlan.queries.slice(1), searchIntent: queryPlan.queries,
    ...(preference ? { primaryVisualSubject: preference.primaryVisualSubject,
      subject: preference.primaryVisualSubject, activity: preference.primaryVisualSubject,
      visualContext: { ...slot.visualContext, primaryVisualSubject: preference.primaryVisualSubject } } : {}),
    plannerSlotStatus: "user_requested", needsUserAction: false,
    manualSearchOverride: {
      reason: preference?.reason || (descriptive ? "explicit_event_search" : queryOnly ? "explicit_query_repair" : "duplicate_visual_responsibility"),
      originalPlannerStatus: slot.plannerSlotStatus, originalIssueCodes: issues.map(issue => issue.code),
      ...(preference ? { originalPrimaryVisualSubject: slot.primaryVisualSubject,
        ...(preference.vocabularyRepair ? { vocabularyRepair: preference.vocabularyRepair } : {}),
        ...(preference.posePreference ? { originalQueryCore: slot.queryCore, posePreference: preference.posePreference, sourceRef: preference.sourceRef } : {}),
        ...(preference.backgroundPreference ? { backgroundPreference: preference.backgroundPreference } : {}),
        ...(preference.supportingPreference ? { supportingPreference: preference.supportingPreference } : {}) } : {}),
    },
  };
}
