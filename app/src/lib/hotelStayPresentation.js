import { normalizeTravelEntityName } from "./travelEntityDisplay.js";

const TERMINAL_OR_TRANSPORT = /机场|航站楼|送机|离境|返程|飞机|航班|小飞机|专车|车辆|用车|游猎车|轮渡|渡轮|码头|高铁|新干线|火车|列车/i;
const LOCATION_SUFFIX = /(?:国家公园|国家保护区|私人保护区|自然保护区|保护区|国家森林公园|森林公园|商圈)$/;

function normalizedNames(item = {}) {
  return [item.officialName, item.shortName, item.hotel, item.hotelOfficialName, item.hotelShortName]
    .map(normalizeTravelEntityName)
    .filter(Boolean);
}

function entityNamesMatch(left = {}, right = {}) {
  const leftNames = normalizedNames(left);
  const rightNames = normalizedNames(right);
  return leftNames.some((leftName) => rightNames.some((rightName) => (
    leftName === rightName
    || (Math.min(leftName.length, rightName.length) >= 6 && (leftName.includes(rightName) || rightName.includes(leftName)))
  )));
}

function compactLocation(value) {
  return String(value || "")
    .split(/[·｜|/]/)[0]
    .trim()
    .replace(LOCATION_SUFFIX, "")
    .trim();
}

function matchingHotelForNode(node, hotels = []) {
  const candidate = { hotel: node };
  return hotels.find((hotel) => entityNamesMatch(candidate, hotel));
}

function routeOrigin(day = {}, hotel = {}, hotels = []) {
  const currentRegion = normalizeTravelEntityName(compactLocation(hotel.region));
  for (const rawNode of day.routeNodes || []) {
    const node = String(rawNode || "").trim();
    if (!node || TERMINAL_OR_TRANSPORT.test(node)) continue;
    const matchedHotel = matchingHotelForNode(node, hotels);
    if (matchedHotel) {
      if (entityNamesMatch(matchedHotel, hotel)) continue;
      const previousRegion = compactLocation(matchedHotel.region);
      if (previousRegion) return previousRegion;
      continue;
    }
    const compact = compactLocation(node);
    if (!compact || normalizeTravelEntityName(compact) === currentRegion) continue;
    return compact;
  }
  return "";
}

function routeDestination(day = {}, hotel = {}, destination = "") {
  const hotelRegion = compactLocation(hotel.region);
  if (hotelRegion && normalizeTravelEntityName(hotelRegion) !== normalizeTravelEntityName(destination)) return hotelRegion;
  const nodes = [...(day.routeNodes || [])].reverse();
  for (const rawNode of nodes) {
    const node = String(rawNode || "").trim();
    if (!node || TERMINAL_OR_TRANSPORT.test(node) || entityNamesMatch({ hotel: node }, hotel)) continue;
    const compact = compactLocation(node);
    if (compact) return compact;
  }
  return "";
}

export function deriveHotelStayLine(hotel = {}, days = [], hotels = [], destination = "") {
  const stayIndexes = days
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => day.overnightType !== "inflight" && day.overnightType !== "none" && entityNamesMatch(day, hotel))
    .map(({ index }) => index);

  if (!stayIndexes.length) return "";
  const isContinuous = stayIndexes.every((value, index) => index === 0 || value === stayIndexes[index - 1] + 1);
  if (!isContinuous) return "";
  if (Number(hotel.nights) > 0 && Number(hotel.nights) !== stayIndexes.length) return "";

  const checkInDay = stayIndexes[0] + 1;
  const checkOutDay = stayIndexes.at(-1) + 2;
  const nights = stayIndexes.length;
  const firstStayDay = days[stayIndexes[0]] || {};
  const origin = routeOrigin(firstStayDay, hotel, hotels);
  const stayDestination = routeDestination(firstStayDay, hotel, destination);
  const route = origin && stayDestination && normalizeTravelEntityName(origin) !== normalizeTravelEntityName(stayDestination)
    ? `｜${origin} → ${stayDestination}`
    : "";
  const nightsLabel = nights > 1 ? `连住${nights}晚` : "1晚";
  return `D${checkInDay}入住 → D${checkOutDay}退房 · ${nightsLabel}${route}`;
}
