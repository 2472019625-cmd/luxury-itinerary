// Small, URL-free projection for editor explanations. Detailed source evidence
// remains in the server ledger and must never enter customer copy.
export function knowledgeAttemptWasExecuted(attempt = {}) {
  // Older adapters omit admission counters; a successful remote terminal
  // response still proves execution. Failed local attempts never do.
  return Boolean(attempt.queryId || attempt.admission?.submitAttempts > 0
    || !attempt.admission && ['completed', 'needs_clarification'].includes(attempt.status));
}
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
  const planningIssues = (result.plannerValidationIssues || evidence.searchTrace?.planner?.issueCodes || []).map(issue => issue.code || issue);
  const duplicateOnly = planningIssues.includes("duplicate_visual_responsibility") && planningIssues.every(code => [
    "duplicate_visual_responsibility", "invalid_image_search_queries", "image_fidelity_query_missing",
    "image_alternate_queries_invalid", "scope_only_location_in_query",
  ].includes(code));
  return {
    planning: {
      blocked: result.technicalStatus === "planner_slot_unresolved",
      reason: duplicateOnly ? "duplicate_visual" : "target_unclear",
    },
    knowledge: {
      queryExecuted: knowledge.knowledgeQueryExecuted === true || attempts.some(knowledgeAttemptWasExecuted),
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
