import test from "node:test";
import assert from "node:assert/strict";
import { buildWebFactSearchRequest, requestWebFactSearch, verifyWebFactSources, WEB_FACT_SEARCH_MODEL } from "../server/agent-web-fact-search.mjs";

const verificationItems = [{ subject: "Example Lodge", field: "officialFacilities", reason: "核验酒店官方设施" }];

test("联网事实核验固定使用搜索模型且只核验已有实体", () => {
  const request = buildWebFactSearchRequest({ factBasis: { hotels: [{ name: "Example Lodge" }] }, verificationItems });
  assert.equal(request.model, WEB_FACT_SEARCH_MODEL);
  assert.match(request.messages[0].content, /不新增客户行程/);
  assert.match(request.messages[0].content, /internalSuggestions/);
});

test("只有真实可访问来源才能成为采用事实，新发现体验留在内部建议", async () => {
  const result = await verifyWebFactSources({
    verificationItems,
    parsed: {
      facts: [
        { subject: "Example Lodge", field: "officialFacilities", statement: "设有泳池", status: "verified", sourceName: "酒店官网", sourceUrl: "https://hotel.example/facilities", sourceTier: "official" },
        { subject: "New Experience", field: "activity", statement: "新增热气球", status: "verified", sourceName: "供应商", sourceUrl: "https://supplier.example/balloon" },
      ],
      internalSuggestions: [],
    },
    fetchSource: async () => ({ ok: true, status: 200 }),
    verifiedAt: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(result.adoptedFacts.length, 1);
  assert.equal(result.adoptedFacts[0].sourceName, "酒店官网");
  assert.equal(result.internalSuggestions.length, 1);
  assert.equal(result.internalSuggestions[0].customerFacing, false);
});

test("来源不可访问时降级为未核验，不伪造采用事实", async () => {
  const result = await verifyWebFactSources({
    verificationItems,
    parsed: { facts: [{ subject: "Example Lodge", field: "officialFacilities", statement: "设有泳池", status: "verified", sourceUrl: "https://bad.example" }] },
    fetchSource: async () => { throw new Error("unreachable"); },
  });
  assert.equal(result.adoptedFacts.length, 0);
  assert.equal(result.unverified[0].status, "unverified");
});

test("接口请求拒绝替换指定模型", async () => {
  await assert.rejects(() => requestWebFactSearch({ apiKey: "test", baseUrl: "https://api.example/v1", factBasis: {}, verificationItems, model: "other", fetchImpl: async () => { throw new Error("不应调用"); } }), /必须为/);
});
