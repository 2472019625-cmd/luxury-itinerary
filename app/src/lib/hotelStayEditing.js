import { hotelStayDetails } from "./hotelStayPresentation.js";

const hotelName = (hotel) => hotel?.shortName || hotel?.officialName || "酒店";
const fail = (reason) => ({ ok: false, reason });

export function planHotelNightChange(data = {}, hotelIndex, desiredNights) {
  const hotels = data.hotels || [];
  const days = data.days || [];
  const index = Number(hotelIndex);
  const desired = Number(desiredNights);
  if (!Number.isInteger(index) || !hotels[index]) return fail("酒店不存在，请重新选择。");
  if (!Number.isInteger(desired) || desired < 1 || desired > days.length) return fail("入住晚数必须是有效的正整数。");

  const stays = hotels.map((hotel) => hotelStayDetails(hotel, days));
  const current = stays[index];
  if (!current.nights || !current.isContinuous) return fail("这家酒店的每日住宿不连续或尚未关联，不能自动调整晚数。");
  if (stays.some((stay, hotelPosition) => hotelPosition !== index && stay.nights && !stay.isContinuous)) return fail("当前存在分散入住的酒店，请先核对住宿安排。");
  if (desired === current.nights) return fail("入住晚数没有变化。");

  const ordered = stays.map((stay, hotelPosition) => ({ ...stay, hotelPosition }))
    .filter((stay) => stay.nights)
    .sort((left, right) => left.stayIndexes[0] - right.stayIndexes[0]);
  const position = ordered.findIndex((stay) => stay.hotelPosition === index);
  const neighbor = desired > current.nights
    ? ordered[position + 1] || ordered[position - 1]
    : ordered[position + 1] || ordered[position - 1];
  if (!neighbor) return fail("没有相邻酒店可以承接晚数；不会自动增加行程天数。");
  const neighborIndex = neighbor.hotelPosition;
  const afterTarget = desired;
  const afterNeighbor = neighbor.nights + current.nights - desired;
  if (afterNeighbor < 1) return fail(`「${hotelName(hotels[neighborIndex])}」只住 ${neighbor.nights} 晚，调整后会被移除；请先确认完整入住安排。`);

  const nextNeighbor = neighbor.stayIndexes[0] === current.stayIndexes.at(-1) + 1;
  const previousNeighbor = current.stayIndexes[0] === neighbor.stayIndexes.at(-1) + 1;
  if (!nextNeighbor && !previousNeighbor) return fail("两家酒店的住宿日不相邻，不能自动转移晚数。");
  const transferCount = Math.abs(desired - current.nights);
  let changedDayIndexes;
  if (desired > current.nights) {
    changedDayIndexes = nextNeighbor ? neighbor.stayIndexes.slice(0, transferCount) : neighbor.stayIndexes.slice(-transferCount);
  } else {
    changedDayIndexes = nextNeighbor ? current.stayIndexes.slice(-transferCount) : current.stayIndexes.slice(0, transferCount);
  }
  if (changedDayIndexes.length !== transferCount) return fail("相邻酒店可调整的住宿日不足。");
  const fromHotelIndex = desired > current.nights ? neighborIndex : index;
  const toHotelIndex = desired > current.nights ? index : neighborIndex;
  if (changedDayIndexes.some((dayIndex) => ["none", "inflight"].includes(days[dayIndex]?.overnightType))) return fail("涉及无住宿或夜航日期，不能自动调整。");
  const signature = JSON.stringify({ hotelIds: [hotels[index].id, hotels[neighborIndex].id], current: current.stayIndexes, neighbor: neighbor.stayIndexes, dayHotels: changedDayIndexes.map((dayIndex) => [days[dayIndex]?.hotel, days[dayIndex]?.hotelOfficialName, days[dayIndex]?.hotelShortName, days[dayIndex]?.overnightType]) });
  return { ok: true, hotelIndex: index, neighborIndex, currentNights: current.nights, desiredNights: afterTarget, neighborCurrentNights: neighbor.nights, neighborDesiredNights: afterNeighbor, changedDayIndexes, fromHotelIndex, toHotelIndex, signature };
}

export function applyHotelNightChange(data, plan) {
  if (!plan?.ok) throw new Error("入住晚数调整方案无效");
  const next = structuredClone(data);
  const destination = next.hotels[plan.toHotelIndex];
  for (const dayIndex of plan.changedDayIndexes) {
    const day = next.days[dayIndex];
    day.hotel = destination.officialName || destination.shortName;
    day.hotelOfficialName = destination.officialName || "";
    day.hotelShortName = destination.shortName || destination.officialName || "";
    day.overnightType = "hotel";
  }
  for (const index of [plan.hotelIndex, plan.neighborIndex]) {
    next.hotels[index].nights = hotelStayDetails(next.hotels[index], next.days).nights;
  }
  return next;
}
