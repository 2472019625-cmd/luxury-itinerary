import test from "node:test";
import assert from "node:assert/strict";
import { applySimpleSkillResults } from "../server/simple-pipeline-writeback.mjs";
import { selectCustomerRenderData } from "../server/customer-render-data.mjs";

test("hotel search-highlight copy writes into the product while source metadata stays internal", () => {
  const outputSchema = { type: "array", minItems: 4, maxItems: 4, items: { type: "object" } };
  const rows = [
    { key: "location", label: "位置", text: "坐落在河畔，可眺望草原。", status: "success", sourceUrl: "https://example.com/hotel", sourceClass: "search_highlight", checkedAt: "2026-09-24T00:00:00.000Z" },
    { key: "rooms", label: "客房", text: "套房设私人露台。", status: "success", sourceUrl: "https://example.com/hotel", sourceClass: "search_highlight", checkedAt: "2026-09-24T00:00:00.000Z" },
    { key: "design", label: "设计", text: "", status: "not_found" },
    { key: "facilities", label: "设施", text: "设有观景露台。", status: "success", sourceUrl: "https://example.com/hotel", sourceClass: "search_highlight", checkedAt: "2026-09-24T00:00:00.000Z" },
  ];
  const task = { targetId: "copy:hotel:1:fact-rows", targetPath: "hotels.0.factRows", moduleType: "hotel_fact_rows", outputSchema, required: false };
  const writeback = applySimpleSkillResults({
    preparedData: { hotels: [{ id: "hotel-1", officialName: "Example Hotel", factRows: [] }] },
    copyTasks: [task],
    copyExecution: { results: [{ targetId: task.targetId, targetPath: task.targetPath, status: "success", value: rows }] },
  });
  assert.equal(writeback.copyWriteback[0].status, "written");
  assert.deepEqual(writeback.data.hotels[0].factRows, rows);

  const customer = selectCustomerRenderData(writeback.data);
  assert.deepEqual(customer.hotels[0].factRows.map((row) => row.label), ["位置", "客房", "设施"]);
  assert.equal(customer.hotels[0].factRows[0].text, rows[0].text);
  assert.equal(JSON.stringify(customer).includes("https://example.com/hotel"), false);
  assert.equal(JSON.stringify(customer).includes("search_highlight"), false);
});
