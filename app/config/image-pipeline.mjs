export const IMAGE_PIPELINE_CONFIG = Object.freeze({
  searchConcurrency: 3,
  auditInitialConcurrency: 2,
  auditMaximumConcurrency: 3,
  sourcePages: 5,
  imagesPerPage: 12,
  downloadsPerRound: 12,
  initialAuditCandidates: 4,
  terminalAuditCandidates: 2,
  maxAutomaticRounds: 2,
  slotTotalTimeoutMs: 240_000,
  searchDownloadTimeoutMs: 90_000,
  initialAuditTimeoutMs: 90_000,
  terminalAuditTimeoutMs: 90_000,
});

export function resolvedImagePipelineConfig(env = process.env) {
  const bounded = (value, fallback, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || fallback));
  return {
    ...IMAGE_PIPELINE_CONFIG,
    searchConcurrency: bounded(env.IMAGE_SLOT_CONCURRENCY, IMAGE_PIPELINE_CONFIG.searchConcurrency, 1, IMAGE_PIPELINE_CONFIG.searchConcurrency),
    auditConcurrency: bounded(env.IMAGE_AUDIT_CONCURRENCY, IMAGE_PIPELINE_CONFIG.auditInitialConcurrency, 1, IMAGE_PIPELINE_CONFIG.auditMaximumConcurrency),
    slotTotalTimeoutMs: bounded(env.IMAGE_SLOT_TIMEOUT_MS, IMAGE_PIPELINE_CONFIG.slotTotalTimeoutMs, 30_000, 600_000),
    searchDownloadTimeoutMs: bounded(env.IMAGE_SEARCH_DOWNLOAD_TIMEOUT_MS, IMAGE_PIPELINE_CONFIG.searchDownloadTimeoutMs, 10_000, 180_000),
    initialAuditTimeoutMs: bounded(env.IMAGE_INITIAL_AUDIT_TIMEOUT_MS, IMAGE_PIPELINE_CONFIG.initialAuditTimeoutMs, 10_000, 180_000),
    terminalAuditTimeoutMs: bounded(env.IMAGE_TERMINAL_AUDIT_TIMEOUT_MS, IMAGE_PIPELINE_CONFIG.terminalAuditTimeoutMs, 10_000, 180_000),
  };
}
