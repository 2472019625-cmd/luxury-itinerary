import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { assertPublicUrl, fetchPublicUrl } from "./page-images.mjs";

export const COPY_FACTS_RESEARCH_MODEL = "gemini-3.7-flash-search";
export const COPY_FACTS_RESEARCH_TYPES = Object.freeze(["official_entity_facts", "authoritative_current_facts"]);

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const stripFence = (value) => clean(value).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
const imageUrlPattern = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i;
const lowTrustDomains = ["tripadvisor.com", "facebook.com", "instagram.com", "youtube.com", "tiktok.com", "x.com", "twitter.com", "wikipedia.org", "wikivoyage.org"];
const majorOtaDomains = ["booking.com", "expedia.com", "agoda.com", "hotels.com", "trip.com"];
const officialPressDomains = ["pressarea.com", "prnewswire.com", "businesswire.com"];
const trustedTradeDomains = ["sleepermagazine.com", "hospitalitydesign.com", "hotelmanagement-network.com", "hoteldesigns.net", "dezeen.com", "designboom.com", "archdaily.com", "travelweekly.com", "forbestravelguide.com"];
const MAX_EXTERNAL_SOURCE_PAGES = 2;
const authoritativeDomains = ["who.int", "iata.org", "icao.int"];
const orderFactPattern = /(?:本次|客人|订单|报价|行程)[^。；]{0,16}(?:已订|预订|入住.*房型|房型|已含|包含|价格|费用|车型|包车|保证|确保)|(?:your|the) (?:booking|reservation|itinerary)[^.;]{0,24}(?:room|include|price|vehicle|guarantee)/i;
const browserExecutables = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

function normalizedCandidateSources(candidate = {}) {
  const sources = [];
  if (clean(candidate.sourceUrl) || clean(candidate.sourceExcerpt)) {
    sources.push({ sourceUrl: candidate.sourceUrl, sourceExcerpt: candidate.sourceExcerpt, sourceMediaType: candidate.sourceMediaType });
  }
  if (Array.isArray(candidate.sources)) sources.push(...candidate.sources);
  const seen = new Set();
  return sources.map((source) => ({
    sourceUrl: clean(source?.sourceUrl),
    sourceExcerpt: clean(source?.sourceExcerpt),
    sourceMediaType: clean(source?.sourceMediaType) || "page",
    sourceClass: clean(source?.sourceClass),
  })).filter((source) => {
    const key = `${source.sourceUrl}\n${source.sourceExcerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

function validateResearchResponseJson(json, researchRequest) {
  if (!json || typeof json !== "object" || Array.isArray(json) || !Array.isArray(json.facts)) return ["根对象必须包含 facts 数组"];
  const requestedCategories = new Set((researchRequest.categories || []).map(clean));
  const errors = [];
  json.facts.forEach((fact, index) => {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
      errors.push(`facts.${index} 必须是对象`);
      return;
    }
    if (!requestedCategories.has(clean(fact.category))) errors.push(`facts.${index}.category 不在请求类别中`);
    if (!clean(fact.fact)) errors.push(`facts.${index}.fact 不能为空`);
    if (!Array.isArray(fact.sources) || fact.sources.length < 1 || fact.sources.length > 3) errors.push(`facts.${index}.sources 必须包含 1—3 个候选来源`);
    else fact.sources.forEach((source, sourceIndex) => {
      if (!clean(source?.sourceUrl)) errors.push(`facts.${index}.sources.${sourceIndex}.sourceUrl 不能为空`);
      if (!clean(source?.sourceExcerpt)) errors.push(`facts.${index}.sources.${sourceIndex}.sourceExcerpt 不能为空`);
      if (clean(source?.sourceMediaType) !== "page") errors.push(`facts.${index}.sources.${sourceIndex}.sourceMediaType 只能是 page`);
      if (source?.sourceClass !== undefined && !["official_entity", "official_brand", "official_press", "operator_or_tourism_authority", "architect_or_design_studio", "trusted_trade_media", "major_ota"].includes(clean(source.sourceClass))) errors.push(`facts.${index}.sources.${sourceIndex}.sourceClass 不在允许枚举中`);
    });
  });
  return errors;
}

function hostMatches(hostname, domain) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const expected = clean(domain).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return Boolean(expected) && (host === expected || host.endsWith(`.${expected}`));
}

function entityDomainTokens(entityName) {
  const ignored = new Set(["hotel", "lodge", "camp", "resort", "tented", "the", "and", "spa", "official"]);
  return clean(entityName).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !ignored.has(token));
}

function isGovernmentHost(hostname) {
  const host = hostname.toLowerCase();
  return /(?:^|\.)gov$/.test(host) || /(?:^|\.)(?:gov|gob|go)(?:\.[a-z]{2,})+$/.test(host) || /(?:^|\.)embassy\./.test(host);
}

function isAllowedOfficialSource(url, request) {
  let hostname;
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if ([...lowTrustDomains, ...majorOtaDomains, ...officialPressDomains, ...trustedTradeDomains].some((domain) => hostMatches(hostname, domain))) return false;
  const declaredDomains = Array.isArray(request.officialDomains) ? request.officialDomains : [];
  if (declaredDomains.some((domain) => hostMatches(hostname, domain))) return true;
  if (request.researchType === "authoritative_current_facts") {
    if (isGovernmentHost(hostname) || authoritativeDomains.some((domain) => hostMatches(hostname, domain))) return true;
  }
  const labels = hostname.replace(/^www\./, "").split(".");
  const countrySecondLevels = new Set(["co", "com", "org", "net", "gov", "go"]);
  const registeredLabel = labels.length >= 3 && labels.at(-1).length === 2 && countrySecondLevels.has(labels.at(-2)) ? labels.at(-3) : labels.at(-2);
  const normalizedLabel = clean(registeredLabel).replace(/[^a-z0-9]/g, "");
  return entityDomainTokens(request.entityName).some((token) => normalizedLabel === token || normalizedLabel.startsWith(token));
}

function isKnownLowTrustSource(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return lowTrustDomains.some((domain) => hostMatches(hostname, domain));
  } catch { return true; }
}

function externalSourceClass(url) {
  let hostname;
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return ""; }
  if (majorOtaDomains.some((domain) => hostMatches(hostname, domain))) return "major_ota";
  if (officialPressDomains.some((domain) => hostMatches(hostname, domain))) return "official_press";
  if (trustedTradeDomains.some((domain) => hostMatches(hostname, domain))) return "trusted_trade_media";
  if (isGovernmentHost(hostname)) return "tourism_authority";
  return "";
}

function externalClassAllowsCategory(sourceClass, category) {
  const normalized = clean(category);
  if (!sourceClass) return false;
  if (sourceClass === "major_ota") return /位置|客房|房型|设施|景观|公共空间|住宿体验/.test(normalized) && !/设计/.test(normalized);
  if (sourceClass === "trusted_trade_media") return /位置|客房|房型|设计|设施|景观|公共空间|住宿体验/.test(normalized);
  if (sourceClass === "architect_or_design_studio") return /设计|空间/.test(normalized);
  if (sourceClass === "official_press" || sourceClass === "tourism_authority") return true;
  return false;
}

function isBudgetedExternalClass(sourceClass) {
  return sourceClass === "architect_or_design_studio" || sourceClass === "trusted_trade_media" || sourceClass === "major_ota";
}

function declaredControlledSourceClass(candidate = {}) {
  const declared = clean(candidate.sourceClass);
  if (declared === "operator_or_tourism_authority") return "tourism_authority";
  if (declared === "architect_or_design_studio") return "architect_or_design_studio";
  return "";
}

function entityEvidenceTokens(entityName) {
  const latin = entityDomainTokens(entityName);
  const cjk = clean(entityName).toLowerCase().match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...latin, ...cjk])];
}

function pageMentionsEntity(body, entityName) {
  const text = clean(String(body || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).toLowerCase();
  const tokens = entityEvidenceTokens(entityName);
  if (!tokens.length) return false;
  return tokens.filter((token) => text.includes(token)).length >= Math.min(2, tokens.length);
}

function pageSupportsDeclaredControlledClass(body, entityName, sourceClass) {
  if (!pageMentionsEntity(body, entityName)) return false;
  const html = String(body || "");
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((match) => clean(match[1].replace(/<[^>]+>/g, " "))).join(" ");
  const jsonLd = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join(" ");
  const local = clean(`${title} ${headings} ${jsonLd}`).toLowerCase();
  if (/(?:review|blog|forum|traveller|traveler|user review|guest review)/i.test(local)) return false;
  if (sourceClass === "architect_or_design_studio") return /(?:architecture|architect|interior design|design studio|portfolio|project)/i.test(local);
  if (sourceClass === "tourism_authority") return /(?:tourism|tourist board|conservancy|reserve|official|operator|government organization|organization)/i.test(local);
  return false;
}

function canonicalPageUrl(body, responseUrl) {
  const canonical = htmlAttribute(body, "link(?=[^>]*\\brel=[\"']canonical[\"'])", "href");
  if (!canonical) return clean(responseUrl);
  try { return new URL(canonical, responseUrl).href; } catch { return clean(responseUrl); }
}

function candidatePriority(candidate, request) {
  const sourceUrl = clean(candidate?.sourceUrl);
  if (isAllowedOfficialSource(sourceUrl, request)) return 0;
  const sourceClass = externalSourceClass(sourceUrl) || declaredControlledSourceClass(candidate);
  if (sourceClass === "official_press" || sourceClass === "tourism_authority") return 2;
  if (sourceClass === "trusted_trade_media") return 3;
  if (sourceClass === "major_ota") return 4;
  if (isKnownLowTrustSource(sourceUrl)) return 9;
  return 1;
}

function htmlAttribute(body, tagPattern, attribute) {
  const match = String(body || "").match(new RegExp(`<${tagPattern}[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, "i"));
  return clean(match?.[1]);
}

function metaContent(body, key, value) {
  const html = String(body || "");
  const direct = html.match(new RegExp(`<meta[^>]*\\b${key}=["']${value}["'][^>]*\\bcontent=["']([^"']+)["'][^>]*>`, "i"));
  const reversed = html.match(new RegExp(`<meta[^>]*\\bcontent=["']([^"']+)["'][^>]*\\b${key}=["']${value}["'][^>]*>`, "i"));
  return clean(direct?.[1] || reversed?.[1]);
}

function pageEstablishesOfficialEntity(body, responseUrl, request) {
  if (request.researchType !== "official_entity_facts") return false;
  const html = String(body || "");
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const headings = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => clean(match[1].replace(/<[^>]+>/g, " "))).join(" ");
  const ogTitle = metaContent(html, "property", "og:title") || metaContent(html, "name", "og:title");
  const jsonLd = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join(" ");
  const identityText = clean([title, headings, ogTitle, jsonLd].join(" ")).toLowerCase();
  const tokens = entityDomainTokens(request.entityName);
  const matched = tokens.filter((token) => identityText.includes(token));
  const identityThreshold = Math.min(2, tokens.length);
  if (!identityThreshold || matched.length < identityThreshold) return false;

  const hasEntitySchema = /"@type"\s*:\s*(?:\[[^\]]*)?["']?(?:hotel|lodgingbusiness|resort|campground|organization|corporation|brand)\b/i.test(jsonLd)
    && /"(?:name|brand|parentOrganization)"\s*:/i.test(jsonLd);
  let canonicalSameHost = false;
  const canonical = htmlAttribute(html, "link(?=[^>]*\\brel=[\"']canonical[\"'])", "href");
  if (canonical) {
    try { canonicalSameHost = hostMatches(new URL(canonical, responseUrl).hostname, new URL(responseUrl).hostname); } catch { canonicalSameHost = false; }
  }
  const hasFirstPartyBookingSurface = /(?:official\s+(?:site|website)|book\s+(?:now|a stay|your stay)|reserve\s+(?:now|a room)|check\s+availability)/i.test(html);
  let registeredLabel = "";
  try {
    const labels = new URL(responseUrl).hostname.replace(/^www\./, "").split(".");
    const countrySecondLevels = new Set(["co", "com", "org", "net", "gov", "go"]);
    registeredLabel = labels.length >= 3 && labels.at(-1).length === 2 && countrySecondLevels.has(labels.at(-2)) ? labels.at(-3) : labels.at(-2);
  } catch {}
  const normalizedOwnerLabel = clean(registeredLabel).toLowerCase().replace(/[^a-z0-9]/g, "");
  const ownerBlocks = [...jsonLd.matchAll(/"(?:brand|parentOrganization)"\s*:\s*(?:\{[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?\}|"([^"]+)")/gi)]
    .map((match) => clean(match[1] || match[2]).toLowerCase().replace(/[^a-z0-9]/g, ""));
  const ownerMatchesDomain = Boolean(normalizedOwnerLabel) && ownerBlocks.some((owner) => owner.includes(normalizedOwnerLabel) || normalizedOwnerLabel.includes(owner));
  return hasEntitySchema && canonicalSameHost && hasFirstPartyBookingSurface && ownerMatchesDomain;
}

function sourceUrlVariants(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const labels = parsed.hostname.split(".");
    if (labels.length !== 2 && !(labels.length === 3 && parsed.hostname.startsWith("www."))) return [parsed.href];
    const alternate = new URL(parsed.href);
    alternate.hostname = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : `www.${parsed.hostname}`;
    return [...new Set([parsed.href, alternate.href])];
  } catch { return [sourceUrl]; }
}

async function fetchOfficialPageWithBrowser(sourceUrl, { signal, timeoutMs = 30_000 } = {}) {
  await assertPublicUrl(sourceUrl);
  const executablePath = browserExecutables.find((candidate) => existsSync(candidate));
  if (!executablePath) throw new Error("未找到可用于官方页面核验的 Chrome/Edge");
  if (signal?.aborted) throw signal.reason || new Error("官方页面核验已取消");
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.setRequestInterception(true);
    page.on("request", (request) => ["image", "media", "font"].includes(request.resourceType()) ? request.abort() : request.continue());
    const response = await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const status = Number(response?.status() || 0);
    const body = await page.content();
    return {
      ok: status >= 200 && status < 300,
      status,
      url: page.url(),
      headers: { get: (name) => name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null },
      text: async () => body,
    };
  } finally {
    await browser.close();
  }
}

function sourceSupportsExcerpt(body, excerpt) {
  const normalizedBody = clean(body).toLowerCase();
  const normalizedExcerpt = clean(excerpt).toLowerCase();
  if (!normalizedBody || !normalizedExcerpt) return false;
  if (normalizedBody.includes(normalizedExcerpt)) return true;
  const tokens = [...new Set(normalizedExcerpt.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((token) => token.length >= 4))];
  return tokens.length > 0 && tokens.filter((token) => normalizedBody.includes(token)).length >= Math.min(3, tokens.length);
}

function pageSignalsUnavailable(body) {
  const title = clean(String(body || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).toLowerCase();
  return /(?:page|content|resource)\s+(?:not\s+found|unavailable)|(?:404|403)\s+(?:error|not\s+found)|页面(?:不存在|未找到)|找不到(?:该|此)?页面/.test(title);
}

export function validateCopyResearchRequest(request = {}) {
  const errors = [];
  if (!COPY_FACTS_RESEARCH_TYPES.includes(request.researchType)) errors.push("researchType 仅支持 official_entity_facts 或 authoritative_current_facts");
  if (!clean(request.entityName)) errors.push("entityName 不能为空");
  if (!Array.isArray(request.categories) || !request.categories.map(clean).filter(Boolean).length) errors.push("categories 必须是非空数组");
  if (request.officialDomains !== undefined && !Array.isArray(request.officialDomains)) errors.push("officialDomains 必须是数组");
  return errors;
}

export function buildCopyFactsResearchRequest({ researchRequest, model = COPY_FACTS_RESEARCH_MODEL, checkedAt = new Date().toISOString() }) {
  return {
    model,
    stream: false,
    reasoning_effort: "low",
    thinking: { type: "disabled" },
    max_tokens: 6_000,
    messages: [
      {
        role: "system",
        content: [
          "你是 Copy Skill 内部的事实研究员，不是独立 Pipeline 阶段。只研究输入实体与指定类别。",
          "official_entity_facts 一次研究输入酒店的全部指定类别，来源优先级为：实体/品牌官网与 Fact Sheet → 品牌官方新闻稿 → 正式运营方或旅游主管机构 → 建筑/设计机构的具体项目页 → 可信酒店行业媒体 → 主流 OTA。后五类只作为官方缺失字段的候选，必须返回具体页面和原文，不能用搜索摘要代替。",
          "authoritative_current_facts 只能采用政府、使领馆、正式国际组织或输入指定的正式运营方页面。没有可靠来源时返回空 facts，不要猜测。",
          "公开研究只能补充实体客观是什么、有什么，绝不能推断或改变本订单购买了什么。不得声明本次房型、包含项、价格、已保证车型、已预订服务或正式状态。",
          "酒店类别固定按输入的‘位置、客房、设计、设施’理解。客房只描述酒店公开房型或景观选择，不得推断本次预订房型；OTA 只能候选支持位置、一般房型与设施，不能证明设计。",
          "每个指定类别最多返回一条精炼事实；一条只保留一个可直接用于文案的核心事实，不要把设施、活动、儿童政策和多段宣传合并成长段。每条事实可返回 1—3 个相互独立的候选页面，按上述来源优先级排序，每个页面必须附上该页自身的原文证据和 sourceClass。sourceClass 只能是 official_entity、official_brand、official_press、operator_or_tourism_authority、architect_or_design_studio、trusted_trade_media、major_ota。sourceClass 只是候选标签，程序会独立核验。",
          "品牌官网可能由母品牌官方域托管；不要仅按酒店名与域名字符是否相同判断。优先返回实体或品牌官方具体页，并在页面标题、结构化数据或正文中确认实体全名。输入 officialDomains 时优先使用这些已知官方域。",
          "禁止采用博客、论坛、用户评论、社交平台、百科和图片。每个来源必须给出可访问的具体页面 URL 和页面中的简短原文证据。只输出 JSON：{facts:[{category,fact,sources:[{sourceUrl,sourceExcerpt,sourceMediaType:\"page\",sourceClass}]}]}。没有可靠事实时输出 {facts:[]}。",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify({ ...researchRequest, checkedAt }) },
    ],
  };
}

export async function requestCopyFactsResearch({ apiKey, baseUrl, model = COPY_FACTS_RESEARCH_MODEL, researchRequest, signal, fetchImpl = fetch, emptyContentRetries = 1 }) {
  if (!apiKey) throw Object.assign(new Error("尚未配置 Copy Facts Research API Key"), { code: "copy_facts_research_not_configured" });
  const attemptUsages = [];
  const attempts = Math.max(1, Number(emptyContentRetries) + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const body = buildCopyFactsResearchRequest({ researchRequest, model });
    const response = await fetchImpl(`${String(baseUrl || "https://api.vveai.com/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || payload?.message || `Copy Facts Research 请求失败（${response.status}）`), { code: "copy_facts_research_request_failed", status: response.status, attemptUsages });
    const content = payload?.choices?.[0]?.message?.content;
    const attemptRecord = { attempt, usage: payload.usage || null, finishReason: payload?.choices?.[0]?.finish_reason || null, receivedContentChars: clean(content).length, outcome: clean(content) ? "received" : "empty_content" };
    attemptUsages.push(attemptRecord);
    if (!clean(content) && attempt < attempts) continue;
    if (!clean(content)) throw Object.assign(new Error(`Copy Facts Research 连续 ${attempts} 次没有返回可用内容`), { code: "copy_facts_research_empty", attemptUsages });
    try {
      const json = JSON.parse(stripFence(content));
      const structureErrors = validateResearchResponseJson(json, researchRequest);
      if (structureErrors.length) {
        attemptRecord.outcome = "invalid_structure";
        if (attempt < attempts) continue;
        throw Object.assign(new Error(`Copy Facts Research 返回结构不符合契约：${structureErrors.join("；")}`), { code: "copy_facts_research_invalid_structure", attemptUsages });
      }
      return { json, model: payload.model || model, usage: payload.usage || null, attemptUsages };
    } catch (error) {
      if (error?.code === "copy_facts_research_invalid_structure") throw error;
      attemptRecord.outcome = "invalid_json";
      if (attempt < attempts) continue;
      throw Object.assign(new Error(`Copy Facts Research 未返回合法 JSON：${error.message}`), { code: "copy_facts_research_invalid_json", attemptUsages });
    }
  }
  throw Object.assign(new Error("Copy Facts Research 未返回结果"), { code: "copy_facts_research_empty", attemptUsages });
}

export async function verifyCopyFactsResearch({ researchRequest, candidates = [], checkedAt = new Date().toISOString(), signal, fetchSource = fetchPublicUrl, fetchBrowserSource = fetchOfficialPageWithBrowser } = {}) {
  const requestedCategories = new Set((researchRequest.categories || []).map(clean));
  const verifiedFacts = [];
  const rejected = [];
  const verifiedCategories = new Set();
  const externalPagesUsed = new Set();
  const sourceCache = new Map();
  const fetchPage = async (candidateUrl, fetcher, mode) => {
    const cacheKey = `${mode}:${candidateUrl}`;
    if (!sourceCache.has(cacheKey)) sourceCache.set(cacheKey, (async () => {
      const response = await fetcher(candidateUrl, {
        signal,
        timeoutMs: mode === "browser" ? 30_000 : 20_000,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
        },
      });
      const contentType = clean(response.headers?.get?.("content-type"));
      const body = response.ok && !/^image\//i.test(contentType) ? await response.text() : "";
      return { response, contentType, body };
    })());
    return sourceCache.get(cacheKey);
  };
  const expandedCandidates = (Array.isArray(candidates) ? candidates : []).flatMap((candidate) => {
    const sources = normalizedCandidateSources(candidate);
    return sources.length ? sources.map((source) => ({ ...candidate, ...source, sources: undefined })) : [candidate];
  }).map((candidate, index) => ({ ...candidate, _candidateOrder: index }))
    .sort((left, right) => candidatePriority(left, researchRequest) - candidatePriority(right, researchRequest) || left._candidateOrder - right._candidateOrder);
  for (const candidate of expandedCandidates) {
    const category = clean(candidate?.category);
    const fact = clean(candidate?.fact);
    const sourceUrl = clean(candidate?.sourceUrl);
    const sourceExcerpt = clean(candidate?.sourceExcerpt);
    let resolvedSourceUrl = sourceUrl;
    let resolvedSourceClass = "";
    let reason = "";
    let verificationAttempts = [];
    if (!category || !requestedCategories.has(category)) reason = "category_not_requested";
    else if (!fact || !sourceUrl || !sourceExcerpt) reason = "fact_source_incomplete";
    else if (orderFactPattern.test(fact)) reason = "order_fact_not_researchable";
    else if (candidate?.sourceMediaType === "image" || imageUrlPattern.test(sourceUrl)) reason = "image_not_fact_evidence";
    else if (verifiedCategories.has(category)) reason = "category_fact_limit_exceeded";
    const directlyAllowed = !reason && isAllowedOfficialSource(sourceUrl, researchRequest);
    const declaredSourceClass = declaredControlledSourceClass(candidate);
    const initialExternalClass = !reason ? (externalSourceClass(sourceUrl) || declaredSourceClass) : "";
    if (!reason && isKnownLowTrustSource(sourceUrl)) reason = "source_not_approved";
    if (!reason && initialExternalClass && researchRequest.researchType !== "official_entity_facts" && !directlyAllowed) reason = "source_not_official_or_authoritative";
    if (!reason && initialExternalClass && !externalClassAllowsCategory(initialExternalClass, category)) reason = "source_class_not_allowed_for_category";
    const mayVerifyParentBrandPage = !reason && researchRequest.researchType === "official_entity_facts" && !initialExternalClass;
    const mayVerifyControlledExternal = !reason && researchRequest.researchType === "official_entity_facts" && Boolean(initialExternalClass);
    if (!reason && !directlyAllowed && !mayVerifyParentBrandPage && !mayVerifyControlledExternal) reason = "source_not_official_or_authoritative";
    if (!reason && isBudgetedExternalClass(initialExternalClass)) {
      let externalPageKey = sourceUrl;
      try { const parsed = new URL(sourceUrl); parsed.hash = ""; externalPageKey = parsed.href; } catch {}
      if (!externalPagesUsed.has(externalPageKey) && externalPagesUsed.size >= MAX_EXTERNAL_SOURCE_PAGES) reason = "external_source_page_budget_exhausted";
      else externalPagesUsed.add(externalPageKey);
    }
    if (!reason) {
      for (const candidateUrl of sourceUrlVariants(sourceUrl)) {
        try {
          const { response, contentType, body } = await fetchPage(candidateUrl, fetchSource, "http");
          verificationAttempts.push({ url: candidateUrl, status: response.status || null });
          if (!response.ok) continue;
          if (/^image\//i.test(contentType)) {
            reason = "image_not_fact_evidence";
            break;
          }
          if (pageSignalsUnavailable(body)) {
            reason = "source_unavailable";
            break;
          }
          if (!sourceSupportsExcerpt(body, sourceExcerpt)) {
            reason = "source_excerpt_not_supported";
            break;
          }
          const finalUrl = canonicalPageUrl(body, clean(response.url) || candidateUrl);
          if (isKnownLowTrustSource(finalUrl)) {
            reason = "source_not_approved";
            break;
          }
          const finalUrlDirectlyAllowed = isAllowedOfficialSource(finalUrl, researchRequest);
          const finalExternalClass = externalSourceClass(finalUrl) || initialExternalClass;
          if (directlyAllowed || finalUrlDirectlyAllowed) resolvedSourceClass = "official_entity";
          else if (researchRequest.researchType === "official_entity_facts" && finalExternalClass && externalClassAllowsCategory(finalExternalClass, category) && (declaredSourceClass ? pageSupportsDeclaredControlledClass(body, researchRequest.entityName, finalExternalClass) : pageMentionsEntity(body, researchRequest.entityName))) resolvedSourceClass = finalExternalClass;
          else if (pageEstablishesOfficialEntity(body, finalUrl, researchRequest)) resolvedSourceClass = "official_brand";
          else { reason = "source_not_official_or_authoritative"; break; }
          resolvedSourceUrl = finalUrl;
          reason = "";
          break;
        } catch (error) {
          verificationAttempts.push({ url: candidateUrl, error: clean(error?.message || error) });
        }
      }
      if (!reason && verificationAttempts.length && !verificationAttempts.some((item) => item.status >= 200 && item.status < 300) && fetchBrowserSource) {
        try {
          const { response, contentType, body } = await fetchPage(sourceUrl, fetchBrowserSource, "browser");
          verificationAttempts.push({ url: clean(response.url) || sourceUrl, status: response.status || null, mode: "browser" });
          if (response.ok && pageSignalsUnavailable(body)) reason = "source_unavailable";
          else if (response.ok && !/^image\//i.test(contentType) && sourceSupportsExcerpt(body, sourceExcerpt)) {
            const finalUrl = canonicalPageUrl(body, clean(response.url) || sourceUrl);
            const finalUrlDirectlyAllowed = isAllowedOfficialSource(finalUrl, researchRequest);
            const finalExternalClass = externalSourceClass(finalUrl) || initialExternalClass;
            if (isKnownLowTrustSource(finalUrl)) reason = "source_not_approved";
            else if (directlyAllowed || finalUrlDirectlyAllowed) {
              resolvedSourceUrl = finalUrl;
              resolvedSourceClass = "official_entity";
              reason = "";
            }
            else if (researchRequest.researchType === "official_entity_facts" && finalExternalClass && externalClassAllowsCategory(finalExternalClass, category) && (declaredSourceClass ? pageSupportsDeclaredControlledClass(body, researchRequest.entityName, finalExternalClass) : pageMentionsEntity(body, researchRequest.entityName))) {
              resolvedSourceUrl = finalUrl;
              resolvedSourceClass = finalExternalClass;
              reason = "";
            } else if (pageEstablishesOfficialEntity(body, finalUrl, researchRequest)) {
              resolvedSourceUrl = finalUrl;
              resolvedSourceClass = "official_brand";
              reason = "";
            } else reason = "source_not_official_or_authoritative";
          } else if (response.ok && !sourceSupportsExcerpt(body, sourceExcerpt)) reason = "source_excerpt_not_supported";
        } catch (error) {
          verificationAttempts.push({ url: sourceUrl, error: clean(error?.message || error), mode: "browser" });
        }
      }
      if (!reason && verificationAttempts.length && !verificationAttempts.some((item) => item.status >= 200 && item.status < 300)) reason = "source_unavailable";
    }
    if (reason) {
      rejected.push({ category, fact, sourceUrl, reason, ...(verificationAttempts.length ? { verificationAttempts } : {}) });
      continue;
    }
    verifiedFacts.push({ category, fact, sourceUrl: resolvedSourceUrl, sourceExcerpt, sourceClass: resolvedSourceClass || "official_entity", checkedAt });
    verifiedCategories.add(category);
  }
  const categoryOutcomes = [...requestedCategories].map((category) => {
    if (verifiedCategories.has(category)) return { category, status: "success" };
    const categoryRejections = rejected.filter((item) => item.category === category);
    const unavailable = categoryRejections.length > 0 && categoryRejections.every((item) => item.reason === "source_unavailable");
    return { category, status: unavailable ? "source_unavailable" : "not_found" };
  });
  return { researchType: researchRequest.researchType, entityName: clean(researchRequest.entityName), verifiedFacts, rejected, categoryOutcomes, externalSourcePagesUsed: externalPagesUsed.size };
}

export async function runCopyFactsResearch({ researchRequest, apiKey, baseUrl, model = COPY_FACTS_RESEARCH_MODEL, signal, requestResearch = requestCopyFactsResearch, fetchSource = fetchPublicUrl } = {}) {
  const errors = validateCopyResearchRequest(researchRequest);
  if (errors.length) throw Object.assign(new Error(errors.join("；")), { code: "invalid_copy_research_request", fields: errors });
  const startedAt = Date.now();
  const response = await requestResearch({ apiKey, baseUrl, model, researchRequest, signal });
  const verified = await verifyCopyFactsResearch({ researchRequest, candidates: response.json?.facts, signal, fetchSource });
  return {
    ...verified,
    status: verified.verifiedFacts.length ? "success" : "not_found",
    model: response.model || model,
    usage: response.usage || null,
    attemptUsages: response.attemptUsages || [],
    durationMs: Date.now() - startedAt,
  };
}
