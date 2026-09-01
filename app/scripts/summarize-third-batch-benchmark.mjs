import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const projectDir = path.resolve(appDir, "..")
const evidenceRoot = path.join(projectDir, "audit", "evidence", "2026-08-31-分级推理与图片超时整改")
const baselineDir = path.join(
  projectDir,
  "audit",
  "evidence",
  "2026-08-31-DeepSeek文案流式并发整改",
  "real-run-2026-08-31T07-48-43-676Z",
)

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function sumUsage(job) {
  const records = [
    ...(job?.usage?.copy?.modules || []),
    ...(job?.usage?.copy?.brandReviews || []),
    ...(job?.usage?.blueprint ? [job.usage.blueprint] : []),
  ]
  return records.reduce(
    (total, record) => {
      const usage = record?.usage || {}
      total.promptTokens += Number(usage.prompt_tokens || 0)
      total.completionTokens += Number(usage.completion_tokens || 0)
      total.reasoningTokens += Number(usage.completion_tokens_details?.reasoning_tokens || 0)
      total.totalTokens += Number(usage.total_tokens || 0)
      total.attempts += Number(usage.attempt_count || record?.attemptUsages?.length || 0)
      return total
    },
    { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, attempts: 0 },
  )
}

function summarizeRun(dirName) {
  const dir = path.join(evidenceRoot, dirName)
  const summary = readJson(path.join(dir, "00-summary.json"))
  const ledger = readJson(path.join(dir, "08-image-ledger.json"))
  const job = readJson(path.join(dir, "03-generation-job.json"))
  const auditFailures = (ledger.candidates || []).filter((candidate) => candidate.auditFailure)
  const timeoutCandidates = auditFailures.filter((candidate) => candidate.auditFailure?.kind === "audit_timeout")
  const invalidAuditFailureCandidates = auditFailures.filter(
    (candidate) => candidate.status !== "manual_review"
      || candidate.adoptable !== true
      || candidate.requiresDecision !== true
      || candidate.hardRejectCode !== "none",
  )
  const maxRoundsObserved = Math.max(0, ...(ledger.slots || []).map((slot) => Number(slot.attempts || 0)))
  const profiles = [
    ...(summary.modelTaskProfiles?.copy || []).map((record) => ({
      taskKind: record.taskKind,
      profile: record.requestProfile,
    })),
    ...(summary.modelTaskProfiles?.brand || []).map((record) => ({
      taskKind: record.taskKind,
      profile: record.requestProfile,
    })),
    { taskKind: "imageBlueprint", profile: summary.modelTaskProfiles?.blueprint },
  ]
  return {
    label: dirName.replace(/-2026-.+$/, ""),
    evidenceDir: dir,
    generationId: summary.generationId,
    projectId: summary.projectId,
    cacheDisabled: summary.cacheDisabled,
    durationsMs: summary.phaseDurations,
    firstProviderResponseMs: summary.firstProviderResponseMs,
    firstContentMs: summary.firstContentMs,
    contentQuality: summary.contentQuality,
    image: {
      autoApproved: summary.imageLedgerStats?.autoApproved || 0,
      manualReviewSlots: summary.imageLedgerStats?.manualReviewSlots || 0,
      emptySlots: summary.imageLedgerStats?.emptySlots || 0,
      hardRejected: summary.imageLedgerStats?.hardRejected || 0,
      auditTimeout: summary.imageLedgerStats?.auditTimeout || 0,
      auditUnavailable: summary.imageLedgerStats?.auditUnavailable || 0,
      searchAttempts: summary.imageLedgerStats?.searchAttempts || 0,
      maxRoundsObserved,
      auditFailureCandidateCount: auditFailures.length,
      auditTimeoutCandidateCount: timeoutCandidates.length,
      invalidAuditFailureCandidateCount: invalidAuditFailureCandidates.length,
      concurrency: summary.imageConcurrency,
    },
    layout: {
      width: summary.finalLayoutReview?.width,
      height: summary.finalLayoutReview?.height,
      passed: summary.finalLayoutReview?.outputQa?.passed === true,
      outputFile: path.join(dir, "06-final-output-2000.png"),
    },
    usage: sumUsage(job),
    profiles,
  }
}

const formalDirs = fs.readdirSync(evidenceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^formal-[123]-/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (formalDirs.length !== 3) {
  throw new Error(`Expected exactly 3 formal runs, found ${formalDirs.length}`)
}

const runs = formalDirs.map(summarizeRun)
const baselineSummary = readJson(path.join(baselineDir, "00-summary.json"))
const baselineAutoApproved = Number(
  baselineSummary.imageLedgerStats?.autoApproved
    ?? baselineSummary.imageResearch?.stats?.autoApproved
    ?? baselineSummary.imageResearch?.selectedCount
    ?? 0,
)
const medians = {
  blueprintMs: median(runs.map((run) => run.durationsMs.blueprintMs)),
  imagePipelineMs: median(runs.map((run) => run.durationsMs.imagePipelineMs)),
  fullGenerationMs: median(runs.map((run) => run.durationsMs.fullGenerationMs)),
  autoApproved: median(runs.map((run) => run.image.autoApproved)),
  totalTokens: median(runs.map((run) => run.usage.totalTokens)),
  reasoningTokens: median(runs.map((run) => run.usage.reasoningTokens)),
}
const targetChecks = {
  blueprintAtMost4Minutes: medians.blueprintMs <= 4 * 60_000,
  imageAtMost10Minutes: medians.imagePipelineMs <= 10 * 60_000,
  fullAtMost16Minutes: medians.fullGenerationMs <= 16 * 60_000,
  automaticAdoptionNotBelowBaseline: medians.autoApproved >= baselineAutoApproved,
  everyRunCacheDisabled: runs.every((run) => run.cacheDisabled === true),
  everyRunSearchPeakAtMost3: runs.every((run) => Number(run.image.concurrency?.searchPeak || 0) <= 3),
  everyRunAuditPeakAtMost2: runs.every((run) => Number(run.image.concurrency?.auditPeak || 0) <= 2),
  everySlotAtMost2Rounds: runs.every((run) => run.image.maxRoundsObserved <= 2),
  auditFailuresNeverHardRejected: runs.every((run) => run.image.invalidAuditFailureCandidateCount === 0),
  everyLayoutPassedAt2000px: runs.every((run) => run.layout.width === 2000 && run.layout.passed),
  factsPreserved: runs.every((run) => run.contentQuality?.factsPreserved === true),
}

const result = {
  generatedAt: new Date().toISOString(),
  baseline: {
    evidenceDir: baselineDir,
    fullGenerationMs: baselineSummary.phaseDurations?.fullGenerationMs,
    blueprintMs: baselineSummary.phaseDurations?.blueprintMs,
    imagePipelineMs: baselineSummary.phaseDurations?.imagePipelineMs,
    autoApproved: baselineAutoApproved,
  },
  runs,
  medians,
  targetChecks,
  performanceStatus: targetChecks.blueprintAtMost4Minutes
    && targetChecks.imageAtMost10Minutes
    && targetChecks.fullAtMost16Minutes
    ? "performance_target_met"
    : "pending_optimization",
  acceptanceStatus: Object.values(targetChecks).every(Boolean)
    ? "pending_independent_review"
    : "pending_optimization_and_independent_review",
  costNote: "供应商响应未返回人民币或美元费用，本报告只汇总逐尝试 Token，不按未授权单价推算金额。",
}

const outputFile = path.join(evidenceRoot, "00-benchmark-summary.json")
fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8")
console.log(JSON.stringify({ outputFile, medians, targetChecks, performanceStatus: result.performanceStatus, acceptanceStatus: result.acceptanceStatus }, null, 2))
