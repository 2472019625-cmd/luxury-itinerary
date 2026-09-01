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

export function generationStateLabel(status = {}, issueCount = 0) {
  if (status.status === 'complete' || status.phase === 'complete') return { tone: 'complete', title: '生成完成', detail: '全部检查通过，可以进入普通编辑器。' };
  if (status.status === 'needs_copy_revision' || status.phase === 'needs_copy_revision') return { tone: 'revision', title: `待文案修订：${issueCount}项`, detail: '图片和版面结果已保留；修订并复检通过后才能正式导出。' };
  if (status.status === 'blocked' || status.phase === 'blocked') return { tone: 'blocked', title: '已阻止生成', detail: '存在事实、费用、安全、内部信息或结构问题，不能进入编辑器或导出。' };
  if (status.status === 'failed') return { tone: 'failed', title: '生成失败', detail: status.error || '接口、网络或程序发生异常。' };
  return null;
}
