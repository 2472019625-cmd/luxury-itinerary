import test from "node:test";
import assert from "node:assert/strict";
import { runCopyWriterSkill, validateCopyValue } from "../server/simple-copy-skill.mjs";

const task = (targetId, targetPath, moduleType = "day") => ({
  targetId,
  targetPath,
  moduleType,
  facts: { source: `${targetId} 的确定事实` },
  factStatuses: { source: "confirmed" },
  plannerGoal: "只表达当前目标的客户价值",
  relevantContext: { destination: "肯尼亚" },
  outputSchema: { type: "string", minLength: 2 },
});

test("Copy 按全局、DAY、notes形成三个物理批次并按 targetId 隔离结构失败", async () => {
  let calls = 0;
  const events = [];
  const notesTask = { ...task("notes", "notes", "notes"), outputSchema: { type: "array", minItems: 1, items: { type: "string" } } };
  const input = [task("highlight-1", "highlights.0", "product_highlight"), task("day-1", "days.0.description"), task("day-2", "days.1.description"), notesTask];
  const seenBatchKinds = [];
  const result = await runCopyWriterSkill({
    tasks: input,
    itineraryContext: { destination: "肯尼亚", dayCount: 2 },
    requestJson: async ({ messages, emptyContentRetries, reasoningEffort }) => {
      calls += 1;
      assert.equal(emptyContentRetries, 1);
      assert.equal(reasoningEffort, "medium");
      assert.match(messages[0].content, /Copy Writer Skill/);
      assert.match(messages[0].content, /不是只能逐字复述 Excel/);
      assert.match(messages[0].content, /真实常见野生动物语境/);
      assert.match(messages[0].content, /不得把“可能看到”写成“保证\/必然看到”/);
      assert.match(messages[0].content, /禁止修改价格、交通承诺、接待等级/);
      const payload = JSON.parse(messages.at(-1).content);
      seenBatchKinds.push(payload.batchKind);
      return { json: { results: payload.tasks.map((item) => ({ targetId: item.targetId, targetPath: item.targetPath, value: item.targetId === "day-2" ? 123 : item.targetId === "notes" ? ["行前准备"] : "草原纵深｜以差异化区域串联完整观察体验。" })) }, attemptUsages: [{ attempt: 1 }] };
    },
    onCapabilityCall: (event) => events.push(event),
  });
  assert.equal(calls, 3);
  assert.equal(result.metrics.modelCalls, 3);
  assert.equal(result.metrics.businessBatches, 3);
  assert.equal(result.metrics.physicalBatches, 3);
  assert.equal(result.metrics.automaticBusinessRetryRounds, 0);
  assert.deepEqual(seenBatchKinds.sort(), ["days", "global", "notes"]);
  assert.equal(result.metrics.reasoningEffort, "medium");
  assert.equal(result.status, "partial_success");
  assert.deepEqual(result.results.map((item) => item.status), ["success", "success", "failed", "success"]);
  assert.equal(result.results[2].error.code, "invalid_output_schema");
  assert.equal(result.results[0].targetPath, "highlights.0");
  assert.deepEqual([...new Set(events.map((event) => event.capabilityId))], ["copy_writer"]);
  assert.deepEqual([...new Set(events.map((event) => event.batchKind))].sort(), ["days", "global", "notes"]);
});

test("单个物理批次技术重试耗尽只影响该批 targets", async () => {
  const input = [task("cover", "title", "cover"), task("day-1", "days.0.description"), task("day-2", "days.1.description"), { ...task("notes", "notes", "notes"), outputSchema: { type: "array", items: { type: "string" }, minItems: 1 } }];
  let physicalCalls = 0;
  const result = await runCopyWriterSkill({
    tasks: input,
    requestJson: async ({ messages, emptyContentRetries }) => {
      physicalCalls += 1;
      assert.equal(emptyContentRetries, 1);
      const payload = JSON.parse(messages.at(-1).content);
      if (payload.batchKind === "days") {
        const error = new Error("network failed after one technical retry");
        error.attemptUsages = [{ attempt: 1 }, { attempt: 2 }];
        throw error;
      }
      return { json: { results: payload.tasks.map((item) => ({ targetId: item.targetId, targetPath: item.targetPath, value: item.targetId === "notes" ? ["行前准备"] : "有效文案" })) }, attemptUsages: [{ attempt: 1 }] };
    },
  });
  assert.equal(physicalCalls, 3);
  assert.equal(result.metrics.businessBatches, 3);
  assert.equal(result.metrics.modelCalls, 4);
  assert.equal(result.metrics.transportAttempts, 4);
  assert.equal(result.metrics.automaticBusinessRetryRounds, 0);
  assert.equal(result.results.find((item) => item.targetId === "cover").status, "success");
  assert.equal(result.results.find((item) => item.targetId === "notes").status, "success");
  assert.ok(result.results.filter((item) => item.targetId.startsWith("day-")).every((item) => item.status === "failed"));
});

test("产品亮点契约不完整时明确返回且不自行规划", async () => {
  let calls = 0;
  const bad = { ...task("highlight-bad", "subtitle", "product_highlight") };
  const result = await runCopyWriterSkill({ tasks: [bad], requestJson: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, "needs_input");
  assert.equal(result.results[0].error.code, "invalid_highlight_contract");
});

test("outputSchema 校验对象和数组结构", () => {
  assert.deepEqual(validateCopyValue({ title: "证件", items: ["检查护照"] }, { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } }, additionalProperties: false }), []);
  assert.ok(validateCopyValue({ title: "证件", items: [3] }, { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } } }).length > 0);
  assert.deepEqual(validateCopyValue({ title: "证件", items: ["检查护照"] }, { oneOf: [{ type: "string" }, { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } } }] }), []);
});
