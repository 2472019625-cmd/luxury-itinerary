import React, { useEffect, useMemo, useRef, useState } from "react";
import { addDays, isUsableFinalImageSource, mapDaysFromStart, removeExperienceReferences, synchronizeExperienceStatus, validateItineraryFacts } from "./lib/itineraryRules.js";
import { applyImageToSlot, IMAGE_REVIEW_STATE, pendingImageReviewSlots } from "./lib/imageReviewPolicy.js";
import { buildLayoutImageSlots, getSlotImage, listImagePlacements, moveImageToSlot, setSlotImage } from "./lib/imageSlots.js";
import { deriveProjectThumbnail } from "./lib/projectThumbnail.js";
import { safeWriteStorage } from './lib/storageSafety.js';
import { recordImageDecision } from './lib/imageDecisions.js';
import { humanReviewReady, recordHumanReview } from './lib/humanReview.js';
import { collectCopyIssues, copyExportEligibility, generationStateLabel, groupCopyIssueTargets, groupCopyIssues } from './lib/copyIssuePresentation.js';
import { normalizeLegacyNotesForDisplay } from './lib/notesSchema.js';
import { AGENT_DESIGNER_STAGES, SIMPLE_DESIGNER_STAGES, getDesignerCurrentAction, getDesignerHighlights, getDesignerSummary, getDesignerTripTitle } from './lib/agentProgressView.js';
import { readAgentSnapshot, agentDisplayState, displayAgentStages, agentElapsed, agentFailurePresentation } from './lib/agentConnection.js';
import { buildCustomerTravelEntityData } from './lib/travelEntityDisplay.js';
import { normalizeHighlightForDisplay } from './lib/highlightDisplay.js';
import { buildConfirmationActionItems, currentPriceSelection, isChildCountConfirmed, listPriceOffers, matchingPriceOffers, priceOfferKey } from './lib/confirmationActionItems.js';

const STORAGE_USERS = "sheyou-workspace-users-v1";
const STORAGE_SESSION = "sheyou-workspace-session-v1";
const STORAGE_PROJECTS = "sheyou-workspace-projects-v1";
export const AGENT_STORAGE = { users: "sheyou-agent-users-v1", session: "sheyou-agent-session-v1", projects: "sheyou-agent-projects-v1" };
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

export function readStorage(key, fallback) {
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

export function Button({ children, tone = "secondary", icon, className = "", ...props }) {
  return <button className={`ws-button ws-button-${tone} ${className}`} {...props}>{icon && <UiIcon name={icon} />}{children}</button>;
}

export function StepRail({ active, onStep, maxStep = active }) {
  return <div className="step-rail" aria-label="行程制作进度">{STEPS.map(([title, copy], index) => {
    const state = index < active ? "complete" : index === active ? "active" : "future";
    return <button key={title} className={`step-item step-${state}`} onClick={() => onStep?.(index)} disabled={!onStep || index > maxStep}>
      <span className="step-index">{state === "complete" ? <UiIcon name="included" size={19} /> : index + 1}</span>
      <span><strong>{title}</strong><small>{copy}</small></span>
    </button>;
  })}</div>;
}

export function AuthScreen({ onAuth, storageKeys = FIXED_STORAGE, serverLogin, serverRegister, registrationEnabled = false }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ invite: "", name: "", login: "", pin: "" });
  const [error, setError] = useState("");
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (serverLogin) {
      try {
        const authenticated = mode === "register"
          ? await serverRegister({ invite:form.invite.trim(), name:form.name.trim(), login:form.login.trim(), password:form.pin })
          : await serverLogin(form.login.trim(), form.pin);
        return onAuth(authenticated);
      }
      catch (failure) { return setError(failure.message); }
    }
    const users = readStorage(storageKeys.users, []);
    if (mode === "register") {
      if (form.invite.trim() !== DEFAULT_INVITE) return setError("公司邀请码不正确");
      if (!form.name.trim() || form.login.trim().length < 3 || !/^\d{6}$/.test(form.pin)) return setError("请完整填写姓名、登录账号和6位数字PIN");
      if (users.some((user) => user.login === form.login.trim())) return setError("该登录账号已被使用");
      const user = { id: uid("user"), name: form.name.trim(), login: form.login.trim(), pin: form.pin, active: true };
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
      <div className="auth-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>{(!serverLogin || registrationEnabled) && <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>创建账号</button>}</div>
      <form onSubmit={submit}>
        <header><small>WELCOME</small><h2>{mode === "login" ? "回到我的项目" : "创建个人工作区"}</h2><p>{mode === "login" ? (serverLogin ? "使用你的定制师账号和密码登录" : "使用内部账号和6位PIN登录") : "使用公司邀请码创建独立的定制师工作台"}</p></header>
        {mode === "register" && <><label>公司邀请码<input value={form.invite} onChange={update("invite")} placeholder="请输入公司邀请码" /></label><label>姓名<input value={form.name} onChange={update("name")} placeholder="定制师姓名" /></label></>}
        <label>登录账号<input value={form.login} onChange={update("login")} placeholder="至少3个字符" autoComplete="username" /></label>
        <label>{serverLogin ? "密码" : "6位PIN"}<input type="password" inputMode={serverLogin ? undefined : "numeric"} maxLength={serverLogin ? 256 : 6} value={form.pin} onChange={update("pin")} placeholder="••••••" autoComplete="current-password" /></label>
        {error && <p className="form-error"><UiIcon name="warning" />{error}</p>}
        <Button tone="primary" type="submit">{mode === "login" ? "进入工作台" : "创建并进入"}</Button>
      </form>
    </section>
  </main>;
}

export function AppHeader({ user, project, saved, canGenerate, onHome, onLogout, onGenerate, onProfile }) {
  return <header className="workspace-header">
    <button className="header-brand" onClick={onHome}><img src="/assets/logos/logo-gold.png" alt="奢游国际" /><span>行程创建工作台</span></button>
    {project && <div className="header-project"><strong>{project.title}</strong><button aria-label="修改项目名称"><UiIcon name="itinerary" size={16} /></button></div>}
    <div className="header-actions">
      {project && <span className={`save-state save-${saved}`}><UiIcon name={saved === "saved" ? "included" : "warning"} />{saved === "saving" ? "正在保存" : saved === "error" ? "保存失败" : "已保存"}</span>}
      {project && canGenerate && <Button tone="primary" onClick={onGenerate}>生成版本</Button>}
      <div className="user-chip"><button className="user-profile-trigger" onClick={onProfile} title="编辑我的定制师资料">{user.profile?.avatar ? <img src={user.profile.avatar} alt={user.name} /> : <span>{user.name.slice(0, 1)}</span>}<div><strong>{user.profile?.name || user.name}</strong><small>定制师</small></div></button><button onClick={onLogout}>退出</button></div>
    </div>
  </header>;
}

function projectStatusLabel(project) {
  const versionCount = project.versions?.length || 0;
  if (versionCount) return { label: `正式版 v${versionCount}.0`, tone: "formal" };
  const stage = project.workflowStage;
  if (["simple-running", "generating"].includes(stage)) return { label: "制作中", tone: "working" };
  if (["uploaded", "confirmed"].includes(stage)) return { label: "待继续", tone: "waiting" };
  if (["needs-copy-revision", "blocked"].includes(stage)) return { label: "待调整", tone: "attention" };
  return { label: "草稿编辑中", tone: "draft" };
}

function readSessionProjects(storageKeys, user) {
  const projects = readStorage(storageKeys.projects, []);
  if (user?.id !== "shared-demo") return projects;
  const migrationKey = `${storageKeys.projects}-owner-migration-v1`;
  if (localStorage.getItem(migrationKey)) return projects;
  const migrated = projects.map((project) => ({ ...project, ownerId:user.id }));
  try {
    writeStorage(storageKeys.projects, migrated);
    localStorage.setItem(migrationKey, "shared-demo");
    return migrated;
  } catch {
    return projects;
  }
}

function projectTripMeta(project) {
  const days = project.data?.days?.length || 0;
  const customerName = String(project.customerName || project.data?.customerName || "").trim();
  const adults = Number(project.data?.adults ?? project.data?.travelers ?? 0);
  const children = Number(project.data?.children ?? 0);
  const travelerCount = Math.max(0, adults) + Math.max(0, children);
  const travelerText = customerName
    ? `客户：${customerName}${travelerCount ? ` · ${travelerCount}位` : ""}`
    : travelerCount ? `出行人：${travelerCount}位` : "";
  return { daysText: days ? `${days}天${days > 1 ? `${days - 1}晚` : ""}` : "", travelerText };
}

function ProjectThumbnail({ project, inactive = false }) {
  const [latestData, setLatestData] = useState(null);
  const destination = String(project.data?.destination || "").trim();
  const initial = (destination || project.title || "旅").slice(0, 1);
  const thumbnail = deriveProjectThumbnail(project, latestData || project.data || {});
  useEffect(() => {
    let stopped = false;
    setLatestData(null);
    if (!project.agentProjectId) return undefined;
    const apiBase = project.flowKind === "simple_skill_v1" ? "/api/simple/projects" : "/api/agent/projects";
    fetch(`${apiBase}/${project.agentProjectId}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((snapshot) => {
        if (!stopped && snapshot?.result?.data) setLatestData(snapshot.result.data);
      })
      .catch(() => {});
    return () => { stopped = true; };
  }, [project.agentProjectId, project.flowKind, project.updatedAt]);
  return <div className={`project-thumb${inactive ? " project-thumb-inactive" : ""}`} data-thumbnail-source={thumbnail.thumbnailSource}><span className="project-thumb-placeholder"><UiIcon name="itinerary" size={22} /><b>{initial}</b></span>{thumbnail.thumbnailUrl && <img key={thumbnail.thumbnailUrl} src={thumbnail.thumbnailUrl} alt={`${project.title}封面`} loading="lazy" decoding="async" onLoad={(event) => { event.currentTarget.hidden = false; }} onError={(event) => { event.currentTarget.hidden = true; }} />}</div>;
}

function WorkspaceHome({ projects, onCreate, onProjects, onOpen, onTrash }) {
  const recentProjects = [...projects]
    .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
    .slice(0, 3);
  return <main className="workspace-home">
    <section className="workspace-home-hero">
      <div className="workspace-home-intro">
        <small>CREATE A JOURNEY</small>
        <h1>开始创建新行程</h1>
        <p>上传客户报价单，我们会根据真实资料<br />完成行程梳理、内容制作与视觉匹配。</p>
        <div className="workspace-home-actions">
          <Button tone="primary" className="workspace-home-create" onClick={onCreate}><span aria-hidden="true">＋</span>新建行程</Button>
          <button className="workspace-home-projects" onClick={onProjects}>我的项目 <span>{projects.length}</span><b aria-hidden="true">→</b></button>
        </div>
      </div>
      <figure className="workspace-home-visual" aria-label="奢游国际品牌旅行路线">
        <div className="workspace-home-route-art" aria-hidden="true">
          <img src="/assets/brand/workspace-journey-route-reference.png" alt="" />
        </div>
      </figure>
    </section>
    <section className="workspace-recent" aria-labelledby="workspace-recent-title">
      <header className="workspace-recent-heading">
        <div><h2 id="workspace-recent-title">最近项目</h2><p>继续您的创作，或从过往项目获取灵感</p></div>
        {recentProjects.length > 0 && <button onClick={onProjects}>查看全部 <span aria-hidden="true">→</span></button>}
      </header>
      {recentProjects.length > 0 ? <div className="workspace-recent-grid">{recentProjects.map((project) => {
        const status = projectStatusLabel(project);
        const meta = projectTripMeta(project);
        return <article key={project.id} className="workspace-recent-card">
          <button className="workspace-recent-open" onClick={() => onOpen(project)} aria-label={`打开项目：${project.title}`}>
          <div className="workspace-recent-cover"><ProjectThumbnail project={project} /></div>
          <div className="workspace-recent-copy">
            {project.data?.destination && <small>{project.data.destination}</small>}
            <h3>{project.title}</h3>
            <div className="workspace-recent-meta"><span>最后编辑 · {formatTime(project.updatedAt)}</span>{meta.daysText && <span>{meta.daysText}</span>}{meta.travelerText && <span>{meta.travelerText}</span>}</div>
          </div>
          </button>
          <div className="workspace-recent-badges"><span className={`project-status-tag project-status-${status.tone}`}>{status.label}</span><button className="workspace-recent-trash" title="移入回收站" aria-label={`将${project.title}移入回收站`} onClick={(event) => { event.stopPropagation(); onTrash(project); }}><UiIcon name="trash" size={15} /></button></div>
        </article>;
      })}</div> : <div className="workspace-recent-empty"><UiIcon name="itinerary" size={28} /><div><strong>还没有最近项目</strong><p>创建第一份客户行程后，会显示在这里。</p></div></div>}
    </section>
  </main>;
}

function ProjectList({ user, projects, exitingProjectIds = [], onCreate, onOpen, onDelete, onTrash, onRestore, onPermanentDelete, onClearTrash }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState("active");
  const [displayMode, setDisplayMode] = useState("list");
  const trashEnabled = Boolean(onTrash && onRestore);
  const ownedProjects = projects.filter((project) => project.ownerId === user.id);
  const trashCount = ownedProjects.filter((project) => Boolean(project.trashedAt)).length;
  const activeCount = ownedProjects.length - trashCount;
  const visible = ownedProjects.filter((project) => {
    const inSelectedView = trashEnabled ? (view === "trash" ? Boolean(project.trashedAt) : !project.trashedAt) : true;
    return inSelectedView && `${project.title}${project.data?.destination || ""}${project.customerName || ""}`.toLowerCase().includes(query.toLowerCase());
  });
  const exiting = new Set(exitingProjectIds);
  const emptyBecauseOfSearch = Boolean(query.trim());
  return <main className="projects-page">
    <header className="projects-heading"><div><small>{view === "trash" ? "RECYCLE BIN" : "MY JOURNEYS"}</small><div className="projects-title-line"><h1>{view === "trash" ? "回收站" : "我的项目"}</h1><span>{view === "trash" ? `${trashCount} 个待处理项目` : `${activeCount} 个项目`}</span></div><p>{view === "trash" ? "已删除项目可在这里恢复或永久删除。" : "每一份草稿都会自动保存，正式版本可随时重新下载。"}</p></div><div className="projects-heading-actions">{view === "trash" && trashCount > 0 && <button className="clear-trash-action" onClick={() => onClearTrash(ownedProjects.filter((project) => project.trashedAt))}>清空回收站</button>}{trashEnabled && <Button onClick={() => { setView(view === "trash" ? "active" : "trash"); setQuery(""); }}>{view === "trash" ? "返回我的项目" : `回收站${trashCount ? `（${trashCount}）` : ""}`}</Button>}{view === "active" && <Button tone="primary" icon="itinerary" onClick={onCreate}>新建行程</Button>}</div></header>
    <div className="projects-toolbar"><div className="project-search"><UiIcon name="itinerary" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "trash" ? "搜索已删除的项目名称或目的地" : "搜索项目名称、目的地或客户"} /></div>{view === "active" && <div className="project-view-toggle" aria-label="项目展示方式"><button className={displayMode === "list" ? "active" : ""} aria-pressed={displayMode === "list"} onClick={() => setDisplayMode("list")}>列表</button><button className={displayMode === "card" ? "active" : ""} aria-pressed={displayMode === "card"} onClick={() => setDisplayMode("card")}>卡片</button></div>}</div>
    {visible.length ? view === "trash" ? <div className="trash-project-grid">{visible.map((project) => <article key={project.id} className={`trash-project-card${exiting.has(project.id) ? " project-item-exiting" : ""}`}>
      <ProjectThumbnail project={project} inactive />
      <div className="trash-project-copy">{project.data?.destination && <small>{project.data.destination}</small>}<h2>{project.title}</h2><span>删除时间 · {formatTime(project.trashedAt)}</span></div>
      <div className="trash-card-actions"><button className="row-project-action row-restore" onClick={() => onRestore(project)} aria-label={`恢复${project.title}`}>恢复</button><button className="row-project-action row-permanent-delete" onClick={() => onPermanentDelete(project)} aria-label={`永久删除${project.title}`}>永久删除</button></div>
    </article>)}</div> : <div className={`project-list project-list-${displayMode}`}>{visible.map((project) => {
      const status = projectStatusLabel(project);
      const meta = projectTripMeta(project);
      return <article key={project.id} className={`project-row project-row-${displayMode}${exiting.has(project.id) ? " project-item-exiting" : ""}`} onClick={() => onOpen(project)}>
        <ProjectThumbnail project={project} />
        <div className="project-copy">{project.data?.destination && <small>{project.data.destination}</small>}<div className="project-name-line"><h2>{project.title}</h2></div><div className="project-meta"><span>最后编辑 · {formatTime(project.updatedAt)}</span>{meta.daysText && <span>{meta.daysText}</span>}{meta.travelerText && <span>{meta.travelerText}</span>}</div></div>
        {onDelete && <button className="row-delete" onClick={(event) => { event.stopPropagation(); onDelete(project); }} aria-label="删除项目">删除</button>}
        <div className="project-row-actions"><span className={`project-status-tag project-status-${status.tone}`}>{status.label}</span><button className="row-open" onClick={(event) => { event.stopPropagation(); onOpen(project); }}>打开 <span aria-hidden="true">›</span></button>{trashEnabled && <button className="row-trash-action" title="移入回收站" onClick={(event) => { event.stopPropagation(); onTrash(project); }} aria-label={`将${project.title}移入回收站`}><UiIcon name="trash" size={17} /></button>}</div>
      </article>;
    })}</div> : <div className={`empty-projects${view === "trash" ? " empty-projects-trash" : ""}`}><UiIcon name="itinerary" size={36} /><h2>{emptyBecauseOfSearch ? "没有匹配的项目" : view === "trash" ? "回收站是空的" : "还没有项目"}</h2><p>{emptyBecauseOfSearch ? "换个项目名称或目的地试试。" : view === "trash" ? "移入回收站的项目会显示在这里。" : "上传原始报价表，开始第一份客户行程。"}</p>{view === "active" && !emptyBecauseOfSearch && <Button tone="primary" onClick={onCreate}>创建项目</Button>}</div>}
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
      onContinue();
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
  </section></main>;
}

function AgentConfirmationPanel({ confirmations = [], decisions, onDecision, onRetryImage }) {
  const pending = confirmations.filter((item) => item.status === "pending");
  if (!pending.length) return null;
  return <section className="agent-inline-confirm"><header><small>智能体生成前检查</small><h2>这些关键问题需要一次确认</h2><p>只询问事实、费用、履约、安全或必需图片问题；选择会保存为本项目约束。</p></header>{pending.map((item) => <article key={item.confirmationId}><span>{item.category}</span><h3>{item.question}</h3><p>{item.reason}</p>{item.choices.map((choice) => <label key={choice.choiceId} className={choice.previewUrl ? "agent-image-choice" : ""}>{choice.previewUrl && <img src={choice.previewUrl} alt={choice.label} />}<input type="radio" name={item.confirmationId} checked={decisions[item.confirmationId] === choice.choiceId} onChange={() => onDecision(item.confirmationId, choice.choiceId)} /><b>{choice.label}</b>{choice.recommended && <em>建议</em>}<small>{choice.reason}</small>{choice.sourcePage && <a href={choice.sourcePage} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>查看图片来源</a>}</label>)}{item.category === "图片" && item.imageSlotId && onRetryImage && <div className="agent-image-retry"><Button onClick={() => onRetryImage(item.imageSlotId)}>重新搜索这一位置</Button><small>只重跑这个图片位，已完成的文案、核验和其他图片不受影响。</small></div>}</article>)}</section>;
}

function ConfirmationStatus({ actionItems }) {
  const complete = actionItems.length === 0;
  return <section className={`confirmation-status ${complete ? "confirmation-status-complete" : "confirmation-status-pending"}`} role="status"><UiIcon name={complete ? "included" : "warning"} /><div><strong>{complete ? "行程关键信息已确认完整" : `还有 ${actionItems.length} 项信息需要确认`}</strong><p>{complete ? "可以继续制作客户行程。" : "完成以下信息后即可继续制作客户行程。"}</p></div></section>;
}

function formatConfirmedPrice(amount) {
  return Number(amount) > 0 ? `¥${Number(amount).toLocaleString("zh-CN")}` : "待确认";
}

function PriceOfferConfirmation({ project, onChange }) {
  const data = project.data;
  const offers = listPriceOffers(data);
  const selection = currentPriceSelection(project);
  if (offers.length < 2) return null;
  const saveSelection = (nextSelection) => onChange({ ...data, totalPrice: Number(nextSelection.amount) || null, priceUnit: nextSelection.unit || data.priceUnit || "元 / 人" }, {
    confirmationSelections: { ...(project.confirmationSelections || {}), priceOffer: nextSelection },
  });
  const chooseOffer = (offer, matchedBy = "manual") => saveSelection({ mode: "source", sourceKey: priceOfferKey(offer), period: offer.period || "", amount: Number(offer.amount), unit: data.priceUnit || "元 / 人", matchedBy });
  const chooseCustom = () => saveSelection({ mode: "custom", sourceKey: null, amount: selection?.mode === "custom" ? selection.amount : "", unit: selection?.mode === "custom" ? selection.unit : (data.priceUnit || "元 / 人起"), matchedBy: "manual" });
  return <section className="price-offer-section"><header><h3>报价确认</h3><span>选择本次采用的报价</span></header>
    <div className="price-offer-options">{offers.map((offer) => {
      const key = priceOfferKey(offer);
      const checked = selection?.sourceKey === key && selection?.mode !== "custom";
      return <label key={key} className={checked ? "price-offer-option selected" : "price-offer-option"}><input type="radio" name="price-offer" checked={checked} onChange={() => chooseOffer(offer)} /><span><strong>{offer.period || "原报价档期"}</strong><small>{formatConfirmedPrice(offer.amount)} / 人</small></span>{checked && selection?.matchedBy === "date" && <em>已根据出发日期匹配</em>}</label>;
    })}
    <label className={selection?.mode === "custom" ? "price-offer-option selected" : "price-offer-option"}><input type="radio" name="price-offer" checked={selection?.mode === "custom"} onChange={chooseCustom} /><span><strong>自定义本次报价</strong><small>不采用原报价档期，手动填写本次客户价格</small></span></label></div>
    {selection?.mode === "custom" && <div className="price-offer-adjust"><label>本次采用金额 *<input type="number" min="1" value={selection.amount ?? ""} onChange={(event) => saveSelection({ ...selection, amount: event.target.value === "" ? "" : Number(event.target.value), matchedBy: "manual" })} placeholder="请输入金额" /></label><label>计价单位 *<input value={selection.unit || ""} onChange={(event) => saveSelection({ ...selection, unit: event.target.value, matchedBy: "manual" })} placeholder="例如：元 / 人起" /></label></div>}
  </section>;
}

function ConfirmationPreview({ project }) {
  const data = project.data;
  const selection = currentPriceSelection(project);
  const travelers = [Number(data.adults) > 0 ? `${data.adults}位成人` : "", isChildCountConfirmed(project, data) ? `${data.children}位儿童` : ""].filter(Boolean).join(" · ");
  const rows = [
    ["客户", project.customerName || data.customerName], ["目的地", data.destination], ["出发日期", data.startDate], ["返程日期", data.endDate], ["出行人数", travelers],
    ["本次报价", selection ? `${formatConfirmedPrice(selection.amount)} ${selection.unit || ""}` : (Number(data.totalPrice) > 0 ? `${formatConfirmedPrice(data.totalPrice)} ${data.priceUnit || ""}` : "")], ["价格依据", selection?.mode === "custom" ? "本次客户确认报价" : (selection?.period ? `${selection.period} 原报价` : "")],
    ["住宿", data.hotels?.length ? `${data.hotels.length}处` : ""], ["行程", data.days?.length ? `${data.days.length}天${Math.max(0, data.days.length - 1)}晚` : ""], ["特殊要求", project.requirements || "无"],
  ].filter(([, value]) => value !== "" && value != null);
  return <div className="confirmation-preview"><h3>{project.title || data.title || "本次客户行程"}</h3><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>请确认以上信息无误，系统将以此制作客户行程。</p></div>;
}

function ConfirmStep({ project, onChange, onContinue, onBack, agentMode = false, agentSnapshot, agentDecisions = {}, onAgentDecision }) {
  const data = project.data;
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStep, setModalStep] = useState("form");
  const [modalMessage, setModalMessage] = useState("");
  const offers = listPriceOffers(data);
  const selection = currentPriceSelection(project);
  const applyChange = (nextData, metadata) => {
    setModalMessage("");
    onChange(nextData, metadata);
  };
  const savePriceSelection = (offer) => applyChange({ ...data, totalPrice: Number(offer.amount), priceUnit: data.priceUnit || "元 / 人" }, { confirmationSelections: { ...(project.confirmationSelections || {}), priceOffer: { mode: "source", sourceKey: priceOfferKey(offer), period: offer.period || "", amount: Number(offer.amount), unit: data.priceUnit || "元 / 人", matchedBy: "date" } } });
  const update = (key, value) => {
    let next = { ...data, [key]: value };
    if (key === "startDate") {
      next = mapDaysFromStart(next, value);
      if (!data.endDate && value && next.days.length) next.endDate = addDays(value, next.days.length - 1);
      const matches = matchingPriceOffers(value, offers);
      if (matches.length === 1 && (!selection || selection.matchedBy === "date")) {
        const offer = matches[0];
        return applyChange({ ...next, totalPrice: Number(offer.amount), priceUnit: data.priceUnit || "元 / 人" }, { confirmationSelections: { ...(project.confirmationSelections || {}), priceOffer: { mode: "source", sourceKey: priceOfferKey(offer), period: offer.period || "", amount: Number(offer.amount), unit: data.priceUnit || "元 / 人", matchedBy: "date" } } });
      }
    }
    applyChange(next);
  };
  const validation = validateItineraryFacts(data);
  const confirmations = agentSnapshot?.confirmations || [];
  const actionItems = buildConfirmationActionItems({ project, data, validation, confirmations, decisions: agentDecisions });
  const requiredPaths = new Set(actionItems.map((item) => item.path));
  const childrenConfirmed = isChildCountConfirmed(project, data);
  const openModal = (step = actionItems.length ? "form" : "preview") => { setModalMessage(""); setModalStep(step); setModalOpen(true); };
  useEffect(() => {
    if (!modalOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setModalOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [modalOpen]);
  useEffect(() => {
    if (!modalOpen || selection || offers.length < 2 || !data.startDate) return;
    const matches = matchingPriceOffers(data.startDate, offers);
    if (matches.length === 1) savePriceSelection(matches[0]);
  }, [modalOpen]);
  return <main className="flow-page"><StepRail active={1} onStep={(step) => step === 0 && onBack()} /><section className="flow-content">
    <header className="flow-heading"><small>STEP 02</small><h1>确认识别结果</h1><p>系统已整理本次行程资料，请补充少量客户信息后开始制作。</p></header>
    <ConfirmationStatus actionItems={actionItems} />
    <section className="recognition-overview"><header><small>识别摘要</small><h2>{project.title || data.title || data.destination || "本次客户行程"}</h2></header><div><span><strong>{data.destination || "待确认"}</strong><small>目的地</small></span><span><strong>{data.days?.length || 0}天{data.days?.length ? Math.max(0, data.days.length - 1) : 0}晚</strong><small>行程</small></span><span><strong>{data.hotels?.length || 0}处</strong><small>住宿</small></span><span><strong>{data.sourcePosterHighlights?.length || 0}个</strong><small>核心亮点</small></span></div></section>
    <section className="confirmation-entry confirmation-entry-compact"><Button tone="primary" onClick={() => openModal()}>{actionItems.length ? "完善待确认信息" : "查看生成前预览"}</Button></section>
    <div className="flow-footer"><Button onClick={onBack}>返回上传</Button></div>
    {modalOpen && <div className="modal-backdrop confirmation-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirmation-modal-title" onMouseDown={(event) => event.target === event.currentTarget && setModalOpen(false)}><section className="confirmation-modal"><header><div><small>{modalStep === "form" ? "生成前确认" : "生成前预览"}</small><h2 id="confirmation-modal-title">{modalStep === "form" ? "完善客户信息" : "确认本次客户行程"}</h2>{modalStep === "form" && <p>补充本次客户信息，确认后即可预览并开始制作。</p>}</div><button className="confirmation-modal-close" aria-label="关闭" onClick={() => setModalOpen(false)}>×</button></header><div className="confirmation-modal-body">{modalStep === "form" ? <>
      <section className="confirmation-customer-section"><header><h3>客户信息</h3></header><div className="confirmation-modal-fields confirmation-modal-fields-single">{requiredPaths.has("destination") && <label>目的地 *<input value={data.destination || ""} onChange={(event) => update("destination", event.target.value)} /></label>}{requiredPaths.has("title") && <label>项目名称 *<input value={project.title || ""} onChange={(event) => applyChange(data, { title: event.target.value })} /></label>}{(requiredPaths.has("customerName") || project.customerName || data.customerName) && <label>客户称呼 *<input value={project.customerName || data.customerName || ""} onChange={(event) => applyChange(data, { customerName: event.target.value })} placeholder="例如：陈女士" /></label>}</div></section>
      <section className="confirmation-customer-section"><header><h3>出行人数</h3></header><div className="confirmation-modal-fields">{(requiredPaths.has("adults") || Number(data.adults) > 0) && <label>成人 *<input type="number" min="1" step="1" value={data.adults ?? data.travelers ?? ""} onChange={(event) => { const value = event.target.value; if (value === "" || /^\d+$/.test(value)) update("adults", value === "" ? null : Number(value)); }} placeholder="待确认" /></label>}{(requiredPaths.has("children") || childrenConfirmed) && <label>儿童 *<input type="number" min="0" step="1" value={childrenConfirmed ? data.children : ""} onChange={(event) => { const value = event.target.value; if (value === "" || /^\d+$/.test(value)) applyChange({ ...data, children: value === "" ? null : Number(value) }, { confirmationSelections: { ...(project.confirmationSelections || {}), childrenConfirmed: value !== "" } }); }} placeholder="待确认" /></label>}</div></section>
      <section className="confirmation-customer-section"><header><h3>旅行日期</h3></header><div className="confirmation-modal-fields">{(requiredPaths.has("startDate") || data.startDate) && <label>出发日期 *<input type="date" value={data.startDate || ""} onChange={(event) => update("startDate", event.target.value)} /></label>}{(requiredPaths.has("endDate") || data.endDate) && <label>返程日期 *<input type="date" value={data.endDate || ""} onChange={(event) => update("endDate", event.target.value)} /></label>}</div></section>
      <PriceOfferConfirmation project={project} onChange={applyChange} />
      {agentMode && confirmations.some((item) => item.status === "pending") && <AgentConfirmationPanel confirmations={confirmations} decisions={agentDecisions} onDecision={onAgentDecision} />}
      {modalMessage && <p className="confirmation-modal-message" role="alert">{modalMessage}</p>}
    </> : <ConfirmationPreview project={project} />}</div><footer><Button onClick={() => modalStep === "preview" ? setModalStep("form") : setModalOpen(false)}>{modalStep === "preview" ? "返回修改" : "取消"}</Button><Button tone="primary" onClick={() => { if (modalStep === "form") { const pending = buildConfirmationActionItems({ project, data, validation: validateItineraryFacts(data), confirmations, decisions: agentDecisions }); if (pending.length) return setModalMessage(pending.length === 1 ? pending[0].description : `请先完成：${pending.map((item) => item.title).join("、")}`); setModalMessage(""); return setModalStep("preview"); } return onContinue(); }}>{modalStep === "form" ? "下一步：确认预览" : "确认并开始生成"}</Button></footer></section></div>}
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

function buildAgentProgress(snapshot) {
  const project = snapshot?.project;
  const plan = snapshot?.plan;
  if (project?.flowKind === "simple_skill_v1") {
    const activeJob = snapshot?.activeJob;
    const backend = new Map((activeJob?.stages || []).map((stage) => [stage.id, stage]));
    const states = { complete: "complete", running: "active", failed: "failed", cancelled: "cancelled", pending: "pending" };
    const stages = SIMPLE_DESIGNER_STAGES.map((definition) => {
      const actualStages = (definition.sourceKeys || [definition.key]).map((key) => backend.get(key));
      const statuses = actualStages.map((stage) => stage?.status || "pending");
      let state = project.status === "complete" ? "complete" : "pending";
      if (statuses.includes("failed")) state = "failed";
      else if (statuses.length && statuses.every((status) => status === "complete")) state = "complete";
      else if (statuses.some((status) => status === "running" || status === "complete")) state = "active";
      else if (statuses.includes("cancelled")) state = "cancelled";
      else if (statuses.length) state = states[statuses[0]] || "pending";
      let stageProgress = state === "complete" ? 1 : state === "active" ? 0.12 : 0;
      if (definition.key === "content_creation") {
        const copy = activeJob?.copyTaskProgress;
        const images = activeJob?.imageSlotProgress;
        const copyStage = backend.get("copy_skill");
        const imageStage = backend.get("image_skill");
        const copyRatio = copy?.total > 0 ? Math.min(1, copy.completed / copy.total) : copyStage?.status === "complete" ? 1 : 0;
        const imageRatio = images?.total > 0 ? Math.min(1, images.completed / images.total) : imageStage?.status === "complete" ? 1 : 0;
        stageProgress = state === "complete" ? 1 : (copyRatio * 18 + imageRatio * 60) / 78;
      }
      return { ...definition, state, progress: stageProgress };
    });
    return { stages, percent: Number(activeJob?.progress ?? run?.progress ?? project.progress ?? 0), planActive: Boolean(plan) };
  }
  const planActive = Boolean(plan?.validation?.passed && project?.activePlanId === plan?.planId);
  if (run?.progress?.stages?.length) {
    const backend = new Map(run.progress.stages.map((stage) => [stage.id, stage]));
    const states = { complete: "complete", running: "active", waiting_confirmation: "waiting", failed: "failed", pending: "pending" };
    const stages = AGENT_DESIGNER_STAGES.map((definition) => {
      const actual = backend.get(definition.key);
      return { ...definition, state: states[actual?.status] || "pending", progress: actual?.totalTasks ? actual.completedTasks / actual.totalTasks : actual?.status === "complete" ? 1 : 0 };
    });
    if (project?.status === "cancelled") stages.forEach((stage) => { if (!["complete", "failed"].includes(stage.state)) stage.state = "cancelled"; });
    return { stages, percent: Number(run.progress.percent || 0), planActive };
  }
  const stages = AGENT_DESIGNER_STAGES.map((definition) => {
    if (definition.key === "planning") {
      if (planActive) return { ...definition, state: "complete", progress: 1 };
      if (project?.status === "planning_failed") return { ...definition, state: "failed", progress: 0 };
      return { ...definition, state: project?.status === "planning" ? "active" : "pending", progress: 0 };
    }
    return { ...definition, state: "pending", progress: 0 };
  });
  if (project?.status === "cancelled") stages.forEach((stage) => { if (!["complete", "failed"].includes(stage.state)) stage.state = "cancelled"; });
  const formallyComplete = ["completed", "ready_for_editor"].includes(project?.status) && stages.every((stage) => stage.state === "complete");
  const percent = formallyComplete ? 100 : Math.min(99, Math.floor(stages.reduce((sum, stage) => sum + stage.progress, 0) / stages.length * 100));
  return { stages, percent, planActive };
}

function useAnimatedProgress(target, enabled = true) {
  const [displayValue, setDisplayValue] = useState(target);
  const valueRef = useRef(target);
  useEffect(() => {
    const next = Math.round(Math.max(0, Math.min(100, Number(target) || 0)));
    const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!enabled || reducedMotion || Math.abs(next - valueRef.current) < 1) {
      valueRef.current = next;
      setDisplayValue(next);
      return undefined;
    }
    let frameId = 0;
    let lastStepAt = performance.now();
    const animate = (now) => {
      if (now - lastStepAt >= 80) {
        const direction = next > valueRef.current ? 1 : -1;
        valueRef.current += direction;
        setDisplayValue(valueRef.current);
        lastStepAt = now;
      }
      if (valueRef.current !== next) frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [enabled, target]);
  return displayValue;
}

function agentRouteProgress(stages, completed = false) {
  if (completed) return 100;
  const activeIndex = stages.findIndex((stage) => ["active", "waiting", "failed", "unknown"].includes(stage.state));
  let fallbackIndex = 0;
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index].state === "complete") {
      fallbackIndex = index;
      break;
    }
  }
  const index = activeIndex >= 0 ? activeIndex : fallbackIndex;
  const stage = stages[index] || stages[0];
  const start = Number(stage?.routePosition || 0);
  const end = Number(stages[index + 1]?.routePosition ?? 100);
  const ratio = stage?.state === "complete" ? 1 : Math.max(0, Math.min(0.92, Number(stage?.progress || 0)));
  return Math.round(start + (end - start) * ratio);
}

function AgentProgressOverview({ snapshot, elapsed }) {
  const progress = buildAgentProgress(snapshot);
  const display = agentDisplayState(snapshot);
  progress.stages = displayAgentStages(progress.stages, display);
  const safeProgress = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const animatedProgress = useAnimatedProgress(safeProgress, !display.failed && !display.disconnected);
  const routeTarget = agentRouteProgress(progress.stages, display.completed);
  const animatedRouteProgress = useAnimatedProgress(routeTarget, !display.failed && !display.disconnected);
  const labels = { complete: "已完成", active: "进行中", waiting: "等待确认", failed: "失败", cancelled: "已取消", pending: display.failed ? "未执行" : "等待处理", unknown: "状态待确认" };
  const latestEvent = snapshot?.executionRun?.events?.at(-1);
  const waitingReason = latestEvent?.waitingReason ? "有一项重要信息需要你确认，保存后会从当前位置继续制作。" : snapshot?.project?.status === "awaiting_confirmation" ? "有一项重要信息需要你确认，保存后会从当前位置继续制作。" : snapshot?.project?.status === "awaiting_user_action" ? "部分内容需要在编辑页补充或确认，不影响你先查看和调整草稿。" : "";
  const imageSlots = snapshot?.activeJob?.imageSlotProgress;
  const copyTasks = snapshot?.activeJob?.copyTaskProgress;
  const detailedAction = getDesignerCurrentAction(snapshot);
  const copyComplete = copyTasks?.total > 0 && copyTasks.completed >= copyTasks.total;
  const imageComplete = imageSlots?.total > 0 && imageSlots.completed >= imageSlots.total;
  const imageActive = imageSlots?.total > 0 && !imageComplete;
  const copyActive = copyTasks?.total > 0 && !copyComplete;
  const actionStage = progress.stages.find((stage) => {
    if (stage.state !== "active") return false;
    if (/文案|介绍|图片|主视觉/.test(detailedAction)) return stage.key === "content_creation" || stage.key === "copy" || stage.key === "images";
    if (/读取|整理/.test(detailedAction)) return stage.key === "parser";
    if (/节奏|亮点/.test(detailedAction)) return stage.key === "planner" || stage.key === "planning";
    if (/费用|原始资料|晚数/.test(detailedAction)) return stage.key === "program_writeback" || stage.key === "final_checks" || stage.key === "verification";
    if (/长图/.test(detailedAction)) return stage.key === "renderer" || stage.key === "render";
    return false;
  }) || progress.stages.find((stage) => stage.state === "active") || progress.stages.find((stage) => stage.state === "waiting");
  const failedStage = progress.stages.find((stage) => stage.state === "failed");
  const mascotProgress = animatedRouteProgress;
  const failure = agentFailurePresentation(snapshot, failedStage?.label);
  const contentHeadline = imageActive && !copyActive ? "正在为这份客户行程挑选合适的视觉素材" : imageActive && copyActive ? "正在完善客户文案与视觉素材" : copyActive ? "正在把确认资料整理成客户可读的行程内容" : "";
  const primaryStatus = display.disconnected ? "正在重新获取制作状态" : display.failed ? "本次生成已停止" : display.completed ? "生成完成" : contentHeadline || (actionStage ? `${actionStage.state === "waiting" ? "等待确认：" : "正在"}${actionStage.label}` : detailedAction);
  const auxiliaryParts = display.disconnected ? ["以下为最后已知进度，后台任务可能仍在继续"] : display.failed ? [`停止于「${failure.stageLabel}」；${failure.userMessage}，后续步骤未继续执行`] : display.completed ? ["客户版行程已制作完成，可以继续调整文案、图片和版式"] : [
    copyTasks?.total > 0 ? copyComplete ? "客户文案已整理完成" : `正在完善客户文案 ${copyTasks.completed} / ${copyTasks.total}` : "",
    imageSlots?.total > 0 ? imageComplete ? `图片位已完成匹配 ${imageSlots.completed} / ${imageSlots.total}` : `已完成 ${imageSlots.completed} / ${imageSlots.total} 个图片位` : "",
    detailedAction !== primaryStatus ? detailedAction : "",
  ].filter(Boolean);
  const progressNote = !display.failed && !display.completed && imageActive ? "图片会逐张核对地点、主体和清晰度，因此通常比文案整理需要更长时间。" : "";
  const displayMode = display.failed ? "failed" : display.completed ? "completed" : display.disconnected ? "disconnected" : "running";
  return <section className={`agent-progress-overview agent-progress-card-${displayMode}`} aria-labelledby="designer-progress-title">
    <header><h2 id="designer-progress-title">客户行程制作进度</h2><span>{display.disconnected ? "最后同步" : "已用时"} {Math.floor(elapsed / 60)}分{elapsed % 60}秒</span></header>
    <div className="agent-progress-total" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={safeProgress} aria-label="客户行程制作进度">
      <div className="agent-progress-headline"><strong><span>{animatedProgress}</span><sup>%</sup></strong><div><div className="agent-progress-status-line"><h3 aria-live="polite">{primaryStatus}</h3>{display.failed && <span className="agent-progress-stop-tag">已终止</span>}</div>{auxiliaryParts.length > 0 && <div className="agent-progress-details" aria-live="polite">{[...new Set(auxiliaryParts)].map((item) => <span key={item}>{item}</span>)}</div>}{progressNote && <p className="agent-progress-note">{progressNote}</p>}</div></div>
      <div className={`agent-progress-route agent-progress-route-${displayMode}`}>
        <div className="agent-progress-route-inner">
          <div className="agent-progress-mascot" style={{ left: `${mascotProgress}%` }} aria-hidden="true">
            <span className="agent-progress-mascot-body"><img src="/assets/logos/logo-gold.svg" alt="" /></span>
          </div>
          <div className="agent-progress-route-track"><span style={{ width: `${animatedRouteProgress}%` }} /></div>
          <div className="agent-progress-route-nodes" aria-hidden="true">
            {progress.stages.map((stage) => <span className={`agent-progress-route-node agent-progress-route-node-${stage.state}`} style={{ left: `${stage.routePosition ?? 0}%` }} key={stage.key}><i /><b>{stage.shortLabel}</b></span>)}
          </div>
        </div>
      </div>
    </div>
    <ol>{progress.stages.map((stage) => <li className={`agent-progress-${stage.state}`} key={stage.key}><i aria-hidden="true">{stage.state === "complete" && <UiIcon name="included" size={13} />}</i><span>{stage.label}</span><em>{labels[stage.state]}</em></li>)}</ol>
    {waitingReason && <p className="agent-progress-wait">{waitingReason}</p>}
  </section>;
}

function AgentGenerationStep({ project, snapshot, error, onReview, onCancel, onEdit, decisions, onDecision, onConfirm, onRetryImage }) {
  const agentProject = snapshot?.project;
  const run = snapshot?.executionRun;
  const display = agentDisplayState(snapshot);
  const elapsed = agentProject?.createdAt ? agentElapsed(snapshot) : 0;
  const waiting = ["awaiting_confirmation", "awaiting_user_action"].includes(agentProject?.status);
  const draft = agentProject?.status === "partial";
  const failed = display.failed;
  const cancelled = agentProject?.status === "cancelled";
  const ready = ["ready_for_editor", "complete"].includes(agentProject?.status);
  const tripTitle = getDesignerTripTitle(snapshot, project);
  const highlights = getDesignerHighlights(snapshot, project);
  const progress = buildAgentProgress(snapshot);
  const displayedStages = displayAgentStages(progress.stages, display);
  const failure = agentFailurePresentation(snapshot, displayedStages.find((stage) => stage.state === "failed")?.label);
  const summary = display.disconnected ? "暂时无法获取最新制作状态，后台可能仍在运行。正在重新获取状态，请不要重复开始生成。" : failed ? `「${tripTitle}」本次生成在「${failure.stageLabel}」遇到问题，已停止继续处理。${failure.userMessage}。` : getDesignerSummary(snapshot);
  return <main className="flow-page"><StepRail active={2} /><section className="generation-page agent-workspace-generation">
    <div className="generation-main agent-designer-summary"><header><small>本次定制摘要</small><h1>{display.disconnected ? `「${tripTitle}」连接异常，正在确认制作状态` : failed ? "生成已终止" : ready ? "生成完成" : draft ? `「${tripTitle}」可编辑草稿已生成` : waiting ? `「${tripTitle}」需要你的确认` : cancelled ? `「${tripTitle}」已取消` : `正在制作「${tripTitle}」`}</h1><p>{summary}</p></header>
      <section className="agent-fact-assurance" aria-label="已保护的重要信息"><div><small>已按你的确认制作</small><strong>日期、酒店、路线和费用不会被擅自改动</strong></div><span>确认信息优先</span></section>
      {highlights.length > 0 && <section className="agent-custom-priorities" aria-labelledby="custom-priorities-title"><header><small>本次定制重点</small><p id="custom-priorities-title">系统会围绕这些体验重点组织客户版表达和配图。</p></header><ul>{highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul></section>}
      <p className="agent-editable-note">完成后可进入编辑页继续调整文案、图片和版式，系统不会把生成结果锁死。</p>
      {waiting && <div className="agent-runtime-confirm"><AgentConfirmationPanel confirmations={snapshot?.confirmations || []} decisions={decisions} onDecision={onDecision} onRetryImage={onRetryImage} /><Button tone="primary" onClick={onConfirm}>保存选择并从当前任务继续</Button></div>}
      {(error || display.disconnected) && <p className="generation-error" role="alert"><UiIcon name="warning" />{display.disconnected ? "暂时无法获取最新状态，正在重新连接，请勿重复生成。" : failed ? "本次生成未完成，请稍后重新尝试。" : "本次操作没有完成，请稍后重试。"}</p>}
    </div>
    <AgentProgressOverview snapshot={snapshot} elapsed={elapsed} />
    <footer className="generation-footer">{!waiting && !ready && !draft && <Button onClick={onReview}>查看确认信息</Button>}{(ready || draft) && <Button tone="primary" onClick={onEdit}>进入编辑页</Button>}{!waiting && !ready && !draft && !cancelled && !failed && <Button onClick={onCancel}>取消任务</Button>}</footer>
  </section></main>;
}

function CandidatePreview({ candidate }) {
  const [failed, setFailed] = useState(false);
  return <div className="candidate-preview">{!failed && candidate.localPreviewUrl ? <img src={candidate.localPreviewUrl} alt={`${candidate.label || "候选图片"}预览`} onError={() => setFailed(true)} /> : <div className="missing-image"><UiIcon name="warning" /><span>候选图片加载失败</span></div>}</div>;
}

export function ImageReviewStep({ project, onDecision, onResearchSlot, onUploadFile, onComplete, onBack, allowEmpty = true, allowReplace = false, backLabel = "返回生成状态", completeLabel = "完成图片确认并进入编辑", title = "确认未自动通过的图片", description = "候选图仅供审核；采用、拒绝、留空或上传都会记录为人工决定。明确硬拒绝图片不可直接采用。" }) {
  const review = project.data.imageReview || { slots: [] };
  const candidates = project.data.imageCandidates || [];
  const pending = pendingImageReviewSlots(review);
  const inputRef = useRef(null);
  const [uploadSlot, setUploadSlot] = useState("");
  const [researchingSlot, setResearchingSlot] = useState("");
  return <main className="flow-page"><StepRail active={2} /><section className="flow-content image-review-page">
    <header className="flow-heading"><small>STEP 03 · IMAGE REVIEW</small><h1>{title}</h1><p>{description}</p></header>
    <div className="review-summary"><span>待确认图片位 <strong>{pending.length}</strong></span><span>全部候选 <strong>{candidates.length}</strong></span><span>自动通过 <strong>{candidates.filter((item) => item.status === IMAGE_REVIEW_STATE.AUTO_APPROVED).length}</strong></span><span>明确拒绝 <strong>{candidates.filter((item) => item.status === IMAGE_REVIEW_STATE.HARD_REJECTED).length}</strong></span></div>
    <div className="review-slots">{review.slots.map((slot) => { const slotCandidates = candidates.filter((item) => item.slotId === slot.slotId); const actionable = slot.status === "manual_review" || allowReplace && ["human_selected", "uploaded"].includes(slot.status); return <section className={`review-slot review-slot-${slot.status}`} key={slot.slotId}><header><div><small>{slot.module}</small><h2>{slot.label}</h2></div><span>{slot.status === "manual_review" ? "待人工确认" : slot.status === "auto_selected" ? "已自动选片" : slot.status === "human_selected" ? "已人工采用" : slot.status === "uploaded" ? "已上传" : slot.status === "left_empty" ? "已留空" : "无可用图片"}</span></header><div className="candidate-grid">{slotCandidates.map((candidate, index) => <article className={`candidate-card candidate-${candidate.status}`} key={`${slot.slotId}-${candidate.candidateId}-${candidate.attempt}-${index}`}><CandidatePreview candidate={candidate} /><div className="candidate-body"><div className="candidate-state"><strong>{candidate.status === IMAGE_REVIEW_STATE.AUTO_APPROVED ? "自动通过" : candidate.status === IMAGE_REVIEW_STATE.HARD_REJECTED ? "明确拒绝" : "待人工确认"}</strong>{candidate.officialSource && <span>官方来源</span>}</div><p>{candidate.reason || "暂无审核说明"}</p><dl><div><dt>相关度</dt><dd>{candidate.terminalAudit?.relevance ?? candidate.initialAudit?.relevance ?? "—"}</dd></div><div><dt>高端感</dt><dd>{candidate.terminalAudit?.luxury ?? candidate.initialAudit?.luxury ?? "—"}</dd></div><div><dt>干净度</dt><dd>{candidate.terminalAudit?.cleanliness ?? candidate.initialAudit?.cleanliness ?? "—"}</dd></div><div><dt>构图</dt><dd>{candidate.terminalAudit?.composition ?? candidate.initialAudit?.composition ?? "—"}</dd></div></dl>{candidate.sourcePage && <a href={candidate.sourcePage} target="_blank" rel="noreferrer">查看来源页面</a>}{actionable && candidate.adoptable !== false && candidate.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW && <div className="candidate-actions"><Button tone="primary" onClick={() => onDecision(slot.slotId, "adopt", candidate)}>采用此图</Button><Button onClick={() => onDecision(slot.slotId, "reject", candidate)}>拒绝此图</Button></div>}</div></article>)}</div>{actionable && <footer><Button disabled={Boolean(researchingSlot)} onClick={async () => { setResearchingSlot(slot.slotId); try { await onResearchSlot(slot.slotId); } finally { setResearchingSlot(""); } }}>{researchingSlot === slot.slotId ? "正在重搜…" : "只重搜此图片位"}</Button>{allowEmpty && <Button onClick={() => onDecision(slot.slotId, "empty")}>本图片位留空</Button>}<Button onClick={() => { setUploadSlot(slot.slotId); inputRef.current?.click(); }}>{slot.status === "manual_review" ? "上传已授权素材" : "上传图片换图"}</Button></footer>}</section>; })}</div>
    <input ref={inputRef} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (!file || !uploadSlot) return; if (onUploadFile) onUploadFile(uploadSlot, file); else { const reader = new FileReader(); reader.onload = () => onDecision(uploadSlot, "upload", { src: reader.result, name: file.name }); reader.readAsDataURL(file); } event.target.value = ""; }} />
    <footer className="flow-footer"><Button onClick={onBack}>{backLabel}</Button><Button tone="primary" disabled={pending.length > 0} onClick={onComplete}>{completeLabel}</Button></footer>
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
  return normalizeHighlightForDisplay(value);
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

function ImagePickerModal({ data, targetSlot, onChoose, onUpload, onResearch, onClose, operation = {} }) {
  const [tab, setTab] = useState('recommended');
  const researching = operation.searching;
  const [pendingChoice, setPendingChoice] = useState(null);
  useEffect(() => {
    const close = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onClose]);
  const inputRef = useRef(null);
  const placements = listImagePlacements(data);
  const usedBySrc = new Map(placements.map(({ slot, image }) => [image.src, slot]));
  const savedCandidates = (data.imageCandidates || []).filter((item) => item.localPreviewUrl);
  const uploaded = placements.filter(({ image }) => image.userProvided && !savedCandidates.some(candidate => candidate.localPreviewUrl === image.src)).map(({ slot, image }) => ({ candidateId: 'user-' + slot.slotId, localPreviewUrl: image.src, sourceTitle: '本地上传', slotId: slot.slotId, userProvided: true }));
  const all = [...savedCandidates, ...uploaded].filter((item, index, array) => array.findIndex((other) => other.localPreviewUrl === item.localPreviewUrl && other.pipelineSlotId === item.pipelineSlotId) === index);
  const matchesTarget = (candidate) => candidate.fieldPath ? candidate.fieldPath === targetSlot.fieldPath : candidate.slotId === targetSlot.slotId;
  const canChoose = (candidate) => candidate.manualSelectable === true || candidate.userProvided || candidate.libraryEligible === true && (!candidate.pipelineSlotId || matchesTarget(candidate));
  const visible = tab === 'recommended' ? all.filter((item) => matchesTarget(item) || !item.pipelineSlotId && item.terminalAudit?.subjectMatch === true).sort((a, b) => Number(matchesTarget(b)) - Number(matchesTarget(a))) : all;
  return <div className="modal-backdrop image-picker-backdrop" role="dialog" aria-modal="true" aria-label="更换图片"><section className="image-picker-modal">
    <header><div><small>更换图片</small><h2>{targetSlot.label}</h2><p>选择已使用图片时会移动到这里，原位置自动留空。</p></div><button onClick={onClose}>关闭</button></header>
    <nav><button className={tab === 'recommended' ? 'active' : ''} onClick={() => setTab('recommended')}>适合当前位置</button><button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>全部行程图片</button><button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>本地上传</button></nav>
    {tab === 'upload' ? <div className="image-picker-upload"><UiIcon name="included" size={42} /><strong>上传你确认可使用的图片</strong><p>上传后会保存在当前项目，并锁定这个位置，自动搜索不会覆盖。</p><Button tone="primary" disabled={operation.saving} onClick={() => inputRef.current?.click()}>选择本地图片</Button></div> : <div className="image-picker-grid">{visible.length ? visible.map((candidate) => { const used = usedBySrc.get(candidate.localPreviewUrl); const selectable = canChoose(candidate); return <button key={`${candidate.pipelineSlotId || candidate.slotId}-${candidate.candidateId}`} disabled={!selectable || operation.saving} className={selectable ? '' : 'image-picker-candidate-rejected'} onClick={() => selectable && setPendingChoice({ candidate, used })}><img src={candidate.localPreviewUrl} alt={candidate.actualSubject || '候选图片'} onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.parentElement.classList.add('thumbnail-load-failed'); }} /><span><strong>{candidate.sourceTitle || (candidate.userProvided ? '本地上传' : '已检查图片')}</strong><small>{selectable ? used ? '当前在：' + used.label : '可人工采用' : candidate.status === IMAGE_REVIEW_STATE.HARD_REJECTED ? '明确拒绝 · 不可采用' : '不适合当前位置'}</small>{candidate.actualSubject && <small>实际主体：{candidate.actualSubject}</small>}{candidate.reason && <small>判定：{candidate.reason}</small>}</span></button>; }) : <div className="empty-image-state"><strong>还没有适合的图片</strong><span>可以为当前位置继续搜索，或上传自己的图片。</span></div>}</div>}
    <footer><div role="status" aria-live="polite">{operation.message}</div>{pendingChoice && <div className="empty-image-state"><strong>确认用于「{targetSlot.label}」？</strong><span>{pendingChoice.candidate.reason || '请确认图片内容和使用权。'} 已使用的图片会移动到这里，原位置留空。</span><Button disabled={operation.saving} onClick={() => onChoose({ ...pendingChoice.candidate, manualConfirmed: true }, pendingChoice.used)}>确认替换</Button><Button onClick={() => setPendingChoice(null)}>取消选择</Button></div>}<Button disabled={researching || !onResearch} onClick={onResearch}>{researching ? '正在搜索…' : '为当前位置搜索更多'}</Button></footer>
    <input ref={inputRef} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ''; }} />
  </section></div>;
}

export function Editor({ project, ItineraryComponent, onProject, onVersions, onResearchSlot, onChooseImage, onOpenImagePicker, onUploadImage, onRepairCopy, onRecheckCopy, onReviewFacts, copyRepairState, defaultDesigner, initialSelection, initialTab = "copy", openPickerOnImageClick = false, canOpenVersions = true, statusNotice }) {
  const [selection, setSelection] = useState(initialSelection || { module: "days", itemIndex: Math.min(2, project.data.days.length - 1), subItemIndex: null, imageIndex: 0 });
  const [tab, setTab] = useState(initialTab);
  const [historyTick, setHistoryTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { if (pickerOpen) onOpenImagePicker?.(); }, [pickerOpen]);
  const [imageOperations, setImageOperations] = useState({});
  const [imageMessage, setImageMessage] = useState('');
  const activeImageActions = useRef(new Set());
  const imageAction = async (slot, kind, perform) => {
    const key = `${slot.slotId}:${kind}`;
    if (activeImageActions.current.has(key)) return false;
    activeImageActions.current.add(key);
    const flag = kind === 'search' ? 'searching' : 'saving';
    const start = kind === 'search' ? `正在为「${slot.label}」搜索更多图片` : kind === 'upload' ? '正在上传并保存图片…' : '正在保存图片…';
    const show = (message, busy) => { setImageOperations(current => ({ ...current, [slot.slotId]: { ...current[slot.slotId], [flag]: busy, message } })); setImageMessage(message); };
    show(start, true);
    try {
      const result = await perform();
      if (result === false) throw new Error('保存失败');
      const message = kind === 'search' ? (result?.newCandidateCount > 0 ? `已找到 ${result.newCandidateCount} 张新候选` : '暂未找到更多合适图片') : kind === 'upload' ? '上传成功，图片已保存' : '图片替换成功';
      show(message, false);
      return true;
    } catch (error) {
      show(`${kind === 'search' ? '搜索失败，请重试' : kind === 'upload' ? '上传或保存失败，请重试' : '图片替换失败，请重试'}${error?.message ? `：${error.message}` : ''}`, false);
      return false;
    } finally { activeImageActions.current.delete(key); }
  };
  const previewRef = useRef(null);
  const fileRef = useRef(null);
  const designerFileRef = useRef(null);
  const historyRef = useRef({ undo: [], redo: [], group: null, at: 0 });
  const visibility = project.visibility || {};
  const viewData = useMemo(() => visibilityData(buildCustomerTravelEntityData(project.data), visibility), [project.data, visibility]);
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
    const imageContainer = event.target.closest(".hero-frame,.hotel-image,.dining-image,.transport-image,.spot-image,.card-missing-image");
    const imageNode = event.target.closest("[data-edit-image]") || imageContainer?.querySelector("[data-edit-image]");
    const parts = node.dataset.editPath.split(".");
    const next = { module: parts[0], itemIndex: parts[1] == null ? null : Number(parts[1]), subItemIndex: parts[2] === "spots" ? Number(parts[3]) : null, imageIndex: Number(imageNode?.dataset.editImage || 0) };
    choose(next, imageNode ? "image" : "copy");
    if (imageNode && openPickerOnImageClick) {
      requestAnimationFrame(() => setPickerOpen(true));
    }
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
    const bindings = project.data.simpleImageSlotBindings || {};
    const boundEntries = Object.entries(bindings);
    const simpleBoundMode = boundEntries.length > 0;
    const pipelineSlotIdByFieldPath = new Map(boundEntries.map(([slotId, binding]) => [binding?.fieldPath, slotId]).filter(([fieldPath]) => fieldPath));
    return buildLayoutImageSlots(project.data).filter((slot) => slot.module === moduleMap[selection.module] && (slot.module !== "day" || slot.dayIndex === selection.itemIndex) && (!simpleBoundMode || pipelineSlotIdByFieldPath.has(slot.fieldPath))).map((slot) => {
      const image = getSlotImage(project.data, slot) || {};
      return { ...slot, key: slot.slotId, pipelineSlotId: pipelineSlotIdByFieldPath.get(slot.fieldPath) || null, src: image.src || "", focus: image.focus || "50% 50%", fit: image.fit, subItemIndex: slot.spotIndex };
    });
  };
  const slots = collectSlots();
  const simpleBoundMode = Object.keys(project.data.simpleImageSlotBindings || {}).length > 0;
  const currentSlot = slots.find((slot) => (slot.itemIndex ?? null) === (selection.itemIndex ?? null) && (slot.subItemIndex ?? null) === (selection.subItemIndex ?? null) && slot.imageIndex === selection.imageIndex) || (simpleBoundMode ? null : slots[0]);
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
      if (onUploadImage) {
        await imageAction(uploadSlot, 'upload', () => onUploadImage(file, uploadSlot));
        return;
      }
      const response = await fetch('/api/images/upload', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error || '图片上传失败');
      updateData((next) => {
      setSlotImage(next, uploadSlot, { src: saved.src, focus: "50% 50%", userProvided: true, sourceTitle: file.name, sha256: saved.sha256 });
      next.imageLocks = { ...(next.imageLocks || {}), [uploadSlot.slotId]: { source: "user_upload", lockedAt: Date.now(), name: file.name } };
      recordImageDecision(next, { slotId: uploadSlot.slotId, action: 'upload', source: 'user_upload', fileName: file.name });
      }, `upload-${uploadSlot.slotId}`);
      setImageMessage('上传成功，图片已保存');
    } catch (error) { setImageMessage(`上传或保存失败，请重试：${error?.message || ''}`); }
  };
  const deleteImage = () => {
    if (!currentSlot || selection.module === "cover" || !window.confirm("删除这张图片？可以立即撤销恢复。")) return;
    updateData((next) => { setSlotImage(next, currentSlot, null); next.imageLocks = { ...(next.imageLocks || {}), [currentSlot.slotId]: { source: "user_cleared", lockedAt: Date.now() } }; recordImageDecision(next, { slotId: currentSlot.slotId, action: 'clear', source: 'user_cleared' }); }, `delete-image-${Date.now()}`);
    setSelection({ ...selection, imageIndex: 0 });
  };
  const chooseLibraryImage = async (candidate, usedSlot) => {
    if (!currentSlot) return;
    if (candidate.manualSelectable && !candidate.manualConfirmed) return;
    if (onChooseImage) {
      await imageAction(currentSlot, 'select', () => onChooseImage(candidate, currentSlot, usedSlot));
      return;
    }
    updateData((next) => {
      const moved = moveImageToSlot(next, currentSlot.slotId, usedSlot?.slotId, { src: candidate.localPreviewUrl, focus: "50% 50%", candidateId: candidate.candidateId, userProvided: Boolean(candidate.userProvided), sourcePage: candidate.sourcePage }, candidate.userProvided ? "user_upload" : "user_selection");
      Object.assign(next, moved);
      const chosen = (next.imageCandidates || []).find((item) => item.candidateId === candidate.candidateId);
      if (chosen) chosen.humanDecision = { action: 'adopt', decidedAt: Date.now(), targetSlotId: currentSlot.slotId, sourceSlotId: usedSlot?.slotId || null, originalStatus: chosen.status, originalRisk: chosen.reason || '' };
      recordImageDecision(next, { slotId: currentSlot.slotId, sourceSlotId: usedSlot?.slotId, action: usedSlot ? 'move' : 'adopt', source: candidate.userProvided ? 'user_upload' : 'user_selection', candidateId: candidate.candidateId });
    }, `choose-image-${currentSlot.slotId}-${Date.now()}`);
    setPickerOpen(false);
    setImageMessage('图片替换成功');
  };
  const researchCurrentSlot = () => imageAction(currentSlot, 'search', () => onResearchSlot(currentSlot.pipelineSlotId || currentSlot.slotId));
  const failurePrefix = selection.module === "cover" ? "cover" : selection.module === "days" ? `days:${selection.itemIndex}:` : `${selection.module}:`;
  const moduleFailures = (project.data.imageFailures || []).filter((failure) => String(failure.slot || "").startsWith(failurePrefix));
  const imagePanel = <div className="image-inspector"><div className="image-library"><header><strong>本模块图片位置</strong><span>{slots.filter((slot) => slot.src).length} / {slots.length}</span></header><div className="image-thumbnails">{slots.map((slot) => <button key={slot.key} className={currentSlot?.key === slot.key ? "active" : ""} onClick={() => selectSlot(slot)}>{slot.src ? <img src={slot.src} alt={slot.label} onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.parentElement.classList.add("thumbnail-load-failed"); }} /> : <span className="empty-slot-thumb">缺图</span>}<span>{slot.label}</span></button>)}</div>{!slots.some((slot) => slot.src) && <div className="empty-image-state"><strong>当前模块暂时缺图</strong><span>可以打开换图窗口，从本次行程图片中选择或本地上传。</span>{moduleFailures.map((failure) => <small key={failure.slot}>{failure.label}：{failure.error}</small>)}</div>}</div>{currentSlot && <>{currentSlot.src ? <><div className="focus-preview" onPointerDown={(event) => { const box = event.currentTarget.getBoundingClientRect(); event.currentTarget.setPointerCapture(event.pointerId); setFocus((event.clientX - box.left) / box.width * 100, (event.clientY - box.top) / box.height * 100); }} onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.getBoundingClientRect(); setFocus(Math.max(0, Math.min(100, (event.clientX - box.left) / box.width * 100)), Math.max(0, Math.min(100, (event.clientY - box.top) / box.height * 100))); }}><img src={currentSlot.src} alt="当前选中图片" style={{ objectPosition: currentSlot.focus }} /><span style={{ left: `${focusX}%`, top: `${focusY}%` }} /></div><div className="focus-controls"><label>横向焦点 <span>{Math.round(focusX)}%</span><input type="range" min="0" max="100" value={focusX} onChange={(event) => setFocus(Number(event.target.value), focusY)} /></label><label>纵向焦点 <span>{Math.round(focusY)}%</span><input type="range" min="0" max="100" value={focusY} onChange={(event) => setFocus(focusX, Number(event.target.value))} /></label></div></> : <div className="empty-image-state"><strong>这个位置还没有图片</strong><span>空位置不会显示破图，也不会阻止继续编辑。</span></div>}<div className="image-actions"><Button tone="primary" onClick={() => setPickerOpen(true)}>换图</Button>{currentSlot.src && <Button onClick={() => setFocus(50, 50)}>恢复居中</Button>}</div></>}<input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => { uploadLocalImage(event.target.files?.[0]); event.target.value = ""; }} />{currentSlot?.src && selection.module !== "cover" && <button className="delete-image-button" onClick={deleteImage}>删除当前图片</button>}<p className="image-source">自动图片已经下载保存并检查；本地素材请确认使用权。</p></div>;

  const title = selection.module === "days" ? `DAY ${String(selection.itemIndex + 1).padStart(2, "0")} · ${selectedDay?.theme || selectedDay?.city || "每日行程"}` : selectedModule.label;
  return <main className="editor-page"><StepRail active={3} maxStep={canOpenVersions ? 4 : 3} onStep={(step) => step === 4 && canOpenVersions && onVersions()} /><div className="editor-grid">
    <aside className="structure-panel"><header><span><UiIcon name="itinerary" />行程结构</span></header><nav>{MODULES.map((module) => module.id === "days" ? <div key={module.id} className="day-nav-group"><button className={selection.module === "days" ? "active" : ""} onClick={() => selectModule("days", selection.itemIndex)}><span className="nav-dot" />每日行程</button><div>{project.data.days.map((day, index) => <button key={index} className={selection.module === "days" && selection.itemIndex === index ? "active" : ""} onClick={() => selectModule("days", index)}><span>DAY {String(index + 1).padStart(2, "0")}</span><em>{day.city || day.theme}</em></button>)}</div></div> : <button key={module.id} className={selection.module === module.id ? "active" : ""} onClick={() => selectModule(module.id)}><span className="nav-dot" />{module.label}{visibility[module.id] === false && <small>已隐藏</small>}</button>)}</nav></aside>
    <section className="canvas-stage" ref={previewRef} onClick={onPreviewClick} tabIndex="0" aria-label="行程长图预览，使用滚轮、PageDown、Home 或 End 浏览"><div className="workspace-itinerary"><ItineraryComponent data={viewData} /></div></section>
    <aside className="inspector-panel"><header><div><small>{project.revisionMode ? 'REVISION MODE' : 'EDIT CONTENT'}</small><h2>{title}</h2></div><div className="history-actions"><button disabled={!historyRef.current.undo.length} onClick={() => restore("undo")} title="撤销 Ctrl+Z"><UiIcon name="return" />撤销</button><button disabled={!historyRef.current.redo.length} onClick={() => restore("redo")} title="重做 Ctrl+Shift+Z"><UiIcon name="process" />重做</button></div></header>{statusNotice && <div className="copy-review-banner" role="status"><strong>{statusNotice.title || "当前可编辑，正式成品尚未开放"}</strong><span>{statusNotice.message || statusNotice}</span>{Array.isArray(statusNotice.items) && statusNotice.items.length > 0 && <ul>{statusNotice.items.map((item) => <li key={item}>{item}</li>)}</ul>}</div>}{(copyReview?.needsReview || copyReview?.blocked || project.revisionMode) && <div className="copy-review-banner" role="status"><strong>修订模式 · {copyIssueTargets.length} 个修改位置</strong><span>底层共发现 {copyReviewIssues.length} 条检查记录；图片和版面已保留。普通文案建议可继续修订，也可在正式版本页确认后按当前内容导出；事实、费用、安全或结构问题仍会阻止。</span><div className="copy-review-actions"><Button tone="primary" disabled={copyRepairState?.busy || !copyIssueTargets.some((target) => target.aiRepairable)} onClick={() => onRepairCopy?.('')}>{copyRepairState?.busy && !copyRepairState.targetPath ? 'AI正在修正…' : 'AI修正全部可修项'}</Button><Button disabled={copyRepairState?.busy} onClick={() => onRecheckCopy?.()}>重新检查全部</Button></div>{copyRepairState?.message && <span className="copy-repair-state">{copyRepairState.message}</span>}<div className="copy-review-details">{copyIssueTargets.map((target) => <section key={target.targetPath}><button className="copy-issue-target" onClick={() => selectIssueTarget(target.targetPath)}><b>{target.label}</b><small>{target.ruleIds.join('/') || 'COPY'} · {target.issues.length}条记录</small></button>{target.issues.map((issue, index) => <p key={`${target.targetPath}-${index}`}><em>{issue.ruleIds?.join('/') || issue.ruleId || 'COPY'}</em>{issue.message}</p>)}<div className="copy-target-actions"><Button disabled={copyRepairState?.busy} onClick={() => target.aiRepairable ? onRepairCopy?.(target.targetPath) : onReviewFacts?.()}>{copyRepairState?.busy && copyRepairState.targetPath === target.targetPath ? '正在修正…' : target.aiRepairable ? 'AI修正这项' : '返回确认原始事实'}</Button></div></section>)}</div></div>}<div className="inspector-tabs"><button className={tab === "copy" ? "active" : ""} onClick={() => setTab("copy")}>文案</button>{hasImages && <button className={tab === "image" ? "active" : ""} onClick={() => setTab("image")}>图片</button>}</div>
      {tab === "copy" && <div className="inspector-body">{copyPanel}</div>}
      {tab === "image" && <div className="inspector-body">{imagePanel}</div>}
      <footer className="module-toggle"><div><UiIcon name="city" /><span><strong>模块显示</strong><small>{selectedModule.required ? "品牌固定模块" : "控制是否进入正式版本"}</small></span></div><label className="switch"><input type="checkbox" checked={selectedModule.required || visibility[selectedModule.id] !== false} disabled={selectedModule.required} onChange={(event) => updateVisibility(event.target.checked)} /><span /></label></footer>
    </aside>
  </div>{imageMessage && !pickerOpen && <div className="manual-image-feedback" role="status" aria-live="polite">{imageMessage}</div>}{pickerOpen && currentSlot && <ImagePickerModal key={currentSlot.slotId} operation={imageOperations[currentSlot.slotId]} data={project.data} targetSlot={currentSlot} onClose={() => setPickerOpen(false)} onChoose={chooseLibraryImage} onResearch={onResearchSlot ? researchCurrentSlot : undefined} onUpload={uploadLocalImage} />}</main>;
}

export function VersionsStep({ project, exporting, exportError, onExport, onBack, onReviewDecision, existingOnly = false }) {
  const humanReview = project.data.humanReview || {};
  const ready = humanReviewReady(humanReview);
  const exportEligibility = copyExportEligibility(project);
  const warningAccepted = !exportEligibility.requiresWarningAcknowledgement || humanReview.exportWithCopyWarningsConfirmed === true;
  return <main className="flow-page"><StepRail active={4} onStep={(step) => step === 3 && onBack()} /><section className="flow-content versions-content"><header className="flow-heading"><small>STEP 05</small><h1>正式版本</h1><p>每次生成都会冻结当时内容，之后仍可返回草稿继续修改。</p></header>
    {!existingOnly && <div className="export-hero"><div><UiIcon name="included" size={32} /><h2>{exporting > 0 && exporting < 100 ? "正在生成高清成品" : "生成新的正式版本"}</h2><p>{exporting > 0 && exporting < 100 ? "正在排版并检查超长页尾，请保持此页面打开。" : "输出一张供客户查看的2000px高清长图。"}</p>{exportEligibility.hardBlocked && <p className="export-error">当前仍有事实、费用、安全或结构问题，必须先处理后才能正式导出。</p>}{exportEligibility.hasWarnings && <label><input type="checkbox" checked={humanReview.exportWithCopyWarningsConfirmed === true} onChange={(event) => onReviewDecision('exportWithCopyWarningsConfirmed', event.target.checked)} /> 我已查看全部文案待修项，仍确认按当前内容生成正式版本</label>}<label><input type="checkbox" checked={humanReview.aestheticConfirmed === true} onChange={(event) => onReviewDecision('aestheticConfirmed', event.target.checked)} /> 我已查看完整预览，确认整体审美、层级和客户可读性</label><label><input type="checkbox" checked={humanReview.licenseReviewed === true} onChange={(event) => onReviewDecision('licenseReviewed', event.target.checked)} /> 我已核对最终图片来源和使用权；授权不明素材会在正式发布前替换</label>{!ready && <p className="export-error">人工复核不会阻止进入编辑器，但生成正式客户版本前必须留下确认记录。</p>}{exporting > 0 && exporting < 100 && <div className="export-progress"><span style={{ width: `${exporting}%` }} /><strong>{exporting}%</strong></div>}{exportError && <p className="export-error">{exportError}</p>}</div><Button tone="primary" disabled={!exportEligibility.allowed || !warningAccepted || !ready || (exporting > 0 && exporting < 100)} onClick={onExport}>生成版本</Button></div>}
    <div className="version-list"><header><h2>版本历史</h2><span>{project.versions?.length || 0} 个版本</span></header>{project.versions?.length ? project.versions.slice().reverse().map((version, index) => <article key={version.id}><div className="version-index">V{String(project.versions.length - index).padStart(2, "0")}</div><div><strong>{version.name}</strong><span>{formatTime(version.createdAt)} · 2000px</span></div><div className="version-downloads">{version.downloadUrl ? <a href={version.downloadUrl} download>下载高清长图</a> : <span>旧版未生成文件</span>}</div></article>) : <div className="empty-versions">还没有正式版本，点击上方按钮生成。</div>}</div>
  </section></main>;
}

function ProfilePanel({ user, onClose, onSave }) {
  const [profile, setProfile] = useState(() => designerProfile(user));
  const [syncProjects, setSyncProjects] = useState(true);
  const fileRef = useRef(null);
  const update = (key) => (event) => setProfile((current) => ({ ...current, [key]: event.target.value }));
  return <div className="modal-backdrop profile-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="profile-panel-title">
    <section className="profile-panel">
      <header className="profile-panel-header">
        <div>
          <small>MY PROFILE</small>
          <h2 id="profile-panel-title">我的定制师资料</h2>
          <p>保存后将作为新项目的默认封面身份。</p>
        </div>
        <button className="profile-close-button" onClick={onClose} aria-label="关闭">×</button>
      </header>
      <div className="profile-layout">
        <aside className="profile-avatar-editor">
          <img src={profile.avatar} alt="定制师头像预览" />
          <Button className="profile-avatar-button" onClick={() => fileRef.current?.click()}>上传头像</Button>
          <input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setProfile((current) => ({ ...current, avatar: reader.result })); reader.readAsDataURL(file); }} />
          <small>建议上传清晰正方形照片，系统将自动居中裁切。</small>
        </aside>
        <div className="profile-fields">
          <div className="profile-name-row">
            <div className="profile-field"><Field label="定制师姓名" value={profile.name} onChange={(value) => setProfile((current) => ({ ...current, name: value }))} /></div>
            <div className="profile-field"><Field label="职位" value={profile.role} onChange={(value) => setProfile((current) => ({ ...current, role: value }))} /></div>
          </div>
          <div className="profile-field profile-bio-field"><Field label="个人介绍" rows={5} value={profile.bio} onChange={(value) => setProfile((current) => ({ ...current, bio: value }))} /></div>
          <label className="sync-projects">
            <input type="checkbox" checked={syncProjects} onChange={(event) => setSyncProjects(event.target.checked)} />
            <span><strong>同步到我的已有项目</strong><small>项目内已单独修改的资料也会被本次资料覆盖。</small></span>
          </label>
        </div>
      </div>
      <footer>
        <Button className="profile-cancel-button" onClick={onClose}>取消</Button>
        <Button tone="primary" onClick={() => onSave(profile, syncProjects)}>保存资料</Button>
      </footer>
    </section>
  </div>;
}

function DeleteDialog({ project, onCancel, onConfirm }) {
  return <div className="modal-backdrop"><section className="confirm-dialog"><UiIcon name="warning" size={34} /><h2>删除“{project.title}”？</h2><p>项目和专属素材将进入回收站。若继续清理正在被历史版本使用的素材，旧版本可能缺图且无法恢复。</p><div><Button onClick={onCancel}>取消</Button><Button tone="danger" onClick={onConfirm}>仍然删除</Button></div></section></div>;
}

function TrashDialog({ project, onCancel, onConfirm }) {
  return <div className="modal-backdrop"><section className="confirm-dialog"><UiIcon name="warning" size={34} /><h2>将“{project.title}”移入回收站？</h2><p>项目、原始资料、运行记录和成品都会完整保留，可随时从回收站恢复。正在执行的生成任务不会因此取消。</p><div><Button onClick={onCancel}>取消</Button><Button tone="primary" onClick={onConfirm}>移入回收站</Button></div></section></div>;
}

function PermanentDeleteDialog({ project, projects, busy, onCancel, onConfirm }) {
  const clearing = Array.isArray(projects);
  const count = projects?.length || 0;
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="permanent-delete-title"><section className="confirm-dialog permanent-delete-dialog"><UiIcon name="warning" size={30} /><h2 id="permanent-delete-title">{clearing ? "清空回收站？" : "永久删除项目？"}</h2><p>{clearing ? `回收站中的 ${count} 个项目删除后将无法恢复，包括生成结果和项目内保存的数据。` : `「${project.title}」删除后将无法恢复，包括该项目的生成结果和项目内保存的数据。`}</p><div><Button disabled={busy} onClick={onCancel}>取消</Button><Button tone="danger" disabled={busy} onClick={onConfirm}>{busy ? "正在删除…" : "永久删除"}</Button></div></section></div>;
}

function ProjectToast({ feedback }) {
  if (!feedback) return null;
  return <div className={`project-toast project-toast-${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}><UiIcon name={feedback.tone === "error" ? "warning" : "included"} size={17} /><span>{feedback.message}</span></div>;
}

export function Workspace({ initialData, ItineraryComponent, agentMode = false }) {
  const storageKeys = agentMode ? AGENT_STORAGE : FIXED_STORAGE;
  const [users, setUsers] = useState(() => window.__sheyouServerUser ? [window.__sheyouServerUser] : readStorage(storageKeys.users, []));
  const [user, setUser] = useState(() => { if(window.__sheyouServerUser) return window.__sheyouServerUser; const session = readStorage(storageKeys.session, null); return readStorage(storageKeys.users, []).find((item) => item.id === session?.userId) || null; });
  const [projects, setProjects] = useState(() => readSessionProjects(storageKeys, window.__sheyouServerUser));
  const [projectId, setProjectId] = useState(null);
  const [screen, setScreen] = useState(() => agentMode ? "home" : "list");
  const [saveState, setSaveState] = useState("saved");
  const [progress, setProgress] = useState(0);
  const [generationStatus, setGenerationStatus] = useState({ phase: "queued", status: "idle", currentAction: "尚未开始", stats: {}, elapsedMs: 0 });
  const [generationError, setGenerationError] = useState("");
  const [copyRepairState, setCopyRepairState] = useState({ busy: false, targetPath: '', message: '' });
  const [exporting, setExporting] = useState(0);
  const [exportError, setExportError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [deleteProject, setDeleteProject] = useState(null);
  const [trashProject, setTrashProject] = useState(null);
  const [permanentDelete, setPermanentDelete] = useState(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [projectFeedback, setProjectFeedback] = useState(null);
  const [exitingProjectIds, setExitingProjectIds] = useState([]);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [agentDecisions, setAgentDecisions] = useState({});
  const saveTimer = useRef(null);
  const generationInFlightRef = useRef(false);
  const currentProject = projects.find((project) => project.id === projectId && project.ownerId === user?.id);
  useEffect(() => {
    if (!projectFeedback) return undefined;
    const timer = setTimeout(() => setProjectFeedback(null), 2200);
    return () => clearTimeout(timer);
  }, [projectFeedback]);
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [screen]);
  useEffect(() => {
    if (!agentMode || !currentProject?.agentProjectId || !["confirm", "generate"].includes(screen)) return undefined;
    let stopped = false; let timer;
    const refresh = async () => {
      try {
        const apiBase = currentProject.flowKind === "simple_skill_v1" ? "/api/simple/projects" : "/api/agent/projects";
        const response = await fetch(`${apiBase}/${currentProject.agentProjectId}`, { signal: AbortSignal.timeout(15000), cache: "no-store" });
        const value = await readAgentSnapshot(response);
        if (stopped) return;
        setAgentSnapshot(value);
        setAgentDecisions((existing) => ({ ...Object.fromEntries((value.confirmations || []).filter((item) => item.status === "pending").map((item) => [item.confirmationId, item.choices.find((choice) => choice.recommended)?.choiceId || item.choices[0]?.choiceId])), ...existing }));
        if (["ready_for_editor", "complete"].includes(value.project.status) && value.result?.data) {
          const executionRunId = value.executionRun?.executionRunId;
          setProjects((existing) => {
            const collection = existing.map((item) => {
              if (item.id !== currentProject.id) return item;
              const versionId = `${item.flowKind === "simple_skill_v1" ? "simple" : "agent"}-${executionRunId}`;
              const downloadBase = item.flowKind === "simple_skill_v1" ? "/api/simple/projects" : "/api/agent/projects";
              const versions = item.versions?.some((version) => version.id === versionId) ? item.versions : [...(item.versions || []), { id: versionId, name: `${item.title} · 智能体完整生成版`, createdAt: Date.now(), snapshot: versionSnapshot(value.result.data), downloadUrl: `${downloadBase}/${item.agentProjectId}/output` }];
              const visibility = value.result.data.showExpenseSection === false ? { ...(item.visibility || {}), expenses: false } : item.visibility;
              return { ...item, workflowStage: "generated", revisionMode: false, data: { ...value.result.data, designer: item.data.designer }, visibility, aiGeneration: { executionRunId, finalQa: value.result.finalQa, imageGate: value.result.imageGate }, versions, updatedAt: Date.now() };
            });
            try { writeStorage(storageKeys.projects, collection); setSaveState("saved"); } catch (error) { setSaveState("error"); setGenerationError(error?.message || "成品已生成，但本地项目保存失败"); }
            return collection;
          });
          setProgress(100);
          timer = setTimeout(() => { if (!stopped) { if (currentProject.flowKind === "simple_skill_v1") window.location.assign(`/simple/projects/${currentProject.agentProjectId}`); else setScreen("editor"); } }, 900);
          return;
        }
        if (["awaiting_user_action", "partial", "ready_to_render"].includes(value.project.status) && value.result?.data && currentProject.flowKind === "simple_skill_v1") {
          window.location.assign(`/simple/projects/${currentProject.agentProjectId}`);
          return;
        }
        if (["preparing", "planning", "ready_for_execution", "running"].includes(value.project.status) || ["pending", "running"].includes(value.executionRun?.status) || value.activeJob?.status === "running") timer = setTimeout(refresh, 1000);
      } catch (error) {
        if (!stopped) {
          setAgentSnapshot(previous => ({ ...previous, _connectionError: error?.message || "状态请求失败", _observedAt: previous?._observedAt || Date.now() }));
          timer = setTimeout(refresh, 3000);
        }
      }
    };
    refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [agentMode, currentProject?.agentProjectId, screen, agentSnapshot?.project?.activeJobId]);
  const commitProjects = (next) => { setProjects(next); try { writeStorage(storageKeys.projects, next); setSaveState('saved'); } catch (error) { setSaveState('error'); alert(error.message); } };
  const showProjectFeedback = (message, tone = "success") => setProjectFeedback({ message, tone, id: Date.now() });
  const commitProjectLifecycle = (next, successMessage) => {
    try { writeStorage(storageKeys.projects, next); setProjects(next); setSaveState("saved"); return true; }
    catch { setSaveState("error"); showProjectFeedback("操作失败，请重试", "error"); return false; }
  };
  const beginProjectExit = async (ids) => {
    setExitingProjectIds(ids);
    await new Promise((resolve) => setTimeout(resolve, 220));
  };
  const finishProjectExit = (ids) => setExitingProjectIds((current) => current.filter((id) => !ids.includes(id)));
  const moveProjectToTrash = async (project) => {
    setTrashProject(null);
    await beginProjectExit([project.id]);
    const saved = commitProjectLifecycle(projects.map((item) => item.id === project.id ? { ...item, trashedAt: Date.now() } : item));
    finishProjectExit([project.id]);
    if (saved) showProjectFeedback("已移入回收站");
  };
  const restoreProject = async (project) => {
    await beginProjectExit([project.id]);
    const saved = commitProjectLifecycle(projects.map((item) => item.id === project.id ? { ...item, trashedAt: null, restoredAt: Date.now() } : item));
    finishProjectExit([project.id]);
    if (saved) showProjectFeedback("项目已恢复");
  };
  const permanentlyDeleteProjects = async (targets) => {
    setProjectActionBusy(true);
    const deletedIds = [];
    try {
      for (const project of targets) {
        if (project.agentProjectId) {
          const apiBase = project.flowKind === "simple_skill_v1" ? "/api/simple/projects" : "/api/agent/projects";
          const response = await fetch(`${apiBase}/${project.agentProjectId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
          if (!response.ok) throw new Error("project_delete_failed");
        }
        deletedIds.push(project.id);
      }
      setPermanentDelete(null);
      await beginProjectExit(deletedIds);
      const deleted = new Set(deletedIds);
      if (!commitProjectLifecycle(projects.filter((item) => !deleted.has(item.id)))) throw new Error("local_delete_failed");
      finishProjectExit(deletedIds);
      showProjectFeedback(targets.length > 1 ? "回收站已清空" : "项目已永久删除");
    } catch {
      if (deletedIds.length) {
        const deleted = new Set(deletedIds);
        commitProjectLifecycle(projects.filter((item) => !deleted.has(item.id)));
      }
      finishProjectExit(deletedIds);
      showProjectFeedback("操作失败，请重试", "error");
    } finally { setProjectActionBusy(false); }
  };
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
    const next = { ...project, flowKind: "simple_skill_v1", agentProjectId: null, workflowStage: "uploaded", title: recognition.data.title || project.title, data: { ...recognition.data, designer: project.data.designer }, recognition: recognition.report, files: files.map((file) => ({ name: file.name, size: file.size, type: file.type, sha256: sourceSha256 })) };
    updateProject(next, true);
    setAgentSnapshot(null);
    return next;
  };
  const continueAgent = async () => {
    if (!currentProject) return;
    const confirmationValidation = validateItineraryFacts(currentProject.data);
    const actionItems = buildConfirmationActionItems({
      project: currentProject,
      data: currentProject.data,
      validation: confirmationValidation,
      confirmations: agentSnapshot?.confirmations || [],
      decisions: agentDecisions,
    });
    if (actionItems.length > 0) {
      setScreen("confirm");
      throw new Error(`还有 ${actionItems.length} 项信息需要确认`);
    }
    if (currentProject.flowKind === "simple_skill_v1" && !currentProject.agentProjectId) {
      const source = currentProject.files?.[0] || {};
      const response = await fetch("/api/simple/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts: currentProject.data, report: currentProject.recognition || {}, sourceName: source.name, sourceSha256: source.sha256 }) });
      const created = await response.json();
      if (!response.ok) throw new Error(created.error || "无法开始制作，请重试");
      updateProject({ ...currentProject, agentProjectId: created.projectId, workflowStage: "simple-running" }, true);
      setAgentSnapshot({ project: { projectId: created.projectId, flowKind: "simple_skill_v1", status: "planning", progress: created.progress || 1 }, plan: null, executionRun: null, activeJob: created });
      setProgress(created.progress || 1); setGenerationError(""); setScreen("generate");
      return;
    }
    if (!currentProject.agentProjectId) return;
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
  const retryAgentImage = async (slotId) => {
    if (!currentProject?.agentProjectId || !slotId) return;
    setGenerationError("");
    const response = await fetch(`/api/agent/projects/${currentProject.agentProjectId}/image-retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slotIds: [slotId] }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "无法重新搜索这个图片位");
    const latestResponse = await fetch(`/api/agent/projects/${currentProject.agentProjectId}`);
    if (latestResponse.ok) setAgentSnapshot(await latestResponse.json());
  };
  const cancelAgent = async () => {
    if (!currentProject?.agentProjectId || !window.confirm("确认取消当前智能体任务？项目、确认和计划记录会保留，已发生的调用无法撤销。")) return;
    const apiBase = currentProject.flowKind === "simple_skill_v1" ? "/api/simple/projects" : "/api/agent/projects";
    const response = await fetch(`${apiBase}/${currentProject.agentProjectId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || "无法取消任务"); setAgentSnapshot(value);
  };
  const createProject = () => { const data = clone(initialData); data.designer = designerProfile(user); const project = { id: uid("project"), flowKind: agentMode ? "simple_skill_v1" : "fixed_v1", ownerId: user.id, title: "新的定制行程", customerName: "", requirements: "", data, files: [], workflowStage: "draft", visibility: {}, versions: [], updatedAt: Date.now() }; commitProjects([project, ...projects]); setAgentSnapshot(null); setProjectId(project.id); setScreen("upload"); };
  const openProject = (project) => {
    if (agentMode) {
      setProjectId(project.id);
      setAgentSnapshot(null);
      const simpleRunStarted = project.flowKind === "simple_skill_v1" && Boolean(project.agentProjectId);
      if (simpleRunStarted && (project.workflowStage === "generated" || project.revisionMode)) {
        window.location.assign(`/simple/projects/${project.agentProjectId}`);
        return;
      }
      setScreen(project.workflowStage === "generated" || project.revisionMode ? "editor" : simpleRunStarted ? "generate" : project.files?.length ? "confirm" : "upload");
      return;
    }
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
  const logout = () => { if(window.__sheyouServerUser){window.dispatchEvent(new Event('sheyou-logout'));return;} localStorage.removeItem(storageKeys.session); setUser(null); setProjectId(null); setScreen(agentMode ? "home" : "list"); };
  if (!user) return <AuthScreen storageKeys={storageKeys} onAuth={(nextUser) => { setUsers(readStorage(storageKeys.users, [])); setUser(nextUser); }} />;
  const activeProjects = projects.filter((project) => project.ownerId === user.id && !project.trashedAt);
  return <div className={`workspace-shell${agentMode ? " workspace-agent-mode" : ""}`}><AppHeader user={user} project={currentProject && !["home", "list"].includes(screen) ? currentProject : null} saved={saveState} canGenerate={agentMode ? false : copyExportEligibility(currentProject || {}).allowed} onHome={() => setScreen(agentMode ? "home" : "list")} onLogout={logout} onProfile={() => setProfileOpen(true)} onGenerate={() => setScreen('versions')} />
    {agentMode && <div className="agent-mode-strip"><span>定制师智能工作台 · 独立项目数据</span><strong>确认信息优先 · 完成后可继续调整</strong></div>}
    {agentMode && screen === "home" && <WorkspaceHome projects={activeProjects} onCreate={createProject} onProjects={() => setScreen("list")} onOpen={openProject} onTrash={setTrashProject} />}
    {screen === "list" && <ProjectList user={user} projects={projects} exitingProjectIds={exitingProjectIds} onCreate={createProject} onOpen={openProject} onDelete={agentMode ? undefined : setDeleteProject} onTrash={agentMode ? setTrashProject : undefined} onRestore={agentMode ? restoreProject : undefined} onPermanentDelete={agentMode ? (project) => setPermanentDelete({ project }) : undefined} onClearTrash={agentMode ? (items) => setPermanentDelete({ projects: items }) : undefined} />}
    {screen === "upload" && currentProject && <UploadStep project={currentProject} onFiles={async (files, recognition, sourceSha256) => agentMode ? attachAgentProject(currentProject, files, recognition, sourceSha256) : updateProject({ ...currentProject, workflowStage: "uploaded", title: recognition.data.title || currentProject.title, data: { ...recognition.data, designer: currentProject.data.designer }, recognition: recognition.report, files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })) }, true)} onContinue={() => setScreen("confirm")} />}
    {screen === "confirm" && currentProject && <ConfirmStep project={currentProject} agentMode={agentMode} agentSnapshot={agentSnapshot} agentDecisions={agentDecisions} onAgentDecision={(confirmationId, choiceId) => setAgentDecisions((current) => ({ ...current, [confirmationId]: choiceId }))} onChange={(data, metadata = {}) => updateProject({ ...currentProject, ...metadata, data })} onBack={() => setScreen("upload")} onContinue={() => agentMode ? continueAgent().catch((error) => setGenerationError(error?.message || "无法继续")) : (() => { setProgress(0); setGenerationError(""); setGenerationStatus({ phase: "queued", status: "idle", currentAction: "尚未开始", stats: {}, elapsedMs: 0 }); setScreen("generate"); })()} />}
    {screen === "generate" && currentProject && (agentMode ? <AgentGenerationStep project={currentProject} snapshot={agentSnapshot} error={generationError} decisions={agentDecisions} onDecision={(confirmationId, choiceId) => setAgentDecisions((current) => ({ ...current, [confirmationId]: choiceId }))} onConfirm={() => continueAgent().catch((error) => setGenerationError(error?.message || "无法保存确认"))} onRetryImage={(slotId) => retryAgentImage(slotId).catch((error) => setGenerationError(error?.message || "无法重新搜索图片"))} onReview={() => setScreen("confirm")} onEdit={() => setScreen("editor")} onCancel={() => cancelAgent().catch((error) => setGenerationError(error?.message || "无法取消任务"))} /> : <GenerationStep project={currentProject} progress={progress} status={generationStatus} error={generationError} onStart={generateProject} onReview={() => setScreen("confirm")} onEdit={() => setScreen("editor")} onRevision={() => { updateProject({ ...currentProject, revisionMode: true }, true); setScreen('editor'); }} />)}
    {screen === "editor" && currentProject && <Editor project={currentProject} ItineraryComponent={ItineraryComponent} onProject={updateProject} onResearchSlot={agentMode ? undefined : async (slotId) => { try { await researchImageSlot(slotId); } catch (error) { setGenerationError(error?.message || "当前位置搜索失败"); alert(error?.message || "当前位置搜索失败"); } }} onRepairCopy={agentMode ? undefined : repairCopy} onRecheckCopy={agentMode ? undefined : () => recheckCopy()} onReviewFacts={() => setScreen('confirm')} copyRepairState={copyRepairState} onVersions={() => setScreen('versions')} defaultDesigner={designerProfile(user)} />}
    {screen === "versions" && currentProject && <VersionsStep project={currentProject} exporting={exporting} exportError={exportError} existingOnly={agentMode} onExport={exportProject} onBack={() => setScreen("editor")} onReviewDecision={(key, checked) => updateProject({ ...currentProject, data: { ...currentProject.data, humanReview: recordHumanReview(currentProject.data.humanReview, key, checked, user.id) } }, true)} />}
    {profileOpen && <ProfilePanel user={user} onClose={() => setProfileOpen(false)} onSave={(profile, syncProjects) => { const nextUsers = users.map((item) => item.id === user.id ? { ...item, name: profile.name || item.name, profile } : item); const nextUser = nextUsers.find((item) => item.id === user.id); setUsers(nextUsers); setUser(nextUser); writeStorage(storageKeys.users, nextUsers); if (syncProjects) { const nextProjects = projects.map((item) => item.ownerId === user.id ? { ...item, data: { ...item.data, designer: clone(profile) }, updatedAt: Date.now() } : item); commitProjects(nextProjects); } setProfileOpen(false); }} />}
    {!agentMode && deleteProject && <DeleteDialog project={deleteProject} onCancel={() => setDeleteProject(null)} onConfirm={() => { commitProjects(projects.filter((item) => item.id !== deleteProject.id)); setDeleteProject(null); }} />}
    {agentMode && trashProject && <TrashDialog project={trashProject} onCancel={() => setTrashProject(null)} onConfirm={() => moveProjectToTrash(trashProject)} />}
    {agentMode && permanentDelete && <PermanentDeleteDialog project={permanentDelete.project} projects={permanentDelete.projects} busy={projectActionBusy} onCancel={() => !projectActionBusy && setPermanentDelete(null)} onConfirm={() => permanentlyDeleteProjects(permanentDelete.projects || [permanentDelete.project])} />}
    <ProjectToast feedback={projectFeedback} />
  </div>;
}
