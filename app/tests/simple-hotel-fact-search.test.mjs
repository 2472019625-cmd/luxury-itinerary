import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { searchSimpleHotelFacts } from "../server/simple-hotel-fact-search.mjs";
import { saveSimpleHotelFactRow } from "../server/simple-manual-images.mjs";
import { selectCustomerRenderData } from "../server/customer-render-data.mjs";
import { fixture } from "./support/manual-image-fixture.mjs";

function hotelStore() {
  const hotel = { id: "h1", officialName: "Example Lodge", factRows: [{ key: "location", label: "位置", text: "人工写的位置", status: "success", confirmedByUser: true }, { key: "design", label: "设计", text: "", status: "not_found" }] };
  const task = { targetId: "copy:hotel:h1:fact-rows", targetPath: "hotels.0.factRows", moduleType: "hotel_fact_rows", facts: {}, researchRequest: { entityName: "Example Lodge", categories: ["位置", "客房", "设计", "设施"] }, plannerGoal: "酒店信息" };
  const result = { data: { hotels: [hotel] } };
  const store = { getProject: () => ({ activeExecutionRunId: "r1", activePlanId: "p1" }), getExecutionRun: () => ({ executionRunId: "r1" }), getPlan: () => ({ copyTasks: [task], itineraryContext: {} }), getFinalResult: () => result };
  return { store, hotel, result, task };
}

test("按酒店补全只请求空项，不覆盖已有文字，并保留来源", async () => {
  const { store, hotel, result } = hotelStore();
  const calls = [];
  const searched = await searchSimpleHotelFacts({ store, root: "/tmp", projectId: "p1", hotelIndex: 0, hotelId: "h1", keys: ["location", "design"], mode: "fill", runCopy: async ({ tasks }) => {
    assert.deepEqual(tasks[0].researchRequest.focusCategories, ["design"]);
    return { results: [{ targetId: tasks[0].targetId, value: [{ key: "location", text: "不应覆盖", status: "success", sourceUrl: "https://example.com" }, { key: "design", text: "开放式木作空间", status: "success", sourceUrl: "https://example.com", sourceExcerpt: "来源摘录" }] }] };
  }, saveRow: async (input) => { calls.push(input); result.data.hotels[0].factRows.push({ key: input.key, text: input.text }); return { applied: true, row: { key: input.key, text: input.text } }; } });
  assert.deepEqual(calls.map((item) => item.key), ["design"]);
  assert.equal(calls[0].source.sourceExcerpt, "来源摘录");
  assert.equal(hotel.factRows[0].text, "人工写的位置");
  assert.equal(searched.appliedRows.length, 1);
});

test("已有文字重新查找只返回候选，未经确认不写入", async () => {
  const { store } = hotelStore();
  let saved = false;
  const result = await searchSimpleHotelFacts({ store, root: "/tmp", projectId: "p1", hotelIndex: 0, hotelId: "h1", keys: ["location"], mode: "suggest", runCopy: async ({ tasks }) => ({ results: [{ targetId: tasks[0].targetId, value: [{ key: "location", text: "新的位置描述", status: "success", sourceUrl: "https://example.com" }] }] }), saveRow: async () => { saved = true; } });
  assert.equal(saved, false);
  assert.equal(result.expectedText, "人工写的位置");
  assert.equal(result.candidates[0].text, "新的位置描述");
});

test("批量补全逐字段聚焦，单项失败不影响其他字段保存", async () => {
  const { store, result } = hotelStore();
  const requested = [];
  const saved = [];
  const response = await searchSimpleHotelFacts({ store, root: "/tmp", projectId: "p1", hotelIndex: 0, hotelId: "h1", keys: ["rooms", "design", "facilities"], mode: "fill", runCopy: async ({ tasks }) => {
    const [key] = tasks[0].researchRequest.focusCategories;
    requested.push(key);
    if (key === "design") throw new Error("search unavailable");
    return { results: [{ targetId: tasks[0].targetId, value: [{ key, text: `${key} fact`, status: "success", sourceUrl: "https://example.com/source" }] }] };
  }, saveRow: async (input) => {
    saved.push(input.key);
    result.data.hotels[0].factRows.push({ key: input.key, text: input.text });
    return { applied: true, row: { key: input.key, text: input.text } };
  } });
  assert.deepEqual(requested, ["rooms", "design", "facilities"]);
  assert.deepEqual(saved, ["rooms", "facilities"]);
  assert.deepEqual(response.missingKeys, ["design"]);
  assert.deepEqual(response.failedKeys, ["design"]);
});

test("服务端逐项保存：只补空项、过期替换拒绝、来源不进入客户成品", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const current = value.store.getFinalResult(value.projectId, value.executionRunId);
  current.data.hotels = [{ id: "h1", officialName: "Example Lodge", factRows: [{ key: "location", label: "位置", text: "人工旧文", status: "success" }] }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, current);
  const render = async ({ mode }) => ({ status: "success", mode, outputPath: "test.png" });
  const ignored = await saveSimpleHotelFactRow({ ...value, hotelIndex: 0, hotelId: "h1", key: "location", text: "搜索新文", mode: "fill", source: { sourceUrl: "https://example.com" }, render });
  assert.equal(ignored.applied, false);
  await assert.rejects(saveSimpleHotelFactRow({ ...value, hotelIndex: 0, hotelId: "h1", key: "location", text: "搜索新文", mode: "replace", expectedText: "过期旧文", source: { sourceUrl: "https://example.com" }, render }), { code: "hotel_fact_changed" });
  const saved = await saveSimpleHotelFactRow({ ...value, hotelIndex: 0, hotelId: "h1", key: "design", text: "自然木作", mode: "fill", source: { sourceUrl: "https://example.com", sourceExcerpt: "公开网页摘要" }, render });
  assert.equal(saved.applied, true);
  const actual = value.store.getFinalResult(value.projectId, value.executionRunId).data.hotels[0].factRows.find((row) => row.key === "design");
  assert.equal(actual.sourceExcerpt, "公开网页摘要");
  assert.equal(selectCustomerRenderData({ hotels: [{ id: "h1", factRows: [actual] }] }).hotels[0].factRows[0].sourceUrl, undefined);
});

test("空白酒店事实可由定制师明确确认留空，但不能清掉已有内容", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const current = value.store.getFinalResult(value.projectId, value.executionRunId);
  current.data.hotels = [{ id: "h1", officialName: "Example Lodge", factRows: [
    { key: "location", label: "位置", text: "保护区内", status: "success" },
    { key: "rooms", label: "客房", text: "", status: "not_found" },
  ] }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, current);
  const render = async ({ mode }) => ({ status: "success", mode, outputPath: "test.png" });
  const saved = await saveSimpleHotelFactRow({ ...value, hotelIndex: 0, hotelId: "h1", key: "rooms", text: "", mode: "confirm_blank", render });
  assert.equal(saved.row.status, "confirmed_empty");
  assert.equal(saved.row.confirmedByUser, true);
  await assert.rejects(saveSimpleHotelFactRow({ ...value, hotelIndex: 0, hotelId: "h1", key: "location", text: "", mode: "confirm_blank", render }), { code: "hotel_fact_not_blank" });
});
