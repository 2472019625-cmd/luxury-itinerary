import { randomUUID } from "node:crypto";
import { createOperationTrace, safeErrorDetails } from './operation-trace.mjs';
import { knowledgeAdmissionState } from './knowledge-admission-state.mjs';
import { knowledgeSubmissionRecovery, submissionFingerprint, canReplayKnowledgeSubmission,
  knowledgeIdempotencyLifetimeMs, knowledgeSubmitRecoveryLimit } from './knowledge-submission-recovery.mjs';

// Two bounded lanes per knowledge service, shared by automatic and manual
// callers. Each accepted query owns its lane until its terminal state is known.
const admissionLanes = new Map();
const connectorIds = new WeakMap();
let nextConnectorId = 0;
function memoryAdmissionState() {
  let value = { phase: 'idle' };
  return { load: async () => value, save: async state => { value = state; }, clear: async () => { value = { phase: 'idle' }; } };
}
export async function searchKnowledgeImages(options = {}) {
  const connector = options.fetchImpl || fetch;
  if (!connectorIds.has(connector)) connectorIds.set(connector, ++nextConnectorId);
  const endpoint = cleanBaseUrl(options.baseUrl);
  const key = `${endpoint}:${connectorIds.get(connector)}:${options.admissionStateDirectory || ''}`;
  const throwCancelled = () => { if (options.signal?.aborted) throw knowledgeRequestError({ stage: 'submit', kind: 'cancelled', code: 'knowledge_cancelled', startedAt: Date.now() }); };
  throwCancelled();
  const concurrency = options.admissionConcurrency === 1 ? 1 : 2;
  const group = admissionLanes.get(key) || { lanes: Array.from({ length: concurrency }, (_, index) => ({
    index, tail: Promise.resolve(), uncertainQueryId: null, pending: 0, busy: false, cancelledSubmission: false,
    state: knowledgeAdmissionState(options.admissionStateDirectory, endpoint, index) || memoryAdmissionState(),
    submissionRecovery: options.idempotentSubmissionRecovery === true
      ? knowledgeSubmissionRecovery(options.submissionRecoveryDirectory, endpoint, index) : null,
  })), recovery: null };
  admissionLanes.set(key, group);
  const lane = group.lanes.reduce((best, candidate) => candidate.pending < best.pending ? candidate : best);
  lane.pending += 1;
  const trace = createOperationTrace('knowledge_admission', options.traceContext, options.logger);
  const queuedAt = Date.now();
  const state = lane.state;
  const acceptanceUnknown = () => Object.assign(new Error('知识库提交结果未知，需核对原请求'), { code: 'knowledge_acceptance_unknown' });
  const clearLane = async (item, key) => {
    await item.state?.clear();
    if (key) await item.submissionRecovery?.clear(key);
  };
  // Single-flight reconciliation excludes live lanes: a submitting marker is
  // also normal while POST is in flight. Old incomplete markers remain closed.
  const recover = () => {
    if (!group.recovery) group.recovery = (async () => {
      const saved = await Promise.all(group.lanes.map(item => item.state?.load()));
      const reconciled = await Promise.allSettled(group.lanes.map(async (item, index) => {
        if (item.busy) {
          if (item.cancelledSubmission) { options.onAdmissionEvent?.({ type: 'blocked' }); throw acceptanceUnknown(); }
          return;
        }
        const marker = saved[index];
        if (marker?.phase === 'submitting') {
          const record = await item.submissionRecovery?.load();
          if (options.idempotentSubmissionRecovery !== true || !canReplayKnowledgeSubmission(record, marker)) {
            options.onAdmissionEvent?.({ type: 'blocked' });
            throw acceptanceUnknown();
          }
          trace.emit('submit_reconciliation_start', { mode: 'same_key_replay' });
          await executeKnowledgeQuery({ ...options, signal: undefined, trace, state: item.state,
            submissionRecovery: item.submissionRecovery, resumeSubmission: record });
          await clearLane(item, marker.idempotencyKey);
          return;
        }
        if (marker?.phase !== 'accepted') return;
        item.uncertainQueryId = marker.queryId;
        await executeKnowledgeQuery({ ...options, signal: undefined, resumeQueryId: item.uncertainQueryId, trace });
        item.uncertainQueryId = null;
        await clearLane(item, marker.idempotencyKey);
      }));
      const failed = reconciled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })().finally(() => { group.recovery = null; });
    return group.recovery;
  };
  let queueTimer, queueExpired = false, acceptedByServer = false, queueWaitMs = 0, executing = false;
  const operation = lane.tail.then(async () => {
    clearTimeout(queueTimer);
    throwCancelled();
    if (queueExpired || Date.now() - queuedAt > (options.queueTimeoutMs ?? 30 * 60_000)) {
      throw Object.assign(new Error('知识库排队超时'), { code: 'knowledge_queue_timeout' });
    }
    queueWaitMs = Date.now() - queuedAt;
    trace.emit('queue_ready', { durationMs: queueWaitMs });
    await recover();
    throwCancelled();
    const saved = await state?.load();
    if (saved?.phase === 'submitting') {
      options.onAdmissionEvent?.({ type: 'blocked' });
      throw acceptanceUnknown();
    }
    if (saved?.phase === 'accepted') lane.uncertainQueryId = saved.queryId;
    // An interrupted accepted query is reconciled before submitting another.
    // A transport failure is not proof that its server-side slot is free.
    if (lane.uncertainQueryId) {
      const previous = await executeKnowledgeQuery({ ...options, signal: undefined,
        resumeQueryId: lane.uncertainQueryId, trace });
      if (!['completed', 'failed', 'needs_clarification'].includes(previous.status)) throw new Error('knowledge_reconciliation_pending');
      lane.uncertainQueryId = null;
      await clearLane(lane, saved?.idempotencyKey);
      throwCancelled();
    }
    try {
      lane.busy = true;
      executing = true;
      const result = await executeKnowledgeQuery({ ...options, trace, state, submissionRecovery: lane.submissionRecovery,
        onAccepted: () => { acceptedByServer = true; } });
      await clearLane(lane, (await state?.load())?.idempotencyKey);
      return { ...result, queueWaitMs, totalDurationMs: Date.now() - queuedAt };
    }
    catch (error) {
      if (error?.queryId) lane.uncertainQueryId = error.queryId;
      // The durable marker, rather than a sticky process flag, determines
      // whether the next request may reconcile and continue.
      error.queueWaitMs = queueWaitMs;
      error.totalDurationMs = Date.now() - queuedAt;
      throw error;
    } finally { lane.busy = false; lane.cancelledSubmission = false; executing = false; }
  });
  lane.tail = operation.catch(error => { trace.emit('query_failed', { ...safeErrorDetails(error), queryId: error.queryId,
    errorId: error.errorId, knowledgeRequestId: error.requestId }); }).finally(() => { lane.pending -= 1; });
  // Return cancellation promptly; the accepted query continues only polling,
  // never searching/generating/writing, until its terminal state or deadline.
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(queueTimer); options.signal?.removeEventListener('abort', cancelled); };
    const cancelled = () => { if (executing && !acceptedByServer) lane.cancelledSubmission = true;
      cleanup(); reject(knowledgeRequestError({ stage: acceptedByServer ? 'poll' : 'submit', kind: 'cancelled', code: 'knowledge_cancelled', startedAt: queuedAt })); };
    options.signal?.addEventListener('abort', cancelled, { once: true });
    queueTimer = setTimeout(() => {
      queueExpired = true;
      cleanup();
      reject(Object.assign(new Error('知识库排队超时'), { code: 'knowledge_queue_timeout' }));
    }, options.queueTimeoutMs ?? 30 * 60_000);
    operation.then(resolve, reject).finally(cleanup);
  });
}

const modes = new Set(["knowledge_only", "knowledge_first", "web_only"]);

function safeDiagnosticId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id) ? id : null;
}

function knowledgeRequestError({ stage, kind, code, diagnosticId, queryId, requestId, errorId, status, startedAt, retryAfterMs }) {
  const action = stage === "submit" ? "提交" : stage === "refresh" ? "刷新原件" : "轮询";
  const suffix = kind === "timeout" || kind === "client_deadline" ? "超时" : kind === "cancelled" ? "已取消" : kind === "invalid_response" ? "响应无效" : "失败";
  const error = new Error(`知识库${action}请求${suffix}`);
  error.code = code;
  if (kind === "cancelled") error.name = "AbortError";
  error.knowledgeStage = stage;
  error.knowledgeFailureKind = kind;
  error.diagnosticId = diagnosticId;
  error.queryId = safeDiagnosticId(queryId);
  error.requestId = safeDiagnosticId(requestId);
  error.errorId = safeDiagnosticId(errorId);
  error.status = Number.isInteger(status) ? status : null;
  error.durationMs = Date.now() - startedAt;
  if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
  return error;
}

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

async function fetchJson(url, options, { fetchImpl, signal, timeoutMs, stage = "poll", diagnosticId = null, queryId = null, startedAt = Date.now(), onDispatch }) {
  const timeout = abortSignal(signal, timeoutMs);
  try {
    timeout.signal.throwIfAborted();
    let requestOptions = options;
    if (options.body instanceof FormData) {
      // Undici can enqueue multipart chunks after an aborted request has closed
      // its body, throwing outside fetch's rejection handler. Encode our small
      // text-only form before attaching the request's cancellation signal.
      const encoded = new Response(options.body);
      const body = Buffer.from(await encoded.arrayBuffer());
      requestOptions = { ...options, body, headers: { ...options.headers, "Content-Type": encoded.headers.get("content-type") } };
    }
    timeout.signal.throwIfAborted();
    onDispatch?.();
    const response = await fetchImpl(url, { ...requestOptions, signal: timeout.signal });
    let payload = null;
    try { payload = await response.json(); } catch (error) {
      // A response body can disconnect after successful headers. Preserve HTTP
      // errors, but let interrupted successful bodies use the transport path.
      if (response.ok && !(error instanceof SyntaxError)) throw error;
    }
    if (!response.ok) {
      throw knowledgeRequestError({
        stage, kind: "http", code: `knowledge_http_${response.status}`, diagnosticId, queryId,
        requestId: payload?.request_id, errorId: payload?.error_id || payload?.data?.error_id,
        status: response.status, startedAt,
        retryAfterMs: retryAfterMilliseconds(response.headers?.get?.('retry-after')),
      });
    }
    return { response, payload };
  } catch (error) {
    if (timeout.signal.aborted && !signal?.aborted) {
      throw knowledgeRequestError({ stage, kind: "timeout", code: "knowledge_timeout", diagnosticId, queryId, startedAt });
    }
    if (signal?.aborted) throw knowledgeRequestError({ stage, kind: "cancelled", code: "knowledge_cancelled", diagnosticId, queryId, startedAt });
    if (error?.knowledgeStage) throw error;
    const failure = knowledgeRequestError({ stage, kind: "transport", code: "knowledge_transport_error", diagnosticId, queryId, startedAt });
    const transportCode = error?.cause?.code || error?.code;
    failure.transportCode = /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/.test(String(transportCode || "")) ? transportCode : null;
    throw failure;
  } finally { timeout.stop(); }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMilliseconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function imagePaths(result = {}) {
  return (Array.isArray(result.path) ? result.path : []).filter((item) => {
    const mime = String(item?.MIME || item?.mime || item?.mime_type || item?.content_type || "").toLowerCase();
    return item?.url && (mime.startsWith("image/") || /\.(?:avif|jpe?g|png|webp)(?:[?#]|$)/i.test(String(item.filename || item.url)));
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
  if (/\.avif(?:[?#]|\s|$)|image%2[fF]avif/i.test(value)) return "image/avif";
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
    const current = await fetchJson(`${normalizedBaseUrl}/api/knowledge/output?query_id=${encodeURIComponent(queryId)}`, { method: "GET" }, { fetchImpl, signal, timeoutMs: requestTimeoutMs, stage: "refresh", queryId, diagnosticId: randomUUID() });
    if (current.response.status !== 200 || current.payload?.data?.status !== "completed") continue;
    const parsed = knowledgeOutputToCandidates(current.payload.data, { baseUrl: normalizedBaseUrl, queryId, queryText: "" });
    const found = parsed.candidates.find((other) => sameKnowledgeAsset(candidate, other));
    if (found?.knowledgeMatchedFile?.url) return found.knowledgeMatchedFile;
  }
  const error = new Error("知识库原件地址已失效且无法刷新");
  error.code = "knowledge_matched_file_unavailable";
  throw error;
}

async function executeKnowledgeQuery({
  queries = [], baseUrl, topK = 5, scopeNodeIds = [], timeoutMs = 120_000,
  requestTimeoutMs = 30_000, pollIntervalMs = 2_000, options = {}, signal, fetchImpl = fetch,
  capacityWaitMs = 180_000, resumeQueryId = null, trace, onAccepted, state,
  idempotentSubmissionRecovery = false, submissionRecovery, resumeSubmission = null, onAdmissionEvent,
} = {}) {
  const startedAt = Date.now();
  const diagnosticId = trace?.requestId || randomUUID();
  const normalizedBaseUrl = cleanBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    const error = new Error("未配置图片知识库地址");
    error.code = "knowledge_not_configured";
    throw error;
  }
  const queryText = resumeSubmission?.queryText || String(queries.find((item) => String(item || "").trim()) || "").trim();
  if (!queryText) {
    const error = new Error("知识库查询文字不能为空");
    error.code = "knowledge_query_required";
    throw error;
  }
  const scope = resumeSubmission ? resumeSubmission.request.scope
    : Array.isArray(scopeNodeIds) && scopeNodeIds.length ? { node_ids: scopeNodeIds.map(String) } : null;
  const request = resumeSubmission?.request || JSON.parse(JSON.stringify({ scope, result_type: "image", top_k: Math.max(1, Math.min(10, Number(topK) || 5)), options: options && typeof options === "object" && !Array.isArray(options) ? options : {} }));
  const form = new FormData();
  form.append("request", JSON.stringify(request));
  form.append("text", queryText);
  const idempotencyKey = resumeSubmission?.idempotencyKey || randomUUID();
  let record = resumeSubmission || { queryText, request, idempotencyKey, submittedAt: Date.now(),
    requestHash: submissionFingerprint({ queryText, request }), recoveryAttempts: 0, cancelled: false };
  let accepted;
  const admissionDeadline = Date.now() + capacityWaitMs;
  let admissionRetries = 0, submitAttempts = 0, recoveredSubmissions = 0;
  let cancellationWrite = Promise.resolve();
  const persistCancellation = () => {
    record.cancelled = true;
    cancellationWrite = cancellationWrite.then(() => submissionRecovery?.cancel(idempotencyKey));
    // The original operation awaits this write; the caller can return promptly.
    cancellationWrite.catch(() => {});
  };
  const admissionInfo = () => ({ admissionRetries, submitAttempts, recoveredSubmissions,
    idempotencyKey, admissionDurationMs: Date.now() - startedAt });
  const marker = () => ({ phase: 'submitting', idempotencyKey, requestHash: record.requestHash, submittedAt: record.submittedAt });
  const clearRejected = async () => { await state?.clear(); await submissionRecovery?.clear(idempotencyKey); };
  if (!resumeQueryId) {
    let replay = Boolean(resumeSubmission);
    let unresolvedDispatch = Boolean(resumeSubmission);
    signal?.addEventListener('abort', persistCancellation, { once: true });
    try {
      while (!accepted) {
        let dispatched = false, stateRecorded = false;
        try {
          signal?.throwIfAborted();
          if (replay) {
            if (!canReplayKnowledgeSubmission(record, marker())) throw Object.assign(new Error('知识库提交结果未知，需核对原请求'), { code: 'knowledge_acceptance_unknown' });
            record = { ...record, recoveryAttempts: record.recoveryAttempts + 1 };
          }
          await submissionRecovery?.save(record);
          await state?.save(marker());
          stateRecorded = true;
          accepted = await fetchJson(`${normalizedBaseUrl}/api/knowledge/query`, {
            method: 'POST', headers: { 'Idempotency-Key': idempotencyKey, 'X-Request-ID': diagnosticId }, body: form,
          }, { fetchImpl, signal, timeoutMs: Math.min(requestTimeoutMs, Math.max(1, admissionDeadline - Date.now())), stage: 'submit', diagnosticId, startedAt,
            onDispatch: () => { dispatched = true; unresolvedDispatch = true; submitAttempts += 1;
              if (replay) recoveredSubmissions += 1;
              onAdmissionEvent?.({ type: 'dispatch', recovered: replay, idempotencyKey });
              trace?.emit('submit_dispatch', { retryCount: record.recoveryAttempts, mode: replay ? 'same_key_replay' : 'initial', resourceId: idempotencyKey });
            } });
          const id = String(accepted.payload?.data?.query_id || '').trim();
          if (accepted.response.status !== 202 || !safeDiagnosticId(id)) {
            throw knowledgeRequestError({ stage: 'submit', kind: 'invalid_response', code: 'knowledge_invalid_acceptance', diagnosticId,
              requestId: accepted.payload?.request_id, errorId: accepted.payload?.error_id, status: accepted.response.status, startedAt });
          }
        } catch (error) {
          accepted = null;
          error.admission = admissionInfo();
          if (!unresolvedDispatch && stateRecorded) await clearRejected();
          const rejected = error.knowledgeStage === 'submit' && error.knowledgeFailureKind === 'http'
            && [400, 401, 403, 404, 422, 429].includes(error.status);
          if (rejected) { await clearRejected(); unresolvedDispatch = false; }
          trace?.emit('submit_failed', { ...safeErrorDetails(error), transportCode: error.transportCode,
            retryCount: record.recoveryAttempts, resourceId: idempotencyKey });
          if (signal?.aborted) { persistCancellation(); throw error; }
          const capacityRetry = error.status === 429 && admissionRetries < 6;
          const unknownRetry = idempotentSubmissionRecovery === true && dispatched
            && ['transport', 'timeout', 'invalid_response'].includes(error.knowledgeFailureKind)
            && record.recoveryAttempts < knowledgeSubmitRecoveryLimit
            && Date.now() - record.submittedAt < knowledgeIdempotencyLifetimeMs - 60_000;
          const delay = capacityRetry ? Math.max(10, error.retryAfterMs ?? Math.min(10_000, 1000 * 2 ** admissionRetries))
            : Math.min(2_000, 500 * 2 ** record.recoveryAttempts);
          if ((!capacityRetry && !unknownRetry) || Date.now() + delay >= admissionDeadline) throw error;
          replay = unknownRetry;
          if (capacityRetry) admissionRetries += 1;
          trace?.emit(capacityRetry ? 'capacity_wait' : 'submit_recovery_wait', { retryCount: capacityRetry ? admissionRetries : record.recoveryAttempts + 1,
            durationMs: delay, knowledgeRequestId: error.requestId, resourceId: idempotencyKey });
          await wait(delay, signal);
        }
      }
    } catch (error) { error.admission = admissionInfo(); throw error; }
    finally { signal?.removeEventListener('abort', persistCancellation); await cancellationWrite; }
  }
  const queryId = resumeQueryId || String(accepted.payload?.data?.query_id || "").trim();
  if (!resumeQueryId && (accepted.response.status !== 202 || !queryId)) {
    throw knowledgeRequestError({
      stage: "submit", kind: "invalid_response", code: "knowledge_invalid_acceptance", diagnosticId,
      requestId: accepted.payload?.request_id, errorId: accepted.payload?.error_id, status: accepted.response.status, startedAt,
    });
  }
  trace?.emit('accepted', { durationMs: Date.now() - startedAt, retryCount: admissionRetries, resumed: Boolean(resumeQueryId), queryId });
  onAccepted?.();
  if (!resumeQueryId) onAdmissionEvent?.({ type: 'accepted', queryId, recovered: recoveredSubmissions > 0, idempotencyKey });
  try { await state?.save({ phase: 'accepted', queryId, ...(!resumeQueryId ? { idempotencyKey } : {}) }); }
  catch (error) { error.queryId = queryId; throw error; }
  // Keep the remote lease after caller cancellation. Polling has its own
  // bounded deadline and never starts a new query or writes itinerary data.
  const pollSignal = undefined;
  const deadline = Date.now() + Math.max(requestTimeoutMs, Number(timeoutMs) || 120_000);
  const pollRecovery = [];
  let lastPollError = null;
  const admission = admissionInfo();
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let current;
    try { current = await fetchJson(`${normalizedBaseUrl}/api/knowledge/output?query_id=${encodeURIComponent(queryId)}`, {
      method: "GET",
    }, { fetchImpl, signal: pollSignal, timeoutMs: Math.min(requestTimeoutMs, remaining), stage: "poll", diagnosticId, queryId, startedAt }); }
    catch (error) {
      lastPollError = error;
      error.pollRecovery = [...pollRecovery];
      const transient = ["transport", "timeout"].includes(error.knowledgeFailureKind)
        || error.knowledgeFailureKind === "http" && [502, 503, 504].includes(error.status);
      if (!transient || pollRecovery.length >= 2 || Date.now() >= deadline) throw error;
      pollRecovery.push({ kind: error.knowledgeFailureKind, code: error.code, transportCode: error.transportCode || null, status: error.status });
      try { await wait(Math.min(Math.max(1, pollIntervalMs), deadline - Date.now()), pollSignal); }
      catch { throw knowledgeRequestError({ stage: "poll", kind: "cancelled", code: "knowledge_cancelled", diagnosticId, queryId, startedAt }); }
      continue;
    }
    lastPollError = null;
    if (current.response.status === 202) {
      try {
        await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), pollSignal);
      } catch {
        throw knowledgeRequestError({ stage: "poll", kind: "cancelled", code: "knowledge_cancelled", diagnosticId, queryId, startedAt });
      }
      continue;
    }
    const output = current.payload?.data || {};
    const status = String(output.status || "");
    trace?.emit('poll_state', { queryId, knowledgeRequestId: current.payload?.request_id, status, errorId: output.error_id });
    if (status === "completed") {
      const parsed = knowledgeOutputToCandidates(output, { baseUrl: normalizedBaseUrl, queryId, queryText });
      const feedback = completedScopeFeedback(output);
      return { status, queryId, queryText, scope, durationMs: Date.now() - startedAt, diagnosticId, admission, pollRecovery, candidates: parsed.candidates, records: parsed.records, clarificationNodeIds: [], ...feedback };
    }
    if (status === "needs_clarification") return { status, queryId, queryText, scope, durationMs: Date.now() - startedAt, diagnosticId, admission, candidates: [], records: [], clarificationNodeIds: Array.isArray(output.clarification_node_ids) ? output.clarification_node_ids : [] };
    if (status !== "failed") throw knowledgeRequestError({ stage: "poll", kind: "invalid_response", code: "knowledge_invalid_output", diagnosticId, queryId, requestId: current.payload?.request_id, status: current.response.status, startedAt });
    return { status: "failed", queryId: safeDiagnosticId(queryId), queryText, scope, durationMs: Date.now() - startedAt, diagnosticId, admission, knowledgeStage: "terminal", knowledgeFailureKind: "terminal_failure", candidates: [], records: [], clarificationNodeIds: [], errorId: safeDiagnosticId(output.error_id), requestId: safeDiagnosticId(current.payload?.request_id) };
  }
  if (lastPollError) { lastPollError.pollRecovery = [...pollRecovery]; throw lastPollError; }
  throw knowledgeRequestError({ stage: "poll", kind: "client_deadline", code: "knowledge_timeout", diagnosticId, queryId, startedAt });
}
