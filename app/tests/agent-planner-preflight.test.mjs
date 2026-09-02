import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAgentPreflight, resolvePreflightConfirmations } from "../server/agent-preflight.mjs";

test("普通解析提醒不阻止规划，费用边界缺失集中等待确认", () => {
  assert.equal(analyzeAgentPreflight({ sourceCoverage:{ warnings:["未识别出明确出发日期"] }, days:[] }).length, 0);
  const items = analyzeAgentPreflight({ sourceCoverage:{ workbookName:"fresh.xlsx", warnings:["缺少费用包含字段，将阻止生成"] }, days:[] });
  assert.equal(items.length, 1);
  assert.equal(items[0].category, "费用");
  assert.equal(items[0].status, "pending");
  const resolved = resolvePreflightConfirmations(items, [{ confirmationId:items[0].confirmationId, choiceId:"hide_unverified_fee_module" }]);
  assert.equal(resolved[0].status, "resolved");
  assert.equal(resolved[0].selectedChoiceId, "hide_unverified_fee_module");
});

test("选择等待资料不会绕过确认门禁", () => {
  const [item] = analyzeAgentPreflight({ sourceCoverage:{ warnings:["费用包含缺失会阻止生成"] }, days:[] });
  const [waiting] = resolvePreflightConfirmations([item], [{ confirmationId:item.confirmationId, choiceId:"wait_for_fee_source" }]);
  assert.equal(waiting.status, "pending");
});
