import { TRAVEL_ENTITY_REGISTRY } from "../src/data/travelEntityRegistry.js";
const name = (value) => typeof value === "string" ? value.trim() : value?.officialName || value?.name || "";
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
  const parts = unique([core.subjectEn, core.actionEn].filter(english));
  if (visualIdentity && !parts.join(" ").toLowerCase().includes(visualIdentity.toLowerCase())) parts.push(visualIdentity);
  const structuredEnglish = parts.join(" ");
  const first = structuredEnglish || shortQueries.find(english);
  const structuredChinese = unique([core.subject, core.action]).join(" ");
  const fallback = structuredChinese || shortQueries.find((query) => !english(query)) || shortQueries.find((query) => query !== first);
  const ordered = first ? unique([first, fallback]) : shortQueries.slice(0, 2);
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
export function classifyWebFallback(result, slot, route = null) {
  const status = result.technicalStatus || "";
  if (slot.planningStatus === "unresolved" || slot.needsUserAction || (String(slot.moduleType).toLowerCase().includes("hotel") && !name(slot.hotelOfficialName) && !name(slot.hotel))) return { allowed: false, reason: "target_identity_unresolved" };
  if (["visual_unavailable", "visual_failed"].includes(result.kind) || status.startsWith("visual_judgment")) return { allowed: false, reason: "audit_unavailable_or_incomplete" };
  if (route?.matched && !route.identityKnown) return { allowed: false, reason: "target_identity_unresolved" };
  if (route?.matched && route.knowledgeStopReason && route.knowledgeStopReason !== "identity_unknown") return { allowed: true, reason: route.knowledgeStopReason };
  if (["knowledge_failed", "knowledge_timeout"].includes(status)) return { allowed: true, reason: "knowledge_service_degraded_fallback" };
  if (["knowledge_scope_unresolved", "knowledge_hotel_scope_unresolved", "knowledge_needs_clarification"].includes(status)) {
    const knownIdentity = name(slot.hotelOfficialName) || name(slot.hotel) || name(slot.location) || name(slot.region) || name(slot.country) || name(slot.queryCore?.identity);
    return { allowed: Boolean(knownIdentity), reason: knownIdentity ? "knowledge_directory_unresolved_fallback" : "target_identity_unresolved" };
  }
  if (["no_candidate", "no_eligible"].includes(result.kind)) return { allowed: true, reason: "content_not_found_fallback" };
  return { allowed: false, reason: "query_or_identity_requires_user_action" };
}
