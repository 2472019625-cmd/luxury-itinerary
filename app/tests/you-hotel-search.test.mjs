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

test("hotel snippets reject a different property sharing brand and region words", async () => {
  const result = await searchHotelHighlights({
    researchRequest: { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Mara River Lodge" },
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: { web: [
      { title: "Example Mara Plains Lodge", url: "https://example.com/mara-plains-lodge", contents: { highlights: ["Example Mara Plains Lodge has a pool beside the plains."] } },
      { title: "Example Mara River Lodge", url: "https://example.com/mara-river-lodge", contents: { highlights: ["Example Mara River Lodge has riverside suites and a pool."] } },
    ] } }) }),
  });
  assert.equal(result.searchSnippets.length, 1);
  assert.equal(result.searchSnippets[0].sourceUrl, "https://example.com/mara-river-lodge");
  assert.equal(result.searchSnippets[0].identityEvidence.method, "full_alias_phrase");
});

test("a shorter property name cannot absorb an extra branch word", async () => {
  const result = await searchHotelHighlights({
    researchRequest: { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Mara Lodge" }, apiKey: "test-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: { web: [
      { title: "Example Mara River Lodge", url: "https://example.com/example-mara-river-lodge/", contents: { highlights: ["Example Mara River Lodge has a pool."] } },
      { title: "Travel review", url: "https://example.com/hotels/example-mara-lodge/", contents: { highlights: ["Example Mara Lodge has a viewing deck."] } },
    ] } }) }),
  });
  assert.equal(result.searchSnippets.length, 1);
  assert.equal(result.searchSnippets[0].sourceUrl, "https://example.com/hotels/example-mara-lodge/");
});

test("a registered Chinese property alias remains valid for a canonical English hotel name", async () => {
  const result = await searchHotelHighlights({
    researchRequest: { researchType: "official_entity_facts", entityKind: "hotel", entityName: "The Ritz-Carlton, Masai Mara Safari Camp" }, apiKey: "test-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: { web: [
      { title: "丽思卡尔顿马赛马拉营地", url: "https://example.com/masai-mara-camp/", contents: { highlights: ["丽思卡尔顿马赛马拉营地设有公共休息空间，住客可在开阔的室内外区域欣赏营地周围的自然环境。"] } },
    ] } }) }),
  });
  assert.equal(result.searchSnippets.length, 1);
  assert.equal(result.searchSnippets[0].identityEvidence.matchedAlias, "丽思卡尔顿马赛马拉营地");
});

test("a one-distinctive-token hotel is accepted only with its full property name", async () => {
  const result = await searchHotelHighlights({
    researchRequest: { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Solio Lodge" }, apiKey: "test-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: { web: [
      { title: "Solio region overview", url: "https://example.com/solio", contents: { highlights: ["Solio region offers wildlife viewing and several lodging choices."] } },
      { title: "Solio Lodge", url: "https://example.com/solio-lodge", contents: { highlights: ["Solio Lodge has rooms and a viewing deck beside the reserve."] } },
    ] } }) }),
  });
  assert.equal(result.searchSnippets.length, 1);
  assert.equal(result.searchSnippets[0].sourceTitle, "Solio Lodge");
});
