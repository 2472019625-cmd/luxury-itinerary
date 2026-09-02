import React, { useEffect, useMemo, useRef, useState } from "react";
import { importItineraryWorkbook } from "./lib/itineraryImport.js";
import { createProductionDefaultData } from "./lib/itineraryRules.js";

const statusLabel = {
  reading: "正在读取资料",
  planning: "正在制定计划",
  checking: "正在检查计划",
  complete: "规划已完成",
  failed: "规划失败",
  cancelled: "已取消",
};

async function sha256(file) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function Section({ number, title, children, muted }) {
  return <section className={`agent-section${muted ? " agent-section-muted" : ""}`}><header><span>{number}</span><h2>{title}</h2></header><div className="agent-section-body">{children}</div></section>;
}

function Chip({ children, tone = "default" }) { return <span className={`agent-chip agent-chip-${tone}`}>{children}</span>; }
const tasksBy = (plan, types) => (plan?.tasks || []).filter((task) => types.includes(task.taskType));
const readable = (value) => {
  if (value === null || value === undefined || value === "") return "未单独声明";
  if (Array.isArray(value)) return value.map(readable).join("、");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}：${readable(item)}`).join("；");
  return String(value);
};

function TaskCards({ tasks }) {
  if (!tasks.length) return <p className="agent-empty">本次事实没有触发这一类任务。</p>;
  return <div className="agent-task-grid">{tasks.map((task) => <article className="agent-task" key={task.taskId}>
    <div className="agent-task-top"><Chip>{task.parallelGroup}</Chip><Chip tone="safe">只规划</Chip></div>
    <h3>{readable(task.title)}</h3><p>{readable(task.objective)}</p>
    <dl><div><dt>需要什么</dt><dd>{readable(task.requiredContext)}</dd></div><div><dt>完成结果</dt><dd>{readable(task.expectedResult)}</dd></div><div><dt>等待</dt><dd>{task.dependsOn?.length ? task.dependsOn.join("、") : "无需等待其他任务"}</dd></div></dl>
  </article>)}</div>;
}

function PlanView({ project, plan, onReplan, busy }) {
  const fact = plan.factBasis;
  const copyTasks = tasksBy(plan, ["copy_global", "copy_hotel_transport", "copy_day_group", "copy_closing", "copy_review", "targeted_copy_repair"]);
  const webTasks = tasksBy(plan, ["web_verification"]);
  const imageTasks = tasksBy(plan, ["image_strategy", "image_slot_plan", "image_search_plan", "visual_review", "image_placement", "image_gap_resolution"]);
  const parallelGroups = useMemo(() => Object.entries((plan.tasks || []).reduce((groups, task) => { (groups[task.parallelGroup] ||= []).push(task); return groups; }, {})), [plan]);
  const nonPlanningCalls = (plan.capabilityCallStats || []).filter((item) => !["source_parser", "trip_planner"].includes(item.capabilityId)).reduce((sum, item) => sum + item.actualCalls, 0);
  return <main className="agent-plan">
    <div className="agent-plan-heading"><div><p className="agent-eyebrow">项目 {project.projectId.slice(0, 8)} · 计划版本 {plan.planVersion}</p><h1>{fact.destination} · {fact.dayCount}日行程成品规划</h1><p>这份页面直接读取当前有效计划 <code>{plan.planId}</code>，没有另一套展示计划。</p></div><button className="agent-secondary" disabled={busy} onClick={onReplan}>重新规划</button></div>

    <Section number="01" title="我理解到的行程"><div className="agent-fact-grid"><div><b>{fact.destination}</b><span>目的地</span></div><div><b>{fact.dayCount} 天</b><span>行程长度</span></div><div><b>{fact.travelerCount || "待确认"}</b><span>出行人数</span></div><div><b>{fact.hotels.length}</b><span>识别酒店</span></div></div><p>{fact.startDate || "日期待确认"} 至 {fact.endDate || "日期待确认"}；住宿：{fact.hotels.map((hotel) => `${hotel.name}${hotel.nights ? `（${hotel.nights}晚）` : ""}`).join("、") || "未识别"}。</p><div className="agent-day-strip">{fact.days.map((day) => <span key={day.day}><b>DAY {day.day}</b>{day.route || day.experience || "待补充"}</span>)}</div></Section>
    <Section number="02" title="这次的整体规划"><div className="agent-theme-grid"><article><small>内容主线</small><h3>{plan.summary.contentTheme}</h3></article><article><small>视觉主线</small><h3>{plan.summary.visualTheme}</h3></article></div><p>{plan.summary.planningRationale}</p><div className="agent-module-list">{(plan.modules || []).map((module) => <div key={module.moduleId}><Chip tone={module.decision === "show" ? "safe" : "muted"}>{module.decision === "show" ? "显示" : "隐藏"}</Chip><b>{module.label}</b><span>{module.reason}</span></div>)}</div></Section>
    <Section number="03" title="文案准备怎么生成"><TaskCards tasks={copyTasks} />{plan.copyPlan?.groups?.length > 0 && <div className="agent-notes">{plan.copyPlan.groups.map((group, index) => <p key={group.groupId || index}><b>{readable(group.label || group.name || group.groupId || `文案单元 ${index + 1}`)}</b>：{readable(group.focus || group.rationale || group.description || group.content)}{group.differentiation ? `；差异重点：${readable(group.differentiation)}` : ""}</p>)}</div>}</Section>
    <Section number="04" title="准备核验什么事实"><p className="agent-callout">联网只用于核验已有行程实体，不会改变产品安排；当前版本不会真实联网。</p>{plan.webVerification?.length ? <div className="agent-list">{plan.webVerification.map((item, index) => <article key={`${item.subject}-${item.field}-${index}`}><h3>{item.subject} · {item.field}</h3><p>{item.reason}</p><small>优先来源：{item.preferredSource}</small></article>)}</div> : <p className="agent-empty">本次没有需要提前联网核验的项目。</p>}<TaskCards tasks={webTasks} /></Section>
    <Section number="05" title="图片准备怎么规划"><p>{plan.imagePlan.visualStory}</p><div className="agent-slot-grid">{(plan.imagePlan.slots || []).map((slot) => <article key={slot.slotId}><div><Chip tone={slot.required ? "warn" : "muted"}>{slot.required ? "必需主图" : "可移除补充图"}</Chip><span>{slot.role}</span></div><h3>{slot.label}</h3><p>{slot.visualDuty}</p><small>{slot.differentiation || slot.searchIntent}</small></article>)}</div><TaskCards tasks={imageTasks} /></Section>
    <Section number="06" title="任务怎样同时进行"><p>本次共有 <b>{plan.tasks.length}</b> 个由行程事实驱动的动态任务。</p><div className="agent-parallel">{parallelGroups.map(([group, tasks]) => <article key={group}><Chip>{group}</Chip><div>{tasks.map((task) => <span key={task.taskId}>{task.title}</span>)}</div></article>)}</div></Section>
    <Section number="07" title="需要你确认的问题">{plan.confirmations?.length ? <div className="agent-list">{plan.confirmations.map((item) => <article key={item.confirmationId}><Chip tone="warn">{item.category}</Chip><h3>{item.question}</h3><p>{item.reason}</p></article>)}</div> : <p className="agent-success">本次没有需要人工确认的关键问题。</p>}</Section>
    <Section number="08" title="安全检查结果"><div className="agent-safety"><div><b>通过</b><span>规则覆盖</span></div><div><b>未改写</b><span>确定性事实</span></div><div><b>{nonPlanningCalls}</b><span>未授权能力调用</span></div><div><b>安全</b><span>依赖与并行</span></div><div><b>plan_only</b><span>当前计划状态</span></div></div><details><summary>查看技术明细</summary><pre>{JSON.stringify({ planId: plan.planId, activePlanId: project.activePlanId, inputFingerprint: plan.inputFingerprint, versions: { rules: plan.ruleProfileVersion, capabilities: plan.capabilityConfigVersion, prompt: plan.promptVersion }, checkpointCoverage: plan.checkpointCoverage, capabilityCallStats: plan.capabilityCallStats, validation: plan.validation }, null, 2)}</pre></details></Section>
    <Section number="09" title="规划调整记录" muted>{plan.adjustments?.length ? <div className="agent-list">{plan.adjustments.map((item, index) => <article key={index}><h3>{item.issue || "规划调整"}</h3><p>{item.change || item.description}</p></article>)}</div> : <p className="agent-empty">首次计划已直接通过安全检查，没有发生结构修正。</p>}<p className="agent-record-note">旧计划会保留；重新规划只会创建新记录并更新 activePlanId，不会覆盖历史。</p></Section>
  </main>;
}

export function AgentPlanner() {
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const [active, setActive] = useState(null);
  const [source, setSource] = useState(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);
  const loadProject = async (projectId) => {
    const response = await fetch(`/api/agent/projects/${projectId}`);
    if (!response.ok) throw new Error((await response.json()).error || "无法读取规划结果");
    setActive(await response.json());
  };
  useEffect(() => {
    const projectId = new URLSearchParams(window.location.search).get("project");
    if (!projectId) return;
    setStatus("reading");
    setMessage("正在读取已保存的规划");
    loadProject(projectId).then(() => { setStatus("complete"); setMessage("规划已完成"); }).catch((failure) => { setStatus("failed"); setError(failure.message); });
  }, []);
  const poll = async (nextJob) => {
    const response = await fetch(`/api/agent/jobs/${nextJob.jobId}`);
    const current = await response.json();
    if (!response.ok) throw new Error(current.error || "无法读取规划状态");
    setJob(current); setStatus(current.status); setMessage(current.message || "");
    if (["planning", "checking"].includes(current.status)) timerRef.current = setTimeout(() => poll(current).catch((failure) => { setStatus("failed"); setError(failure.message); }), 900);
    else if (current.status === "complete") await loadProject(current.projectId);
    else if (current.status === "failed") setError([current.error, ...(current.validationErrors || []).map((item) => item.message)].filter(Boolean).join("；"));
  };
  const submit = async (payload, endpoint = "/api/agent/projects") => {
    setError(""); setActive(endpoint.includes("replan") ? active : null); setStatus("planning"); setMessage("正在理解行程");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : "{}" });
    const created = await response.json();
    if (!response.ok) throw new Error(created.error || "无法创建规划任务");
    setJob(created); await poll(created);
  };
  const upload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus("reading"); setMessage("正在读取资料"); setError("");
    try {
      const [{ data, report }, digest] = await Promise.all([importItineraryWorkbook(file, createProductionDefaultData()), sha256(file)]);
      setSource({ name: file.name, digest, report });
      await submit({ facts: data, report, sourceName: file.name, sourceSha256: digest });
    } catch (failure) { setStatus("failed"); setError(failure.message || "资料读取失败"); }
    finally { event.target.value = ""; }
  };
  const cancel = async () => {
    if (!job) return;
    await fetch(`/api/agent/jobs/${job.jobId}/cancel`, { method: "POST" });
    setMessage("正在取消");
  };
  return <div className="agent-shell">
    <header className="agent-topbar"><div><span className="agent-mark">奢游</span><div><b>智能体试验版｜规划预览</b><small>最终智能体架构 · 独立规划模块</small></div></div><div className="agent-mode"><i />执行开关已关闭</div></header>
    <section className="agent-hero"><div><p className="agent-eyebrow">AGENT V1 · PLAN PREVIEW</p><h1>先把整趟行程想清楚，再开始制作</h1><p>上传真实 Excel 后，智能体会理解行程并制定唯一的动态任务计划。当前只做规划，不会开始生成成品、联网搜图或导出。</p><div className="agent-actions"><button onClick={() => inputRef.current?.click()} disabled={["reading", "planning", "checking"].includes(status)}>选择行程 Excel</button>{["planning", "checking"].includes(status) && <button className="agent-secondary" onClick={cancel}>取消规划</button>}<input ref={inputRef} type="file" accept=".xlsx,.xls" onChange={upload} hidden /></div>{source && <p className="agent-source">{source.name} · 指纹 {source.digest.slice(0, 12)}…</p>}</div><aside><strong>本次边界</strong><ul><li>确定性读取 Excel</li><li>智能体自主制定计划</li><li>程序检查规则与权限</li><li>后续能力真实调用为零</li></ul></aside></section>
    {status !== "idle" && !active?.plan && <section className={`agent-status agent-status-${status}`}><span className="agent-spinner" /><div><b>{statusLabel[status] || message}</b><p>{error || message}</p></div></section>}
    {error && active?.plan && <div className="agent-error">{error}</div>}
    {active?.plan && <PlanView project={active.project} plan={active.plan} busy={["planning", "checking"].includes(status)} onReplan={() => submit(null, `/api/agent/projects/${active.project.projectId}/replan`).catch((failure) => { setStatus("failed"); setError(failure.message); })} />}
    <footer className="agent-footer">规划服务独立运行于 127.0.0.1:4174 · 固定流程 4173 不会被占用或引用</footer>
  </div>;
}
