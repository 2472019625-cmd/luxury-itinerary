const SEARCH_URL = "https://ydc-index.io/v1/search";
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const genericNameTokens = new Set(["the", "hotel", "resort", "lodge", "camp", "safari", "and", "spa"]);

function identityTokens(name) {
  const latin = clean(name).toLowerCase().match(/[a-z0-9]+/g) || [];
  const cjk = clean(name).match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...latin.filter((token) => token.length >= 2 && !genericNameTokens.has(token)), ...cjk])];
}

function resultMatchesHotel(result, entityName) {
  const tokens = identityTokens(entityName);
  if (!tokens.length) return false;
  const local = clean(`${result?.title || ""} ${result?.url || ""}`).toLowerCase();
  return tokens.filter((token) => local.includes(token)).length >= Math.min(2, tokens.length);
}

function publicSourceUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

export async function searchHotelHighlights({ researchRequest, apiKey = process.env.YDC_API_KEY, signal, fetchImpl = fetch, checkedAt = new Date().toISOString() } = {}) {
  if (!clean(apiKey)) throw Object.assign(new Error("未配置 YDC_API_KEY，不能执行酒店搜索片段研究"), { code: "you_hotel_api_key_missing" });
  const entityName = clean(researchRequest?.entityName);
  if (!entityName) throw Object.assign(new Error("酒店正式名称不能为空"), { code: "hotel_entity_name_missing" });
  const response = await fetchImpl(SEARCH_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: entityName, count: 10, extraction: { extraction_mode: "highlights" } }),
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`You.com 酒店搜索失败（HTTP ${response.status}）`), { code: "you_hotel_search_failed", status: response.status });
  const payload = await response.json();
  const results = Array.isArray(payload?.results?.web) ? payload.results.web : [];
  const snippets = [];
  const seen = new Set();
  for (const result of results) {
    if (snippets.length >= 16) break;
    const sourceUrl = publicSourceUrl(result?.url);
    if (!sourceUrl || !resultMatchesHotel(result, entityName)) continue;
    const excerpts = Array.isArray(result?.contents?.highlights) && result.contents.highlights.length
      ? result.contents.highlights : Array.isArray(result?.snippets) && result.snippets.length
        ? result.snippets : [result?.description];
    for (const excerpt of excerpts.slice(0, 8)) {
      if (snippets.length >= 16) break;
      const sourceExcerpt = clean(excerpt).slice(0, 450);
      if (sourceExcerpt.length < 35) continue;
      const key = `${sourceUrl}\n${sourceExcerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      snippets.push({ sourceUrl, sourceTitle: clean(result?.title), sourceExcerpt, sourceClass: "search_highlight", checkedAt });
    }
  }
  return {
    researchType: researchRequest.researchType,
    entityName,
    status: snippets.length ? "success" : "not_found",
    provider: "you_web_search_highlights",
    searchQuery: entityName,
    searchResultCount: results.length,
    searchSnippets: snippets,
    verifiedFacts: [],
    categoryOutcomes: [],
    attemptUsages: [{}],
  };
}
