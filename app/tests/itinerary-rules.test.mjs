import assert from "node:assert/strict";
import test from "node:test";
import {
  compactProofPoints,
  formatTravelerCount,
  inferOvernightType,
  isUsableFinalImageSource,
  mapDaysFromStart,
  normalizeDayFacts,
  normalizeItineraryFacts,
  synchronizeExperienceStatus,
  validateItineraryFacts,
} from "../src/lib/itineraryRules.js";

test("maps DAY dates continuously and rejects a conflicting inclusive return span", () => {
  const mapped = mapDaysFromStart({ days: [{}, {}, {}, {}, {}, {}, {}, {}], endDate: "2026-08-25" }, "2026-08-17");
  assert.equal(mapped.days[0].date, "2026-08-17");
  assert.equal(mapped.days[7].date, "2026-08-24");
  const validation = validateItineraryFacts(mapped);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /自然日共9天/);
});

test('editor status changes synchronize included, excluded and pending lists', () => {
  const data = normalizeItineraryFacts({ days: [{ spots: [{ name: '热气球', status: 'optional_paid', sourceEvidence: ['自费热气球'] }] }], included: [], excluded: [], pendingConfirmations: [] }, { mapDates: false });
  synchronizeExperienceStatus(data, 0, 0, 'included');
  assert.ok(data.included.some((item) => item.startsWith('热气球：')));
  assert.ok(!data.excluded.some((item) => item.startsWith('热气球：')));
  assert.equal(data.days[0].spots[0].feeBoundary, 'included');
  synchronizeExperienceStatus(data, 0, 0, 'pending');
  assert.ok(data.pendingConfirmations.some((item) => item.startsWith('热气球：')));
  assert.ok(!data.included.some((item) => item.startsWith('热气球：')));
});

test("renders real traveler counts and never substitutes a service slogan", () => {
  assert.equal(formatTravelerCount({ adults: 2, children: 1 }), "2位成人 / 1位儿童");
  assert.equal(formatTravelerCount({}), "待确认");
  assert.notEqual(formatTravelerCount({ travelerLabel: "一家一团 · 私家定制" }), "一家一团 · 私家定制");
});

test("classifies flight and no-stay return days without treating planes as hotels", () => {
  assert.equal(inferOvernightType({ hotel: "飞机" }, 7, 8), "inflight");
  const inflight = normalizeDayFacts({ hotel: "飞机", theme: "返程" }, 7, 8);
  assert.equal(inflight.hotel, "");
  assert.equal(inflight.overnightLabel, "返程航班");
  assert.equal(inferOvernightType({ hotel: "无住宿" }, 7, 8), "none");
  assert.equal(inferOvernightType({ hotel: "Four Seasons Safari Lodge" }, 3, 8), "hotel");
});

test("separates route, travel time and activity while creating grounded daily image subjects", () => {
  const day = normalizeDayFacts({
    city: "阿鲁沙-塔兰吉雷国家公园\n车程约2.5小时",
    vehicle: "四驱开顶越野车",
    description: "酒店早餐后前往塔兰吉雷国家公园游猎，观赏猴面包树及象群。",
    hotel: "Elephant Springs Camp",
    spots: [],
  }, 1, 8);
  assert.deepEqual(day.routeNodes, ["阿鲁沙", "塔兰吉雷国家公园", "Elephant Springs Camp"]);
  assert.equal(day.estimatedTravelTime, "车程约2.5小时");
  assert.equal(day.activityLevel, "适中");
  assert.equal(day.spots[0].name, "塔兰吉雷国家公园游猎");
  const normalizedAgain = normalizeDayFacts(day, 1, 8);
  assert.equal(normalizedAgain.routeNodes.filter((node) => node === "Elephant Springs Camp").length, 1);
});

test("keeps hotel proof points concise and final images local", () => {
  assert.deepEqual(compactProofPoints(["位于塞伦盖蒂中部核心位置，方便衔接全天游猎", "连续入住两晚让节奏更从容舒适"]), ["塞伦盖蒂中部核心位置", "方便衔接全天游猎", "连续入住两晚让节奏"]);
  assert.deepEqual(compactProofPoints(["酒店内即可赏火山口日出与全景", "Serena品牌 safari服务"]), ["火山口日出视野", "Serena品牌服务"]);
  assert.equal(isUsableFinalImageSource("/image-assets/run/photo.webp"), true);
  assert.equal(isUsableFinalImageSource("data:image/png;base64,AA=="), true);
  assert.equal(isUsableFinalImageSource("https://remote.example/photo.jpg"), false);
  assert.equal(isUsableFinalImageSource(""), false);
});

test("normalizes experience states and synchronizes fee and confirmation boundaries", () => {
  const normalized = normalizeItineraryFacts({ days: [{
    description: "上午游猎；热气球为自费可选；文化村待确认；观景台需提前预约。",
    spots: [
      { name: "核心游猎", description: "上午游猎" },
      { name: "热气球", description: "热气球为自费可选" },
      { name: "文化村", description: "文化村待确认" },
      { name: "观景台", description: "观景台需提前预约" },
    ],
  }], excluded: [], pendingConfirmations: [] }, { mapDates: false });
  assert.deepEqual(normalized.days[0].spots.map((spot) => spot.status), ["included", "optional_paid", "pending", "reservation_required"]);
  assert.deepEqual(normalized.days[0].spots.map((spot) => spot.statusLabel), ["已包含", "自费可选", "待确认", "需提前预约"]);
  assert.ok(normalized.days[0].spots.every((spot) => spot.id && Array.isArray(spot.sourceEvidence) && Array.isArray(spot.images)));
  assert.ok(normalized.excluded.some((item) => item.includes("热气球")));
  assert.ok(normalized.pendingConfirmations.some((item) => item.includes("文化村")));
});

test("splits an included core experience from optional paid sub-experiences", () => {
  const day = normalizeDayFacts({ city: '塞伦盖蒂西部', description: '游猎日，独立包车敞篷越野游猎，可自费参加清晨热气球Safari', spots: [] }, 2, 7);
  assert.equal(day.spots[0].name, '塞伦盖蒂西部游猎');
  assert.equal(day.spots[0].status, 'included');
  assert.equal(day.spots[1].name, '清晨热气球 Safari');
  assert.equal(day.spots[1].status, 'optional_paid');
  assert.match(day.spots[1].sourceEvidence[0], /自费/);
});

test('classifies hotel-night, vehicle guarantee and fee conflicts as blockers', () => {
  const data = normalizeItineraryFacts({
    days: [
      { hotel: 'Test Lodge', overnightType: 'hotel', spots: [{ name: '热气球', status: 'optional_paid', sourceEvidence: ['自费热气球'] }] },
      { hotel: '无住宿', overnightType: 'none', spots: [] },
    ],
    hotels: [{ officialName: 'Test Lodge', nights: 2 }],
    transportSummary: [{ category: '用车', model: 'V-Class', modelGuaranteed: true }],
    included: ['热气球'], excluded: [], pendingConfirmations: [], adults: 2,
  }, { mapDates: false });
  // Recreate an explicit unverified guarantee after normalization has safely downgraded it.
  data.transportSummary[0].modelGuaranteed = true;
  const validation = validateItineraryFacts(data);
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((item) => item.code === 'hotel_nights_conflict'));
  assert.ok(validation.issues.some((item) => item.code === 'vehicle_guarantee_without_evidence'));
  assert.ok(validation.issues.some((item) => item.code === 'optional_included_conflict'));
});

test('time-sensitive advice requires a source/date or conservative wording', () => {
  const base = { days: [{}], adults: 2, notes: [{ title: '签证', items: ['请核对'] }] };
  const unverified = validateItineraryFacts(base);
  assert.ok(unverified.needsConfirmation.some((item) => item.code === 'time_sensitive_unverified'));
  const conservative = validateItineraryFacts({ ...base, notes: ['签证要求以出发时官方要求为准'] });
  assert.ok(!conservative.needsConfirmation.some((item) => item.code === 'time_sensitive_unverified'));
  const verified = validateItineraryFacts({ ...base, notes: [{ title: '签证', items: ['须提前办理'], sourceUrl: 'https://official.example', verifiedAt: '2026-08-29' }] });
  assert.ok(!verified.needsConfirmation.some((item) => item.code === 'time_sensitive_unverified'));
});

test('source import coverage blocks silently emptied fees and daily transport', () => {
  const data = normalizeItineraryFacts({
    days:[{vehicle:'',description:'抵达后休整'}], adults:2, included:[], transportSummary:[],
    sourceImportCoverage:{
      included:Array.from({length:9},(_,index)=>({text:`费用${index + 1}`})),
      dailyTransport:[{dayIndex:0,text:'商务车'}],
    },
  }, {mapDates:false});
  const validation = validateItineraryFacts(data);
  assert.equal(validation.valid, false);
  const codes = validation.issues.map((item) => item.code);
  assert.ok(codes.includes('included_source_count_mismatch'));
  assert.ok(codes.includes('daily_transport_source_missing'));
  assert.ok(codes.includes('transport_summary_source_missing'));
});
