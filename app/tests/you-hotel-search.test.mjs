import assert from "node:assert/strict";
import test from "node:test";
import { searchHotelHighlights } from "../server/you-hotel-search.mjs";

test("You hotel search uses only the formal hotel name and retains matching highlights", async () => {
  let request;
  const result = await searchHotelHighlights({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example River Lodge", entityKind: "hotel" },
    apiKey: "test-key",
    checkedAt: "2026-09-24T00:00:00.000Z",
    fetchImpl: async (_url, options) => {
      request = { headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ results: { web: [
        { title: "Example River Lodge", url: "https://example.com/river-lodge", contents: { highlights: ["Example River Lodge has six suites overlooking the river."] } },
        { title: "Another River Lodge", url: "https://other.com/lodge", contents: { highlights: ["Another River Lodge has a pool and guest rooms."] } },
      ] } }) };
    },
  });
  assert.equal(request.body.query, "Example River Lodge");
  assert.equal(request.body.count, 10);
  assert.equal(request.body.extraction.extraction_mode, "highlights");
  assert.equal(request.headers["X-API-Key"], "test-key");
  assert.equal(result.searchSnippets.length, 1);
  assert.equal(result.searchSnippets[0].sourceUrl, "https://example.com/river-lodge");
  assert.equal(result.searchSnippets[0].sourceClass, "search_highlight");
  assert.deepEqual(result.verifiedFacts, []);
});

test("You hotel search keeps empty result separate from a failed request", async () => {
  const request = { researchType: "official_entity_facts", entityName: "Example Lodge", entityKind: "hotel" };
  const empty = await searchHotelHighlights({ researchRequest: request, apiKey: "test-key", fetchImpl: async () => ({ ok: true, json: async () => ({ results: { web: [] } }) }) });
  assert.equal(empty.status, "not_found");
  await assert.rejects(searchHotelHighlights({ researchRequest: request, apiKey: "test-key", fetchImpl: async () => ({ ok: false, status: 503 }) }), { code: "you_hotel_search_failed" });
});
