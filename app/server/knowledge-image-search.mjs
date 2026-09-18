import { randomUUID } from "node:crypto";

const modes = new Set(["knowledge_only", "knowledge_first", "web_only"]);

export function normalizeImageSourceMode(value) {
  const normalized = String(value || "web_only").trim().toLowerCase();
  return modes.has(normalized) ? normalized : "web_only";
}

function cleanBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/$/, "");
  if (!normalized) return "";
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("知识库地址只支持 HTTP/HTTPS");
  return parsed.href.replace(/\/$/, "");
}

function abortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("knowledge_timeout")), timeoutMs);
  const combined = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return { signal: combined, stop: () => clearTimeout(timer) };
}

async function fetchJson(url, options, { fetchImpl, signal, timeoutMs }) {
  const timeout = abortSignal(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: timeout.signal });
    let payload = null;
    try { payload = await response.json(); } catch { /* Preserve the HTTP status below. */ }
    if (!response.ok) {
      const error = new Error(payload?.detail || payload?.error || `知识库请求失败（${response.status}）`);
      error.code = `knowledge_http_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return { response, payload };
  } catch (error) {
    if (timeout.signal.aborted && !signal?.aborted) {
      const timeoutError = new Error("知识库查询超时");
      timeoutError.code = "knowledge_timeout";
      throw timeoutError;
    }
    throw error;
  } finally { timeout.stop(); }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
  });
}

function imagePaths(result = {}) {
  return (Array.isArray(result.path) ? result.path : []).filter((item) => {
    const mime = String(item?.MIME || item?.mime || item?.mime_type || item?.content_type || "").toLowerCase();
    return item?.url && (mime.startsWith("image/") || /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(String(item.filename || item.url)));
  });
}

function pathDescriptor(item = {}) {
  const relation = String(item.relation || "").trim().toLowerCase() || null;
  return {
    relation,
    url: String(item.url || "").trim(),
    filename: String(item.filename || "").trim(),
    mimeType: imageMimeType(item),
    knowledgeId: String(item.knowledge_id || item.knowledgeId || "").trim() || null,
    versionId: String(item.version_id || item.versionId || "").trim() || null,
    sourcePathId: String(item.source_path_id || item.sourcePathId || "").trim() || null,
    sourceDisplayPath: String(item.source_display_path || item.sourceDisplayPath || "").trim() || null,
    expiresAt: String(item.expires_at || item.expiresAt || "").trim() || null,
    locator: item.locator && typeof item.locator === "object" ? item.locator : null,
    downloadOrigin: item.url ? new URL(item.url).origin : null,
  };
}

function pathAssetId(item = {}, result = {}) {
  return [item.versionId, item.knowledgeId, item.sourcePathId, result.asset_id, result.file_id, result.object_id, result.id]
    .map((value) => String(value || "").trim()).find(Boolean) || null;
}

function pathGroupKey(item = {}, result = {}, index = 0) {
  return item.versionId || item.sourcePathId || item.knowledgeId || pathAssetId(item, result) || `legacy-${index + 1}`;
}

function resultImageGroups(result = {}) {
  const described = imagePaths(result).map(pathDescriptor);
  const hasRelations = described.some((item) => ["preview", "matched_file"].includes(item.relation));
  if (!hasRelations) {
    return described.map((item, index) => ({
      key: pathGroupKey(item, result, index),
      assetId: pathAssetId(item, result),
      preview: { ...item, relation: "legacy_preview" },
      matchedFile: { ...item, relation: "legacy_matched_file" },
    }));
  }
  const groups = new Map();
  for (const [index, item] of described.entries()) {
    const key = pathGroupKey(item, result, index);
    const group = groups.get(key) || { key, assetId: pathAssetId(item, result), preview: null, matchedFile: null };
    if (item.relation === "preview" && !group.preview) group.preview = item;
    if (item.relation === "matched_file" && !group.matchedFile) group.matchedFile = item;
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.preview || group.matchedFile);
}

function contentText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("；");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text.trim();
  return [value.description, value.ocr_text, value.associations].map(contentText).filter(Boolean).join("；");
}

function sourcePathText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.source_display_path || value.display_path || value.path || value.original_filename || "").trim();
}

function imageMimeType(item = {}) {
  const declared = String(item.MIME || item.mime || item.mime_type || item.content_type || "").toLowerCase();
  if (declared.startsWith("image/")) return declared;
  const value = `${item.filename || ""} ${item.url || ""}`;
  if (/\.webp(?:[?#]|\s|$)|image%2[fF]webp/i.test(value)) return "image/webp";
  if (/\.png(?:[?#]|\s|$)|image%2[fF]png/i.test(value)) return "image/png";
  if (/\.jpe?g(?:[?#]|\s|$)|image%2[fF]jpe?g/i.test(value)) return "image/jpeg";
  return "";
}

const completedEmptyScopeStates = new Set(["empty", "unavailable", "no_match"]);

function completedScopeFeedback(output = {}) {
  const hasResults = Array.isArray(output.results) && output.results.length > 0;
  if (hasResults) return { scopeState: null, message: null };
  const scopeState = String(output.scope_state || "").trim();
  return {
    scopeState: completedEmptyScopeStates.has(scopeState) ? scopeState : null,
    message: completedEmptyScopeStates.has(scopeState) && typeof output.message === "string"
      ? output.message.trim() || null
      : null,
  };
}

export function knowledgeOutputToCandidates(output = {}, { baseUrl, queryId, queryText } = {}) {
  const stableSource = `${cleanBaseUrl(baseUrl)}/api/knowledge/output?query_id=${encodeURIComponent(queryId || "")}`;
  const records = [];
  const candidates = [];
  for (const result of Array.isArray(output.results) ? output.results : []) {
    const ranking = Number(result?.ranking || records.length + 1);
    const fragmentContent = contentText(result?.fragment?.content);
    const sourcePaths = Array.isArray(result?.source_paths) ? result.source_paths.map(sourcePathText).filter(Boolean) : [];
    for (const [pathIndex, group] of resultImageGroups(result).entries()) {
      const preview = group.preview;
      const matchedFile = group.matchedFile;
      const visible = preview || matchedFile;
      const mimeType = preview?.mimeType || matchedFile?.mimeType || "";
      const recordId = `knowledge-${queryId}-${ranking}-${pathIndex + 1}`;
      const filename = String(matchedFile?.filename || preview?.filename || `knowledge-image-${ranking}-${pathIndex + 1}`);
      const assetId = group.assetId || group.key || null;
      records.push({
        recordId, assetId, ranking, filename, mimeType, fragmentContent, sourcePaths,
        preview, matchedFile,
        previewOrigin: preview?.downloadOrigin || null,
        matchedFileOrigin: matchedFile?.downloadOrigin || null,
        downloadOrigin: visible?.downloadOrigin || null,
      });
      candidates.push({
        imageUrl: preview?.url || matchedFile?.url,
        previewUrl: preview?.url || null,
        pageUrl: stableSource,
        title: filename,
        alt: fragmentContent || filename,
        summary: [fragmentContent, ...sourcePaths].filter(Boolean).join(" | "),
        semanticText: [queryText, fragmentContent, ...sourcePaths, filename].filter(Boolean).join(" "),
        semanticScore: Math.max(1, 100 - Math.max(0, ranking - 1) * 5),
        searchRank: ranking,
        sourceKind: "knowledge_library",
        knowledgeAssetId: assetId,
        knowledgeRecordId: recordId,
        knowledgeQueryId: queryId,
        knowledgeFragmentContent: fragmentContent,
        knowledgeSourcePaths: sourcePaths,
        knowledgeMimeType: mimeType,
        knowledgePreview: preview,
        knowledgeMatchedFile: matchedFile,
        officialHint: false,
      });
    }
  }
  return { candidates, records };
}

function sameKnowledgeAsset(candidate = {}, other = {}) {
  const candidateVersion = String(candidate.knowledgeMatchedFile?.versionId || candidate.knowledgePreview?.versionId || "");
  const otherVersion = String(other.knowledgeMatchedFile?.versionId || other.knowledgePreview?.versionId || "");
  if (candidateVersion && otherVersion) return candidateVersion === otherVersion;
  const candidateId = String(candidate.knowledgeAssetId || "");
  const otherId = String(other.knowledgeAssetId || "");
  if (candidateId && otherId) return candidateId === otherId;
  return candidate.title === other.title && candidate.knowledgeSourcePaths?.some((value) => other.knowledgeSourcePaths?.includes(value));
}

export async function refreshKnowledgeMatchedFile({ baseUrl, queryIds = [], candidate, requestTimeoutMs = 30_000, signal, fetchImpl = fetch } = {}) {
  const normalizedBaseUrl = cleanBaseUrl(baseUrl);
  for (const queryId of [...new Set((queryIds || []).map(String).filter(Boolean))]) {
    const current = await fetchJson(`${normalizedBaseUrl}/api/knowledge/output?query_id=${encodeURIComponent(queryId)}`, { method: "GET" }, { fetchImpl, signal, timeoutMs: requestTimeoutMs });
    if (current.response.status !== 200 || current.payload?.data?.status !== "completed") continue;
    const parsed = knowledgeOutputToCandidates(current.payload.data, { baseUrl: normalizedBaseUrl, queryId, queryText: "" });
    const found = parsed.candidates.find((other) => sameKnowledgeAsset(candidate, other));
    if (found?.knowledgeMatchedFile?.url) return found.knowledgeMatchedFile;
  }
  const error = new Error("知识库原件地址已失效且无法刷新");
  error.code = "knowledge_matched_file_unavailable";
  throw error;
}

export async function searchKnowledgeImages({
  queries = [], baseUrl, topK = 5, scopeNodeIds = [], timeoutMs = 120_000,
  requestTimeoutMs = 30_000, pollIntervalMs = 2_000, options = {}, signal, fetchImpl = fetch,
} = {}) {
  const startedAt = Date.now();
  const normalizedBaseUrl = cleanBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    const error = new Error("未配置图片知识库地址");
    error.code = "knowledge_not_configured";
    throw error;
  }
  const queryText = String(queries.find((item) => String(item || "").trim()) || "").trim();
  if (!queryText) {
    const error = new Error("知识库查询文字不能为空");
    error.code = "knowledge_query_required";
    throw error;
  }
  const scope = Array.isArray(scopeNodeIds) && scopeNodeIds.length ? { node_ids: scopeNodeIds.map(String) } : null;
  const request = { scope, result_type: "image", top_k: Math.max(1, Math.min(10, Number(topK) || 5)), options: options && typeof options === "object" && !Array.isArray(options) ? options : {} };
  const form = new FormData();
  form.append("request", JSON.stringify(request));
  form.append("text", queryText);
  const accepted = await fetchJson(`${normalizedBaseUrl}/api/knowledge/query`, {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
    body: form,
  }, { fetchImpl, signal, timeoutMs: requestTimeoutMs });
  const queryId = String(accepted.payload?.data?.query_id || "").trim();
  if (accepted.response.status !== 202 || !queryId) {
    const error = new Error("知识库未返回有效 query_id");
    error.code = "knowledge_invalid_acceptance";
    throw error;
  }
  const deadline = Date.now() + Math.max(requestTimeoutMs, Number(timeoutMs) || 120_000);
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const current = await fetchJson(`${normalizedBaseUrl}/api/knowledge/output?query_id=${encodeURIComponent(queryId)}`, {
      method: "GET",
    }, { fetchImpl, signal, timeoutMs: Math.min(requestTimeoutMs, remaining) });
    if (current.response.status === 202) {
      await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
      continue;
    }
    const output = current.payload?.data || {};
    const status = String(output.status || "failed");
    if (status === "completed") {
      const parsed = knowledgeOutputToCandidates(output, { baseUrl: normalizedBaseUrl, queryId, queryText });
      const feedback = completedScopeFeedback(output);
      return { status, queryId, queryText, scope, durationMs: Date.now() - startedAt, candidates: parsed.candidates, records: parsed.records, clarificationNodeIds: [], ...feedback };
    }
    if (status === "needs_clarification") return { status, queryId, queryText, scope, durationMs: Date.now() - startedAt, candidates: [], records: [], clarificationNodeIds: Array.isArray(output.clarification_node_ids) ? output.clarification_node_ids : [] };
    return { status: "failed", queryId, queryText, scope, durationMs: Date.now() - startedAt, candidates: [], records: [], clarificationNodeIds: [], errorId: output.error_id || null, requestId: current.payload?.request_id || null };
  }
  const error = new Error(`知识库查询超时：${queryId}`);
  error.code = "knowledge_timeout";
  error.queryId = queryId;
  error.durationMs = Date.now() - startedAt;
  throw error;
}
