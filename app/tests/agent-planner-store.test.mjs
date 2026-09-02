import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";

test("activePlanId是唯一页面/执行计划引用，重新规划不覆盖旧记录", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-plan-store-"));
  const store = new AgentPlanStore(root);
  store.createProject({ projectId: "p1", flowKind: "agent_v1", executionEnabled: false, activePlanId: null, planIds: [] });
  store.activatePlan("p1", { planId: "plan-v1", planVersion: 1, tasks: [{ taskId: "dynamic-a" }] });
  store.activatePlan("p1", { planId: "plan-v2", previousPlanId: "plan-v1", planVersion: 2, tasks: [{ taskId: "dynamic-b" }] });
  const active = store.getActive("p1");
  assert.equal(active.project.activePlanId, "plan-v2");
  assert.deepEqual(active.project.planIds, ["plan-v1", "plan-v2"]);
  assert.equal(active.plan.tasks[0].taskId, "dynamic-b");
  assert.equal(JSON.parse(readFileSync(store.planFile("p1", "plan-v1"), "utf8")).tasks[0].taskId, "dynamic-a");
  assert.throws(() => store.activatePlan("p1", { planId: "plan-v2", tasks: [] }), /不可覆盖/);
});
