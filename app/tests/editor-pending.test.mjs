import assert from "node:assert/strict";
import test from "node:test";
import { groupPendingItems, hotelFactPendingItems } from "../src/lib/editorPending.js";

test("酒店四项按一家酒店归为一条，人工填写和确认留空均消除缺项", () => {
  const hotels = [{ id: "h1", shortName: "示例营地", factRows: [
    { key: "location", text: "保护区内" },
    { key: "rooms", text: "", status: "not_found" },
    { key: "design", text: "", status: "confirmed_empty" },
    { key: "facilities", text: "", status: "not_found" },
  ] }];
  const issues = hotelFactPendingItems(hotels);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].missingFields.map((field) => field.key), ["rooms", "facilities"]);
  hotels[0].factRows[1].text = "十间帐篷";
  assert.deepEqual(hotelFactPendingItems(hotels)[0].missingFields.map((field) => field.key), ["facilities"]);
  hotels[0].factRows[3].status = "confirmed_empty";
  assert.equal(hotelFactPendingItems(hotels).length, 0);
});

test("待处理按文案、图片状态、酒店信息分类", () => {
  const items = [{ kind: "copy", id: "c" }, { kind: "image", id: "a" }, { kind: "image", id: "b" }, { kind: "hotel_fact", id: "h" }];
  const review = { slots: [{ slotId: "a", status: "candidate_waiting", selectableCandidateIds: ["1"] }, { slotId: "b", status: "not_found", selectableCandidateIds: [] }] };
  assert.deepEqual(groupPendingItems(items, review).map((group) => group.label), ["文案", "图片需确认", "图片未找到", "酒店信息"]);
});
