import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_CAPABILITIES, ACTUAL_INVOCATION_ALLOWLIST } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_IDS, CHECKPOINT_IDS, RULE_GROUP_COUNTS } from "../config/agent-rule-profile.mjs";
import { AGENT_TASK_ROUTES } from "../config/agent-task-routing.mjs";

test("正式规则配置覆盖92条规则且分组数量正确", () => {
  assert.equal(AGENT_RULE_IDS.length, 92);
  assert.deepEqual(RULE_GROUP_COUNTS, { FLOW: 10, DATA: 16, COPY: 17, IMG: 20, VIS: 16, OPS: 13 });
  assert.equal(new Set(AGENT_RULE_IDS).size, 92);
});

test("15项能力完整且真实调用白名单只有解析与规划", () => {
  assert.equal(AGENT_CAPABILITIES.length, 15);
  assert.deepEqual(ACTUAL_INVOCATION_ALLOWLIST, ["source_parser", "trip_planner"]);
  for (const item of AGENT_CAPABILITIES) {
    for (const key of ["allowedInputSchemas", "allowedOutputSchemas", "mutablePaths", "forbiddenPaths", "reasoningPolicy", "budgetKey", "failureTypes", "retryLimit", "evidenceSchema", "userStateMap"]) assert.notEqual(item[key], undefined, `${item.id}.${key}`);
  }
});

test("任务路由覆盖全部安全检查点但不把检查点当展示任务", () => {
  const covered = new Set(Object.values(AGENT_TASK_ROUTES).flatMap((route) => route.checkpoints));
  assert.deepEqual([...covered].sort(), [...CHECKPOINT_IDS].sort());
  assert.ok(!Object.keys(AGENT_TASK_ROUTES).some((key) => /^T\d{2}$/.test(key)));
});

test("计划schema是正式版本化结构", () => {
  const schema = JSON.parse(readFileSync(new URL("../config/agent-plan.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, "agent.project-plan.v1");
  assert.ok(schema.required.includes("tasks"));
  assert.ok(schema.required.includes("activePlanId") === false);
  assert.equal(schema.properties.executionEnabled.const, false);
  assert.equal(schema.properties.tasks.items.properties.invocationMode.const, "plan_only");
});

test("规划提示词把路由作为白名单并要求动态DAY目标", () => {
  const prompt = readFileSync(new URL("../prompts/agent-trip-planner-v1.md", import.meta.url), "utf8");
  assert.match(prompt, /不是每次必须逐条实例化的固定任务模板/);
  assert.match(prompt, /customerCopy\.days\.day1_to_day3/);
  assert.match(prompt, /不能固定为路由数量/);
});
