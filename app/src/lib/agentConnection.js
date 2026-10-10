export async function readAgentSnapshot(response) {
  const type = response.headers.get('content-type') || '';
  const diagnostic = `HTTP ${response.status}; content-type=${type || 'missing'}; path=${new URL(response.url || 'http://localhost/').pathname}; ray=${response.headers.get('cf-ray') || 'none'}`;
  const raw = await response.text();
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`${diagnostic}; ${/^\s*</.test(raw) ? 'HTML response instead of JSON' : 'invalid JSON response'}`); }
  if (!response.ok) throw new Error(`${diagnostic}; request failed`);
  if (!value?.project?.status) throw new Error(`${diagnostic}; missing project status`);
  return { ...value, _observedAt: Date.now() };
}

export function simpleRenderedEditorState(snapshot) {
  if (snapshot?.project?.flowKind !== 'simple_skill_v1') return null;
  const status = snapshot.project.status;
  if (!['complete', 'ready_for_editor', 'partial', 'awaiting_user_action', 'ready_to_render'].includes(status)) return null;
  if (snapshot.project.activeExecutionRunId && snapshot.project.activeExecutionRunId !== snapshot?.executionRun?.executionRunId) return null;
  if (snapshot?.executionRun?.status !== status) return null;
  if (['cancelled', 'failed', 'planning_failed', 'execution_failed', 'terminated'].includes(snapshot?.activeJob?.status)) return null;
  const result = snapshot?.result;
  const renderedOutput = result?.outputPath || result?.render?.outputPath;
  if (!result?.data || !renderedOutput || result?.render?.status !== 'success') return null;
  return ['complete', 'ready_for_editor'].includes(status) ? 'complete' : 'draft';
}

export function simpleEditableEditorState(snapshot) {
  const rendered = simpleRenderedEditorState(snapshot);
  if (rendered) return rendered;
  if (snapshot?.project?.flowKind !== 'simple_skill_v1') return null;
  if (!['partial', 'awaiting_user_action', 'ready_to_render'].includes(snapshot.project.status)) return null;
  if (snapshot.project.activeExecutionRunId && snapshot.project.activeExecutionRunId !== snapshot?.executionRun?.executionRunId) return null;
  if (['cancelled', 'failed', 'planning_failed', 'execution_failed', 'terminated', 'running'].includes(snapshot?.activeJob?.status)) return null;
  if (['cancelled', 'failed', 'running'].includes(snapshot?.executionRun?.status)) return null;
  if (!snapshot?.result?.data || !['failed', 'blocked'].includes(snapshot?.result?.render?.status)) return null;
  return 'draft';
}

export function agentDisplayState(snapshot) {
  const statuses = [snapshot?.project?.status, snapshot?.activeJob?.status, snapshot?.executionRun?.status];
  const simple = snapshot?.project?.flowKind === 'simple_skill_v1';
  const draft = simple ? simpleEditableEditorState(snapshot) === 'draft' : false;
  const renderFailed = simple && draft && !simpleRenderedEditorState(snapshot);
  const failed = statuses.some(s => ['failed', 'interrupted', 'planning_failed', 'execution_failed', 'terminated'].includes(s)) || (simple && !draft && ['partial', 'awaiting_user_action', 'ready_to_render'].includes(snapshot?.project?.status) && ['failed', 'blocked'].includes(snapshot?.result?.render?.status));
  const cancelled = statuses.includes('cancelled');
  const completed = !failed && !cancelled && (simple ? simpleRenderedEditorState(snapshot) === 'complete' : statuses.some(s => ['complete', 'completed', 'ready_for_editor'].includes(s)));
  const disconnected = Boolean(snapshot?._connectionError) && !failed && !cancelled && !completed && !draft;
  const queued = !failed && !cancelled && statuses.includes('queued');
  return { failed, cancelled, completed, draft, renderFailed, disconnected, queued, frozen: failed || cancelled || completed || draft || disconnected };
}

export function displayAgentStages(stages, state) {
  if (state.failed) {
    const explicitFailure = stages.findIndex(stage => stage.state === 'failed');
    const activeFailure = stages.findIndex(stage => ['active', 'waiting', 'unknown'].includes(stage.state));
    const firstUnfinished = stages.findIndex(stage => stage.state !== 'complete');
    const failureIndex = explicitFailure >= 0 ? explicitFailure : activeFailure >= 0 ? activeFailure : firstUnfinished >= 0 ? firstUnfinished : Math.max(0, stages.length - 1);
    return stages.map((stage, index) => stage.state === 'complete' ? stage : { ...stage, state: stage.state === 'failed' || index === failureIndex ? 'failed' : 'pending' });
  }
  if (state.completed) return stages.map(stage => ({ ...stage, state: 'complete' }));
  return stages.map(stage => stage.state !== 'active' ? stage : { ...stage, state: state.cancelled ? 'cancelled' : stage.state });
}

export function agentElapsed(snapshot, now = Date.now()) {
  const state = agentDisplayState(snapshot);
  if (state.queued) return 0;
  const simple = snapshot?.project?.flowKind === 'simple_skill_v1';
  const queue = snapshot?.activeJob?.generationQueue || snapshot?.project?.generationQueue;
  // The persisted queue duration survives reopening and later editor saves.
  if (simple && ['complete', 'failed'].includes(queue?.state)
    && Number.isFinite(queue.executionMs) && queue.executionMs >= 0) {
    return Math.floor(queue.executionMs / 1000);
  }
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  const queueStart = timestamp(queue?.startedAt);
  const jobStart = timestamp(snapshot?.activeJob?.startedAt);
  if (simple && queue && !Number.isFinite(queueStart) && !Number.isFinite(jobStart)
    && ['queued', 'cancelled', 'interrupted'].includes(queue.state)
    && !Number.isFinite(queue.executionMs)) return 0;
  const terminalTime = state.draft
    ? snapshot?.activeJob?.completedAt || snapshot?.activeJob?.finishedAt || snapshot?.activeJob?.updatedAt || snapshot?.executionRun?.updatedAt || snapshot?.project?.updatedAt
    : snapshot?.executionRun?.updatedAt || snapshot?.activeJob?.updatedAt || snapshot?.project?.updatedAt;
  // Count planning from the whole-batch execution start, excluding admission
  // waiting. Older records without queue metadata retain their original clock.
  const submittedAt = timestamp(snapshot?.project?.createdAt || snapshot?.activeJob?.createdAt);
  const simpleStart = Number.isFinite(jobStart) ? jobStart : Number.isFinite(queueStart) ? queueStart
    : Number.isFinite(queue?.waitMs) && Number.isFinite(submittedAt) ? submittedAt + queue.waitMs : submittedAt;
  const startedAt = simple
    ? simpleStart || snapshot?.executionRun?.startedAt || snapshot?.executionRun?.createdAt
    : snapshot?.executionRun?.startedAt || snapshot?.activeJob?.startedAt || snapshot?.executionRun?.createdAt || snapshot?.activeJob?.createdAt || snapshot?.project?.createdAt;
  const end = state.disconnected ? snapshot?._observedAt : state.frozen ? Date.parse(terminalTime) : now;
  const start = timestamp(startedAt);
  return Math.max(0, Math.floor(((end || snapshot?._observedAt || now) - (Number.isFinite(start) ? start : now)) / 1000));
}

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function agentFailurePresentation(snapshot, stageLabel = '当前处理阶段') {
  if (snapshot?.project?.status === 'interrupted') {
    return { stageLabel, userMessage: '服务重启后本次制作已中断，已保存的资料仍然保留，请重新制作', technicalError: 'generation_process_interrupted' };
  }
  const latestEvent = snapshot?.activeJob?.latestEvent || snapshot?.executionRun?.events?.at?.(-1) || {};
  const rawError = snapshot?.project?.lastError || snapshot?.project?.error || snapshot?.executionRun?.error || snapshot?.activeJob?.error || latestEvent.error || latestEvent.reason || latestEvent.message;
  const technicalError = errorText(rawError) || '未提供技术错误信息';
  const clue = `${stageLabel} ${snapshot?.project?.currentStage || ''} ${snapshot?.activeJob?.currentStage || ''} ${technicalError}`;
  let userMessage = '系统在处理当前阶段时遇到问题';
  if (/解析|parser|source_parse/i.test(clue)) userMessage = '行程资料解析失败';
  else if (/规划|planner|planning|plan_validation/i.test(clue)) userMessage = '行程规划未通过校验';
  else if (/文案|copy/i.test(clue)) userMessage = '文案生成失败';
  else if (/图片|image/i.test(clue)) userMessage = '图片处理失败';
  else if (/写回|writeback|program_writeback|费用和重要信息/i.test(clue)) userMessage = '数据写回失败';
  else if (/渲染|renderer|render|长图/i.test(clue)) userMessage = '成品渲染失败';
  return { stageLabel, userMessage, technicalError };
}
