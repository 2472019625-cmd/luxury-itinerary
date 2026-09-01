const rules = (issue = {}) => [...new Set([...(issue.ruleIds || []), issue.ruleId].filter(Boolean))];

export function collectCopyIssues(contentQuality = {}) {
  const source = contentQuality.allIssues?.length ? contentQuality.allIssues : [
    ...(contentQuality.finalReview?.issues || []),
    ...(contentQuality.unresolvedIssues || []),
    ...(contentQuality.brandEditor?.unresolvedIssues || []),
  ];
  const unique = new Map();
  for (const issue of source.filter(Boolean)) {
    const item = { ...issue, ruleIds: rules(issue) };
    const key = `${item.ruleIds.join('/')}:${item.path || 'customer'}:${item.code || ''}:${item.message || ''}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

export function copyIssueGroup(issue = {}) {
  const path = String(issue.path || 'customer');
  const day = path.match(/^days\.(\d+)/);
  if (day) return `DAY ${Number(day[1]) + 1}`;
  const hotel = path.match(/^hotels\.(\d+)/);
  if (hotel) return `酒店 ${Number(hotel[1]) + 1}`;
  if (path.startsWith('notes')) return '注意事项';
  if (path.startsWith('highlights')) return '产品亮点';
  if (path.startsWith('transportSummary')) return '全程交通';
  if (path.startsWith('diningExperiences')) return '特色餐饮';
  if (/included|excluded|cancellation|expenses/.test(path)) return '费用';
  if (path === 'title' || path === 'subtitle') return '封面';
  return '全局';
}

export function groupCopyIssues(contentQuality = {}) {
  return collectCopyIssues(contentQuality).reduce((groups, issue) => {
    const key = copyIssueGroup(issue);
    if (!groups[key]) groups[key] = [];
    groups[key].push(issue);
    return groups;
  }, {});
}

export function copyIssueTargetPath(issue = {}) {
  const path = String(issue.path || 'customer');
  let match = path.match(/^days\.(\d+)/);
  if (match) return `days.${match[1]}`;
  match = path.match(/^hotels\.(\d+)/);
  if (match) return `hotels.${match[1]}`;
  match = path.match(/^diningExperiences\.(\d+)/);
  if (match) return `diningExperiences.${match[1]}`;
  match = path.match(/^transportSummary\.(\d+)/);
  if (match) return `transportSummary.${match[1]}`;
  if (path.startsWith('notes.')) return path.match(/^notes\.\d+\.items\.\d+/)?.[0] || path.match(/^notes\.\d+/)?.[0] || 'notes';
  if (path.startsWith('highlights')) return 'highlights';
  if (/^(includedCustomer|excludedCustomer|cancellationCustomer|included|excluded|cancellation|expenses)/.test(path)) return 'expenses';
  return path.split('.').slice(0, 2).join('.') || 'customer';
}

export function isCopyIssueAiRepairable(issue = {}) {
  if (issue.repairable === false || issue.action === 'user_confirmation') return false;
  if (issue.path === 'customer' || issue.code === 'brand_review_unavailable') return false;
  if (['fact','safety','structure'].includes(issue.severity) && !['safe_fact_fallback','safe_time_sensitive_fallback'].includes(issue.action)) return false;
  return issue.action !== 'block';
}

export function groupCopyIssueTargets(contentQuality = {}) {
  const targets = new Map();
  for (const issue of collectCopyIssues(contentQuality)) {
    const targetPath = copyIssueTargetPath(issue);
    if (!targets.has(targetPath)) targets.set(targetPath, { targetPath, label: copyIssueGroup(issue), issues: [], ruleIds: new Set(), aiRepairable: false });
    const target = targets.get(targetPath);
    target.issues.push(issue);
    rules(issue).forEach((ruleId) => target.ruleIds.add(ruleId));
    if (isCopyIssueAiRepairable(issue)) target.aiRepairable = true;
  }
  return [...targets.values()].map((target) => ({ ...target, ruleIds: [...target.ruleIds] }));
}

export function generationStateLabel(status = {}, issueCount = 0) {
  if (status.status === 'complete' || status.phase === 'complete') return { tone: 'complete', title: '生成完成', detail: '全部检查通过，可以进入普通编辑器。' };
  if (status.status === 'needs_copy_revision' || status.phase === 'needs_copy_revision') return { tone: 'revision', title: `待文案修订：${issueCount}项`, detail: '图片和版面结果已保留；可继续修订，也可查看全部问题并确认后按当前内容正式导出。' };
  if (status.status === 'blocked' || status.phase === 'blocked') return { tone: 'blocked', title: '待事实确认', detail: '完整预览已保留；可进入编辑器查看，但事实、费用或结构问题确认前不能正式导出。' };
  if (status.status === 'failed') return { tone: 'failed', title: '生成失败', detail: status.error || '接口、网络或程序发生异常。' };
  return null;
}

export function copyExportEligibility(project = {}) {
  const quality = project.data?.copyQuality || {};
  const hardBlocked = project.workflowStage === 'blocked' || quality.blocked === true || Number(quality.hardIssueCount || 0) > 0;
  const hasDraft = Array.isArray(project.data?.days) && project.data.days.length > 0;
  const hasWarnings = hasDraft && !hardBlocked && quality.passed !== true;
  return {
    allowed: hasDraft && !hardBlocked,
    hardBlocked,
    hasWarnings,
    requiresWarningAcknowledgement: hasWarnings,
  };
}
