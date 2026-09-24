import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
const diagnostic = readFileSync(new URL("../src/AgentWorkspace.jsx", import.meta.url), "utf8");
const workspaceCss = readFileSync(new URL("../src/workspace.css", import.meta.url), "utf8");
const confirmationActions = readFileSync(new URL("../src/lib/confirmationActionItems.js", import.meta.url), "utf8");

test("Step4预览缩放仅作用于编辑器，结构栏默认展开且体验卡可收起", () => {
  assert.match(workspace, /setStructureExpanded\] = useState\(\(\) => window\.innerWidth > 900\)/);
  assert.match(workspace, /setFitPreviewZoom\(Math\.min\(0\.4, Math\.max\(0\.15,/);
  assert.match(workspace, /aria-label="预览缩放"/);
  assert.match(workspace, /aria-label="预览适合宽度"/);
  assert.match(workspace, /selection\.slotId === slot\.slotId && collapsedDaySlotId !== slot\.slotId/);
  assert.match(workspace, /setCollapsedDaySlotId\(slot\.slotId\)/);
  assert.match(workspaceCss, /\.editor-grid \.workspace-itinerary \.export-frame \{ zoom: var\(--preview-zoom, \.4\); \}/);
  assert.doesNotMatch(workspaceCss, /^\.workspace-itinerary \.export-frame \{ zoom: var\(--preview-zoom/m);
});

test("4174正式入口复用原Workspace五步前端而非简化项目页", () => {
  assert.match(app, /<Workspace[^>]+agentMode=/);
  assert.match(workspace, /上传资料[\s\S]+确认信息[\s\S]+生成内容[\s\S]+编辑预览[\s\S]+下载版本/);
  assert.match(app, /agent-diagnostics[\s\S]+window\.location\.replace\("\/agent"\)/);
  assert.match(app, /window\.location\.pathname === "\/"[\s\S]{0,180}window\.location\.replace\("\/agent"\)/);
  assert.match(app, /params\.get\("templatePreview"\) !== "1"/);
  assert.match(app, /!exportMode/);
  assert.match(diagnostic, /function SimpleManualImagePage/);
  assert.doesNotMatch(diagnostic, /智能体内部诊断|管理员/);
});

test("登录与创建账号的凭据输入可手动显示和隐藏", () => {
  const auth = workspace.slice(workspace.indexOf("export function AuthScreen"), workspace.indexOf("export function AppHeader"));
  assert.match(auth, /type=\{showPin \? "text" : "password"\}/);
  assert.match(auth, /type="button" aria-label=\{showPin \? "隐藏密码" : "显示密码"\}/);
  assert.match(auth, /aria-pressed=\{showPin\}/);
  assert.match(auth, /setShowPin\(false\)/);
  assert.match(workspaceCss, /\.auth-secret-toggle \{[^}]*width: 44px; height: 44px;/);
});

test("智能体项目以服务端为准且项目管理形成30天回收站闭环", () => {
  assert.match(workspace, /sheyou-agent-users-v1/);
  assert.match(workspace, /sheyou-agent-session-v1/);
  assert.match(workspace, /sheyou-agent-projects-v1/);
  assert.match(workspace, /onTrash=\{agentMode \? setTrashProject : undefined\}/);
  assert.match(workspace, /onRestore=\{agentMode \? restoreProject : undefined\}/);
  assert.match(workspace, /agentProjectsApi\.list\(user\)/);
  assert.match(workspace, /agentProjectsApi\.create\(user, next\)/);
  assert.match(workspace, /agentProjectsApi\.trash\(user, project\.id\)/);
  assert.match(workspace, /agentProjectsApi\.restore\(user, project\.id\)/);
  assert.match(workspace, /永久删除项目？/);
  assert.match(workspace, /清空回收站？/);
  assert.match(workspace, /agentProjectsApi\.remove\(user, project\.id\)/);
  assert.match(workspace, /项目已恢复/);
  assert.match(workspace, /项目已永久删除/);
  assert.match(workspace, /操作失败，请重试/);
  assert.match(workspace, /project-thumb-placeholder/);
  assert.match(workspace, /className="row-trash-action" title="移入回收站"/);
  assert.match(workspace, /<UiIcon name="trash" size=\{17\}/);
  assert.match(workspace, /className="workspace-recent-trash" title="移入回收站"/);
  assert.match(workspace, /<WorkspaceHome[\s\S]{0,400}onTrash=\{setTrashProject\}/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function ProjectThumbnail"), workspace.indexOf("function UploadStep")), />缺图</);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function PermanentDeleteDialog"), workspace.indexOf("export function Workspace")), /window\.(alert|confirm)/);
  assert.match(workspace, /这会停止本次制作/);
  assert.match(workspace, /回收站保留30天/);
  assert.match(workspace, /!project\.trashedAt/);
  assert.match(workspace, /本地缓存不会替代服务端数据/);
  assert.match(workspace, /project-list-\$\{displayMode\}/);
  assert.match(workspace, /trash-project-grid/);
  assert.match(workspace, /草稿编辑中/);
  assert.match(workspace, /正式版 v\$\{versionCount\}\.0/);
  assert.match(workspace, /loading="lazy" decoding="async"/);
  assert.match(workspace, /beginProjectExit/);
  assert.match(workspaceCss, /project-item-exiting/);
  assert.match(workspaceCss, /grid-template-columns:\s*repeat\(3/);
});

test("开始与重新制作绑定当前账号，启动失败留在确认弹窗并提示", () => {
  const starts = workspace.match(/fetch\("\/api\/simple\/projects", \{ method: "POST", headers: agentProjectHeaders\(user, true\)/g) || [];
  assert.equal(starts.length, 2);
  assert.match(workspace, /await onContinue\(\)/);
  assert.match(workspace, /startingGeneration \? "正在开始制作…" : "确认并开始生成"/);
  assert.match(workspace, /<ConfirmationPreview project=\{project\} \/>\{modalMessage && <p className="confirmation-modal-message" role="alert">/);
});

test("智能体工作台首页只负责开始和进入唯一项目列表", () => {
  assert.match(workspace, /function WorkspaceHome/);
  assert.match(workspace, /开始创建新行程/);
  assert.match(workspace, /projects=\{activeProjects\}/);
  assert.match(workspace, /onProjects=\{\(\) => setScreen\("list"\)\}/);
  assert.match(workspace, /onOpen=\{openProject\}/);
  assert.match(workspace, /\.sort\(\(left, right\).*updatedAt/);
  assert.match(workspace, /\.slice\(0, 3\)/);
  assert.match(workspace, /workspace-journey-route-reference\.png/);
  assert.match(workspace, /最近项目/);
  assert.match(workspace, /useState\(\(\) => agentMode \? "home" : "list"\)/);
  assert.equal((workspace.match(/function ProjectList/g) || []).length, 1);
  assert.match(workspace, /<ProjectList user=\{user\} projects=\{projects\}/);
  assert.match(workspace, />打开 <span aria-hidden="true">›<\/span>/);
  assert.doesNotMatch(workspace, />打开项目 <UiIcon/);
  assert.match(workspaceCss, /\.workspace-home/);
  assert.match(workspaceCss, /grid-template-columns:\s*minmax\(360px, \.43fr\) minmax\(0, \.57fr\)/);
  assert.match(workspaceCss, /\.workspace-recent-grid/);
});

test("Simple项目直达编辑页复用全局工作台Header", () => {
  assert.match(workspace, /export function AppHeader/);
  assert.match(diagnostic, /<div className="workspace-shell workspace-agent-mode"><AppHeader/);
  assert.match(diagnostic, /localStorage\.removeItem\(AGENT_STORAGE\.session\)/);
  const desktopNarrow = workspaceCss.slice(workspaceCss.indexOf("@media (max-width: 1180px)"), workspaceCss.indexOf("@media (max-width: 900px)"));
  assert.doesNotMatch(desktopNarrow, /header-brand span[^}]+display:\s*none/);
});

test("Step4人工换图允许未自动采用候选且结果提示自动消失", () => {
  const picker = workspace.slice(workspace.indexOf("function ImagePickerModal"), workspace.indexOf("export function Editor"));
  const editor = workspace.slice(workspace.indexOf("export function Editor"), workspace.indexOf("export function VersionsStep"));
  assert.match(picker, /canManuallyChooseImageCandidate\(candidate\)/);
  assert.match(picker, /manualConfirmed:\s*true/);
  assert.match(picker, /可人工确认采用/);
  assert.doesNotMatch(picker, /不适合当前位置/);
  assert.match(editor, /setTimeout\(\(\) => setImageMessage/);
  assert.match(editor, /2800/);
  assert.match(editor, /if \(saved\) setPickerOpen\(false\)/);
});

test("编辑页以紧凑结构栏和右侧待处理视图替代底部重复提示", () => {
  const editor = workspace.slice(workspace.indexOf("export function Editor"), workspace.indexOf("export function VersionsStep"));
  assert.match(editor, /structure-compact/);
  assert.match(editor, /editor-issues-trigger/);
  assert.match(editor, /editor-issues-view/);
  assert.match(editor, /setFinalIssuesOpen\(false\);[\s\S]{0,500}selectBlockingImage\(item\)/);
  assert.match(editor, /setDayInfoOpen\(true\)/);
  assert.match(editor, /pendingIssueFocusRef/);
  assert.doesNotMatch(editor, /正式下载还差|可编辑草稿已生成|className=\{`editor-final-step/);
  assert.match(workspaceCss, /\.editor-grid\.structure-compact/);
  assert.match(workspaceCss, /\.inspector-issues-open > \.inspector-body/);
});

test("编辑器将预订流程与资金安全提醒拆为独立显示模块", () => {
  assert.match(workspace, /\{ id: "booking", label: "预订流程" \},\s*\{ id: "security", label: "资金安全提醒" \}/);
  const visibility = workspace.slice(workspace.indexOf("function visibilityData"), workspace.indexOf("function versionSnapshot"));
  assert.match(visibility, /visibility\.booking === false\) next\.showBookingSection = false/);
  assert.match(visibility, /visibility\.security === false\) next\.showSecuritySection = false/);
  assert.doesNotMatch(visibility, /visibility\.booking === false[^\n]+showSecuritySection/);
  assert.match(workspace, /预订流程为品牌固定内容，可独立控制是否进入正式版本/);
  assert.match(workspace, /资金安全提醒与其付款区域连续展示，可独立于预订流程显示或隐藏/);
});

test("酒店结构化事实同时进入最终展示和Step4编辑，并兼容旧项目文案", () => {
  assert.match(app, /hotel\.factRows/);
  assert.match(app, /className="hotel-fact-rows"/);
  assert.match(app, /factRows\.length > 0[\s\S]{0,700}hotel\.editorialCopy/);
  assert.match(workspace, /HOTEL_FACT_ROW_DEFINITIONS[\s\S]{0,220}location[\s\S]{0,220}rooms[\s\S]{0,220}design[\s\S]{0,220}facilities/);
  assert.match(workspace, /酒店展示信息/);
  assert.match(workspace, /updateHotelFactRow\(next\.hotels\[selection\.itemIndex\]/);
  assert.match(workspace, /showLegacyHotelCopy[\s\S]{0,1500}旧项目兼容内容/);
});

test("生成步骤只展示定制师可理解的状态且不暴露技术运行信息", () => {
  const generation = workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview"));
  assert.match(workspace, /SIMPLE_DESIGNER_STAGES/);
  assert.match(workspace, /run\.progress\.stages/);
  assert.match(workspace, /aria-valuenow=\{safeProgress\}/);
  assert.doesNotMatch(generation, /本次定制摘要|已按你的确认制作|本次定制重点|确认信息优先/);
  assert.match(generation, /<AgentProgressOverview snapshot=\{snapshot\}/);
  assert.doesNotMatch(generation, /请勿重复生成|后台可能仍在运行/);
  assert.doesNotMatch(generation, /管理员运行详情|projectId|executionRunId|次下游调用|当前内部动作/);
  assert.doesNotMatch(generation, /mini-itinerary|当前项目/);
  assert.match(workspace, /screen === "editor" && currentProject/);
  assert.match(workspace, /existingOnly=\{agentMode\}/);
  assert.match(workspace, /ready_for_editor/);
  assert.doesNotMatch(generation, /查看确认信息|onReview/);
});

test("产品前端只有定制师角色且确认页不展示技术警告", () => {
  const confirm = workspace.slice(workspace.indexOf("function ConfirmStep"), workspace.indexOf("function GenerationStep"));
  assert.doesNotMatch(workspace, /function AdminPanel|user\.isAdmin|首位注册用户将自动成为管理员/);
  assert.match(workspace, /<small>定制师<\/small>/);
  assert.doesNotMatch(confirm, /recognition\?\.warnings|内部信息已隔离|schema|slot|pipeline/i);
  assert.match(workspace, /行程关键信息已确认完整/);
  assert.match(confirm, /buildConfirmationActionItems/);
  assert.match(confirm, /if \(pending\.length\) return setModalMessage/);
  assert.match(confirm, /确认并开始生成/);
  assert.match(confirmationActions, /field:startDate/);
  assert.match(confirmationActions, /field:endDate/);
  assert.match(confirmationActions, /field:adults/);
  assert.match(confirmationActions, /source:multiPricePeriod/);
  assert.match(confirmationActions, /原报价包含 \$\{price\.count\} 个价格档期/);
  assert.match(workspace, /selection\?\.mode === "custom"/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function PriceOfferConfirmation"), workspace.indexOf("function ConfirmationPreview")), /适用档期/);
});

test("上传识别成功后自动进入确认页且不再展示重复统计", () => {
  const upload = workspace.slice(workspace.indexOf("function UploadStep"), workspace.indexOf("function AgentConfirmationPanel"));
  assert.doesNotMatch(upload, /recognition-strip|内部信息已隔离/);
  assert.match(upload, /await onFiles\(\[workbook\], recognition, sourceSha256\);\s*onContinue\(\);/);
  assert.doesNotMatch(upload, />确认识别结果</);
  assert.match(workspace, /className="recognition-overview"/);
});

test("确认页展示、实时表单和继续门禁共用同一 actionItems 派生", () => {
  const confirm = workspace.slice(workspace.indexOf("function ConfirmStep"), workspace.indexOf("function GenerationStep"));
  const continuation = workspace.slice(workspace.indexOf("const continueAgent"), workspace.indexOf("const retryAgentImage"));
  assert.match(confirm, /<ConfirmationStatus actionItems=\{actionItems\}/);
  assert.doesNotMatch(confirm, /ConfirmationActionList|需要你确认/);
  assert.match(confirm, /onChange=\{\(event\) => update\("startDate"/);
  assert.match(confirm, /onChange=\{\(event\) => update\("endDate"/);
  assert.match(confirm, /update\("adults"/);
  assert.match(confirm, /childrenConfirmed \? data\.children : ""/);
  assert.match(confirmationActions, /field:children/);
  assert.match(continuation, /buildConfirmationActionItems/);
  assert.match(continuation, /if \(actionItems\.length > 0\)/);
});

test("客户行程制作进度使用单列卡并保留真实子任务状态", () => {
  const progressView = workspace.slice(workspace.indexOf("function AgentProgressOverview"), workspace.indexOf("function AgentGenerationStep"));
  const progressCss = workspaceCss.slice(workspaceCss.indexOf(".agent-progress-overview"), workspaceCss.indexOf(".agent-stage-banner"));
  assert.match(progressView, /客户行程制作进度/);
  assert.match(progressView, /已用时/);
  assert.match(progressView, /正在重新连接/);
  assert.match(progressView, /最后同步/);
  assert.match(progressView, /当前显示最近一次同步进度/);
  assert.match(progressView, /进度暂时未更新，我们会自动继续尝试/);
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
  assert.match(generation, /display\.cancelled \? "制作已停止"/);
  assert.match(generation, /未完成内容不会进入编辑页；已确认的资料仍会保留/);
  assert.match(generation, /failed:\s*"失败"/);
  assert.match(generation, /pending:\s*display\.failed \|\| display\.cancelled \? "未执行"/);
  assert.match(generation, /agentFailurePresentation/);
  assert.match(workspaceCss, /\.agent-workspace-generation[^}]+display:\s*flex[^}]+flex-direction:\s*column/);
  assert.match(workspaceCss, /\.agent-progress-overview[^}]+min-height:\s*clamp\(440px,calc\(100dvh - 340px\),620px\)/);
  assert.match(workspaceCss, /\.agent-progress-overview ol[^}]+flex:\s*1/);
  assert.match(workspaceCss, /\.agent-workspace-generation > \.generation-footer[^}]+margin:\s*-8px 5vw 24px[^}]+border-top:\s*0[^}]+background:\s*transparent/);
});

test("取消生成停留在进度页、冻结本地项目且不开放编辑入口", () => {
  const generation = workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview"));
  const cancellation = workspace.slice(workspace.indexOf("const cancelAgent"), workspace.indexOf("const createProject"));
  const polling = workspace.slice(workspace.indexOf("const cancellationLocked"), workspace.indexOf("const commitProjects"));
  assert.match(workspace, /stage === "cancelled"[^\n]+label: "已停止"/);
  assert.match(generation, /const canEdit = ready \|\| draft/);
  assert.match(generation, /const canCancel = !waiting && !canEdit && !cancelled && !failed/);
  assert.match(generation, /<StepRail active=\{2\} stopped=\{cancelled\}/);
  assert.match(workspace, /state === "stopped" \? "本次制作已停止"/);
  assert.doesNotMatch(generation, /查看确认信息|onReview/);
  assert.match(cancellation, /workflowStage: "cancelled"/);
  assert.match(cancellation, /setScreen\("generate"\)/);
  assert.match(polling, /currentProject\.workflowStage === "cancelled"/);
  assert.match(polling, /cancelledAgentIdsRef\.current\.has/);
});

test("非首页提供明确返回入口且返回首页不会取消后台制作", () => {
  const strip = workspace.slice(workspace.indexOf("export function AgentModeStrip"), workspace.indexOf("function projectStatusLabel"));
  const render = workspace.slice(workspace.indexOf("const activeProjects"));
  assert.match(strip, /agent-home-return/);
  assert.match(strip, /name="return"/);
  assert.match(strip, /返回首页/);
  assert.match(render, /<AgentModeStrip showHome=\{screen !== "home"\} onHome=\{goHome\}/);
  assert.match(workspace, /const goHome = async \(\) =>[\s\S]*?flushAgentSave\(currentProject\)/);
  assert.match(diagnostic, /<AgentModeStrip showHome onHome=\{goHome\}/);
  assert.doesNotMatch(strip, /\/cancel|cancelAgent/);
});

test("停止或失败后在同一业务项目下创建新制作批次并保留旧批次", () => {
  const generation = workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview"));
  const restart = workspace.slice(workspace.indexOf("const restartAgent"), workspace.indexOf("const createProject"));
  const deletion = workspace.slice(workspace.indexOf("const permanentlyDeleteProjects"), workspace.indexOf("const updateProject"));
  assert.match(generation, /cancelled \|\| failed/);
  assert.match(generation, /重新制作/);
  assert.match(generation, /重新尝试/);
  assert.match(workspace, /function RestartGenerationDialog/);
  assert.match(workspace, /系统会按当前确认的信息重新开始制作/);
  assert.match(workspace, /之前的制作记录会保留，已经完成的处理不会撤销/);
  assert.match(restart, /fetch\("\/api\/simple\/projects"/);
  assert.match(restart, /generationAttempts/);
  assert.match(restart, /agentProjectId: currentProject\.agentProjectId/);
  assert.match(restart, /agentProjectId: created\.projectId, workflowStage: "simple-running"/);
  assert.doesNotMatch(restart, /commitProjects\(\[|uid\("project"\)/);
  const backend = readFileSync(new URL("../server/agent-planner-app.mjs", import.meta.url), "utf8");
  assert.match(backend, /project\.generationAttempts/);
  assert.match(backend, /purgeAssociatedData/);
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
  assert.match(workspace, /waiting && <section className="agent-generation-support"/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("function AgentGenerationStep"), workspace.indexOf("function CandidatePreview")), /返回处理确认/);
});
