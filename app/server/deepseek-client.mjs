function parseJsonContent(content) {
  const source = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(source);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitStatus(callback, status) {
  callback?.({ ...status, lastEventAt: new Date().toISOString() });
}

function aggregateUsage(attempts = []) {
  const usages = attempts.map((item) => item.usage).filter(Boolean);
  if (!usages.length) return null;
  const sum = (path) => usages.reduce((total, usage) => total + Number(path.reduce((value, key) => value?.[key], usage) || 0), 0);
  return {
    prompt_tokens: sum(["prompt_tokens"]),
    completion_tokens: sum(["completion_tokens"]),
    total_tokens: sum(["total_tokens"]),
    prompt_tokens_details: { cached_tokens: sum(["prompt_tokens_details", "cached_tokens"]) },
    completion_tokens_details: { reasoning_tokens: sum(["completion_tokens_details", "reasoning_tokens"]) },
    prompt_cache_hit_tokens: sum(["prompt_cache_hit_tokens"]),
    prompt_cache_miss_tokens: sum(["prompt_cache_miss_tokens"]),
    attempt_count: attempts.length,
  };
}

async function consumeSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeChunk = (chunk) => {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (data) onEvent(data);
      boundary = buffer.indexOf("\n\n");
    }
  };

  if (body?.getReader) {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumeChunk(value);
    }
  } else if (body?.[Symbol.asyncIterator]) {
    for await (const chunk of body) consumeChunk(chunk);
  } else {
    throw new Error("DeepSeek 流式响应不可读取");
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (data) onEvent(data);
  }
}

export function buildDeepSeekRequest({ model, messages, reasoningEffort = "high", maxTokens = 24000, thinkingType = "enabled" }) {
  return {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: thinkingType },
    reasoning_effort: reasoningEffort,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
}

export async function requestDeepSeekJson({
  apiKey,
  baseUrl = "https://api.deepseek.com",
  model = "deepseek-v4-flash",
  messages,
  reasoningEffort = "high",
  thinkingType = "enabled",
  maxTokens = 24000,
  timeoutMs = 300000,
  emptyContentRetries = 2,
  fetchImpl = fetch,
  sleepImpl = wait,
  onStatus,
  signal,
}) {
  if (!apiKey) throw new Error("尚未配置 DeepSeek 文字模型 API Key");
  const attempts = Math.max(1, Number(emptyContentRetries) + 1);
  let emptyDiagnostic = null;
  const attemptUsages = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      emitStatus(onStatus, { providerResponded: false, streamPhase: "waiting", attempt, receivedContentChars: 0, reasoningChars: 0 });
      const combinedSignal = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(buildDeepSeekRequest({ model, messages, reasoningEffort, maxTokens, thinkingType: attempt === 1 ? thinkingType : "disabled" })),
        signal: combinedSignal,
      });
      if (!response.ok) {
        const payload = await response.json?.().catch(() => ({})) || {};
        const error = new Error(payload?.error?.message || payload?.message || `DeepSeek 接口请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }

      emitStatus(onStatus, { providerResponded: true, streamPhase: "responded", attempt, receivedContentChars: 0, reasoningChars: 0 });
      let content = "";
      let reasoningChars = 0;
      let finishReason = null;
      let usage = null;
      let actualModel = model;
      let doneReceived = false;
      await consumeSse(response.body, (data) => {
        if (data === "[DONE]") {
          doneReceived = true;
          return;
        }
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        actualModel = payload.model || actualModel;
        usage = payload.usage || usage;
        const choice = payload?.choices?.[0];
        finishReason = choice?.finish_reason || finishReason;
        const delta = choice?.delta || {};
        if (delta.reasoning_content) {
          reasoningChars += String(delta.reasoning_content).length;
          emitStatus(onStatus, { providerResponded: true, streamPhase: "reasoning", attempt, receivedContentChars: content.length, reasoningChars });
        }
        if (delta.content) {
          content += String(delta.content);
          emitStatus(onStatus, { providerResponded: true, streamPhase: "content", attempt, receivedContentChars: content.length, reasoningChars });
        }
      });
      content = content.trim();
      const attemptRecord = { attempt, usage: usage || null, finishReason, receivedContentChars: content.length, reasoningChars, outcome: "received", reasoningEffort, thinkingType: attempt === 1 ? thinkingType : "disabled" };
      attemptUsages.push(attemptRecord);
      if (!content) {
        attemptRecord.outcome = "empty_content";
        emptyDiagnostic = { finishReason, reasoningChars };
        if (attempt < attempts) {
          emitStatus(onStatus, { providerResponded: true, streamPhase: "retrying", attempt, nextAttempt: attempt + 1, receivedContentChars: 0, reasoningChars, reason: "empty_content" });
          await sleepImpl(Math.min(750 * attempt, 2000));
          continue;
        }
        throw new Error(`DeepSeek 接口连续 ${attempts} 次没有返回可用内容（finish_reason=${emptyDiagnostic.finishReason || "unknown"}，reasoning_chars=${emptyDiagnostic.reasoningChars}）`);
      }
      try {
        const parsed = parseJsonContent(content);
        attemptRecord.outcome = "accepted";
        const result = {
          json: parsed, usage: aggregateUsage(attemptUsages), attemptUsages, model: actualModel,
          recovery: attempt > 1 ? { reason: "empty_or_invalid_json", retryCount: attempt - 1, thinkingType: "disabled" } : null,
          stream: { doneReceived, finishReason, receivedContentChars: content.length, reasoningChars },
          requestProfile: { reasoningEffort, thinkingType },
        };
        emitStatus(onStatus, { providerResponded: true, streamPhase: "complete", attempt, receivedContentChars: content.length, reasoningChars });
        return result;
      } catch (error) {
        if (error instanceof SyntaxError) attemptRecord.outcome = finishReason === "length" ? "truncated_json" : "invalid_json";
        if (attempt < attempts && error instanceof SyntaxError) {
          emitStatus(onStatus, { providerResponded: true, streamPhase: "retrying", attempt, nextAttempt: attempt + 1, receivedContentChars: content.length, reasoningChars, reason: finishReason === "length" ? "truncated_json" : "invalid_json" });
          await sleepImpl(Math.min(750 * attempt, 2000));
          continue;
        }
        if (error instanceof SyntaxError) throw new Error(`DeepSeek 接口连续 ${attempts} 次未返回完整合法JSON（${error.message}）`);
        throw error;
      }
    } catch (error) {
      if (!attemptUsages.some((item) => item.attempt === attempt)) attemptUsages.push({ attempt, usage: null, finishReason: null, receivedContentChars: 0, reasoningChars: 0, outcome: error?.status ? `http_${error.status}` : error?.name === "AbortError" ? "timeout" : "stream_interrupted", reasoningEffort, thinkingType: attempt === 1 ? thinkingType : "disabled" });
      error.attemptUsages = [...attemptUsages];
      if (signal?.aborted) throw error;
      if (error?.name === "AbortError" && attempt < attempts) {
        emitStatus(onStatus, { providerResponded: false, streamPhase: "retrying", attempt, nextAttempt: attempt + 1, receivedContentChars: 0, reasoningChars: 0, reason: "timeout" });
        await sleepImpl(Math.min(1000 * attempt, 3000));
        continue;
      }
      if (error?.name === "AbortError") {
        const timeoutError = new Error(`DeepSeek 文字生成超过 ${Math.max(1, Math.round(timeoutMs / 60_000))} 分钟，请重试`);
        timeoutError.code = "model_timeout";
        timeoutError.attemptUsages = [...attemptUsages];
        throw timeoutError;
      }
      if (attempt < attempts && (error?.status === 429 || error?.status >= 500)) {
        emitStatus(onStatus, { providerResponded: false, streamPhase: "retrying", attempt, nextAttempt: attempt + 1, receivedContentChars: 0, reasoningChars: 0, reason: `http_${error.status}` });
        await sleepImpl(Math.min(1000 * attempt, 3000));
        continue;
      }
      if (attempt < attempts && !error?.status) {
        emitStatus(onStatus, { providerResponded: true, streamPhase: "retrying", attempt, nextAttempt: attempt + 1, receivedContentChars: 0, reasoningChars: 0, reason: "stream_interrupted" });
        await sleepImpl(Math.min(1000 * attempt, 3000));
        continue;
      }
      error.attemptUsages = [...attemptUsages];
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
