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

export function parseSearchResults(content) {
  const text = messageText(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini 搜索未返回可解析的 JSON");
  const payload = JSON.parse(text.slice(start, end + 1));
  const results = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.sources) ? payload.sources : [];
  return results.map((item) => ({
    title: String(item?.title || "").trim(),
    pageUrl: String(item?.url || item?.link || "").trim(),
    summary: String(item?.summary || item?.snippet || item?.content || "").trim(),
  })).filter((item) => /^https?:\/\//i.test(item.pageUrl));
}

async function resolveGroundingRedirect(value, signal) {
  const url = await assertPublicUrl(value);
  if (url.hostname !== "vertexaisearch.cloud.google.com") return url.href;
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 LuxuryTravelImageResearch/1.0", accept: "text/html,application/xhtml+xml" },
    signal,
  });
  const finalUrl = response.url;
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`搜索来源跳转失败（${response.status}）`);
  await assertPublicUrl(finalUrl);
  return finalUrl;
}

async function runSearchRequest({ userPrompt, apiKey, baseUrl, model, count, signal }) {
  if (!apiKey) throw new Error("尚未配置 Gemini 图片搜索 API 密钥");
  if (!model) throw new Error("尚未配置 Gemini 图片搜索模型");
  const response = await fetch(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
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
  const raw = parseSearchResults(payload?.choices?.[0]?.message?.content);
  const resolved = [];
  for (const [index, item] of raw.slice(0, count).entries()) {
    try {
      const pageUrl = await resolveGroundingRedirect(item.pageUrl, signal);
      resolved.push({ ...item, pageUrl, media: "", searchRank: index + 1, officialHint: isOfficialSource(pageUrl) });
    } catch (error) {
      resolved.push({ ...item, media: "", searchRank: index + 1, officialHint: isOfficialSource(item.pageUrl), resolutionError: error?.cause?.message || error?.message || String(error) });
    }
  }
  return resolved.filter(Boolean).filter((item, index, array) => array.findIndex((other) => other.pageUrl === item.pageUrl) === index);
}

export async function searchWeb({ query, apiKey, baseUrl, model, count = 10, signal }) {
  return runSearchRequest({
    userPrompt: `搜索包含高清照片或官方图库的页面：${String(query).slice(0, 180)}`,
    apiKey,
    baseUrl,
    model,
    count,
    signal,
  });
}

export async function searchWebBatch({ queries, apiKey, baseUrl, model, count = 6, signal }) {
  const normalized = [...new Set((Array.isArray(queries) ? queries : []).map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 3);
  if (!normalized.length) throw new Error("图片搜索至少需要一个 query");
  return runSearchRequest({
    userPrompt: `围绕同一个图片位执行一次完整搜索。以下是同一视觉目标的不同搜索表达，请合并搜索覆盖、去重后返回最有价值的来源页面，不要把它们当成多轮任务：\n${normalized.map((query, index) => `${index + 1}. ${query.slice(0, 180)}`).join("\n")}`,
    apiKey,
    baseUrl,
    model,
    count,
    signal,
  });
}
