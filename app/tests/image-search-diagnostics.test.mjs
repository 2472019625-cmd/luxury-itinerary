import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageSearchDiagnostic } from '../server/image-search-diagnostics.mjs';

test('诊断区分专属目录缺失未查询、父级已补查和联网已执行且不泄漏来源链接', () => {
  const skipped = buildImageSearchDiagnostic({ pipelineEvidence: {
    knowledgeSearch: { status: 'entity_directory_missing', attempts: [] },
    explicitEntityFastPath: { knowledgeStopReason: 'entity_directory_missing', enteredWeb: true },
    pageFailures: [{ status: 200, pageUrl: 'https://example.com/private?token=secret' }],
    webExecution: { executedQueries: ['query 1', 'query 2'], pagesUsed: 7, downloadsUsed: 3, remainingPages: 1, remainingDownloads: 3, stopReason: 'queries_exhausted', queryReports: [{ downloadAttempts: 3 }] },
  } });
  assert.equal(skipped.knowledge.queryExecuted, false);
  assert.equal(skipped.knowledge.directoryStatus, 'not_found');
  assert.equal(skipped.web.entered, true);
  assert.equal(skipped.web.queryCount, 2);
  assert.equal(skipped.web.pageFailures, 1);
  assert.ok(!JSON.stringify(skipped).includes('secret'));
  const probed = buildImageSearchDiagnostic({ pipelineEvidence: { knowledgeSearch: {
    status: 'completed', scopeState: 'no_match', attempts: [{ status: 'completed' }],
    scopePlan: { scopes: [{ role: 'entity_parent_probe' }] }, scopeResolution: { status: 'resolved' },
  } } });
  assert.equal(probed.knowledge.queryExecuted, true);
  assert.equal(probed.knowledge.parentProbeUsed, true);
  assert.equal(probed.knowledge.directoryStatus, 'not_found');
  assert.equal(probed.web.entered, false);
});
