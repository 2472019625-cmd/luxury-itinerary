import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { searchWeb } from "./image-search.mjs";
import { extractPageImages } from "./page-images.mjs";
import { downloadCandidate } from "./image-download.mjs";
import { ImageDeduper } from "./image-dedupe.mjs";
import { auditCandidates, validateCandidate } from "./image-audit.mjs";
import { applySelections, buildImageSlots } from "./image-allocator.mjs";
import { writeImageLedger } from "./image-ledger.mjs";
import { searchCommonsImages } from "./commons-search.mjs";
import { classifyImageCandidate, IMAGE_REVIEW_STATE } from "../src/lib/imageReviewPolicy.js";
import { cacheKey, createImageResearchCache } from "./image-cache.mjs";
import { resolvedImagePipelineConfig } from "../config/image-pipeline.mjs";

export function imagePipelineLimits(env = process.env) {
  const config = resolvedImagePipelineConfig(env);
  return {
    searchConcurrency: config.searchConcurrency,
    auditConcurrency: config.auditConcurrency,
    auditMaximumConcurrency: config.auditMaximumConcurrency,
    sourcePages: config.sourcePages,
    imagesPerPage: config.imagesPerPage,
    downloadsPerRound: config.downloadsPerRound,
    initialAudit: config.initialAuditCandidates,
    terminalAudit: config.terminalAuditCandidates,
    maxAutomaticRounds: config.maxAutomaticRounds,
    slotTotalTimeoutMs: config.slotTotalTimeoutMs,
    searchDownloadTimeoutMs: config.searchDownloadTimeoutMs,
    initialAuditTimeoutMs: config.initialAuditTimeoutMs,
    terminalAuditTimeoutMs: config.terminalAuditTimeoutMs,
  };
}

export class ConcurrentTaskQueue {
  constructor(concurrency) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.active = 0;
    this.peakActive = 0;
    this.pending = [];
  }
  add(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.#drain();
    });
  }
  #drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const entry = this.pending.shift();
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1;
        this.#drain();
      });
    }
  }
}

export async function settledMap(items, limit, worker) {
  const queue = new ConcurrentTaskQueue(limit);
  return Promise.all(items.map((item, index) => queue.add(async () => {
    try { return await worker(item, index); } catch (error) { return { error: error?.message || String(error) }; }
  })));
}

export function classifyAuditFailure(error) {
  const status = Number(error?.status || 0) || null;
  const code = String(error?.code || "");
  if (error?.name === "AbortError" || code === "audit_timeout" || /timeout|超时/i.test(error?.message || "")) return { kind: "audit_timeout", status, reason: "视觉审核超时，需人工确认" };
  if (status === 429 || code === "audit_rate_limited") return { kind: "audit_unavailable", status: 429, reason: "视觉审核服务限流，需人工确认" };
  if (status >= 500 || code === "audit_service_error") return { kind: "audit_unavailable", status, reason: "视觉审核服务暂时不可用，需人工确认" };
  if (code === "audit_invalid_json") return { kind: "audit_unavailable", status, reason: "视觉审核结果格式异常，需人工确认" };
  return { kind: "audit_unavailable", status, reason: "视觉审核未完成，需人工确认" };
}

export function shouldContinueAutomaticSearch({ selected = false, manualAvailable = false, allCandidatesHardRejected = false, downloadableCandidateCount = 0, round = 1, maxRounds = 2 } = {}) {
  if (selected || manualAvailable || round >= maxRounds) return false;
  return downloadableCandidateCount === 0 || allCandidatesHardRejected;
}

export function baseScore(candidate, slot = {}) {
  const words = `${candidate.alt || ""} ${candidate.title || ""}`.toLowerCase();
  const anchors = [slot.subject, slot.brand, slot.label].filter(Boolean).flatMap((value) => String(value).toLowerCase().split(/\s+|[-–—·]/)).filter((value) => value.length >= 3);
  const textMatch = anchors.some((word) => words.includes(word)) ? 10 : 0;
  const ratio = Number(candidate.width || 0) / Math.max(1, Number(candidate.height || 1));
  const composition = ratio >= 1.2 && ratio <= 2.4 ? 5 : 0;
  return (candidate.officialHint ? 40 : 0)
    + (candidate.kind === "commons" ? 24 : candidate.kind === "og:image" ? 20 : candidate.kind === "twitter:image" ? 12 : 0)
    + Math.min(20, Math.round((candidate.width * candidate.height) / 500_000))
    + textMatch + composition - candidate.searchRank * 2;
}

function queryForRound(slot, round) {
  if (slot.queries?.[round - 1]) return slot.queries[round - 1];
  if (round === 1) return slot.query;
  const fallback = slot.fallbackPlan?.[round - 2];
  if (fallback) return `${slot.subject} ${slot.location || ""} ${fallback}`.slice(0, 180);
  return `${slot.brand || slot.label} ${slot.location || slot.context} ${slot.subject} official gallery photos`.trim().slice(0, 180);
}

export function candidateRecordId(slotId, attempt, sha256) {
  return createHash("sha256").update(`${slotId}\n${attempt}\n${sha256}`).digest("hex");
}

export function uniqueCandidatesByContent(candidates = []) {
  const seenContentHashes = new Set();
  return candidates.filter((item) => {
    if (!item?.sha256 || seenContentHashes.has(item.sha256)) return false;
    seenContentHashes.add(item.sha256);
    return true;
  });
}

async function candidatesForSlotRound(slot, round, options) {
  const { config } = options;
  const query = queryForRound(slot, round);
  const searchKey = cacheKey(options.searchModel, query, slot.location, slot.subject);
  let pages = options.disableCache ? null : options.cache.get("search", searchKey);
  if (!pages) {
    pages = await options.trackCapabilityCall("image_search", `${slot.key}:round:${round}`, () => searchWeb({ query, apiKey: options.searchApiKey, baseUrl: options.searchBaseUrl, model: options.searchModel, count: config.sourcePages, signal: options.signal }));
    if (!options.disableCache) await options.cache.set("search", searchKey, pages);
  }
  const pageGroups = await settledMap(pages.slice(0, config.sourcePages), 3, async (page) => {
    const key = cacheKey(page.pageUrl, config.imagesPerPage);
    const cached = options.disableCache ? null : options.cache.get("page-images", key);
    if (cached) return cached;
    const found = await extractPageImages(page, { signal: options.signal, maxImages: config.imagesPerPage });
    if (!options.disableCache) await options.cache.set("page-images", key, found);
    return found;
  });
  let raw = pageGroups.flatMap((value) => Array.isArray(value) ? value : []).filter((item, index, array) => array.findIndex((other) => other.imageUrl === item.imageUrl) === index);
  if (round > 1 && raw.length < 12) {
    const commons = await searchCommonsImages(query, { signal: options.signal, count: 12 }).catch(() => []);
    raw = [...raw, ...commons].filter((item, index, array) => array.findIndex((other) => other.imageUrl === item.imageUrl) === index);
  }
  raw = raw.slice(0, config.downloadsPerRound);
  const downloaded = await settledMap(raw, 3, (candidate) => downloadCandidate(candidate, { directory: options.assetDirectory, publicPrefix: options.publicPrefix, signal: options.signal }));
  const allCandidates = uniqueCandidatesByContent(downloaded.filter((item) => item?.filePath).sort((a, b) => baseScore(b, slot) - baseScore(a, slot)));
  return { query, sourcePageCount: Math.min(config.sourcePages, pages.length), extractedCount: raw.length, downloadedCount: allCandidates.length, allCandidates, candidates: allCandidates.slice(0, config.initialAuditCandidates) };
}

async function runTimedStage(state, stage, timeoutMs, worker) {
  const remaining = Math.max(0, state.config.slotTotalTimeoutMs - state.activeMs);
  const budget = Math.min(remaining, timeoutMs);
  if (!budget) {
    const error = new Error(`图片位总体预算已在${stage}前耗尽`);
    error.name = "AbortError";
    error.code = stage.includes("audit") ? "audit_timeout" : "stage_timeout";
    throw error;
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), budget);
  let outcome = "complete";
  const combinedSignal = state.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([state.signal, controller.signal]) : controller.signal;
  try {
    return await worker(combinedSignal);
  } catch (cause) {
    outcome = controller.signal.aborted ? "timeout" : "error";
    if (controller.signal.aborted) {
      const error = new Error(`${stage}超时`, { cause });
      error.name = "AbortError";
      error.code = stage.includes("audit") ? "audit_timeout" : "stage_timeout";
      throw error;
    }
    throw cause;
  } finally {
    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;
    state.activeMs += durationMs;
    state.stageTimings.push({ stage, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), durationMs, outcome });
    clearTimeout(timer);
  }
}

function imageRecord(candidate, audit) {
  return {
    src: candidate.publicUrl, focus: "50% 50%", sourcePage: candidate.pageUrl, originalImageUrl: candidate.imageUrl,
    sourceTitle: candidate.title, sourceMedia: candidate.media, license: candidate.license || null, creator: candidate.creator || null,
    officialSource: Boolean(candidate.officialHint), width: candidate.width, height: candidate.height, sha256: candidate.sha256,
    dHash: candidate.dHash, perceptualHash: candidate.dHash,
    audit: audit ? { score: audit.score, reason: audit.reason, relevance: audit.relevance, luxury: audit.luxury, cleanliness: audit.cleanliness, composition: audit.composition } : null,
  };
}

export async function resolveItineraryImages(data, { root, apiKey, baseUrl, model, searchApiKey, searchBaseUrl, searchModel, onlySlotIds = [], disableCache = false, onProgress = () => {}, onCapabilityCall = () => {}, signal } = {}) {
  if (process.env.IMAGE_PIPELINE_ENABLED === "off") return { data, summary: { enabled: false } };
  const config = resolvedImagePipelineConfig();
  const runId = randomUUID();
  const assetDirectory = path.join(root, "output", "image-assets", runId);
  const ledgerDirectory = path.join(root, "output", "image-ledgers");
  await mkdir(assetDirectory, { recursive: true });
  const requestedSlots = new Set(onlySlotIds || []);
  const slots = buildImageSlots(data, { includeLocked: requestedSlots.size > 0 }).filter((slot) => !requestedSlots.size || requestedSlots.has(slot.key));
  if (requestedSlots.size && !slots.length) throw new Error("指定图片位不存在或已不再适用");
  const deduper = new ImageDeduper();
  deduper.seed((data.imageSourceLedger || []).filter((item) => !requestedSlots.has(item.slotId || item.slot)));
  const selections = [];
  const failures = [];
  const reviews = [];
  const candidatesLedger = [];
  const cache = await createImageResearchCache(root);
  const publicPrefix = `/image-assets/${runId}`;
  const searchQueue = new ConcurrentTaskQueue(config.searchConcurrency);
  const auditQueue = new ConcurrentTaskQueue(config.auditConcurrency);
  const states = slots.map((slot) => ({ slot, config, signal, activeMs: 0, attempts: 0, selected: false, manualAvailable: false, searched: false, accounted: false, lastStage: "search", lastReason: "尚未找到合格图片", stopReason: "", stageTimings: [] }));
  const stats = { slotCount: slots.length, searchedSlots: 0, searchAttempts: 0, candidateCount: 0, initialAuditCalls: 0, terminalAuditCalls: 0, auditedCandidates: 0, autoApproved: 0, manualReviewCandidates: 0, manualReviewSlots: 0, hardRejected: 0, auditTimeout: 0, auditUnavailable: 0, emptySlots: 0, failedSlots: 0, resolvedSlots: 0, processingSlots: 0, searchDownloadMs: 0, initialAuditMs: 0, terminalAuditMs: 0 };
  const report = (stage, label, currentAction) => {
    stats.manualReviewCandidates = candidatesLedger.filter((item) => item.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW && item.adoptable).length;
    stats.manualReviewSlots = new Set(candidatesLedger.filter((item) => item.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW && item.adoptable).map((item) => item.slotId)).size;
    stats.processingSlots = searchQueue.active + auditQueue.active;
    const effectiveStage = stats.resolvedSlots < slots.length
      ? auditQueue.active > 0 ? "auditing" : searchQueue.active > 0 || stage === "searching" ? "searching" : stage
      : stage;
    onProgress({ stage: effectiveStage, label, currentAction, current: stats.resolvedSlots, total: slots.length, stats: { ...stats, manualReview: stats.manualReviewSlots } });
  };

  async function trackedCall(capabilityId, target, worker) {
    const callId = randomUUID();
    const startedAt = Date.now();
    onCapabilityCall({ phase: "started", capabilityId, callId, stage: "images", target });
    try {
      const result = await worker();
      onCapabilityCall({ phase: "finished", capabilityId, callId, stage: "images", target, durationMs: Date.now() - startedAt, attemptCount: 1 });
      return result;
    } catch (error) {
      onCapabilityCall({ phase: "finished", capabilityId, callId, stage: "images", target, durationMs: Date.now() - startedAt, attemptCount: 1, failed: true, cancelled: error?.name === "AbortError" || signal?.aborted, reason: error?.message || String(error) });
      throw error;
    }
  }

  function ledgerItemFor(state, candidate) {
    return candidatesLedger.find((item) => item.candidateId === candidateRecordId(state.slot.key, state.attempts, candidate.sha256));
  }

  function markManual(state, candidate, reason, auditFailure = null, audit = null) {
    const item = ledgerItemFor(state, candidate);
    if (item) Object.assign(item, { status: IMAGE_REVIEW_STATE.MANUAL_REVIEW, adoptable: true, libraryEligible: true, requiresDecision: true, stage: "terminal_audit", reason, hardRejectCode: "none", auditFailure, ...(audit ? { terminalAudit: audit } : {}) });
    state.manualAvailable = true;
    reviews.push({ candidateId: item?.candidateId, sha256: candidate.sha256, slot: state.slot.key, attempt: state.attempts, localPreviewUrl: candidate.publicUrl, imageUrl: candidate.imageUrl, sourcePage: candidate.pageUrl, selected: false, stage: "manual_review", reason, auditFailure, ...(audit || {}) });
  }

  function markAuditFailure(state, candidates, error) {
    const failure = classifyAuditFailure(error);
    if (failure.kind === "audit_timeout") stats.auditTimeout += 1;
    else stats.auditUnavailable += 1;
    for (const candidate of candidates) markManual(state, candidate, failure.reason, { kind: failure.kind, status: failure.status });
    state.lastStage = "audit";
    state.lastReason = failure.reason;
    state.stopReason = failure.kind;
    return { selected: false, manualAvailable: true, allCandidatesHardRejected: false };
  }

  async function auditAttempt(state, attempt) {
    const candidates = attempt.candidates.slice(0, config.initialAuditCandidates);
    if (!candidates.length) return { selected: false, manualAvailable: false, allCandidatesHardRejected: false };
    let ranking;
    try {
      stats.initialAuditCalls += 1;
      const before = Date.now();
      ranking = await runTimedStage(state, "initial_audit", config.initialAuditTimeoutMs, (signal) => apiKey && process.env.IMAGE_VISUAL_AUDIT !== "off"
        ? trackedCall("visual_auditor", `${state.slot.key}:initial`, () => auditCandidates({ slot: state.slot, candidates, apiKey, baseUrl, model, signal }))
        : auditCandidates({ slot: state.slot, candidates, apiKey, baseUrl, model, signal }));
      stats.initialAuditMs += Date.now() - before;
    } catch (error) {
      return markAuditFailure(state, candidates, error);
    }
    const rankedIndexes = new Set(ranking.map((item) => item.index));
    candidates.forEach((candidate, index) => {
      const item = ledgerItemFor(state, candidate);
      if (item && !rankedIndexes.has(index)) Object.assign(item, { status: IMAGE_REVIEW_STATE.MANUAL_REVIEW, adoptable: false, libraryEligible: false, requiresDecision: false, stage: "initial_audit", reason: "初审未进入终审名单，仅供查看" });
    });
    if (!ranking.length) {
      for (const candidate of candidates) {
        const item = ledgerItemFor(state, candidate);
        if (item) Object.assign(item, { status: IMAGE_REVIEW_STATE.HARD_REJECTED, adoptable: false, libraryEligible: false, requiresDecision: false, stage: "initial_audit", reason: "视觉初审未保留该候选，不进入人工可采用清单", hardRejectCode: "forbid" });
      }
      stats.hardRejected += candidates.length;
      state.lastStage = "audit";
      state.lastReason = "视觉初审未保留任何候选";
      state.stopReason = "initial_audit_rejected_all";
      return { selected: false, manualAvailable: false, allCandidatesHardRejected: true };
    }
    let hardCount = 0;
    const terminal = ranking.slice(0, config.terminalAuditCandidates);
    for (let index = 0; index < terminal.length; index += 1) {
      if (index > 0 && hardCount !== index) break;
      const initialAudit = terminal[index];
      const candidate = candidates[initialAudit.index];
      if (!candidate) continue;
      const item = ledgerItemFor(state, candidate);
      if (item) Object.assign(item, { status: IMAGE_REVIEW_STATE.MANUAL_REVIEW, stage: "terminal_audit", initialAudit });
      let validation;
      try {
        stats.terminalAuditCalls += 1;
        const before = Date.now();
        const auditKey = cacheKey(candidate.sha256, model, state.slot.module, state.slot.mustHave || [], state.slot.forbid || []);
        validation = disableCache ? null : cache.get("terminal-audit", auditKey);
        if (!validation) {
          validation = await runTimedStage(state, "terminal_audit", config.terminalAuditTimeoutMs, (signal) => apiKey && process.env.IMAGE_VISUAL_AUDIT !== "off"
            ? trackedCall("visual_auditor", `${state.slot.key}:terminal:${index + 1}`, () => validateCandidate({ slot: state.slot, candidate, apiKey, baseUrl, model, signal }))
            : validateCandidate({ slot: state.slot, candidate, apiKey, baseUrl, model, signal }));
          if (!disableCache) await cache.set("terminal-audit", auditKey, validation);
        }
        stats.terminalAuditMs += Date.now() - before;
      } catch (error) {
        return markAuditFailure(state, [candidate], error);
      }
      stats.auditedCandidates += 1;
      const classification = classifyImageCandidate({ slot: state.slot, candidate, audit: validation });
      if (item) Object.assign(item, { status: classification.state, adoptable: classification.adoptable, libraryEligible: classification.state !== IMAGE_REVIEW_STATE.HARD_REJECTED && classification.adoptable, requiresDecision: classification.state === IMAGE_REVIEW_STATE.MANUAL_REVIEW, stage: "terminal_audit", reason: classification.reason, hardRejectCode: classification.hardRejectCode, terminalAudit: validation });
      if (classification.state === IMAGE_REVIEW_STATE.HARD_REJECTED) {
        hardCount += 1;
        stats.hardRejected += 1;
        reviews.push({ candidateId: item?.candidateId, sha256: candidate.sha256, slot: state.slot.key, attempt: state.attempts, localPreviewUrl: candidate.publicUrl, imageUrl: candidate.imageUrl, sourcePage: candidate.pageUrl, selected: false, stage: "audit", ...validation });
        continue;
      }
      if (classification.state === IMAGE_REVIEW_STATE.MANUAL_REVIEW) {
        markManual(state, candidate, classification.reason, null, validation);
        state.stopReason = "manual_candidate";
        return { selected: false, manualAvailable: true, allCandidatesHardRejected: false };
      }
      const decision = await deduper.accept(candidate);
      if (!decision.accepted) {
        if (item) Object.assign(item, { status: IMAGE_REVIEW_STATE.HARD_REJECTED, adoptable: false, libraryEligible: false, requiresDecision: false, stage: "dedupe", reason: decision.reason, hardRejectCode: "duplicate", duplicateOf: decision.duplicateOf });
        hardCount += 1;
        stats.hardRejected += 1;
        reviews.push({ candidateId: item?.candidateId, sha256: candidate.sha256, slot: state.slot.key, attempt: state.attempts, localPreviewUrl: candidate.publicUrl, imageUrl: candidate.imageUrl, sourcePage: candidate.pageUrl, selected: false, stage: "dedupe", reason: decision.reason, duplicateOf: decision.duplicateOf });
        continue;
      }
      candidate.dHash = decision.dHash;
      const record = imageRecord(candidate, { ...initialAudit, ...validation, score: Math.min(initialAudit.score ?? 100, validation.relevance ?? 0) });
      if (!data.imageLocks?.[state.slot.key]) selections.push({ slot: state.slot, images: [{ src: record.src, focus: record.focus, sourcePage: record.sourcePage }], records: [record] });
      state.selected = true;
      state.stopReason = "auto_approved";
      stats.autoApproved += 1;
      if (item) Object.assign(item, { status: IMAGE_REVIEW_STATE.AUTO_APPROVED, adoptable: true, libraryEligible: true, requiresDecision: false, selected: !data.imageLocks?.[state.slot.key], stage: "complete", reason: validation.reason, terminalAudit: validation });
      reviews.push({ candidateId: item?.candidateId, sha256: candidate.sha256, slot: state.slot.key, attempt: state.attempts, localPreviewUrl: candidate.publicUrl, imageUrl: candidate.imageUrl, sourcePage: candidate.pageUrl, selected: !data.imageLocks?.[state.slot.key], stage: "complete", ...validation });
      return { selected: true, manualAvailable: false, allCandidatesHardRejected: false };
    }
    const unreviewedRanked = ranking.slice(config.terminalAuditCandidates).map((audit) => candidates[audit.index]).filter(Boolean);
    if (unreviewedRanked.length) {
      for (const candidate of unreviewedRanked) markManual(state, candidate, "已通过初审但未完成终审，保留供人工确认");
      state.stopReason = "manual_candidate_after_terminal_limit";
      return { selected: false, manualAvailable: true, allCandidatesHardRejected: false };
    }
    state.lastStage = "audit";
    state.lastReason = "候选图片均有明确硬错误";
    return { selected: false, manualAvailable: false, allCandidatesHardRejected: hardCount > 0 && hardCount === terminal.length };
  }

  function recordCandidates(state, round, attempt) {
    attempt.allCandidates.forEach((candidate, candidateIndex) => candidatesLedger.push({
      candidateId: candidateRecordId(state.slot.key, round, candidate.sha256), slotId: state.slot.key, label: state.slot.label, priority: state.slot.priority,
      attempt: round, query: attempt.query, localPreviewUrl: candidate.publicUrl, originalImageUrl: candidate.imageUrl, sourcePage: candidate.pageUrl,
      sourceTitle: candidate.title, officialSource: Boolean(candidate.officialHint), width: candidate.width, height: candidate.height, sha256: candidate.sha256,
      baseScore: baseScore(candidate, state.slot), status: IMAGE_REVIEW_STATE.MANUAL_REVIEW, adoptable: false, libraryEligible: false,
      requiresDecision: false, shortlist: candidateIndex < config.initialAuditCandidates, stage: "download",
      reason: candidateIndex < config.initialAuditCandidates ? "已下载，等待视觉审核" : "基础排序未进入前4，仅供查看",
    }));
  }

  async function processState(state) {
    for (let round = 1; round <= config.maxAutomaticRounds; round += 1) {
      state.attempts = round;
      report("searching", state.slot.label, `正在搜索并下载：${state.slot.label}`);
      let attempt;
      try {
        attempt = await searchQueue.add(async () => {
          const before = Date.now();
          try { return await runTimedStage(state, "search_download", config.searchDownloadTimeoutMs, (signal) => candidatesForSlotRound(state.slot, round, { searchApiKey, searchBaseUrl, searchModel, assetDirectory, publicPrefix, cache, disableCache, signal, config, trackCapabilityCall: trackedCall })); }
          finally { stats.searchDownloadMs += Date.now() - before; }
        });
        stats.searchAttempts += 1;
        if (!state.searched) { state.searched = true; stats.searchedSlots += 1; }
        stats.candidateCount += attempt.allCandidates.length;
        recordCandidates(state, round, attempt);
        report("searching", state.slot.label, `已完成第 ${round} 轮搜索与下载：${state.slot.label}`);
      } catch (error) {
        state.lastStage = "search";
        state.lastReason = error?.name === "AbortError" ? "搜索与下载阶段超时" : error?.message || String(error);
        attempt = { allCandidates: [], candidates: [], query: queryForRound(state.slot, round) };
      }
      if (!attempt.candidates.length) {
        if (shouldContinueAutomaticSearch({ downloadableCandidateCount: 0, round, maxRounds: config.maxAutomaticRounds })) continue;
        state.stopReason = state.lastReason === "尚未找到合格图片" ? "no_downloadable_candidates" : "search_unavailable";
        break;
      }
      report("auditing", state.slot.label, `正在审核第 ${round} 轮候选：${state.slot.label}`);
      const outcome = await auditQueue.add(() => auditAttempt(state, attempt));
      if (!shouldContinueAutomaticSearch({ ...outcome, downloadableCandidateCount: attempt.candidates.length, round, maxRounds: config.maxAutomaticRounds })) break;
      state.stopReason = "all_candidates_hard_rejected_retrying";
    }
    if (!state.accounted) { state.accounted = true; stats.resolvedSlots += 1; }
    report("finalizing", state.slot.label, `已完成搜索与审核：${state.slot.label}`);
  }

  await Promise.all(states.map(processState));
  stats.searchDownloadMs = states.flatMap((state) => state.stageTimings).filter((item) => item.stage === "search_download").reduce((sum, item) => sum + item.durationMs, 0);
  stats.initialAuditMs = states.flatMap((state) => state.stageTimings).filter((item) => item.stage === "initial_audit").reduce((sum, item) => sum + item.durationMs, 0);
  stats.terminalAuditMs = states.flatMap((state) => state.stageTimings).filter((item) => item.stage === "terminal_audit").reduce((sum, item) => sum + item.durationMs, 0);
  const next = applySelections(data, selections);
  if (requestedSlots.size) next.imageSourceLedger = [...(data.imageSourceLedger || []).filter((item) => !requestedSlots.has(item.slot)), ...(next.imageSourceLedger || [])];
  const reviewSlots = states.map((state) => {
    const selection = selections.find((item) => item.slot.key === state.slot.key);
    const candidates = candidatesLedger.filter((item) => item.slotId === state.slot.key);
    const status = selection ? "auto_selected" : data.imageLocks?.[state.slot.key] ? "user_locked" : candidates.some((item) => item.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW && item.adoptable) ? "manual_review" : "empty";
    if (status === "empty") failures.push({ slot: state.slot.key, slotId: state.slot.key, label: state.slot.label, query: queryForRound(state.slot, Math.max(1, state.attempts)), stage: state.lastStage, reason: state.lastReason, error: state.lastReason, attempts: state.attempts, action: "manual_upload_or_targeted_research", stopReason: state.stopReason || "budget_exhausted" });
    return { slotId: state.slot.key, label: state.slot.label, module: state.slot.module, imageCount: state.slot.imageCount, status, attempts: state.attempts, stopReason: state.stopReason || (status === "manual_review" ? "manual_candidate" : status), stageTimings: state.stageTimings, candidateIds: candidates.map((item) => item.candidateId), selectedCandidateIds: candidates.filter((item) => item.selected).map((item) => item.candidateId) };
  });
  stats.manualReviewCandidates = candidatesLedger.filter((item) => item.status === IMAGE_REVIEW_STATE.MANUAL_REVIEW && item.adoptable).length;
  stats.manualReviewSlots = reviewSlots.filter((item) => item.status === "manual_review").length;
  stats.emptySlots = reviewSlots.filter((item) => item.status === "empty").length;
  stats.failedSlots = stats.emptySlots;
  stats.resolvedSlots = reviewSlots.length;
  stats.processingSlots = 0;
  const pendingCount = stats.manualReviewSlots;
  next.imageFailures = requestedSlots.size ? [...(data.imageFailures || []).filter((item) => !requestedSlots.has(item.slotId || item.slot)), ...failures] : failures;
  next.imageCandidates = requestedSlots.size ? [...(data.imageCandidates || []).filter((item) => !requestedSlots.has(item.slotId)), ...candidatesLedger] : candidatesLedger;
  const mergedReviewSlots = requestedSlots.size ? [...(data.imageReview?.slots || []).filter((item) => !requestedSlots.has(item.slotId)), ...reviewSlots] : reviewSlots;
  next.imageReview = { version: 2, runId, slots: mergedReviewSlots, stats: { ...stats, manualReview: pendingCount }, pendingCount, updatedAt: Date.now() };
  const ledger = {
    runId, destination: data.destination, searchProvider: "vveai-openai-compatible", searchModel,
    concurrency: { search: config.searchConcurrency, searchPeak: searchQueue.peakActive, audit: config.auditConcurrency, auditPeak: auditQueue.peakActive, auditMaximum: config.auditMaximumConcurrency },
    limits: imagePipelineLimits(), disableCache, slotOrder: slots.map(({ key, priority }) => ({ slotId: key, priority })), slotCount: slots.length,
    selectedCount: selections.reduce((sum, item) => sum + item.images.length, 0), stats, failures, slots: reviewSlots, sources: next.imageSourceLedger, candidates: candidatesLedger, reviews,
    licenseNotice: "来源记录用于素材追溯，不等同于取得商业使用授权；客户正式发布前应复核品牌媒体使用许可。",
  };
  const ledgerFile = await writeImageLedger(ledgerDirectory, runId, ledger);
  next.imageResearch = { runId, searchProvider: ledger.searchProvider, searchModel, concurrency: ledger.concurrency, limits: ledger.limits, selectedCount: ledger.selectedCount, slotCount: slots.length, failedCount: stats.failedSlots, emptySlotCount: stats.emptySlots, pendingReviewCount: pendingCount, stats: { ...stats, manualReview: pendingCount }, failures, ledgerUrl: `/api/image-ledgers/${runId}` };
  report("complete", "图片处理完成", "图片搜索、检查与分配完成，人工候选与缺图可在编辑器处理");
  return { data: next, summary: next.imageResearch, ledgerFile };
}
