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

test("批量 Copy 一次调用并按 targetId 隔离结构失败", async () => {
  let calls = 0;
  const events = [];
  const input = [task("highlight-1", "highlights.0", "product_highlight"), task("day-1", "days.0.description"), task("day-2", "days.1.description")];
  const result = await runCopyWriterSkill({
    tasks: input,
    itineraryContext: { destination: "肯尼亚", dayCount: 2 },
    requestJson: async ({ messages, emptyContentRetries, reasoningEffort }) => {
      calls += 1;
      assert.equal(emptyContentRetries, 0);
      assert.equal(reasoningEffort, "medium");
      assert.match(messages[0].content, /Copy Writer Skill/);
      return { json: { results: [
        { targetId: "highlight-1", targetPath: "highlights.0", value: "草原纵深｜以差异化区域串联完整观察体验。" },
        { targetId: "day-1", targetPath: "days.0.description", value: "进入保护区，展开当天真实体验。" },
        { targetId: "day-2", targetPath: "days.1.description", value: 123 },
      ] }, attemptUsages: [{ attempt: 1 }] };
    },
    onCapabilityCall: (event) => events.push(event),
  });
  assert.equal(calls, 1);
  assert.equal(result.metrics.modelCalls, 1);
  assert.equal(result.metrics.businessBatches, 1);
  assert.equal(result.metrics.reasoningEffort, "medium");
  assert.equal(result.status, "partial_success");
  assert.deepEqual(result.results.map((item) => item.status), ["success", "success", "failed"]);
  assert.equal(result.results[2].error.code, "invalid_output_schema");
  assert.equal(result.results[0].targetPath, "highlights.0");
  assert.deepEqual([...new Set(events.map((event) => event.capabilityId))], ["copy_writer"]);
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
