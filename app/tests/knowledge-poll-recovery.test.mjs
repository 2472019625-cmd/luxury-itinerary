import test from 'node:test';
import assert from 'node:assert/strict';
import { searchKnowledgeImages } from '../server/knowledge-image-search.mjs';

const reply = (status, data) => new Response(JSON.stringify({ data }), { status });
const accepted = () => reply(202, { query_id: 'qry_existing' });
const complete = () => reply(200, { query_id: 'qry_existing', status: 'completed', results: [] });
const disconnected = () => Object.assign(new TypeError('sensitive URL must not leak'), { cause: { code: 'ECONNRESET' } });
const options = { baseUrl: 'http://knowledge.test', queries: ['草原酒会'], pollIntervalMs: 1, requestTimeoutMs: 50, timeoutMs: 200 };

test('lost poll and interrupted body recover the same accepted task without submitting again', async () => {
  const calls = [];
  const response = await searchKnowledgeImages({ ...options, fetchImpl: async (url, init) => {
    calls.push([url, init.method]);
    if (calls.length === 1) return accepted();
    if (calls.length === 2) throw disconnected();
    if (calls.length === 3) return { ok: true, status: 200, json: async () => { throw disconnected(); } };
    return complete();
  }});
  assert.equal(response.status, 'completed');
  assert.equal(response.pollRecovery.length, 2);
  assert.equal(response.pollRecovery[0].transportCode, 'ECONNRESET');
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
  assert.ok(calls.slice(1).every(([url]) => url.endsWith('query_id=qry_existing')));
});

test('persistent transport errors stop after two bounded recoveries and preserve safe diagnostics', async () => {
  let calls = 0;
  await assert.rejects(searchKnowledgeImages({ ...options, fetchImpl: async () => {
    if (++calls === 1) return accepted();
    throw disconnected();
  }}), error => error.queryId === 'qry_existing' && error.transportCode === 'ECONNRESET'
    && error.pollRecovery.length === 2 && !error.message.includes('sensitive'));
  assert.equal(calls, 4);
});

test('deadline during recovery retains the original transport failure instead of reporting empty or deadline', async () => {
  let calls = 0;
  await assert.rejects(searchKnowledgeImages({ ...options, requestTimeoutMs: 10, timeoutMs: 30, pollIntervalMs: 100,
    fetchImpl: async () => { if (++calls === 1) return accepted(); throw disconnected(); },
  }), error => error.knowledgeFailureKind === 'transport' && error.transportCode === 'ECONNRESET'
    && error.queryId === 'qry_existing');
  assert.ok(calls <= 4);
});

test('transient gateway failure resumes polling without resubmission', async () => {
  let calls = 0;
  const result = await searchKnowledgeImages({ ...options, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? accepted() : calls === 2 ? reply(503, {}) : complete();
  }});
  assert.equal(result.status, 'completed');
  assert.equal(result.pollRecovery[0].status, 503);
  assert.equal(calls, 3);
});

for (const status of [401, 403, 404, 429]) test(`HTTP ${status} is not retried or reclassified as empty`, async () => {
  let calls = 0;
  await assert.rejects(searchKnowledgeImages({ ...options, fetchImpl: async () => ++calls === 1 ? accepted() : reply(status, {}) }),
    error => error.status === status && error.knowledgeFailureKind === 'http');
  assert.equal(calls, 2);
});

test('server terminal failure and invalid JSON are not network recovery', async () => {
  let calls = 0;
  const failed = await searchKnowledgeImages({ ...options, fetchImpl: async () => ++calls === 1 ? accepted() : reply(200, { status: 'failed', error_id: 'err_one' }) });
  assert.equal(failed.status, 'failed'); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(searchKnowledgeImages({ ...options, fetchImpl: async () => ++calls === 1 ? accepted() : new Response('{', { status: 200 }) }),
    error => error.knowledgeFailureKind === 'invalid_response');
  assert.equal(calls, 2);
});

test('cancel during recovery cannot cause another poll', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(searchKnowledgeImages({ ...options, signal: controller.signal, fetchImpl: async () => {
    if (++calls === 1) return accepted();
    controller.abort(); throw disconnected();
  }}), error => error.name === 'AbortError');
  assert.equal(calls, 2);
});
