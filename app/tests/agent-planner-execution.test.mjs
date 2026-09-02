import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";
import { assertCapabilityRoute, cancelExecutionRun, createExecutionRun, readyExecutionTasks, readyParallelGroups, transitionExecutionTask } from "../server/agent-execution-scheduler.mjs";

const tasks = [
  { taskId:"a", taskType:"source_intake", capabilityIds:["source_parser"], dependsOn:[], parallelGroup:"P1" },
  { taskId:"b", taskType:"journey_strategy", capabilityIds:["trip_planner"], dependsOn:["a"], parallelGroup:"P2" },
];
const plan = { planId:"plan-1", inputFingerprint:"fingerprint", status:"plan_only", executionEnabled:false, ruleProfileVersion:AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion:AGENT_CAPABILITY_VERSION, tasks };
const project = { projectId:"project-1", activePlanId:"plan-1", inputFingerprint:"fingerprint" };

test("执行记录只引用activePlanId并取得计划级执行授权", () => {
  const run = createExecutionRun(project, plan, "2026-09-02T00:00:00.000Z");
  assert.equal(run.planId, plan.planId);
  assert.equal(run.status, "pending");
  assert.equal(run.executionEnabled, true);
  assert.equal(run.authorization.planId, plan.planId);
  assert.ok(run.taskRuns.every((item) => item.status === "pending"));
  assert.ok(run.capabilityCallStats.every((item) => item.actualCalls === 0));
  assert.deepEqual(readyExecutionTasks(plan, run).map((item) => item.taskId), ["a"]);
  assert.deepEqual(readyParallelGroups(plan, run), [{ parallelGroup:"P1", taskIds:["a"] }]);
  assert.equal(assertCapabilityRoute(tasks[0], "source_parser", run).id, "source_parser");
  assert.throws(() => assertCapabilityRoute(tasks[0], "trip_planner", run), /不属于任务/);
});

test("取消只改变运行记录，不修改计划", () => {
  const snapshot = structuredClone(plan);
  const initial = createExecutionRun(project, plan);
  const running = transitionExecutionTask(plan, initial, "a", "running");
  const cancelled = cancelExecutionRun(plan, running);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.taskRuns.every((item) => item.status === "cancelled"));
  assert.ok(cancelled.events.some((item) => item.type === "run_cancelled"));
  assert.deepEqual(plan, snapshot);
  assert.throws(() => createExecutionRun({ ...project, activePlanId:"other" }, plan), /activePlanId/);
});
