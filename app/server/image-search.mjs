import { assertPublicUrl } from "./page-images.mjs";
import { createOperationTrace, safeErrorDetails, operationAbortDetails } from './operation-trace.mjs';

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

export async function resolveGroundingRedirect(value, signal, fetchImpl = fetch, trace) {
  const measure = (phase, fn) => trace ? trace.measure(phase, fn) : fn();
  const url = await measure('source_dns', () => assertPublicUrl(value));
  if (!isGroundingRedirectUrl(url.href)) return url.href;
  const response = await measure('redirect_http', () => fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "Mozilla/5.0 LuxuryTravelImageResearch/1.0", accept: "text/html,application/xhtml+xml" },
    signal,
  }));
  const location = response.headers.get("location");
  if (location) {
    const finalUrl = new URL(location, url).href;
    await response.body?.cancel().catch(() => undefined);
    if (isGroundingRedirectUrl(finalUrl)) throw new Error("grounding_redirect_unresolved");
    await measure('source_dns', () => assertPublicUrl(finalUrl));
    return finalUrl;
  }
  if (response.ok) {
    const html = await measure('redirect_body', () => response.text());
    const match = html.match(/<(?:link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href|meta[^>]+(?:property|name)=["']og:url["'][^>]+content)=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=([^"']+)["']/i);
    if (match?.[1]) {
      const finalUrl = new URL(match[1].trim(), url).href;
      if (!isGroundingRedirectUrl(finalUrl)) { await measure('source_dns', () => assertPublicUrl(finalUrl)); return finalUrl; }
    }
  } else await response.body?.cancel().catch(() => undefined);
  throw new Error("grounding_redirect_unresolved");
}

async function runSearchRequest(input) {
  const trace = createOperationTrace('web_search', input.traceContext);
  try { const value = await tracedSearchRequest({ ...input, trace }); trace.emit('search_complete', { resultCount: value.length }); return value; }
  catch (error) {
    trace.emit('search_failed', { ...safeErrorDetails(error), ...operationAbortDetails(error, input.signal) });
    // Preserve the original failure and retry policy while making failed
    // attempts measurable alongside successful requests.
    if (error && typeof error === 'object' && Object.isExtensible(error) && !Object.hasOwn(error, 'timing')) {
      Object.defineProperty(error, 'timing', { value: {requestId: trace.requestId, phases: {...trace.timings}}, enumerable: false, configurable: true });
    }
    throw error;
  }
}

async function tracedSearchRequest({ userPrompt, apiKey, baseUrl, model, count, signal, fetchImpl = fetch, trace, requestTimeoutMs = 300_000 }) {
  if (!apiKey) throw new Error("尚未配置 Gemini 图片搜索 API 密钥");
  if (!model) throw new Error("尚未配置 Gemini 图片搜索模型");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(requestTimeoutMs) || 300_000));
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timed = fn => async () => {
    try { return await fn(); }
    catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw Object.assign(new Error('图片搜索响应超时'), { code: 'search_response_timeout', cause: error });
      throw error;
    }
  };
  let response, payload;
  try {
  response = await trace.measure('http_headers', timed(() => fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `你是高端旅行图片资料搜索员。使用实时网络搜索，为后续网页图片提取寻找真实、可访问的来源页面。搜索具体酒店时优先该酒店的专属介绍页及专属图库，核对页面路径和标题确实对应目标酒店；不要用品牌首页、地区总览或其他酒店页面充数。优先酒店、营地、航空公司、旅游局等官方网站，其次可信旅行媒体和 Wikimedia Commons。官网拒绝访问时仍返回本次搜索中可核验的第三方专属页面；不要猜测图片直链或绕过访问限制。只返回 JSON：{"results":[{"title":"页面标题","url":"https://真实搜索结果页面","summary":"页面为什么可能包含所需图片"}]}。最多返回 ${Math.max(1, Math.min(12, count))} 条。URL 必须来自本次搜索结果，禁止编造 URL，禁止返回图片 data URI；尽量返回目标页面的 canonical URL，不要返回 vertexaisearch.cloud.google.com 中转跳转地址。`,
        },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2400,
    }),
    signal: requestSignal,
  })));
  trace.emit('http_status', { statusCode: response.status });
  try { payload = await trace.measure('response_body', timed(() => response.json())); }
  catch (error) {
    // Keep an actual HTTP rejection distinguishable from malformed successful
    // content. The body-read failure is already recorded by the trace.
    if (response.ok || controller.signal.aborted || signal?.aborted) throw error;
    payload = {};
  }
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const upstreamCode = String(payload?.error?.code || payload?.code || "").slice(0, 80);
    const upstreamMessage = String(payload?.error?.message || payload?.message || "").slice(0, 300);
    const quotaRejected = /(?:insufficient[_ -]?(?:quota|balance|credit)|(?:quota|balance|credit)[_ -]?(?:exhausted|insufficient|exceeded)|prepay.{0,30}(?:insufficient|exhausted|not enough)|预扣额度不足|余额不足|额度不足)/i.test(`${upstreamCode} ${upstreamMessage}`);
    const code = quotaRejected ? "search_quota_rejected" : response.status === 429 ? "search_rate_limited" : "search_provider_failed";
    const error = new Error(quotaRejected ? "图片搜索服务明确拒绝：额度不足" : `图片搜索服务请求失败（HTTP ${response.status}）`);
    error.code = code;
    error.status = response.status;
    error.upstreamCode = /^[a-z][a-z0-9_.-]{0,79}$/i.test(upstreamCode) ? upstreamCode : null;
    throw error;
  }
  const raw = await trace.measure('parse', () => mergeSearchSources(parseSearchResults(payload?.choices?.[0]?.message?.content), parseSearchMetadata(payload)));
  const sources = raw.slice(0, count);
  const resolved = new Array(sources.length);
  const sourceDiagnostics = new Array(sources.length);
  const concurrencyLimit = 2;
  let nextIndex = 0, active = 0, concurrencyPeak = 0;
  // Limit only post-search URL resolution. Indexed writes preserve provider
  // priority and duplicate precedence even when redirects finish out of order.
  await trace.measure('source_resolution', () => Promise.all(Array.from({ length: Math.min(concurrencyLimit, sources.length) }, async () => {
    while (nextIndex < sources.length) {
      const index = nextIndex++, item = sources[index];
      active += 1;
      concurrencyPeak = Math.max(concurrencyPeak, active);
      try {
        const pageUrl = await resolveGroundingRedirect(item.pageUrl, signal, fetchImpl, trace);
        resolved[index] = { ...item, pageUrl, media: "", searchRank: index + 1, officialHint: isOfficialSource(pageUrl) };
      } catch (error) {
        if (isGroundingRedirectUrl(item.pageUrl)) sourceDiagnostics[index] = { code: "grounding_redirect_unresolved", pageUrl: item.pageUrl, title: item.title, reason: error?.cause?.message || error?.message || String(error) };
      } finally { active -= 1; }
    }
  })));
  const diagnostics = sourceDiagnostics.filter(Boolean);
  trace.emit('source_resolution_summary', { concurrencyLimit, concurrencyPeak, sourceCount: sources.length, resolvedCount: resolved.filter(Boolean).length });
  const output = resolved.filter(Boolean).filter((item, index, array) => array.findIndex((other) => other.pageUrl === item.pageUrl) === index);
  Object.defineProperty(output, "diagnostics", { value: diagnostics, enumerable: false });
  Object.defineProperty(output, 'timing', { value: { requestId: trace.requestId, phases: trace.timings }, enumerable: false });
  return output;
}

export async function searchWeb({ query, apiKey, baseUrl, model, count = 10, signal, fetchImpl, traceContext, requestTimeoutMs }) {
  return runSearchRequest({
    userPrompt: `搜索包含高清照片或官方图库的页面：${String(query).slice(0, 180)}`,
    apiKey,
    baseUrl,
    model,
    count,
    signal,
    fetchImpl, traceContext, requestTimeoutMs,
  });
}

export async function searchWebBatch({ queries, apiKey, baseUrl, model, count = 6, signal, fetchImpl, traceContext, requestTimeoutMs }) {
  const normalized = [...new Set((Array.isArray(queries) ? queries : []).map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 3);
  if (!normalized.length) throw new Error("图片搜索至少需要一个 query");
  return runSearchRequest({
    userPrompt: `围绕同一个图片位执行一次完整搜索。以下是同一视觉目标的不同搜索表达，请合并搜索覆盖、去重后返回最有价值的来源页面，不要把它们当成多轮任务：\n${normalized.map((query, index) => `${index + 1}. ${query.slice(0, 180)}`).join("\n")}`,
    apiKey,
    baseUrl,
    model,
    count,
    signal,
    fetchImpl, traceContext, requestTimeoutMs,
  });
}
