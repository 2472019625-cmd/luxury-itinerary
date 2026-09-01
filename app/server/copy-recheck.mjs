import { COPY_RULE_VERSION } from '../config/copy-rule-runtime.mjs';
import { reviewCustomerContent } from './content-quality.mjs';

function uniqueIssues(issues = []) {
  const values = new Map();
  for (const issue of issues.filter(Boolean)) {
    const key = `${issue.ruleIds?.join('/') || issue.ruleId || 'COPY'}:${issue.path || 'customer'}:${issue.code || ''}:${issue.message || ''}`;
    if (!values.has(key)) values.set(key, issue);
  }
  return [...values.values()];
}

export function recheckCopyData(data = {}) {
  const sourceData = data.copySourceFacts || data;
  const report = reviewCustomerContent(data, { sourceData });
  const issues = uniqueIssues(report.issues);
  const hardIssues = issues.filter((item) => ['fact','safety','structure'].includes(item?.severity) || item?.action === 'block');
  const passed = issues.length === 0;
  const status = passed ? 'passed' : hardIssues.length ? 'blocked_generation' : 'needs_final_review';
  const copyQuality = {
    ...(data.copyQuality || {}), version: '5.0', ruleVersion: COPY_RULE_VERSION,
    passed, status, needsReview: !passed && !hardIssues.length, blocked: hardIssues.length > 0,
    hardIssueCount: hardIssues.length, remainingIssueCount: issues.length, allIssues: issues,
    checkedAt: new Date().toISOString(), revisionMode: !passed,
  };
  return { data: { ...data, copyQuality }, contentQuality: { ...copyQuality, finalReview: report, allIssues: issues } };
}
