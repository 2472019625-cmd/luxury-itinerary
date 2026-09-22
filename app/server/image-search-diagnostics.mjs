// Small, URL-free projection for editor explanations. Detailed source evidence
// remains in the server ledger and must never enter customer copy.
export function buildImageSearchDiagnostic(result = {}) {
  const evidence = result.pipelineEvidence || {};
  const knowledge = evidence.knowledgeSearch || {};
  const web = evidence.webExecution || {};
  const route = evidence.explicitEntityFastPath || {};
  const attempts = Array.isArray(knowledge.attempts) ? knowledge.attempts : [];
  const parentProbeUsed = Boolean(route.parentProbeUsed || knowledge.scopePlan?.scopes?.some(scope => scope.role === "entity_parent_probe"));
  const missingDirectory = parentProbeUsed || [knowledge.status, knowledge.failureReason, route.knowledgeStopReason].includes("entity_directory_missing");
  const directoryStatus = missingDirectory ? "not_found"
    : knowledge.status === "needs_clarification" || knowledge.rootScopeResolution?.status === "ambiguous" ? "ambiguous"
      : knowledge.scopeResolution?.status === "resolved" ? "resolved" : "skipped";
  return {
    knowledge: {
      queryExecuted: knowledge.knowledgeQueryExecuted === true || attempts.length > 0,
      attempts: attempts.length, status: knowledge.status || "skipped", scopeState: knowledge.scopeState || null,
      directoryStatus, parentProbeUsed,
    },
    web: {
      entered: Boolean(route.enteredWeb || evidence.sourceFallback?.entered || web.executedQueries?.length),
      queryCount: web.executedQueries?.length || 0, pagesAccessed: web.pagesUsed || 0,
      pageFailures: evidence.pageFailures?.length || 0,
      downloadAttempts: (web.queryReports || []).reduce((sum, report) => sum + Number(report.downloadAttempts || 0), 0),
      stopReason: web.stopReason || null, pendingPages: web.pendingPages || 0,
      remainingPages: web.remainingPages ?? null, remainingDownloads: web.remainingDownloads ?? null,
    },
  };
}
