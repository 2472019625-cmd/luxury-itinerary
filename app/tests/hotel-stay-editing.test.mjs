import assert from "node:assert/strict";
import test from "node:test";
import { applyHotelNightChange, planHotelNightChange } from "../src/lib/hotelStayEditing.js";

const data = {
  hotels: [
    { id: "a", officialName: "Hotel A", shortName: "甲酒店", nights: 1 },
    { id: "b", officialName: "Hotel B", shortName: "乙酒店", nights: 2 },
    { id: "c", officialName: "Hotel C", shortName: "丙酒店", nights: 1 },
  ],
  days: [
    { hotel: "Hotel A", hotelOfficialName: "Hotel A", hotelShortName: "甲酒店", overnightType: "hotel", routeNodes: ["机场", "甲酒店"], description: "抵达甲酒店" },
    { hotel: "Hotel B", hotelOfficialName: "Hotel B", hotelShortName: "乙酒店", overnightType: "hotel", routeNodes: ["甲酒店", "乙酒店"], description: "去乙酒店" },
    { hotel: "Hotel B", hotelOfficialName: "Hotel B", hotelShortName: "乙酒店", overnightType: "hotel", routeNodes: ["乙酒店"], description: "乙酒店休息" },
    { hotel: "Hotel C", hotelOfficialName: "Hotel C", hotelShortName: "丙酒店", overnightType: "hotel", routeNodes: ["丙酒店"], description: "去丙酒店" },
  ],
};

test("增加一家酒店晚数只从下一家转移一晚，其他内容保留", () => {
  const plan = planHotelNightChange(data, 0, 2);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changedDayIndexes, [1]);
  const next = applyHotelNightChange(data, plan);
  assert.deepEqual(next.hotels.map((hotel) => hotel.nights), [2, 1, 1]);
  assert.equal(next.days[1].hotel, "Hotel A");
  assert.deepEqual(next.days[1].routeNodes, data.days[1].routeNodes);
  assert.equal(next.days[1].description, data.days[1].description);
  assert.equal(data.days[1].hotel, "Hotel B");
});

test("减少一家酒店晚数把边界住宿日交给下一家", () => {
  const plan = planHotelNightChange(data, 1, 1);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changedDayIndexes, [2]);
  assert.deepEqual(applyHotelNightChange(data, plan).hotels.map((hotel) => hotel.nights), [1, 1, 2]);
});

test("最后一家酒店可从前一家转移晚数", () => {
  const plan = planHotelNightChange(data, 2, 2);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changedDayIndexes, [2]);
  assert.deepEqual(applyHotelNightChange(data, plan).hotels.map((hotel) => hotel.nights), [1, 1, 2]);
});

test("不会把相邻酒店减到零晚", () => {
  assert.equal(planHotelNightChange(data, 0, 4).ok, false);
});
