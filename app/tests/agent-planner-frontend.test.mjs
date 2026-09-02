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

test("生成步骤预留真实事件总览并把计划技术信息默认折叠", () => {
  const generation = workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview"));
  assert.match(generation, /PlanView project=\{agentProject\} plan=\{plan\}/);
  assert.match(workspace, /资料检查[\s\S]+智能规划[\s\S]+事实核验[\s\S]+文案生成[\s\S]+图片准备[\s\S]+审核排版[\s\S]+成品检查/);
  assert.match(workspace, /runByTaskId/);
  assert.match(workspace, /aria-valuenow=\{progress\.percent\}/);
  assert.match(generation, /查看本次规划 \/ 技术详情/);
  assert.match(generation, /次下游调用/);
  assert.doesNotMatch(generation, /mini-itinerary|当前项目/);
  assert.match(workspace, /!agentMode && screen === "editor"/);
  assert.match(workspace, /!agentMode && screen === "versions"/);
});

test("等待确认保留在生成页并从当前任务继续", () => {
  assert.match(workspace, /agent-runtime-confirm/);
  assert.match(workspace, /保存选择并从当前任务继续/);
  assert.match(workspace, /waiting \? "需要你的确认"/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview")), /返回处理确认/);
});
