import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";
import { assertCapabilityRoute, cancelExecutionRun, createExecutionRun, readyExecutionTasks, readyParallelGroups } from "../server/agent-execution-scheduler.mjs";

const tasks = [
  { taskId:"a", taskType:"source_intake", capabilityIds:["source_parser"], dependsOn:[], parallelGroup:"P1" },
  { taskId:"b", taskType:"journey_strategy", capabilityIds:["trip_planner"], dependsOn:["a"], parallelGroup:"P2" },
];
const plan = { planId:"plan-1", inputFingerprint:"fingerprint", status:"plan_only", executionEnabled:false, ruleProfileVersion:AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion:AGENT_CAPABILITY_VERSION, tasks };
const project = { projectId:"project-1", activePlanId:"plan-1", inputFingerprint:"fingerprint" };

test("执行记录只引用activePlanId并保持全部能力零调用", () => {
  const run = createExecutionRun(project, plan, "2026-09-02T00:00:00.000Z");
  assert.equal(run.planId, plan.planId);
  assert.equal(run.status, "execution_disabled");
  assert.ok(run.taskRuns.every((item) => item.status === "pending"));
  assert.ok(run.capabilityCallStats.every((item) => item.actualCalls === 0));
  assert.deepEqual(readyExecutionTasks(plan, run).map((item) => item.taskId), ["a"]);
  assert.deepEqual(readyParallelGroups(plan, run), [{ parallelGroup:"P1", taskIds:["a"] }]);
  assert.throws(() => assertCapabilityRoute(tasks[0], "source_parser"), /执行能力尚未开放/);
});

test("取消只改变运行记录，不修改计划", () => {
  const snapshot = structuredClone(plan);
  const cancelled = cancelExecutionRun(createExecutionRun(project, plan));
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.taskRuns.every((item) => item.status === "cancelled"));
  assert.deepEqual(plan, snapshot);
  assert.throws(() => createExecutionRun({ ...project, activePlanId:"other" }, plan), /activePlanId/);
});
