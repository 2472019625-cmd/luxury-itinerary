import { TRAVEL_ENTITY_REGISTRY } from "../src/data/travelEntityRegistry.js";
const SEARCH_URL = "https://ydc-index.io/v1/search";
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const genericNameTokens = new Set(["the", "hotel", "resort", "lodge", "camp", "safari", "and", "spa"]);
const snippetCategoryKeys = (value) => {
  const text = clean(value).toLowerCase();
  return [
    ["location", /\b(?:located|near|overlook|river|coast|park|reserve|conservancy|distance|setting)\b|位于|坐落|毗邻|河畔|临近|地处/],
    ["rooms", /\b(?:rooms?|suites?|villas?|tents?|accommodations?|bedrooms?)\b|客房|套房|别墅|帐篷|住宿/],
    ["design", /\b(?:design|architecture|architect|interior|style|built)\b|设计|建筑|室内|风格/],
    ["facilities", /\b(?:pool|spa|deck|restaurant|lounge|gym|library|facility|facilities)\b|泳池|水疗|餐厅|露台|休息区|设施/],
  ].filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
};

function identityTokens(name) {
  const latin = clean(name).toLowerCase().match(/[a-z0-9]+/g) || [];
  const cjk = clean(name).match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...latin.filter((token) => token.length >= 2 && !genericNameTokens.has(token)), ...cjk])];
}

function hotelIdentityMatch(result, entityName) {
  const normalized = clean(entityName).toLowerCase();
  const registry = TRAVEL_ENTITY_REGISTRY.find((entity) =>
    [entity.canonicalName, ...(entity.aliases || [])].some((alias) => clean(alias).toLowerCase() === normalized));
  const aliases = [...new Set([entityName, registry?.canonicalName, ...(registry?.aliases || []), ...Object.values(registry?.displayNames || {})].map(clean).filter(Boolean))];
  const phraseKey = (value) => clean(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  let url;
  try { url = new URL(result?.url); } catch { url = null; }
  let pathname = url?.pathname || "";
  try { pathname = decodeURIComponent(pathname); } catch { /* Keep the encoded path. */ }
  const sources = [result?.title, url?.hostname, pathname].map(phraseKey).filter(Boolean);
  const matchedAlias = aliases.find((alias) => {
    const tokens = identityTokens(alias);
    const specificName = tokens.length >= 2 || Boolean(registry) || /(?:hotel|lodge|camp|resort|酒店|营地|度假村)/i.test(alias);
    const key = phraseKey(alias);
    return specificName && key.length >= 4 && sources.some((source) => source.includes(key));
  });
  return matchedAlias ? { method: "full_alias_phrase", matchedAlias: clean(matchedAlias) } : null;
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
  const focusTerms = { location: "location setting", rooms: "rooms suites accommodation", design: "architecture interior design", facilities: "facilities amenities" };
  const focus = [...new Set((researchRequest?.focusCategories || []).filter((key) => focusTerms[key]))];
  const query = focus.length ? `${entityName} ${focus.map((key) => focusTerms[key]).join(" ")}` : entityName;
  const response = await fetchImpl(SEARCH_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, count: 10, extraction: { extraction_mode: "highlights" } }),
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
    const identityEvidence = hotelIdentityMatch(result, entityName);
    if (!sourceUrl || !identityEvidence) continue;
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
      snippets.push({ entityName, identityEvidence, sourceUrl, sourceTitle: clean(result?.title), sourceExcerpt, categoryKeys: snippetCategoryKeys(sourceExcerpt), sourceClass: "search_highlight", checkedAt });
    }
  }
  return {
    researchType: researchRequest.researchType,
    entityName,
    status: snippets.length ? "success" : "not_found",
    provider: "you_web_search_highlights",
    searchQuery: query,
    searchResultCount: results.length,
    searchSnippets: snippets,
    verifiedFacts: [],
    categoryOutcomes: [],
    attemptUsages: [{}],
  };
}
