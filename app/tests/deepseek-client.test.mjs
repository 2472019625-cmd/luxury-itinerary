import test from "node:test";
import assert from "node:assert/strict";
import { buildDeepSeekRequest, requestDeepSeekJson } from "../server/deepseek-client.mjs";

function sseResponse(events, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  return {
    ok,
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        const text = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
        const split = Math.max(1, Math.floor(text.length / 3));
        yield encoder.encode(text.slice(0, split));
        yield encoder.encode(text.slice(split, split * 2));
        yield encoder.encode(text.slice(split * 2));
      },
    },
    json: async () => ({}),
  };
}

function completion(content, { reasoning = "", finishReason = null, model } = {}) {
  return {
    ...(model ? { model } : {}),
    choices: [{ delta: { ...(reasoning ? { reasoning_content: reasoning } : {}), ...(content ? { content } : {}) }, finish_reason: finishReason }],
  };
}

test("builds a DeepSeek V4 JSON request without legacy provider fields", () => {
  const body = buildDeepSeekRequest({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "test" }], reasoningEffort: "high", maxTokens: 321 });
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 321);
  assert.equal("do_sample" in body, false);
  assert.equal("clear_thinking" in body.thinking, false);
});

test("can disable thinking on the first mechanical attempt and keeps retries disabled", async () => {
  const thinkingTypes = [];
  let calls = 0;
  const result = await requestDeepSeekJson({
    apiKey: "test-key",
    messages: [{ role: "user", content: "repair json" }],
    reasoningEffort: "low",
    thinkingType: "disabled",
    emptyContentRetries: 1,
    fetchImpl: async (_url, options) => {
      calls += 1;
      thinkingTypes.push(JSON.parse(options.body).thinking.type);
      return sseResponse(calls === 1 ? [completion("", { finishReason: "stop" }), "[DONE]"] : [completion('{"ok":true}', { finishReason: "stop" }), "[DONE]"]);
    },
    sleepImpl: async () => {},
  });
  assert.deepEqual(thinkingTypes, ["disabled", "disabled"]);
  assert.deepEqual(result.requestProfile, { reasoningEffort: "low", thinkingType: "disabled" });
  assert.deepEqual(result.attemptUsages.map((item) => item.thinkingType), ["disabled", "disabled"]);
});

test("parses fragmented SSE JSON, records model, and never exposes reasoning text", async () => {
  let request;
  const statuses = [];
  const result = await requestDeepSeekJson({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "test" }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return sseResponse([
        completion("", { reasoning: "private chain of thought", model: "deepseek-v4-flash-0731" }),
        completion("```json\n{\"ok\":"),
        completion("true}\n```", { finishReason: "stop" }),
        { choices: [], usage: { total_tokens: 10 } },
        "[DONE]",
      ]);
    },
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.model, "deepseek-v4-flash-0731");
  assert.equal(result.stream.reasoningChars, 24);
  assert.equal(result.stream.doneReceived, true);
  assert.equal(JSON.stringify(statuses).includes("private chain of thought"), false);
  assert.equal(statuses.at(-1).streamPhase, "complete");
});

test("fails safely when the DeepSeek key is missing", async () => {
  await assert.rejects(() => requestDeepSeekJson({ messages: [] }), /尚未配置 DeepSeek/);
});

test("retries empty content twice before accepting a usable JSON response", async () => {
  let calls = 0;
  const thinkingTypes = [];
  const result = await requestDeepSeekJson({
    apiKey: "test-key",
    messages: [{ role: "user", content: "test" }],
    fetchImpl: async (_url, options) => {
      calls += 1;
      thinkingTypes.push(JSON.parse(options.body).thinking.type);
      return sseResponse(calls < 3
        ? [completion("", { finishReason: "stop" }), { choices: [], usage: { prompt_tokens: calls, completion_tokens: calls, total_tokens: calls * 2 } }, "[DONE]"]
        : [completion('{"ok":true}', { finishReason: "stop" }), { choices: [], usage: { prompt_tokens: calls, completion_tokens: calls, total_tokens: calls * 2 } }, "[DONE]"]);
    },
    sleepImpl: async () => {},
  });
  assert.equal(calls, 3);
  assert.deepEqual(thinkingTypes, ["enabled", "disabled", "disabled"]);
  assert.deepEqual(result.json, { ok: true });
  assert.deepEqual(result.recovery, { reason: "empty_or_invalid_json", retryCount: 2, thinkingType: "disabled" });
  assert.equal(result.usage.total_tokens, 12);
  assert.deepEqual(result.attemptUsages.map((item) => item.outcome), ["empty_content", "empty_content", "accepted"]);
});

test("retries a truncated JSON response without accepting partial output", async () => {
  let calls = 0;
  const attempts = [];
  const result = await requestDeepSeekJson({
    apiKey: "test-key",
    emptyContentRetries: 1,
    messages: [{ role: "user", content: "test" }],
    fetchImpl: async () => {
      calls += 1;
      return sseResponse([completion(calls === 1 ? '{"broken":"' : '{"ok":true}', { finishReason: calls === 1 ? "length" : "stop" }), "[DONE]"]);
    },
    sleepImpl: async () => {},
    onModelAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.recovery.reason, "empty_or_invalid_json");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].rawContent, '{"broken":"');
  assert.equal(attempts[0].parseResult.status, "invalid_json");
  assert.equal(attempts[1].rawContent, '{"ok":true}');
  assert.equal(attempts[1].parseResult.status, "valid_json");
});

test("repairs only deterministic JSON punctuation before accepting the response", async () => {
  let calls = 0;
  const attempts = [];
  const result = await requestDeepSeekJson({
    apiKey: "test-key",
    emptyContentRetries: 1,
    allowSyntaxRepair: true,
    messages: [{ role: "user", content: "return json" }],
    fetchImpl: async () => {
      calls += 1;
      return sseResponse([completion('{"summary":{"ok":true} "items":[1,2,],}', { finishReason: "stop" }), "[DONE]"]);
    },
    sleepImpl: async () => {},
    onModelAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.json, { summary: { ok: true }, items: [1, 2] });
  assert.equal(result.parseResult.status, "repaired_json");
  assert.deepEqual(result.parseResult.operations.map((item) => item.type), ["removed_trailing_comma", "removed_trailing_comma", "inserted_missing_comma"]);
  assert.equal(attempts[0].parseResult.status, "repaired_json");
});

test("does not invent content when malformed JSON cannot be deterministically repaired", async () => {
  let calls = 0;
  const attempts = [];
  await assert.rejects(() => requestDeepSeekJson({
    apiKey: "test-key",
    emptyContentRetries: 1,
    allowSyntaxRepair: true,
    messages: [{ role: "user", content: "return json" }],
    fetchImpl: async () => {
      calls += 1;
      return sseResponse([completion('{"businessField":"unterminated', { finishReason: "length" }), "[DONE]"]);
    },
    sleepImpl: async () => {},
    onModelAttempt: (attempt) => attempts.push(attempt),
  }), /连续 2 次未返回完整合法JSON/);
  assert.equal(calls, 2);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((attempt) => attempt.parseResult.status === "invalid_json"));
  assert.ok(attempts.every((attempt) => attempt.rawContent === '{"businessField":"unterminated'));
});

test("reports a clear error after all empty-content retries are exhausted", async () => {
  let calls = 0;
  await assert.rejects(() => requestDeepSeekJson({
    apiKey: "test-key",
    messages: [{ role: "user", content: "test" }],
    fetchImpl: async () => {
      calls += 1;
      return sseResponse([completion("", { finishReason: null }), "[DONE]"]);
    },
    sleepImpl: async () => {},
  }), /连续 3 次没有返回可用内容.*finish_reason=unknown/);
  assert.equal(calls, 3);
});

test("retries rate limits with a bounded attempt and sanitized retry status", async () => {
  let calls = 0;
  const statuses = [];
  const result = await requestDeepSeekJson({
    apiKey: "test-key",
    emptyContentRetries: 1,
    messages: [{ role: "user", content: "test" }],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({ error: { message: "busy" } }) };
      return sseResponse([completion('{"ok":true}', { finishReason: "stop" }), "[DONE]"]);
    },
    sleepImpl: async () => {},
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(statuses.some((status) => status.streamPhase === "retrying" && status.reason === "http_429"), true);
});

test("does not retry authentication failures", async () => {
  let calls = 0;
  await assert.rejects(() => requestDeepSeekJson({
    apiKey: "bad-key",
    messages: [],
    fetchImpl: async () => { calls += 1; return { ok: false, status: 401, json: async () => ({ error: { message: "unauthorized" } }) }; },
    sleepImpl: async () => {},
  }), /unauthorized/);
  assert.equal(calls, 1);
});

test("retries an interrupted stream without retaining its partial JSON", async () => {
  let calls = 0;
  const statuses = [];
  const encoder = new TextEncoder();
  const result = await requestDeepSeekJson({
    apiKey: "test-key",
    emptyContentRetries: 1,
    messages: [],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) return sseResponse([completion('{"ok":true}', { finishReason: "stop" }), "[DONE]"]);
      return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield encoder.encode('data: {"choices":[{"delta":{"content":"{\\"partial\\":"}}]}\n\n'); throw new Error("socket closed"); } } };
    },
    sleepImpl: async () => {},
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(statuses.some((status) => status.reason === "stream_interrupted"), true);
});
