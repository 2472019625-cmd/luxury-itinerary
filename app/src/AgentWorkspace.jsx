import React, { useEffect, useRef, useState } from "react";
import { mergeManualImagePayload, mergeTargetedRepairPayload } from "./lib/manualImageState.js";
import { AGENT_STORAGE, AgentModeStrip, AppHeader, Editor, VersionsStep, readStorage } from "./Workspace.jsx";

async function readJson(response) { const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || "请求失败"), { payload:value }); return value; }

function editorSelectionForSlot(project, slotId) {
  const binding = project.data.simpleImageSlotBindings?.[slotId];
  const fieldPath = binding?.fieldPath || "heroImage";
  if (fieldPath === "heroImage") return { module:"cover", itemIndex:null, subItemIndex:null, imageIndex:0 };
  let match = fieldPath.match(/^hotels\.(\d+)\.images\.(\d+)$/);
  if (match) return { module:"hotels", itemIndex:Number(match[1]), subItemIndex:null, imageIndex:Number(match[2]) };
  match = fieldPath.match(/^transportSummary\.(\d+)\.images\.(\d+)$/);
  if (match) return { module:"transport", itemIndex:Number(match[1]), subItemIndex:null, imageIndex:Number(match[2]) };
  match = fieldPath.match(/^days\.(\d+)\.spots\.(\d+)\.images\.(\d+)$/);
  if (match) return { module:"days", itemIndex:Number(match[1]), subItemIndex:Number(match[2]), imageIndex:Number(match[3]), spotId:binding?.spotId || null, slotId };
  return { module:"cover", itemIndex:null, subItemIndex:null, imageIndex:0 };
}

function SimpleManualImagePage({ projectId, ItineraryComponent }) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [repairState, setRepairState] = useState({ busy:false, targetId:"", message:"" });
  const [screen, setScreen] = useState("editor");
  const daySaveTimer = useRef(null);
  const [user] = useState(() => {
    if (window.__sheyouServerUser) return window.__sheyouServerUser;
    const session = readStorage(AGENT_STORAGE.session, null);
    return readStorage(AGENT_STORAGE.users, []).find((item) => item.id === session?.userId) || null;
  });
  const load = async () => {
    try { const next = await readJson(await fetch(`/api/simple/projects/${projectId}/manual-images`)); setPayload(current => mergeManualImagePayload(current, next)); setError(""); }
    catch (failure) { setError(failure.message); }
  };
  useEffect(() => { load(); }, [projectId]);
  useEffect(() => () => clearTimeout(daySaveTimer.current), []);
  useEffect(() => {
    if (!payload?.renderPending) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const next = await readJson(await fetch(`/api/simple/projects/${projectId}/manual-images`));
        if (!stopped) setPayload(current => current?.manualRevision === next.manualRevision ? { ...next, project: { ...next.project, data: current.project.data } } : current);
      } catch (failure) { if (!stopped) setError(`图片已保存，成品检查状态获取失败：${failure.message}`); }
    }, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [payload, projectId]);
  const request = async (slotId, action, body) => {
    setBusy(`${slotId}:${action}`); setError("");
    try {
      const response = await fetch(`/api/simple/projects/${projectId}/manual-images/${encodeURIComponent(slotId)}/${action}`, { ...body, signal: AbortSignal.timeout(action === 'research' ? 240000 : 60000) });
      const next = await readJson(response);
      setPayload(current => mergeManualImagePayload(current, next));
      return next;
    } catch (failure) { setError(failure.message); throw failure; }
    finally { setBusy(""); }
  };
  const choose = async (candidate, targetSlot) => {
    const slotId = targetSlot.pipelineSlotId;
    if (!slotId) throw new Error("当前位置没有对应的 Simple Pipeline 图片位");
    return request(slotId, "select", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ candidateId:candidate.candidateId, manualConfirmed:candidate.manualConfirmed === true }) });
  };
  const upload = async (slotId, file) => request(slotId, "upload", { method:"POST", headers:{ "content-type":file.type || "application/octet-stream", "x-file-name":encodeURIComponent(file.name) }, body:file });
  const uploadFromEditor = async (file, targetSlot) => {
    const slotId = targetSlot.pipelineSlotId;
    if (!slotId) throw new Error("当前位置没有对应的 Simple Pipeline 图片位");
    return upload(slotId, file);
  };
  const research = async (slotId) => {
    return request(slotId, "research", { method:"POST" });
  };
  const targetedRepair = async (kind, targetId) => {
    setRepairState({ busy:true, targetId, message:kind === "copy" ? "正在重新生成这一项文案…" : "正在重新检查高清成品…" });
    setError("");
    try {
      const endpoint = kind === "copy"
        ? `/api/simple/projects/${projectId}/repair/copy/${encodeURIComponent(targetId)}`
        : `/api/simple/projects/${projectId}/repair/renderer`;
      const next = await readJson(await fetch(endpoint, { method:"POST", signal:AbortSignal.timeout(240000) }));
      setPayload((current) => mergeTargetedRepairPayload(current, next));
      const success = next.repair?.status === "success";
      setRepairState({ busy:false, targetId:"", message:success ? (kind === "copy" ? "这项文案已重新生成" : "成品检查已通过") : (kind === "copy" ? "这项文案仍未生成成功，可以再次重试" : "成品检查仍未通过，请查看对应提示") });
      return next;
    } catch (failure) {
      setError(failure.message);
      setRepairState({ busy:false, targetId:"", message:"本次处理未完成，请重试" });
      throw failure;
    }
  };
  const batchRepair = async (kind, targetIds) => {
    const ids = [...new Set((targetIds || []).filter(Boolean))];
    const targetId = `${kind}:all`;
    setRepairState({ busy:true, targetId, message:kind === "copy" ? `正在并发生成 ${ids.length} 项失败文案…` : `正在并发搜索 ${ids.length} 个缺图位置…` });
    setError("");
    try {
      const endpoint = kind === "copy"
        ? `/api/simple/projects/${projectId}/repair/copy`
        : `/api/simple/projects/${projectId}/repair/images`;
      const body = kind === "copy" ? { targetIds:ids } : { slotIds:ids };
      const next = await readJson(await fetch(endpoint, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body), signal:AbortSignal.timeout(kind === "copy" ? 300000 : 600000) }));
      setPayload((current) => kind === "copy" ? mergeTargetedRepairPayload(current, next) : mergeManualImagePayload(current, next));
      const successful = kind === "copy" ? next.repair?.successfulTargets?.length || 0 : next.repair?.successfulSlotIds?.length || 0;
      const failed = kind === "copy" ? next.repair?.failedTargetIds?.length || 0 : next.repair?.failedSlotIds?.length || 0;
      setRepairState({ busy:false, targetId:"", message:failed ? `已完成 ${successful} 项，仍有 ${failed} 项需要处理` : `已完成全部 ${successful} 项` });
      return next;
    } catch (failure) {
      setError(failure.message);
      setRepairState({ busy:false, targetId:"", message:"本次批量处理未完成，请重试" });
      throw failure;
    }
  };
  const saveDayEditor = async (project, dayIndex) => {
    const data = project.data;
    const bindings = Object.fromEntries(Object.entries(data.simpleImageSlotBindings || {}).filter(([, binding]) => binding.module === "day" && binding.dayIndex === dayIndex));
    const response = await fetch(`/api/simple/projects/${projectId}/day-editor/${dayIndex}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day: data.days[dayIndex], bindings, included: data.included || [], excluded: data.excluded || [], pendingConfirmations: data.pendingConfirmations || [] }),
      signal: AbortSignal.timeout(60000),
    });
    const next = await readJson(response);
    setPayload((current) => mergeManualImagePayload(current, next));
    setError("");
    return next;
  };
  const persistDayEditor = (project, dayIndex, { immediate = false } = {}) => {
    clearTimeout(daySaveTimer.current);
    if (immediate) return saveDayEditor(project, dayIndex).catch((failure) => { setError(`体验卡片保存失败：${failure.message}`); throw failure; });
    daySaveTimer.current = setTimeout(() => saveDayEditor(project, dayIndex).catch((failure) => setError(`体验卡片保存失败：${failure.message}`)), 500);
    return Promise.resolve(null);
  };
  if (!payload) return <div className="agent-shell"><div className="agent-status"><span className="agent-spinner"/><b>{error || "正在读取当前项目"}</b></div></div>;
  const workspaceUser = user || { id:"project-designer", name:payload.project.data?.designer?.name || "定制师", profile:payload.project.data?.designer || {} };
  const headerProject = { ...payload.project, title:payload.project.title || payload.project.data?.title || "定制行程" };
  const goHome = () => window.location.assign("/agent");
  const logout = () => { if(window.__sheyouServerUser){window.dispatchEvent(new Event('sheyou-logout'));return;} localStorage.removeItem(AGENT_STORAGE.session); window.location.assign("/agent"); };
  if (screen === "versions" && payload.canEnterFinal) return <div className="workspace-shell workspace-agent-mode"><AppHeader user={workspaceUser} project={headerProject} saved="saved" canGenerate={false} onHome={goHome} onLogout={logout} /><AgentModeStrip showHome onHome={goHome} /><VersionsStep project={payload.project} existingOnly onBack={() => setScreen("editor")} /></div>;
  const firstUnresolved = payload.unresolvedRequiredSlotIds?.[0] || "image:cover:primary";
  const pendingSummary = payload.unresolvedNotices?.map((item) => item.message) || [];
  return <div className="workspace-shell workspace-agent-mode"><AppHeader user={workspaceUser} project={headerProject} saved="saved" canGenerate={false} onHome={goHome} onLogout={logout} /><AgentModeStrip showHome onHome={goHome} /><Editor
    project={payload.project}
    ItineraryComponent={ItineraryComponent}
    onProject={(project) => setPayload((current) => ({ ...current, project }))}
    onPersistDayEditor={persistDayEditor}
    onChooseImage={choose}
    onUploadImage={uploadFromEditor}
    onResearchSlot={research}
    onRetryCopy={(targetId) => targetedRepair("copy", targetId)}
    onRetryAllCopy={(targetIds) => batchRepair("copy", targetIds)}
    onRetryAllImages={(slotIds) => batchRepair("image", slotIds)}
    onRetryRenderer={() => targetedRepair("renderer", "renderer:2000")}
    onOpenImagePicker={load}
    onVersions={() => payload.canEnterFinal && setScreen("versions")}
    openPickerOnImageClick
    canOpenVersions={payload.canEnterFinal}
    blockingItems={payload.blockingItems || []}
    issueActionState={repairState}
    initialSelection={editorSelectionForSlot(payload.project, firstUnresolved)}
    initialTab={payload.unresolvedCopyCount ? "copy" : "image"}
    defaultDesigner={payload.project.data.designer || { avatar:"", name:"", role:"", bio:"" }}
    statusNotice={payload.canEnterFinal
      ? { title:"内容已经补齐", message:"正式成品已通过检查，可以进入 Step 5 查看和下载。" }
      : { title:"可编辑草稿已生成", message:payload.draftRendered ? "未完成项目已在对应位置保留提醒；你可以先编辑文案、补图和检查版面，正式下载会在问题补齐后开放。" : "可以先在编辑器处理未完成项目；草稿长图生成未通过时，请按下方提醒检查对应模块。", items:pendingSummary }}
  />{busy && <div className="agent-execution-notice">正在处理 {busy.split(":").slice(0, -1).join(":")}，只会更新当前图片位。</div>}{error && <div className="agent-error">{error}</div>}</div>;
}

export function AgentWorkspace({ ItineraryComponent }) {
  const simpleMatch = window.location.pathname.match(/^\/simple\/projects\/([^/]+)/);
  if (simpleMatch) return <SimpleManualImagePage projectId={simpleMatch[1]} ItineraryComponent={ItineraryComponent} />;
  return null;
}
