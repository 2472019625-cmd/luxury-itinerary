import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
const diagnostic = readFileSync(new URL("../src/AgentWorkspace.jsx", import.meta.url), "utf8");

test("4174正式入口复用原Workspace五步前端而非简化项目页", () => {
  assert.match(app, /<Workspace[^>]+agentMode=/);
  assert.match(workspace, /上传资料[\s\S]+确认信息[\s\S]+生成内容[\s\S]+编辑预览[\s\S]+下载版本/);
  assert.match(app, /agent-diagnostics/);
  assert.match(diagnostic, /智能体内部诊断/);
});

test("智能体浏览器存储使用独立命名空间且首批项目不显示删除入口", () => {
  assert.match(workspace, /sheyou-agent-users-v1/);
  assert.match(workspace, /sheyou-agent-session-v1/);
  assert.match(workspace, /sheyou-agent-projects-v1/);
  assert.match(workspace, /onDelete=\{agentMode \? undefined : setDeleteProject\}/);
});

test("生成步骤读取同一activePlan并在能力关闭时锁定编辑与下载", () => {
  const generation = workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview"));
  assert.match(generation, /PlanView project=\{agentProject\} plan=\{plan\}/);
  assert.match(generation, /计划任务/);
  assert.match(generation, /下游能力调用/);
  assert.match(generation, /编辑预览尚未开放/);
  assert.match(generation, /下载版本尚未开放/);
  assert.doesNotMatch(generation, /overall-progress|aria-valuenow|100%/);
  assert.match(workspace, /!agentMode && screen === "editor"/);
  assert.match(workspace, /!agentMode && screen === "versions"/);
});

test("等待确认保留在生成页并从当前任务继续", () => {
  assert.match(workspace, /agent-runtime-confirm/);
  assert.match(workspace, /保存选择并从当前任务继续/);
  assert.match(workspace, /waiting \? "等待确认"/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview")), /返回处理确认/);
});
