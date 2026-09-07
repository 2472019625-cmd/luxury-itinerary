import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";
import { createAgentPlannerServer } from "../server/agent-planner-app.mjs";

test("员工端确认后创建 simple_skill_v1 运行而不是旧 agent_v1", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-server-"));
  const simpleStore = new AgentPlanStore(path.join(root, "projects"));
  let received;
  const runtime = createAgentPlannerServer({
    port: 0,
    simpleStore,
    simplePipelineRunner: async (options) => {
      received = options;
      options.onEvent({ stage: "parser", phase: "started" });
      options.onEvent({ stage: "parser", phase: "finished" });
      options.onEvent({ stage: "planner", phase: "started", projectId: options.projectId });
      options.onEvent({ stage: "planner", phase: "progress", detail: { message: "正在返回规划" } });
      return { projectId: options.projectId, pipelineStatus: "complete" };
    },
  });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const port = runtime.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/simple/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facts: { destination: "肯尼亚", days: [{ day: 1 }] }, report: { workbookName: "fixture.xlsx" }, sourceName: "fixture.xlsx" }),
  });
  const created = await response.json();
  assert.equal(response.status, 202);
  assert.equal(created.flowKind, "simple_skill_v1");
  assert.ok(created.projectId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.projectId, created.projectId);
  assert.equal(received.sourceData.data.destination, "肯尼亚");
  assert.equal(runtime.simpleJobs.get(created.projectId).status, "complete");
});
