import { normalizeTravelEntityName } from "./travelEntityDisplay.js";

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

export function hotelStayDetails(hotel = {}, days = []) {
  const stayIndexes = days
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => day.overnightType !== "inflight" && day.overnightType !== "none" && entityNamesMatch(day, hotel))
    .map(({ index }) => index);

  const isContinuous = stayIndexes.every((value, index) => index === 0 || value === stayIndexes[index - 1] + 1);
  return { stayIndexes, nights: stayIndexes.length, isContinuous };
}

export function deriveHotelStayLine(hotel = {}, days = [], hotels = [], destination = "") {
  const { stayIndexes, nights, isContinuous } = hotelStayDetails(hotel, days);
  if (!stayIndexes.length || !isContinuous) return "";

  const checkInDay = stayIndexes[0] + 1;
  const checkOutDay = stayIndexes.at(-1) + 2;
  const nightsLabel = nights > 1 ? `连住${nights}晚` : "1晚";
  return `D${checkInDay}入住 → D${checkOutDay}退房 · ${nightsLabel}`;
}
