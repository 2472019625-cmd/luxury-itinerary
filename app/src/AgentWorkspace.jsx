import React, { useEffect, useRef, useState } from "react";
import { importItineraryWorkbook } from "./lib/itineraryImport.js";
import { createProductionDefaultData } from "./lib/itineraryRules.js";
import { PlanView } from "./AgentPlanner.jsx";

const labels = { preparing:"正在准备", awaiting_confirmation:"等待确认", planning:"正在制定计划", ready_for_execution:"执行准备完成", planning_failed:"生成中断", cancelled:"已取消" };
async function digest(file) { const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2,"0")).join(""); }
async function readJson(response) { const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || "请求失败"), { payload:value }); return value; }

function ProjectHeader({ project }) {
  const fact = project.factBasis;
  return <><header className="agent-topbar"><div><span className="agent-mark">奢游</span><div><b>智能体内部诊断</b><small>管理员与开发使用 · 非员工正式入口</small></div></div><div className="agent-mode"><i />执行能力尚未开放</div></header><section className="agent-project-head"><div><p className="agent-eyebrow">PROJECT {project.projectId.slice(0,8)}</p><h1>{fact.destination} · {fact.dayCount}日行程</h1><p>{project.source.name}</p></div><span className={`agent-project-state state-${project.status}`}>{labels[project.status] || project.currentStage}</span></section></>;
}

function Confirmations({ items, onSubmit, busy }) {
  const [decisions,setDecisions] = useState(() => Object.fromEntries(items.map((item) => [item.confirmationId, item.choices.find((choice) => choice.recommended)?.choiceId || item.choices[0]?.choiceId])));
  return <section className="agent-project-card agent-confirm"><p className="agent-eyebrow">需要你确认</p><h2>这些关键事实不能由智能体猜测</h2><p>确认会作为后续规划约束保存，不会改写原始资料。</p>{items.map((item) => <article key={item.confirmationId}><span>{item.category}</span><h3>{item.question}</h3><p>{item.reason}</p>{item.choices.map((choice) => <label key={choice.choiceId}><input type="radio" name={item.confirmationId} checked={decisions[item.confirmationId]===choice.choiceId} onChange={() => setDecisions({...decisions,[item.confirmationId]:choice.choiceId})}/><b>{choice.label}</b>{choice.recommended && <em>建议</em>}<small>{choice.reason}</small></label>)}</article>)}<button disabled={busy} onClick={() => onSubmit(Object.entries(decisions).map(([confirmationId,choiceId]) => ({confirmationId,choiceId})))}>保存确认并继续</button></section>;
}

function TaskOverview({ plan, run }) {
  const state = new Map((run?.taskRuns || []).map((item) => [item.taskId,item.status]));
  return <section className="agent-project-card"><p className="agent-eyebrow">执行任务</p><h2>任务调度概览</h2><p>所有任务来自当前有效计划；现阶段仅展示调度顺序，不调用下游能力。</p><div className="agent-run-list">{plan.tasks.map((task,index) => <div key={task.taskId}><span>{String(index+1).padStart(2,"0")}</span><div><b>{task.title}</b><small>{task.parallelGroup} · {task.dependsOn.length ? `等待 ${task.dependsOn.length} 项` : "可作为首批任务"}</small></div><em>{state.get(task.taskId)==="cancelled" ? "已取消" : "待执行"}</em></div>)}</div></section>;
}

function ProjectPage({ projectId }) {
  const [data,setData] = useState(null), [error,setError] = useState(""), [notice,setNotice] = useState(""), [busy,setBusy] = useState(false);
  useEffect(() => { let timer; const poll = async () => { try { const next=await readJson(await fetch(`/api/agent/projects/${projectId}`)); setData(next); if (["preparing","planning"].includes(next.project.status)) timer=setTimeout(poll,1000); } catch (e) { setError(e.message); } }; poll(); return () => clearTimeout(timer); },[projectId]);
  const confirm = async (decisions) => { setBusy(true); setError(""); try { const response=await fetch(`/api/agent/projects/${projectId}/confirmations`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({decisions})}); const result=await readJson(response); if (result.jobId) window.location.reload(); else setData(result); } catch(e){setError(e.message)} finally{setBusy(false)} };
  const checkExecution = async () => { setBusy(true); setError(""); try { const response=await fetch(`/api/agent/projects/${projectId}/execution-runs`,{method:"POST"}); const value=await response.json(); if (value.executionRun) setData({...data,executionRun:value.executionRun}); setNotice(value.error || "执行能力尚未开放"); } finally {setBusy(false)} };
  const cancel = async () => { if(!window.confirm("确认取消当前项目？已保存的计划和记录不会删除。")) return; setData(await readJson(await fetch(`/api/agent/projects/${projectId}/cancel`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({confirmed:true})}))); };
  if (!data) return <div className="agent-shell"><div className="agent-status"><span className="agent-spinner"/><b>{error || "正在读取项目"}</b></div></div>;
  const {project,plan,confirmations=[],executionRun,activeJob}=data;
  return <div className="agent-shell"><ProjectHeader project={project}/><main className="agent-project-main">{error && <div className="agent-error">{error}</div>}{notice && <div className="agent-execution-notice">{notice}。当前计划和任务记录已保留，未调用任何下游能力。</div>}{project.status==="awaiting_confirmation" && <Confirmations items={confirmations.filter((item)=>item.status==="pending")} onSubmit={confirm} busy={busy}/>} {["preparing","planning"].includes(project.status) && <section className="agent-project-card agent-current"><span className="agent-spinner"/><div><p className="agent-eyebrow">当前任务</p><h2>{activeJob?.message || project.currentStage}</h2><p>智能体正在基于同一份项目事实制定任务计划。</p></div></section>}{project.status==="planning_failed" && <section className="agent-project-card"><h2>生成中断</h2><p>{project.lastError}</p></section>}{plan && project.status!=="cancelled" && <><section className="agent-project-card agent-ready"><div><p className="agent-eyebrow">当前状态</p><h2>计划已经准备好，执行能力尚未开放</h2><p>当前有效计划：{plan.planId}。计划与执行记录分开保存，执行不会修改这份计划。</p></div><div className="agent-actions"><button onClick={checkExecution} disabled={busy}>检查执行可用性</button><button className="agent-secondary" onClick={cancel}>取消项目</button></div></section><TaskOverview plan={plan} run={executionRun}/><details className="agent-plan-details"><summary>查看本次规划</summary><PlanView project={project} plan={plan} embedded /></details></>}{project.status==="cancelled" && <section className="agent-project-card"><h2>项目已取消</h2><p>计划、确认和运行记录已保留，可用于追溯。</p></section>}</main><footer className="agent-footer">正式智能体项目独立运行于 127.0.0.1:4174 · 固定流程 4173 保持隔离</footer></div>;
}

function Landing() {
  const input=useRef(null); const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const upload=async(event)=>{const file=event.target.files?.[0]; if(!file)return; setBusy(true);setError("");try{const [{data,report},sourceSha256]=await Promise.all([importItineraryWorkbook(file,createProductionDefaultData()),digest(file)]);const value=await readJson(await fetch("/api/agent/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({facts:data,report,sourceName:file.name,sourceSha256})}));window.location.assign(`/agent-diagnostics/projects/${value.projectId}`);}catch(e){setError(e.message)}finally{setBusy(false);event.target.value=""}};
  return <div className="agent-shell"><header className="agent-topbar"><div><span className="agent-mark">奢游</span><div><b>智能体内部诊断</b><small>管理员与开发使用 · 非员工正式入口</small></div></div><div className="agent-mode"><i/>执行能力尚未开放</div></header><section className="agent-hero"><div><p className="agent-eyebrow">AGENT DIAGNOSTICS</p><h1>查看智能体项目内部记录</h1><p>这里保留确认、唯一计划和执行运行记录用于开发诊断；员工正式入口已经接回原五步行程美化工作台。</p><div className="agent-actions"><button disabled={busy} onClick={()=>input.current?.click()}>{busy?"正在读取资料":"创建诊断项目"}</button><input hidden ref={input} type="file" accept=".xlsx,.xls" onChange={upload}/></div>{error&&<div className="agent-error">{error}</div>}</div><aside><strong>诊断边界</strong><ul><li>不作为员工工作台</li><li>只读同一智能体项目</li><li>计划与执行状态分离</li><li>下游真实调用保持为零</li></ul></aside></section></div>;
}

export function AgentWorkspace(){const match=window.location.pathname.match(/^\/(?:agent\/projects|agent-diagnostics\/projects)\/([^/]+)/);return match?<ProjectPage projectId={match[1]}/>:<Landing/>;}
