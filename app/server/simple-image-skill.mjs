import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditCandidates, validateCandidate } from "./image-audit.mjs";
import { ImageDeduper } from "./image-dedupe.mjs";
import { downloadCandidate } from "./image-download.mjs";
import { searchWeb } from "./image-search.mjs";
import { extractPageImages } from "./page-images.mjs";
import { searchCommonsImages } from "./commons-search.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hardRejectCodes = new Set(["watermark", "subject_mismatch", "place_mismatch", "broken", "low_resolution", "low_quality", "forbid"]);

class TaskQueue {
  constructor(limit) { this.limit = Math.max(1, Number(limit) || 1); this.active = 0; this.peak = 0; this.pending = []; }
  add(worker) {
    return new Promise((resolve, reject) => { this.pending.push({ worker, resolve, reject }); this.drain(); });
  }
  drain() {
    while (this.active < this.limit && this.pending.length) {
      const task = this.pending.shift(); this.active += 1; this.peak = Math.max(this.peak, this.active);
      Promise.resolve().then(task.worker).then(task.resolve, task.reject).finally(() => { this.active -= 1; this.drain(); });
    }
  }
}

const text = (value) => typeof value === "string" ? value.trim() : value?.name || value?.officialName || value?.title || "";
const unique = (items) => [...new Set(items.map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
const contextText = (value) => typeof value === "string" ? value : value && typeof value === "object" ? Object.values(value).flat(2).filter((item) => typeof item === "string").join(" ") : "";

export function validateImageSlot(slot = {}) {
  const errors = [];
  for (const field of ["slotId", "moduleType", "visualGoal", "visualContext", "copyTargetId", "aspectRatio"]) if (!slot[field] || (typeof slot[field] === "string" && !slot[field].trim())) errors.push(`缺少 ${field}`);
  if (typeof slot.required !== "boolean") errors.push("required 必须是 boolean");
  if (typeof slot.userLocked !== "boolean") errors.push("userLocked 必须是 boolean");
  for (const forbidden of ["mustHave", "prefer", "forbid"]) if (Object.hasOwn(slot, forbidden)) errors.push(`Planner slot 不得提供 ${forbidden}`);
  return errors;
}

export function buildImageConstraints(slot = {}) {
  const location = text(slot.location);
  const hotel = text(slot.hotel);
  const activity = text(slot.activity);
  const subject = text(slot.subject);
  const mustHave = unique([
    location && `地点：${location}`,
    hotel && `酒店身份：${hotel}`,
    activity && `活动：${activity}`,
    subject && `主体：${subject}`,
  ]);
  const visualContext = slot.visualContext && typeof slot.visualContext === "object" ? slot.visualContext : {};
  const avoid = Array.isArray(visualContext.avoid) ? visualContext.avoid : Array.isArray(visualContext.avoidVisuals) ? visualContext.avoidVisuals : [];
  const prefer = unique([
    `符合视觉职责：${text(slot.visualGoal)}`,
    slot.aspectRatio && `构图适配 ${slot.aspectRatio}`,
    "真实自然、干净、有品质",
    String(slot.moduleType).toLowerCase().includes("cover") && "具有目的地代表性并留有标题空间",
    String(slot.moduleType).toLowerCase().includes("day") && "与相邻 DAY 形成可辨识的视觉职责差异",
  ]);
  const forbid = unique(["错误地点", "错误酒店身份", "错误活动", "错误主体", "明显水印", "破图或不可解码", "AI 生成图", "明显低质", ...avoid]);
  return { mustHave, prefer, forbid };
}

export function buildImageQueries(slot = {}, maxQueries = 3) {
  const location = text(slot.location);
  const hotel = text(slot.hotel);
  const activity = text(slot.activity);
  const subject = text(slot.subject);
  const goal = text(slot.visualGoal);
  const moduleType = String(slot.moduleType || "").toLowerCase();
  const identity = hotel || subject || activity;
  const candidates = moduleType.includes("hotel")
    ? [`${hotel || identity} ${location} official gallery photos`, `${hotel || identity} ${goal} official photography`]
    : [`${location} ${activity || subject} ${goal} travel photography`, `${location} ${subject || activity} authentic high resolution photos`];
  return unique(candidates.map((query) => query.slice(0, 180))).slice(0, Math.max(1, Math.min(3, maxQueries)));
}

function basicScore(candidate, slot) {
  const words = `${candidate.title || ""} ${candidate.alt || ""} ${candidate.summary || ""}`.toLowerCase();
  const anchors = [text(slot.location), text(slot.hotel), text(slot.activity), text(slot.subject)].flatMap((value) => value.toLowerCase().split(/\s+|[-–—·]/)).filter((value) => value.length >= 3);
  const match = anchors.filter((anchor) => words.includes(anchor)).length;
  const pixels = Number(candidate.width || 0) * Number(candidate.height || 0);
  return (candidate.officialHint ? 40 : 0) + match * 8 + Math.min(20, Math.round(pixels / 500_000)) - Number(candidate.searchRank || 0);
}

function publicCandidate(candidate, audit = null, rejection = null) {
  return {
    imageUrl: candidate.imageUrl,
    localUrl: candidate.publicUrl,
    sourcePage: candidate.pageUrl,
    sourceTitle: candidate.title || "",
    officialSource: Boolean(candidate.officialHint),
    width: candidate.width,
    height: candidate.height,
    sha256: candidate.sha256,
    actualSubject: audit?.actualSubject || null,
    matchReason: audit?.reason || null,
    rejection,
  };
}

function resultStatus(results) {
  if (results.every((item) => item.status === "success")) return "success";
  if (results.some((item) => item.status === "success")) return "partial_success";
  if (results.some((item) => item.status === "needs_user_action")) return "needs_user_action";
  if (results.every((item) => item.status === "not_found")) return "not_found";
  return "failed";
}

export async function runImageSearchSkill({
  slots = [],
  root = appRoot,
  searchApiKey,
  searchBaseUrl,
  searchModel,
  visionApiKey,
  visionBaseUrl,
  visionModel,
  maxQueriesPerSlot = 2,
  sourcePagesPerQuery = 4,
  downloadsPerSlot = 12,
  concurrency = {},
  signal,
  adapters = {},
  onCapabilityCall,
} = {}) {
  const startedAt = Date.now();
  const batchId = randomUUID();
  const searchFn = adapters.searchWeb || searchWeb;
  const commonsFn = adapters.searchCommonsImages || searchCommonsImages;
  const extractFn = adapters.extractPageImages || extractPageImages;
  const downloadFn = adapters.downloadCandidate || downloadCandidate;
  const rankFn = adapters.auditCandidates || auditCandidates;
  const validateFn = adapters.validateCandidate || validateCandidate;
  const slotQueue = new TaskQueue(concurrency.slots || 3);
  const searchQueue = new TaskQueue(concurrency.search || 3);
  const pageQueue = new TaskQueue(concurrency.pages || 3);
  const downloadQueue = new TaskQueue(concurrency.downloads || 3);
  const visionQueue = new TaskQueue(concurrency.vision || 2);
  const deduper = new ImageDeduper();
  let dedupeTail = Promise.resolve();
  const withDedupeLock = (candidate) => {
    const operation = dedupeTail.then(() => deduper.accept(candidate));
    dedupeTail = operation.catch(() => undefined);
    return operation;
  };
  const metrics = { businessBatches: 1, slotCount: Array.isArray(slots) ? slots.length : 0, searchCalls: 0, commonsCalls: 0, pageExtractionCalls: 0, downloadAttempts: 0, initialVisionCalls: 0, terminalVisionCalls: 0 };
  const assetDirectory = path.join(root, "output", "image-assets", `simple-${batchId}`);
  const publicPrefix = `/image-assets/simple-${batchId}`;
  await mkdir(assetDirectory, { recursive: true });

  if (!Array.isArray(slots) || !slots.length) return { batchId, status: "failed", results: [], warnings: [{ code: "slots_required", message: "Image Skill 需要非空 slots[]" }], metrics: { ...metrics, durationMs: Date.now() - startedAt } };

  async function tracked(capabilityId, target, worker) {
    const callId = randomUUID(); const callStartedAt = Date.now();
    onCapabilityCall?.({ phase: "started", capabilityId, callId, batchId, target });
    try {
      const value = await worker();
      onCapabilityCall?.({ phase: "finished", capabilityId, callId, batchId, target, durationMs: Date.now() - callStartedAt, attemptCount: 1 });
      return value;
    } catch (error) {
      onCapabilityCall?.({ phase: "finished", capabilityId, callId, batchId, target, durationMs: Date.now() - callStartedAt, attemptCount: 1, failed: true, reason: error?.message || String(error) });
      throw error;
    }
  }

  async function processSlot(slot) {
    const slotStartedAt = Date.now();
    const contractErrors = validateImageSlot(slot);
    if (contractErrors.length) return { slotId: slot?.slotId || null, status: "failed", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: null, technicalStatus: "invalid_slot_contract", warnings: contractErrors, constraints: null, durationMs: Date.now() - slotStartedAt };
    const constraints = buildImageConstraints(slot);
    const queriesUsed = buildImageQueries(slot, maxQueriesPerSlot);
    if (slot.userLocked) return { slotId: slot.slotId, status: "needs_user_action", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: "图片位已由用户锁定，未执行自动搜索", technicalStatus: "user_locked", warnings: [], constraints, durationMs: Date.now() - slotStartedAt };

    const warnings = [];
    const queryResults = await Promise.all(queriesUsed.map(async (query) => {
      const [pagesResult, commonsResult] = await Promise.allSettled([
        searchQueue.add(() => tracked("image_search", `${slot.slotId}:${query}`, async () => { metrics.searchCalls += 1; return searchFn({ query, apiKey: searchApiKey, baseUrl: searchBaseUrl, model: searchModel, count: sourcePagesPerQuery, signal }); })),
        searchQueue.add(async () => { metrics.commonsCalls += 1; return commonsFn(query, { signal, count: 8 }); }),
      ]);
      if (pagesResult.status === "rejected") warnings.push(`搜索失败：${pagesResult.reason?.message || pagesResult.reason}`);
      if (commonsResult.status === "rejected") warnings.push(`Commons 搜索失败：${commonsResult.reason?.message || commonsResult.reason}`);
      return { pages: pagesResult.status === "fulfilled" ? pagesResult.value : [], commons: commonsResult.status === "fulfilled" ? commonsResult.value : [] };
    }));
    const allPages = queryResults.flatMap((item) => item.pages).filter((item, index, array) => item?.pageUrl && array.findIndex((other) => other.pageUrl === item.pageUrl) === index);
    const directCandidates = queryResults.flatMap((item) => item.commons);
    const extractedGroups = await Promise.all(allPages.slice(0, sourcePagesPerQuery * queriesUsed.length).map((page) => pageQueue.add(async () => {
      try { metrics.pageExtractionCalls += 1; return await extractFn(page, { signal, maxImages: 12 }); }
      catch (error) { warnings.push(`网页图片提取失败：${page.pageUrl}：${error?.message || error}`); return []; }
    })));
    const rawCandidates = [...directCandidates, ...extractedGroups.flat()].filter((item, index, array) => item?.imageUrl && array.findIndex((other) => other.imageUrl === item.imageUrl) === index);
    const downloadedResults = await Promise.all(rawCandidates.slice(0, downloadsPerSlot).map((candidate) => downloadQueue.add(async () => {
      try { metrics.downloadAttempts += 1; return await downloadFn(candidate, { directory: assetDirectory, publicPrefix, signal }); }
      catch (error) { warnings.push(`候选下载失败：${error?.message || error}`); return null; }
    })));
    const contentSeen = new Set();
    const downloaded = downloadedResults.filter((item) => item?.filePath && item?.sha256 && !contentSeen.has(item.sha256) && contentSeen.add(item.sha256)).sort((a, b) => basicScore(b, slot) - basicScore(a, slot));
    if (!downloaded.length) {
      const allSearchFailed = warnings.filter((item) => item.startsWith("搜索失败")).length === queriesUsed.length;
      return { slotId: slot.slotId, status: allSearchFailed ? "failed" : "not_found", selected: null, candidates: [], queriesUsed, sourceEvidence: allPages.map((item) => item.pageUrl), actualSubject: null, matchReason: allSearchFailed ? "所有搜索请求均失败" : "首轮业务批次未找到可下载解码的候选", technicalStatus: allSearchFailed ? "search_failed" : "no_technical_candidate", warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }

    const visionEnabled = Boolean(visionApiKey && visionBaseUrl && visionModel && process.env.IMAGE_VISUAL_AUDIT !== "off");
    if (!visionEnabled) return { slotId: slot.slotId, status: "needs_user_action", selected: null, candidates: downloaded.map((item) => publicCandidate(item)), queriesUsed, sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: null, matchReason: "存在技术可用候选，但未完成真实视觉主体判断", technicalStatus: "visual_judgment_unavailable", warnings, constraints, durationMs: Date.now() - slotStartedAt };

    let ranking;
    try {
      ranking = await visionQueue.add(() => tracked("visual_judgment", `${slot.slotId}:ranking`, async () => { metrics.initialVisionCalls += 1; return rankFn({ slot: { ...slot, ...constraints, label: text(slot.subject) || slot.slotId, context: contextText(slot.visualContext), module: slot.moduleType }, candidates: downloaded.slice(0, 4), apiKey: visionApiKey, baseUrl: visionBaseUrl, model: visionModel, signal }); }));
    } catch (error) {
      warnings.push(`视觉排序未完成：${error?.message || error}`);
      return { slotId: slot.slotId, status: "needs_user_action", selected: null, candidates: downloaded.map((item) => publicCandidate(item)), queriesUsed, sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: null, matchReason: "视觉判断不可用，不得默认通过", technicalStatus: "visual_judgment_failed", warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }

    const ordered = ranking.map((item) => ({ candidate: downloaded[item.index], ranking: item })).filter((item) => item.candidate).slice(0, 3);
    const judged = [];
    for (const entry of ordered) {
      let audit;
      try {
        audit = await visionQueue.add(() => tracked("visual_judgment", `${slot.slotId}:candidate:${judged.length + 1}`, async () => { metrics.terminalVisionCalls += 1; return validateFn({ slot: { ...slot, ...constraints, label: text(slot.subject) || slot.slotId, context: contextText(slot.visualContext), module: slot.moduleType }, candidate: entry.candidate, apiKey: visionApiKey, baseUrl: visionBaseUrl, model: visionModel, signal }); }));
      } catch (error) {
        warnings.push(`候选视觉判断失败：${error?.message || error}`);
        judged.push({ ...entry, audit: null, rejection: "visual_judgment_failed" });
        continue;
      }
      const hard = audit.watermark === true || audit.subjectMatch === false || audit.placeMatch === false || hardRejectCodes.has(String(audit.hardRejectCode || "none"));
      const hotelIdentityMissing = String(slot.moduleType).toLowerCase().includes("hotel") && !entry.candidate.officialHint && audit.sourceSupportsIdentity !== true;
      if (hard || hotelIdentityMissing) { judged.push({ ...entry, audit, rejection: hard ? String(audit.hardRejectCode || "fact_mismatch") : "hotel_identity_unconfirmed" }); continue; }
      if (audit.pass !== true || audit.subjectMatch !== true || (audit.placeMatch !== true && audit.sourceSupportsIdentity !== true)) { judged.push({ ...entry, audit, rejection: "needs_user_judgment" }); continue; }
      const duplicate = await withDedupeLock(entry.candidate);
      if (!duplicate.accepted) { judged.push({ ...entry, audit, rejection: duplicate.reason }); continue; }
      const selected = { ...publicCandidate(entry.candidate, audit), dHash: duplicate.dHash, aspectRatio: slot.aspectRatio };
      judged.push({ ...entry, audit, rejection: null });
      return { slotId: slot.slotId, status: "success", selected, candidates: judged.map((item) => publicCandidate(item.candidate, item.audit, item.rejection)), queriesUsed, sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: audit.actualSubject || text(slot.subject), matchReason: audit.reason || "事实匹配并完成真实视觉判断", technicalStatus: "downloaded_decoded_and_judged", warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    const unresolved = judged.some((item) => ["needs_user_judgment", "visual_judgment_failed", "hotel_identity_unconfirmed"].includes(item.rejection));
    return { slotId: slot.slotId, status: unresolved ? "needs_user_action" : "not_found", selected: null, candidates: judged.map((item) => publicCandidate(item.candidate, item.audit, item.rejection)), queriesUsed, sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: judged.find((item) => item.audit?.actualSubject)?.audit.actualSubject || null, matchReason: unresolved ? "候选尚未完成可自动采用的事实与主体确认" : "首轮候选均有明确事实、技术或重复问题", technicalStatus: unresolved ? "visual_judgment_inconclusive" : "no_eligible_candidate", warnings, constraints, durationMs: Date.now() - slotStartedAt };
  }

  const results = await Promise.all(slots.map((slot) => slotQueue.add(async () => {
    try { return await processSlot(slot); }
    catch (error) { return { slotId: slot?.slotId || null, status: "failed", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: error?.message || String(error), technicalStatus: "slot_failed", warnings: [], constraints: null, durationMs: 0 }; }
  })));
  return { batchId, status: resultStatus(results), results, warnings: [], metrics: { ...metrics, concurrencyPeak: { slots: slotQueue.peak, search: searchQueue.peak, pages: pageQueue.peak, downloads: downloadQueue.peak, vision: visionQueue.peak }, durationMs: Date.now() - startedAt } };
}
