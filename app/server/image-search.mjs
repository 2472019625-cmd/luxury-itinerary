import { assertPublicUrl } from "./page-images.mjs";

const officialDomains = [
  "marriott.com", "ritzcarlton.com", "singita.com", "melia.com", "relaischateaux.com",
  "andbeyond.com", "angama.com", "saruni.com", "nimali.com", "serenahotels.com",
  "coastal.co.tz", "magicalkenya.com", "kws.go.ke", "tanzaniatourism.go.tz",
];

export function isOfficialSource(...urls) {
  return urls.some((value) => {
    try {
      const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
      return officialDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  });
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n");
  return "";
}

export function isGroundingRedirectUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)google\.com$/i.test(url.hostname) && /\/grounding-api-redirect(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function firstUrl(item) {
  const containers = [item, item?.source, item?.citation, item?.web, item?.url_citation, item?.metadata].filter(Boolean);
  const keys = ["canonicalUrl", "canonical_url", "originalUrl", "original_url", "sourceUrl", "source_url", "uri", "url", "link", "href"];
  for (const container of containers) {
    for (const key of keys) {
      const value = String(container?.[key] || "").trim();
      if (/^https?:\/\//i.test(value)) return value;
    }
  }
  return "";
}

function sourceRecord(item = {}) {
  const nested = item?.source || item?.citation || item?.web || item?.url_citation || item?.metadata || {};
  return {
    title: String(item?.title || item?.name || nested?.title || nested?.name || "").trim(),
    pageUrl: firstUrl(item),
    summary: String(item?.summary || item?.snippet || item?.content || nested?.summary || nested?.snippet || nested?.content || "").trim(),
  };
}

function collectSourceRecords(value, records, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value)) {
    const record = sourceRecord(value);
    if (record.pageUrl) records.push(record);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) collectSourceRecords(child, records, seen);
}

export function parseSearchMetadata(payload = {}) {
  const message = payload?.choices?.[0]?.message || {};
  const candidate = payload?.candidates?.[0] || {};
  const roots = [
    message.annotations, message.citations, message.sources,
    message.groundingMetadata, message.grounding_metadata,
    payload.citations, payload.sources, payload.groundingMetadata, payload.grounding_metadata,
    payload?.choices?.[0]?.citations, payload?.choices?.[0]?.sources,
    payload?.choices?.[0]?.groundingMetadata, payload?.choices?.[0]?.grounding_metadata,
    candidate.groundingMetadata, candidate.grounding_metadata,
  ].filter(Boolean);
  const records = [];
  for (const root of roots) collectSourceRecords(root, records);
  return records.filter((item, index, array) => item.pageUrl && array.findIndex((other) => other.pageUrl === item.pageUrl) === index);
}

export function parseSearchResults(content) {
  const text = messageText(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini 搜索未返回可解析的 JSON");
  const payload = JSON.parse(text.slice(start, end + 1));
  const results = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.sources) ? payload.sources : [];
  return results.map(sourceRecord).filter((item) => /^https?:\/\//i.test(item.pageUrl));
}

function mergeSearchSources(contentResults, metadataResults) {
  const publicByTitle = new Map(metadataResults.filter((item) => !isGroundingRedirectUrl(item.pageUrl) && item.title).map((item) => [item.title.toLowerCase(), item]));
  const merged = [];
  for (const item of [...metadataResults, ...contentResults]) {
    const replacement = isGroundingRedirectUrl(item.pageUrl) && item.title ? publicByTitle.get(item.title.toLowerCase()) : null;
    const resolved = replacement ? { ...item, ...replacement, summary: item.summary || replacement.summary } : item;
    if (!merged.some((existing) => existing.pageUrl === resolved.pageUrl)) merged.push(resolved);
  }
  return merged;
}

export async function resolveGroundingRedirect(value, signal, fetchImpl = fetch) {
  const url = await assertPublicUrl(value);
  if (!isGroundingRedirectUrl(url.href)) return url.href;
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "Mozilla/5.0 LuxuryTravelImageResearch/1.0", accept: "text/html,application/xhtml+xml" },
    signal,
  });
  const location = response.headers.get("location");
  if (location) {
    const finalUrl = new URL(location, url).href;
    await response.body?.cancel().catch(() => undefined);
    if (isGroundingRedirectUrl(finalUrl)) throw new Error("grounding_redirect_unresolved");
    await assertPublicUrl(finalUrl);
    return finalUrl;
  }
  if (response.ok) {
    const html = await response.text();
    const match = html.match(/<(?:link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href|meta[^>]+(?:property|name)=["']og:url["'][^>]+content)=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=([^"']+)["']/i);
    if (match?.[1]) {
      const finalUrl = new URL(match[1].trim(), url).href;
      if (!isGroundingRedirectUrl(finalUrl)) { await assertPublicUrl(finalUrl); return finalUrl; }
    }
  } else await response.body?.cancel().catch(() => undefined);
  throw new Error("grounding_redirect_unresolved");
}

async function runSearchRequest({ userPrompt, apiKey, baseUrl, model, count, signal, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("尚未配置 Gemini 图片搜索 API 密钥");
  if (!model) throw new Error("尚未配置 Gemini 图片搜索模型");
  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `你是高端旅行图片资料搜索员。使用实时网络搜索，为后续网页图片提取寻找真实、可访问的来源页面。优先酒店、营地、航空公司、旅游局等官方网站及其图库，其次可信旅行媒体和 Wikimedia Commons。只返回 JSON：{"results":[{"title":"页面标题","url":"https://真实搜索结果页面","summary":"页面为什么可能包含所需图片"}]}。最多返回 ${Math.max(1, Math.min(12, count))} 条。URL 必须来自本次搜索结果，禁止编造 URL，禁止返回图片 data URI；尽量返回目标页面的 canonical URL，不要返回 vertexaisearch.cloud.google.com 中转跳转地址。`,
        },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2400,
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Gemini 图片搜索失败（${response.status}）`);
  const contentResults = parseSearchResults(payload?.choices?.[0]?.message?.content);
  const raw = mergeSearchSources(contentResults, parseSearchMetadata(payload));
  const resolved = [];
  const diagnostics = [];
  for (const [index, item] of raw.slice(0, count).entries()) {
    try {
      const pageUrl = await resolveGroundingRedirect(item.pageUrl, signal, fetchImpl);
      resolved.push({ ...item, pageUrl, media: "", searchRank: index + 1, officialHint: isOfficialSource(pageUrl) });
    } catch (error) {
      if (isGroundingRedirectUrl(item.pageUrl)) diagnostics.push({ code: "grounding_redirect_unresolved", pageUrl: item.pageUrl, title: item.title, reason: error?.cause?.message || error?.message || String(error) });
    }
  }
  const output = resolved.filter(Boolean).filter((item, index, array) => array.findIndex((other) => other.pageUrl === item.pageUrl) === index);
  Object.defineProperty(output, "diagnostics", { value: diagnostics, enumerable: false });
  return output;
}

export async function searchWeb({ query, apiKey, baseUrl, model, count = 10, signal, fetchImpl }) {
  return runSearchRequest({
    userPrompt: `搜索包含高清照片或官方图库的页面：${String(query).slice(0, 180)}`,
    apiKey,
    baseUrl,
    model,
    count,
    signal,
    fetchImpl,
  });
}

export async function searchWebBatch({ queries, apiKey, baseUrl, model, count = 6, signal, fetchImpl }) {
  const normalized = [...new Set((Array.isArray(queries) ? queries : []).map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 3);
  if (!normalized.length) throw new Error("图片搜索至少需要一个 query");
  return runSearchRequest({
    userPrompt: `围绕同一个图片位执行一次完整搜索。以下是同一视觉目标的不同搜索表达，请合并搜索覆盖、去重后返回最有价值的来源页面，不要把它们当成多轮任务：\n${normalized.map((query, index) => `${index + 1}. ${query.slice(0, 180)}`).join("\n")}`,
    apiKey,
    baseUrl,
    model,
    count,
    signal,
    fetchImpl,
  });
}
