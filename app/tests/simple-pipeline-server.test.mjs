import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { scryptSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";
import { createAgentPlannerServer } from "../server/agent-planner-app.mjs";
import { SharedApiKeyStore } from "../server/shared-api-keys.mjs";
import { provisionInitialAdmin } from "../server/demo-auth.mjs";

test("共用 Key 仅初始管理账号可设置，员工邀请码账号只使用且不能读取", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-shared-keys-"));
  const credentialFile = path.join(root, "auth.json");
  const usersFile = path.join(root, "users.json");
  const salt = "d".repeat(32);
  await writeFile(credentialFile, JSON.stringify({ login:"legacy", salt, hash:scryptSync("legacy-secret", salt, 64).toString("hex") }));
  provisionInitialAdmin({ credentialFile, usersFile, login:"sheyou-admin", name:"负责人", password:"482615" });
  const origin = "https://sheyou-ai.cn";
  const runWaiters = [];
  const nextRun = () => new Promise((resolve) => runWaiters.push(resolve));
  const runtime = createAgentPlannerServer({
    port:0, workspaceRoot:path.join(root,"agent"), catalogFile:path.join(root,"catalog.sqlite"), simpleStore:new AgentPlanStore(path.join(root,"projects")),
    auth:{ enabled:true, file:credentialFile, usersFile, inviteCode:"TEAM-INVITE", origin, secure:false },
    modelConfig:{ apiKey:"bypass-text-key", baseUrl:"https://text.example/v1", model:"text-model" },
    searchModelConfig:{ apiKey:"bypass-search-key", baseUrl:"https://search.example/v1", model:"search-model", imageSearchModel:"image-model" },
    visionModelConfig:{ apiKey:"bypass-vision-key", baseUrl:"https://vision.example/v1", model:"vision-model" },
    fetchImpl:async () => ({ ok:true, status:200 }),
    simplePipelineRunner:async (options) => { runWaiters.shift()?.(options); return { pipelineStatus:"complete" }; },
  });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => runtime.server.close(resolve)); await rm(root, { recursive:true, force:true }); });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const headers = { host:"sheyou-ai.cn", "x-forwarded-for":"203.0.113.5", origin, "content-type":"application/json" };
  const adminLogin = await fetch(`${base}/api/auth/login`, { method:"POST", headers, body:JSON.stringify({ login:"sheyou-admin", password:"482615" }) });
  assert.equal(adminLogin.status, 200);
  assert.equal((await adminLogin.json()).user.canManageApiKeys, true);
  const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
  const register = await fetch(`${base}/api/auth/register`, { method:"POST", headers, body:JSON.stringify({ invite:"TEAM-INVITE", name:"员工", login:"employee", password:"employee-pin" }) });
  assert.equal(register.status, 200);
  assert.equal((await register.json()).user.canManageApiKeys, false);
  const employeeCookie = register.headers.get("set-cookie").split(";")[0];
  const keyUrl = `${base}/api/admin/api-keys`;
  assert.equal((await fetch(keyUrl, { headers:{ ...headers, cookie:employeeCookie } })).status, 403);
  assert.equal((await fetch(`${keyUrl}/text`, { method:"PUT", headers:{ ...headers, cookie:employeeCookie }, body:JSON.stringify({ apiKey:"forbidden" }) })).status, 403);
  assert.equal((await fetch(`${keyUrl}/mode`, { method:"POST", headers:{ ...headers, cookie:employeeCookie }, body:JSON.stringify({ mode:"shared" }) })).status, 403);
  const body = JSON.stringify({ facts:{ destination:"肯尼亚", days:[{ day:1 }] } });
  const legacyRunStarted = nextRun();
  assert.equal((await fetch(`${base}/api/simple/projects`, { method:"POST", headers:{ ...headers, cookie:employeeCookie }, body })).status, 202);
  const legacyRun = await legacyRunStarted;
  assert.equal(legacyRun.plannerOptions.apiKey, "bypass-text-key");
  assert.equal(legacyRun.copyOptions.researchApiKey, "bypass-search-key");
  assert.equal((await (await fetch(keyUrl, { headers:{ ...headers, cookie:adminCookie } })).json()).mode, "legacy");
  assert.equal((await fetch(`${keyUrl}/mode`, { method:"POST", headers:{ ...headers, cookie:adminCookie }, body:JSON.stringify({ mode:"shared" }) })).status, 400);
  for (const id of ["text", "search", "vision", "you"]) {
    const saved = await fetch(`${keyUrl}/${id}`, { method:"PUT", headers:{ ...headers, cookie:adminCookie }, body:JSON.stringify({ apiKey:`private-${id}-secret` }) });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(JSON.stringify(await saved.json()), /private-.*-secret/);
  }
  const status = await (await fetch(keyUrl, { headers:{ ...headers, cookie:adminCookie } })).json();
  assert.equal(status.services.filter((service) => service.configured).length, 4);
  assert.equal(status.mode, "legacy");
  const tested = await (await fetch(`${keyUrl}/text/test`, { method:"POST", headers:{ ...headers, cookie:adminCookie } })).json();
  assert.equal(tested.connected, true);
  const stillLegacyRunStarted = nextRun();
  assert.equal((await fetch(`${base}/api/simple/projects`, { method:"POST", headers:{ ...headers, cookie:employeeCookie }, body })).status, 202);
  assert.equal((await stillLegacyRunStarted).plannerOptions.apiKey, "bypass-text-key");
  const activated = await fetch(`${keyUrl}/mode`, { method:"POST", headers:{ ...headers, cookie:adminCookie }, body:JSON.stringify({ mode:"shared" }) });
  assert.equal(activated.status, 200);
  assert.equal((await activated.json()).mode, "shared");
  const runStarted = nextRun();
  assert.equal((await fetch(`${base}/api/simple/projects`, { method:"POST", headers:{ ...headers, cookie:employeeCookie }, body })).status, 202);
  const run = await runStarted;
  assert.equal(run.plannerOptions.apiKey, "private-text-secret");
  assert.equal(run.copyOptions.researchApiKey, "private-search-secret");
  assert.equal(run.copyOptions.hotelSearchApiKey, "private-you-secret");
  assert.equal(run.imageOptions.visionApiKey, "private-vision-secret");
  assert.equal((await fetch(`${keyUrl}/text`, { method:"DELETE", headers:{ ...headers, cookie:adminCookie } })).status, 400);
  const rolledBack = await fetch(`${keyUrl}/mode`, { method:"POST", headers:{ ...headers, cookie:adminCookie }, body:JSON.stringify({ mode:"legacy" }) });
  assert.equal((await rolledBack.json()).mode, "legacy");
  const restoredRunStarted = nextRun();
  assert.equal((await fetch(`${base}/api/simple/projects`, { method:"POST", headers:{ ...headers, cookie:employeeCookie }, body })).status, 202);
  assert.equal((await restoredRunStarted).plannerOptions.apiKey, "bypass-text-key");
});

test("Simple 项目按登录定制师隔离且旧项目只归 dsy 兼容账号", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-owner-auth-"));
  const simpleStore = new AgentPlanStore(path.join(root, "projects"));
  simpleStore.createProject({ projectId:"mine", flowKind:"simple_skill_v1", ownerId:"shared-demo", status:"complete", activePlanId:null, planIds:[], executionRunIds:[] });
  simpleStore.createProject({ projectId:"other", flowKind:"simple_skill_v1", ownerId:"user-other", status:"complete", activePlanId:null, planIds:[], executionRunIds:[] });
  simpleStore.createProject({ projectId:"legacy", flowKind:"simple_skill_v1", status:"complete", activePlanId:null, planIds:[], executionRunIds:[] });
  const authFile = path.join(root, "auth.json");
  const salt = "c".repeat(32);
  const password = "dsy-password";
  await writeFile(authFile, JSON.stringify({ name:"dsy", login:"dsy", salt, hash:scryptSync(password,salt,64).toString("hex") }));
  const origin = "https://sheyou-ai.cn";
  const apiKeyStore = new SharedApiKeyStore({ file:path.join(root, "shared-keys.json") });
  for (const id of ["text", "search", "vision", "you"]) apiKeyStore.set(id, `test-${id}-key`);
  const runtime = createAgentPlannerServer({
    port:0,
    workspaceRoot:path.join(root,"agent"),
    simpleStore,
    apiKeyStore,
    simplePipelineRunner:async ({ projectId, ownerId }) => {
      simpleStore.createProject({ projectId, ownerId, flowKind:"simple_skill_v1", status:"complete", activePlanId:null, planIds:[], executionRunIds:[] });
      return { pipelineStatus:"complete" };
    },
    auth:{ enabled:true, file:authFile, usersFile:path.join(root,"users.json"), inviteCode:"TEAM-INVITE", origin, secure:false },
  });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => runtime.server.close(resolve)); await rm(root, { recursive:true, force:true }); });
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  const headers = { host:"sheyou-ai.cn", "x-forwarded-for":"203.0.113.3", origin, "content-type":"application/json" };
  const login = await fetch(`${url}/api/auth/login`, { method:"POST", headers, body:JSON.stringify({ login:"dsy", password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const get = id => fetch(`${url}/api/simple/projects/${id}`, { headers:{ ...headers, cookie } });
  assert.equal((await get("mine")).status, 200);
  assert.equal((await get("other")).status, 404);
  assert.equal((await get("legacy")).status, 200);
  assert.equal(simpleStore.getProject("legacy").ownerId, "shared-demo");
  const registered = await fetch(`${url}/api/auth/register`, { method:"POST", headers, body:JSON.stringify({ invite:"TEAM-INVITE", name:"张三", login:"zhangsan", password:"safe-password" }) });
  assert.equal(registered.status, 200);
  const otherCookie = registered.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${url}/api/simple/projects/mine`, { headers:{ ...headers, cookie:otherCookie } })).status, 404);
  const created = await fetch(`${url}/api/simple/projects`, { method:"POST", headers:{ ...headers, cookie:otherCookie }, body:JSON.stringify({ facts:{ destination:"肯尼亚", days:[{ title:"抵达" }] } }) });
  assert.equal(created.status, 202);
  const createdBody = await created.json();
  assert.match(runtime.simpleJobs.get(createdBody.projectId).project.ownerId, /^user-/);
});

test("员工端确认后创建 simple_skill_v1 运行而不是旧 agent_v1", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-server-"));
  const simpleStore = new AgentPlanStore(path.join(root, "projects"));
  let received;
  let releaseRunner;
  const runnerPaused = new Promise((resolve) => { releaseRunner = resolve; });
  const runtime = createAgentPlannerServer({
    port: 0,
    simpleStore,
    modelConfig: { apiKey: "text-key", baseUrl: "https://text.example/v1", model: "text-model" },
    searchModelConfig: { apiKey: "search-key", baseUrl: "https://search.example/v1", model: "facts-search-model", imageSearchModel: "image-search-model" },
    simplePipelineRunner: async (options) => {
      received = options;
      options.onEvent({ stage: "parser", phase: "started" });
      options.onEvent({ stage: "parser", phase: "finished" });
      options.onEvent({ stage: "planner", phase: "started", projectId: options.projectId });
      options.onEvent({ stage: "planner", phase: "progress", detail: { message: "正在返回规划" } });
      options.onEvent({ stage: "planner", phase: "finished", copyTaskCount: 88, imageSlotCount: 28 });
      options.onEvent({ stage: "skills", phase: "started" });
      options.onEvent({ stage: "copy_skill", phase: "started", targetCount: 88 });
      options.onEvent({ stage: "image_skill", phase: "started", slotCount: 28 });
      options.onEvent({ stage: "capability", capabilityId: "copy_task_progress", phase: "task_progress", completedTasks: 41, totalTasks: 88 });
      options.onEvent({ stage: "capability", capabilityId: "image_slot_progress", phase: "slot_progress", completedSlots: 1, totalSlots: 28 });
      options.onEvent({ stage: "capability", capabilityId: "visual_judgment", phase: "finished", status: "success" });
      await runnerPaused;
      options.onEvent({ stage: "skills", phase: "finished", status: "success" });
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
    headers: { "content-type": "application/json", "x-agent-local-user": "simple-server-test" },
    body: JSON.stringify({ facts: { destination: "肯尼亚", days: [{ day: 1 }] }, report: { workbookName: "fixture.xlsx" }, sourceName: "fixture.xlsx" }),
  });
  const created = await response.json();
  assert.equal(response.status, 202);
  assert.equal(created.flowKind, "simple_skill_v1");
  assert.ok(created.projectId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.projectId, created.projectId);
  assert.equal(received.sourceData.data.destination, "肯尼亚");
  assert.equal(received.copyOptions.researchApiKey, "search-key");
  assert.equal(received.copyOptions.researchBaseUrl, "https://search.example/v1");
  assert.equal(received.copyOptions.researchModel, "facts-search-model");
  assert.equal(runtime.simpleJobs.get(created.projectId).stageStates.image_skill, "running", "单个视觉能力结束不能把整个图片阶段标成完成");
  assert.equal(runtime.simpleJobs.get(created.projectId).progress, 29, "百分比应由 Copy/Image 的真实完成数联合计算");
  assert.deepEqual(runtime.simpleJobs.get(created.projectId).copyTaskProgress, { completed: 41, total: 88 });
  assert.deepEqual(runtime.simpleJobs.get(created.projectId).imageSlotProgress, { completed: 1, total: 28 });
  releaseRunner();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.simpleJobs.get(created.projectId).status, "complete");
});

test("取消 Simple 生成后保持已停止且迟到的完成结果不能覆盖终态", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-server-cancel-"));
  const simpleStore = new AgentPlanStore(path.join(root, "projects"));
  let releaseRunner;
  const paused = new Promise((resolve) => { releaseRunner = resolve; });
  const runtime = createAgentPlannerServer({
    port: 0,
    simpleStore,
    simplePipelineRunner: async (options) => {
      simpleStore.createProject({ projectId: options.projectId, flowKind: "simple_skill_v1", status: "running", currentStage: "内容制作", progress: 42, activePlanId: null, planIds: [], executionRunIds: [], activeExecutionRunId: null });
      options.onEvent({ stage: "copy_skill", phase: "started", targetCount: 10 });
      await paused;
      options.onEvent({ stage: "pipeline", phase: "finished", status: "complete" });
      return { projectId: options.projectId, pipelineStatus: "complete" };
    },
  });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { releaseRunner(); await new Promise((resolve) => runtime.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  const createdResponse = await fetch(`${url}/api/simple/projects`, { method: "POST", headers: { "content-type": "application/json", "x-agent-local-user": "simple-server-test" }, body: JSON.stringify({ facts: { destination: "肯尼亚", days: [{ day: 1 }] }, report: {}, sourceName: "cancel.xlsx" }) });
  const created = await createdResponse.json();
  await new Promise((resolve) => setImmediate(resolve));
  const cancelResponse = await fetch(`${url}/api/simple/projects/${created.projectId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
  const cancelled = await cancelResponse.json();
  assert.equal(cancelResponse.status, 202);
  assert.equal(cancelled.project.status, "cancelled");
  assert.equal(cancelled.activeJob.status, "cancelled");
  assert.equal(cancelled.activeJob.currentAction, "制作已停止");
  assert.equal(simpleStore.getProject(created.projectId).status, "cancelled");
  releaseRunner();
  await new Promise((resolve) => setImmediate(resolve));
  const finalResponse = await fetch(`${url}/api/simple/projects/${created.projectId}`);
  const finalState = await finalResponse.json();
  assert.equal(finalState.project.status, "cancelled");
  assert.equal(finalState.activeJob.status, "cancelled");
  assert.equal(finalState.result, null);
});

test("致命失败冻结真实百分比并把当前阶段标失败、后续阶段保持未执行", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-server-failure-"));
  const runtime = createAgentPlannerServer({
    port: 0,
    simpleStore: new AgentPlanStore(path.join(root, "projects")),
    simplePipelineRunner: async (options) => {
      options.onEvent({ stage: "parser", phase: "started" });
      options.onEvent({ stage: "parser", phase: "finished" });
      options.onEvent({ stage: "planner", phase: "started" });
      throw new Error("planner unavailable");
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
    headers: { "content-type": "application/json", "x-agent-local-user": "simple-server-test" },
    body: JSON.stringify({ facts: { destination: "肯尼亚", days: [{ day: 1 }] }, report: {}, sourceName: "failure.xlsx" }),
  });
  const created = await response.json();
  await new Promise((resolve) => setImmediate(resolve));
  const job = runtime.simpleJobs.get(created.projectId);
  assert.equal(job.status, "failed");
  assert.equal(job.progress, 8);
  assert.equal(job.stageStates.parser, "complete");
  assert.equal(job.stageStates.planner, "failed");
  assert.equal(job.stageStates.copy_skill, "pending");
  assert.equal(job.stageStates.image_skill, "pending");
});

test("Simple 项目确认永久删除时先终止运行且后台不会重新写回", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-pipeline-server-delete-"));
  const simpleStore = new AgentPlanStore(path.join(root, "projects"));
  let releaseRunner;
  const paused = new Promise((resolve) => { releaseRunner = resolve; });
  const runtime = createAgentPlannerServer({
    port: 0,
    simpleStore,
    simplePipelineRunner: async (options) => {
      simpleStore.createProject({ projectId: options.projectId, flowKind: "simple_skill_v1", status: "running", activePlanId: null, planIds: [], executionRunIds: [], activeExecutionRunId: null });
      options.onEvent({ stage: "parser", phase: "started" });
      await paused;
      options.onEvent({ stage: "parser", phase: "finished" });
      return { projectId: options.projectId, pipelineStatus: "complete" };
    },
  });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    releaseRunner();
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const port = runtime.server.address().port;
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/simple/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-local-user": "simple-server-test" },
    body: JSON.stringify({ facts: { destination: "测试", days: [{ day: 1 }] }, report: {}, sourceName: "delete.xlsx" }),
  });
  const created = await createdResponse.json();
  await new Promise((resolve) => setImmediate(resolve));
  const runningDelete = await fetch(`http://127.0.0.1:${port}/api/simple/projects/${created.projectId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
  assert.equal(runningDelete.status, 200);
  assert.equal(runtime.simpleControllers.has(created.projectId), false);
  const afterDelete = await fetch(`http://127.0.0.1:${port}/api/simple/projects/${created.projectId}`);
  assert.equal(afterDelete.status, 404);
  releaseRunner();
  await new Promise((resolve) => setImmediate(resolve));
  const afterRefresh = await fetch(`http://127.0.0.1:${port}/api/simple/projects/${created.projectId}`);
  assert.equal(afterRefresh.status, 404);
  assert.equal(simpleStore.getProject(created.projectId), null);
});
