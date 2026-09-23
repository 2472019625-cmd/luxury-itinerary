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

export function agentDisplayState(snapshot) {
  const statuses = [snapshot?.project?.status, snapshot?.activeJob?.status, snapshot?.executionRun?.status];
  const failed = statuses.some(s => ['failed', 'planning_failed', 'execution_failed', 'terminated'].includes(s));
  const cancelled = statuses.includes('cancelled');
  const completed = !failed && !cancelled && statuses.some(s => ['complete', 'completed', 'ready_for_editor'].includes(s));
  const disconnected = Boolean(snapshot?._connectionError) && !failed && !cancelled && !completed;
  return { failed, cancelled, completed, disconnected, frozen: failed || cancelled || completed || disconnected };
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
  const terminalTime = snapshot?.executionRun?.updatedAt || snapshot?.activeJob?.updatedAt || snapshot?.project?.updatedAt;
  const end = state.disconnected ? snapshot?._observedAt : state.frozen ? Date.parse(terminalTime) : now;
  return Math.max(0, Math.floor(((end || snapshot?._observedAt || now) - Date.parse(snapshot?.project?.createdAt || now)) / 1000));
}

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function agentFailurePresentation(snapshot, stageLabel = '当前处理阶段') {
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
