import { randomUUID } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[a-z0-9:_-]{1,180}$/i.test(value) ? value : null;
const abortOrigins = new Set(['request_deadline', 'caller_cancel', 'session_close', 'unknown_abort']);
// Classification is observational only: preserve the original error, signal
// and retry policy. ABORT_ERR alone does not prove a request timed out.
export function operationAbortDetails(error, ...signals) {
  const reason = signals.find(signal => signal?.aborted)?.reason;
  const code = reason?.code || error?.code;
  if (abortOrigins.has(reason?.abortOrigin)) return { abortOrigin: reason.abortOrigin };
  if (reason?.name === 'TimeoutError' || ['image_fetch_timeout', 'search_response_timeout', 'browser_timeout'].includes(code)) return { abortOrigin: 'request_deadline' };
  if (signals.some(signal => signal?.aborted)) return { abortOrigin: 'caller_cancel' };
  if (error?.name === 'AbortError' || ['ABORT_ERR', 'request_cancelled'].includes(code)) return { abortOrigin: 'unknown_abort' };
  return {};
}
export function safeErrorDetails(error) {
  const transportCode = error?.cause?.code || error?.code;
  return {
    code: safeId(error?.code) || 'operation_failed',
    ...(safeId(transportCode) ? { transportCode } : {}),
    ...(Number.isInteger(error?.status) ? { statusCode: error.status } : {}),
    ...(Number.isInteger(error?.cause?.errno) ? { errno: error.cause.errno } : {}),
    ...(typeof error?.name === 'string' && /^(?:Error|TypeError|SyntaxError|AbortError|TimeoutError)$/.test(error.name) ? { errorType: error.name } : {}),
  };
}
// Only callers' numeric measurements, controlled codes and IDs are logged.
// Never spread a request, candidate, error object or upstream body into a log.
export function createOperationTrace(operation, context = {}, logger = console.info) {
  const requestId = safeId(context.requestId) || randomUUID();
  const ids = Object.fromEntries(['projectId', 'executionRunId', 'batchId', 'slotId', 'candidateId', 'revision'].map(key => [key, safeId(context[key])]).filter(([, value]) => value));
  const started = Date.now();
  const timings = {};
  const emit = (phase, measurements = {}) => {
    const safe = Object.fromEntries(Object.entries(measurements).filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key)
      && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
        || key === 'abortOrigin' && abortOrigins.has(value)
        || ['code', 'transportCode', 'errorType', 'resourceType', 'resourceId', 'queryId', 'knowledgeRequestId', 'errorId', 'status', 'mode', 'finishReason'].includes(key) && safeId(value))));
    try { logger(JSON.stringify({ event: 'operation_trace', operation, requestId, ...ids, phase, elapsedMs: Date.now() - started, ...safe })); } catch { /* diagnostics must not break business work */ }
  };
  const measure = async (phase, fn) => {
    const start = Date.now();
    emit(`${phase}_start`);
    try { const value = await fn(); const durationMs = Date.now() - start; timings[phase] = (timings[phase] || 0) + durationMs; emit(`${phase}_end`, { durationMs }); return value; }
    catch (error) { const durationMs = Date.now() - start; timings[phase] = (timings[phase] || 0) + durationMs; emit(`${phase}_failed`, { durationMs, ...safeErrorDetails(error) }); throw error; }
  };
  return { requestId, timings, emit, measure };
}

export function fieldTypes(value, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value || {}, key)).map(key => {
    const item = value[key];
    return [key, Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item];
  }));
}
