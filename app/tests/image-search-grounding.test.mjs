import test from "node:test";
import assert from "node:assert/strict";
import { isGroundingRedirectUrl, parseSearchMetadata, parseSearchResults, searchWebBatch } from "../server/image-search.mjs";

const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/token";

test("prefers canonical URL fields in structured search results", () => {
  const [result] = parseSearchResults(JSON.stringify({ results: [{ title: "Grumeti Fund", url: redirectUrl, canonicalUrl: "https://grumetifund.org/anti-poaching/" }] }));
  assert.equal(result.pageUrl, "https://grumetifund.org/anti-poaching/");
});

test("extracts public original sources from citation and grounding metadata", () => {
  const results = parseSearchMetadata({ choices: [{ message: { citations: [{ title: "Singita conservation", source: { original_url: "https://singita.com/conservation/" } }], grounding_metadata: { grounding_chunks: [{ web: { uri: "https://grumetifund.org/our-work/anti-poaching/", title: "Anti-poaching" } }] } } }] });
  assert.deepEqual(results.map((item) => item.pageUrl), ["https://singita.com/conservation/", "https://grumetifund.org/our-work/anti-poaching/"]);
});

test("does not return an unresolved grounding redirect as a source page", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [{ title: "Anti-poaching", url: redirectUrl }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("unavailable", { status: 502 });
  };
  const results = await searchWebBatch({ queries: ["Grumeti anti-poaching"], apiKey: "test", baseUrl: "https://search.invalid", model: "test", count: 6, fetchImpl });
  assert.equal(isGroundingRedirectUrl(redirectUrl), true);
  assert.deepEqual([...results], []);
  assert.equal(results.diagnostics.length, 1);
  assert.equal(results.diagnostics[0].code, "grounding_redirect_unresolved");
  assert.equal(calls, 2);
});

test("uses a public grounding citation instead of fetching a matching redirect", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ results: [{ title: "Anti-poaching", url: redirectUrl }] }),
      citations: [{ title: "Anti-poaching", url: "https://grumetifund.org/our-work/anti-poaching/" }],
    } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const results = await searchWebBatch({ queries: ["Grumeti anti-poaching"], apiKey: "test", baseUrl: "https://search.invalid", model: "test", count: 6, fetchImpl });
  assert.deepEqual(results.map((item) => item.pageUrl), ["https://grumetifund.org/our-work/anti-poaching/"]);
  assert.equal(results.diagnostics.length, 0);
  assert.equal(calls, 1);
});
