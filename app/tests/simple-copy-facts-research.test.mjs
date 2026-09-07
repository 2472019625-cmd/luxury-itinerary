import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCopyFactsResearchRequest,
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
  assert.match(prompt.messages[0].content, /第三方平台、媒体文章、社交平台和图片都不能自动成为已核验事实/);
  assert.deepEqual(prompt.response_format, { type: "json_object" });
  assert.match(prompt.messages[0].content, /1—3 个相互独立的官方候选页面/);
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
  assert.deepEqual(requestBodies[0].response_format, { type: "json_object" });
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
    assert.deepEqual(Object.keys(result.verifiedFacts[0]), ["category", "fact", "sourceUrl", "sourceExcerpt", "checkedAt"]);
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
  assert.deepEqual(result.rejected.map((item) => item.reason), ["source_not_official_or_authoritative", "source_not_official_or_authoritative", "image_not_fact_evidence", "order_fact_not_researchable"]);
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
