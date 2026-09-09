import { TRAVEL_ENTITY_REGISTRY } from "../data/travelEntityRegistry.js";

export const DEFAULT_TRAVEL_LOCALE = "zh-CN";

export function normalizeTravelEntityName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\s\u00a0\-–—_,，.。·:：'’"“”()（）/\\]+/g, "")
    .trim();
}

function contextValue(context, key) {
  return context?.[key] ?? context?.scope?.[key] ?? "";
}

function matchesScope(entity, context, key) {
  const expected = normalizeTravelEntityName(contextValue(context, key));
  if (!expected) return true;
  return [entity?.[key], entity?.scope?.[key]].some((value) => normalizeTravelEntityName(value) === expected);
}

export function resolveTravelEntity(value, { locale = DEFAULT_TRAVEL_LOCALE, entityType, country, region, scope, registry = TRAVEL_ENTITY_REGISTRY } = {}) {
  const input = String(value ?? "").trim();
  const key = normalizeTravelEntityName(input);
  const context = { country, region, scope };
  if (!key) return { input, canonicalName: input, displayName: input, locale, status: "empty", entity: null, issues: [] };

  let candidates = registry.filter((entity) => [entity.canonicalName, ...(entity.aliases || [])].some((name) => normalizeTravelEntityName(name) === key));
  if (entityType) candidates = candidates.filter((entity) => entity.entityType === entityType);
  if (candidates.length > 1 && contextValue(context, "country")) {
    const scoped = candidates.filter((entity) => matchesScope(entity, context, "country"));
    if (scoped.length) candidates = scoped;
  }
  if (candidates.length > 1 && contextValue(context, "region")) {
    const scoped = candidates.filter((entity) => matchesScope(entity, context, "region"));
    if (scoped.length) candidates = scoped;
  }

  if (candidates.length > 1) {
    return {
      input,
      canonicalName: input,
      displayName: input,
      locale,
      status: "ambiguous",
      entity: null,
      issues: [{ code: "entity_resolution_pending", value: input, candidateIds: candidates.map((entity) => entity.id) }],
    };
  }

  const entity = candidates[0];
  if (!entity) {
    return {
      input,
      canonicalName: input,
      displayName: input,
      locale,
      status: "unmapped",
      entity: null,
      issues: [{ code: "entity_display_name_missing", value: input, locale }],
    };
  }

  const localized = String(entity.displayNames?.[locale] || "").trim();
  return {
    input,
    canonicalName: entity.canonicalName,
    displayName: localized || entity.canonicalName,
    locale,
    status: localized ? "resolved" : "canonical_fallback",
    entity,
    issues: localized ? [] : [{ code: "entity_display_name_missing", value: entity.canonicalName, entityId: entity.id, locale }],
  };
}

export function resolveEntityDisplayName(value, locale = DEFAULT_TRAVEL_LOCALE, context = {}) {
  return resolveTravelEntity(value, { ...context, locale }).displayName;
}

export function sameTravelEntityName(left, right) {
  return Boolean(normalizeTravelEntityName(left)) && normalizeTravelEntityName(left) === normalizeTravelEntityName(right);
}

function hotelContext(hotel = {}, data = {}) {
  return { entityType: "hotel", country: hotel.country || data.country, region: hotel.region };
}

function findHotelForDay(day, hotels) {
  const dayKeys = [day.hotel, day.hotelOfficialName, day.hotelShortName].map(normalizeTravelEntityName).filter(Boolean);
  return hotels.find((hotel) => {
    const hotelKeys = [hotel.officialName, hotel.shortName, hotel.__canonicalName, ...(hotel.__aliases || [])].map(normalizeTravelEntityName).filter(Boolean);
    return dayKeys.some((key) => hotelKeys.includes(key));
  });
}

export function synchronizeTravelEntityDisplayFields(data = {}, { locale = data?.locale || DEFAULT_TRAVEL_LOCALE, registry = TRAVEL_ENTITY_REGISTRY } = {}) {
  const next = structuredClone(data || {});
  const hotels = (next.hotels || []).map((hotel) => {
    const sourceName = hotel.officialName || hotel.shortName;
    const resolved = resolveTravelEntity(sourceName, { ...hotelContext(hotel, next), locale, registry });
    if (resolved.status !== "resolved") return hotel;
    return {
      ...hotel,
      officialName: hotel.officialName || resolved.canonicalName,
      shortName: resolved.displayName,
      __canonicalName: resolved.canonicalName,
      __aliases: resolved.entity?.aliases || [],
    };
  });

  if (Array.isArray(next.hotels)) next.hotels = hotels;
  if (Array.isArray(next.days)) next.days = next.days.map((day) => {
    if (!day.hotel && !day.hotelOfficialName && !day.hotelShortName) return day;
    const matchedHotel = findHotelForDay(day, hotels);
    if (matchedHotel) {
      return {
        ...day,
        hotelShortName: matchedHotel.shortName || day.hotelShortName || day.hotel,
        hotelOfficialName: matchedHotel.officialName || day.hotelOfficialName || day.hotel,
      };
    }
    const resolved = resolveTravelEntity(day.hotelOfficialName || day.hotel || day.hotelShortName, { locale, entityType: "hotel", country: next.country, registry });
    return resolved.status === "resolved" ? { ...day, hotelShortName: resolved.displayName, hotelOfficialName: resolved.canonicalName } : day;
  });

  if (Array.isArray(next.hotels)) next.hotels = next.hotels.map(({ __canonicalName, __aliases, ...hotel }) => hotel);
  return next;
}

function displayDirectEntity(value, options) {
  if (!String(value ?? "").trim()) return value;
  return resolveTravelEntity(value, options).displayName;
}

export function buildCustomerTravelEntityData(data = {}, { locale = data?.locale || DEFAULT_TRAVEL_LOCALE, registry = TRAVEL_ENTITY_REGISTRY } = {}) {
  const next = synchronizeTravelEntityDisplayFields(data, { locale, registry });
  const baseContext = { locale, country: next.country, registry };
  if (Array.isArray(next.days)) next.days = next.days.map((day) => ({
      ...day,
      routeNodes: (day.routeNodes || []).map((node) => displayDirectEntity(node, { ...baseContext, region: day.region })),
      spots: (day.spots || []).map((spot) => ({ ...spot, name: displayDirectEntity(spot.name, { ...baseContext, region: day.region }) })),
    }));
  if (Array.isArray(next.diningExperiences)) next.diningExperiences = next.diningExperiences.map((item) => ({
      ...item,
      title: displayDirectEntity(item.title, { ...baseContext, entityType: "restaurant", region: item.location }),
    }));
  if (next.simpleImageSlotBindings) {
    next.simpleImageSlotBindings = Object.fromEntries(Object.entries(next.simpleImageSlotBindings).map(([slotId, binding]) => [slotId, {
      ...binding,
      cardTitle: displayDirectEntity(binding.cardTitle, { ...baseContext, region: next.days?.[binding.dayIndex]?.region }),
    }]));
  }
  return next;
}
