import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentPlannerServer } from "../server/agent-planner-app.mjs";
import { AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";

test("独立服务硬拒绝4173且不暴露旧生成端点", async () => {
  assert.throws(() => createAgentPlannerServer({ port: 4173, workspaceRoot: mkdtempSync(path.join(tmpdir(), "agent-http-forbidden-")) }), /禁止使用/);
  const { server } = createAgentPlannerServer({ port: 0, workspaceRoot: mkdtempSync(path.join(tmpdir(), "agent-http-")), modelConfig: { apiKey: "test" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/api/agent/health`)).json();
    assert.equal(health.executionEnabled, true);
    assert.equal(health.flowKind, "agent_v1");
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(forbidden.status, 404);
    assert.match((await forbidden.json()).error, /未提供该能力/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("缺失费用边界时只创建等待确认项目且不调用规划器", async () => {
  let plannerCalls = 0;
  const { server } = createAgentPlannerServer({ port:0, workspaceRoot:mkdtempSync(path.join(tmpdir(),"agent-confirm-")), modelConfig:{apiKey:"test"}, planner:async()=>{plannerCalls+=1;} });
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve)); const port=server.address().port;
  try {
    const response=await fetch(`http://127.0.0.1:${port}/api/agent/projects`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({facts:{destination:"肯尼亚",days:[{route:"内罗毕—保护区"}]},report:{workbookName:"fresh-conflict.xlsx",warnings:["费用包含字段缺失，将阻止生成"]}})});
    const created=await response.json();
    assert.equal(created.status,"awaiting_confirmation");
    assert.equal(plannerCalls,0);
    const project=await (await fetch(`http://127.0.0.1:${port}/api/agent/projects/${created.projectId}`)).json();
    assert.equal(project.confirmations.length,1);
    assert.equal(project.plan,null);
  } finally { await new Promise((resolve)=>server.close(resolve)); }
});

test("执行端点创建计划级授权运行并异步启动", async () => {
  const executor = { execute: async (_projectId, run) => run };
  const { server,store }=createAgentPlannerServer({port:0,workspaceRoot:mkdtempSync(path.join(tmpdir(),"agent-exec-http-")),modelConfig:{apiKey:"test"},executor});
  store.createProject({projectId:"p1",flowKind:"agent_v1",executionEnabled:false,status:"planning",activePlanId:null,planIds:[],executionRunIds:[],inputFingerprint:"fp"});
  store.saveSourceData("p1",{facts:{destination:"肯尼亚",days:[{id:"d1",spots:[]}]}});
  store.activatePlan("p1",{planId:"plan1",inputFingerprint:"fp",status:"plan_only",executionEnabled:false,ruleProfileVersion:AGENT_RULE_PROFILE_VERSION,capabilityConfigVersion:AGENT_CAPABILITY_VERSION,tasks:[{taskId:"task1",taskType:"source_intake",capabilityIds:["source_parser"],dependsOn:[],parallelGroup:"P1"}],capabilityCallStats:[]});
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve)); const port=server.address().port;
  try {
    const response=await fetch(`http://127.0.0.1:${port}/api/agent/projects/p1/execution-runs`,{method:"POST"}); const value=await response.json();
    assert.equal(response.status,202); assert.equal(value.executionRun.planId,"plan1"); assert.equal(value.executionRun.executionEnabled,true); assert.equal(value.executionRun.authorization.planId,"plan1");
  } finally { await new Promise((resolve)=>server.close(resolve)); }
});
