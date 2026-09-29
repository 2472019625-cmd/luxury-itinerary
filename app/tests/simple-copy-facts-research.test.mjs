import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCopyFactsResearchRequest,
  copyResearchStateKey,
  requestCopyFactsResearch,
  runCopyFactsResearch,
  validateCopyResearchRequest,
  verifyCopyFactsResearch,
} from "../server/simple-copy-facts-research.mjs";

function textResponse(body, contentType = "text/html; charset=utf-8", url = "https://example.com/") {
  return { ok: true, status: 200, url, headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null }, text: async () => body };
}

test("Copy Facts Research 只接受两类显式请求", () => {
  assert.deepEqual(validateCopyResearchRequest({ researchType: "official_entity_facts", entityName: "Singita Faru Faru Lodge", categories: ["景观"] }), []);
  assert.deepEqual(validateCopyResearchRequest({ researchType: "authoritative_current_facts", entityName: "坦桑尼亚入境要求", categories: ["签证"] }), []);
  assert.match(validateCopyResearchRequest({ researchType: "hotel_search", entityName: "x", categories: ["x"] })[0], /仅支持/);
  const prompt = buildCopyFactsResearchRequest({ researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["空间"] } });
  assert.match(prompt.messages[0].content, /公开研究只能补充实体客观是什么、有什么/);
  assert.match(prompt.messages[0].content, /实体\/品牌官网与 Fact Sheet/);
  assert.match(prompt.messages[0].content, /禁止采用博客、论坛、用户评论、社交平台、百科和图片/);
  assert.equal(Object.hasOwn(prompt, "response_format"), false);
  assert.match(prompt.messages[0].content, /1—3 个相互独立的候选页面/);
});

test("hotel uses You highlights when configured and leaves dining on the existing researcher", async () => {
  const hotelRequest = { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Lodge", categories: ["位置", "客房", "设计", "设施"] };
  let hotelSearchCalls = 0;
  const hotel = await runCopyFactsResearch({
    researchRequest: hotelRequest,
    hotelSearchApiKey: "test-you-key",
    hotelSearch: async ({ researchRequest, apiKey }) => {
      hotelSearchCalls += 1;
      assert.equal(apiKey, "test-you-key");
      assert.equal(researchRequest.entityName, "Example Lodge");
      return { status: "success", provider: "you_web_search_highlights", searchSnippets: [{ sourceUrl: "https://example.com/lodge", sourceExcerpt: "Example Lodge has six suites." }], verifiedFacts: [] };
    },
    requestResearch: async () => { throw new Error("legacy researcher should not run"); },
  });
  assert.equal(hotelSearchCalls, 1);
  assert.equal(hotel.provider, "you_web_search_highlights");
  assert.equal(hotel.searchSnippets.length, 1);
});

test("hotel highlights share the durable research claim and result across reentry", async () => {
  const researchStateStore = memoryResearchState();
  let calls = 0;
  const options = {
    researchRequest: { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Lodge", categories: ["位置"] },
    researchStateStore,
    hotelSearchApiKey: "test-you-key",
    hotelSearch: async () => {
      calls += 1;
      return { status: "success", provider: "you_web_search_highlights", searchSnippets: [{ sourceUrl: "https://example.com/lodge", sourceExcerpt: "Example Lodge has six suites." }], verifiedFacts: [] };
    },
    requestResearch: async () => { throw new Error("legacy researcher should not run"); },
  };
  const first = await runCopyFactsResearch(options);
  const repeated = await runCopyFactsResearch(options);
  assert.equal(first.provider, "you_web_search_highlights");
  assert.equal(calls, 1);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.invocationBusinessCalls, 0);
});

test("hotel search technical failure preserves the previous researcher as fallback", async () => {
  const researchRequest = { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Lodge", categories: ["位置"] };
  let legacyCalls = 0;
  const result = await runCopyFactsResearch({
    researchRequest,
    hotelSearchApiKey: "test-you-key",
    hotelSearch: async () => { throw Object.assign(new Error("upstream unavailable"), { code: "you_hotel_search_failed" }); },
    requestResearch: async () => {
      legacyCalls += 1;
      return { json: { facts: [] }, attemptUsages: [{}] };
    },
  });
  assert.equal(legacyCalls, 1);
  assert.equal(result.provider, "legacy_facts_research_fallback");
  assert.equal(result.hotelSearchFailure.code, "you_hotel_search_failed");
});

test("Dining Facts Research 只研究指定实体中的当前餐饮 focus", () => {
  const prompt = buildCopyFactsResearchRequest({
    researchRequest: {
      researchType: "official_entity_facts",
      entityName: "Example Safari Camp",
      entityKind: "dining",
      focus: "Sundowner",
      categories: ["餐饮形式", "体验特色"],
    },
  });
  assert.match(prompt.messages[0].content, /只研究指定餐厅或明确酒店中的 focus 体验/);
  assert.match(prompt.messages[0].content, /餐饮研究总计最多返回两条事实/);
  assert.match(prompt.messages[0].content, /不得把酒店其他餐厅、泛化菜单/);
  assert.match(prompt.messages[1].content, /"entityKind":"dining"/);
  assert.match(prompt.messages[1].content, /"focus":"Sundowner"/);
});

test("Facts Research 非法 JSON 或结构只在当前研究调用内技术重试", async () => {
  const payloads = [
    { choices: [{ message: { content: '{"facts":[{"category":"景观"' }, finish_reason: "stop" }] },
    { choices: [{ message: { content: JSON.stringify({ facts: [{ category: "景观", fact: "面向河岸。", sourceUrl: "https://example.com/lodge", sourceExcerpt: "river setting" }] }) }, finish_reason: "stop" }] },
    { choices: [{ message: { content: JSON.stringify({ facts: [{ category: "景观", fact: "面向河岸。", sources: [{ sourceUrl: "https://example.com/lodge", sourceExcerpt: "river setting", sourceMediaType: "page" }] }] }) }, finish_reason: "stop" }] },
  ];
  const requestBodies = [];
  const result = await requestCopyFactsResearch({
    apiKey: "test-key",
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["景观"] },
    emptyContentRetries: 2,
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => payloads.shift() };
    },
  });
  assert.equal(requestBodies.length, 3);
  assert.equal(Object.hasOwn(requestBodies[0], "response_format"), false);
  assert.equal(result.attemptUsages[0].outcome, "invalid_json");
  assert.equal(result.attemptUsages[1].outcome, "invalid_structure");
  assert.equal(result.json.facts[0].sources.length, 1);
});

test("Faru Faru 与 Sabora 可从 Singita 官方页面形成结构化 verifiedFacts", async () => {
  const cases = [
    {
      entityName: "Singita Faru Faru Lodge",
      category: "景观与环境",
      fact: "酒店位于 Grumeti 保护区，空间面向河岸环境。",
      sourceUrl: "https://singita.com/lodge/singita-faru-faru-lodge/",
      sourceExcerpt: "Grumeti Reserve riverine setting",
    },
    {
      entityName: "Singita Sabora Tented Camp",
      category: "住宿体验",
      fact: "营地采用帐篷式住宿空间，强调贴近草原环境的居停体验。",
      sourceUrl: "https://singita.com/lodge/singita-sabora-tented-camp/",
      sourceExcerpt: "tented camp on the plains",
    },
  ];
  for (const item of cases) {
    const result = await runCopyFactsResearch({
      researchRequest: { researchType: "official_entity_facts", entityName: item.entityName, categories: [item.category] },
      requestResearch: async () => ({ json: { facts: [{ ...item, sourceMediaType: "page" }] }, model: "research-fixture" }),
      fetchSource: async () => textResponse(`<main>${item.sourceExcerpt}</main>`, undefined, item.sourceUrl),
    });
    assert.equal(result.status, "success");
    assert.equal(result.researchType, "official_entity_facts");
    assert.equal(result.entityName, item.entityName);
    assert.deepEqual(Object.keys(result.verifiedFacts[0]), ["category", "fact", "sourceUrl", "sourceExcerpt", "sourceClass", "checkedAt"]);
    assert.match(result.verifiedFacts[0].sourceUrl, /^https:\/\/singita\.com\//);
  }
});

test("第三方来源、图片和订单购买推断不会进入 verifiedFacts", async () => {
  const researchRequest = { researchType: "official_entity_facts", entityName: "Singita Faru Faru Lodge", categories: ["空间", "订单"] };
  const result = await verifyCopyFactsResearch({
    researchRequest,
    candidates: [
      { category: "空间", fact: "设有泳池", sourceUrl: "https://www.tripadvisor.com/example", sourceExcerpt: "pool", sourceMediaType: "page" },
      { category: "空间", fact: "设有泳池", sourceUrl: "https://singita.evil.example.com/fake", sourceExcerpt: "pool", sourceMediaType: "page" },
      { category: "空间", fact: "设有泳池", sourceUrl: "https://singita.com/media/pool.jpg", sourceExcerpt: "pool", sourceMediaType: "image" },
      { category: "订单", fact: "本次订单已包含河景套房", sourceUrl: "https://singita.com/lodge/singita-faru-faru-lodge/", sourceExcerpt: "river suite", sourceMediaType: "page" },
    ],
    fetchSource: async () => textResponse("pool river suite"),
  });
  assert.equal(result.verifiedFacts.length, 0);
  assert.deepEqual(result.rejected.map((item) => item.reason).sort(), ["source_not_approved", "source_not_official_or_authoritative", "image_not_fact_evidence", "order_fact_not_researchable"].sort());
});

test("权威时效事实仅接受政府、正式组织或声明的运营方域名", async () => {
  const researchRequest = { researchType: "authoritative_current_facts", entityName: "坦桑尼亚入境要求", categories: ["入境"], officialDomains: ["immigration.go.tz"] };
  const result = await verifyCopyFactsResearch({
    researchRequest,
    candidates: [
      { category: "入境", fact: "旅客应在出发前核对当前入境要求。", sourceUrl: "https://immigration.go.tz/index.php/entry-requirements", sourceExcerpt: "entry requirements", sourceMediaType: "page" },
      { category: "入境", fact: "网文称要求已经变化。", sourceUrl: "https://example-travel-blog.com/tanzania", sourceExcerpt: "changed", sourceMediaType: "page" },
    ],
    fetchSource: async (url) => textResponse("official entry requirements", undefined, url),
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.match(result.verifiedFacts[0].sourceUrl, /immigration\.go\.tz/);
  assert.equal(result.rejected[0].reason, "category_fact_limit_exceeded");
});

test("母品牌官方域可通过页面实体身份二次核验，普通第三方内容页仍拒绝", async () => {
  const researchRequest = { researchType: "official_entity_facts", entityName: "Riverside Retreat Lodge", categories: ["空间与设计", "景观与环境"] };
  const officialBody = `
    <html><head>
      <title>Riverside Retreat Lodge | Official Site</title>
      <link rel="canonical" href="https://globalhospitality.example/hotels/riverside-retreat/">
      <script type="application/ld+json">{"@type":"Hotel","name":"Riverside Retreat Lodge","brand":{"@type":"Brand","name":"Global Hospitality"}}</script>
    </head><body><h1>Riverside Retreat Lodge</h1><p>Designed around a central river courtyard.</p><a>Book now</a></body></html>`;
  const blogBody = `
    <html><head><title>Riverside Retreat Lodge review</title><link rel="canonical" href="https://travelstories.example/riverside-retreat/">
      <script type="application/ld+json">{"@type":"BlogPosting","name":"Riverside Retreat Lodge review"}</script>
    </head><body><p>Views across the river valley.</p></body></html>`;
  const result = await verifyCopyFactsResearch({
    researchRequest,
    candidates: [
      { category: "空间与设计", fact: "空间围绕中央河景庭院展开。", sourceUrl: "https://globalhospitality.example/hotels/riverside-retreat/", sourceExcerpt: "Designed around a central river courtyard", sourceMediaType: "page" },
      { category: "景观与环境", fact: "面向河谷。", sourceUrl: "https://travelstories.example/riverside-retreat/", sourceExcerpt: "Views across the river valley", sourceMediaType: "page" },
    ],
    fetchSource: async (url) => url.includes("globalhospitality") ? textResponse(officialBody, undefined, url) : textResponse(blogBody, undefined, url),
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.match(result.verifiedFacts[0].sourceUrl, /globalhospitality/);
  assert.equal(result.rejected[0].reason, "source_not_official_or_authoritative");
});

test("酒店目录页不能冒充母品牌官网，认可的行业来源保留外部来源身份", async () => {
  const directoryUrl = "https://hotel-directory.example/example-lodge";
  const tradeUrl = "https://www.forbestravelguide.com/hotels/example-lodge";
  const directoryBody = `<html><head><title>Example Lodge</title><link rel="canonical" href="${directoryUrl}"><script type="application/ld+json">{"@type":"Hotel","name":"Example Lodge","brand":{"@type":"Brand","name":"Example Lodge"}}</script></head><body><h1>Example Lodge</h1><p>near the river with a pool</p><a>Book now</a></body></html>`;
  const tradeBody = `<html><head><title>Example Lodge - Forbes Travel Guide</title></head><body><h1>Example Lodge</h1><p>near the river</p></body></html>`;
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["位置", "设施"] },
    candidates: [
      { category: "设施", fact: "设有泳池。", sourceUrl: directoryUrl, sourceExcerpt: "pool", sourceMediaType: "page" },
      { category: "位置", fact: "靠近河岸。", sourceUrl: tradeUrl, sourceExcerpt: "near the river", sourceMediaType: "page", sourceClass: "trusted_trade_media" },
    ],
    fetchSource: async (url) => textResponse(url === tradeUrl ? tradeBody : directoryBody, undefined, url),
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.verifiedFacts[0].sourceClass, "trusted_trade_media");
  assert.equal(result.rejected[0].reason, "source_not_official_or_authoritative");
});

test("事实核验使用浏览器化请求头、www 技术兜底并限制每类别一条", async () => {
  const researchRequest = { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["景观与环境"] };
  const seen = [];
  const result = await verifyCopyFactsResearch({
    researchRequest,
    candidates: [
      { category: "景观与环境", fact: "面向河岸环境。", sourceUrl: "https://example.com/lodge", sourceExcerpt: "river setting", sourceMediaType: "page" },
      { category: "景观与环境", fact: "第二条同类事实。", sourceUrl: "https://example.com/other", sourceExcerpt: "second fact", sourceMediaType: "page" },
    ],
    fetchSource: async (url, options) => {
      seen.push({ url, headers: options.headers });
      if (!url.includes("www.")) return { ok: false, status: 403, url, headers: { get: () => "text/html" }, text: async () => "blocked" };
      return textResponse("<p>river setting</p>", undefined, url);
    },
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.rejected[0].reason, "category_fact_limit_exceeded");
  assert.equal(seen.length, 2);
  assert.match(seen[0].headers["user-agent"], /Chrome/);
  assert.match(seen[0].headers.accept, /application\/xhtml\+xml/);
  assert.equal(seen[1].url, "https://www.example.com/lodge");
});

test("普通 HTTP 被官方站拦截时可用受控浏览器核验同一官方页面", async () => {
  const sourceUrl = "https://example.com/lodge";
  let browserCalls = 0;
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["空间与设计"] },
    candidates: [{ category: "空间与设计", fact: "空间采用本地石材。", sourceUrl, sourceExcerpt: "locally sourced stone", sourceMediaType: "page" }],
    fetchSource: async (url) => ({ ok: false, status: 403, url, headers: { get: () => "text/html" }, text: async () => "blocked" }),
    fetchBrowserSource: async (url) => {
      browserCalls += 1;
      return textResponse("<title>Example Lodge</title><p>Built with locally sourced stone.</p>", undefined, url);
    },
  });
  assert.equal(browserCalls, 1);
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.rejected.length, 0);
});

test("搜索跳转链接最终落到实体官网时按最终官方 URL 核验和保存", async () => {
  const redirectUrl = "https://search-gateway.example/redirect/opaque-token";
  const officialUrl = "https://examplelodge.com/stay/example-lodge/";
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["景观与环境"] },
    candidates: [{ category: "景观与环境", fact: "面向河岸环境。", sourceUrl: redirectUrl, sourceExcerpt: "river setting", sourceMediaType: "page" }],
    fetchSource: async (url) => ({ ok: false, status: 403, url, headers: { get: () => "text/html" }, text: async () => "blocked" }),
    fetchBrowserSource: async () => textResponse("<p>river setting</p>", undefined, officialUrl),
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.verifiedFacts[0].sourceUrl, officialUrl);
  assert.equal(result.rejected.length, 0);
});

test("同一事实的首个官方候选不可用时继续核验后续候选", async () => {
  const unavailableUrl = "https://example.com/missing";
  const workingUrl = "https://example.com/lodge";
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["景观与环境"] },
    candidates: [{
      category: "景观与环境",
      fact: "面向河岸环境。",
      sources: [
        { sourceUrl: unavailableUrl, sourceExcerpt: "river setting", sourceMediaType: "page" },
        { sourceUrl: workingUrl, sourceExcerpt: "river setting", sourceMediaType: "page" },
      ],
    }],
    fetchSource: async (url) => url === workingUrl
      ? textResponse("<p>river setting</p>", undefined, url)
      : { ok: false, status: 404, url, headers: { get: () => "text/html" }, text: async () => "" },
    fetchBrowserSource: null,
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.verifiedFacts[0].sourceUrl, workingUrl);
  assert.equal(result.rejected[0].sourceUrl, unavailableUrl);
  assert.equal(result.rejected[0].reason, "source_unavailable");
});

test("HTTP 200 的品牌官网软 404 仍按来源不可用拒绝", async () => {
  const sourceUrl = "https://parentbrand.example/hotels/example-lodge/dining";
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["公共空间"] },
    candidates: [{ category: "公共空间", fact: "设有观景餐厅。", sourceUrl, sourceExcerpt: "restaurant", sourceMediaType: "page" }],
    fetchSource: async () => textResponse("<title>Sorry! - Page Not Found (404 Error)</title><p>restaurant directory</p>", undefined, sourceUrl),
  });
  assert.equal(result.verifiedFacts.length, 0);
  assert.equal(result.rejected[0].reason, "source_unavailable");
});

test("官方候选成功后不再访问同字段的外部候选", async () => {
  const visited = [];
  const officialUrl = "https://examplelodge.com/location";
  const externalUrl = "https://www.sleepermagazine.com/stories/projects/example-lodge/";
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["位置"] },
    candidates: [{
      category: "位置",
      fact: "酒店位于河岸保护区。",
      sources: [
        { sourceUrl: externalUrl, sourceExcerpt: "Example Lodge sits in the riverside reserve", sourceMediaType: "page", sourceClass: "trusted_trade_media" },
        { sourceUrl: officialUrl, sourceExcerpt: "riverside reserve", sourceMediaType: "page", sourceClass: "official_entity" },
      ],
    }],
    fetchSource: async (url) => {
      visited.push(url);
      return textResponse("<title>Example Lodge</title><p>riverside reserve</p>", undefined, url);
    },
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.verifiedFacts[0].sourceClass, "official_entity");
  assert.deepEqual(visited, [officialUrl]);
});

test("HTTP 200 图片响应不能按页面正文核验，同一失效 URL 不重复抓取", async () => {
  const url = "https://examplelodge.com/downloadimg";
  let fetches = 0;
  const result = await verifyCopyFactsResearch({
    researchRequest: { ...hotelResearch, categories: ["客房", "设计"] },
    candidates: [fixtureFact("客房", url), fixtureFact("设计", url)],
    fetchSource: async () => { fetches += 1; return textResponse("Example Lodge river courtyard rooms pool", "image/jpeg", url); },
    fetchBrowserSource: null,
  });
  assert.equal(fetches, 1);
  assert.equal(result.verifiedFacts.length, 0);
  assert.deepEqual(result.rejected.map((item) => item.reason), ["image_not_fact_evidence", "duplicate_failed_source_url"]);
  assert.equal(result.rejected[0].verificationAttempts[0].contentType, "image/jpeg");
});

test("同页错误摘录只拒该断言，另一类别可复用正文核验", async () => {
  const url = "https://examplelodge.com/facts";
  let fetches = 0;
  const pages = [];
  const body = "<title>Example Lodge</title><p>Example Lodge has a pool</p>";
  const result = await verifyCopyFactsResearch({ researchRequest: { ...hotelResearch, categories: ["位置", "设施"] },
    candidates: [
      { ...fixtureFact("位置", url), sources: [{ fact: "位置的公开资料。", sourceUrl: url, sourceExcerpt: "not on this page", sourceMediaType: "page" }] },
      { ...fixtureFact("设施", url), sources: [{ fact: "设施的公开资料。", sourceUrl: url, sourceExcerpt: "Example Lodge has a pool", sourceMediaType: "page" }] },
    ],
    fetchSource: async () => { fetches += 1; return textResponse(body, undefined, url); }, fetchBrowserSource: null,
    onSourcePage: async (page) => pages.push(structuredClone(page)),
  });
  assert.equal(fetches, 1);
  assert.equal(pages.length, 1, "同页缓存复用不产生额外请求或重复证据");
  assert.equal(pages[0].body, body);
  assert.equal(pages[0].finalUrl, url);
  assert.ok(pages[0].fetchedAt);
  assert.equal(result.rejected[0].reason, "source_excerpt_not_supported");
  assert.deepEqual(result.verifiedFacts.map((item) => item.category), ["设施"]);
});

test("明确 404 不再用浏览器重复请求同一失效页", async () => {
  let browserCalls = 0;
  const url = "https://examplelodge.com/rooms/missing";
  const result = await verifyCopyFactsResearch({ researchRequest: { ...hotelResearch, categories: ["客房"] }, candidates: [fixtureFact("客房", url)],
    fetchSource: async (candidateUrl) => ({ ok: false, status: 404, url: candidateUrl, headers: { get: () => "text/html" } }),
    fetchBrowserSource: async () => { browserCalls += 1; return fixturePage(url); },
  });
  assert.equal(browserCalls, 0);
  assert.equal(result.rejected[0].reason, "source_unavailable");
});

test("content_filter 与空正文保留技术失败", async () => {
  for (const finishReason of ["content_filter", "stop"]) {
    await assert.rejects(requestCopyFactsResearch({
      apiKey: "fixture-key", researchRequest: hotelResearch, emptyContentRetries: 0,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: finishReason, message: { content: "" } }] }) }),
    }), (error) => error.code === (finishReason === "content_filter" ? "copy_facts_research_content_filtered" : "copy_facts_research_empty"));
  }
});

test("品牌官网页面必须绑定当前酒店，不能把同品牌另一城市门店的事实写入", async () => {
  const request = { researchType: "official_entity_facts", entityKind: "hotel", entityName: "JW Marriott Hotel Nairobi", location: "Nairobi", categories: ["设施"], officialDomains: ["marriott.example"] };
  const candidate = { category: "设施", fact: "设有屋顶泳池。", sourceUrl: "https://marriott.example/hotels/jw-marriott-hotel-mombasa/", sourceExcerpt: "rooftop pool", sourceMediaType: "page" };
  const wrong = await verifyCopyFactsResearch({ researchRequest: request, candidates: [candidate],
    fetchSource: async (url) => textResponse("<title>JW Marriott Hotel Mombasa</title><h1>JW Marriott Hotel Mombasa</h1><p>rooftop pool</p>", undefined, url), fetchBrowserSource: null });
  assert.equal(wrong.verifiedFacts.length, 0);
  assert.equal(wrong.rejected[0].reason, "entity_identity_unproven");
  const correctUrl = "https://marriott.example/hotels/jw-marriott-hotel-nairobi/";
  const correct = await verifyCopyFactsResearch({ researchRequest: request, candidates: [{ ...candidate, sourceUrl: correctUrl }],
    fetchSource: async (url) => textResponse("<title>JW Marriott Hotel Nairobi</title><h1>JW Marriott Hotel Nairobi</h1><p>rooftop pool</p>", undefined, url), fetchBrowserSource: null });
  assert.equal(correct.verifiedFacts.length, 1);
  assert.equal(correct.verifiedFacts[0].sourceClass, "official_entity");
});

test("酒店官方域跳转到未受控域不能继续按官方事实采用", async () => {
  const original = "https://marriott.example/hotels/jw-marriott-hotel-nairobi/";
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityKind: "hotel", entityName: "JW Marriott Hotel Nairobi", categories: ["设施"], officialDomains: ["marriott.example"] },
    candidates: [{ category: "设施", fact: "设有屋顶泳池。", sourceUrl: original, sourceExcerpt: "rooftop pool", sourceMediaType: "page" }],
    fetchSource: async () => textResponse("<title>JW Marriott Hotel Nairobi</title><p>rooftop pool</p>", undefined, "https://other.example/hotels/jw-marriott-hotel-nairobi/"),
    fetchBrowserSource: null,
  });
  assert.equal(result.verifiedFacts.length, 0);
  assert.equal(result.rejected[0].reason, "source_not_official_or_authoritative");
});

test("酒店独立专属域的栏目页仍可核验事实", async () => {
  const url = "https://examplelodge.com/location";
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Lodge", categories: ["位置"] },
    candidates: [{ category: "位置", fact: "坐落在河岸。", sourceUrl: url, sourceExcerpt: "river bank", sourceMediaType: "page" }],
    fetchSource: async () => textResponse("<title>Location</title><h1>Location</h1><p>river bank</p>", undefined, url), fetchBrowserSource: null,
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.verifiedFacts[0].sourceClass, "official_entity");
});

test("同名酒店在品牌域必须有地区证据，浏览器兜底也不能放行错店", async () => {
  const request = { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Lodge", location: "Nairobi", categories: ["位置"], officialDomains: ["brand.example"] };
  const url = "https://brand.example/hotels/example-lodge-mombasa/";
  const candidate = { category: "位置", fact: "坐落在河岸。", sourceUrl: url, sourceExcerpt: "river bank", sourceMediaType: "page" };
  const unavailable = async () => ({ ok: false, status: 403, url, headers: { get: () => "text/html" }, text: async () => "blocked" });
  const result = await verifyCopyFactsResearch({ researchRequest: request, candidates: [candidate], fetchSource: unavailable,
    fetchBrowserSource: async () => textResponse("<title>Example Lodge Mombasa</title><h1>Example Lodge Mombasa</h1><p>river bank</p>", undefined, url) });
  assert.equal(result.verifiedFacts.length, 0);
  assert.equal(result.rejected[0].reason, "entity_identity_unproven");
});

test("可信行业媒体可补设计事实，OTA 只允许位置客房设施", async () => {
  const designUrl = "https://www.sleepermagazine.com/stories/projects/example-lodge/";
  const otaUrl = "https://www.booking.com/hotel/xx/example-lodge.html";
  const body = "<title>Example Lodge architecture project</title><h1>Example Lodge</h1><p>Designed around a stone courtyard. The hotel is near the river.</p>";
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["设计", "位置"] },
    candidates: [
      { category: "设计", fact: "空间围绕石材庭院展开。", sourceUrl: designUrl, sourceExcerpt: "Designed around a stone courtyard", sourceMediaType: "page", sourceClass: "trusted_trade_media" },
      { category: "设计", fact: "采用庭院式设计。", sourceUrl: otaUrl, sourceExcerpt: "stone courtyard", sourceMediaType: "page", sourceClass: "major_ota" },
      { category: "位置", fact: "靠近河岸。", sourceUrl: otaUrl, sourceExcerpt: "near the river", sourceMediaType: "page", sourceClass: "major_ota" },
    ],
    fetchSource: async (url) => textResponse(body, undefined, url),
  });
  assert.deepEqual(result.verifiedFacts.map((item) => [item.category, item.sourceClass]), [["设计", "trusted_trade_media"], ["位置", "major_ota"]]);
  const otaDesignOnly = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["设计"] },
    candidates: [{ category: "设计", fact: "采用庭院式设计。", sourceUrl: otaUrl, sourceExcerpt: "stone courtyard", sourceMediaType: "page", sourceClass: "major_ota" }],
    fetchSource: async (url) => textResponse(body, undefined, url),
  });
  assert.equal(otaDesignOnly.verifiedFacts.length, 0);
  assert.equal(otaDesignOnly.rejected[0].reason, "source_class_not_allowed_for_category");
});

test("酒店受控外部页面最多使用两个且每字段独立记录状态", async () => {
  const urls = {
    design: "https://www.sleepermagazine.com/stories/projects/example-lodge/",
    rooms: "https://www.booking.com/hotel/xx/example-lodge.html",
    facilities: "https://www.expedia.com/Example-Lodge.h1.Hotel-Information",
  };
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["设计", "客房", "设施", "位置"] },
    candidates: [
      { category: "设计", fact: "采用石材庭院设计。", sourceUrl: urls.design, sourceExcerpt: "stone courtyard", sourceMediaType: "page", sourceClass: "trusted_trade_media" },
      { category: "客房", fact: "公开房型包含河景客房。", sourceUrl: urls.rooms, sourceExcerpt: "river-view rooms", sourceMediaType: "page", sourceClass: "major_ota" },
      { category: "设施", fact: "设有室外泳池。", sourceUrl: urls.facilities, sourceExcerpt: "outdoor pool", sourceMediaType: "page", sourceClass: "major_ota" },
    ],
    fetchSource: async (url) => textResponse(`<title>Example Lodge</title><h1>Example Lodge</h1><p>stone courtyard river-view rooms outdoor pool</p>`, undefined, url),
  });
  assert.equal(result.externalSourcePagesUsed, 2);
  assert.equal(result.verifiedFacts.length, 2);
  assert.ok(result.rejected.some((item) => item.reason === "external_source_page_budget_exhausted"));
  assert.deepEqual(result.categoryOutcomes.map(({ category, status }) => ({ category, status })), [
    { category: "设计", status: "success" },
    { category: "客房", status: "success" },
    { category: "设施", status: "not_found" },
    { category: "位置", status: "not_found" },
  ]);
  assert.equal(result.categoryOutcomes.find((item) => item.category === "设施").reason, "verification_budget_exhausted");
  assert.equal(result.categoryOutcomes.find((item) => item.category === "位置").reason, "model_omitted");
});

test("来源不可访问与没有候选按字段区分", async () => {
  const result = await verifyCopyFactsResearch({
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["位置", "设计"] },
    candidates: [{ category: "位置", fact: "位于河岸。", sourceUrl: "https://examplelodge.com/location", sourceExcerpt: "river", sourceMediaType: "page", sourceClass: "official_entity" }],
    fetchSource: async (url) => ({ ok: false, status: 404, url, headers: { get: () => "text/html" }, text: async () => "" }),
    fetchBrowserSource: null,
  });
  assert.deepEqual(result.categoryOutcomes.map(({ category, status }) => ({ category, status })), [
    { category: "位置", status: "source_unavailable" },
    { category: "设计", status: "not_found" },
  ]);
  assert.deepEqual(result.categoryOutcomes.map((item) => item.reason), ["source_access_failed", "model_omitted"]);
});

test("截断终止即使返回合法 JSON 也不被采用，语法修复不补齐截断结构", async () => {
  for (const payload of [
    { choices: [{ finish_reason: "length", message: { content: '{"facts":[]}' } }] },
    { choices: [{ finish_reason: "stop", message: { content: '{"facts":[]' } }] },
  ]) {
    let calls = 0;
    await assert.rejects(requestCopyFactsResearch({
      apiKey: "fixture-key", researchRequest: { categories: ["设计"] }, emptyContentRetries: 0,
      fetchImpl: async () => { calls += 1; return { ok: true, json: async () => payload }; },
    }), (error) => payload.choices[0].finish_reason === "length" ? error.code === "copy_facts_research_truncated" : error.code === "copy_facts_research_invalid_json");
    assert.equal(calls, 1);
  }
});

test("明确无证据、模型漏项与不可访问的自报不会混同；漏类不触发技术重试", async () => {
  let calls = 0;
  const researchRequest = { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Lodge", categories: ["位置", "客房", "设计", "设施"] };
  const response = await requestCopyFactsResearch({ apiKey: "fixture-key", researchRequest,
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ facts: [], categoryOutcomes: [{ category: "位置", status: "no_evidence" }, { category: "客房", status: "access_failed" }, { category: "设施", status: "candidate_found" }] }) } }] }) }; },
  });
  const result = await verifyCopyFactsResearch({ researchRequest, candidates: response.json.facts, reportedOutcomes: response.json.categoryOutcomes });
  assert.equal(calls, 1);
  assert.deepEqual(result.categoryOutcomes.map((item) => item.reason), ["no_evidence", "reported_access_failed", "model_omitted", "model_omitted"]);
  assert.ok(result.categoryOutcomes.every((item) => item.terminal));
});

test("纯语法错误可本地修复，页面脚本及少量通用词不能充当事实摘录", async () => {
  const researchRequest = { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["设计"] };
  const parsed = await requestCopyFactsResearch({ apiKey: "fixture-key", researchRequest,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: '{"facts":[],}' } }] }) }),
  });
  assert.equal(parsed.attemptUsages.length, 1);
  assert.equal(parsed.attemptUsages[0].outcome, "repaired_json");
  for (const body of ['<script>Designed around a stone courtyard with woven ceilings and carved doors</script><p>rooms available</p>', '<p>Designed stone courtyard rooms available</p>']) {
    const result = await verifyCopyFactsResearch({ researchRequest,
      candidates: [{ category: "设计", fact: "设有石材庭院。", sourceUrl: "https://examplelodge.com/design", sourceExcerpt: "Designed around a stone courtyard with woven ceilings and carved doors" }],
      fetchSource: async (url) => textResponse(body, undefined, url), fetchBrowserSource: null,
    });
    assert.equal(result.verifiedFacts.length, 0);
    assert.equal(result.rejected[0].reason, "source_excerpt_not_supported");
  }
});

function memoryResearchState() {
  const states = new Map();
  return {
    states,
    load: async (key) => structuredClone(states.get(key) || null),
    claim: async (key, phase) => {
      const state = states.get(key) || {};
      if (state.claims?.[phase]) return { claimed: false, state: structuredClone(state) };
      const next = { ...state, claims: { ...state.claims, [phase]: true } };
      states.set(key, next);
      return { claimed: true, state: structuredClone(next) };
    },
    save: async (key, patch) => { const state = { ...states.get(key), ...structuredClone(patch) }; states.set(key, state); return structuredClone(state); },
  };
}

const hotelResearch = { researchType: "official_entity_facts", entityKind: "hotel", entityName: "Example Lodge", categories: ["位置", "客房", "设计", "设施"] };
const fixtureFact = (category, url = "https://examplelodge.com/facts") => ({ category, fact: `${category}的公开资料。`, sources: [{ fact: `${category}的公开资料。`, sourceUrl: url, sourceExcerpt: "Example Lodge river courtyard rooms pool", sourceMediaType: "page" }] });
const fixturePage = (url) => textResponse("<title>Example Lodge</title><p>Example Lodge river courtyard rooms pool</p>", undefined, url);

test("酒店候选只采用已核验页面自己的事实，不能继承其他页面的设施合集", async () => {
  const missing = "https://examplelodge.com/unavailable";
  const available = "https://examplelodge.com/fitness";
  const result = await verifyCopyFactsResearch({
    researchRequest: { ...hotelResearch, categories: ["设施"] },
    candidates: [{ category: "设施", fact: "设有泳池、水疗、酒吧及健身中心。", sources: [
      { fact: "设有泳池和水疗。", sourceUrl: missing, sourceExcerpt: "Example Lodge offers a pool and spa.", sourceMediaType: "page" },
      { fact: "设有健身中心。", sourceUrl: available, sourceExcerpt: "Example Lodge offers a fitness center.", sourceMediaType: "page" },
    ] }],
    fetchSource: async (url) => url === available
      ? textResponse("<title>Example Lodge</title><p>Example Lodge offers a fitness center.</p>", undefined, url)
      : { ok: false, status: 404, url, headers: { get: () => "text/html" } },
    fetchBrowserSource: null,
  });
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.verifiedFacts[0].fact, "设有健身中心。");
  assert.equal(result.verifiedFacts[0].sourceUrl, available);
  assert.equal(result.rejected[0].reason, "source_unavailable");
});

test("酒店来源未给出自身事实时不回退采用父级总结", async () => {
  let fetches = 0;
  const result = await verifyCopyFactsResearch({ researchRequest: { ...hotelResearch, categories: ["设施"] },
    candidates: [{ category: "设施", fact: "设有泳池和健身中心。", sources: [
      { sourceUrl: "https://examplelodge.com/fitness", sourceExcerpt: "fitness center", sourceMediaType: "page" },
    ] }], fetchSource: async () => { fetches++; return fixturePage("https://examplelodge.com/fitness"); },
  });
  assert.equal(result.verifiedFacts.length, 0);
  assert.equal(result.rejected[0].reason, "fact_source_incomplete");
  assert.equal(fetches, 0);
});

test("同酒店仅缺类补证一次，已核验字段不重写，重入复用持久结果", async () => {
  const researchStateStore = memoryResearchState();
  const requests = [];
  const requestResearch = async ({ researchRequest }) => {
    requests.push(researchRequest);
    return { json: { facts: researchRequest.researchPhase === "supplement" ? [fixtureFact("设计", "https://www.sleepermagazine.com/projects/example-lodge/")] : [fixtureFact("位置"), fixtureFact("客房"), fixtureFact("设施")] } };
  };
  const options = { researchRequest: hotelResearch, researchStateStore, requestResearch, fetchSource: async (url) => fixturePage(url), fetchBrowserSource: null };
  const result = await runCopyFactsResearch(options);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].categories, ["设计"]);
  assert.equal(requests[1].researchPhase, "supplement");
  assert.ok(requests[1].sourceDirections[0].domains.includes("sleepermagazine.com"));
  assert.deepEqual(result.verifiedFacts.map((item) => item.category), ["位置", "客房", "设施", "设计"]);
  assert.equal(result.externalSourcePagesUsed, 1);
  assert.equal(result.businessCalls, 2);
  assert.equal(result.supplementAttempted, true);
  assert.ok(result.categoryOutcomes.every((item) => item.reason === "verified"));
  const repeated = await runCopyFactsResearch(options);
  assert.equal(requests.length, 2);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.invocationBusinessCalls, 0);
  assert.equal(repeated.invocationTransportAttempts, 0);
});

test("主研究先核验备选页面；全部类别完成时不再补证", async () => {
  let calls = 0;
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore: memoryResearchState(),
    requestResearch: async () => { calls += 1; return { json: { facts: hotelResearch.categories.map((category) => ({ ...fixtureFact(category), sources: [{ fact: `${category}的公开资料。`, sourceUrl: "https://examplelodge.com/missing", sourceExcerpt: "river courtyard", sourceMediaType: "page" }, ...fixtureFact(category).sources] })) } }; },
    fetchSource: async (url) => url.includes("missing") ? { ok: false, status: 404, url, headers: { get: () => "text/html" } } : fixturePage(url), fetchBrowserSource: null,
  });
  assert.equal(calls, 1);
  assert.equal(result.verifiedFacts.length, 4);
  assert.equal(result.supplementStopReason, "complete");
});

test("主研究和补证共享外部两页预算；没有持久状态不擅自发第二次业务请求", async () => {
  let calls = 0;
  const twoPages = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore: memoryResearchState(),
    requestResearch: async () => { calls += 1; return { json: { facts: [fixtureFact("设计", "https://www.sleepermagazine.com/projects/example-lodge/"), fixtureFact("客房", "https://www.booking.com/hotel/example-lodge.html")] } }; },
    fetchSource: async (url) => fixturePage(url), fetchBrowserSource: null,
  });
  assert.equal(calls, 1);
  assert.equal(twoPages.externalSourcePagesUsed, 2);
  assert.equal(twoPages.supplementStopReason, "source_budget_exhausted");
  const noJournal = await runCopyFactsResearch({ researchRequest: hotelResearch,
    requestResearch: async () => { calls += 1; return { json: { facts: [] } }; },
  });
  assert.equal(calls, 2);
  assert.equal(noJournal.supplementStopReason, "durable_state_unavailable");
});

test("官方 404 后同批有效详情页可核验，补搜排除旧页", async () => {
  const missing = "https://examplelodge.com/rooms/missing";
  const valid = "https://examplelodge.com/rooms/example-lodge";
  const designPage = "https://examplelodge.com/design/example-lodge";
  const requests = [];
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore: memoryResearchState(),
    requestResearch: async ({ researchRequest }) => {
      requests.push(researchRequest);
      return { json: { facts: researchRequest.researchPhase === "supplement" ? [fixtureFact("设计", designPage)] : [{ ...fixtureFact("客房"), sources: [{ fact: "客房的公开资料。", sourceUrl: missing, sourceExcerpt: "rooms", sourceMediaType: "page" }, { fact: "客房的公开资料。", sourceUrl: valid, sourceExcerpt: "rooms", sourceMediaType: "page" }] }] } };
    },
    fetchSource: async (url) => url.includes("/missing") ? { ok: false, status: 404, url, headers: { get: () => "text/html" } } : fixturePage(url), fetchBrowserSource: null,
  });
  assert.equal(result.verifiedFacts.length, 2);
  assert.equal(result.verifiedFacts[0].sourceUrl, valid);
  assert.ok(requests[1].excludedSourceUrls.includes(missing));
  assert.equal(result.supplementAttempted, true);
});

test("外部两页用尽仍可用唯一补搜查同酒店官方详情页", async () => {
  const requests = [];
  const result = await runCopyFactsResearch({ researchRequest: { ...hotelResearch, officialDomains: ["examplelodge.com"] }, researchStateStore: memoryResearchState(),
    requestResearch: async ({ researchRequest }) => {
      requests.push(researchRequest);
      return { json: { facts: researchRequest.researchPhase === "supplement" ? [fixtureFact("位置", "https://examplelodge.com/about/example-lodge")] : [fixtureFact("设计", "https://www.sleepermagazine.com/project/example-lodge"), fixtureFact("客房", "https://www.booking.com/hotel/example-lodge.html")] } };
    }, fetchSource: async (url) => fixturePage(url), fetchBrowserSource: null,
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].sourceDirections[0].domains, ["examplelodge.com"]);
  assert.equal(result.externalSourcePagesUsed, 2);
  assert.equal(result.verifiedFacts.length, 3);
  assert.equal(result.verifiedFacts.at(-1).sourceClass, "official_entity");
});

test("母品牌域名不同于酒店名时，失败候选只作为外部额度耗尽后的唯一补搜方向", async () => {
  const missing = "https://globalstays.example/hotels/example-lodge/rooms-old";
  const valid = "https://globalstays.example/hotels/example-lodge/rooms";
  const requests = [];
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore: memoryResearchState(),
    requestResearch: async ({ researchRequest }) => {
      requests.push(researchRequest);
      return { json: { facts: researchRequest.researchPhase === "supplement"
        ? [{ ...fixtureFact("客房", valid), sources: [{ fact: "客房的公开资料。", sourceUrl: valid, sourceExcerpt: "Example Lodge river courtyard rooms pool", sourceMediaType: "page", sourceClass: "official_brand" }] }]
        : [
          { ...fixtureFact("客房", missing), sources: [{ fact: "客房的公开资料。", sourceUrl: missing, sourceExcerpt: "rooms", sourceMediaType: "page", sourceClass: "official_brand" }] },
          fixtureFact("位置", "https://www.booking.com/hotel/xx/example-lodge.html"),
          fixtureFact("设计", "https://www.sleepermagazine.com/project/example-lodge"),
        ] } };
    },
    fetchSource: async (url) => url === missing || url.includes("www.globalstays.example/hotels/example-lodge/rooms-old")
      ? { ok: false, status: 404, url, headers: { get: () => "text/html" } }
      : url === valid || url.includes("www.globalstays.example/hotels/example-lodge/rooms")
        ? textResponse(`<title>Example Lodge rooms</title><h1>Example Lodge</h1><link rel="canonical" href="${url}"><script type="application/ld+json">{"@type":"Hotel","name":"Example Lodge","brand":{"name":"Global Stays"}}</script><p>Book now. Example Lodge river courtyard rooms pool</p>`, undefined, url)
        : fixturePage(url),
    fetchBrowserSource: null,
  });
  assert.equal(requests.length, 2);
  assert.equal(result.externalSourcePagesUsed, 2);
  assert.ok(requests[1].sourceDirections.some((item) => item.category === "客房" && item.domains.includes("globalstays.example")));
  assert.ok(requests[1].excludedSourceUrls.includes(missing));
  assert.equal(result.verifiedFacts.find((item) => item.category === "客房")?.sourceClass, "official_brand");
  assert.equal(result.rejected.find((item) => item.sourceUrl === missing)?.declaredSourceClass, "official_brand");
});

test("自称母品牌的冒牌域名可给搜索方向但不能提升为可信事实", async () => {
  const result = await verifyCopyFactsResearch({
    researchRequest: hotelResearch,
    candidates: [{ category: "客房", fact: "酒店设有河景客房。", sourceUrl: "https://impostor.example/hotels/example-lodge/rooms", sourceExcerpt: "river-view rooms", sourceMediaType: "page", sourceClass: "official_brand" }],
    fetchSource: async (url) => textResponse("<title>Example Lodge</title><h1>Example Lodge</h1><p>river-view rooms</p>", undefined, url),
    fetchBrowserSource: null,
  });
  assert.equal(result.verifiedFacts.length, 0);
  assert.equal(result.rejected[0].declaredSourceClass, "official_brand");
  assert.equal(result.rejected[0].reason, "source_not_official_or_authoritative");
});

test("已领取主研究但未落结果不会重复派发，不同酒店键互不混用", async () => {
  const researchStateStore = memoryResearchState();
  const key = copyResearchStateKey(hotelResearch);
  assert.equal(key, copyResearchStateKey({ ...hotelResearch, categories: [...hotelResearch.categories].reverse() }));
  assert.notEqual(key, copyResearchStateKey({ ...hotelResearch, entityName: "Another Lodge" }));
  const scoped = { ...hotelResearch, location: "Nairobi", officialDomains: ["brand.example", "hotel.example"] };
  assert.equal(copyResearchStateKey(scoped), copyResearchStateKey({ ...scoped, officialDomains: ["https://www.HOTEL.example/page", "BRAND.example"] }));
  assert.notEqual(copyResearchStateKey(scoped), copyResearchStateKey({ ...scoped, location: "Mombasa" }));
  assert.notEqual(copyResearchStateKey(scoped), copyResearchStateKey({ ...scoped, officialDomains: ["another.example"] }));
  await researchStateStore.claim(key, "main");
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore, requestResearch: async () => { throw new Error("must not dispatch"); } });
  assert.equal(result.invocationBusinessCalls, 0);
  assert.equal(result.categoryOutcomes[0].reason, "research_interrupted");
});

test("补证不接受成功字段改写或方向外来源，已核验页面可为缺失类别提供新摘录", async () => {
  let calls = 0;
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore: memoryResearchState(),
    requestResearch: async ({ researchRequest }) => {
      calls += 1;
      return { json: { facts: researchRequest.researchPhase === "supplement" ? [fixtureFact("位置", "https://www.booking.com/hotel/changed.html"), fixtureFact("设计"), fixtureFact("设计", "https://social.example/design")] : [fixtureFact("位置")] } };
    }, fetchSource: async (url) => fixturePage(url), fetchBrowserSource: null,
  });
  assert.equal(calls, 2);
  assert.equal(result.verifiedFacts.length, 2);
  assert.equal(result.verifiedFacts[0].sourceUrl, "https://examplelodge.com/facts");
  assert.equal(result.verifiedFacts[1].category, "设计");
  assert.equal(result.rejected.filter((item) => item.reason === "source_direction_not_allowed").length, 2);
});

test("补搜可复用主搜摘录失败但正文有效的官方页面", async () => {
  const url = "https://examplelodge.com/facts";
  const requests = [];
  let fetches = 0;
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore: memoryResearchState(),
    requestResearch: async ({ researchRequest }) => {
      requests.push(researchRequest);
      return { json: { facts: [{ ...fixtureFact("位置", url), sources: [{ fact: "位置的公开资料。", sourceUrl: url, sourceExcerpt: researchRequest.researchPhase === "supplement" ? "Example Lodge beside the river" : "incorrect excerpt", sourceMediaType: "page" }] }] } };
    },
    fetchSource: async () => { fetches += 1; return textResponse("<title>Example Lodge</title><p>Example Lodge beside the river</p>", undefined, url); }, fetchBrowserSource: null,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].excludedSourceUrls.includes(url), false);
  assert.equal(fetches, 1);
  assert.equal(result.verifiedFacts[0].category, "位置");
  assert.equal(result.verifiedFacts[0].sourceUrl, url);
});

test("物理请求与业务次数分别持久记录；截断主研究不启动缺类补证", async () => {
  const researchStateStore = memoryResearchState();
  let calls = 0;
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore,
    requestResearch: (options) => requestCopyFactsResearch({ ...options, apiKey: "fixture-key", fetchImpl: async () => {
      const saved = await researchStateStore.load(copyResearchStateKey(hotelResearch));
      assert.ok(saved.claims.main);
      assert.equal(saved.transportAttempts, calls + 1);
      calls += 1;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "length", message: { content: '{"facts":[]}' } }] }) };
    } }),
  });
  assert.equal(calls, 2);
  assert.equal(result.businessCalls, 1);
  assert.equal(result.invocationTransportAttempts, 2);
  assert.equal(result.categoryOutcomes[0].reason, "research_truncated");
  assert.equal(result.supplementStopReason, "main_failed");
});

test("主研究与补证的技术重试合计最多四次，并保留逐阶段记录", async () => {
  const researchStateStore = memoryResearchState();
  let calls = 0;
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore,
    requestResearch: (options) => requestCopyFactsResearch({ ...options, apiKey: "fixture-key", fetchImpl: async () => {
      calls += 1;
      const facts = options.researchRequest.researchPhase === "supplement" ? [fixtureFact("设计", "https://www.sleepermagazine.com/project/example-lodge")] : [fixtureFact("位置"), fixtureFact("客房"), fixtureFact("设施")];
      const content = calls % 2 ? '{"facts":[' : JSON.stringify({ facts });
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content } }] }) };
    } }), fetchSource: async (url) => fixturePage(url), fetchBrowserSource: null,
  });
  assert.equal(calls, 4);
  assert.equal(result.transportAttempts, 4);
  assert.equal(result.businessCalls, 2);
  assert.deepEqual(result.attemptUsages.map((item) => item.phase), ["main", "main", "supplement", "supplement"]);
  assert.equal(result.verifiedFacts.length, 4);
  assert.equal((await researchStateStore.load(copyResearchStateKey(hotelResearch))).transportAttempts, 4);
});

test("补证期间重入不重复请求且不把部分结果覆盖研究拥有者", async () => {
  const researchStateStore = memoryResearchState();
  let resume;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { resume = resolve; });
  let calls = 0;
  const options = { researchRequest: hotelResearch, researchStateStore, fetchSource: async (url) => fixturePage(url), fetchBrowserSource: null,
    requestResearch: async ({ researchRequest }) => {
      calls += 1;
      if (researchRequest.researchPhase !== "supplement") return { json: { facts: [fixtureFact("位置"), fixtureFact("客房"), fixtureFact("设施")] } };
      entered();
      await pending;
      return { json: { facts: [fixtureFact("设计", "https://www.sleepermagazine.com/project/example-lodge")] } };
    },
  };
  const owner = runCopyFactsResearch(options);
  await started;
  const concurrent = await runCopyFactsResearch(options);
  assert.equal(concurrent.supplementPending, true);
  assert.equal(concurrent.invocationBusinessCalls, 0);
  assert.equal((await researchStateStore.load(copyResearchStateKey(hotelResearch))).result, undefined);
  resume();
  const completed = await owner;
  assert.equal(calls, 2);
  assert.equal(completed.verifiedFacts.length, 4);
  assert.equal((await researchStateStore.load(copyResearchStateKey(hotelResearch))).result.coverageComplete, true);
});

test("补证只消费剩余外部页额度；成功设计事实冻结", async () => {
  const visited = [];
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore: memoryResearchState(),
    requestResearch: async ({ researchRequest }) => ({ json: { facts: researchRequest.researchPhase === "supplement" ? [fixtureFact("位置", "https://booking.com/example-lodge"), fixtureFact("客房", "https://expedia.com/example-lodge")] : [fixtureFact("设计", "https://sleepermagazine.com/project/example-lodge")] } }),
    fetchSource: async (url) => { visited.push(url); return fixturePage(url); }, fetchBrowserSource: null,
  });
  assert.equal(result.externalSourcePagesUsed, 2);
  assert.deepEqual(visited, ["https://sleepermagazine.com/project/example-lodge", "https://booking.com/example-lodge"]);
  assert.equal(result.categoryOutcomes.find((item) => item.category === "客房").reason, "verification_budget_exhausted");
  assert.equal(result.verifiedFacts.find((item) => item.category === "设计").sourceUrl, "https://sleepermagazine.com/project/example-lodge");
});

test("补证技术失败保留主研究事实且记录失败，不开启第三轮", async () => {
  const researchStateStore = memoryResearchState();
  let calls = 0;
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch, researchStateStore,
    requestResearch: async ({ researchRequest }) => { calls += 1; if (researchRequest.researchPhase === "supplement") throw Object.assign(new Error("fixture failure"), { code: "copy_facts_research_truncated" }); return { json: { facts: [fixtureFact("位置")] } }; },
    fetchSource: async (url) => fixturePage(url), fetchBrowserSource: null,
  });
  assert.equal(calls, 2);
  assert.equal(result.verifiedFacts.length, 1);
  assert.equal(result.supplementFailure.reason, "research_truncated");
  assert.equal((await researchStateStore.load(copyResearchStateKey(hotelResearch))).supplementFailure.reason, "research_truncated");
});

test("读取与领取之间主研究刚完成时仍使用最新持久预算", async () => {
  const mainResult = { verifiedFacts: [], rejected: [], attemptUsages: [], categoryOutcomes: hotelResearch.categories.map((category) => ({ category, status: "not_found", reason: "model_omitted" })) };
  const latest = { mainResult, transportAttempts: 2, externalSourcePages: ["https://booking.com/example", "https://sleepermagazine.com/example"] };
  const result = await runCopyFactsResearch({ researchRequest: hotelResearch,
    researchStateStore: { load: async () => null, claim: async () => ({ claimed: false, state: latest }), save: async () => {} },
    requestResearch: async () => { throw new Error("不应突破最新预算重新派发"); },
  });
  assert.equal(result.externalSourcePagesUsed, 2);
  assert.equal(result.transportAttempts, 2);
  assert.equal(result.supplementStopReason, "source_budget_exhausted");
  assert.equal(result.invocationBusinessCalls, 0);
});

test("餐饮正式来源仅因网络不可访问时沿用现有 verifiedFacts，酒店与软404不受影响", async () => {
  const unavailable = async (url) => ({ ok: false, status: 403, url, headers: { get: () => "text/html" }, text: async () => "blocked" });
  const diningRequest = { researchType: "official_entity_facts", entityName: "Example Dining", entityKind: "dining", focus: "Table-side Grill", categories: ["体验特色"] };
  const candidate = { category: "体验特色", fact: "烤肉由服务人员巡桌现切。", sourceUrl: "https://example-group.test/dining/example/", sourceExcerpt: "carved at your table", sourceMediaType: "page", sourceClass: "official_brand" };

  const dining = await verifyCopyFactsResearch({ researchRequest: diningRequest, candidates: [candidate], fetchSource: unavailable, fetchBrowserSource: null });
  assert.equal(dining.verifiedFacts.length, 1);
  assert.equal(dining.verifiedFacts[0].fact, candidate.fact);
  assert.equal(dining.verifiedFacts[0].sourceClass, "official_brand");

  const hotel = await verifyCopyFactsResearch({
    researchRequest: { ...diningRequest, entityKind: "hotel", categories: ["设施"] },
    candidates: [{ ...candidate, category: "设施", fact: "设有餐厅。" }],
    fetchSource: unavailable,
    fetchBrowserSource: null,
  });
  assert.equal(hotel.verifiedFacts.length, 0);
  assert.equal(hotel.rejected[0].reason, "source_unavailable");

  const soft404 = await verifyCopyFactsResearch({
    researchRequest: diningRequest,
    candidates: [candidate],
    fetchSource: async (url) => textResponse("<title>Page Not Found 404 Error</title>", undefined, url),
    fetchBrowserSource: null,
  });
  assert.equal(soft404.verifiedFacts.length, 0);
  assert.equal(soft404.rejected[0].reason, "source_unavailable");
});
