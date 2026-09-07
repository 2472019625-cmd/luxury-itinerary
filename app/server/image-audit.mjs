import { readFile } from "node:fs/promises";
import sharp from "sharp";

function auditError(message, { status, code, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  if (status) error.status = status;
  error.code = code || "audit_unavailable";
  return error;
}

function responseError(payload, status, label) {
  const code = status === 429 ? "audit_rate_limited" : status >= 500 ? "audit_service_error" : "audit_request_error";
  return auditError(payload?.error?.message || payload?.message || `${label}（${status}）`, { status, code });
}

function parseAuditJson(raw, label) {
  try {
    return JSON.parse(String(raw || "{}").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (cause) {
    throw auditError(`${label}返回了无效JSON`, { code: "audit_invalid_json", cause });
  }
}

async function contactSheet(candidates) {
  const cellWidth = 600;
  const cellHeight = 420;
  const columns = 2;
  const rows = Math.ceil(candidates.length / columns);
  const composites = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    const image = await sharp(await readFile(candidates[index].filePath)).resize(cellWidth, cellHeight, { fit: "cover" }).jpeg({ quality: 82 }).toBuffer();
    const label = Buffer.from(`<svg width="${cellWidth}" height="${cellHeight}"><rect x="0" y="0" width="92" height="54" fill="rgba(0,0,0,.72)"/><text x="46" y="38" text-anchor="middle" fill="white" font-size="34" font-family="Arial">${index + 1}</text></svg>`);
    composites.push({ input: image, left: x, top: y }, { input: label, left: x, top: y });
  }
  return sharp({ create: { width: columns * cellWidth, height: rows * cellHeight, channels: 3, background: "#ffffff" } }).composite(composites).jpeg({ quality: 84 }).toBuffer();
}

export async function auditCandidates({ slot, candidates, apiKey, baseUrl, model, signal }) {
  if (!candidates.length) return [];
  if (!apiKey || process.env.IMAGE_VISUAL_AUDIT === "off") return candidates.map((_, index) => ({ index, score: 60 - index, reason: "基础质量排序" }));
  const sheet = await contactSheet(candidates.slice(0, 4));
  const prompt = `你是高端定制旅行图片总监。请审核这张编号候选图拼版，为以下展示位排序：\n名称：${slot.label}\n地点/品牌：${slot.context}\n主体：${slot.subject}\nmustHave：${(slot.mustHave || []).join("；")}\nprefer：${(slot.prefer || []).join("；")}\nforbid：${(slot.forbid || []).join("；")}\n\n地点、品牌和主体正确高于单纯好看。重点判断相关度、高端感、干净度、构图适配和水印；命中 forbid 或不满足 mustHave 必须拒绝，缺少 prefer 只影响排序。输出JSON对象：{"ranking":[{"index":从0开始的图片序号,"score":0到100,"reason":"简短理由","relevance":0到100,"luxury":0到100,"cleanliness":0到100,"composition":0到100,"watermark":true或false}],"rejected":[从0开始序号]}。`;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${sheet.toString("base64")}` } },
        { type: "text", text: prompt },
      ] }],
      stream: false,
      do_sample: false,
      reasoning_effort: "low",
      max_tokens: 1800,
      response_format: { type: "json_object" },
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(payload, response.status, "视觉审核失败");
  const result = parseAuditJson(payload?.choices?.[0]?.message?.content, "视觉初审");
  const rejected = new Set(Array.isArray(result.rejected) ? result.rejected : []);
  return (Array.isArray(result.ranking) ? result.ranking : []).filter((item) => Number.isInteger(item.index) && candidates[item.index] && !rejected.has(item.index)).sort((a, b) => (b.score || 0) - (a.score || 0));
}

export async function judgeCandidatesBatch({ slot, candidates, apiKey, baseUrl, model, signal, fetchImpl = fetch, timeoutMs = 90_000 }) {
  if (!candidates.length) return [];
  if (!apiKey || !baseUrl || !model || process.env.IMAGE_VISUAL_AUDIT === "off") {
    throw auditError("真实视觉判断未配置，不得默认通过", { code: "audit_unavailable" });
  }
  const judgedCandidates = candidates.slice(0, 4);
  const sheet = await contactSheet(judgedCandidates);
  const sourceContext = judgedCandidates.map((candidate, index) => `${index + 1}. candidateId=${candidate.candidateId}；来源页面：${candidate.pageUrl || "未知"}；标题：${candidate.title || "未知"}；官方来源提示：${candidate.officialHint ? "是" : "否"}`).join("\n");
  const prompt = `你是高端定制旅行图片事实与视觉判断员。请在一次判断中逐张核验候选，并严格按 candidateId 返回。\n展示位：${slot.label}\n模块：${slot.module}\n地点/品牌与现有语境：${slot.context}\n目标主体：${slot.subject}\n视觉目标：${slot.visualGoal || ""}\nmustHave：${(slot.mustHave || []).join("；")}\nprefer：${(slot.prefer || []).join("；")}\nforbid：${(slot.forbid || []).join("；")}\n${sourceContext}\n\n事实匹配高于单纯好看。每张图必须先描述实际主体，再对地点、酒店身份、活动、主体、水印、AI痕迹、真实摄影属性和技术可用性逐项给出布尔硬判断。cover、hotel、DAY、transport 客户主图必须是现场真实摄影；地图、示意图、信息图、页面截图和纯文字海报的 photographic 必须为 false。若图片实际地点与目标地点明显冲突（例如目标为坦桑尼亚而图片为呼伦贝尔/中国），locationMatch 必须为 false。某项对当前 slot 不适用时填 true；任何适用 mustHave 不满足时 eligible 必须为 false。官方来源只能支持酒店身份，不能替代对图片实际主体、活动与地点的判断。prefer 只影响排序，不作为硬拒绝。禁止因不确定而默认 eligible。输出JSON：{"judgments":[{"candidateId":"与输入完全一致","actualSubject":"实际主体及可辨识地点/媒介类型","locationMatch":true或false,"hotelIdentityMatch":true或false,"activityMatch":true或false,"subjectMatch":true或false,"watermarkFree":true或false,"nonAI":true或false,"photographic":true或false,"technicalUsable":true或false,"eligible":true或false,"hardRejectCode":"none|watermark|subject_mismatch|place_mismatch|hotel_identity_mismatch|activity_mismatch|ai_generated|non_photographic|technical_unusable|broken|low_resolution|low_quality|forbid","relevance":0到100,"luxury":0到100,"cleanliness":0到100,"composition":0到100,"score":0到100,"reason":"事实化说明"}]}。judgments 可按推荐顺序排列，但 candidateId 必须对应同一张输入图片。`;
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 90_000));
  const requestSignal = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${sheet.toString("base64")}` } },
          { type: "text", text: prompt },
        ] }],
        stream: false,
        do_sample: false,
        reasoning_effort: "low",
        max_tokens: 2200,
        response_format: { type: "json_object" },
      }),
      signal: requestSignal,
    });
  } catch (error) {
    if (requestSignal.aborted && !signal?.aborted) throw auditError(`候选图片视觉判断超过 ${Math.ceil(timeoutMs / 1000)} 秒`, { code: "audit_timeout", cause: error });
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(payload, response.status, "批量视觉判断失败");
  const result = parseAuditJson(payload?.choices?.[0]?.message?.content, "批量视觉判断");
  const knownIds = new Set(judgedCandidates.map((candidate) => candidate.candidateId));
  const seenIds = new Set();
  return (Array.isArray(result.judgments) ? result.judgments : [])
    .filter((item) => knownIds.has(item?.candidateId) && !seenIds.has(item.candidateId) && seenIds.add(item.candidateId))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

export async function validateCandidate({ slot, candidate, apiKey, baseUrl, model, signal }) {
  if (!apiKey || process.env.IMAGE_VISUAL_AUDIT === "off") return { pass: true, subjectMatch: true, placeMatch: true, sourceSupportsIdentity: Boolean(candidate.officialHint), watermark: false, hardRejectCode: "none", relevance: 80, luxury: 72, cleanliness: 80, composition: 70, reason: "未启用视觉复核" };
  const image = await sharp(await readFile(candidate.filePath)).resize({ width: 1100, height: 900, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer();
  const prompt = `只审核这一张图片是否可以用于高端旅行客户成品。展示位：${slot.label}。模块：${slot.module}。地点/品牌：${slot.context}。主体：${slot.subject}。mustHave：${(slot.mustHave || []).join("；")}。prefer：${(slot.prefer || []).join("；")}。forbid：${(slot.forbid || []).join("；")}。来源页面：${candidate.pageUrl}，来源标题：${candidate.title || ''}，官方来源提示：${candidate.officialHint ? "是" : "否"}。必须先描述图片实际主体，再分别判断视觉主体与来源身份。prefer 不满足只能降分，不能作为硬拒绝。酒店官方来源可支持酒店身份，不能只凭建筑风格推翻；若主体属于酒店但场景不是首选，应给 pass=false 或低分并 hardRejectCode=none，交人工确认。只有水印、破图/严重低质、主体完全错误、明确地点品牌错误或命中 forbid 才能给硬拒绝码。输出JSON：{"pass":true或false,"actualSubject":"实际主体","subjectMatch":true或false,"placeMatch":true或false,"sourceSupportsIdentity":true或false,"watermark":true或false,"hardRejectCode":"none|watermark|subject_mismatch|place_mismatch|broken|low_resolution|low_quality|forbid","relevance":0到100,"luxury":0到100,"cleanliness":0到100,"composition":0到100,"reason":"事实化说明通过、待确认或拒绝原因"}。`;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } },
        { type: "text", text: prompt },
      ] }],
      stream: false,
      do_sample: false,
      reasoning_effort: "low",
      max_tokens: 800,
      response_format: { type: "json_object" },
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(payload, response.status, "图片终审失败");
  return parseAuditJson(payload?.choices?.[0]?.message?.content, "图片终审");
}
