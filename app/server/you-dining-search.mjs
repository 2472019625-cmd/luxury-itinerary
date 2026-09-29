const SEARCH_URL = "https://ydc-index.io/v1/search";
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const lowTrustDomains = ["tripadvisor.com", "facebook.com", "instagram.com", "youtube.com", "tiktok.com", "x.com", "twitter.com", "wikipedia.org", "wikivoyage.org"];

function identityTokens(value) {
  const normalized = clean(value).toLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g) || [];
  const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...latin.filter((token) => token.length >= 4), ...cjk])];
}

function matchesIdentity(text, identity) {
  const tokens = identityTokens(identity);
  if (!tokens.length) return false;
  const local = clean(text).toLowerCase();
  return tokens.filter((token) => local.includes(token)).length >= Math.min(2, tokens.length);
}

function matchesFocus(text, focus) {
  const local = clean(text).toLowerCase();
  const tokens = identityTokens(focus);
  const latin = tokens.filter((token) => /^[a-z0-9]+$/.test(token));
  const cjk = tokens.filter((token) => !/^[a-z0-9]+$/.test(token));
  return [latin, cjk].some((group) => group.length > 0 && group.filter((token) => local.includes(token)).length >= Math.min(2, group.length));
}

function publicSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (lowTrustDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return "";
    return url.href;
  } catch { return ""; }
}

function sourcePriority(result, researchRequest, focus) {
  let host = "";
  try { host = new URL(result?.url).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* Invalid sources are filtered later. */ }
  const official = (researchRequest?.officialDomains || []).some((domain) => {
    const expected = clean(domain).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    return expected && (host === expected || host.endsWith(`.${expected}`));
  });
  const focusPage = matchesFocus(`${result?.title || ""} ${result?.url || ""}`, focus);
  return Number(official) * 4 + Number(focusPage) * 2;
}

export async function searchDiningHighlights({ researchRequest, apiKey = process.env.YDC_API_KEY, signal, fetchImpl = fetch, checkedAt = new Date().toISOString() } = {}) {
  if (!clean(apiKey)) throw Object.assign(new Error("未配置 YDC_API_KEY，不能执行餐饮搜索片段研究"), { code: "you_dining_api_key_missing" });
  const entityName = clean(researchRequest?.entityName);
  const focus = clean(researchRequest?.focus);
  if (!entityName || !focus) throw Object.assign(new Error("餐饮实体与当前体验名称不能为空"), { code: "dining_search_identity_missing" });
  const focusIncludesEntity = focus.toLowerCase().includes(entityName.toLowerCase());
  const focusDetail = focusIncludesEntity ? clean(focus.toLowerCase().replace(entityName.toLowerCase(), "")) : focus;
  const searchQuery = focusIncludesEntity ? focus : `${entityName} ${focus}`;
  const response = await fetchImpl(SEARCH_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: searchQuery, count: 10, extraction: { extraction_mode: "highlights" } }),
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`You.com 餐饮搜索失败（HTTP ${response.status}）`), { code: "you_dining_search_failed", status: response.status });
  const payload = await response.json();
  const results = Array.isArray(payload?.results?.web) ? payload.results.web : [];
  const snippets = [];
  const seen = new Set();
  for (const result of [...results].sort((a, b) => sourcePriority(b, researchRequest, focusDetail || focus) - sourcePriority(a, researchRequest, focusDetail || focus))) {
    if (snippets.length >= 12) break;
    const sourceUrl = publicSourceUrl(result?.url);
    const pageIdentity = `${result?.title || ""} ${sourceUrl}`;
    if (!sourceUrl || !matchesIdentity(pageIdentity, entityName)) continue;
    const excerpts = Array.isArray(result?.contents?.highlights) && result.contents.highlights.length
      ? result.contents.highlights : Array.isArray(result?.snippets) && result.snippets.length
        ? result.snippets : [result?.description];
    for (const excerpt of excerpts.slice(0, 6)) {
      if (snippets.length >= 12) break;
      const sourceExcerpt = clean(excerpt).slice(0, 450);
      if (sourceExcerpt.length < 25) continue;
      // A relevant hotel page alone cannot establish the particular dining experience.
      if (identityTokens(focusDetail).length && !matchesFocus(`${pageIdentity} ${sourceExcerpt}`, focusDetail)) continue;
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
    searchQuery,
    searchResultCount: results.length,
    searchSnippets: snippets,
    verifiedFacts: [],
    categoryOutcomes: [],
    attemptUsages: [{}],
  };
}
