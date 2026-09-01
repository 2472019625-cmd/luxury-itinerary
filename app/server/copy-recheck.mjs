import { COPY_RULE_VERSION } from '../config/copy-rule-runtime.mjs';
import { reviewCustomerContent } from './content-quality.mjs';
import { applySafeCopyCorrections } from './fact-provenance.mjs';
import { isBlockingCopyIssue } from './copy-repair.mjs';

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
  const safePass = applySafeCopyCorrections(data, sourceData);
  const report = reviewCustomerContent(safePass.data, { sourceData });
  const issues = uniqueIssues(report.issues);
  const hardIssues = issues.filter((item) => isBlockingCopyIssue(item));
  const passed = issues.length === 0;
  const status = passed ? 'passed' : hardIssues.length ? 'blocked_generation' : 'needs_copy_revision';
  const copyQuality = {
    ...(data.copyQuality || {}), version: '5.0', ruleVersion: COPY_RULE_VERSION,
    passed, status, needsReview: !passed && !hardIssues.length, blocked: hardIssues.length > 0,
    hardIssueCount: hardIssues.length, remainingIssueCount: issues.length, allIssues: issues,
    checkedAt: new Date().toISOString(), revisionMode: !passed,
  };
  return { data: { ...safePass.data, copyQuality }, contentQuality: { ...copyQuality, safeCorrections: safePass.corrections, factProvenance: safePass.provenance, finalReview: report, allIssues: issues } };
}
