import React, { useEffect, useMemo, useRef, useState } from "react";
import { addDays, isUsableFinalImageSource, mapDaysFromStart, removeExperienceReferences, synchronizeExperienceStatus, validateItineraryFacts } from "./lib/itineraryRules.js";
import { applyImageToSlot, IMAGE_REVIEW_STATE, pendingImageReviewSlots } from "./lib/imageReviewPolicy.js";
import { buildLayoutImageSlots, getSlotImage, listImagePlacements, moveImageToSlot, setSlotImage } from "./lib/imageSlots.js";
import { safeWriteStorage } from './lib/storageSafety.js';
import { recordImageDecision } from './lib/imageDecisions.js';
import { humanReviewReady, recordHumanReview } from './lib/humanReview.js';
import { collectCopyIssues, copyExportEligibility, generationStateLabel, groupCopyIssueTargets, groupCopyIssues } from './lib/copyIssuePresentation.js';
import { normalizeLegacyNotesForDisplay } from './lib/notesSchema.js';
import { PlanView } from "./AgentPlanner.jsx";

const STORAGE_USERS = "sheyou-workspace-users-v1";
const STORAGE_SESSION = "sheyou-workspace-session-v1";
const STORAGE_PROJECTS = "sheyou-workspace-projects-v1";
const AGENT_STORAGE = { users: "sheyou-agent-users-v1", session: "sheyou-agent-session-v1", projects: "sheyou-agent-projects-v1" };
const FIXED_STORAGE = { users: STORAGE_USERS, session: STORAGE_SESSION, projects: STORAGE_PROJECTS };
const DEFAULT_INVITE = import.meta.env.VITE_COMPANY_INVITE_CODE || "SHEYOU2026";

const STEPS = [
  ["上传资料", "上传文档与素材"],
  ["确认信息", "确认基础信息与偏好"],
  ["生成内容", "AI 解析与内容生成"],
  ["编辑预览", "调整内容与版式"],
  ["下载版本", "导出与分享"],
];

const MODULES = [
  { id: "cover", label: "封面", required: true },
  { id: "highlights", label: "产品亮点" },
  { id: "overview", label: "行程总览" },
  { id: "hotels", label: "臻选下榻" },
  { id: "dining", label: "特色餐饮" },
  { id: "transport", label: "全程交通" },
  { id: "days", label: "每日行程", required: true },
  { id: "expenses", label: "费用说明" },
  { id: "booking", label: "预订与安全" },
  { id: "notes", label: "注意事项" },
  { id: "footer", label: "品牌页尾", required: true },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  const result = safeWriteStorage(localStorage, key, value);
  if (!result.ok) {
    const error = new Error(result.message);
    error.code = result.code;
    throw error;
  }
  return result;
}

function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fileSha256(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function designerProfile(user) {
  return { name: user?.profile?.name || user?.name || "定制师名字", avatar: user?.profile?.avatar || "/assets/placeholders/avatar.png", role: user?.profile?.role || "资深定制师", bio: user?.profile?.bio || "专属定制师将与您1V1沟通，从路线节奏、酒店房型到在地体验持续跟进，\n让你的旅行 有品质 也有范儿" };
}

function UiIcon({ name, size = 18 }) {
  return <span className="ui-icon" style={{ width: size, height: size, WebkitMaskImage: `url(/assets/icons/${name}.svg)`, maskImage: `url(/assets/icons/${name}.svg)` }} aria-hidden="true" />;
}

function Button({ children, tone = "secondary", icon, className = "", ...props }) {
  return <button className={`ws-button ws-button-${tone} ${className}`} {...props}>{icon && <UiIcon name={icon} />}{children}</button>;
}

function StepRail({ active, onStep, maxStep = active }) {
  return <div className="step-rail" aria-label="行程制作进度">{STEPS.map(([title, copy], index) => {
    const state = index < active ? "complete" : index === active ? "active" : "future";
    return <button key={title} className={`step-item step-${state}`} onClick={() => onStep?.(index)} disabled={!onStep || index > maxStep}>
      <span className="step-index">{state === "complete" ? <UiIcon name="included" size={19} /> : index + 1}</span>
      <span><strong>{title}</strong><small>{copy}</small></span>
    </button>;
  })}</div>;
}

function AuthScreen({ onAuth, storageKeys = FIXED_STORAGE }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ invite: "", name: "", login: "", pin: "" });
  const [error, setError] = useState("");
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = (event) => {
    event.preventDefault();
    setError("");
    const users = readStorage(storageKeys.users, []);
    if (mode === "register") {
      if (form.invite.trim() !== DEFAULT_INVITE) return setError("公司邀请码不正确");
      if (!form.name.trim() || form.login.trim().length < 3 || !/^\d{6}$/.test(form.pin)) return setError("请完整填写姓名、登录账号和6位数字PIN");
      if (users.some((user) => user.login === form.login.trim())) return setError("该登录账号已被使用");
      const user = { id: uid("user"), name: form.name.trim(), login: form.login.trim(), pin: form.pin, isAdmin: users.length === 0, active: true };
      writeStorage(storageKeys.users, [...users, user]);
      writeStorage(storageKeys.session, { userId: user.id });
      return onAuth(user);
    }
    const user = users.find((item) => item.login === form.login.trim() && item.pin === form.pin && item.active !== false);
    if (!user) return setError("账号或PIN不正确");
    writeStorage(storageKeys.session, { userId: user.id });
    onAuth(user);
  };
  return <main className="auth-screen">
    <section className="auth-brand">
      <img src="/assets/logos/logo-gold.png" alt="奢游国际 Luxury Travel" />
      <span>ITINERARY STUDIO</span>
      <h1>把复杂行程，整理成<br />让客人期待出发的作品</h1>
      <p>资料识别、品牌文案、旅行影像与高清交付，在一个工作台里完成。</p>
    </section>
    <section className="auth-panel">
      <div className="auth-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>首次使用</button></div>
      <form onSubmit={submit}>
        <header><small>WELCOME</small><h2>{mode === "login" ? "回到我的项目" : "创建个人工作区"}</h2><p>{mode === "login" ? "使用内部账号和6位PIN登录" : "首位注册用户将自动成为管理员"}</p></header>
        {mode === "register" && <><label>公司邀请码<input value={form.invite} onChange={update("invite")} placeholder="请输入公司邀请码" /></label><label>姓名<input value={form.name} onChange={update("name")} placeholder="定制师姓名" /></label></>}
        <label>登录账号<input value={form.login} onChange={update("login")} placeholder="至少3个字符" autoComplete="username" /></label>
        <label>6位PIN<input type="password" inputMode="numeric" maxLength="6" value={form.pin} onChange={update("pin")} placeholder="••••••" autoComplete="current-password" /></label>
        {error && <p className="form-error"><UiIcon name="warning" />{error}</p>}
        <Button tone="primary" type="submit">{mode === "login" ? "进入工作台" : "创建并进入"}</Button>
        {mode === "register" && <small className="invite-tip">演示邀请码：SHEYOU2026</small>}
      </form>
    </section>
  </main>;
}

function AppHeader({ user, project, saved, canGenerate, onHome, onLogout, onAdmin, onGenerate, onProfile }) {
  return <header className="workspace-header">
    <button className="header-brand" onClick={onHome}><img src="/assets/logos/logo-gold.png" alt="奢游国际" /><span>行程创建工作台</span></button>
    {project && <div className="header-project"><strong>{project.title}</strong><button aria-label="修改项目名称"><UiIcon name="itinerary" size={16} /></button></div>}
    <div className="header-actions">
      {project && <span className={`save-state save-${saved}`}><UiIcon name={saved === "saved" ? "included" : "warning"} />{saved === "saving" ? "正在保存" : saved === "error" ? "保存失败" : "已保存"}</span>}
      {project && canGenerate && <Button tone="primary" onClick={onGenerate}>生成版本</Button>}
      {user.isAdmin && <button className="header-icon-button" onClick={onAdmin} title="管理员"><UiIcon name="people" /></button>}
      <div className="user-chip"><button className="user-profile-trigger" onClick={onProfile} title="编辑我的定制师资料">{user.profile?.avatar ? <img src={user.profile.avatar} alt={user.name} /> : <span>{user.name.slice(0, 1)}</span>}<div><strong>{user.profile?.name || user.name}</strong><small>{user.profile?.role || (user.isAdmin ? "管理员" : "定制师")}</small></div></button><button onClick={onLogout}>退出</button></div>
    </div>
  </header>;
}

function ProjectList({ user, projects, onCreate, onOpen, onDelete }) {
  const [query, setQuery] = useState("");
  const visible = projects.filter((project) => project.ownerId === user.id && `${project.title}${project.data.destination}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="projects-page">
    <header className="projects-heading"><div><small>MY JOURNEYS</small><h1>我的项目</h1><p>每一份草稿都会自动保存，正式版本可随时重新下载。</p></div><Button tone="primary" icon="itinerary" onClick={onCreate}>新建行程</Button></header>
    <div className="project-search"><UiIcon name="itinerary" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称或目的地" /></div>
    {visible.length ? <div className="project-list">{visible.map((project) => <article key={project.id} className="project-row" onClick={() => onOpen(project)}>
      <div className="project-thumb">{project.data.heroImage ? <img src={project.data.heroImage} alt="" onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.parentElement.classList.add("project-thumb-missing"); }} /> : <span>缺图</span>}</div>
      <div className="project-copy"><small>{project.data.destination || "目的地待确认"}</small><h2>{project.title}</h2><span>最后编辑 {formatTime(project.updatedAt)}</span></div>
      <div className="project-version"><strong>{project.versions?.length || 0}</strong><span>正式版本</span></div>
      {onDelete && <button className="row-delete" onClick={(event) => { event.stopPropagation(); onDelete(project); }} aria-label="删除项目">删除</button>}
      <span className="row-open">打开项目 <UiIcon name="return" size={16} /></span>
    </article>)}</div> : <div className="empty-projects"><UiIcon name="itinerary" size={42} /><h2>还没有匹配的项目</h2><p>上传原始报价表，开始第一份客户行程。</p><Button tone="primary" onClick={onCreate}>创建项目</Button></div>}
  </main>;
}

function UploadStep({ project, onFiles, onContinue }) {
  const inputRef = useRef(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const acceptFiles = async (files) => {
    const workbook = Array.from(files).find((file) => /\.(xlsx|xls)$/i.test(file.name));
    setParseError("");
    if (!workbook) {
      setParseError("请至少上传一份 Excel 报价单。第一版将以 Excel 作为行程信息主来源。");
      return;
    }
    setParsing(true);
    try {
      const { importItineraryWorkbook } = await import("./lib/itineraryImport.js");
      const [recognition, sourceSha256] = await Promise.all([importItineraryWorkbook(workbook, project.data), fileSha256(workbook)]);
      await onFiles([workbook], recognition, sourceSha256);
    } catch (error) {
      setParseError(error?.message || "报价单读取失败，请确认文件未加密且可以正常打开。");
    } finally {
      setParsing(false);
    }
  };
  return <main className="flow-page"><StepRail active={0} /><section className="flow-content flow-content-narrow">
    <header className="flow-heading"><small>STEP 01</small><h1>上传原始报价单</h1><p>上传 Excel 后系统会先在本机识别行程事实，并过滤不应展示给客人的内部信息。</p></header>
    <div className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); acceptFiles(event.dataTransfer.files); }} onClick={() => inputRef.current?.click()}>
      <UiIcon name={parsing ? "process" : "itinerary"} size={40} /><h2>{parsing ? "正在读取报价单" : "拖入文件，或点击选择"}</h2><p>{parsing ? "正在核对逐日行程、住宿、餐食、亮点与报价信息" : "当前支持一份 Excel 行程报价单（.xlsx / .xls）"}</p><Button tone="secondary" disabled={parsing}>{parsing ? "识别中…" : "选择 Excel"}</Button><input ref={inputRef} type="file" hidden accept=".xlsx,.xls" onChange={(event) => { acceptFiles(event.target.files); event.target.value = ""; }} />
    </div>
    {parseError && <p className="upload-error"><UiIcon name="warning" />{parseError}</p>}
    {project.files?.length > 0 && <div className="file-list"><header><strong>已选择 {project.files.length} 个文件</strong><span>共 {formatFileSize(project.files.reduce((sum, file) => sum + (file.size || 0), 0))}</span></header>{project.files.map((file) => <div key={`${file.name}-${file.size}`}><UiIcon name="included" /><span><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span></div>)}</div>}
    {project.recognition && <div className="recognition-strip"><div><strong>{project.recognition.dayCount}</strong><span>逐日行程</span></div><div><strong>{project.recognition.hotelCount}</strong><span>住宿名称</span></div><div><strong>{project.recognition.highlightCount}</strong><span>原始亮点</span></div><div><strong>{project.recognition.internalFilteredCount}</strong><span>内部信息已隔离</span></div></div>}
    <div className="flow-footer"><Button tone="primary" disabled={!project.files?.length || parsing} onClick={onContinue}>确认识别结果</Button></div>
  </section></main>;
}

function AgentConfirmationPanel({ confirmations = [], decisions, onDecision }) {
  const pending = confirmations.filter((item) => item.status === "pending");
  if (!pending.length) return <div className="agent-inline-clear"><UiIcon name="included" /><div><strong>没有需要额外确认的关键问题</strong><p>系统会使用已识别事实自动继续制定计划。</p></div></div>;
  return <section className="agent-inline-confirm"><header><small>智能体生成前检查</small><h2>这些关键问题需要一次确认</h2><p>只询问事实、费用、履约或安全问题；选择会保存为本项目约束。</p></header>{pending.map((item) => <article key={item.confirmationId}><span>{item.category}</span><h3>{item.question}</h3><p>{item.reason}</p>{item.choices.map((choice) => <label key={choice.choiceId}><input type="radio" name={item.confirmationId} checked={decisions[item.confirmationId] === choice.choiceId} onChange={() => onDecision(item.confirmationId, choice.choiceId)} /><b>{choice.label}</b>{choice.recommended && <em>建议</em>}<small>{choice.reason}</small></label>)}</article>)}</section>;
}

function ConfirmStep({ project, onChange, onContinue, onBack, agentMode = false, agentSnapshot, agentDecisions = {}, onAgentDecision }) {
  const data = project.data;
  const update = (key, value) => {
    let next = { ...data, [key]: value };
    if (key === "startDate") {
      next = mapDaysFromStart(next, value);
      if (!data.endDate && value && next.days.length) next.endDate = addDays(value, next.days.length - 1);
    }
    onChange(next);
  };
  const validation = validateItineraryFacts(data);
  return <main className="flow-page"><StepRail active={1} onStep={(step) => step === 0 && onBack()} /><section className="flow-content">
    <header className="flow-heading"><small>STEP 02</small><h1>确认识别结果</h1><p>重要事实只采用原始资料或你的输入；红色项必须确认后才能继续。</p></header>
    {agentMode && <AgentConfirmationPanel confirmations={agentSnapshot?.confirmations || []} decisions={agentDecisions} onDecision={onAgentDecision} />}
    <div className="confirm-layout"><div className="confirm-form">
      <div className="field-grid"><label className={!data.destination ? "required-field" : ""}>目的地<input value={data.destination || ""} onChange={(event) => update("destination", event.target.value)} /></label><label>客户称呼<input value={project.customerName || ""} onChange={(event) => onChange(data, { customerName: event.target.value })} placeholder="例如：陈女士" /></label><label>出发日期<input type="date" value={data.startDate || ""} onChange={(event) => update("startDate", event.target.value)} /></label><label>返程日期<input type="date" value={data.endDate || ""} onChange={(event) => update("endDate", event.target.value)} /></label><label>成人<input type="number" min="1" value={data.adults ?? data.travelers ?? ""} onChange={(event) => update("adults", event.target.value === "" ? null : Number(event.target.value))} placeholder="待确认" /></label><label>儿童<input type="number" min="0" value={data.children ?? ""} onChange={(event) => update("children", event.target.value === "" ? 0 : Number(event.target.value))} /></label></div>
      {!validation.valid && <div className="validation-errors" role="alert"><strong>生成前需要确认</strong>{validation.errors.map((error) => <p key={error}>{error}</p>)}</div>}
      <label>项目名称<input value={project.title} onChange={(event) => onChange(data, { title: event.target.value })} /></label>
      <label>特殊需求<textarea rows="4" value={project.requirements || ""} onChange={(event) => onChange(data, { requirements: event.target.value })} placeholder="饮食偏好、节奏、房型、长者儿童等" /></label>
    </div><aside className="recognition-summary"><h2>识别摘要</h2><div><strong>{data.days.length}</strong><span>行程天数</span></div><div><strong>{data.hotels?.length || 0}</strong><span>住宿信息</span></div><div><strong>{project.recognition?.highlightCount || 0}</strong><span>原始亮点</span></div><hr /><h3><UiIcon name="warning" />需要留意</h3>{(project.recognition?.warnings?.length ? project.recognition.warnings : ["请确认日期、人数与客户称呼后继续。"]).map((warning) => <p className="warning-note" key={warning}>{warning}</p>)}<p className="soft-note">已隔离 {project.recognition?.internalFilteredCount || 0} 条疑似供应商成本、利润或内部报价说明，不会进入客户成品。</p></aside></div>
    <div className="flow-footer"><Button onClick={onBack}>返回上传</Button><Button tone="primary" disabled={!data.destination || !project.title || !validation.valid || (agentMode && (agentSnapshot?.confirmations || []).some((item) => item.status === "pending" && !agentDecisions[item.confirmationId]))} onClick={onContinue}>{agentMode ? "保存确认并继续" : "确认并生成内容"}</Button></div>
  </section></main>;
}

function GenerationStep({ project, progress, status, error, onStart, onEdit, onRevision, onReview }) {
  const startedRef = useRef(false);
  useEffect(() => {
    if (!startedRef.current && progress === 0 && !error) {
      startedRef.current = true;
      onStart();
    }
  }, [error, onStart, progress]);
  const phaseLabels = { queued: "准备生成", copy: "生成客户文案", copy_mainline: "建立整程内容与视觉主线", copy_modules: "并行生成文案模块", brand_review: "独立品牌审查与目标修复", blueprint: "理解整份行程并规划图片", images: "准备图片检索", searching: "搜索与下载图片", auditing: "检查候选图片", allocating: "放入版面", final_review: "检查实际长图", complete: "生成完成", needs_copy_revision: "待文案修订", blocked: "已阻止生成" };
  const quality = status?.contentQuality || project.aiGeneration?.contentQuality || {};
  const copyIssues = collectCopyIssues(quality);
  const copyIssueTargets = groupCopyIssueTargets(quality);
  const groupedIssues = groupCopyIssues(quality);
  const terminal = generationStateLabel(status, copyIssueTargets.length);
  const activeTitle = terminal?.title || phaseLabels[status?.phase] || "处理真实数据";
  const stats = status?.stats || {};
  const copyProgress = status?.copyProgress || {};
  const copyStream = status?.copyStream || {};
  const streamText = copyStream.streamPhase === "queued" ? "等待文案队列" : copyStream.streamPhase === "waiting" ? "等待 DeepSeek 响应" : copyStream.streamPhase === "reasoning" ? "DeepSeek 已响应，正在分析" : copyStream.streamPhase === "content" ? "正在接收结构化文案" : copyStream.streamPhase === "retrying" ? `当前模块正在第 ${copyStream.nextAttempt || (copyStream.attempt || 1) + 1} 次尝试` : copyStream.streamPhase === "complete" ? "当前文案模块已接收完成" : "";
  const elapsed = Math.max(0, Math.round(Number(status?.elapsedMs || 0) / 1000));
  return <main className="flow-page"><StepRail active={2} /><section className="generation-page">
    <div className="generation-main"><header><small>STEP 03 · AI GENERATION</small><h1>{activeTitle}</h1><p>{terminal?.detail || "系统正在按整份行程规划、搜索并检查图片，请稍候。"}</p></header>
      {!terminal || terminal.tone === 'complete' ? <div className="overall-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress} aria-label="生成进度"><div><span style={{ width: `${progress}%` }} /></div><strong>{progress}%</strong></div> : <div className={`generation-terminal generation-terminal-${terminal.tone}`} role="status"><strong>{terminal.title}</strong><span>{terminal.detail}</span></div>}<div className="progress-meta" aria-live="polite"><span>{status?.currentAction || "正在调用真实生成服务"}</span><span>已用时 {Math.floor(elapsed / 60)}分{elapsed % 60}秒</span></div>
      {copyProgress.totalUnits > 0 && <div className="live-stats"><span>文案模块 <strong>{copyProgress.completedUnits || 0}/{copyProgress.totalUnits}</strong></span><span>当前模块 <strong>{copyProgress.currentUnit || "准备中"}</strong></span><span>模型状态 <strong>{streamText || "准备中"}</strong></span><span>尝试 <strong>{copyStream.attempt || 1}</strong></span>{copyStream.receivedContentChars > 0 && <span>已接收 <strong>{copyStream.receivedContentChars} 字符</strong></span>}</div>}
      {stats.slotCount > 0 && <div className="live-stats"><span>已搜索图片位 <strong>{stats.searchedSlots || 0}/{stats.slotCount || 0}</strong></span><span>搜索轮次 <strong>{stats.searchAttempts || 0}</strong></span><span>候选 <strong>{stats.candidateCount || 0}</strong></span><span>已审核 <strong>{stats.auditedCandidates || 0}</strong></span><span>自动通过 <strong>{stats.autoApproved || 0}</strong></span><span>待人工位置 <strong>{stats.manualReviewSlots ?? stats.manualReview ?? 0}</strong></span><span>审核超时 <strong>{stats.auditTimeout || 0}</strong></span><span>审核服务异常 <strong>{stats.auditUnavailable || 0}</strong></span><span>明确拒绝 <strong>{stats.hardRejected || 0}</strong></span></div>}
      {error && <p className="generation-error"><UiIcon name="warning" />{error}</p>}
      {copyIssues.length > 0 && <section className="copy-issue-list" aria-label="全部文案问题"><header><strong>系统已发现的问题</strong><span>{copyIssueTargets.length} 个修改位置 · {copyIssues.length} 条检查记录</span></header>{Object.entries(groupedIssues).map(([group, issues]) => <div key={group}><h3>{group}</h3>{issues.map((issue, index) => <p key={`${group}-${index}`}><b>{issue.ruleIds?.join('/') || issue.ruleId || 'COPY'}</b><span>{issue.message}</span></p>)}</div>)}</section>}
      {progress === 0 && error && <Button tone="primary" onClick={() => { startedRef.current = true; onStart(); }}>重新生成</Button>}
    </div>
    <aside className="generation-preview"><header><strong>当前项目</strong><span>真实数据</span></header><div className="mini-itinerary"><img src="/assets/logos/logo-gold.png" alt="奢游国际" /><small>PRIVATE JOURNEY · {project.data.destination || "目的地待确认"}</small><h2>{project.data.title || project.title}</h2><div className="mini-image">{project.data.heroImage ? <img src={project.data.heroImage} alt={project.data.destination || "行程封面"} /> : <span>封面图片检索中</span>}</div></div><h3><UiIcon name="process" />处理状态</h3><p>{terminal?.detail || "正在生成客户版文案并检索、下载和审核真实图片，请保持页面打开。"}</p></aside>
    <footer className="generation-footer"><Button onClick={onReview}>查看识别结果</Button>{['needs_copy_revision','blocked'].includes(status?.status) && <Button tone="primary" onClick={onRevision}>进入编辑查看并处理</Button>}{status?.status === 'complete' && <Button tone="primary" onClick={onEdit}>进入编辑</Button>}</footer>
  </section></main>;
}

const AGENT_PROGRESS_STAGES = [
  { key: "intake", label: "资料检查" },
  { key: "planning", label: "智能规划" },
  { key: "facts", label: "事实核验", taskTypes: ["web_verification"] },
  { key: "copy", label: "文案生成", taskTypes: ["copy_global", "copy_hotel_transport", "copy_day_group", "copy_closing"] },
  { key: "images", label: "图片准备", taskTypes: ["image_search_plan"] },
  { key: "review", label: "审核排版", taskTypes: ["copy_review", "targeted_copy_repair", "visual_review", "image_placement", "image_gap_resolution", "layout_render"] },
  { key: "final", label: "成品检查", taskTypes: ["final_qa", "completion_gate", "persistence"] },
];
const AGENT_TASK_SUCCESS = new Set(["succeeded", "user_resolved", "user_accepted_suggestion", "not_applicable", "removed_optional"]);

function taskStageState(tasks, runByTaskId) {
  if (!tasks.length) return { state: "pending", progress: 0 };
  const states = tasks.map((task) => runByTaskId.get(task.taskId)?.status || "pending");
  if (states.some((state) => ["failed", "blocked"].includes(state))) return { state: "failed", progress: 0 };
  if (states.some((state) => ["waiting_confirmation", "waiting_user"].includes(state))) return { state: "waiting", progress: states.filter((state) => AGENT_TASK_SUCCESS.has(state)).length / states.length };
  if (states.some((state) => ["running", "retrying", "queued"].includes(state))) return { state: "active", progress: states.filter((state) => AGENT_TASK_SUCCESS.has(state)).length / states.length };
  const completed = states.filter((state) => AGENT_TASK_SUCCESS.has(state)).length;
  return { state: completed === states.length ? "complete" : "pending", progress: completed / states.length };
}

function buildAgentProgress(snapshot) {
  const project = snapshot?.project;
  const plan = snapshot?.plan;
  const run = snapshot?.executionRun;
  const runByTaskId = new Map((run?.taskRuns || []).map((item) => [item.taskId, item]));
  const planActive = Boolean(plan?.validation?.passed && project?.activePlanId === plan?.planId);
  const intakeComplete = Boolean(project && !["preparing", "awaiting_confirmation"].includes(project.status));
  const stages = AGENT_PROGRESS_STAGES.map((definition) => {
    if (definition.key === "intake") {
      if (project?.status === "awaiting_confirmation") return { ...definition, state: "waiting", progress: 0 };
      if (intakeComplete) return { ...definition, state: "complete", progress: 1 };
      return { ...definition, state: project ? "active" : "pending", progress: 0 };
    }
    if (definition.key === "planning") {
      if (planActive) return { ...definition, state: "complete", progress: 1 };
      if (project?.status === "planning_failed") return { ...definition, state: "failed", progress: 0 };
      return { ...definition, state: project?.status === "planning" ? "active" : "pending", progress: 0 };
    }
    const tasks = (plan?.tasks || []).filter((task) => definition.taskTypes.includes(task.taskType));
    return { ...definition, ...taskStageState(tasks, runByTaskId) };
  });
  if (project?.status === "cancelled") stages.forEach((stage) => { if (!["complete", "failed"].includes(stage.state)) stage.state = "cancelled"; });
  const formallyComplete = ["completed", "ready_for_editor"].includes(project?.status) && stages.every((stage) => stage.state === "complete");
  const percent = formallyComplete ? 100 : Math.min(99, Math.floor(stages.reduce((sum, stage) => sum + stage.progress, 0) / stages.length * 100));
  return { stages, percent, planActive };
}

function AgentProgressOverview({ snapshot, taskCount, executed, elapsed, action }) {
  const progress = buildAgentProgress(snapshot);
  const labels = { complete: "已完成", active: "进行中", waiting: "等待确认", failed: "已中断", cancelled: "已取消", pending: "未开始" };
  const waitingReason = snapshot?.project?.status === "awaiting_confirmation" ? "等待：需要你确认关键业务问题" : snapshot?.executionRun?.status === "execution_disabled" ? "等待：真实执行能力尚未开放" : "";
  return <aside className="agent-progress-overview"><header><small>REAL-TIME PROGRESS</small><h2>实时进度总览</h2></header><div className="agent-progress-total" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress.percent} aria-label="智能体真实总进度"><strong>{progress.percent}<sup>%</sup></strong><div><span style={{ width: `${progress.percent}%` }} /></div><p>{action}</p></div><ol>{progress.stages.map((stage) => <li className={`agent-progress-${stage.state}`} key={stage.key}><i /> <span>{stage.label}</span><em>{labels[stage.state]}</em></li>)}</ol>{waitingReason && <p className="agent-progress-wait">{waitingReason}</p>}<footer><div><strong>{executed}/{taskCount}</strong><span>完成任务</span></div><div><strong>{Math.floor(elapsed / 60)}分{elapsed % 60}秒</strong><span>实际用时</span></div></footer></aside>;
}

function AgentGenerationStep({ project, snapshot, error, onReview, onCancel, decisions, onDecision, onConfirm }) {
  const agentProject = snapshot?.project;
  const plan = snapshot?.plan;
  const run = snapshot?.executionRun;
  const activeJob = snapshot?.activeJob;
  const taskState = new Map((run?.taskRuns || []).map((item) => [item.taskId, item.status]));
  const executed = [...taskState.values()].filter((value) => ["succeeded", "user_resolved", "user_accepted_suggestion", "not_applicable", "removed_optional"].includes(value)).length;
  const taskCount = plan?.tasks?.length || 0;
  const elapsed = agentProject?.createdAt ? Math.max(0, Math.floor((Date.now() - new Date(agentProject.createdAt).getTime()) / 1000)) : 0;
  const waiting = agentProject?.status === "awaiting_confirmation";
  const failed = agentProject?.status === "planning_failed";
  const cancelled = agentProject?.status === "cancelled";
  const ready = agentProject?.status === "ready_for_execution";
  const intakeFinished = Boolean(agentProject && !["preparing", "awaiting_confirmation"].includes(agentProject.status));
  const activeTitle = waiting ? "需要你的确认" : failed ? "生成任务已中断" : cancelled ? "生成任务已取消" : "正在生成行程成品";
  const action = waiting ? "等待你确认关键业务问题" : ready && run?.status === "execution_disabled" ? "等待真实执行能力开放" : activeJob?.message || agentProject?.currentStage || "正在读取智能体项目";
  const latestResult = plan ? `智能规划已完成并通过检查，已建立 ${taskCount} 个执行任务。` : intakeFinished ? "资料检查已经完成，正在建立本次唯一任务计划。" : "正在读取并检查本次上传资料。";
  return <main className="flow-page"><StepRail active={2} /><section className="generation-page agent-workspace-generation">
    <div className="generation-main"><header><small>STEP 03 · AGENT GENERATION</small><h1>{activeTitle}</h1><p>{waiting ? "保存选择后会从受影响的当前任务继续，不会整份重跑。" : failed ? agentProject?.lastError || "当前阶段没有通过安全检查。" : cancelled ? "项目、计划和已经形成的证据都已保留。" : latestResult}</p></header>
      {waiting && <div className="agent-runtime-confirm"><AgentConfirmationPanel confirmations={snapshot?.confirmations || []} decisions={decisions} onDecision={onDecision} /><Button tone="primary" onClick={onConfirm}>保存选择并从当前任务继续</Button></div>}
      {error && <p className="generation-error"><UiIcon name="warning" />{error}</p>}
      {plan && <details className="agent-plan-details workspace-agent-plan"><summary><small>查看本次规划 / 技术详情</small></summary><section className="agent-technical-summary"><span>计划 {plan.planId.slice(0, 8)}</span><span>{taskCount} 个任务</span><span>{executed} 个完成</span><span>{run?.capabilityCallStats?.reduce((sum, item) => sum + item.actualCalls, 0) || 0} 次下游调用</span><span>版本 {plan.planVersion}</span></section><PlanView project={agentProject} plan={plan} embedded /></details>}
    </div>
    <AgentProgressOverview snapshot={snapshot} taskCount={taskCount} executed={executed} elapsed={elapsed} action={action} />
    <footer className="generation-footer">{!waiting && <Button onClick={onReview}>查看确认信息</Button>}{!["cancelled"].includes(agentProject?.status) && <Button onClick={onCancel}>取消任务</Button>}</footer>
  </section></main>;
}

function CandidatePreview({ candidate }) {
  const [failed, setFailed] = useState(false);
  return <div className="candidate-preview">{!failed && candidate.localPreviewUrl ? <img src={candidate.localPreviewUrl} alt={`${candidate.label || "候选图片"}预览`} onError={() => setFailed(true)} /> : <div className="missing-image"><UiIcon name="warning" /><span>候选图片加载失败</span></div>}</div>;
}

function ImageReviewStep({ project, onDecision, onResearchSlot, onComplete, onBack }) {
  const review = project.data.imageReview || { slots: [] };
  const candidates = project.data.imageCandidates || [];
  const pending = pendingImageReviewSlots(review);
  const inputRef = useRef(null);
  const [uploadSlot, setUploadSlot] = useState("");
  const [researchingSlot, setResearchingSlot] = useState("");
  return <main className="flow-page"><StepRail active={2} /><section className="flow-content image-review-page">
    <header className="flow-heading"><small>STEP 03 · IMAGE REVIEW</small><h1>确认未自动通过的图片</h1><p>候选图仅供审核；采用、拒绝、留空或上传都会记录为人工决定。明确硬拒绝图片不可直接采用。</p></header>
    <div className="review-summary"><span>待确认图片位 <strong>{pending.length}</strong></span><span>全部候选 <strong>{candidates.length}</strong></span><span>自动通过 <strong>{candidates.filter((item) => item.status === IMAGE_REVIEW_STATE.AUTO_APPROVED).length}</strong></span><span>明确拒绝 <strong>{candidates.filter((item) => item.status === IMAGE_REVIEW_STATE.HARD_REJECTED).length}</strong></span></div>
    <div className="review-slots">{review.slots.map((slot) => { const slotCandidates = candidates.filter((item) => item.slotId === slot.slotId); return <section className={`review-slot review-slot-${slot.status}`} key={slot.slotId}><header><div><small>{slot.module}</small><h2>{slot.label}</h2></div><span>{slot.status === "manual_review" ? "待人工确认" : slot.status === "auto_selected" ? "已自动选片" : slot.status === "human_selected" ? "已人工采用" : slot.status === "uploaded" ? "已上传" : slot.status === "left_empty" ? "已留空" : "无可用图片"}</span></header><div className="candidate-grid">{slotCandidates.map((candidate, index) => <article className={`candidate-card candidate-${candidate.status}`} key={`${slot.slotId}-${candidate.candidateId}-${candidate.attempt}-${index}`}><CandidatePreview candidate={candidate} /><div className="candidate-body"><div className="candidate-state"><strong>{candidate.status === IMAGE_REVIEW_STATE.AUTO_APPROVED ? "自动通过" : candidate.status === IMAGE_REVIEW_STATE.HARD_REJECTED ? "明确拒绝" : "待人工确认"}</strong>{candidate.officialSource && <span>官方来源</span>}</div><p>{candidate.reason || "暂无审核说明"}</p><dl><div><dt>相关度</dt><dd>{candidate.terminalAudit?.relevance ?? candidate.initialAudit?.relevance ?? "—"}</dd></div><div><dt>高端感</dt><dd>{candidate.terminalAudit?.luxury ?? candidate.initialAudit?.luxury ?? "—"}</dd></div><div><dt>干净度</dt><dd>{candidate.terminalAudit?.cleanliness ?? candidate.initialAudit?.cleanliness ?? "—"}</dd></div><div><dt>构图</dt><dd>{candidate.terminalAudit?.composition ?? candidate.initialAudit?.composition ?? "—"}</dd></div></dl><a href={candidate.sourcePage} target="_blank" rel="noreferrer">查看来源页面</a>{slot.status === "manual_review" && candidate.adoptable !== false && candidate.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW && <div className="candidate-actions"><Button tone="primary" onClick={() => onDecision(slot.slotId, "adopt", candidate)}>采用此图</Button><Button onClick={() => onDecision(slot.slotId, "reject", candidate)}>拒绝此图</Button></div>}</div></article>)}</div>{slot.status === "manual_review" && <footer><Button disabled={Boolean(researchingSlot)} onClick={async () => { setResearchingSlot(slot.slotId); try { await onResearchSlot(slot.slotId); } finally { setResearchingSlot(""); } }}>{researchingSlot === slot.slotId ? "正在重搜…" : "只重搜此图片位"}</Button><Button onClick={() => onDecision(slot.slotId, "empty")}>本图片位留空</Button><Button onClick={() => { setUploadSlot(slot.slotId); inputRef.current?.click(); }}>上传已授权素材</Button></footer>}</section>; })}</div>
    <input ref={inputRef} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file || !uploadSlot) return; const reader = new FileReader(); reader.onload = () => onDecision(uploadSlot, "upload", { src: reader.result, name: file.name }); reader.readAsDataURL(file); event.target.value = ""; }} />
    <footer className="flow-footer"><Button onClick={onBack}>返回生成状态</Button><Button tone="primary" disabled={pending.length > 0} onClick={onComplete}>完成图片确认并进入编辑</Button></footer>
  </section></main>;
}

function visibilityData(data, visibility) {
  const next = clone(data);
  if (visibility.highlights === false) next.highlights = [];
  if (visibility.overview === false) next.showOverviewSection = false;
  if (visibility.hotels === false) next.hotels = [];
  if (visibility.dining === false) next.diningExperiences = [];
  if (visibility.transport === false) next.transportSummary = [];
  if (visibility.expenses === false) { next.totalPrice = null; next.included = []; next.excluded = []; next.cancellation = []; }
  if (visibility.booking === false) { next.showBookingSection = false; next.showSecuritySection = false; }
  if (visibility.notes === false) next.notes = [];
  return next;
}

function versionSnapshot(data) {
  const next = clone(data);
  for (const key of ["imageBlueprint", "imageCandidates", "imageReview", "imageResearch", "imageFailures", "imageSourceLedger"]) delete next[key];
  const compact = (value) => {
    if (Array.isArray(value)) return value.map(compact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
    if (typeof value === "string" && value.startsWith("data:image/")) return "";
    return value;
  };
  return compact(next);
}

function parseHighlight(value = "") {
  const match = String(value).match(/^([^：:]+)[：:](.*)$/s);
  return match ? { title: match[1], description: match[2] } : { title: value, description: "" };
}

function imageList(item) {
  if (item?.images?.length) return item.images.map((image) => typeof image === "string" ? { src: image, focus: "50% 50%" } : { focus: "50% 50%", ...image }).filter((image) => isUsableFinalImageSource(image.src));
  if (item?.image) {
    const image = { src: typeof item.image === "string" ? item.image : item.image.src, focus: item.focus || item.image.focus || "50% 50%", fit: item.fit || item.image.fit };
    return isUsableFinalImageSource(image.src) ? [image] : [];
  }
  return [];
}

function splitLines(value) {
  return String(value || "").split("\n").map((item) => item.trim()).filter(Boolean);
}

function snapshotProject(project) {
  return { data: clone(project.data), visibility: clone(project.visibility || {}), title: project.title, customerName: project.customerName, requirements: project.requirements };
}

function Field({ label, value, onChange, rows, type = "text", placeholder }) {
  return <label>{label}{rows ? <textarea rows={rows} value={value ?? ""} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /> : <input type={type} value={value ?? ""} onChange={(event) => onChange(type === "number" ? Number(event.target.value) : event.target.value)} placeholder={placeholder} />}</label>;
}

function ItemPicker({ label, items, index = 0, getLabel, onSelect, onAdd, onDelete, onMove }) {
  if (!items.length) return <div className="item-picker item-picker-empty"><span>暂无{label}</span><Button onClick={onAdd}>新增{label}</Button></div>;
  return <div className="item-picker"><label>{label}<select value={Math.min(index, items.length - 1)} onChange={(event) => onSelect(Number(event.target.value))}>{items.map((item, itemIndex) => <option key={item.id || `${label}-${itemIndex}`} value={itemIndex}>{getLabel(item, itemIndex)}</option>)}</select></label><div className="item-picker-actions"><button onClick={() => onMove(-1)} disabled={index <= 0}>上移</button><button onClick={() => onMove(1)} disabled={index >= items.length - 1}>下移</button><button onClick={onAdd}>新增</button><button className="danger-text" onClick={onDelete}>删除</button></div></div>;
}

function ImagePickerModal({ data, targetSlot, onChoose, onUpload, onResearch, onClose }) {
  const [tab, setTab] = useState('recommended');
  const [researching, setResearching] = useState(false);
  const inputRef = useRef(null);
  const placements = listImagePlacements(data);
  const usedBySrc = new Map(placements.map(({ slot, image }) => [image.src, slot]));
  const safeCandidates = (data.imageCandidates || []).filter((item) => item.libraryEligible === true && item.localPreviewUrl);
  const uploaded = placements.filter(({ image }) => image.userProvided).map(({ slot, image }) => ({ candidateId: 'user-' + slot.slotId, localPreviewUrl: image.src, sourceTitle: '本地上传', slotId: slot.slotId, userProvided: true }));
  const all = [...safeCandidates, ...uploaded].filter((item, index, array) => array.findIndex((other) => other.localPreviewUrl === item.localPreviewUrl) === index);
  const visible = tab === 'recommended' ? all.filter((item) => item.slotId === targetSlot.slotId || item.terminalAudit?.subjectMatch === true).sort((a, b) => Number(b.slotId === targetSlot.slotId) - Number(a.slotId === targetSlot.slotId)) : all;
  return <div className="modal-backdrop image-picker-backdrop" role="dialog" aria-modal="true" aria-label="更换图片"><section className="image-picker-modal">
    <header><div><small>更换图片</small><h2>{targetSlot.label}</h2><p>选择已使用图片时会移动到这里，原位置自动留空。</p></div><button onClick={onClose}>关闭</button></header>
    <nav><button className={tab === 'recommended' ? 'active' : ''} onClick={() => setTab('recommended')}>适合当前位置</button><button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>全部行程图片</button><button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>本地上传</button></nav>
    {tab === 'upload' ? <div className="image-picker-upload"><UiIcon name="included" size={42} /><strong>上传你确认可使用的图片</strong><p>上传后会保存在当前项目，并锁定这个位置，自动搜索不会覆盖。</p><Button tone="primary" onClick={() => inputRef.current?.click()}>选择本地图片</Button></div> : <div className="image-picker-grid">{visible.length ? visible.map((candidate) => { const used = usedBySrc.get(candidate.localPreviewUrl); return <button key={candidate.candidateId} onClick={() => onChoose(candidate, used)}><img src={candidate.localPreviewUrl} alt="候选图片" onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.parentElement.classList.add('thumbnail-load-failed'); }} /><span><strong>{candidate.sourceTitle || (candidate.userProvided ? '本地上传' : '已检查图片')}</strong><small>{used ? '当前在：' + used.label : '当前未使用'}</small></span></button>; }) : <div className="empty-image-state"><strong>还没有适合的图片</strong><span>可以为当前位置继续搜索，或上传自己的图片。</span></div>}</div>}
    <footer><Button disabled={researching} onClick={async () => { setResearching(true); try { await onResearch(); } finally { setResearching(false); } }}>{researching ? '正在搜索…' : '为当前位置搜索更多'}</Button></footer>
    <input ref={inputRef} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ''; }} />
  </section></div>;
}

export function Editor({ project, ItineraryComponent, onProject, onVersions, onResearchSlot, onRepairCopy, onRecheckCopy, onReviewFacts, copyRepairState, defaultDesigner, initialSelection, initialTab = "copy" }) {
  const [selection, setSelection] = useState(initialSelection || { module: "days", itemIndex: Math.min(2, project.data.days.length - 1), subItemIndex: null, imageIndex: 0 });
  const [tab, setTab] = useState(initialTab);
  const [historyTick, setHistoryTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const previewRef = useRef(null);
  const fileRef = useRef(null);
  const designerFileRef = useRef(null);
  const historyRef = useRef({ undo: [], redo: [], group: null, at: 0 });
  const visibility = project.visibility || {};
  const viewData = useMemo(() => visibilityData(project.data, visibility), [project.data, visibility]);
  const selectedModule = MODULES.find((module) => module.id === selection.module) || MODULES[0];
  const selectedDay = selection.module === "days" ? project.data.days[selection.itemIndex] : null;
  const hasImages = ["cover", "hotels", "dining", "transport", "days"].includes(selection.module);
  const copyReview = project.data.copyQuality || project.aiGeneration?.contentQuality;
  const copyReviewIssues = collectCopyIssues(copyReview);
  const copyIssueTargets = groupCopyIssueTargets(copyReview);

  const commit = (nextProject, group = uid("edit")) => {
    const history = historyRef.current;
    const now = Date.now();
    if (history.group !== group || now - history.at > 800) {
      history.undo.push(snapshotProject(project));
      if (history.undo.length > 50) history.undo.shift();
      history.redo = [];
    }
    history.group = group;
    history.at = now;
    setHistoryTick((value) => value + 1);
    onProject(nextProject);
  };
  const updateData = (updater, group) => {
    const next = clone(project.data);
    updater(next);
    const imageOnly = /^(image-|upload-|delete-image-|choose-image-)/.test(String(group || ''));
    if (!imageOnly) {
      next.copyQuality = { ...(next.copyQuality || {}), passed: false, status: 'needs_copy_revision', needsReview: true, blocked: false, checkedAt: null, manualEditPendingRecheck: true };
      next.humanReview = { ...(next.humanReview || {}), exportWithCopyWarningsConfirmed: false };
    }
    commit({ ...project, workflowStage: imageOnly ? project.workflowStage : 'needs-copy-revision', revisionMode: imageOnly ? project.revisionMode : true, data: next }, group);
  };
  const restore = (direction) => {
    const history = historyRef.current;
    const source = direction === "undo" ? history.undo : history.redo;
    const target = direction === "undo" ? history.redo : history.undo;
    const snapshot = source.pop();
    if (!snapshot) return;
    target.push(snapshotProject(project));
    history.group = null;
    setHistoryTick((value) => value + 1);
    onProject({ ...project, ...snapshot }, true);
  };
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      restore(event.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);
  useEffect(() => { if (!hasImages && tab === "image") setTab("copy"); }, [hasImages, tab]);

  const selectionPath = (value = selection) => {
    if (value.module === "days") return value.subItemIndex == null ? `days.${value.itemIndex}` : `days.${value.itemIndex}.spots.${value.subItemIndex}`;
    return value.itemIndex == null ? value.module : `${value.module}.${value.itemIndex}`;
  };
  const centerInCanvas = (target, behavior = "smooth") => {
    const stage = previewRef.current;
    if (!stage || !target) return;
    const stageBox = stage.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    stage.scrollTo({ top: Math.max(0, stage.scrollTop + targetBox.top - stageBox.top - 28), behavior });
  };
  const choose = (next, nextTab) => {
    historyRef.current.group = null;
    setSelection(next);
    if (nextTab) setTab(nextTab);
    requestAnimationFrame(() => centerInCanvas(previewRef.current?.querySelector(`[data-edit-path="${selectionPath(next)}"]`)));
  };
  const selectModule = (module, itemIndex) => {
    const collections = { highlights: project.data.highlights, overview: project.data.days, hotels: project.data.hotels, dining: project.data.diningExperiences, transport: project.data.transportSummary, notes: project.data.notes };
    const nextIndex = module === "days" ? Math.max(0, itemIndex ?? selection.itemIndex ?? 0) : collections[module]?.length ? Math.max(0, itemIndex ?? 0) : null;
    choose({ module, itemIndex: nextIndex, subItemIndex: null, imageIndex: 0 }, "copy");
  };
  const selectIssueTarget = (targetPath = '') => {
    let match = targetPath.match(/^days\.(\d+)/);
    if (match) return selectModule('days', Number(match[1]));
    match = targetPath.match(/^hotels\.(\d+)/);
    if (match) return selectModule('hotels', Number(match[1]));
    match = targetPath.match(/^diningExperiences\.(\d+)/);
    if (match) return selectModule('dining', Number(match[1]));
    match = targetPath.match(/^transportSummary\.(\d+)/);
    if (match) return selectModule('transport', Number(match[1]));
    match = targetPath.match(/^notes\.(\d+)/);
    if (match) return selectModule('notes', Number(match[1]));
    if (targetPath === 'highlights') return selectModule('highlights');
    if (targetPath === 'expenses') return selectModule('expenses');
    return selectModule('cover');
  };
  useEffect(() => {
    const editorPage = previewRef.current?.closest(".editor-page");
    if (editorPage) editorPage.scrollTop = 0;
    previewRef.current?.querySelectorAll(".workspace-selected-node").forEach((node) => node.classList.remove("workspace-selected-node"));
    previewRef.current?.querySelector(`[data-edit-path="${selectionPath()}"]`)?.classList.add("workspace-selected-node");
  }, [selection, viewData]);

  const onPreviewClick = (event) => {
    const node = event.target.closest("[data-edit-path]");
    if (!node) return;
    const parts = node.dataset.editPath.split(".");
    const next = { module: parts[0], itemIndex: parts[1] == null ? null : Number(parts[1]), subItemIndex: parts[2] === "spots" ? Number(parts[3]) : null, imageIndex: Number(event.target.closest("[data-edit-image]")?.dataset.editImage || 0) };
    choose(next, event.target.closest("[data-edit-image]") ? "image" : "copy");
  };
  const updateVisibility = (checked) => commit({ ...project, visibility: { ...visibility, [selectedModule.id]: checked } }, `visibility-${selectedModule.id}`);
  const moveItem = (key, index, delta) => updateData((next) => { const list = next[key]; const target = index + delta; if (target < 0 || target >= list.length) return; [list[index], list[target]] = [list[target], list[index]]; }, `move-${key}-${Date.now()}`);
  const deleteItem = (key, index, after) => {
    if (!window.confirm("确定删除这项内容吗？可以立即使用撤销恢复。")) return;
    updateData((next) => next[key].splice(index, 1), `delete-${key}-${Date.now()}`);
    after?.();
  };

  const picker = (key, label, getLabel, createItem) => {
    const items = project.data[key] || [];
    const index = Math.min(selection.itemIndex ?? 0, Math.max(0, items.length - 1));
    return <ItemPicker label={label} items={items} index={index} getLabel={getLabel} onSelect={(itemIndex) => choose({ ...selection, itemIndex, subItemIndex: null, imageIndex: 0 })} onAdd={() => { const item = createItem(); updateData((next) => next[key].push(item), `add-${key}-${Date.now()}`); choose({ ...selection, itemIndex: items.length, subItemIndex: null, imageIndex: 0 }); }} onDelete={() => deleteItem(key, index, () => choose({ ...selection, itemIndex: Math.max(0, index - 1), subItemIndex: null, imageIndex: 0 }))} onMove={(delta) => { moveItem(key, index, delta); choose({ ...selection, itemIndex: index + delta }); }} />;
  };

  let copyPanel;
  if (selection.module === "cover") copyPanel = <><Field label="封面标题" value={project.data.title} onChange={(value) => updateData((next) => { next.title = value; }, "cover-title")} /><Field label="封面副标题" rows={4} value={project.data.subtitle} onChange={(value) => updateData((next) => { next.subtitle = value; }, "cover-subtitle")} /><Field label="目的地" value={project.data.destination} onChange={(value) => updateData((next) => { next.destination = value; }, "cover-destination")} /><div className="inspector-divider"><span>项目定制师资料</span></div><div className="project-designer-avatar"><img src={project.data.designer?.avatar || defaultDesigner.avatar} alt="项目定制师头像" /><Button onClick={() => designerFileRef.current?.click()}>替换项目头像</Button><input ref={designerFileRef} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => updateData((next) => { next.designer = { ...(next.designer || {}), avatar: reader.result }; }, `designer-avatar-${Date.now()}`); reader.readAsDataURL(file); event.target.value = ""; }} /></div><Field label="姓名" value={project.data.designer?.name || ""} onChange={(value) => updateData((next) => { next.designer = { ...(next.designer || {}), name: value }; }, "designer-name")} /><Field label="职位" value={project.data.designer?.role || ""} onChange={(value) => updateData((next) => { next.designer = { ...(next.designer || {}), role: value }; }, "designer-role")} /><Field label="个人介绍" rows={4} value={project.data.designer?.bio || ""} onChange={(value) => updateData((next) => { next.designer = { ...(next.designer || {}), bio: value }; }, "designer-bio")} /><Button onClick={() => updateData((next) => { next.designer = clone(defaultDesigner); }, `designer-default-${Date.now()}`)}>使用我的默认资料</Button></>;
  else if (selection.module === "highlights") {
    const item = parseHighlight(project.data.highlights?.[selection.itemIndex] || "");
    copyPanel = <><Field label="模块标题" value={project.data.highlightsSectionTitle || "产品亮点"} onChange={(value) => updateData((next) => { next.highlightsSectionTitle = value; }, "highlights-section-title")} />{picker("highlights", "亮点", (value, index) => parseHighlight(value).title || `亮点${index + 1}`, () => "新亮点：请输入亮点说明")}<Field label="亮点标题" value={item.title} onChange={(value) => updateData((next) => { const parsed = parseHighlight(next.highlights[selection.itemIndex]); next.highlights[selection.itemIndex] = `${value}：${parsed.description}`; }, `highlight-title-${selection.itemIndex}`)} /><Field label="亮点说明" rows={5} value={item.description} onChange={(value) => updateData((next) => { const parsed = parseHighlight(next.highlights[selection.itemIndex]); next.highlights[selection.itemIndex] = `${parsed.title}：${value}`; }, `highlight-copy-${selection.itemIndex}`)} /></>;
  } else if (selection.module === "overview") {
    const day = project.data.days[selection.itemIndex] || {};
    copyPanel = <><Field label="模块标题" value={project.data.overviewSectionTitle || "行程总览"} onChange={(value) => updateData((next) => { next.overviewSectionTitle = value; }, "overview-section-title")} />{picker("days", "总览天数", (value, index) => `DAY ${String(index + 1).padStart(2, "0")} · ${value.theme || value.city || "未命名"}`, () => ({ date: null, theme: "新一天行程", routeNodes: [], city: "", description: "", spots: [] }))}<Field label="路线节点（每行一个）" rows={4} value={(day.routeNodes || []).join("\n")} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].routeNodes = splitLines(value); }, `overview-route-${selection.itemIndex}`)} /><Field label="总览主题" value={day.theme} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].theme = value; }, `overview-theme-${selection.itemIndex}`)} /><Field label="总览备注" rows={3} value={day.overviewNote || ""} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].overviewNote = value; }, `overview-note-${selection.itemIndex}`)} /></>;
  } else if (selection.module === "hotels") {
    const hotel = project.data.hotels?.[selection.itemIndex] || {};
    copyPanel = <><Field label="模块标题" value={project.data.hotelSectionTitle || "臻选下榻"} onChange={(value) => updateData((next) => { next.hotelSectionTitle = value; }, "hotel-section-title")} /><Field label="模块引导标题" value={project.data.hotelIntroTitle || "住进风景深处，也住进旅程的黄金位置"} onChange={(value) => updateData((next) => { next.hotelIntroTitle = value; }, "hotel-intro-title")} /><Field label="模块引导文案" rows={3} value={project.data.hotelIntroCopy || "每一处下榻都服务于路线节奏：或更接近游猎现场，或以完整度假体验承接长途移动后的松弛时刻。"} onChange={(value) => updateData((next) => { next.hotelIntroCopy = value; }, "hotel-intro-copy")} />{picker("hotels", "酒店", (value, index) => value.shortName || value.officialName || `酒店${index + 1}`, () => ({ id: uid("hotel"), officialName: "新酒店", shortName: "新酒店", region: "", nights: 1, editorialCopy: "", proofPoints: [], images: [] }))}<Field label="展示名称" value={hotel.shortName} onChange={(value) => updateData((next) => { next.hotels[selection.itemIndex].shortName = value; }, `hotel-short-${selection.itemIndex}`)} /><Field label="酒店正式名称" value={hotel.officialName} onChange={(value) => updateData((next) => { next.hotels[selection.itemIndex].officialName = value; }, `hotel-name-${selection.itemIndex}`)} /><div className="field-grid-compact"><Field label="地区" value={hotel.region} onChange={(value) => updateData((next) => { next.hotels[selection.itemIndex].region = value; }, `hotel-region-${selection.itemIndex}`)} /><Field label="入住晚数" type="number" value={hotel.nights || 1} onChange={(value) => updateData((next) => { next.hotels[selection.itemIndex].nights = value; }, `hotel-nights-${selection.itemIndex}`)} /></div><Field label="酒店介绍" rows={6} value={hotel.editorialCopy} onChange={(value) => updateData((next) => { next.hotels[selection.itemIndex].editorialCopy = value; }, `hotel-copy-${selection.itemIndex}`)} /><Field label="酒店卖点（每行一个）" rows={4} value={(hotel.proofPoints || []).join("\n")} onChange={(value) => updateData((next) => { next.hotels[selection.itemIndex].proofPoints = splitLines(value); }, `hotel-points-${selection.itemIndex}`)} /></>;
  } else if (selection.module === "dining") {
    const item = project.data.diningExperiences?.[selection.itemIndex] || {};
    copyPanel = <><Field label="模块标题" value={project.data.diningSectionTitle || "特色餐饮"} onChange={(value) => updateData((next) => { next.diningSectionTitle = value; }, "dining-section-title")} /><Field label="模块引导标题" value={project.data.diningIntroTitle || ""} onChange={(value) => updateData((next) => { next.diningIntroTitle = value; }, "dining-intro-title")} /><Field label="模块引导文案" rows={3} value={project.data.diningIntroCopy || ""} onChange={(value) => updateData((next) => { next.diningIntroCopy = value; }, "dining-intro-copy")} />{picker("diningExperiences", "餐饮项目", (value, index) => value.title || `餐饮${index + 1}`, () => ({ id: uid("dining"), location: "", title: "新餐饮体验", officialName: "", editorialCopy: "", images: [] }))}<Field label="地点" value={item.location} onChange={(value) => updateData((next) => { next.diningExperiences[selection.itemIndex].location = value; }, `dining-location-${selection.itemIndex}`)} /><Field label="餐饮名称" value={item.title} onChange={(value) => updateData((next) => { next.diningExperiences[selection.itemIndex].title = value; }, `dining-title-${selection.itemIndex}`)} /><Field label="正式/英文名称" value={item.officialName} onChange={(value) => updateData((next) => { next.diningExperiences[selection.itemIndex].officialName = value; }, `dining-official-${selection.itemIndex}`)} /><Field label="餐饮介绍" rows={6} value={item.editorialCopy} onChange={(value) => updateData((next) => { next.diningExperiences[selection.itemIndex].editorialCopy = value; }, `dining-copy-${selection.itemIndex}`)} /></>;
  } else if (selection.module === "transport") {
    const item = project.data.transportSummary?.[selection.itemIndex] || {};
    copyPanel = <><Field label="模块标题" value={project.data.transportSectionTitle || "全程交通"} onChange={(value) => updateData((next) => { next.transportSectionTitle = value; }, "transport-section-title")} /><Field label="模块引导标题" value={project.data.transportIntroTitle || "移动不是赶路，而是旅程体验的一部分"} onChange={(value) => updateData((next) => { next.transportIntroTitle = value; }, "transport-intro-title")} /><Field label="模块引导文案" rows={3} value={project.data.transportIntroCopy || "城市接送、专属游猎、草原飞行与海上衔接各司其职，让跨区域移动保持私密、舒适与从容。"} onChange={(value) => updateData((next) => { next.transportIntroCopy = value; }, "transport-intro-copy")} />{picker("transportSummary", "交通项目", (value, index) => value.category || `交通${index + 1}`, () => ({ id: uid("transport"), category: "新交通项目", serviceLevel: "", usageLabel: "全程专属交通衔接", usageSegments: [], editorialCopy: "", features: [], images: [] }))}<Field label="交通类别" value={item.category} onChange={(value) => updateData((next) => { next.transportSummary[selection.itemIndex].category = value; }, `transport-category-${selection.itemIndex}`)} /><Field label="服务等级" value={item.serviceLevel} onChange={(value) => updateData((next) => { next.transportSummary[selection.itemIndex].serviceLevel = value; }, `transport-level-${selection.itemIndex}`)} /><Field label="客户可见适用场景" value={item.usageLabel || ""} onChange={(value) => updateData((next) => { next.transportSummary[selection.itemIndex].usageLabel = value; }, `transport-usage-label-${selection.itemIndex}`)} /><div className="field-grid-compact"><Field label="参考车型" value={item.model || ""} onChange={(value) => updateData((next) => { next.transportSummary[selection.itemIndex].model = value; }, `transport-model-${selection.itemIndex}`)} /><Field label="座位数" type="number" value={item.seatCount || ""} onChange={(value) => updateData((next) => { next.transportSummary[selection.itemIndex].seatCount = value; }, `transport-seats-${selection.itemIndex}`)} /></div><Field label="交通介绍" rows={5} value={item.editorialCopy} onChange={(value) => updateData((next) => { next.transportSummary[selection.itemIndex].editorialCopy = value; }, `transport-copy-${selection.itemIndex}`)} /><Field label="服务特色（每行一个）" rows={4} value={(item.features || []).join("\n")} onChange={(value) => updateData((next) => { next.transportSummary[selection.itemIndex].features = splitLines(value); }, `transport-features-${selection.itemIndex}`)} /></>;
  } else if (selection.module === "days") {
    const day = selectedDay || {};
    const spots = day.spots || [];
    const spotIndex = Math.min(selection.subItemIndex ?? 0, Math.max(0, spots.length - 1));
    const spot = spots[spotIndex];
    copyPanel = <>{selection.subItemIndex == null ? <><Field label="日期" type="date" value={day.date || ""} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].date = value; }, `day-date-${selection.itemIndex}`)} /><Field label="每日主题" value={day.theme} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].theme = value; }, `day-theme-${selection.itemIndex}`)} /><Field label="路线节点（每行一个）" rows={4} value={(day.routeNodes || []).join("\n")} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].routeNodes = splitLines(value); }, `day-route-${selection.itemIndex}`)} /><Field label="交通与节奏" value={day.vehicle || ""} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].vehicle = value; }, `day-vehicle-${selection.itemIndex}`)} /><div className="field-grid-compact"><Field label="预计车程" value={day.estimatedTravelTime || ""} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].estimatedTravelTime = value; }, `day-time-${selection.itemIndex}`)} /><Field label="活动强度" value={day.activityLevel || ""} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].activityLevel = value; }, `day-level-${selection.itemIndex}`)} /></div><Field label="今日行程" rows={8} value={day.description} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].description = value; }, `day-copy-${selection.itemIndex}`)} /><Field label="今日贴士" rows={3} value={(day.dayNotices?.[0]?.text || day.dayNotices?.[0] || "")} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].dayNotices = value ? [{ type: 'tip', text: value }] : []; }, `day-notice-${selection.itemIndex}`)} /></> : null}<ItemPicker label="景点/体验" items={spots} index={spotIndex} getLabel={(value, index) => value.name || `体验${index + 1}`} onSelect={(subItemIndex) => choose({ ...selection, subItemIndex, imageIndex: 0 })} onAdd={() => { updateData((next) => next.days[selection.itemIndex].spots.push({ name: "新体验", description: "", status: "pending", statusLabel: '待确认', feeBoundary: 'pending', sourceEvidence: [], images: [] }), `add-spot-${Date.now()}`); choose({ ...selection, subItemIndex: spots.length, imageIndex: 0 }); }} onDelete={() => { if (!spot) return; if (!window.confirm("确定删除这个景点/体验吗？可以立即撤销。")) return; updateData((next) => { removeExperienceReferences(next, next.days[selection.itemIndex].spots[spotIndex].name); next.days[selection.itemIndex].spots.splice(spotIndex, 1); }, `delete-spot-${Date.now()}`); choose({ ...selection, subItemIndex: spots.length > 1 ? Math.max(0, spotIndex - 1) : null, imageIndex: 0 }); }} onMove={(delta) => { updateData((next) => { const list = next.days[selection.itemIndex].spots; const target = spotIndex + delta; if (target < 0 || target >= list.length) return; [list[spotIndex], list[target]] = [list[target], list[spotIndex]]; }, `move-spot-${Date.now()}`); choose({ ...selection, subItemIndex: spotIndex + delta }); }} />{selection.subItemIndex != null && spot && <><Field label="体验名称" value={spot.name} onChange={(value) => updateData((next) => { const current = next.days[selection.itemIndex].spots[spotIndex]; removeExperienceReferences(next, current.name); current.name = value; synchronizeExperienceStatus(next, selection.itemIndex, spotIndex, current.status || 'pending'); }, `spot-name-${selection.itemIndex}-${spotIndex}`)} /><label>真实状态<select value={spot.status || 'pending'} onChange={(event) => updateData((next) => { synchronizeExperienceStatus(next, selection.itemIndex, spotIndex, event.target.value); }, `spot-status-${selection.itemIndex}-${spotIndex}`)}><option value="included">已包含</option><option value="optional_paid">自费可选</option><option value="reservation_required">需提前预约</option><option value="pending">待确认</option></select></label><Field label="体验介绍" rows={6} value={spot.experience || spot.description || ""} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].spots[spotIndex].description = value; delete next.days[selection.itemIndex].spots[spotIndex].experience; }, `spot-copy-${selection.itemIndex}-${spotIndex}`)} /><Field label="补充提醒" rows={3} value={spot.reminder || ""} onChange={(value) => updateData((next) => { next.days[selection.itemIndex].spots[spotIndex].reminder = value; }, `spot-reminder-${selection.itemIndex}-${spotIndex}`)} /><Button onClick={() => choose({ ...selection, subItemIndex: null }, "copy")}>返回每日信息</Button></>}</>;
  } else if (selection.module === "expenses") copyPanel = <><Field label="行程总价" type="number" value={project.data.totalPrice || ""} onChange={(value) => updateData((next) => { next.totalPrice = value; }, "price-total")} /><Field label="价格单位" value={project.data.priceUnit || ""} onChange={(value) => updateData((next) => { next.priceUnit = value; }, "price-unit")} /><Field label="报价说明（每行一条）" rows={4} value={(project.data.priceNotes || []).join("\n")} onChange={(value) => updateData((next) => { next.priceNotes = splitLines(value); }, "price-notes")} /><Field label="费用包含（每行一条）" rows={6} value={(project.data.included || []).join("\n")} onChange={(value) => updateData((next) => { next.included = splitLines(value); }, "price-included")} /><Field label="费用不含（每行一条）" rows={6} value={(project.data.excluded || []).join("\n")} onChange={(value) => updateData((next) => { next.excluded = splitLines(value); }, "price-excluded")} /><Field label="退改政策（每行一条）" rows={6} value={(project.data.cancellation || []).join("\n")} onChange={(value) => updateData((next) => { next.cancellation = splitLines(value); }, "price-cancellation")} /></>;
  else if (selection.module === "notes") {
    const note = project.data.notes?.[selection.itemIndex] || {};
    copyPanel = <><Field label="模块标题" value={project.data.notesSectionTitle || "注意事项"} onChange={(value) => updateData((next) => { next.notesSectionTitle = value; }, "notes-section-title")} /><Field label="模块引导文案" rows={3} value={project.data.notesIntro || "下面这些小提醒，会由定制师在行前为您逐项复核，让旅程更从容。"} onChange={(value) => updateData((next) => { next.notesIntro = value; }, "notes-intro")} />{picker("notes", "注意事项", (value, index) => value.title || `注意事项${index + 1}`, () => ({ title: "新注意事项", icon: "warning", tone: "gold", items: [], sourceUrl: '', verifiedAt: '', verificationStatus: 'pending' }))}<Field label="标题" value={note.title} onChange={(value) => updateData((next) => { next.notes[selection.itemIndex].title = value; }, `note-title-${selection.itemIndex}`)} /><Field label="内容（每行一条）" rows={8} value={(note.items || []).join("\n")} onChange={(value) => updateData((next) => { next.notes[selection.itemIndex].items = splitLines(value); }, `note-items-${selection.itemIndex}`)} /><Field label="权威来源网址（时效信息）" value={note.sourceUrl || ''} onChange={(value) => updateData((next) => { next.notes[selection.itemIndex].sourceUrl = value; next.notes[selection.itemIndex].verificationStatus = value && next.notes[selection.itemIndex].verifiedAt ? 'verified' : 'pending'; }, `note-source-${selection.itemIndex}`)} /><Field label="人工复核日期" type="date" value={note.verifiedAt || ''} onChange={(value) => updateData((next) => { next.notes[selection.itemIndex].verifiedAt = value; next.notes[selection.itemIndex].verificationStatus = value && next.notes[selection.itemIndex].sourceUrl ? 'verified' : 'pending'; }, `note-verified-${selection.itemIndex}`)} /></>;
  } else copyPanel = <div className="module-summary"><UiIcon name="security" size={28} /><h3>{selectedModule.label}</h3><p>{selection.module === "booking" ? "预订流程与资金安全提醒为品牌固定内容，只允许整体隐藏。" : "品牌页尾为固定品牌资产，不支持修改。"}</p></div>;

  const collectSlots = () => {
    const moduleMap = { cover: "cover", hotels: "hotel", dining: "dining", transport: "transport", days: "day" };
    return buildLayoutImageSlots(project.data).filter((slot) => slot.module === moduleMap[selection.module] && (slot.module !== "day" || slot.dayIndex === selection.itemIndex)).map((slot) => {
      const image = getSlotImage(project.data, slot) || {};
      return { ...slot, key: slot.slotId, src: image.src || "", focus: image.focus || "50% 50%", fit: image.fit, subItemIndex: slot.spotIndex };
    });
  };
  const slots = collectSlots();
  const currentSlot = slots.find((slot) => slot.itemIndex === selection.itemIndex && slot.subItemIndex === selection.subItemIndex && slot.imageIndex === selection.imageIndex) || slots[0];
  const setImage = (src, focus = currentSlot?.focus || "50% 50%", slot = currentSlot, extra = {}) => updateData((next) => {
    if (!slot) return;
    setSlotImage(next, slot, src ? { src, focus, ...extra } : null);
  }, `image-${slot?.slotId || currentSlot?.slotId}`);
  const setFocus = (x, y) => currentSlot && setImage(currentSlot.src, `${Math.round(x)}% ${Math.round(y)}%`);
  const [focusX, focusY] = String(currentSlot?.focus || "50% 50%").match(/[\d.]+/g)?.map(Number) || [50, 50];
  const selectSlot = (slot) => choose({ ...selection, itemIndex: slot.itemIndex, subItemIndex: slot.subItemIndex, imageIndex: slot.imageIndex }, "image");
  const selectedItemForImage = () => {
    if (selection.module === "hotels") return project.data.hotels?.[selection.itemIndex];
    if (selection.module === "dining") return project.data.diningExperiences?.[selection.itemIndex];
    if (selection.module === "transport") return project.data.transportSummary?.[selection.itemIndex];
    if (selection.module === "days") return selectedDay?.spots?.[selection.subItemIndex ?? 0];
    return null;
  };
  const canAddImage = selection.module === "cover" ? !currentSlot : selectedItemForImage() && imageList(selectedItemForImage()).length < (selection.module === "hotels" ? 1 : 2);
  const addImage = () => {
    fileRef.current?.click();
  };
  const uploadLocalImage = async (file) => {
    if (!file) return;
    const item = selectedItemForImage();
    const uploadSlot = currentSlot || {
      itemIndex: selection.itemIndex,
      subItemIndex: selection.module === "days" ? (selection.subItemIndex ?? 0) : null,
      imageIndex: item ? imageList(item).length : 0,
    };
    try {
      const response = await fetch('/api/images/upload', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error || '图片上传失败');
      updateData((next) => {
      setSlotImage(next, uploadSlot, { src: saved.src, focus: "50% 50%", userProvided: true, sourceTitle: file.name, sha256: saved.sha256 });
      next.imageLocks = { ...(next.imageLocks || {}), [uploadSlot.slotId]: { source: "user_upload", lockedAt: Date.now(), name: file.name } };
      recordImageDecision(next, { slotId: uploadSlot.slotId, action: 'upload', source: 'user_upload', fileName: file.name });
      }, `upload-${uploadSlot.slotId}`);
    } catch (error) { alert(error?.message || '图片上传失败'); }
  };
  const deleteImage = () => {
    if (!currentSlot || selection.module === "cover" || !window.confirm("删除这张图片？可以立即撤销恢复。")) return;
    updateData((next) => { setSlotImage(next, currentSlot, null); next.imageLocks = { ...(next.imageLocks || {}), [currentSlot.slotId]: { source: "user_cleared", lockedAt: Date.now() } }; recordImageDecision(next, { slotId: currentSlot.slotId, action: 'clear', source: 'user_cleared' }); }, `delete-image-${Date.now()}`);
    setSelection({ ...selection, imageIndex: 0 });
  };
  const chooseLibraryImage = (candidate, usedSlot) => {
    if (!currentSlot) return;
    updateData((next) => {
      const moved = moveImageToSlot(next, currentSlot.slotId, usedSlot?.slotId, { src: candidate.localPreviewUrl, focus: "50% 50%", candidateId: candidate.candidateId, userProvided: Boolean(candidate.userProvided), sourcePage: candidate.sourcePage }, candidate.userProvided ? "user_upload" : "user_selection");
      Object.assign(next, moved);
      const chosen = (next.imageCandidates || []).find((item) => item.candidateId === candidate.candidateId);
      if (chosen) chosen.humanDecision = { action: 'adopt', decidedAt: Date.now(), targetSlotId: currentSlot.slotId, sourceSlotId: usedSlot?.slotId || null, originalStatus: chosen.status, originalRisk: chosen.reason || '' };
      recordImageDecision(next, { slotId: currentSlot.slotId, sourceSlotId: usedSlot?.slotId, action: usedSlot ? 'move' : 'adopt', source: candidate.userProvided ? 'user_upload' : 'user_selection', candidateId: candidate.candidateId });
    }, `choose-image-${currentSlot.slotId}-${Date.now()}`);
    setPickerOpen(false);
  };
  const failurePrefix = selection.module === "cover" ? "cover" : selection.module === "days" ? `days:${selection.itemIndex}:` : `${selection.module}:`;
  const moduleFailures = (project.data.imageFailures || []).filter((failure) => String(failure.slot || "").startsWith(failurePrefix));
  const imagePanel = <div className="image-inspector"><div className="image-library"><header><strong>本模块图片位置</strong><span>{slots.filter((slot) => slot.src).length} / {slots.length}</span></header><div className="image-thumbnails">{slots.map((slot) => <button key={slot.key} className={currentSlot?.key === slot.key ? "active" : ""} onClick={() => selectSlot(slot)}>{slot.src ? <img src={slot.src} alt={slot.label} onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.parentElement.classList.add("thumbnail-load-failed"); }} /> : <span className="empty-slot-thumb">缺图</span>}<span>{slot.label}</span></button>)}</div>{!slots.some((slot) => slot.src) && <div className="empty-image-state"><strong>当前模块暂时缺图</strong><span>可以打开换图窗口，从本次行程图片中选择或本地上传。</span>{moduleFailures.map((failure) => <small key={failure.slot}>{failure.label}：{failure.error}</small>)}</div>}</div>{currentSlot && <>{currentSlot.src ? <><div className="focus-preview" onPointerDown={(event) => { const box = event.currentTarget.getBoundingClientRect(); event.currentTarget.setPointerCapture(event.pointerId); setFocus((event.clientX - box.left) / box.width * 100, (event.clientY - box.top) / box.height * 100); }} onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.getBoundingClientRect(); setFocus(Math.max(0, Math.min(100, (event.clientX - box.left) / box.width * 100)), Math.max(0, Math.min(100, (event.clientY - box.top) / box.height * 100))); }}><img src={currentSlot.src} alt="当前选中图片" style={{ objectPosition: currentSlot.focus }} /><span style={{ left: `${focusX}%`, top: `${focusY}%` }} /></div><div className="focus-controls"><label>横向焦点 <span>{Math.round(focusX)}%</span><input type="range" min="0" max="100" value={focusX} onChange={(event) => setFocus(Number(event.target.value), focusY)} /></label><label>纵向焦点 <span>{Math.round(focusY)}%</span><input type="range" min="0" max="100" value={focusY} onChange={(event) => setFocus(focusX, Number(event.target.value))} /></label></div></> : <div className="empty-image-state"><strong>这个位置还没有图片</strong><span>空位置不会显示破图，也不会阻止继续编辑。</span></div>}<div className="image-actions"><Button tone="primary" onClick={() => setPickerOpen(true)}>换图</Button>{currentSlot.src && <Button onClick={() => setFocus(50, 50)}>恢复居中</Button>}</div></>}<input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => { uploadLocalImage(event.target.files?.[0]); event.target.value = ""; }} />{currentSlot?.src && selection.module !== "cover" && <button className="delete-image-button" onClick={deleteImage}>删除当前图片</button>}<p className="image-source">自动图片已经下载保存并检查；本地素材请确认使用权。</p></div>;

  const title = selection.module === "days" ? `DAY ${String(selection.itemIndex + 1).padStart(2, "0")} · ${selectedDay?.theme || selectedDay?.city || "每日行程"}` : selectedModule.label;
  return <main className="editor-page"><StepRail active={3} maxStep={4} onStep={(step) => step === 4 && onVersions()} /><div className="editor-grid">
    <aside className="structure-panel"><header><span><UiIcon name="itinerary" />行程结构</span></header><nav>{MODULES.map((module) => module.id === "days" ? <div key={module.id} className="day-nav-group"><button className={selection.module === "days" ? "active" : ""} onClick={() => selectModule("days", selection.itemIndex)}><span className="nav-dot" />每日行程</button><div>{project.data.days.map((day, index) => <button key={index} className={selection.module === "days" && selection.itemIndex === index ? "active" : ""} onClick={() => selectModule("days", index)}><span>DAY {String(index + 1).padStart(2, "0")}</span><em>{day.city || day.theme}</em></button>)}</div></div> : <button key={module.id} className={selection.module === module.id ? "active" : ""} onClick={() => selectModule(module.id)}><span className="nav-dot" />{module.label}{visibility[module.id] === false && <small>已隐藏</small>}</button>)}</nav></aside>
    <section className="canvas-stage" ref={previewRef} onClick={onPreviewClick} tabIndex="0" aria-label="行程长图预览，使用滚轮、PageDown、Home 或 End 浏览"><div className="workspace-itinerary"><ItineraryComponent data={viewData} /></div></section>
    <aside className="inspector-panel"><header><div><small>{project.revisionMode ? 'REVISION MODE' : 'EDIT CONTENT'}</small><h2>{title}</h2></div><div className="history-actions"><button disabled={!historyRef.current.undo.length} onClick={() => restore("undo")} title="撤销 Ctrl+Z"><UiIcon name="return" />撤销</button><button disabled={!historyRef.current.redo.length} onClick={() => restore("redo")} title="重做 Ctrl+Shift+Z"><UiIcon name="process" />重做</button></div></header>{(copyReview?.needsReview || copyReview?.blocked || project.revisionMode) && <div className="copy-review-banner" role="status"><strong>修订模式 · {copyIssueTargets.length} 个修改位置</strong><span>底层共发现 {copyReviewIssues.length} 条检查记录；图片和版面已保留。普通文案建议可继续修订，也可在正式版本页确认后按当前内容导出；事实、费用、安全或结构问题仍会阻止。</span><div className="copy-review-actions"><Button tone="primary" disabled={copyRepairState?.busy || !copyIssueTargets.some((target) => target.aiRepairable)} onClick={() => onRepairCopy?.('')}>{copyRepairState?.busy && !copyRepairState.targetPath ? 'AI正在修正…' : 'AI修正全部可修项'}</Button><Button disabled={copyRepairState?.busy} onClick={() => onRecheckCopy?.()}>重新检查全部</Button></div>{copyRepairState?.message && <span className="copy-repair-state">{copyRepairState.message}</span>}<div className="copy-review-details">{copyIssueTargets.map((target) => <section key={target.targetPath}><button className="copy-issue-target" onClick={() => selectIssueTarget(target.targetPath)}><b>{target.label}</b><small>{target.ruleIds.join('/') || 'COPY'} · {target.issues.length}条记录</small></button>{target.issues.map((issue, index) => <p key={`${target.targetPath}-${index}`}><em>{issue.ruleIds?.join('/') || issue.ruleId || 'COPY'}</em>{issue.message}</p>)}<div className="copy-target-actions"><Button disabled={copyRepairState?.busy} onClick={() => target.aiRepairable ? onRepairCopy?.(target.targetPath) : onReviewFacts?.()}>{copyRepairState?.busy && copyRepairState.targetPath === target.targetPath ? '正在修正…' : target.aiRepairable ? 'AI修正这项' : '返回确认原始事实'}</Button></div></section>)}</div></div>}<div className="inspector-tabs"><button className={tab === "copy" ? "active" : ""} onClick={() => setTab("copy")}>文案</button>{hasImages && <button className={tab === "image" ? "active" : ""} onClick={() => setTab("image")}>图片</button>}</div>
      {tab === "copy" && <div className="inspector-body">{copyPanel}</div>}
      {tab === "image" && <div className="inspector-body">{imagePanel}</div>}
      <footer className="module-toggle"><div><UiIcon name="city" /><span><strong>模块显示</strong><small>{selectedModule.required ? "品牌固定模块" : "控制是否进入正式版本"}</small></span></div><label className="switch"><input type="checkbox" checked={selectedModule.required || visibility[selectedModule.id] !== false} disabled={selectedModule.required} onChange={(event) => updateVisibility(event.target.checked)} /><span /></label></footer>
    </aside>
  </div>{pickerOpen && currentSlot && <ImagePickerModal data={project.data} targetSlot={currentSlot} onClose={() => setPickerOpen(false)} onChoose={chooseLibraryImage} onResearch={() => onResearchSlot?.(currentSlot.slotId)} onUpload={(file) => { uploadLocalImage(file); setPickerOpen(false); }} />}</main>;
}

function VersionsStep({ project, exporting, exportError, onExport, onBack, onReviewDecision }) {
  const humanReview = project.data.humanReview || {};
  const ready = humanReviewReady(humanReview);
  const exportEligibility = copyExportEligibility(project);
  const warningAccepted = !exportEligibility.requiresWarningAcknowledgement || humanReview.exportWithCopyWarningsConfirmed === true;
  return <main className="flow-page"><StepRail active={4} onStep={(step) => step === 3 && onBack()} /><section className="flow-content versions-content"><header className="flow-heading"><small>STEP 05</small><h1>正式版本</h1><p>每次生成都会冻结当时内容，之后仍可返回草稿继续修改。</p></header>
    <div className="export-hero"><div><UiIcon name="included" size={32} /><h2>{exporting > 0 && exporting < 100 ? "正在生成高清成品" : "生成新的正式版本"}</h2><p>{exporting > 0 && exporting < 100 ? "正在排版并检查超长页尾，请保持此页面打开。" : "输出一张供客户查看的2000px高清长图。"}</p>{exportEligibility.hardBlocked && <p className="export-error">当前仍有事实、费用、安全或结构问题，必须先处理后才能正式导出。</p>}{exportEligibility.hasWarnings && <label><input type="checkbox" checked={humanReview.exportWithCopyWarningsConfirmed === true} onChange={(event) => onReviewDecision('exportWithCopyWarningsConfirmed', event.target.checked)} /> 我已查看全部文案待修项，仍确认按当前内容生成正式版本</label>}<label><input type="checkbox" checked={humanReview.aestheticConfirmed === true} onChange={(event) => onReviewDecision('aestheticConfirmed', event.target.checked)} /> 我已查看完整预览，确认整体审美、层级和客户可读性</label><label><input type="checkbox" checked={humanReview.licenseReviewed === true} onChange={(event) => onReviewDecision('licenseReviewed', event.target.checked)} /> 我已核对最终图片来源和使用权；授权不明素材会在正式发布前替换</label>{!ready && <p className="export-error">人工复核不会阻止进入编辑器，但生成正式客户版本前必须留下确认记录。</p>}{exporting > 0 && exporting < 100 && <div className="export-progress"><span style={{ width: `${exporting}%` }} /><strong>{exporting}%</strong></div>}{exportError && <p className="export-error">{exportError}</p>}</div><Button tone="primary" disabled={!exportEligibility.allowed || !warningAccepted || !ready || (exporting > 0 && exporting < 100)} onClick={onExport}>生成版本</Button></div>
    <div className="version-list"><header><h2>版本历史</h2><span>{project.versions?.length || 0} 个版本</span></header>{project.versions?.length ? project.versions.slice().reverse().map((version, index) => <article key={version.id}><div className="version-index">V{String(project.versions.length - index).padStart(2, "0")}</div><div><strong>{version.name}</strong><span>{formatTime(version.createdAt)} · 2000px</span></div><div className="version-downloads">{version.downloadUrl ? <a href={version.downloadUrl} download>下载高清长图</a> : <span>旧版未生成文件</span>}</div></article>) : <div className="empty-versions">还没有正式版本，点击上方按钮生成。</div>}</div>
  </section></main>;
}

function ProfilePanel({ user, onClose, onSave }) {
  const [profile, setProfile] = useState(() => designerProfile(user));
  const [syncProjects, setSyncProjects] = useState(true);
  const fileRef = useRef(null);
  const update = (key) => (event) => setProfile((current) => ({ ...current, [key]: event.target.value }));
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="profile-panel"><header><div><small>MY PROFILE</small><h2>我的定制师资料</h2><p>保存后将作为新项目的默认封面身份。</p></div><button onClick={onClose}>关闭</button></header><div className="profile-layout"><div className="profile-avatar-editor"><img src={profile.avatar} alt="定制师头像预览" /><Button onClick={() => fileRef.current?.click()}>上传头像</Button><input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setProfile((current) => ({ ...current, avatar: reader.result })); reader.readAsDataURL(file); }} /><small>建议上传清晰正方形照片，系统将自动居中裁切。</small></div><div className="profile-fields"><Field label="定制师姓名" value={profile.name} onChange={(value) => setProfile((current) => ({ ...current, name: value }))} /><Field label="职位" value={profile.role} onChange={(value) => setProfile((current) => ({ ...current, role: value }))} /><Field label="个人介绍" rows={6} value={profile.bio} onChange={(value) => setProfile((current) => ({ ...current, bio: value }))} /><label className="sync-projects"><input type="checkbox" checked={syncProjects} onChange={(event) => setSyncProjects(event.target.checked)} /><span><strong>同步到我的已有项目</strong><small>项目内已单独修改的资料也会被本次资料覆盖。</small></span></label></div></div><footer><Button onClick={onClose}>取消</Button><Button tone="primary" onClick={() => onSave(profile, syncProjects)}>保存资料</Button></footer></section></div>;
}

function AdminPanel({ users, projects, onClose, onToggle, onReset }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="admin-panel"><header><div><small>ADMIN</small><h2>极简管理</h2></div><button onClick={onClose}>关闭</button></header><div className="admin-summary"><div><strong>{users.length}</strong><span>定制师</span></div><div><strong>{projects.length}</strong><span>项目</span></div><div><strong>{projects.reduce((sum, item) => sum + (item.versions?.length || 0), 0)}</strong><span>正式版本</span></div></div><div className="admin-users">{users.map((user) => <article key={user.id}><span>{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><small>{user.login} · {projects.filter((project) => project.ownerId === user.id).length}个项目</small></div><button onClick={() => onReset(user)}>重置PIN</button><button className={user.active === false ? "activate" : "deactivate"} onClick={() => onToggle(user)}>{user.active === false ? "启用" : "停用"}</button></article>)}</div></section></div>;
}

function DeleteDialog({ project, onCancel, onConfirm }) {
  return <div className="modal-backdrop"><section className="confirm-dialog"><UiIcon name="warning" size={34} /><h2>删除“{project.title}”？</h2><p>项目和专属素材将进入回收站。若继续清理正在被历史版本使用的素材，旧版本可能缺图且无法恢复。</p><div><Button onClick={onCancel}>取消</Button><Button tone="danger" onClick={onConfirm}>仍然删除</Button></div></section></div>;
}

export function Workspace({ initialData, ItineraryComponent, agentMode = false }) {
  const storageKeys = agentMode ? AGENT_STORAGE : FIXED_STORAGE;
  const [users, setUsers] = useState(() => readStorage(storageKeys.users, []));
  const [user, setUser] = useState(() => { const session = readStorage(storageKeys.session, null); return readStorage(storageKeys.users, []).find((item) => item.id === session?.userId) || null; });
  const [projects, setProjects] = useState(() => readStorage(storageKeys.projects, []));
  const [projectId, setProjectId] = useState(null);
  const [screen, setScreen] = useState("list");
  const [saveState, setSaveState] = useState("saved");
  const [progress, setProgress] = useState(0);
  const [generationStatus, setGenerationStatus] = useState({ phase: "queued", status: "idle", currentAction: "尚未开始", stats: {}, elapsedMs: 0 });
  const [generationError, setGenerationError] = useState("");
  const [copyRepairState, setCopyRepairState] = useState({ busy: false, targetPath: '', message: '' });
  const [exporting, setExporting] = useState(0);
  const [exportError, setExportError] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [deleteProject, setDeleteProject] = useState(null);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [agentDecisions, setAgentDecisions] = useState({});
  const saveTimer = useRef(null);
  const generationInFlightRef = useRef(false);
  const currentProject = projects.find((project) => project.id === projectId);
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [screen]);
  useEffect(() => {
    if (!agentMode || !currentProject?.agentProjectId || !["confirm", "generate"].includes(screen)) return undefined;
    let stopped = false; let timer;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/agent/projects/${currentProject.agentProjectId}`);
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "无法读取智能体项目");
        if (stopped) return;
        setAgentSnapshot(value);
        setAgentDecisions((existing) => ({ ...Object.fromEntries((value.confirmations || []).filter((item) => item.status === "pending").map((item) => [item.confirmationId, item.choices.find((choice) => choice.recommended)?.choiceId || item.choices[0]?.choiceId])), ...existing }));
        if (["preparing", "planning"].includes(value.project.status)) timer = setTimeout(refresh, 1000);
      } catch (error) { if (!stopped) setGenerationError(error?.message || "无法读取智能体项目"); }
    };
    refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [agentMode, currentProject?.agentProjectId, screen]);
  const commitProjects = (next) => { setProjects(next); try { writeStorage(storageKeys.projects, next); setSaveState('saved'); } catch (error) { setSaveState('error'); alert(error.message); } };
  const updateProject = (nextProject, immediate = false) => {
    const next = { ...nextProject, updatedAt: Date.now() };
    const collection = projects.map((item) => item.id === next.id ? next : item);
    setProjects(collection);
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { try { writeStorage(storageKeys.projects, collection); setSaveState("saved"); } catch (error) { setSaveState("error"); setGenerationError(error?.message || '保存失败，当前编辑尚未持久化'); } }, immediate ? 0 : 2000);
  };
  const attachAgentProject = async (project, files, recognition, sourceSha256) => {
    const workbook = files[0];
    const response = await fetch("/api/agent/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts: recognition.data, report: recognition.report, sourceName: workbook.name, sourceSha256 }) });
    const created = await response.json();
    if (!response.ok) throw new Error(created.error || "无法创建智能体项目");
    const next = { ...project, flowKind: "agent_v1", agentProjectId: created.projectId, workflowStage: created.status === "awaiting_confirmation" ? "agent-awaiting-confirmation" : "agent-planning", title: recognition.data.title || project.title, data: { ...recognition.data, designer: project.data.designer }, recognition: recognition.report, files: files.map((file) => ({ name: file.name, size: file.size, type: file.type, sha256: sourceSha256 })) };
    updateProject(next, true);
    const snapshotResponse = await fetch(`/api/agent/projects/${created.projectId}`);
    if (snapshotResponse.ok) setAgentSnapshot(await snapshotResponse.json());
    return next;
  };
  const continueAgent = async () => {
    if (!currentProject?.agentProjectId) return;
    const pending = (agentSnapshot?.confirmations || []).filter((item) => item.status === "pending");
    if (pending.length) {
      const response = await fetch(`/api/agent/projects/${currentProject.agentProjectId}/confirmations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: pending.map((item) => ({ confirmationId: item.confirmationId, choiceId: agentDecisions[item.confirmationId] })) }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "无法保存关键确认");
      const latestResponse = await fetch(`/api/agent/projects/${currentProject.agentProjectId}`);
      const latest = latestResponse.ok ? await latestResponse.json() : value;
      setAgentSnapshot(latest);
      if (latest.project?.status === "awaiting_confirmation") return;
    }
    setProgress(0); setGenerationError(""); setScreen("generate");
  };
  const cancelAgent = async () => {
    if (!currentProject?.agentProjectId || !window.confirm("确认取消当前智能体任务？项目、确认和计划记录会保留，已发生的调用无法撤销。")) return;
    const response = await fetch(`/api/agent/projects/${currentProject.agentProjectId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || "无法取消任务"); setAgentSnapshot(value);
  };
  const createProject = () => { const data = clone(initialData); data.designer = designerProfile(user); const project = { id: uid("project"), flowKind: agentMode ? "agent_v1" : "fixed_v1", ownerId: user.id, title: "新的定制行程", customerName: "", requirements: "", data, files: [], workflowStage: "draft", visibility: {}, versions: [], updatedAt: Date.now() }; commitProjects([project, ...projects]); setAgentSnapshot(null); setProjectId(project.id); setScreen("upload"); };
  const openProject = (project) => {
    if (agentMode) { setProjectId(project.id); setAgentSnapshot(null); setScreen(project.files?.length ? "confirm" : "upload"); return; }
    if (project.data?.notes?.some((item) => typeof item === 'string')) {
      const issues = [{ ruleIds:['COPY-013'], ruleId:'COPY-013', code:'notes_legacy_structure', path:'notes', message:'历史字符串注意事项已转换为分组展示，仍需复核后才能正式导出', severity:'quality', action:'manual_revision' }];
      const normalized = { ...project, workflowStage:'needs-copy-revision', revisionMode:false, data:{ ...project.data, notes:normalizeLegacyNotesForDisplay(project.data.notes), copyQuality:{ ...(project.data.copyQuality || {}), version:'5.0', passed:false, status:'needs_copy_revision', needsReview:true, remainingIssueCount:issues.length, allIssues:issues } }, aiGeneration:{ ...(project.aiGeneration || {}), contentQuality:{ ...(project.aiGeneration?.contentQuality || {}), version:'5.0', passed:false, status:'needs_copy_revision', needsReview:true, remainingIssueCount:issues.length, allIssues:issues } } };
      const next = projects.map((item) => item.id === normalized.id ? normalized : item);
      commitProjects(next);
      project = normalized;
    }
    setProjectId(project.id);
    if (project.workflowStage === 'needs-copy-revision' || project.workflowStage === 'blocked') {
      const blocked = project.workflowStage === 'blocked';
      setProgress(98);
      setGenerationStatus({ status: blocked ? 'blocked' : 'needs_copy_revision', phase: blocked ? 'blocked' : 'needs_copy_revision', currentAction: blocked ? '该项目存在阻断问题' : '该项目仍需文案修订', contentQuality: project.aiGeneration?.contentQuality || project.data?.copyQuality, elapsedMs: 0 });
      if (!project.revisionMode) updateProject({ ...project, revisionMode: true }, true);
      setScreen('editor');
      return;
    }
    setScreen(project.workflowStage === "generated" || project.workflowStage === "image-review" || project.revisionMode ? "editor" : project.files?.length ? "confirm" : "upload");
  };
  const generateProject = async () => {
    if (!currentProject || generationInFlightRef.current || (progress > 0 && progress < 100)) return;
    generationInFlightRef.current = true;
    setGenerationError("");
    setProgress(3);
    setGenerationStatus({ phase: "queued", status: "queued", currentAction: "任务已排队，准备生成", stats: {}, elapsedMs: 0 });
    try {
      const response = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: currentProject.data, context: { specialRequests: currentProject.requirements || "", disableCopyCache: window.__SHEYOU_REAL_VALIDATION_DISABLE_COPY_CACHE__ === true } }) });
      let result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法创建生成任务");
      const deadline = Date.now() + 60 * 60 * 1000;
      while (!["complete", "needs_copy_revision", "blocked", "failed"].includes(result.status)) {
        if (Date.now() > deadline) throw new Error("生成任务超过60分钟，请检查网络或稍后重试");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const statusResponse = await fetch(`/api/jobs/${result.id}`);
        result = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(result.error || "无法读取生成进度");
        setProgress(Math.max(3, Math.min(99, result.progress || 3)));
        setGenerationStatus(result);
      }
      if (result.status === "failed") throw new Error(result.error || "内容生成失败");
      const workflowStage = result.status === 'complete' ? 'generated' : result.status === 'needs_copy_revision' ? 'needs-copy-revision' : 'blocked';
      updateProject({ ...currentProject, workflowStage, revisionMode: result.status !== 'complete', data: { ...result.data, designer: currentProject.data.designer }, aiGeneration: { taskId: result.id, model: result.model, usage: result.usage, contentQuality: result.contentQuality, imageResearch: result.imageResearch, imageBlueprint: result.imageBlueprint, finalLayoutReview: result.finalLayoutReview, generatedAt: Date.now() } }, true);
      setGenerationStatus(result);
      setProgress(result.status === 'complete' ? 100 : Number(result.progress || 98));
      setScreen("editor");
    } catch (error) {
      setGenerationError(error?.message || "内容生成失败，请重试");
      setProgress(0);
    } finally {
      generationInFlightRef.current = false;
    }
  };
  const decideImage = (slotId, action, candidate) => {
    if (!currentProject) return;
    let data = clone(currentProject.data);
    const decidedAt = Date.now();
    const slot = data.imageReview?.slots?.find((item) => item.slotId === slotId);
    if (!slot) return;
    const matching = (data.imageCandidates || []).filter((item) => item.slotId === slotId);
    if (action === "adopt" && candidate?.adoptable !== false && candidate?.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW) {
      data = applyImageToSlot(data, slotId, [{ src: candidate.localPreviewUrl, focus: "50% 50%", sourcePage: candidate.sourcePage }]);
      const chosen = data.imageCandidates.find((item) => item.slotId === slotId && item.candidateId === candidate.candidateId && item.attempt === candidate.attempt);
      if (chosen) chosen.humanDecision = { action: "adopt", decidedAt, originalStatus: candidate.status, originalRisk: candidate.reason || "" };
      const updatedSlot = data.imageReview.slots.find((item) => item.slotId === slotId);
      updatedSlot.status = "human_selected"; updatedSlot.selectedCandidateIds = [candidate.candidateId];
    } else if (action === "reject" && candidate) {
      const rejected = data.imageCandidates.find((item) => item.slotId === slotId && item.candidateId === candidate.candidateId && item.attempt === candidate.attempt);
      if (rejected) rejected.humanDecision = { action: "reject", decidedAt, originalStatus: candidate.status, originalRisk: candidate.reason || "" };
    } else if (action === "empty") {
      slot.status = "left_empty"; slot.selectedCandidateIds = [];
      matching.forEach((item) => { if (item.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW && !item.humanDecision) item.humanDecision = { action: "left_empty", decidedAt, originalStatus: item.status, originalRisk: item.reason || "" }; });
    } else if (action === "upload" && candidate?.src) {
      data = applyImageToSlot(data, slotId, [{ src: candidate.src, focus: "50% 50%" }]);
      const updatedSlot = data.imageReview.slots.find((item) => item.slotId === slotId);
      updatedSlot.status = "uploaded"; updatedSlot.upload = { name: candidate.name || "本地素材", decidedAt, source: "user_upload" };
    }
    const pendingCount = pendingImageReviewSlots(data.imageReview).length;
    data.imageReview.pendingCount = pendingCount; data.imageReview.updatedAt = decidedAt;
    updateProject({ ...currentProject, workflowStage: pendingCount ? "image-review" : currentProject.workflowStage, data }, true);
  };
  const researchImageSlot = async (slotId) => {
    if (!currentProject) return;
    setGenerationError("");
    const response = await fetch("/api/images/research-slot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: currentProject.data, slotId }) });
    let job = await response.json();
    if (!response.ok) throw new Error(job.error || "无法创建单图片位重搜任务");
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!["complete", "failed"].includes(job.status)) {
      if (Date.now() > deadline) throw new Error("单图片位重搜超过10分钟");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const statusResponse = await fetch(`/api/jobs/${job.id}`);
      job = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(job.error || "无法读取重搜进度");
    }
    if (job.status === "failed") throw new Error(job.error || "单图片位重搜失败");
    updateProject({ ...currentProject, workflowStage: "generated", data: { ...job.data, designer: currentProject.data.designer }, aiGeneration: { ...(currentProject.aiGeneration || {}), imageResearch: job.imageResearch } }, true);
  };
  const exportProject = async () => {
    if (!currentProject || (exporting > 0 && exporting < 100)) return;
    const exportEligibility = copyExportEligibility(currentProject);
    if (!exportEligibility.allowed) { setExportError('仍有事实、费用、安全或结构问题，不能生成正式版本。'); return; }
    if (exportEligibility.requiresWarningAcknowledgement && currentProject.data.humanReview?.exportWithCopyWarningsConfirmed !== true) { setExportError('请先确认已查看全部文案待修项。'); return; }
    setExportError("");
    setExporting(5);
    try {
      const response = await fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: visibilityData(currentProject.data, currentProject.visibility || {}), options: { allowCopyReviewPending: exportEligibility.hasWarnings } }) });
      const created = await response.json();
      if (!response.ok) throw new Error(created.error || "无法创建生成任务");
      let job = created;
      const deadline = Date.now() + 20 * 60 * 1000;
      while (job.status !== "complete" && job.status !== "failed") {
        if (Date.now() > deadline) throw new Error("生成时间超过20分钟，请稍后重试");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const statusResponse = await fetch(`/api/jobs/${job.id}`);
        job = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(job.error || "无法读取生成进度");
        setExporting(job.status === "rendering" ? Math.max(18, Math.min(92, job.progress || 65)) : job.progress || 8);
      }
      if (job.status === "failed") throw new Error(job.error || "长图生成失败");
      const version = { id: uid("version"), name: `${currentProject.title} · 正式版${exportEligibility.hasWarnings ? '（带文案确认）' : ''}`, createdAt: Date.now(), snapshot: versionSnapshot(currentProject.data), downloadUrl: job.downloadUrl, exportWithCopyWarnings: exportEligibility.hasWarnings, warningAcknowledgedAt: exportEligibility.hasWarnings ? currentProject.data.humanReview?.updatedAt : null };
      updateProject({ ...currentProject, versions: [...(currentProject.versions || []), version] }, true);
      setExporting(100);
    } catch (error) {
      setExportError(error?.message || "生成失败，请重试");
      setExporting(0);
    }
  };
  const recheckCopy = async ({ navigateOnPass = false } = {}) => {
    if (!currentProject) return;
    setExportError('');
    setCopyRepairState({ busy: true, targetPath: '', message: '正在用完整品牌规则重新检查…' });
    try {
      const response = await fetch('/api/copy/recheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: currentProject.data }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '文案复检失败');
      const passed = result.contentQuality?.passed === true;
      const nextProject = { ...currentProject, workflowStage: passed ? 'generated' : result.contentQuality?.blocked ? 'blocked' : 'needs-copy-revision', revisionMode: !passed, data: { ...result.data, humanReview: { ...(result.data?.humanReview || currentProject.data.humanReview || {}), exportWithCopyWarningsConfirmed: false }, designer: currentProject.data.designer }, aiGeneration: { ...(currentProject.aiGeneration || {}), contentQuality: result.contentQuality } };
      updateProject(nextProject, true);
      setProgress(passed ? 100 : 98);
      setGenerationStatus({ status: passed ? 'complete' : result.contentQuality?.blocked ? 'blocked' : 'needs_copy_revision', phase: passed ? 'complete' : result.contentQuality?.blocked ? 'blocked' : 'needs_copy_revision', currentAction: passed ? '文案复检通过，正式导出已解锁' : `仍有 ${result.contentQuality?.remainingIssueCount || 0} 个问题需要处理`, contentQuality: result.contentQuality });
      setCopyRepairState({ busy: false, targetPath: '', message: passed ? '复检通过，已解锁正式导出。' : `复检后仍有 ${result.contentQuality?.remainingIssueCount || 0} 条检查记录。` });
      if (passed && navigateOnPass) setScreen('versions');
    } catch (error) {
      const message = error?.message || '文案复检失败';
      setExportError(message);
      setCopyRepairState({ busy: false, targetPath: '', message });
    }
  };
  const repairCopy = async (targetPath = '') => {
    if (!currentProject || copyRepairState.busy) return;
    setExportError('');
    setCopyRepairState({ busy: true, targetPath, message: targetPath ? `正在定点修正 ${targetPath}…` : '正在修正全部可自动处理的问题…' });
    try {
      const response = await fetch('/api/copy/repair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: currentProject.data, targetPath }) });
      let result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法创建文案修正任务');
      const deadline = Date.now() + 20 * 60 * 1000;
      while (!['complete', 'needs_copy_revision', 'blocked', 'failed'].includes(result.status)) {
        if (Date.now() > deadline) throw new Error('文案修正超过20分钟，请稍后重试');
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const statusResponse = await fetch(`/api/jobs/${result.id}`);
        result = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(result.error || '无法读取文案修正进度');
        setCopyRepairState({ busy: true, targetPath, message: result.currentAction || '正在修正文案…' });
      }
      if (result.status === 'failed') throw new Error(result.error || '文案修正失败');
      const passed = result.status === 'complete' && result.contentQuality?.passed === true;
      const nextProject = { ...currentProject, workflowStage: passed ? 'generated' : result.status === 'blocked' ? 'blocked' : 'needs-copy-revision', revisionMode: !passed, data: { ...result.data, humanReview: { ...(result.data?.humanReview || currentProject.data.humanReview || {}), exportWithCopyWarningsConfirmed: false }, designer: currentProject.data.designer }, aiGeneration: { ...(currentProject.aiGeneration || {}), contentQuality: result.contentQuality } };
      updateProject(nextProject, true);
      setProgress(passed ? 100 : 98);
      setGenerationStatus(result);
      setCopyRepairState({ busy: false, targetPath: '', message: passed ? 'AI修正和复检已通过，正式导出已解锁。' : `已完成修正，仍有 ${result.contentQuality?.remainingIssueCount || 0} 条检查记录。` });
    } catch (error) {
      const message = error?.message || '文案修正失败';
      setCopyRepairState({ busy: false, targetPath: '', message });
      setExportError(message);
    }
  };
  const logout = () => { localStorage.removeItem(storageKeys.session); setUser(null); setProjectId(null); setScreen("list"); };
  if (!user) return <AuthScreen storageKeys={storageKeys} onAuth={(nextUser) => { setUsers(readStorage(storageKeys.users, [])); setUser(nextUser); }} />;
  return <div className={`workspace-shell${agentMode ? " workspace-agent-mode" : ""}`}><AppHeader user={user} project={currentProject && !["list", "admin"].includes(screen) ? currentProject : null} saved={saveState} canGenerate={agentMode ? false : copyExportEligibility(currentProject || {}).allowed} onHome={() => setScreen("list")} onLogout={logout} onAdmin={() => setAdminOpen(true)} onProfile={() => setProfileOpen(true)} onGenerate={() => setScreen('versions')} />
    {agentMode && <div className="agent-mode-strip"><span>智能体试验版 · 独立项目数据</span><strong>真实执行能力尚未开放</strong></div>}
    {screen === "list" && <ProjectList user={user} projects={projects} onCreate={createProject} onOpen={openProject} onDelete={agentMode ? undefined : setDeleteProject} />}
    {screen === "upload" && currentProject && <UploadStep project={currentProject} onFiles={async (files, recognition, sourceSha256) => agentMode ? attachAgentProject(currentProject, files, recognition, sourceSha256) : updateProject({ ...currentProject, workflowStage: "uploaded", title: recognition.data.title || currentProject.title, data: { ...recognition.data, designer: currentProject.data.designer }, recognition: recognition.report, files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })) }, true)} onContinue={() => setScreen("confirm")} />}
    {screen === "confirm" && currentProject && <ConfirmStep project={currentProject} agentMode={agentMode} agentSnapshot={agentSnapshot} agentDecisions={agentDecisions} onAgentDecision={(confirmationId, choiceId) => setAgentDecisions((current) => ({ ...current, [confirmationId]: choiceId }))} onChange={(data, metadata = {}) => updateProject({ ...currentProject, ...metadata, data })} onBack={() => setScreen("upload")} onContinue={() => agentMode ? continueAgent().catch((error) => setGenerationError(error?.message || "无法继续")) : (() => { setProgress(0); setGenerationError(""); setGenerationStatus({ phase: "queued", status: "idle", currentAction: "尚未开始", stats: {}, elapsedMs: 0 }); setScreen("generate"); })()} />}
    {screen === "generate" && currentProject && (agentMode ? <AgentGenerationStep project={currentProject} snapshot={agentSnapshot} error={generationError} decisions={agentDecisions} onDecision={(confirmationId, choiceId) => setAgentDecisions((current) => ({ ...current, [confirmationId]: choiceId }))} onConfirm={() => continueAgent().catch((error) => setGenerationError(error?.message || "无法保存确认"))} onReview={() => setScreen("confirm")} onCancel={() => cancelAgent().catch((error) => setGenerationError(error?.message || "无法取消任务"))} /> : <GenerationStep project={currentProject} progress={progress} status={generationStatus} error={generationError} onStart={generateProject} onReview={() => setScreen("confirm")} onEdit={() => setScreen("editor")} onRevision={() => { updateProject({ ...currentProject, revisionMode: true }, true); setScreen('editor'); }} />)}
    {!agentMode && screen === "editor" && currentProject && <Editor project={currentProject} ItineraryComponent={ItineraryComponent} onProject={updateProject} onResearchSlot={async (slotId) => { try { await researchImageSlot(slotId); } catch (error) { setGenerationError(error?.message || "当前位置搜索失败"); alert(error?.message || "当前位置搜索失败"); } }} onRepairCopy={repairCopy} onRecheckCopy={() => recheckCopy()} onReviewFacts={() => setScreen('confirm')} copyRepairState={copyRepairState} onVersions={() => setScreen('versions')} defaultDesigner={designerProfile(user)} />}
    {!agentMode && screen === "versions" && currentProject && <VersionsStep project={currentProject} exporting={exporting} exportError={exportError} onExport={exportProject} onBack={() => setScreen("editor")} onReviewDecision={(key, checked) => updateProject({ ...currentProject, data: { ...currentProject.data, humanReview: recordHumanReview(currentProject.data.humanReview, key, checked, user.id) } }, true)} />}
    {adminOpen && <AdminPanel users={users} projects={projects} onClose={() => setAdminOpen(false)} onToggle={(target) => { const next = users.map((item) => item.id === target.id ? { ...item, active: item.active === false } : item); setUsers(next); writeStorage(storageKeys.users, next); }} onReset={(target) => { const next = users.map((item) => item.id === target.id ? { ...item, pin: "123456" } : item); setUsers(next); writeStorage(storageKeys.users, next); alert(`${target.name} 的PIN已重置为 123456`); }} />}
    {profileOpen && <ProfilePanel user={user} onClose={() => setProfileOpen(false)} onSave={(profile, syncProjects) => { const nextUsers = users.map((item) => item.id === user.id ? { ...item, name: profile.name || item.name, profile } : item); const nextUser = nextUsers.find((item) => item.id === user.id); setUsers(nextUsers); setUser(nextUser); writeStorage(storageKeys.users, nextUsers); if (syncProjects) { const nextProjects = projects.map((item) => item.ownerId === user.id ? { ...item, data: { ...item.data, designer: clone(profile) }, updatedAt: Date.now() } : item); commitProjects(nextProjects); } setProfileOpen(false); }} />}
    {!agentMode && deleteProject && <DeleteDialog project={deleteProject} onCancel={() => setDeleteProject(null)} onConfirm={() => { commitProjects(projects.filter((item) => item.id !== deleteProject.id)); setDeleteProject(null); }} />}
  </div>;
}
