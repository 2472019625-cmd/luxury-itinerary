import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";
import { createAgentPlannerServer } from "../server/agent-planner-app.mjs";

test("服务端目录隔离用户；移入回收站停止制作；恢复和永久清理原始资料", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-storage-"));
  const simpleStore = new AgentPlanStore(path.join(root, "simple"));
  let releaseRunner;
  const paused = new Promise((resolve) => { releaseRunner = resolve; });
  const runtime = createAgentPlannerServer({
    port: 0,
    workspaceRoot: path.join(root, "agent", "projects"),
    simpleStore,
    catalogFile: path.join(root, "catalog.sqlite"),
    cleanupIntervalMs: 0,
    simplePipelineRunner: async ({ projectId, ownerId, onEvent }) => {
      simpleStore.createProject({ projectId, ownerId, flowKind: "simple_skill_v1", status: "running", currentStage: "内容制作", progress: 12, activePlanId: null, planIds: [], executionRunIds: [] });
      onEvent({ stage: "copy_skill", phase: "started", targetCount: 10 });
      await paused;
      return { projectId, pipelineStatus: "complete" };
    },
  });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { releaseRunner(); await new Promise((resolve) => runtime.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const ownerA = { "content-type": "application/json", "x-agent-local-user": "owner-a" };
  const ownerB = { "content-type": "application/json", "x-agent-local-user": "owner-b" };
  const missingOwnerResponse = await fetch(`${base}/api/simple/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts: { days: [{ day: 1 }] } }) });
  assert.equal(missingOwnerResponse.status, 401, "缺少当前账号时不得创建共享账号制作任务");
  assert.equal(runtime.simpleJobs.size, 0);
  const runResponse = await fetch(`${base}/api/simple/projects`, { method: "POST", headers: ownerA, body: JSON.stringify({ facts: { destination: "肯尼亚", days: [{ day: 1 }] }, report: {}, sourceName: "trip.xlsx" }) });
  const run = await runResponse.json();
  assert.equal(runResponse.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(simpleStore.getProject(run.projectId).ownerId, "owner-a");
  const project = { id: "customer-trip", title: "肯尼亚行程", flowKind: "simple_skill_v1", files: [{ name: "trip.xlsx" }], agentProjectId: run.projectId, workflowStage: "simple-running" };
  const createdResponse = await fetch(`${base}/api/agent-workspace/projects`, { method: "POST", headers: ownerA, body: JSON.stringify({ project }) });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.project.ownerId, "owner-a");
  assert.equal((await fetch(`${base}/api/agent-workspace/projects/customer-trip`, { headers: ownerB })).status, 404);
  const source = await fetch(`${base}/api/agent-workspace/projects/customer-trip/source`, { method: "PUT", headers: { "x-agent-local-user": "owner-a" }, body: Buffer.from("workbook-fixture") });
  assert.equal(source.status, 200);
  const sourceFile = path.join(root, "agent", "sources", "customer-trip", "original.xlsx");
  assert.ok((await stat(sourceFile)).size > 0);
  const trashResponse = await fetch(`${base}/api/agent-workspace/projects/customer-trip/trash`, { method: "POST", headers: ownerA });
  const trashed = await trashResponse.json();
  assert.equal(trashResponse.status, 200);
  assert.ok(trashed.project.purgeAt > trashed.project.trashedAt);
  assert.equal(simpleStore.getProject(run.projectId).status, "cancelled");
  releaseRunner();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(simpleStore.getProject(run.projectId).status, "cancelled", "迟到的任务不能覆盖停止状态");
  const restoredResponse = await fetch(`${base}/api/agent-workspace/projects/customer-trip/restore`, { method: "POST", headers: ownerA });
  assert.equal(restoredResponse.status, 200);
  assert.equal((await restoredResponse.json()).project.trashedAt, null);
  assert.ok((await stat(sourceFile)).size > 0, "恢复后原始资料仍在");
  await fetch(`${base}/api/agent-workspace/projects/customer-trip/trash`, { method: "POST", headers: ownerA });
  assert.equal((await fetch(`${base}/api/agent-workspace/projects/customer-trip`, { method: "DELETE", headers: ownerA })).status, 200);
  assert.equal((await fetch(`${base}/api/agent-workspace/projects/customer-trip`, { headers: ownerA })).status, 404);
  assert.equal(simpleStore.getProject(run.projectId), null);
  await assert.rejects(stat(sourceFile), { code: "ENOENT" });
  runtime.catalog.create("owner-a", { id: "expired-trip", files: [{ name: "old.xlsx" }] }, Date.now() - 32 * 24 * 60 * 60 * 1000);
  runtime.catalog.trash("owner-a", "expired-trip", Date.now() - 31 * 24 * 60 * 60 * 1000);
  await runtime.purgeExpiredProjects();
  assert.equal(runtime.catalog.get("owner-a", "expired-trip"), null, "到期项目会由服务端定时清理");
});
