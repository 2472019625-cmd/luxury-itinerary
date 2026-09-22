import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TRAVEL_ENTITY_REGISTRY } from "../src/data/travelEntityRegistry.js";
import { normalizeTravelEntityName } from "../src/lib/travelEntityDisplay.js";

const GENERIC_NODE_NAMES = new Set(["根知识库", "stay", "food", "experience", "guestareas", "wildlife", "safari", "photo", "确定", "同集团未确认归属营地", "同集团未确定营地归属"]);

const CHILD_SCOPE_SEMANTICS = {
  accommodation: {
    slotTerms: ["suite", "bedroom", "room interior", "guest room", "villa", "tent", "客房", "套房", "卧室", "房间", "帐篷"],
    directoryTerms: ["stay", "accommodation", "room", "rooms", "suite", "villa", "tent", "guest room", "住宿", "客房", "套房"],
  },
  dining: {
    slotTerms: ["bush breakfast", "breakfast", "sundowner", "dinner", "wine cellar", "wine tasting", "restaurant", "dining", "bar", "早餐", "晚宴", "酒窖", "品酒", "餐厅", "餐饮", "日落酒会"],
    directoryTerms: ["food", "dining", "culinary", "restaurant", "bar", "breakfast", "dinner", "wine", "cellar", "餐饮", "餐厅", "酒窖", "早餐", "晚宴"],
  },
  balloon: {
    slotTerms: ["hot air balloon", "balloon", "热气球"],
    directoryTerms: ["balloon", "ballooning", "热气球"],
  },
  culture: {
    slotTerms: ["maasai", "cultural", "culture", "village", "boma", "马赛", "文化", "部落"],
    directoryTerms: ["maasai", "culture", "cultural", "village", "boma", "马赛", "文化", "部落"],
  },
  activity: {
    slotTerms: ["walking safari", "night safari", "night game drive", "game drive", "anti-poaching", "ranger", "star bed", "sleep out", "outdoor bed", "viewpoint", "徒步游猎", "夜间游猎", "反偷猎", "巡护", "星空床", "观景台"],
    directoryTerms: ["activities", "activity", "safari", "wilderness", "experience", "excursions", "game drive", "活动", "游猎", "体验"],
  },
  wellness: {
    slotTerms: ["spa", "wellness", "massage", "水疗", "康养", "按摩"],
    directoryTerms: ["spa", "wellness", "massage", "水疗", "康养"],
  },
};

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const normalized = (value) => normalizeTravelEntityName(clean(value));
const unique = (values) => [...new Set(values.map(clean).filter(Boolean))];
const canUseEmbeddedName = (value) => value.length >= 6 || ((value.match(/[\u3400-\u9fff]/g) || []).length >= 4);

function flattenStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenStrings(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) flattenStrings(item, output);
  return output;
}

function slotFacts(slot = {}) {
  return unique(flattenStrings({
    destination: slot.destination,
    country: slot.country,
    day: slot.day,
    location: slot.location,
    region: slot.region,
    hotel: slot.hotel,
    hotelOfficialName: slot.hotelOfficialName,
    hotelShortName: slot.hotelShortName,
    diningLocation: slot.diningLocation,
    primaryVisualSubject: slot.primaryVisualSubject,
    activity: slot.activity,
    subject: slot.subject,
    sourceEvidence: slot.sourceEvidence,
    routeNodes: slot.routeNodes,
    visualContext: slot.visualContext,
  }));
}

function referencedEntities(facts) {
  const normalizedFacts = facts.map(normalized).filter(Boolean);
  return TRAVEL_ENTITY_REGISTRY.filter((entity) => {
    const names = [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})].map(normalized).filter(Boolean);
    return names.some((name) => normalizedFacts.some((fact) => fact === name || (canUseEmbeddedName(name) && fact.includes(name))));
  });
}

function enrichedFacts(slot) {
  const direct = slotFacts(slot);
  const entities = referencedEntities(direct);
  const scopeKeys = entities.flatMap((entity) => [entity.region, entity.country]).map(normalized).filter(Boolean);
  const directScopeEntities = TRAVEL_ENTITY_REGISTRY.filter((entity) => {
    if (!["place", "park", "conservancy", "airport"].includes(entity.entityType)) return false;
    return [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})]
      .map(normalized)
      .some((name) => scopeKeys.includes(name));
  });
  const parentScopeKeys = directScopeEntities.flatMap((entity) => [entity.region, entity.country]).map(normalized).filter(Boolean);
  const parentScopeEntities = TRAVEL_ENTITY_REGISTRY.filter((entity) => {
    if (!["place", "park", "conservancy", "airport"].includes(entity.entityType)) return false;
    return [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})]
      .map(normalized)
      .some((name) => parentScopeKeys.includes(name));
  });
  const scopeEntities = [...directScopeEntities, ...parentScopeEntities];
  return unique([
    ...direct,
    ...entities.flatMap((entity) => [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {}), entity.country, entity.region]),
    ...scopeEntities.flatMap((entity) => [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})]),
  ]);
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function buildKnowledgeHierarchy(nodes = []) {
  const byId = new Map(nodes.filter((node) => node?.node_id).map((node) => [String(node.node_id), node]));
  const records = [...byId.values()].map((node) => {
    const chain = [];
    const seen = new Set();
    let current = node;
    while (current?.node_id && !seen.has(current.node_id)) {
      seen.add(current.node_id);
      chain.unshift(clean(current.formal_name));
      current = current.parent_node_id ? byId.get(String(current.parent_node_id)) : null;
    }
    return {
      nodeId: String(node.node_id),
      formalName: clean(node.formal_name),
      parentNodeId: node.parent_node_id ? String(node.parent_node_id) : null,
      pathSegments: chain.filter(Boolean),
      fullPath: chain.filter(Boolean).join(" / "),
      // The current Knowledge API searches a selected directory together with
      // all descendants. Keep the flag explicit so a future non-recursive
      // hierarchy can still use child -> root without duplicating today.
      includesDescendants: node.scope_includes_descendants !== false && node.includes_descendants !== false,
    };
  });
  return { byId: new Map(records.map((record) => [record.nodeId, record])), records };
}

export async function loadKnowledgeHierarchy({ baseUrl, fetchImpl = fetch, signal, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const combined = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const response = await fetchImpl(`${String(baseUrl || "").replace(/\/$/, "")}/api/knowledge/hierarchy/nodes?status=active`, { signal: combined });
    if (!response.ok) throw Object.assign(new Error(`知识库层级读取失败（${response.status}）`), { code: `knowledge_hierarchy_http_${response.status}` });
    const payload = await response.json();
    const nodes = payload?.data?.nodes || payload?.nodes || [];
    if (!Array.isArray(nodes)) throw Object.assign(new Error("知识库层级返回格式无效"), { code: "knowledge_hierarchy_invalid" });
    return buildKnowledgeHierarchy(nodes);
  } finally {
    clearTimeout(timer);
  }
}

function matchStrength(name, fact) {
  const left = normalized(name);
  const right = normalized(fact);
  if (!left || !right) return 0;
  if (left === right) return 120;
  const nameTokens = clean(name).toLocaleLowerCase("en").split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3 && !["the", "hotel", "camp", "lodge", "safari"].includes(token));
  const factTokens = clean(fact).toLocaleLowerCase("en").split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3 && !["the", "hotel", "camp", "lodge", "safari"].includes(token));
  if (nameTokens.length >= 2 && nameTokens.every((token) => factTokens.some((candidate) => token === candidate || (Math.min(token.length, candidate.length) >= 4 && editDistance(token, candidate) <= 1)))) return 100;
  if ((canUseEmbeddedName(left) || canUseEmbeddedName(right)) && (left.includes(right) || right.includes(left))) return 88;
  if (Math.max(left.length, right.length) >= 9 && editDistance(left, right) <= 1) return 104;
  return 0;
}

function entityNames(entity) {
  return [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})].filter(Boolean);
}

function stronglyReferencedEntities(value) {
  return TRAVEL_ENTITY_REGISTRY.filter((entity) => entityNames(entity)
    .some((name) => Math.max(matchStrength(name, value), matchStrength(value, name)) >= 100));
}

function identityMatches(left, right) {
  if (Math.max(matchStrength(left, right), matchStrength(right, left)) >= 88) return true;
  const leftEntityIds = new Set(stronglyReferencedEntities(left).map((entity) => entity.id));
  return stronglyReferencedEntities(right).some((entity) => leftEntityIds.has(entity.id));
}

function strictIdentityMatches(left, right) {
  if (Math.max(matchStrength(left, right), matchStrength(right, left)) >= 100) return true;
  const leftEntityIds = new Set(stronglyReferencedEntities(left).map((entity) => entity.id));
  return stronglyReferencedEntities(right).some((entity) => leftEntityIds.has(entity.id));
}

function sourcePathSegments(sourcePath) {
  return unique(clean(sourcePath).split(/[\\/]+/).map((segment) => segment.replace(/[?#].*$/, "")));
}

function sourcePathSupportsParent(segments, parentAnchor) {
  if (segments.some((segment) => identityMatches(segment, parentAnchor))) return true;
  return segments.some((segment) => stronglyReferencedEntities(segment).some((entity) =>
    [entity.region, entity.country].filter(Boolean).some((scopeValue) => identityMatches(scopeValue, parentAnchor))));
}

function moduleKind(slot = {}) {
  const value = clean(slot.moduleType).toLowerCase();
  if (value.includes("hotel")) return "hotel";
  if (value.includes("dining") || value.includes("restaurant")) return "dining";
  if (value.includes("transport") || value.includes("transfer")) return "transport";
  if (value.includes("cover")) return "cover";
  if (value.includes("day")) return "day";
  return "generic";
}

function explicitNamedEntity(slot = {}) {
  return referencedEntities(unique([slot.diningLocation, slot.primaryVisualSubject, slot.activity, slot.subject]))
    .find((entity) => ["attraction", "restaurant", "experience"].includes(entity.entityType)) || null;
}

function querySourceValues(slot = {}) {
  return unique([slot.primaryVisualSubject, slot.subject, slot.activity]);
}

function namedEntityText(slot = {}) {
  const subject = clean(slot.primaryVisualSubject || slot.subject || slot.activity);
  const explicitEntity = explicitNamedEntity(slot);
  return clean(slot.diningLocation)
    || explicitEntity?.canonicalName
    || subject.match(/\bThe\s+[A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*){0,4}\b/)?.[0]
    || subject.match(/\b[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,4}\s+(?:Museum|Centre|Center|Restaurant)\b/)?.[0]
    || "";
}

function namedEntityIsContextualExperience(slot = {}) {
  const entity = explicitNamedEntity(slot);
  if (!entity || entity.entityType !== "attraction") return false;
  const searchable = normalized(querySourceValues(slot).join(" "));
  const hasAnimal = /(giraffe|elephant|rhino|zebra|长颈鹿|大象|犀牛|斑马)/.test(searchable);
  const hasInteraction = /(interaction|feeding|encounter|closecontact|互动|喂食|投喂|零距离|近距离接触)/.test(searchable);
  const asksForVenueIdentity = /(exterior|entrance|signage|building|architecture|外观|入口|招牌|标识|建筑)/.test(searchable);
  const entityText = normalized(entityNames(entity).join(" "));
  const isViewpoint = /(viewpoint|observationhill|observationdeck|观景山|观景台)/.test(entityText);
  const hasViewTarget = /(overlook|panoramic|fromhill|fromviewpoint|俯瞰|眺望|远眺|山顶).*(wetland|elephant|wildlife|savanna|lake|river|湿地|象群|大象|动物|草原|湖泊|河流)/.test(searchable)
    || /(wetland|elephant|wildlife|savanna|lake|river|湿地|象群|大象|动物|草原|湖泊|河流).*(overlook|panoramic|fromhill|fromviewpoint|俯瞰|眺望|远眺|山顶)/.test(searchable);
  return !asksForVenueIdentity && ((hasAnimal && hasInteraction) || (isViewpoint && hasViewTarget));
}

function visualSubjectWithoutContextEntity(slot = {}) {
  const subject = clean(slot.primaryVisualSubject || slot.subject || slot.activity);
  const entity = explicitNamedEntity(slot);
  if (!subject || !entity) return subject;
  let result = subject;
  for (const name of entityNames(entity).sort((left, right) => right.length - left.length)) {
    if (!name) continue;
    result = result.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  }
  result = clean(result);
  return clean(result.replace(/^[与和及、:：\-—]+|[与和及、:：\-—]+$/g, "")) || subject;
}

function hotelEntityForSlot(slot = {}) {
  const kind = moduleKind(slot);
  const targetValues = unique([
    slot.hotel,
    slot.hotelOfficialName,
    slot.hotelShortName,
    slot.diningLocation,
    ...(kind === "hotel" || kind === "dining" ? [slot.location] : []),
    ...querySourceValues(slot),
  ]);
  const direct = referencedEntities(targetValues).filter((entity) => entity.entityType === "hotel");
  if (direct.length === 1) return direct[0];
  if (kind !== "day") return null;
  const target = normalized(querySourceValues(slot).join(" "));
  const contextual = referencedEntities(slotFacts(slot)).filter((entity) => entity.entityType === "hotel");
  const matching = contextual.filter((entity) => entityNames(entity).some((name) => {
    const words = clean(name).toLocaleLowerCase("en").split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 5 && !["hotel", "lodge", "camp", "safari", "resort", "tented"].includes(word));
    return words.some((word) => target.includes(normalized(word)));
  }));
  return matching.length === 1 ? matching[0] : null;
}

export function classifyKnowledgeImagePurpose(slot = {}) {
  const kind = moduleKind(slot);
  const searchable = normalized(querySourceValues(slot).join(" "));
  const hotelEntity = hotelEntityForSlot(slot);
  const hotelIdentity = clean(slot.hotel || slot.hotelOfficialName || slot.hotelShortName || hotelEntity?.canonicalName);
  const namedEntity = namedEntityText(slot);
  if (kind === "cover") return "cover";
  if (kind === "transport" || /(lightaircraft|bushplane|airstrip|草原飞机|轻型飞机|transfervehicle|cartransfer|接送车辆|商务用车)/.test(searchable)) return "transport";
  const hotelSemantic = hotelIdentity ? semanticCategory(slot) : null;
  const subjectNamesHotel = hotelEntity && querySourceValues(slot).some((value) => entityNames(hotelEntity).some((name) => identityMatches(value, name)));
  const explicitHotelFacility = /(专属|exclusive|starbed|sleepout|outdoorbed|星空床|winecellar|酒窖|suite|guestroom|pool|spa|套房|客房|泳池|水疗|私人(?:酒窖|泳池|餐厅|用餐|露台|酒廊)|private(?:winecellar|pool|dining|deck|lounge))/.test(searchable);
  // A hotel present in the day context does not make every meal or activity a
  // hotel-exclusive experience. Bind identity only when the visual subject
  // names the hotel or is explicitly a hotel facility/private experience.
  if (hotelIdentity && ["day", "dining"].includes(kind) && hotelSemantic && (subjectNamesHotel || explicitHotelFacility)) return "hotel_experience";
  if (kind === "hotel") return "hotel_space";
  if (namedEntity && namedEntityIsContextualExperience(slot)) return "destination_experience";
  if (namedEntity) return "explicit_entity";
  return "destination_experience";
}

function expandEntityFacts(values, entityTypes = [], { includeScope = true } = {}) {
  const facts = unique(values);
  const keys = facts.map(normalized).filter(Boolean);
  const matched = TRAVEL_ENTITY_REGISTRY.filter((entity) => {
    if (entityTypes.length && !entityTypes.includes(entity.entityType)) return false;
    const names = [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})].map(normalized).filter(Boolean);
    return names.some((name) => keys.some((key) => key === name || (canUseEmbeddedName(name) && key.includes(name))));
  });
  const scopeValues = includeScope ? matched.flatMap((entity) => [entity.region, entity.country]).filter(Boolean) : [];
  const scopeKeys = scopeValues.map(normalized);
  const scopeEntities = includeScope ? TRAVEL_ENTITY_REGISTRY.filter((entity) => {
    if (!["place", "park", "conservancy", "airport"].includes(entity.entityType)) return false;
    return [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})]
      .map(normalized)
      .some((name) => scopeKeys.includes(name));
  }) : [];
  return unique([
    ...facts,
    ...matched.flatMap((entity) => [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {}), ...scopeValues]),
    ...scopeEntities.flatMap((entity) => [entity.canonicalName, ...(entity.aliases || []), ...Object.values(entity.displayNames || {})]),
  ]);
}

function primaryFactGroups(slot, facts) {
  const kind = moduleKind(slot);
  const purpose = classifyKnowledgeImagePurpose(slot);
  const specificGeography = expandEntityFacts([slot.location, slot.region, slot.visualContext?.geographicLocation], ["place", "park", "conservancy", "airport"]);
  const broadGeography = expandEntityFacts([slot.destination, slot.country, slot.visualContext?.destination], ["place", "park", "conservancy", "airport"]);
  const fallbackGeographies = unique([
    ...(Array.isArray(slot.scopeFallbackLocations) ? slot.scopeFallbackLocations : []),
    ...(Array.isArray(slot.visualContext?.scopeFallbackLocations) ? slot.visualContext.scopeFallbackLocations : []),
  ]).map((value) => expandEntityFacts([value], ["place", "park", "conservancy", "airport"])).filter((group) => group.length);
  const explicitEntity = explicitNamedEntity(slot);
  const explicitName = explicitEntity?.canonicalName || (purpose === "explicit_entity" ? namedEntityText(slot) : "");
  if (explicitName) {
    const entityFacts = explicitEntity ? entityNames(explicitEntity) : [explicitName];
    return [entityFacts, specificGeography, ...fallbackGeographies, broadGeography, facts].filter((group) => group.length);
  }
  if (["hotel_space", "hotel_experience"].includes(purpose)) {
    const hotelEntity = hotelEntityForSlot(slot);
    const referencedHotels = hotelEntity ? [hotelEntity] : referencedEntities(facts).filter((entity) => entity.entityType === "hotel");
    const hotels = expandEntityFacts([slot.hotel, slot.hotelOfficialName, slot.hotelShortName, slot.diningLocation, ...referencedHotels.flatMap((entity) => entityNames(entity))], ["hotel"], { includeScope: false });
    return [hotels, specificGeography, ...fallbackGeographies, broadGeography].filter((group) => group.length);
  }
  if (kind === "cover") {
    const coreDestination = expandEntityFacts(querySourceValues(slot), ["place", "park", "conservancy", "airport"]);
    return [coreDestination, specificGeography, ...fallbackGeographies, broadGeography].filter((group) => group.length);
  }
  const route = expandEntityFacts([
    ...(Array.isArray(slot.routeNodes) ? slot.routeNodes : []),
    ...(Array.isArray(slot.visualContext?.routeNodes) ? slot.visualContext.routeNodes : []),
    slot.hotel,
  ], ["place", "park", "conservancy", "airport", "hotel"]);
  return [specificGeography, ...fallbackGeographies, route, broadGeography, facts].filter((group) => group.length);
}

function mappingKey(slot) {
  const kind = moduleKind(slot);
  const purpose = classifyKnowledgeImagePurpose(slot);
  const identity = ["hotel_space", "hotel_experience"].includes(purpose)
    ? clean(slot.hotel || slot.hotelOfficialName || slot.hotelShortName || slot.diningLocation || hotelEntityForSlot(slot)?.canonicalName || slot.subject)
    : clean(slot.location || slot.region || slot.destination || slot.country);
  return identity ? `${kind}:${normalized(identity)}` : "";
}

export function resolveKnowledgeScope(slot = {}, hierarchy, { allowedNodeIds, cachedNodeId } = {}) {
  if (!hierarchy?.records?.length) return { status: "unresolved", nodeIds: [], reason: "hierarchy_unavailable", facts: slotFacts(slot) };
  const directFacts = slotFacts(slot);
  const allFacts = enrichedFacts(slot);
  const factGroups = primaryFactGroups(slot, directFacts);
  const allowed = Array.isArray(allowedNodeIds) && allowedNodeIds.length ? new Set(allowedNodeIds.map(String)) : null;
  const kind = moduleKind(slot);
  let scored = [];
  for (const importantFacts of factGroups) {
    scored = hierarchy.records
      .filter((node) => !allowed || allowed.has(node.nodeId))
      .map((node) => {
        const direct = Math.max(0, ...importantFacts.map((fact) => matchStrength(node.formalName, fact)));
        const context = node.pathSegments.slice(0, -1).reduce((score, segment) => score + (allFacts.some((fact) => matchStrength(segment, fact) >= 104) ? 10 : 0), 0);
        const genericPenalty = GENERIC_NODE_NAMES.has(normalized(node.formalName)) || GENERIC_NODE_NAMES.has(node.formalName) ? 80 : 0;
        const deepHotelChildPenalty = (kind === "hotel" || kind === "dining") && /\b(?:food|stay|experience|guest areas?|wildlife|safari|accommodation)\b/i.test(node.formalName) ? 60 : 0;
        const coverHotelPenalty = kind === "cover" && node.pathSegments.length > 4 ? 80 : 0;
        return { node, score: direct + context - genericPenalty - deepHotelChildPenalty - coverHotelPenalty, direct };
      })
      .filter((item) => item.direct >= 88 && item.score >= 88)
      .sort((left, right) => right.score - left.score || left.node.pathSegments.length - right.node.pathSegments.length);
    if (scored.length) break;
  }
  const first = scored[0];
  const second = scored[1];
  if (!first || (second && first.score === second.score)) {
    return { status: first ? "ambiguous" : "unresolved", nodeIds: [], candidates: scored.slice(0, 8).map((item) => ({ nodeId: item.node.nodeId, fullPath: item.node.fullPath, score: item.score })), reason: first ? "non_unique_match" : "no_deterministic_match", facts: allFacts, mappingKey: mappingKey(slot) };
  }
  const validatedCache = cachedNodeId && String(cachedNodeId) === first.node.nodeId;
  return { status: "resolved", nodeIds: [first.node.nodeId], node: first.node, fullPath: first.node.fullPath, reason: validatedCache ? "persistent_mapping_validated" : "unique_hierarchy_match", facts: allFacts, mappingKey: mappingKey(slot) };
}

export function resolveKnowledgeClarification(slot, clarificationNodeIds, hierarchy) {
  return resolveKnowledgeScope(slot, hierarchy, { allowedNodeIds: clarificationNodeIds });
}

// Directory identity may be distributed across brand/location/venue ancestors.
// This confirms directories only; it never establishes a Slot's Core identity.
export function confirmHotelDirectory(slot, hierarchy) {
  const entity = hotelEntityForSlot(slot);
  const targets = unique([slot.hotel, slot.hotelOfficialName, slot.queryCore?.identity,
    ...(entity ? entityNames(entity) : [])]);
  const nonHotelScopeNames = unique([
    slot.country,
    slot.destination,
    slot.visualContext?.destination,
    entity?.country,
    entity?.region,
  ]).map(normalized);
  const names = targets.map(name => ({name, tokens: clean(name).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(t => t && !/^(?:the|hotel|lodge|camp|resort|tented|member|of|collection)$/i.test(t))}));
  const fullCandidates = [];
  const abbreviatedCandidates = [];
  for (const node of hierarchy?.records || []) {
    if (GENERIC_NODE_NAMES.has(normalized(node.formalName))) continue;
    if (nonHotelScopeNames.includes(normalized(node.formalName))) continue;
    const pathNames = unique([...node.pathSegments, ...node.pathSegments.flatMap(segment =>
      TRAVEL_ENTITY_REGISTRY.filter(e => entityNames(e).some(n => normalized(n) === normalized(segment))).flatMap(entityNames))]);
    const tokens = new Set(pathNames.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const leafTokens = clean(node.formalName).toLowerCase().split(/[^\p{L}\p{N}]+/u);
    if (names.some(({name, tokens: required}) => normalized(node.formalName) === normalized(name)
      || (leafTokens.length >= 2 && strictIdentityMatches(node.formalName, name))
      || (required.length > 0 && required.every(t => tokens.has(t)) && required.some(t => leafTokens.includes(t))))) {
      fullCandidates.push(node);
    } else if (leafTokens.length >= 2 && names.some(({tokens: required}) =>
      leafTokens.every(t => required.includes(t)))) {
      // Only unique abbreviated roots may be used; activity context cannot
      // disambiguate two different hotels sharing the same directory name.
      abbreviatedCandidates.push(node);
    }
  }
  const candidates = fullCandidates.length ? fullCandidates : abbreviatedCandidates;
  // Once a hotel root is proven, descendant spaces are not competing hotels.
  const roots = candidates.filter(node => !candidates.some(other => other.nodeId !== node.nodeId
    && ancestorChain(resolutionForNode(node),hierarchy).some(a => a.nodeId === other.nodeId)));
  const status = roots.length === 1 ? 'resolved' : roots.length > 1 ? 'ambiguous' : 'unresolved';
  return {status, reason: status === 'resolved' ? 'hotel_identity_confirmed_by_full_path'
    : status === 'ambiguous' ? 'entity_directory_ambiguous' : 'entity_directory_unresolved',
    candidates: roots.map(n => ({nodeId:n.nodeId,fullPath:n.fullPath})),
    resolution: roots.length === 1 ? resolutionForNode(roots[0], 'hotel_identity_confirmed_by_full_path', targets) : null};
}

function semanticCategory(slot = {}) {
  const hotelIdentity = clean(slot.hotel || slot.hotelOfficialName || slot.hotelShortName || slot.diningLocation || hotelEntityForSlot(slot)?.canonicalName);
  const subject = clean(slot.primaryVisualSubject || slot.subject);
  const activity = clean(slot.activity);
  const kind = moduleKind(slot);
  const isRepresentativeHotel = kind === "hotel" && !activity && (!subject || identityMatches(subject, hotelIdentity));
  if (isRepresentativeHotel) return "accommodation";
  const searchable = normalized(unique([subject, activity, slot.diningLocation]).join(" "));
  const matches = Object.entries(CHILD_SCOPE_SEMANTICS)
    .filter(([, definition]) => definition.slotTerms.some((term) => searchable.includes(normalized(term))))
    .map(([category]) => category);
  return matches.length === 1 ? matches[0] : null;
}

function scopeSummary(resolution) {
  return resolution ? {
    status: resolution.status,
    nodeIds: resolution.nodeIds || [],
    fullPath: resolution.fullPath || null,
    reason: resolution.reason || null,
  } : null;
}

function isResolvedHotelRoot(slot, scopeResolution) {
  if (scopeResolution?.status !== "resolved" || !scopeResolution.node) return false;
  const hotels = referencedEntities(slotFacts(slot)).filter((entity) => entity.entityType === "hotel");
  return hotels.some((hotel) => entityNames(hotel).some((name) => identityMatches(name, scopeResolution.node.formalName)));
}

export function resolveKnowledgeChildScope(slot = {}, rootResolution = null, hierarchy) {
  const baseDecision = {
    entered: false,
    category: null,
    rootScope: scopeSummary(rootResolution),
    availableChildren: [],
    matchingChildren: [],
    reason: "hotel_root_not_confirmed",
  };
  if (!isResolvedHotelRoot(slot, rootResolution) || !hierarchy?.records?.length) return { scopeResolution: rootResolution, decision: baseDecision };
  const directChildren = hierarchy.records.filter((record) => record.parentNodeId === rootResolution.node.nodeId);
  baseDecision.availableChildren = directChildren.map((record) => ({ nodeId: record.nodeId, formalName: record.formalName, fullPath: record.fullPath }));
  const category = semanticCategory(slot);
  baseDecision.category = category;
  if (!category) return { scopeResolution: rootResolution, decision: { ...baseDecision, reason: "no_unique_slot_semantic_or_representative_hotel" } };
  const directoryTerms = CHILD_SCOPE_SEMANTICS[category].directoryTerms.map(normalized);
  const expectedPrefix = [...rootResolution.node.pathSegments];
  const descendantsByBranch = directChildren.map((branch) => ({
    branch,
    descendants: hierarchy.records.filter((record) => record.pathSegments.length > expectedPrefix.length
      && [...expectedPrefix, branch.formalName].every((segment, index) => normalized(segment) === normalized(record.pathSegments[index]))),
  }));
  const matching = descendantsByBranch.filter(({ descendants }) => descendants.some((record) => directoryTerms.some((term) => normalized(record.formalName).includes(term))));
  baseDecision.matchingChildren = matching.map(({ branch }) => ({ nodeId: branch.nodeId, formalName: branch.formalName, fullPath: branch.fullPath }));
  if (matching.length !== 1) {
    return { scopeResolution: rootResolution, decision: { ...baseDecision, reason: matching.length ? "multiple_equally_plausible_child_scopes" : "no_matching_child_scope" } };
  }
  const child = matching[0].branch;
  return {
    scopeResolution: { status: "resolved", nodeIds: [child.nodeId], node: child, fullPath: child.fullPath, reason: "unique_semantic_child_scope", facts: rootResolution.facts, mappingKey: rootResolution.mappingKey },
    decision: { ...baseDecision, entered: true, nodeId: child.nodeId, fullPath: child.fullPath, reason: "unique_semantic_child_scope" },
  };
}

function resolutionForNode(node, reason, facts = [], mapping = "") {
  return { status: "resolved", nodeIds: [node.nodeId], node, fullPath: node.fullPath, reason, facts, mappingKey: mapping };
}

function ancestorChain(resolution, hierarchy) {
  if (resolution?.status !== "resolved" || !resolution.node || !hierarchy?.byId) return [];
  const chain = [];
  let current = resolution.node;
  while (current) {
    chain.push(current);
    current = current.parentNodeId ? hierarchy.byId.get(current.parentNodeId) : null;
  }
  return chain;
}

function addScope(scopes, resolution, role, evidenceResolution = resolution, sourcePathMode = "entity_identity", identityAnchors = []) {
  if (resolution?.status !== "resolved") return;
  if (scopes.some((item) => item.resolution.nodeIds[0] === resolution.nodeIds[0])) return;
  scopes.push({ role, resolution, evidenceResolution, sourcePathMode, identityAnchors: unique(identityAnchors) });
}

function resolutionContains(rootResolution, childResolution, hierarchy) {
  if (rootResolution?.status !== "resolved" || childResolution?.status !== "resolved") return false;
  if (rootResolution.node?.includesDescendants === false) return false;
  const rootId = rootResolution.nodeIds?.[0];
  let current = childResolution.node;
  while (current) {
    if (current.nodeId === rootId) return true;
    current = current.parentNodeId ? hierarchy?.byId?.get(current.parentNodeId) : null;
  }
  return false;
}

function resolutionEntityType(resolution) {
  if (resolution?.status !== "resolved" || !resolution.node) return null;
  return TRAVEL_ENTITY_REGISTRY
    .map((entity) => ({ entity, score: Math.max(...entityNames(entity).map((name) => matchStrength(name, resolution.node.formalName))) }))
    .filter((item) => item.score >= 88)
    .sort((left, right) => right.score - left.score)[0]?.entity?.entityType || null;
}

function progressiveScopeResolutions(startResolution, countryResolution, hierarchy) {
  const countryNodeId = countryResolution?.nodeIds?.[0] || null;
  const chain = ancestorChain(startResolution, hierarchy)
    .filter((node) => !GENERIC_NODE_NAMES.has(normalized(node.formalName)))
    .map((node, index) => resolutionForNode(node, index === 0 ? "planned_specific_scope" : "planned_parent_scope", startResolution?.facts, startResolution?.mappingKey));
  const untilCountry = [];
  for (const resolution of chain) {
    untilCountry.push(resolution);
    if (countryNodeId && resolution.nodeIds[0] === countryNodeId) break;
  }
  if (countryResolution && !untilCountry.some((resolution) => resolution.nodeIds[0] === countryNodeId)) untilCountry.push(countryResolution);
  return untilCountry;
}

export function buildKnowledgeScopePlan(slot = {}, rootResolution = null, hierarchy) {
  const purpose = classifyKnowledgeImagePurpose(slot);
  const hotelModule = moduleKind(slot) === "hotel";
  const refined = resolveKnowledgeChildScope(slot, rootResolution, hierarchy);
  const scopes = [];
  const chain = ancestorChain(rootResolution, hierarchy);
  const hierarchyRoot = chain.at(-1) || null;
  const meaningful = chain.filter((node) => !GENERIC_NODE_NAMES.has(normalized(node.formalName)));
  const countryFacts = unique([
    slot.country,
    slot.destination,
    slot.visualContext?.destination,
    ...referencedEntities(slotFacts(slot)).map((entity) => entity.country),
  ]);
  const matchedEntities = referencedEntities(slotFacts(slot));
  const regionFacts = unique(matchedEntities.map((entity) => entity.region));
  const regionNode = meaningful.find((node) => regionFacts.some((fact) => identityMatches(node.formalName, fact)));
  const inferredCountryNode = regionNode?.parentNodeId ? hierarchy?.byId?.get(regionNode.parentNodeId) : null;
  const countryNode = meaningful.find((node) => countryFacts.some((fact) => identityMatches(node.formalName, fact)))
    || hierarchy?.records?.find((node) => !GENERIC_NODE_NAMES.has(normalized(node.formalName))
      && countryFacts.some((fact) => identityMatches(node.formalName, fact)))
    || (inferredCountryNode && inferredCountryNode.nodeId !== hierarchyRoot?.nodeId ? inferredCountryNode : null)
    || (["cover", "transport"].includes(purpose) && identityMatches(rootResolution?.node?.formalName, slot.location) ? rootResolution.node : null);
  const countryResolution = countryNode ? resolutionForNode(countryNode, "planned_country_scope", rootResolution?.facts, rootResolution?.mappingKey) : null;
  const parentNode = rootResolution?.node?.parentNodeId ? hierarchy?.byId?.get(rootResolution.node.parentNodeId) : null;
  const parentResolution = parentNode && !GENERIC_NODE_NAMES.has(normalized(parentNode.formalName))
    ? resolutionForNode(parentNode, "planned_parent_scope", rootResolution?.facts, rootResolution?.mappingKey)
    : null;
  const rootEntityType = resolutionEntityType(rootResolution);

  const hotelScopeBypass = ["configured_scope", "test_adapter_without_hierarchy"].includes(rootResolution?.reason);
  const requestedHotel = clean(slot.hotel || slot.hotelOfficialName || slot.hotelShortName || hotelEntityForSlot(slot)?.canonicalName);
  const hotelDirectoryConfirmation = hotelModule ? confirmHotelDirectory(slot, hierarchy) : null;
  const resolvedSpecificHotel = hotelModule ? Boolean(hotelDirectoryConfirmation?.resolution)
    : Boolean(rootResolution?.status === "resolved" && rootResolution.node && requestedHotel
      && identityMatches(rootResolution.node.formalName, requestedHotel));
  const hotelIdentityAnchors = unique([
    requestedHotel,
    ...(hotelEntityForSlot(slot) ? entityNames(hotelEntityForSlot(slot)) : []),
  ]);

  if (hotelModule && ["hotel_space", "hotel_experience"].includes(purpose) && (resolvedSpecificHotel || hotelScopeBypass)) {
    // Hotel cards search only inside the confirmed hotel directory. Broad
    // hotel-value queries make child-directory guessing unnecessary, and a
    // missing/empty hotel directory must fall through to the existing Web
    // source instead of searching other hotels at region/country level.
    const confirmedRoot = hotelDirectoryConfirmation?.resolution || rootResolution;
    addScope(scopes, confirmedRoot, "hotel_root", confirmedRoot, "entity_identity");
    refined.decision.reason = "hotel_module_locked_to_confirmed_hotel_root";
  } else if (hotelModule && ["hotel_space", "hotel_experience"].includes(purpose)) {
    refined.decision.reason = "hotel_module_specific_directory_unresolved";
  } else if (["hotel_space", "hotel_experience"].includes(purpose) && (resolvedSpecificHotel || hotelScopeBypass)) {
    const hotelRootCoversChild = refined.decision.entered && resolutionContains(rootResolution, refined.scopeResolution, hierarchy);
    if (!hotelRootCoversChild && refined.decision.entered) addScope(scopes, refined.scopeResolution, "hotel_child", rootResolution, "entity_identity");
    addScope(scopes, rootResolution, "hotel_root", rootResolution, "entity_identity");
    refined.decision.rootIncludesSelectedChild = hotelRootCoversChild;
  } else if (["hotel_space", "hotel_experience"].includes(purpose)) {
    const regionResolution = regionNode
      ? resolutionForNode(regionNode, "planned_hotel_region_fallback", rootResolution?.facts, rootResolution?.mappingKey)
      : null;
    const rootUsableAsFallback = rootResolution?.status === "resolved"
      && rootResolution.node
      && !GENERIC_NODE_NAMES.has(normalized(rootResolution.node.formalName));
    const startResolution = regionResolution || (rootUsableAsFallback ? rootResolution : countryResolution);
    const progressive = progressiveScopeResolutions(startResolution, countryResolution, hierarchy);
    progressive.forEach((resolution, index) => addScope(
      scopes,
      resolution,
      resolution.nodeIds[0] === countryResolution?.nodeIds?.[0] ? "hotel_country_fallback" : index === 0 ? "hotel_region_fallback" : "hotel_parent_fallback",
      resolution,
      "entity_identity",
      hotelIdentityAnchors,
    ));
    refined.decision.reason = scopes.length ? "specific_hotel_scope_unresolved_using_region_country" : "specific_hotel_scope_and_fallback_unresolved";
  } else if (purpose === "explicit_entity") {
    const entity = explicitNamedEntity(slot);
    const rootIsEntity = entity && entityNames(entity).some((name) => matchStrength(name, rootResolution?.node?.formalName) >= 100);
    const identityAnchors = entity ? entityNames(entity) : [namedEntityText(slot)];
    const startResolution = rootIsEntity ? rootResolution : (rootResolution?.status === "resolved" ? rootResolution : parentResolution);
    const progressive = progressiveScopeResolutions(startResolution, countryResolution, hierarchy);
    progressive.forEach((resolution, index) => addScope(
      scopes,
      resolution,
      index === 0 ? (rootIsEntity ? "entity" : "entity_scope_unresolved") : resolution.nodeIds[0] === countryResolution?.nodeIds?.[0] ? "entity_country_fallback" : "entity_parent_fallback",
      rootIsEntity ? rootResolution : resolution,
      "entity_identity",
      identityAnchors,
    ));
  } else if (["cover", "transport"].includes(purpose)) {
    addScope(scopes, countryResolution, "country", countryResolution, "country_context");
    if (!scopes.length) addScope(scopes, rootResolution, "country_scope_unresolved", rootResolution, "country_context");
  } else {
    // Ordinary experiences progress from the most specific usable place to
    // its parent region and finally the country. Hotel/restaurant/attraction
    // nodes that are merely context start from their parent instead.
    const contextualEntityRoot = ["hotel", "restaurant", "attraction"].includes(rootEntityType);
    const startResolution = contextualEntityRoot ? (parentResolution || countryResolution) : rootResolution;
    const progressive = progressiveScopeResolutions(startResolution, countryResolution, hierarchy);
    progressive.forEach((resolution, index) => addScope(
      scopes,
      resolution,
      resolution.nodeIds[0] === countryResolution?.nodeIds?.[0] ? "country" : index === 0 ? "specific_location" : "parent_location",
      resolution,
      "country_context",
    ));
    if (!scopes.length) addScope(scopes, rootResolution, "country_scope_unresolved", rootResolution, "country_context");
  }
  if (!scopes.length && rootResolution && !["hotel_space", "hotel_experience"].includes(purpose)) scopes.push({ role: "configured_or_unresolved", resolution: rootResolution, evidenceResolution: rootResolution });
  const fastPath = explicitEntityRoute(slot);
  if (fastPath.matched) {
    // Only a verified entity node may seed this route. A regional resolution
    // is not evidence that the named venue exists in the library.
    const targetEntity = ["hotel", "hotel_experience"].includes(fastPath.entityType) ? hotelEntityForSlot(slot) : explicitNamedEntity(slot);
    const directoryMatches = (node) => fastPath.identityAnchors.some((anchor) => normalized(anchor) === normalized(node.formalName))
      || Boolean(targetEntity && stronglyReferencedEntities(node.formalName).some((entity) => entity.id === targetEntity.id));
    const matches = (hierarchy?.records || []).filter(directoryMatches);
    const rootMatches = rootResolution?.node && directoryMatches(rootResolution.node);
    const exact = hotelModule ? hotelDirectoryConfirmation?.resolution : rootMatches ? rootResolution : matches.length === 1
      ? resolutionForNode(matches[0], "explicit_entity_directory", rootResolution?.facts, rootResolution?.mappingKey) : null;
    scopes.length = 0;
    const role = ["hotel", "hotel_experience"].includes(fastPath.entityType) ? "hotel_root" : "entity";
    if (fastPath.identityKnown && exact) addScope(scopes, exact, role, exact, "entity_identity", fastPath.identityAnchors);
    else if (fastPath.identityKnown && rootResolution?.reason === "test_adapter_without_hierarchy") addScope(scopes, rootResolution, role, rootResolution, "entity_identity", fastPath.identityAnchors);
    fastPath.hotelDirectoryConfirmation = hotelDirectoryConfirmation;
    fastPath.knowledgeStopReason = !fastPath.identityKnown ? "identity_unknown" : !scopes.length
      ? "entity_directory_missing" : null;
  }
  return {
    purpose,
    scopes,
    explicitEntityFastPath: fastPath,
    blockedReason: fastPath.matched && !scopes.length ? fastPath.knowledgeStopReason : hotelModule && ["hotel_space", "hotel_experience"].includes(purpose) && !scopes.length
      ? "hotel_directory_unresolved"
      : ["hotel_space", "hotel_experience"].includes(purpose) && !scopes.length ? "hotel_scope_and_fallback_unresolved" : null,
    stopBoundary: fastPath.matched ? (["hotel", "hotel_experience"].includes(fastPath.entityType) ? "hotel_root" : "entity_identity") : hotelModule && ["hotel_space", "hotel_experience"].includes(purpose) ? "hotel_root"
      : ["hotel_space", "hotel_experience"].includes(purpose) ? (resolvedSpecificHotel || hotelScopeBypass ? "hotel_root" : "country")
      : purpose === "explicit_entity" ? "entity_identity"
        : "country",
    strategy: fastPath.matched ? "explicit_entity_fast_path" : "preplanned_progressive_scope_single_batch",
    childScopeDecision: refined.decision,
  };
}

export function explicitEntityRoute(slot = {}) {
  const proof = slot.minimumVisualProof || {};
  const hotelModule = moduleKind(slot) === "hotel";
  const identityIsCore = slot.exactIdentityRequired;
  // Routing consumes explicit semantic constraints only. Names, aliases,
  // purpose classifiers and locationRole cannot establish Core identity.
  const entityName = clean(slot.queryCore?.identity);
  const matched = Boolean(entityName) && identityIsCore === true;
  // Existing registry is used only after the trigger, for directory aliases
  // and report metadata; it never determines whether identity is required.
  const targetEntity = matched ? TRAVEL_ENTITY_REGISTRY.find((entity) => entityNames(entity).some((anchor) => normalized(anchor) === normalized(entityName))) : null;
  const entityType = hotelModule ? "hotel" : slot.entityType || proof.entityType || (targetEntity?.entityType === "hotel" ? "hotel_experience" : targetEntity?.entityType) || "entity";
  return { matched, entityType: matched ? entityType : null, entityName, identityKnown: Boolean(entityName),
    identityAnchors: unique([entityName, ...(slot.identityAnchors || proof.identityAnchors || []), ...(targetEntity ? entityNames(targetEntity) : [])]),
    routingReason: matched ? "explicit_core_identity" : identityIsCore === false ? "identity_not_core" : identityIsCore === true ? "target_identity_missing" : "core_identity_constraint_missing" };
}

function queryPlanForSlot(slot = {}, scopeResolution = null) {
  const kind = moduleKind(slot);
  const purpose = classifyKnowledgeImagePurpose(slot);
  const subject = clean(slot.primaryVisualSubject || slot.subject || slot.activity);
  const activity = clean(slot.activity);
  const location = clean(slot.location || slot.region || slot.destination || slot.country);
  const sourceText = querySourceValues(slot).join(" ");
  const searchable = normalized(sourceText);
  const explicitEntity = explicitNamedEntity(slot);
  const namedSubject = namedEntityText(slot);
  const hasRiverCrossing = /(rivercrossing|渡河|天国之渡)/.test(searchable);
  const hasMigration = /(wildebeest|migration|角马|迁徙)/.test(searchable);
  const hasElephants = /(elephantherd|elephants|象群|大象)/.test(searchable);
  const hasMountain = /(kilimanjaro|snowmountain|snowypeak|雪山|雪峰|乞力马扎罗)/.test(searchable);
  const hasStarBed = /(starbed|sleepout|outdoorbed|星空床)/.test(searchable);
  const hasSunrise = /(sunrise|dawn|日出|黎明|清晨)/.test(searchable);
  const hasSunset = /(sunset|sundown|日落|落日|夕阳|黄昏)/.test(searchable);
  const hasThermalNight = /(thermal|热成像|红外)/.test(searchable);
  const hasNocturnalAnimals = /(nocturnal|nightanimals|夜行动物)/.test(searchable);
  const hasGuide = /(armedguide|ranger|guide|持枪|向导|护林员)/.test(searchable);
  const hasWildebeest = /(wildebeest|角马)/.test(searchable);
  const hasZebra = /(zebra|斑马)/.test(searchable);
  const hasGiraffe = /(giraffe|长颈鹿)/.test(searchable);
  const hasWaterbuck = /(waterbuck|水羚)/.test(searchable);
  const hasHippo = /(hippo|河马)/.test(searchable);
  const hasWetland = /(wetland|marsh|湿地|沼泽)/.test(searchable);
  const hasBoat = /(boat|cruise|游船|乘船|船上)/.test(searchable);
  const hasFishEagle = /(fish eagle|鱼鹰|海雕)/.test(searchable);
  const hasFishingDive = /(俯冲|捕鱼|抓鱼|捕食|div(?:e|ing)|fish(?:ing)?|hunt(?:ing)?)/.test(searchable);
  const hasRoaming = /(roaming|free roaming|漫步|自由活动)/.test(searchable);
  const hasCycling = /(cycling|bike ride|bicycle|骑行|骑车|自行车)/.test(searchable);
  const hasGeothermal = /(geothermal|steam|地热|蒸汽)/.test(searchable);
  const hasVolcanicCliffs = /(volcaniccliff|volcanicgorge|火山峭壁|火山峡谷)/.test(searchable);
  const hasBalloon = /(hotairballoon|balloon|热气球)/.test(searchable);
  const hasWalkingSafari = /(walkingsafari|徒步游猎|徒步safari|步行游猎|步行safari|bushwalk|guidedwalk|丛林徒步)/.test(searchable);
  const hasNightSafari = /(nightsafari|nightgamedrive|夜间.*游猎|夜巡|thermal.*night|夜间热成像)/.test(searchable);
  const hasLeopard = /(leopard|花豹|豹子|豹类)/.test(searchable);
  const hasCheetah = /(cheetah|猎豹|豹子|豹类|花豹)/.test(searchable);
  const hasLion = /(lion|狮群|狮子)/.test(searchable);
  const hasHyena = /(hyena|鬣狗)/.test(searchable);
  const hasTracking = /(tracking|track|sighting|追踪|追寻|寻踪)/.test(searchable);
  const hasSpecificVisualAction = /(观赏|追踪|觅食|上岸|互动|俯冲|捕鱼|徒步|行走|喂食|feeding|foraging|comingashore|tracking|walking)/.test(searchable);
  const chineseFirst = (zh = [], en = []) => unique([...zh, ...en]);

  if (kind === "cover") {
    if (hasRiverCrossing && hasMigration) {
      if (hasWildebeest && hasZebra) return chineseFirst(["角马斑马渡河", "马拉河角马斑马渡河"], ["wildebeest zebra river crossing", "Great Migration river crossing"]);
      return chineseFirst(["角马渡河", "马拉河角马大迁徙"], ["wildebeest river crossing", "Great Migration river crossing"]);
    }
    if (hasBalloon) return hasSunrise
      ? chineseFirst(["热气球草原日出", "热气球俯瞰草原"], ["hot air balloon sunrise", "hot air balloon over savanna"])
      : chineseFirst(["热气球俯瞰草原"], ["hot air balloon over savanna", "balloon safari"]);
    if (hasElephants && hasMountain) return chineseFirst(["大象乞力马扎罗雪山", "象群雪山"], ["elephants Kilimanjaro", "elephant herd snow mountain"]);
    if (hasMigration) return chineseFirst(["角马斑马大迁徙", "角马大迁徙"], ["wildebeest zebra Great Migration", "wildebeest migration"]);
    if (hasElephants) return chineseFirst(["草原象群", "大象群"], ["elephant herd safari", "elephants savanna"]);
    if (/(bigfive|非洲五霸|五霸)/.test(searchable)) return chineseFirst(["非洲五霸游猎"], ["big five safari", "lion leopard cheetah safari"]);
    if (hasLeopard || hasCheetah || hasLion) return animalQueryPlan({ hasLeopard, hasCheetah, hasLion, hasTracking });
    if (/(lightaircraft|bushplane|草原飞机|轻型飞机)/.test(searchable)) return chineseFirst(["草原小型飞机"], ["bush plane", "light safari aircraft"]);
    const scopeName = clean(scopeResolution?.node?.formalName || location);
    const scopeEntity = TRAVEL_ENTITY_REGISTRY.find((entity) => ["place", "park", "conservancy"].includes(entity.entityType)
      && entityNames(entity).some((name) => identityMatches(name, scopeName)));
    const queryName = scopeEntity?.region || scopeEntity?.canonicalName || scopeName;
    return unique([`${queryName}野生动物草原`, `${queryName} wildlife safari`, `${queryName} savanna wildlife`]);
  }
  if (namedEntityIsContextualExperience(slot) && /(giraffe|长颈鹿)/.test(searchable)) {
    const chineseName = clean(explicitEntity?.displayNames?.["zh-CN"] || explicitEntity?.aliases?.find((name) => /[\u3400-\u9fff]/.test(name)) || namedSubject);
    return chineseFirst([`${chineseName}游客与长颈鹿互动`, "游客喂长颈鹿", "长颈鹿与游客互动"], [`${namedSubject} giraffe interaction`, "feeding giraffe visitor"]);
  }
  if (namedEntityIsContextualExperience(slot) && hasWetland && hasElephants) {
    return chineseFirst(["湿地象群", "山顶俯瞰湿地象群"], ["elephants in wetlands", "wetland elephants from viewpoint"]);
  }
  if (namedEntityIsContextualExperience(slot) && hasWetland) {
    return chineseFirst(["山顶俯瞰湿地", "湿地俯瞰"], ["wetlands from viewpoint", "wetland panorama"]);
  }
  if (namedSubject && purpose === "explicit_entity") {
    const entityType = explicitEntity?.entityType
      || (kind === "dining" || /(restaurant|dining|餐厅|餐饮|用餐|晚餐|宴)/.test(searchable) ? "restaurant" : "attraction");
    const chineseName = clean(explicitEntity?.displayNames?.["zh-CN"] || explicitEntity?.aliases?.find((name) => /[\u3400-\u9fff]/.test(name)) || namedSubject);
    if (/(giraffe|长颈鹿)/.test(searchable)) return chineseFirst([`${chineseName}游客喂长颈鹿`, "长颈鹿与游客互动"], [`${namedSubject} giraffe interaction`, "feeding giraffe visitor"]);
    if (/(viewpoint|observationhill|观景台|观景山|俯瞰)/.test(searchable)) return chineseFirst([`${chineseName}观景全景`, `${chineseName}俯瞰风景`], [`${namedSubject} panoramic viewpoint`, `${namedSubject} scenic view`]);
    return entityType === "restaurant"
      ? chineseFirst([`${chineseName}餐厅用餐`, `${chineseName}餐厅环境`], [`${namedSubject} restaurant dining`, `${namedSubject} dining interior`])
      : chineseFirst([`${chineseName}参观体验`, chineseName], [`${namedSubject} visitor experience`, namedSubject]);
  }
  if (purpose === "hotel_space" && semanticCategory(slot) === "accommodation") return hotelSpaceQueryGroups(slot).flatMap((group) => group.queries);
  if (/(viewpoint|scenicviewpoint|observationdeck|观景台|观景点)/.test(searchable) && !hasSpecificVisualAction) {
    if (hasMountain && hasSunset) return chineseFirst(["乞力马扎罗日落观景台"], ["Kilimanjaro sunset viewpoint", "sunset viewpoint Kilimanjaro"]);
    if (hasMountain) return chineseFirst(["乞力马扎罗雪山观景台"], ["Kilimanjaro scenic viewpoint", "observation deck Kilimanjaro"]);
    if (hasSunset) return chineseFirst(["日落观景台"], ["sunset scenic viewpoint", "sunset observation deck"]);
    return chineseFirst(["全景观景台"], ["scenic viewpoint", "panoramic observation deck"]);
  }
  if (/((maasai|masai).*(welcome|ceremony)|(welcome|ceremony).*(maasai|masai)|马赛.*(欢迎|仪式)|马萨伊.*(欢迎|仪式))/.test(searchable)) return chineseFirst(["马赛欢迎仪式", "马赛文化欢迎"], ["Maasai welcome ceremony", "Maasai cultural welcome"]);
  if (hasWalkingSafari) {
    return hasGuide
      ? chineseFirst(["持枪向导步行游猎", "向导带队丛林徒步"], ["armed guide walking safari", "guided bush walk ranger"])
      : chineseFirst(["步行游猎", "丛林徒步"], ["walking safari", "guided bush walk"]);
  }
  if (hasBoat && hasHippo) return chineseFirst(["游船追踪河马", "游船观赏河马"], ["boat safari hippos", "hippo boat ride"]);
  if (hasFishEagle && hasFishingDive) return chineseFirst(["鱼鹰俯冲捕鱼", "鱼鹰捕鱼"], ["fish eagle diving for fish", "African fish eagle fishing"]);
  if (hasGiraffe && hasWaterbuck) return chineseFirst(["长颈鹿与水羚", "长颈鹿", "水羚"], ["giraffe waterbuck"]);
  if (hasGiraffe && hasZebra && !hasHippo && !hasWaterbuck) return hasRoaming
    ? chineseFirst(["斑马与长颈鹿自由漫步", "斑马自由漫步", "长颈鹿自由漫步"], ["zebra giraffe roaming"])
    : chineseFirst(["斑马与长颈鹿", "斑马", "长颈鹿"], ["zebra giraffe"]);
  if (hasCycling && hasGeothermal) return chineseFirst(["地热蒸汽间骑行", "地热峡谷骑行"], ["cycling among geothermal steam", "geothermal cycling"]);
  if (hasVolcanicCliffs) return chineseFirst(["火山峭壁", "火山峡谷峭壁"], ["volcanic cliffs", "volcanic gorge cliffs"]);
  if (hasBalloon) return hasSunrise
    ? chineseFirst(["热气球草原日出", "热气球俯瞰迁徙兽群"], ["hot air balloon sunrise", "hot air balloon over savanna"])
    : chineseFirst(["热气球俯瞰草原"], ["hot air balloon safari", "balloon flight over savanna"]);
  if (hasNightSafari) {
    if (hasThermalNight) {
      const nightSubjects = unique([
        "热成像夜间游猎",
        hasLeopard && "夜间追踪花豹",
        hasCheetah && "夜间追踪猎豹",
        hasHyena && "夜间追踪鬣狗",
        !hasLeopard && !hasCheetah && !hasHyena && "夜间追踪夜行动物",
      ]);
      return chineseFirst(nightSubjects, ["thermal imaging night safari", "night safari nocturnal animals"]);
    }
    return chineseFirst(["夜间游猎", "夜间驱车游猎"], ["night safari", "night game drive"]);
  }
  if (hasStarBed) return chineseFirst(["星空床户外住宿", "户外星空床"], ["star bed sleep out", "outdoor sleep out bed"]);
  if (hasRiverCrossing && hasMigration) {
    if (hasWildebeest && hasZebra) return chineseFirst(["角马斑马渡河", "马拉河角马斑马渡河"], ["wildebeest zebra river crossing", "Great Migration river crossing"]);
    return chineseFirst(["角马渡河", "马拉河角马大迁徙"], ["wildebeest river crossing", "Great Migration river crossing"]);
  }
  if (hasMigration) return chineseFirst(["角马斑马大迁徙", "角马大迁徙"], ["wildebeest zebra Great Migration", "wildebeest migration"]);
  if (hasElephants && hasMountain) return chineseFirst(["大象乞力马扎罗雪山", "象群雪山"], ["elephants Kilimanjaro", "elephant herd snow mountain"]);
  if (hasWetland && hasElephants) return chineseFirst(["湿地象群", "俯瞰湿地象群"], ["elephants in wetlands", "wetland elephant herd"]);
  if (hasElephants) return chineseFirst(["草原象群", "大象群"], ["elephant herd safari", "elephants savanna"]);
  if (/(bigfive|非洲五霸|五霸)/.test(searchable)) return chineseFirst(["非洲五霸游猎"], ["big five safari", "lion leopard cheetah safari"]);
  if (hasLeopard || hasCheetah || hasLion) return animalQueryPlan({ hasLeopard, hasCheetah, hasLion, hasTracking });
  if (/(bushbreakfast|丛林早餐|草原早餐)/.test(searchable)) return chineseFirst(["草原丛林早餐", "草原户外早餐"], ["bush breakfast", "outdoor breakfast savanna"]);
  if (/(sundowner|日落酒会|落日酒会)/.test(searchable)) return chineseFirst(["草原日落酒会", "户外落日饮品"], ["sundowner safari", "sunset drinks outdoors"]);
  if (/(winecellar|winetasting|酒窖|品酒)/.test(searchable)) return chineseFirst(["私人酒窖品酒", "酒窖品酒体验"], ["wine cellar tasting", "private wine tasting"]);
  if (/(starlitdinner|starlightdinner|星空晚宴)/.test(searchable)) return chineseFirst(["户外星空晚宴", "星空下用餐"], ["starlit outdoor dinner", "dinner under the stars"]);
  if (/(beadwork|beading|beadmaking|串珠|珠饰|珠串|串珠制作)/.test(searchable)) return chineseFirst(["马赛串珠制作课程", "马赛珠饰手作"], ["Maasai beadwork workshop", "Maasai beadwork making"]);
  if (/(pool|泳池)/.test(searchable)) return ["pool", "swimming pool", "pool deck"];
  if (/(suite|bedroom|roominterior|guestroom|客房|套房|卧室|房间)/.test(searchable)) return ["suite", "bedroom", "room interior", "guest room"];
  if (/(lounge|guestarea|mainarea|公区|休息区)/.test(searchable)) return ["main areas", "lounge", "guest area", "deck"];
  if (kind === "hotel") {
    const directoryName = clean(scopeResolution?.node?.formalName).toLocaleLowerCase("en");
    const directoryQuery = /\b(room|suite|villa|tent|lounge|deck)\b/.exec(directoryName)?.[1] || "";
    return unique([directoryQuery, "exterior", "suite", "pool", "main areas"]);
  }
  if (kind === "dining") return unique([subject, activity].map(compactVisualQuery).filter(Boolean));
  if (/(maasai|masai)(culture|cultural|people|village|boma|ceremony)|(culture|cultural|people|village|boma|ceremony)(maasai|masai)|马赛(文化|部落|村落|村|人|仪式)|马萨伊(文化|部落|村落|村|人|仪式)/.test(searchable)) return ["maasai village", "maasai culture", "boma"];
  if (/(anti-poaching|antipoaching|反偷猎|巡护)/.test(searchable)) return ["anti-poaching", "ranger patrol", "observation post"];
  if (/(museum|博物馆)/.test(searchable)) return ["museum exterior", "museum interior", "museum"];
  if (/(airport|机场)/.test(searchable)) return ["airport departure", "airport exterior", "terminal"];
  if (/(lightaircraft|bushplane|草原飞机|轻型飞机)/.test(searchable)) return chineseFirst(["草原小型飞机", "轻型飞机起降"], ["bush plane", "light safari aircraft"]);
  if (/(transfervehicle|cartransfer|businessvehicle|接送车辆|商务用车)/.test(searchable)) return chineseFirst(["商务接送车", "机场酒店接送车"], ["business transfer vehicle", "airport hotel transfer vehicle"]);
  if (/(safarivehicle|gamedrive|游猎车|越野车|开顶)/.test(searchable)) return chineseFirst(["四驱开顶游猎车", "开顶越野车"], ["open-top safari vehicle", "4x4 safari vehicle"]);
  if (hasBoat) return chineseFirst(["游船", "观光游船"], ["boat ride", "safari boat"]);
  const compactSubject = compactVisualQuery(subject);
  const compactActivity = compactVisualQuery(activity);
  const combined = compactSubject && compactActivity
    && !normalized(compactSubject).includes(normalized(compactActivity))
    && !normalized(compactActivity).includes(normalized(compactSubject))
    ? `${compactSubject} ${compactActivity}`
    : "";
  const shortSeeds = unique(combined ? [combined, compactSubject] : [compactSubject, compactActivity]).filter(Boolean);
  if (purpose === "hotel_space") return hotelSpaceQueryGroups(slot).flatMap((group) => group.queries);
  return shortSeeds;
}

const QUERY_DUTY_CLAUSE = /(?:^|\s)(?:用于|用来|旨在)?(?:证明(?:当天|当日|本日|该日|此日)|补充(?:当天|当日|本日|该日|此日|体验)|区别于其他图片|与其他图片(?:形成)?(?:区别|差异)|保留(?:自费|可选|待确认)?状态|体现(?:当天|当日|本日|该日|此日)?核心体验|(?:当天|当日)最具视觉价值|不得暗示已包含)/i;
const MEANINGLESS_QUERY = /^(?:landscape|experience|view|activity|photo|photos|image|images|scenery|场景|画面|体验|活动|风景)$/i;
const QUERY_PARTICLES = new Set(["的", "地", "得", "与", "和", "及", "在", "于", "从", "向", "由", "随", "旁", "边", "中", "内", "间", "下"]);
const QUERY_WRAPPERS = new Set(["场景", "画面", "体验", "活动", "照片", "图片", "真实", "独特", "核心"]);
const QUERY_FUNCTION_WORDS = new Set(["带领", "进行", "识别", "观察", "展示", "表现", "体验", "看见", "看到", "欣赏", "探访", "参观"]);
const querySegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh-CN", { granularity: "word" }) : null;

function cleanKnowledgeQuery(value) {
  const clauses = clean(value)
    .replace(/[（(][^）)]*(?:自费|可选|待确认)[^）)]*[）)]/g, "")
    .split(/[|｜;；。]+/)
    .map((clause) => clean(clause)
      .replace(/(?:与前一天|与后一天|区别于其他图片|与其他图片(?:形成)?(?:区别|差异)|DAY\s*\d+).*/gi, "")
      .trim())
    .filter((clause) => clause && !QUERY_DUTY_CLAUSE.test(clause));
  const query = clean(clauses.join(" "))
    .replace(/^[,，:：\-—–]+|[,，:：\-—–]+$/g, "")
    .trim();
  return query && !MEANINGLESS_QUERY.test(query) ? query : "";
}

function rawPlannerQueries(value) {
  const values = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return values.flatMap((item) => clean(typeof item === "string" ? item : item?.query).split(/[|｜;；\n]+/)).map(clean).filter(Boolean);
}

function queryWords(value) {
  const textValue = cleanKnowledgeQuery(value);
  if (!textValue) return [];
  if (!querySegmenter) return textValue.split(/\s+/).filter(Boolean);
  const segmented = [...querySegmenter.segment(textValue)].filter((item) => item.isWordLike).map((item) => item.segment);
  const merged = [];
  let singleHanRun = "";
  const flush = () => { if (singleHanRun) merged.push(singleHanRun); singleHanRun = ""; };
  for (const token of segmented) {
    if (/^[\u3400-\u9fff]$/.test(token) && !QUERY_PARTICLES.has(token)) singleHanRun += token;
    else { flush(); merged.push(token); }
  }
  flush();
  return merged.filter((token) => !QUERY_PARTICLES.has(token) && !QUERY_WRAPPERS.has(token));
}

function isEffectiveShortQuery(value) {
  const query = cleanKnowledgeQuery(value);
  if (!query || MEANINGLESS_QUERY.test(query) || QUERY_DUTY_CLAUSE.test(query)) return false;
  const entityNamesInQuery = TRAVEL_ENTITY_REGISTRY
    .flatMap(entityNames)
    .filter((name) => normalized(query).includes(normalized(name)))
    .sort((left, right) => right.length - left.length);
  let identityRemainder = query;
  for (const name of entityNamesInQuery) identityRemainder = identityRemainder.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  identityRemainder = cleanKnowledgeQuery(identityRemainder);
  if (identityRemainder !== query
    && query.length <= 110
    && query.split(/\s+/).filter(Boolean).length <= 12
    && (!identityRemainder || ([...identityRemainder.replace(/\s+/g, "")].length <= 20 && queryWords(identityRemainder).length <= 6))) return true;
  const hasChinese = /[\u3400-\u9fff]/.test(query);
  const hasLatin = /[A-Za-z]/.test(query);
  // A named entity may legitimately be Latin while the searchable subject is
  // Chinese (for example "The Carnivore餐厅"). Keep that compact form, but
  // reject sentence-length bilingual descriptions.
  if (hasChinese && hasLatin) {
    if ([...query.replace(/\s+/g, "")].length <= 28 && queryWords(query).length <= 7) return true;
    return false;
  }
  if (hasChinese) return [...query.replace(/\s+/g, "")].length <= 20 && queryWords(query).length <= 6;
  // Planner often needs a compact English phrase with subject, action and one
  // visual qualifier. Eight to ten words are still a practical search query;
  // rejecting them here silently drops otherwise valid Planner wording.
  return query.split(/\s+/).filter(Boolean).length <= 10 && query.length <= 96;
}

export function validatePlannerSearchIntent(value) {
  const errors = [];
  if (!Array.isArray(value)) errors.push("必须使用数组，不能返回单个字符串");
  const rawQueries = rawPlannerQueries(value);
  const cleaned = unique(rawQueries.map(cleanKnowledgeQuery).filter(Boolean));
  if (cleaned.length < 2 || cleaned.length > 4) errors.push("去重后必须保留2—4条Query");
  for (const query of cleaned) {
    if (QUERY_DUTY_CLAUSE.test(query)) errors.push(`包含图片职责说明：${query}`);
    else if (!isEffectiveShortQuery(query)) errors.push(`不是简短的单语搜索表达：${query}`);
  }
  return { valid: errors.length === 0, queries: cleaned, errors: unique(errors) };
}

function compactVisualQuery(value) {
  const firstClause = cleanKnowledgeQuery(value).split(/[,，:：→]/)[0].trim();
  if (!firstClause) return "";
  if (/[\u3400-\u9fff]/.test(firstClause)) return firstClause;
  return firstClause.split(/\s+/).slice(0, 7).join(" ");
}

function locationQueryParts(slot = {}) {
  return unique([slot.location, slot.region, slot.destination, slot.country, slot.visualContext?.geographicLocation]
    .flatMap((value) => clean(value).split(/[\/→>·]+/))
    .map((value) => value.replace(/^(?:抵达|探访|游览|参观|前往|探索)\s*/i, "").trim()))
    .sort((left, right) => right.length - left.length);
}

function safeScopePhrase(value) {
  const phrase = clean(value);
  if (!phrase) return false;
  const hanCount = (phrase.match(/[\u3400-\u9fff]/g) || []).length;
  return hanCount >= 3 || (hanCount === 0 && normalized(phrase).length >= 4) || (hanCount > 0 && normalized(phrase).length >= 4);
}

function scopeLocationPhrases(slot = {}, scopeResolution = null) {
  const direct = unique([
    ...locationQueryParts(slot),
    ...(scopeResolution?.node?.pathSegments || []),
  ]).filter((value) => value && !GENERIC_NODE_NAMES.has(normalized(value)));
  const aliases = direct.flatMap((location) => TRAVEL_ENTITY_REGISTRY
    .filter((entity) => entityNames(entity).some((name) => identityMatches(name, location)))
    .flatMap(entityNames));
  return unique([...direct, ...aliases]).filter(safeScopePhrase).sort((left, right) => right.length - left.length);
}

function removeScopePhrase(value, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startsLatin = /^[A-Za-z0-9]/.test(phrase);
  const endsLatin = /[A-Za-z0-9]$/.test(phrase);
  const pattern = new RegExp(`${startsLatin ? "(?<![\\p{L}\\p{N}])" : ""}${escaped}${endsLatin ? "(?![\\p{L}\\p{N}])" : ""}`, "giu");
  let removed = false;
  const result = value.replace(pattern, () => { removed = true; return " "; });
  return { result, removed };
}

function queryWithoutLocationPrefix(value, slot = {}) {
  let result = cleanKnowledgeQuery(value);
  for (const location of locationQueryParts(slot)) {
    const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`^(?:在|位于|前往|探访|游览|参观|抵达)?\\s*${escaped}(?:的|内|中|上|下|间|湖畔|山顶)?[\\s·:：,，\\-—–]*`, "iu"), "");
  }
  return cleanKnowledgeQuery(result);
}

function queryScopeOnlyPhrases(slot = {}, rawCore = {}, scopeResolution = null) {
  return scopeLocationPhrases(slot, scopeResolution);
}

export function cleanupPlannerQueryScope(value, slot = {}, scopeResolution = null) {
  const originalQuery = clean(value);
  if (slot.locationRole === "visual_identity") return { originalQuery, scopeCleanup: false, removedScopeLocations: [], finalQuery: originalQuery };
  let result = cleanKnowledgeQuery(value);
  const removedScopeLocations = [];
  for (const phrase of queryScopeOnlyPhrases(slot, {}, scopeResolution)) {
    const removal = removeScopePhrase(result, phrase);
    result = removal.result;
    if (removal.removed) removedScopeLocations.push(phrase);
  }
  const finalQuery = cleanKnowledgeQuery(result)
    .replace(/^[的与和及、:：\-—–]+|[的与和及、:：\-—–]+$/g, "")
    .trim();
  return { originalQuery, scopeCleanup: removedScopeLocations.length > 0, removedScopeLocations: unique(removedScopeLocations), finalQuery };
}

function queryWithoutScopeContext(value, slot = {}, rawCore = {}, scopeResolution = null) {
  return cleanupPlannerQueryScope(value, slot, scopeResolution).finalQuery;
}

const QUERY_TIME_CONTEXT = /(?:清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜间|夜晚|凌晨|黎明)(?:时|期间|时分|时刻|的)?/g;
const QUERY_STATUS_CONTEXT = /(?:自费|可选|待确认|需预约|另行付费)/g;
const QUERY_TIME_CONTEXT_EN = /\b(?:early\s+morning|dawn|morning|noon|afternoon|dusk|evening|nighttime|night)\b/gi;
const QUERY_STATUS_CONTEXT_EN = /\b(?:optional|self[- ]paid|at\s+extra\s+cost|reservation\s+required|to\s+be\s+confirmed)\b/gi;

function stripQueryContextModifiers(value, protectedValues = []) {
  const protectedText = normalized(protectedValues.join(" "));
  const keepProtectedTime = (match) => protectedText.includes(normalized(match)) ? match : " ";
  return cleanKnowledgeQuery(cleanKnowledgeQuery(value)
    .replace(QUERY_STATUS_CONTEXT, " ")
    .replace(QUERY_STATUS_CONTEXT_EN, " ")
    .replace(QUERY_TIME_CONTEXT, keepProtectedTime)
    .replace(QUERY_TIME_CONTEXT_EN, keepProtectedTime)
    .replace(/^[\s·:：,，\-—–]+|[\s·:：,，\-—–]+$/g, " "));
}

function semanticallyDistinctCoreParts(parts = []) {
  const cleaned = unique(parts.map(cleanKnowledgeQuery).filter(Boolean));
  return cleaned.filter((part, index) => {
    const partKey = normalized(part);
    return !cleaned.some((other, otherIndex) => otherIndex !== index
      && normalized(other).length > partKey.length
      && normalized(other).includes(partKey));
  });
}

function collapseRepeatedCoreSuffixes(value, core = {}) {
  let result = cleanKnowledgeQuery(value);
  const parts = unique([core.identity, core.subject, core.action, core.identityEn, core.subjectEn, core.actionEn].map(cleanKnowledgeQuery).filter(Boolean));
  for (const part of parts.sort((left, right) => right.length - left.length)) {
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = new RegExp(`[\\s·:：,，\\-—–]+${escaped}$`, "iu");
    const withoutSuffix = cleanKnowledgeQuery(result.replace(suffix, ""));
    if (withoutSuffix !== result && normalized(withoutSuffix).includes(normalized(part))) result = withoutSuffix;
  }
  return result;
}

function plannerQueryCore(slot = {}) {
  const raw = slot.queryCore && typeof slot.queryCore === "object" ? slot.queryCore : {};
  return {
    subject: clean(raw.subject),
    action: clean(raw.action),
    identity: clean(raw.identity),
    subjectEn: clean(raw.subjectEn),
    actionEn: clean(raw.actionEn),
    identityEn: clean(raw.identityEn),
  };
}

function effectivePlannerQueryCore(slot = {}, rawCore = plannerQueryCore(slot), scopeResolution = null) {
  const locationRole = slot.locationRole === "visual_identity" ? "visual_identity" : "scope_only";
  // Identity may be the experience itself (for example night game drive,
  // walking safari, star bed or outdoor shower), not a geographic scope.
  // Preserve its time/experience wording when a genuinely invalid Planner
  // query has to fall back to queryCore.
  const isVisualIdentity = (value) => {
    const withoutScope = locationRole === "scope_only"
      ? queryWithoutScopeContext(value, slot, rawCore, scopeResolution)
      : cleanKnowledgeQuery(value);
    return Boolean(stripQueryContextModifiers(withoutScope));
  };
  const protectedVisualParts = [
    rawCore.subject,
    rawCore.action,
    ...(isVisualIdentity(rawCore.identity) ? [rawCore.identity] : []),
    rawCore.subjectEn,
    rawCore.actionEn,
    ...(isVisualIdentity(rawCore.identityEn) ? [rawCore.identityEn] : []),
  ];
  const cleanPart = (value) => {
    const withoutScope = locationRole === "scope_only"
      ? queryWithoutScopeContext(value, slot, rawCore, scopeResolution)
      : cleanKnowledgeQuery(value);
    return stripQueryContextModifiers(withoutScope, protectedVisualParts);
  };
  return {
    subject: cleanPart(rawCore.subject),
    action: cleanKnowledgeQuery(rawCore.action),
    identity: cleanPart(rawCore.identity),
    subjectEn: cleanPart(rawCore.subjectEn),
    actionEn: cleanKnowledgeQuery(rawCore.actionEn),
    identityEn: cleanPart(rawCore.identityEn),
  };
}

function plannerSearchEntries(slot = {}, rawCore = plannerQueryCore(slot), core = rawCore) {
  const entries = [];
  const seen = new Set();
  const unifiedQueries = rawPlannerQueries([
    slot.fidelityQuery,
    ...(Array.isArray(slot.alternateQueries) ? slot.alternateQueries : []),
  ]);
  const sourceQueries = unifiedQueries.length ? unifiedQueries : rawPlannerQueries(slot.searchIntent);
  for (const [plannerIndex, rawValue] of sourceQueries.entries()) {
    const query = clean(rawValue);
    const cleaned = cleanKnowledgeQuery(query);
    const scopeCleanup = cleanupPlannerQueryScope(query, slot, null);
    const finalQuery = scopeCleanup.finalQuery;
    // Planner owns the search wording. The only permitted wording change here
    // is deterministic removal of the actual scope location and its aliases.
    if (!query
      || cleaned !== query
      || !finalQuery
      || seen.has(normalized(finalQuery))
      || !isEffectiveShortQuery(finalQuery)) continue;
    seen.add(normalized(finalQuery));
    entries.push({
      query: finalQuery,
      plannerIndex,
      source: "planner",
      originalQuery: query,
      scopeCleanup: scopeCleanup.scopeCleanup,
      removedScopeLocations: scopeCleanup.removedScopeLocations,
      finalQuery,
    });
  }
  return entries;
}

function queryCoreConfigured(core = {}) {
  return Boolean(core.subject || core.action || core.identity || core.subjectEn || core.actionEn || core.identityEn);
}

function composeCoreQuery({ identity = "", subject = "", action = "" } = {}) {
  const parts = semanticallyDistinctCoreParts([identity, subject, action]);
  const chineseOnly = parts.length > 0 && parts.every((part) => /^[\u3400-\u9fff]+$/.test(part));
  return cleanKnowledgeQuery(parts.join(chineseOnly ? "" : " "));
}

function repairedCoreQueries(core = {}) {
  return unique([
    composeCoreQuery(core),
    composeCoreQuery({ identity: core.identityEn, subject: core.subjectEn, action: core.actionEn }),
    cleanKnowledgeQuery(core.subject),
    cleanKnowledgeQuery(core.subjectEn),
  ]).filter(isEffectiveShortQuery);
}

function broadenedCoreQueries(core = {}) {
  return unique([
    composeCoreQuery({ subject: core.subject, action: core.action }),
    cleanKnowledgeQuery(core.subject),
    composeCoreQuery({ subject: core.subjectEn, action: core.actionEn }),
    cleanKnowledgeQuery(core.subjectEn),
  ]).filter(isEffectiveShortQuery);
}

function stripGenericVisualDecorations(value, slot = {}) {
  let result = queryWithoutLocationPrefix(cleanKnowledgeQuery(value), slot)
    .replace(/^(?:自费|可选|待确认)\s*/g, "")
    .replace(/^(?:清晨|早晨|上午|中午|午后|傍晚|黄昏|夜间|夜晚|凌晨|黎明)(?:时|期间|的)?\s*/g, "")
    .replace(/^(?:在|于|从)\s*/g, "");
  result = result.replace(/^(?=[^，。；]{2,16}(?:下|旁|边|中|内|间)(?:的)?)(?:[^，。；]*?(?:金光|晨光|夕阳|暮色|夜色|星空|薄雾|雾气|观景台|观景平台|高处)[^，。；]*?)(?:下|旁|边|中|内|间)(?:的)?\s*/g, "");
  return clean(result)
    .replace(/(?:场景|画面|体验|活动|照片|图片)$/g, "")
    .replace(/^[的与和及、:：\-—–]+|[的与和及、:：\-—–]+$/g, "")
    .trim();
}

function genericVariantsForValue(value, slot = {}) {
  const core = stripGenericVisualDecorations(value, slot);
  if (!core) return [];
  const candidates = [];
  const relation = core.match(/^(.{2,24}?)(?:对望|同框|面向|眺望|远眺|俯瞰|环绕)(.{2,24})$/);
  if (relation) {
    candidates.push(`${clean(relation[1])}与${clean(relation[2])}`, clean(relation[1]), clean(relation[2]));
    return unique(candidates.map(cleanKnowledgeQuery).filter(isEffectiveShortQuery));
  }
  const words = queryWords(core);
  if (words.length <= 4) candidates.push(core);
  if (words.length >= 3) {
    candidates.push(words.slice(0, 3).join(""), words.slice(-3).join(""));
  }
  const pairs = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    const pair = words.slice(index, index + 2);
    const score = pair.filter((word) => !QUERY_FUNCTION_WORDS.has(word)).length;
    pairs.push({ query: pair.join(""), score, index });
  }
  pairs.sort((left, right) => right.score - left.score || left.index - right.index);
  candidates.push(...pairs.map((item) => item.query));
  if (words.length >= 2) candidates.push(words[0], words.at(-1));
  return unique(candidates.map(cleanKnowledgeQuery).filter(isEffectiveShortQuery));
}

function genericQueryFallbacks(slot = {}) {
  const sourceValues = unique([slot.primaryVisualSubject, slot.subject, slot.activity]);
  return unique(sourceValues.flatMap((value) => genericVariantsForValue(value, slot))).filter(isEffectiveShortQuery);
}

function orderedQueryEntries(entries = []) {
  const uniqueEntries = [];
  const seen = new Set();
  for (const entry of entries) {
    const query = cleanKnowledgeQuery(entry.query);
    const key = normalized(query);
    if (!query || seen.has(key)) continue;
    seen.add(key);
    uniqueEntries.push({ ...entry, query });
  }
  return uniqueEntries;
}

export function buildKnowledgeVisualTarget(slot = {}) {
  const purpose = classifyKnowledgeImagePurpose(slot);
  const coreVisualTarget = compactVisualQuery(namedEntityIsContextualExperience(slot)
    ? visualSubjectWithoutContextEntity(slot)
    : slot.primaryVisualSubject || slot.subject || slot.activity);
  const visualDuty = compactVisualQuery(slot.visualDuty || slot.visualGoal || coreVisualTarget);
  const existingIdentityOrTypeProofRequired = ["hotel_space", "hotel_experience", "explicit_entity", "transport"].includes(purpose);
  return {
    coreVisualTarget,
    visualDuty,
    purpose,
    exactIdentityRequired: slot.exactIdentityRequired === true,
    representativeAllowed: !existingIdentityOrTypeProofRequired,
  };
}

function buildKnowledgeQueryVisualTarget(slot = {}) {
  const purpose = classifyKnowledgeImagePurpose(slot);
  const coreVisualTarget = compactVisualQuery(namedEntityIsContextualExperience(slot)
    ? visualSubjectWithoutContextEntity(slot)
    : slot.primaryVisualSubject || slot.subject || slot.activity);
  const existingIdentityOrTypeProofRequired = ["hotel_space", "hotel_experience", "explicit_entity", "transport"].includes(purpose);
  return { coreVisualTarget, visualDuty: coreVisualTarget, purpose, exactIdentityRequired: slot.exactIdentityRequired === true, representativeAllowed: !existingIdentityOrTypeProofRequired };
}

function searchIntentEnglishSynonyms(slot = {}) {
  const rawValues = Array.isArray(slot.searchIntent) ? slot.searchIntent : [slot.searchIntent];
  const subjectKey = normalized(querySourceValues(slot).join(" "));
  const anchors = [
    [/(?:游船|乘船|boat)/, /\bboat\b/i],
    [/(?:河马|hippo)/, /\bhippos?\b/i],
    [/(?:长颈鹿|giraffe)/, /\bgiraffes?\b/i],
    [/(?:水羚|waterbuck)/, /\bwaterbucks?\b/i],
    [/(?:斑马|zebra)/, /\bzebras?\b/i],
    [/(?:象群|大象|elephant)/, /\belephants?\b/i],
    [/(?:鱼鹰|fish eagle)/, /\bfish\s+eagle\b/i],
    [/(?:骑行|cycling)/, /\b(?:cycling|bike|bicycle)\b/i],
  ].filter(([subjectPattern]) => subjectPattern.test(subjectKey)).map(([, intentPattern]) => intentPattern);
  if (!anchors.length) return [];
  const locationTokens = unique([slot.location, slot.region, slot.destination, slot.country])
    .flatMap((value) => clean(value).toLowerCase().split(/[^a-z]+/))
    .filter((value) => value.length >= 3);
  return unique(rawValues.flatMap((value) => clean(value).match(/[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,7}/g) || [])
    .map((phrase) => phrase.split(/\s+/).filter((word) => !locationTokens.includes(word.toLowerCase()) && !/^(?:photo|photos|photography|image|images|lake)$/i.test(word)).join(" "))
    .filter((phrase) => phrase && phrase.split(/\s+/).length <= 6 && anchors.some((pattern) => pattern.test(phrase))));
}

function animalQueryPlan({ hasLeopard, hasCheetah, hasLion, hasTracking }) {
  const zh = [];
  const en = [];
  if (hasLeopard) { zh.push(hasTracking ? "追踪花豹" : "花豹游猎"); en.push(hasTracking ? "leopard sighting safari" : "leopard safari"); }
  if (hasCheetah) { zh.push(hasTracking ? "追踪猎豹" : "猎豹游猎"); en.push(hasTracking ? "cheetah sighting safari" : "cheetah safari"); }
  if (hasLion) { zh.push(hasTracking ? "追踪狮群" : "狮群游猎"); en.push(hasTracking ? "lion pride sighting" : "lion pride safari"); }
  return unique([...zh, ...en]);
}

function hotelSpaceQueryGroups(slot = {}) {
  return [
    { category: "exterior", queries: ["酒店外观"] },
    { category: "suite", queries: ["酒店套房"] },
    { category: "pool", queries: ["酒店泳池"] },
    { category: "main_areas", queries: ["酒店公共空间"] },
  ];
}

export function applyKnowledgeScopeToQueryPlan(basePlan = {}, slot = {}, scopeResolution = null) {
  const sharedScopeNodeIds = scopeResolution?.status === "resolved" ? [...(scopeResolution.nodeIds || [])] : [];
  if (basePlan.validationError || !Array.isArray(basePlan.queries) || !basePlan.queries.length) {
    return { ...basePlan, sharedScopeNodeIds };
  }
  const purpose = basePlan.purpose || classifyKnowledgeImagePurpose(slot);
  const hotelName = clean(slot.hotel || slot.hotelOfficialName || slot.hotelShortName || hotelEntityForSlot(slot)?.canonicalName);
  const expandedHotelScope = ["hotel_space", "hotel_experience"].includes(purpose)
    && hotelName
    && scopeResolution?.status === "resolved"
    && scopeResolution.node
    && !identityMatches(scopeResolution.node?.formalName, hotelName);
  if (!expandedHotelScope) return { ...basePlan, sharedScopeNodeIds };

  const queries = basePlan.queries.map((query) => normalized(query).includes(normalized(hotelName))
    ? query
    : cleanKnowledgeQuery(`${hotelName} ${query}`));
  const searchable = queries.every((query) => query
    && !QUERY_DUTY_CLAUSE.test(query)
    && !MEANINGLESS_QUERY.test(query)
    && normalized(query).includes(normalized(hotelName))
    && query.length <= 110
    && query.split(/\s+/).filter(Boolean).length <= 12);
  if (!searchable) {
    return {
      ...basePlan,
      queries: [],
      querySteps: [],
      plannerQueries: [],
      fallbackQueries: [],
      validationError: { code: "hotel_identity_query_unrecoverable", detail: "expanded_hotel_scope_identity_query_invalid", message: "酒店目录扩大后无法形成安全的酒店身份Query，保留图片位并转人工处理" },
      strategy: "needs_user_action_hotel_identity_query_unrecoverable",
      sharedScopeNodeIds,
    };
  }
  return {
    ...basePlan,
    queries,
    querySteps: queries.map((query, index) => ({
      ...(basePlan.querySteps?.[index] || {}),
      query,
      finalQuery: query,
      source: normalized(query) === normalized(basePlan.queries[index]) ? basePlan.querySteps?.[index]?.source || "planner" : "scope_identity",
    })),
    plannerQueries: [],
    fallbackQueries: queries,
    repairStatus: "hotel_identity_added_for_expanded_scope",
    strategy: "planner_queries_with_hotel_scope_identity",
    sharedScopeNodeIds,
  };
}

export function buildKnowledgeQueryPlan(slot = {}, scopeResolution = null, { maxQueries = 4 } = {}) {
  const limit = Math.max(2, Math.min(4, Number(maxQueries) || 4));
  const purpose = classifyKnowledgeImagePurpose(slot);
  const visualTarget = buildKnowledgeQueryVisualTarget(slot);
  if (moduleKind(slot) === "hotel" && ["hotel_space", "hotel_experience"].includes(purpose)) {
    const queryGroups = hotelSpaceQueryGroups(slot).slice(0, limit);
    const queries = queryGroups.map((group) => group.queries[0]);
    return applyKnowledgeScopeToQueryPlan({
      queries,
      querySteps: queries.map((query, index) => ({
        query,
        source: "hotel_value_category",
        level: index === 0 ? "representative" : "alternate_category",
        category: queryGroups[index].category,
        coreVisualTarget: "酒店代表性空间",
        originalQuery: null,
        scopeCleanup: false,
        removedScopeLocations: [],
        finalQuery: query,
      })),
      queryGroups,
      purpose,
      visualTarget,
      plannerQueries: [],
      fallbackQueries: queries,
      repairStatus: "hotel_value_categories",
      degraded: false,
      strategy: "sequential_hotel_value_categories_until_selected",
      sharedScopeNodeIds: [],
    }, slot, scopeResolution);
  }
  const rawCore = plannerQueryCore(slot);
  // Query repair is deliberately independent of the resolved directory. Scope
  // chooses where to search; it must not reinterpret what the Planner asked for.
  const core = effectivePlannerQueryCore(slot, rawCore, null);
  const plannerEntries = plannerSearchEntries(slot, rawCore, core);
  const hasCore = queryCoreConfigured(core);
  const coreRepairs = hasCore ? repairedCoreQueries(core) : [];
  const fidelityValid = plannerEntries.some((entry) => entry.plannerIndex === 0);
  let entries = fidelityValid
    ? [...plannerEntries]
    : [...coreRepairs.slice(0, 1).map((query) => ({ query, source: "repair" })), ...plannerEntries];
  if (entries.length < 2) {
    const used = new Set(entries.map((entry) => normalized(entry.query)));
    entries.push(...coreRepairs
      .filter((query) => !used.has(normalized(query)))
      .map((query) => ({ query, source: "repair" })));
  }

  const selectedEntries = orderedQueryEntries(entries)
    .filter((entry) => isEffectiveShortQuery(entry.query))
    .slice(0, limit);
  const queryGroups = [];
  if (!selectedEntries.length) {
    return applyKnowledgeScopeToQueryPlan({
      queries: [],
      querySteps: [],
      queryGroups,
      purpose,
      visualTarget,
      plannerQueries: [],
      fallbackQueries: [],
      validationError: { code: "query_core_unrecoverable", detail: "no_safe_query_after_repair", message: "当前图片位无法从Planner主体与动作中形成安全Query，保留图片位并转人工处理" },
      strategy: "needs_user_action_query_core_unrecoverable",
      sharedScopeNodeIds: [],
    }, slot, scopeResolution);
  }
  const queries = selectedEntries.map((entry) => entry.query);
  const querySteps = selectedEntries.map((entry, index) => ({
    query: entry.query,
    source: entry.source,
    level: index === 0 ? "precise" : "broadened",
    coreVisualTarget: visualTarget.coreVisualTarget,
    originalQuery: entry.originalQuery ?? null,
    scopeCleanup: entry.scopeCleanup === true,
    removedScopeLocations: Array.isArray(entry.removedScopeLocations) ? entry.removedScopeLocations : [],
    finalQuery: entry.finalQuery || entry.query,
  }));
  return applyKnowledgeScopeToQueryPlan({
    queries,
    querySteps,
    queryGroups,
    purpose,
    visualTarget,
    plannerQueries: selectedEntries.filter((entry) => entry.source === "planner").map((entry) => entry.query),
    fallbackQueries: selectedEntries.filter((entry) => entry.source !== "planner").map((entry) => entry.query),
    repairStatus: selectedEntries.some((entry) => entry.source === "repair") ? "repaired_from_planner_core"
      : "planner_valid",
    degraded: selectedEntries.length < 2,
    strategy: selectedEntries.every((entry) => entry.source === "planner") ? "planner_queries"
        : selectedEntries.some((entry) => entry.source === "repair") ? "planner_core_repair"
          : "planner_queries",
    sharedScopeNodeIds: [],
  }, slot, scopeResolution);
}

export function buildKnowledgeQuery(slot = {}, scopeResolution = null) {
  return buildKnowledgeQueryPlan(slot, scopeResolution, { maxQueries: 4 }).queries[0] || "";
}

export function knowledgeSourcePathMatches(scopeResolution, sourcePaths = [], { mode = "entity_identity", identityAnchors = [] } = {}) {
  if (!scopeResolution || scopeResolution.status !== "resolved" || !scopeResolution.node) return { match: null, reason: "scope_unresolved" };
  if (!Array.isArray(sourcePaths) || !sourcePaths.length) return { match: null, reason: "source_path_missing" };
  const meaningful = scopeResolution.node.pathSegments.filter((segment) => !GENERIC_NODE_NAMES.has(normalized(segment)) && normalized(segment).length >= 3);
  // The leaf proves the specific entity while its nearest meaningful parent
  // prevents duplicate leaf names in another region from being accepted.
  const leafAnchor = meaningful.at(-1);
  const parentAnchor = meaningful.at(-2);
  if (!leafAnchor) return { match: null, reason: "scope_has_no_identity_anchor" };
  const matched = sourcePaths.some((sourcePath) => {
    const segments = sourcePathSegments(sourcePath);
    if (identityAnchors.length) return segments.some((segment) => identityAnchors.some((anchor) => strictIdentityMatches(segment, anchor)));
    const leafMatches = segments.some((segment) => identityMatches(segment, leafAnchor));
    if (!leafMatches) return false;
    if (mode === "country_context") return true;
    return !parentAnchor || sourcePathSupportsParent(segments, parentAnchor);
  });
  return {
    match: matched,
    reason: matched ? "source_path_matches_scope" : "knowledge_source_path_mismatch",
    anchors: (identityAnchors.length ? identityAnchors : mode === "country_context" ? [leafAnchor] : [parentAnchor, leafAnchor]).filter(Boolean).map(normalized),
    scopePath: scopeResolution.fullPath,
    mode,
  };
}

export function createKnowledgeScopeResolver({ baseUrl, root, fetchImpl = fetch, signal, hierarchyLoader = loadKnowledgeHierarchy } = {}) {
  const mappingPath = root ? path.join(root, "output", "knowledge-node-mappings.json") : "";
  let hierarchyPromise;
  let mappingsPromise;
  let writeTail = Promise.resolve();
  const hierarchy = () => hierarchyPromise ||= hierarchyLoader({ baseUrl, fetchImpl, signal });
  const mappings = () => mappingsPromise ||= (mappingPath
    ? readFile(mappingPath, "utf8").then((value) => JSON.parse(value)).catch(() => ({}))
    : Promise.resolve({}));
  const persist = async (key, resolution) => {
    if (!mappingPath || !key || resolution?.status !== "resolved") return;
    writeTail = writeTail.then(async () => {
      const current = await mappings();
      current[key] = { nodeId: resolution.nodeIds[0], fullPath: resolution.fullPath, updatedAt: new Date().toISOString() };
      await mkdir(path.dirname(mappingPath), { recursive: true });
      const temporary = `${mappingPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      await rename(temporary, mappingPath);
    });
    await writeTail;
  };
  return {
    async resolve(slot, options = {}) {
      const [index, saved] = await Promise.all([hierarchy(), mappings()]);
      const key = mappingKey(slot);
      const resolution = resolveKnowledgeScope(slot, index, { ...options, cachedNodeId: options.allowedNodeIds ? null : saved[key]?.nodeId });
      await persist(key, resolution);
      return resolution;
    },
    async clarify(slot, nodeIds) {
      const index = await hierarchy();
      const resolution = resolveKnowledgeClarification(slot, nodeIds, index);
      await persist(mappingKey(slot), resolution);
      return resolution;
    },
    async refine(slot, rootResolution) {
      const index = await hierarchy();
      return resolveKnowledgeChildScope(slot, rootResolution, index);
    },
    async plan(slot, rootResolution) {
      const index = await hierarchy();
      return buildKnowledgeScopePlan(slot, rootResolution, index);
    },
  };
}
