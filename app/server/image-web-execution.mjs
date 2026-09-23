import { TRAVEL_ENTITY_REGISTRY } from "../src/data/travelEntityRegistry.js";
const name = (value) => String(typeof value === "string" ? value : value?.officialName || value?.name || "").replace(/\s+/g, " ").trim();
const unique = (items) => [...new Set(items.filter(Boolean).map((item) => item.trim().replace(/\s+/g, " ")))];
const english = (value) => Boolean(value && /[a-z]/i.test(value) && !/[\u4e00-\u9fff]/.test(value));
const entityFor = (value) => TRAVEL_ENTITY_REGISTRY.find((entity) => [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})].some((alias) => alias && alias.toLowerCase() === name(value).toLowerCase()));
const englishName = (value) => { const entity = entityFor(value); return [entity?.displayNames?.en, entity?.canonicalName, ...(entity?.aliases || []), name(value)].find(english) || name(value); };
export function buildWebExecutionQueries(slot, queries, purpose = "", route = null) {
  const hotelModule = String(slot.moduleType).toLowerCase().includes("hotel");
  const hotel = name(slot.hotelOfficialName) || name(slot.hotel) || (route?.matched && route.entityType === "hotel" ? route.entityName : "");
  if (hotelModule) return hotel ? ["exterior", "suite", "pool", "public space"].map((category) => `${englishName(hotel)} ${category}`) : [];
  const core = slot.queryCore || {};
  const shortQueries = unique(queries);
  const visualIdentity = slot.exactIdentityRequired === true && english(core.identityEn) ? core.identityEn : "";
  const englishSubject = [core.subjectEn, core.subject].find(english) || "";
  const englishAction = [core.actionEn, core.action].find(english) || "";
  const hasSubject = Boolean(name(core.subject) || name(core.subjectEn));
  const hasAction = Boolean(name(core.action) || name(core.actionEn));
  // A translated fragment must never replace the complete Planner query.
  // Static scenes legitimately have no action; otherwise both Core parts
  // need an English expression before we construct an English query.
  const completeEnglishCore = hasSubject && englishSubject && (!hasAction || englishAction);
  const parts = completeEnglishCore ? unique([englishSubject, englishAction]) : [];
  if (visualIdentity && !parts.join(" ").toLowerCase().includes(visualIdentity.toLowerCase())) parts.push(visualIdentity);
  const structuredEnglish = completeEnglishCore ? parts.join(" ") : "";
  const incompleteEnglishParts = !completeEnglishCore && (hasSubject || hasAction)
    ? unique([englishSubject, englishAction, [englishSubject, englishAction].filter(Boolean).join(" ")]).map(value => value.toLowerCase()) : [];
  const first = structuredEnglish || shortQueries.find(query => english(query) && !incompleteEnglishParts.includes(query.toLowerCase()));
  const structuredChinese = unique([core.subject || core.subjectEn, core.action || core.actionEn]).join(" ");
  const fallback = structuredChinese || shortQueries.find((query) => !english(query)) || shortQueries.find((query) => query !== first);
  const ordered = first ? unique([first, fallback])
    : unique([structuredChinese, ...shortQueries.filter(query => !incompleteEnglishParts.includes(query.toLowerCase()))]).slice(0, 2);
  if (slot.exactIdentityRequired === true) {
    if (!name(core.identity)) return [];
    const context = route?.entityType === "hotel_experience" ? "" : englishName(slot.region || slot.country);
    return ordered.slice(0, 2).map((query) => {
      const entity = english(core.identityEn) ? core.identityEn : englishName(core.identity);
      const base = query.toLowerCase().includes(entity.toLowerCase()) ? query : `${entity} ${query}`;
      return context && !base.toLowerCase().includes(context.toLowerCase()) ? `${base} ${context}` : base;
    });
  }
  const locationEntity = entityFor(slot.location) || (slot.visualContext?.scopeFallbackLocations || []).map(entityFor).find((entity) => entity && ["place", "park", "conservancy"].includes(entity.entityType));
  const identity = unique([slot.regionEn, slot.countryEn, slot.region, slot.country, locationEntity?.region, locationEntity?.country, slot.destinationEn, slot.destination].map(englishName)).find(english) || "";
  return ordered.slice(0, 2).map((query) => identity && !query.toLowerCase().includes(identity.toLowerCase()) ? `${identity} ${query}` : query);
}
export function classifyWebFallback(result, slot, route = null, knowledgeQueries = null) {
  const status = result.technicalStatus || "";
  if (slot.planningStatus === "unresolved" || slot.needsUserAction || (String(slot.moduleType).toLowerCase().includes("hotel") && !name(slot.hotelOfficialName) && !name(slot.hotel))) return { allowed: false, reason: "target_identity_unresolved" };
  if (["visual_unavailable", "visual_failed"].includes(result.kind) || status.startsWith("visual_judgment")) return { allowed: false, reason: "audit_unavailable_or_incomplete" };
  if (route?.matched && !route.identityKnown) return { allowed: false, reason: "target_identity_unresolved" };
  if (result.kind === "inconclusive" && ["knowledge_original_resolution_insufficient", "preview_found_original_download_failed"].includes(status)) {
    if (result.visualAuditComplete !== true) return { allowed: false, reason: "audit_unavailable_or_incomplete" };
    if (!Array.isArray(knowledgeQueries) || !knowledgeQueries.length || !buildWebExecutionQueries(slot, knowledgeQueries, "", route).length) return { allowed: false, reason: "web_query_unavailable" };
    return { allowed: true, reason: status === "knowledge_original_resolution_insufficient" ? "knowledge_original_resolution_fallback" : "knowledge_original_download_fallback" };
  }
  if (route?.matched && route.knowledgeStopReason && route.knowledgeStopReason !== "identity_unknown") return { allowed: true, reason: route.knowledgeStopReason };
  if (["knowledge_failed", "knowledge_timeout"].includes(status)) return { allowed: true, reason: "knowledge_service_degraded_fallback" };
  if (["knowledge_scope_unresolved", "knowledge_hotel_scope_unresolved", "knowledge_needs_clarification"].includes(status)) {
    const knownIdentity = name(slot.hotelOfficialName) || name(slot.hotel) || name(slot.location) || name(slot.region) || name(slot.country) || name(slot.queryCore?.identity);
    return { allowed: Boolean(knownIdentity), reason: knownIdentity ? "knowledge_directory_unresolved_fallback" : "target_identity_unresolved" };
  }
  if (["no_candidate", "no_eligible"].includes(result.kind)) return { allowed: true, reason: "content_not_found_fallback" };
  return { allowed: false, reason: "query_or_identity_requires_user_action" };
}
