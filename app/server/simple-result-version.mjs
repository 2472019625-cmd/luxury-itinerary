// Call immediately before synchronous writes. No await may separate the check and commit.
export function assertSimpleResultCurrent({ store, project, run, result, code = 'manual_result_stale', operation } = {}) {
  const active = store.getProject(project.projectId);
  const latest = store.getFinalResult(project.projectId, run.executionRunId);
  const expected = result.manualImageCompletion || {};
  const current = latest?.manualImageCompletion || {};
  const stale = !latest || active?.activeExecutionRunId !== run.executionRunId || active?.activePlanId !== project.activePlanId ||
    Number(current.version || 0) !== Number(expected.version || 0) || (current.revision || null) !== (expected.revision || null);
  if (!stale) return;
  console.warn(JSON.stringify({ event: 'simple_result_stale', projectId: project.projectId, executionRunId: run.executionRunId,
    operation, expectedVersion: Number(expected.version || 0), currentVersion: Number(current.version || 0) }));
  throw Object.assign(new Error('项目内容已更新，本次操作未保存。请重试。'), { code });
}
