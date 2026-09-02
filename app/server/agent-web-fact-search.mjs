import { fetchPublicUrl } from "./page-images.mjs";

export const WEB_FACT_SEARCH_MODEL = "gemini-3.7-flash-search";

const clean = (value) => typeof value === "string" ? value.trim() : "";
const stripFence = (value) => clean(value).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

function normalizeSourceName(value, url) {
  if (clean(value)) return clean(value).slice(0, 160);
  try { return new URL(url).hostname; } catch { return "未知来源"; }
}

function normalizeFact(item, verifiedAt) {
  const sourceUrl = clean(item?.sourceUrl || item?.url);
  return {
    subject: clean(item?.subject),
    field: clean(item?.field),
    statement: clean(item?.statement),
    status: ["verified", "conflict", "unverified"].includes(item?.status) ? item.status : "unverified",
    sourceName: normalizeSourceName(item?.sourceName, sourceUrl),
    sourceUrl,
    sourceTier: ["official", "authoritative", "public"].includes(item?.sourceTier) ? item.sourceTier : "public",
    verifiedAt,
    validUntil: clean(item?.validUntil) || null,
    recheckAt: clean(item?.recheckAt) || null,
    conservativeFallback: clean(item?.conservativeFallback) || "该信息暂未取得足够可靠的公开来源，客户文案采用保守表达并等待确认。",
    sourceAccessible: false,
    sourceHttpStatus: null,
  };
}

export function buildWebFactSearchRequest({ factBasis, verificationItems, model = WEB_FACT_SEARCH_MODEL }) {
  return {
    model,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你是旅行事实联网核验员。只核验输入中已有的实体和字段，不新增客户行程、费用、图片位或每日安排。",
          "必须实际联网检索。优先官方来源，其次权威公共来源；每条采用事实必须给出可访问的具体页面URL、来源名称和核验日期。",
          "来源冲突返回 conflict，无可靠来源返回 unverified，并给出保守表达。检索中发现但输入未安排的新体验只能放入 internalSuggestions。",
          "只返回JSON：{facts:[{subject,field,statement,status,sourceName,sourceUrl,sourceTier,validUntil,recheckAt,conservativeFallback}],internalSuggestions:[{title,reason,sourceName,sourceUrl}]}。",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify({ factBasis, verificationItems, verifiedAt: new Date().toISOString() }) },
    ],
  };
}

export async function requestWebFactSearch({ apiKey, baseUrl, factBasis, verificationItems, signal, fetchImpl = fetch, model = WEB_FACT_SEARCH_MODEL }) {
  if (!apiKey) throw new Error("尚未配置联网事实核验 API Key");
  if (model !== WEB_FACT_SEARCH_MODEL) throw new Error(`联网事实核验模型必须为 ${WEB_FACT_SEARCH_MODEL}`);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const combinedSignal = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(`${String(baseUrl || "https://api.vveai.com/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(buildWebFactSearchRequest({ factBasis, verificationItems, model })),
      signal: combinedSignal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.message || `联网事实核验请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!clean(content)) throw new Error("联网事实核验没有返回可用内容");
    let parsed;
    try { parsed = JSON.parse(stripFence(content)); } catch (error) { throw new Error(`联网事实核验未返回合法JSON：${error.message}`); }
    return { parsed, model: payload.model || model, usage: payload.usage || null, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyWebFactSources({ parsed, verificationItems, signal, fetchSource = fetchPublicUrl, verifiedAt = new Date().toISOString() }) {
  const requested = new Set((verificationItems || []).map((item) => `${clean(item.subject)}\u0000${clean(item.field)}`));
  const facts = [];
  const internalSuggestions = Array.isArray(parsed?.internalSuggestions) ? parsed.internalSuggestions.map((item) => ({ title: clean(item?.title), reason: clean(item?.reason), sourceName: normalizeSourceName(item?.sourceName, item?.sourceUrl), sourceUrl: clean(item?.sourceUrl), customerFacing: false })).filter((item) => item.title) : [];
  for (const raw of Array.isArray(parsed?.facts) ? parsed.facts : []) {
    const item = normalizeFact(raw, verifiedAt);
    if (!requested.has(`${item.subject}\u0000${item.field}`)) {
      if (item.statement) internalSuggestions.push({ title: item.statement, reason: `检索发现但不属于既有核验项：${item.subject}/${item.field}`, sourceName: item.sourceName, sourceUrl: item.sourceUrl, customerFacing: false });
      continue;
    }
    if (item.sourceUrl) {
      try {
        const response = await fetchSource(item.sourceUrl, { signal, timeoutMs: 20_000, headers: { "user-agent": "LuxuryTravelFactVerifier/1.0", accept: "text/html,application/json,*/*" } });
        item.sourceHttpStatus = response.status;
        item.sourceAccessible = response.ok;
      } catch {
        item.sourceAccessible = false;
      }
    }
    if (!item.sourceAccessible) item.status = "unverified";
    facts.push(item);
  }
  for (const expected of verificationItems || []) {
    if (facts.some((item) => item.subject === clean(expected.subject) && item.field === clean(expected.field))) continue;
    facts.push(normalizeFact({ subject: expected.subject, field: expected.field, status: "unverified", conservativeFallback: "未取得可访问来源，保留原始资料口径并等待确认。" }, verifiedAt));
  }
  return { facts, internalSuggestions, adoptedFacts: facts.filter((item) => item.status === "verified" && item.sourceAccessible), conflicts: facts.filter((item) => item.status === "conflict"), unverified: facts.filter((item) => item.status === "unverified") };
}

export async function runWebFactSearch(options) {
  const response = await requestWebFactSearch(options);
  const evidence = await verifyWebFactSources({ parsed: response.parsed, verificationItems: options.verificationItems, signal: options.signal, fetchSource: options.fetchSource });
  return { capabilityId: "web_fact_search", configuredModel: WEB_FACT_SEARCH_MODEL, actualModel: response.model, durationMs: response.durationMs, usage: response.usage, ...evidence };
}
