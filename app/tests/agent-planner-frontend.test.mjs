import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
const diagnostic = readFileSync(new URL("../src/AgentWorkspace.jsx", import.meta.url), "utf8");
const workspaceCss = readFileSync(new URL("../src/workspace.css", import.meta.url), "utf8");

test("4174正式入口复用原Workspace五步前端而非简化项目页", () => {
  assert.match(app, /<Workspace[^>]+agentMode=/);
  assert.match(workspace, /上传资料[\s\S]+确认信息[\s\S]+生成内容[\s\S]+编辑预览[\s\S]+下载版本/);
  assert.match(app, /agent-diagnostics/);
  assert.match(diagnostic, /智能体内部诊断/);
});

test("智能体浏览器存储使用独立命名空间且项目管理形成回收站闭环", () => {
  assert.match(workspace, /sheyou-agent-users-v1/);
  assert.match(workspace, /sheyou-agent-session-v1/);
  assert.match(workspace, /sheyou-agent-projects-v1/);
  assert.match(workspace, /onTrash=\{agentMode \? setTrashProject : undefined\}/);
  assert.match(workspace, /onRestore=\{agentMode \? restoreProject : undefined\}/);
  assert.match(workspace, /trashedAt: Date\.now\(\)/);
  assert.match(workspace, /trashedAt: null/);
  assert.match(workspace, /永久删除项目？/);
  assert.match(workspace, /清空回收站？/);
  assert.match(workspace, /method: "DELETE"/);
  assert.match(workspace, /项目已恢复/);
  assert.match(workspace, /项目已永久删除/);
  assert.match(workspace, /操作失败，请重试/);
  assert.match(workspace, /project-thumb-placeholder/);
  assert.match(workspace, /className="row-trash-action" title="移入回收站"/);
  assert.match(workspace, /<UiIcon name="trash" size=\{17\}/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function ProjectThumbnail"), workspace.indexOf("function UploadStep")), />缺图</);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function PermanentDeleteDialog"), workspace.indexOf("export function Workspace")), /window\.(alert|confirm)/);
  assert.match(workspace, /项目、原始资料、运行记录和成品都会完整保留/);
  assert.match(workspace, /正在执行的生成任务不会因此取消/);
  assert.match(workspace, /!project\.trashedAt/);
  assert.match(workspace, /writeStorage\(storageKeys\.projects, next\); setProjects\(next\)/);
  assert.match(workspace, /project-list-\$\{displayMode\}/);
  assert.match(workspace, /trash-project-grid/);
  assert.match(workspace, /草稿编辑中/);
  assert.match(workspace, /正式版 v\$\{versionCount\}\.0/);
  assert.match(workspace, /loading="lazy" decoding="async"/);
  assert.match(workspace, /beginProjectExit/);
  assert.match(workspaceCss, /project-item-exiting/);
  assert.match(workspaceCss, /grid-template-columns:\s*repeat\(3/);
});

test("Simple项目直达编辑页复用全局工作台Header", () => {
  assert.match(workspace, /export function AppHeader/);
  assert.match(diagnostic, /<div className="workspace-shell workspace-agent-mode"><AppHeader/);
  assert.match(diagnostic, /localStorage\.removeItem\(AGENT_STORAGE\.session\)/);
  const desktopNarrow = workspaceCss.slice(workspaceCss.indexOf("@media (max-width: 1180px)"), workspaceCss.indexOf("@media (max-width: 900px)"));
  assert.doesNotMatch(desktopNarrow, /header-brand span[^}]+display:\s*none/);
});

test("生成步骤默认使用定制师视角并把管理员运行信息折叠", () => {
  const generation = workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview"));
  assert.match(generation, /PlanView project=\{agentProject\} plan=\{plan\}/);
  assert.match(workspace, /SIMPLE_DESIGNER_STAGES/);
  assert.match(workspace, /run\.progress\.stages/);
  assert.match(workspace, /run\?\.events\?\.at\(-1\)/);
  assert.match(workspace, /aria-valuenow=\{safeProgress\}/);
  assert.match(generation, /本次定制摘要/);
  assert.match(generation, /已按你的确认制作/);
  assert.match(generation, /本次定制重点/);
  assert.match(generation, /管理员运行详情/);
  assert.doesNotMatch(generation, /<details[^>]+open/);
  assert.match(generation, /次下游调用/);
  assert.doesNotMatch(generation, /mini-itinerary|当前项目/);
  assert.match(workspace, /screen === "editor" && currentProject/);
  assert.match(workspace, /existingOnly=\{agentMode\}/);
  assert.match(workspace, /ready_for_editor/);
});

test("客户行程制作进度使用单列卡并保留真实子任务状态", () => {
  const progressView = workspace.slice(workspace.indexOf("function AgentProgressOverview"), workspace.indexOf("function AgentGenerationStep"));
  const progressCss = workspaceCss.slice(workspaceCss.indexOf(".agent-progress-overview"), workspaceCss.indexOf(".agent-stage-banner"));
  assert.match(progressView, /客户行程制作进度/);
  assert.match(progressView, /已用时/);
  assert.match(progressView, /getDesignerCurrentAction\(snapshot\)/);
  assert.match(progressView, /客户文案已整理完成/);
  assert.match(progressView, /已完成.*个图片位/);
  assert.match(progressView, /图片会逐张核对地点、主体和清晰度/);
  assert.match(progressView, /content_creation/);
  assert.match(progressView, /agent-progress-headline/);
  assert.match(progressView, /agent-progress-route/);
  assert.match(progressView, /agent-progress-mascot/);
  assert.match(progressView, /style=\{\{ left: `\$\{mascotProgress\}%` \}\}/);
  assert.match(progressView, /useAnimatedProgress\(safeProgress/);
  assert.match(progressView, /width: `\$\{animatedRouteProgress\}%`/);
  assert.match(progressView, /mascotProgress = animatedRouteProgress/);
  assert.match(progressView, /stage\.routePosition/);
  assert.match(workspace, /valueRef\.current \+= direction/);
  assert.match(workspace, /now - lastStepAt >= 80/);
  assert.match(progressView, /progress\.stages\.map/);
  assert.doesNotMatch(progressView, /setInterval|setTimeout|Math\.random/);
  assert.doesNotMatch(progressView, /<footer>/);
  assert.doesNotMatch(progressCss, /grid-template-columns:\s*minmax\(240px/);
  assert.match(progressCss, /border-radius:\s*12px/);
  assert.match(progressCss, /left \.68s cubic-bezier\(\.22,\.61,\.36,1\)/);
  assert.match(progressCss, /agent-progress-mascot-body[^}]+transform:\s*scaleX\(-1\)/);
  assert.match(progressCss, /agent-progress-route-node-complete i::after/);
  assert.match(progressCss, /agent-progress-route-node-active i::after/);
  assert.match(progressCss, /agent-list-pulse/);
  assert.match(workspaceCss, /prefers-reduced-motion/);
});

test("生成页全宽对齐并明确区分运行完成和终止状态", () => {
  const generation = workspace.slice(workspace.indexOf("function AgentProgressOverview"), workspace.indexOf("function CandidatePreview"));
  assert.match(generation, /display\.failed \? "本次生成已停止"/);
  assert.match(generation, /display\.completed \? "生成完成"/);
  assert.match(generation, /failed:\s*"失败"/);
  assert.match(generation, /pending:\s*display\.failed \? "未执行"/);
  assert.match(generation, /agentFailurePresentation/);
  assert.match(workspaceCss, /\.agent-workspace-generation \.generation-main[^}]+padding-right:\s*5vw[^}]+padding-left:\s*5vw/);
  assert.match(workspaceCss, /\.agent-designer-summary > header \{ max-width:\s*none/);
  assert.match(workspaceCss, /\.agent-fact-assurance[^}]+max-width:\s*none/);
  assert.match(workspaceCss, /\.agent-custom-priorities[^}]+max-width:\s*none/);
});

test("终止态保留品牌进度并只局部提示失败", () => {
  const progressView = workspace.slice(workspace.indexOf("function AgentProgressOverview"), workspace.indexOf("function AgentGenerationStep"));
  const progressCss = workspaceCss.slice(workspaceCss.indexOf(".agent-progress-overview"), workspaceCss.indexOf(".agent-stage-banner"));
  assert.match(progressView, /display\.failed \? "本次生成已停止"/);
  assert.match(progressView, /agent-progress-stop-tag/);
  assert.match(progressView, /后续步骤未继续执行/);
  assert.match(progressView, /mascotProgress = animatedRouteProgress/);
  assert.doesNotMatch(progressView, /failedStageIndex/);
  assert.match(progressCss, /agent-progress-route-failed \.agent-progress-mascot-body[^}]+agent-mascot-idle/);
  assert.match(progressCss, /agent-progress-route-node-failed i[^}]+border-color:\s*#b65a4d/);
  assert.match(progressCss, /li\.agent-progress-failed[^}]+linear-gradient/);
  assert.doesNotMatch(progressCss, /agent-progress-card-failed \.agent-progress-route-track span[^}]+background:\s*var\(--ws-danger\)/);
});

test("等待确认保留在生成页并从当前任务继续", () => {
  assert.match(workspace, /agent-runtime-confirm/);
  assert.match(workspace, /保存选择并从当前任务继续/);
  assert.match(workspace, /waiting \? `「\$\{tripTitle\}」需要你的确认`/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview")), /返回处理确认/);
});
