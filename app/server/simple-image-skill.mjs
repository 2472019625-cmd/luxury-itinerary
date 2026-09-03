import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeCandidatesBatch } from "./image-audit.mjs";
import { ImageDeduper } from "./image-dedupe.mjs";
import { downloadCandidate } from "./image-download.mjs";
import { searchWebBatch } from "./image-search.mjs";
import { extractPageImages } from "./page-images.mjs";
import { searchCommonsImages } from "./commons-search.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hardRejectCodes = new Set(["watermark", "subject_mismatch", "place_mismatch", "hotel_identity_mismatch", "activity_mismatch", "ai_generated", "non_photographic", "technical_unusable", "broken", "low_resolution", "low_quality", "forbid"]);

class TaskQueue {
  constructor(limit) { this.limit = Math.max(1, Number(limit) || 1); this.active = 0; this.peak = 0; this.pending = []; }
  add(worker) { return new Promise((resolve, reject) => { this.pending.push({ worker, resolve, reject }); this.drain(); }); }
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

function positiveVisualContext(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .filter(([key]) => !/avoid|forbid|exclude|不得|避免/i.test(key))
    .flatMap(([, item]) => Array.isArray(item) ? item : [item])
    .flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" ? Object.values(item).filter((entry) => typeof entry === "string") : [])
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  const mustHave = unique([location && `地点：${location}`, hotel && `酒店身份：${hotel}`, activity && `活动：${activity}`, subject && `主体：${subject}`]);
  const visualContext = slot.visualContext && typeof slot.visualContext === "object" ? slot.visualContext : {};
  const avoid = Array.isArray(visualContext.avoid) ? visualContext.avoid : Array.isArray(visualContext.avoidVisuals) ? visualContext.avoidVisuals : [];
  const prefer = unique([`符合视觉职责：${text(slot.visualGoal)}`, slot.aspectRatio && `构图适配 ${slot.aspectRatio}`, "真实自然、干净、有品质", String(slot.moduleType).toLowerCase().includes("cover") && "具有目的地代表性并留有标题空间", String(slot.moduleType).toLowerCase().includes("day") && "与相邻 DAY 形成可辨识的视觉职责差异"]);
  const forbid = unique(["错误地点", "错误酒店身份", "错误活动", "错误主体", "明显水印", "破图或不可解码", "AI 生成图", "地图、示意图、信息图或截图", "明显低质", ...avoid]);
  return { mustHave, prefer, forbid };
}

export function buildImageQueries(slot = {}, maxQueries = 3) {
  const location = text(slot.location);
  const hotel = text(slot.hotel);
  const activity = text(slot.activity);
  const subject = text(slot.subject);
  const moduleType = String(slot.moduleType || "").toLowerCase();
  const identity = hotel || activity || subject;
  const coreSubject = activity || subject;
  const candidates = moduleType.includes("hotel")
    ? [`${identity} ${location} official gallery`, `${identity} official photography`]
    : moduleType.includes("transport")
      ? [`${location} ${coreSubject} travel photography`, `${location} ${coreSubject} official photos`]
      : [`${location} ${coreSubject} travel photography`, `${location} ${coreSubject} safari photos`];
  return unique(candidates.map((query) => query.replace(/\s+/g, " ").trim().slice(0, 120))).slice(0, Math.max(1, Math.min(3, maxQueries)));
}

function isDayPrimarySlot(slot = {}) {
  if (String(slot.moduleType || "").toLowerCase() !== "day") return false;
  const role = `${slot.slotId || ""} ${slot.imageRole || ""} ${slot.role || ""}`;
  return !/secondary|detail|decorative|supporting|第二|细节|装饰/i.test(role);
}

export function buildControlledFallbackPlan(slot = {}, maxQueries = 2) {
  if (!isDayPrimarySlot(slot)) return null;
  const target = `${text(slot.activity)} ${text(slot.subject)}`.toLowerCase();
  const location = text(slot.location);
  let fallbackTarget = "";
  let fallbackTheme = "";
  let subjectPattern = null;
  let candidates = [];
  if (/anti[- ]?poaching|observation post|反偷猎|巡护观察站/.test(target)) {
    fallbackTarget = "同保护区的 ranger、game scout、巡护队或真实野生动物保护工作现场";
    fallbackTheme = "ranger patrol and wildlife conservation work";
    subjectPattern = /anti[- ]?poaching|observation post|ranger|game scout|patrol|conservation|wildlife protection|反偷猎|观察站|巡护|护林|保护工作/i;
    candidates = [`${location} ranger patrol conservation team photography`, `${location} game scout wildlife protection photography`];
  } else if (/walking safari|bush walk|guided walk|night safari|night game drive|徒步|夜游|夜间游猎/.test(target)) {
    fallbackTarget = "同保护区由 ranger 带领的荒野步行、户外探索或夜间保护区活动";
    fallbackTheme = "ranger-led wilderness walking or night reserve activity";
    subjectPattern = /walking|bush walk|guided walk|wilderness walk|ranger|guide|outdoor exploration|night (?:game|safari|reserve)|徒步|步行|向导|巡护员|荒野探索|夜游|夜间.*(?:游猎|保护区|活动)/i;
    candidates = [`${location} ranger led wilderness walking photography`, `${location} night reserve activity ranger photography`];
  } else if (/maasai|masai|马赛/.test(target)) {
    fallbackTarget = "同地区真实 Maasai 人物、文化互动或村落环境";
    fallbackTheme = "Maasai cultural experience and village environment";
    subjectPattern = /maasai|masai|马赛|cultural interaction|culture|village|community|文化互动|文化体验|村落|部族/i;
    candidates = [`${location} Maasai cultural experience photography`, `${location} Maasai people village environment photography`];
  } else if (/hot air balloon|balloon safari|热气球/.test(target)) {
    fallbackTarget = "同地点真实热气球 Safari、升空或草原上空飞行场景";
    fallbackTheme = "hot air balloon safari experience";
    subjectPattern = /hot air balloon|balloon safari|balloon flight|热气球|气球飞行/i;
    candidates = [`${location} hot air balloon safari photography`, `${location} balloon flight travel photography`];
  } else return null;
  return {
    originalExactTarget: { location, activity: text(slot.activity), subject: text(slot.subject) },
    fallbackTarget,
    fallbackTheme,
    queries: unique(candidates.map((query) => query.replace(/\s+/g, " ").trim().slice(0, 120))).slice(0, Math.max(1, Math.min(2, maxQueries))),
    subjectPattern,
  };
}

function controlledFallbackRejection(plan, audit = {}) {
  const subject = `${audit.actualSubject || ""} ${audit.reason || ""}`;
  if (/泳池|客房|卧室|餐厅|酒廊|酒店空间|酒店室内|pool|guest room|bedroom|restaurant|dining|lounge|hotel interior/i.test(subject)) return "activity_mismatch";
  if (/地图|示意图|信息图|截图|\bmap\b|diagram|infographic|screenshot/i.test(subject)) return "non_photographic";
  if (!plan.subjectPattern.test(subject)) return "fallback_theme_mismatch";
  return null;
}

function layerEvidence() {
  return { searchPages: 0, searchPageUrls: [], groundingRedirectUnresolved: [], extractedCandidates: 0, semanticRelevantCandidates: 0, downloadAttempts: 0, downloadedCandidates: 0, pageFailures: [], downloadFailures: [], searchCompleted: false, semanticExtractionCompleted: false, visualJudgmentCompleted: false };
}

function basicScore(candidate, slot) {
  const localWords = `${candidate.alt || ""} ${candidate.semanticText || ""}`.toLowerCase();
  const pageWords = `${candidate.title || ""} ${candidate.summary || ""}`.toLowerCase();
  const anchors = [text(slot.location), text(slot.hotel), text(slot.activity), text(slot.subject), ...positiveVisualContext(slot.visualContext)].flatMap((value) => String(value).toLowerCase().split(/\s+|[-–—·]/)).filter((value) => value.length >= 3);
  const localMatch = anchors.filter((anchor) => localWords.includes(anchor)).length;
  const pageMatch = anchors.filter((anchor) => pageWords.includes(anchor)).length;
  const pixels = Number(candidate.width || 0) * Number(candidate.height || 0);
  const extractionQuality = /og:image|image-srcset|picture-srcset|gallery-link|media-link|json-ld/i.test(candidate.kind || "") ? 12 : candidate.highResHint ? 6 : 0;
  return (candidate.officialHint ? 40 : 0) + extractionQuality + Number(candidate.semanticScore || 0) - Number(candidate.genericActivityPenalty || 0) + localMatch * 8 + pageMatch * 2 + Math.min(20, Math.round(pixels / 500_000)) - Number(candidate.searchRank || 0);
}

function stableCandidateId(slotId, candidate = {}) {
  const identity = [slotId, candidate.sha256, candidate.imageUrl, candidate.pageUrl].map((item) => String(item || "").trim()).join("|");
  return `candidate-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function hardJudgment(audit = null) {
  if (!audit) return null;
  return {
    locationMatch: audit.locationMatch,
    hotelIdentityMatch: audit.hotelIdentityMatch,
    activityMatch: audit.activityMatch,
    subjectMatch: audit.subjectMatch,
    watermarkFree: audit.watermarkFree,
    nonAI: audit.nonAI,
    photographic: audit.photographic,
    technicalUsable: audit.technicalUsable,
    eligible: audit.eligible,
  };
}

function publicCandidate(candidate, audit = null, rejection = null) {
  return { candidateId: candidate.candidateId, imageUrl: candidate.imageUrl, localUrl: candidate.publicUrl, sourcePage: candidate.pageUrl, sourceTitle: candidate.title || "", officialSource: Boolean(candidate.officialHint), width: candidate.width, height: candidate.height, sha256: candidate.sha256, semanticScore: Number(candidate.semanticScore || 0), semanticMatches: Array.isArray(candidate.semanticMatches) ? candidate.semanticMatches : [], actualSubject: audit?.actualSubject || null, matchReason: audit?.reason || null, hardJudgment: hardJudgment(audit), rejection };
}

function resultStatus(results) {
  if (results.every((item) => item.status === "success")) return "success";
  if (results.some((item) => item.status === "success")) return "partial_success";
  if (results.some((item) => item.status === "needs_user_action")) return "needs_user_action";
  if (results.every((item) => item.status === "not_found")) return "not_found";
  return "failed";
}

const hardBooleanFields = ["locationMatch", "hotelIdentityMatch", "activityMatch", "subjectMatch", "watermarkFree", "nonAI", "photographic", "technicalUsable", "eligible"];

function completeVisualJudgment(audit) {
  return audit && typeof audit.candidateId === "string" && audit.candidateId.trim() && hardBooleanFields.every((field) => typeof audit[field] === "boolean") && typeof audit.actualSubject === "string" && audit.actualSubject.trim();
}

function failedHardRequirement(slot, audit) {
  if (audit.technicalUsable !== true) return "technical_unusable";
  if (audit.watermarkFree !== true) return "watermark";
  if (audit.nonAI !== true) return "ai_generated";
  if (audit.photographic !== true || /地图|示意图|信息图|截图|\bmap\b|diagram|infographic|screenshot/i.test(`${audit.actualSubject || ""} ${audit.reason || ""}`)) return "non_photographic";
  if (/徒步|walking safari/i.test(`${text(slot.activity)} ${text(slot.subject)}`) && /泳池|客房|酒店|服务员|室内|pool|guest room|hotel interior|lodge deck/i.test(`${audit.actualSubject || ""} ${audit.reason || ""}`)) return "activity_mismatch";
  const expectedEastAfrica = /坦桑尼亚|塞伦盖蒂|格鲁梅蒂|乞力马扎罗|tanzania|serengeti|grumeti|kilimanjaro/i.test(text(slot.location));
  const conflictingChina = /呼伦贝尔|内蒙古|中国|hulunbuir|inner mongolia|\bchina\b/i.test(`${audit.actualSubject || ""} ${audit.reason || ""}`);
  if (expectedEastAfrica && conflictingChina) return "place_mismatch";
  if (text(slot.location) && audit.locationMatch !== true) return "place_mismatch";
  if (text(slot.hotel) && audit.hotelIdentityMatch !== true) return "hotel_identity_mismatch";
  if (text(slot.activity) && audit.activityMatch !== true) return "activity_mismatch";
  if (text(slot.subject) && audit.subjectMatch !== true) return "subject_mismatch";
  if (audit.eligible !== true) return "not_eligible";
  if (hardRejectCodes.has(String(audit.hardRejectCode || "none"))) return String(audit.hardRejectCode);
  return null;
}

function retryableTechnicalError(error) {
  const value = `${error?.code || ""} ${error?.name || ""} ${error?.message || error || ""}`;
  if (/page_access_blocked|page_redirect_mismatch|分辨率不足|文件过大|资源上限|不支持的图片格式|下载失败（4\d\d）/i.test(value)) return false;
  return /invalid_json|JSON|parse|解析|decode|解码|corrupt|sharp|unsupported image|network|fetch|socket|ECONN|ETIMEDOUT|timeout|timed out|aborted|abort|unavailable|请求失败|下载失败/i.test(value);
}

async function withOneTechnicalRetry(worker, onRetry) {
  try { return await worker(1); }
  catch (error) {
    if (!retryableTechnicalError(error)) throw error;
    onRetry?.(error);
    return worker(2);
  }
}

function failureLayer(error) {
  const value = `${error?.code || ""} ${error?.message || error || ""}`;
  if (/page_access_blocked/i.test(value)) return "page_access";
  if (/分辨率不足|比例不适合/i.test(value)) return "size";
  if (/decode|解码|corrupt|sharp|unsupported image|不支持的图片格式/i.test(value)) return "decode";
  if (/下载|network|fetch|socket|ECONN|ENOTFOUND|ETIMEDOUT|timeout|aborted|terminated|HTTP|\（\d{3}\）/i.test(value)) return "download";
  return "other";
}

export async function runImageSearchSkill({
  slots = [], root = appRoot, searchApiKey, searchBaseUrl, searchModel, visionApiKey, visionBaseUrl, visionModel,
  maxQueriesPerSlot = 2, sourcePagesPerSlot = 4, downloadsPerSlot = 6, visionCandidatesPerSlot = 4,
  concurrency = {}, signal, adapters = {}, onCapabilityCall,
} = {}) {
  const startedAt = Date.now();
  const batchId = randomUUID();
  const searchFn = adapters.searchWebBatch || searchWebBatch;
  const commonsFn = adapters.searchCommonsImages || searchCommonsImages;
  const extractFn = adapters.extractPageImages || extractPageImages;
  const downloadFn = adapters.downloadCandidate || downloadCandidate;
  const judgeFn = adapters.judgeCandidatesBatch || judgeCandidatesBatch;
  const slotQueue = new TaskQueue(concurrency.slots || 3);
  const searchQueue = new TaskQueue(concurrency.search || 3);
  const pageQueue = new TaskQueue(concurrency.pages || 3);
  const downloadQueue = new TaskQueue(concurrency.downloads || 3);
  const visionQueue = new TaskQueue(concurrency.vision || 2);
  const deduper = new ImageDeduper();
  let dedupeTail = Promise.resolve();
  const withDedupeLock = (candidate) => { const operation = dedupeTail.then(() => deduper.accept(candidate)); dedupeTail = operation.catch(() => undefined); return operation; };
  const timingsMs = { searchProvider: 0, commons: 0, pageExtraction: 0, download: 0, batchVision: 0, topConfirmation: 0 };
  const metrics = { businessBatches: 1, automaticFollowupRounds: 0, slotCount: Array.isArray(slots) ? slots.length : 0, searchCalls: 0, commonsCalls: 0, pageExtractionCalls: 0, downloadAttempts: 0, batchVisionCalls: 0, topConfirmationCalls: 0, technicalRetries: { search: 0, pageExtraction: 0, download: 0 }, timingsMs, timingsSemantics: "各阶段所有并发操作耗时累计；阶段间存在重叠，不应相加作为总耗时" };
  const assetDirectory = path.join(root, "output", "image-assets", `simple-${batchId}`);
  const publicPrefix = `/image-assets/simple-${batchId}`;
  await mkdir(assetDirectory, { recursive: true });
  if (!Array.isArray(slots) || !slots.length) return { batchId, status: "failed", results: [], warnings: [{ code: "slots_required", message: "Image Skill 需要非空 slots[]" }], metrics: { ...metrics, durationMs: Date.now() - startedAt } };

  async function measure(stage, worker) { const stageStartedAt = Date.now(); try { return await worker(); } finally { timingsMs[stage] += Date.now() - stageStartedAt; } }
  async function tracked(capabilityId, target, worker) {
    const callId = randomUUID(); const callStartedAt = Date.now();
    let attemptCount = 0;
    const recordAttempt = () => { attemptCount += 1; };
    onCapabilityCall?.({ phase: "started", capabilityId, callId, batchId, target });
    try { const value = await worker(recordAttempt); onCapabilityCall?.({ phase: "finished", capabilityId, callId, batchId, target, durationMs: Date.now() - callStartedAt, attemptCount: Math.max(1, attemptCount) }); return value; }
    catch (error) { onCapabilityCall?.({ phase: "finished", capabilityId, callId, batchId, target, durationMs: Date.now() - callStartedAt, attemptCount: Math.max(1, attemptCount), failed: true, reason: error?.message || String(error) }); throw error; }
  }

  async function processSlot(slot) {
    const slotStartedAt = Date.now();
    const contractErrors = validateImageSlot(slot);
    if (contractErrors.length) return { slotId: slot?.slotId || null, status: "failed", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: null, technicalStatus: "invalid_slot_contract", warnings: contractErrors, constraints: null, durationMs: Date.now() - slotStartedAt };
    const constraints = buildImageConstraints(slot);
    const queriesUsed = buildImageQueries(slot, maxQueriesPerSlot);
    if (slot.userLocked) return { slotId: slot.slotId, status: "needs_user_action", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: "图片位已由用户锁定，未执行自动搜索", technicalStatus: "user_locked", warnings: [], constraints, durationMs: Date.now() - slotStartedAt };
    const visionEnabled = Boolean(visionApiKey && visionBaseUrl && visionModel && process.env.IMAGE_VISUAL_AUDIT !== "off");
    const warnings = [];
    const pipelineEvidence = layerEvidence();
    pipelineEvidence.exactMatchSuccess = false;
    pipelineEvidence.controlledFallback = { entered: false, reason: null, originalExactTarget: null, fallbackTarget: null, fallbackTheme: null, evidence: null };

    async function runLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName, fallbackPlan = null) {
      const isHotel = String(layerSlot.moduleType).toLowerCase().includes("hotel");
      const [pagesResult, commonsResult] = await Promise.allSettled([
        searchQueue.add(() => tracked("image_search", `${slot.slotId}:${layerName}`, async (recordAttempt) => withOneTechnicalRetry(async () => {
          recordAttempt(); metrics.searchCalls += 1;
          return measure("searchProvider", () => searchFn({ queries: layerQueries, apiKey: searchApiKey, baseUrl: searchBaseUrl, model: searchModel, count: sourcePagesPerSlot, signal }));
        }, (error) => { metrics.technicalRetries.search += 1; warnings.push(`${layerName} 搜索技术重试：${error?.message || error}`); }))),
        isHotel ? Promise.resolve([]) : searchQueue.add(async () => { metrics.commonsCalls += 1; return measure("commons", () => commonsFn(layerQueries[0], { signal, count: downloadsPerSlot })); }),
      ]);
      evidence.searchCompleted = pagesResult.status === "fulfilled";
      if (pagesResult.status === "rejected") warnings.push(`${layerName} 搜索失败：${pagesResult.reason?.message || pagesResult.reason}`);
      if (commonsResult.status === "rejected") warnings.push(`${layerName} Commons 搜索失败：${commonsResult.reason?.message || commonsResult.reason}`);
      if (pagesResult.status === "fulfilled" && Array.isArray(pagesResult.value?.diagnostics)) {
        evidence.groundingRedirectUnresolved = pagesResult.value.diagnostics.filter((item) => item?.code === "grounding_redirect_unresolved");
        for (const item of evidence.groundingRedirectUnresolved) warnings.push(`${layerName} 搜索来源未解析：grounding_redirect_unresolved：${item.title || item.pageUrl}`);
      }
      const allPages = (pagesResult.status === "fulfilled" ? pagesResult.value : []).filter((item, index, array) => item?.pageUrl && array.findIndex((other) => other.pageUrl === item.pageUrl) === index).sort((a, b) => basicScore(b, layerSlot) - basicScore(a, layerSlot)).slice(0, sourcePagesPerSlot);
      evidence.searchPages = allPages.length;
      evidence.searchPageUrls = allPages.map((item) => item.pageUrl);
      const directCandidates = commonsResult.status === "fulfilled" ? commonsResult.value : [];
      const semanticTerms = unique([text(layerSlot.activity), text(layerSlot.subject), text(layerSlot.location), ...(Array.isArray(layerSlot.searchKeywords) ? layerSlot.searchKeywords : []), ...layerQueries]);
      const extractedGroups = await Promise.all(allPages.map((page) => pageQueue.add(async () => {
        try {
          return await withOneTechnicalRetry(async () => { metrics.pageExtractionCalls += 1; return measure("pageExtraction", () => extractFn(page, { signal, maxImages: 24, semanticTerms })); }, (error) => { metrics.technicalRetries.pageExtraction += 1; warnings.push(`${layerName} 网页提图技术重试：${page.pageUrl}：${error?.message || error}`); });
        }
        catch (error) { const classified = failureLayer(error); const failure = classified === "download" ? "page_fetch" : classified; evidence.pageFailures.push({ pageUrl: page.pageUrl, layer: failure, reason: error?.message || String(error) }); warnings.push(`${layerName} 网页图片提取失败：${page.pageUrl}：${error?.message || error}`); return []; }
      })));
      evidence.semanticExtractionCompleted = true;
      const perPageCap = Math.max(2, Math.ceil(downloadsPerSlot / Math.max(1, allPages.length)));
      const diverseExtracted = extractedGroups.flatMap((group) => [...group].sort((a, b) => basicScore(b, layerSlot) - basicScore(a, layerSlot)).slice(0, perPageCap));
      const rawCandidates = [...diverseExtracted, ...directCandidates].filter((item, index, array) => item?.imageUrl && array.findIndex((other) => other.imageUrl === item.imageUrl) === index).sort((a, b) => basicScore(b, layerSlot) - basicScore(a, layerSlot)).slice(0, downloadsPerSlot);
      evidence.extractedCandidates = extractedGroups.flat().length + directCandidates.length;
      evidence.semanticRelevantCandidates = extractedGroups.flat().filter((item) => Number(item.semanticScore || 0) > 0).length + directCandidates.filter((item) => Number(item.semanticScore || 0) > 0).length;
      const downloadedResults = await Promise.all(rawCandidates.map((candidate) => downloadQueue.add(async () => {
        try {
          return await withOneTechnicalRetry(async () => { metrics.downloadAttempts += 1; evidence.downloadAttempts += 1; return measure("download", () => downloadFn(candidate, { directory: assetDirectory, publicPrefix, signal })); }, (error) => { metrics.technicalRetries.download += 1; warnings.push(`${layerName} 候选下载技术重试：${error?.message || error}`); });
        }
        catch (error) { const failure = failureLayer(error); evidence.downloadFailures.push({ imageUrl: candidate.imageUrl, layer: failure, reason: error?.message || String(error) }); warnings.push(`${layerName} 候选下载失败：${error?.message || error}`); return null; }
      })));
      const contentSeen = new Set();
      const downloaded = downloadedResults.filter((item) => item?.filePath && item?.sha256 && !contentSeen.has(item.sha256) && contentSeen.add(item.sha256)).sort((a, b) => basicScore(b, layerSlot) - basicScore(a, layerSlot)).map((item) => ({ ...item, candidateId: stableCandidateId(slot.slotId, item) }));
      evidence.downloadedCandidates = downloaded.length;
      if (!downloaded.length) {
        evidence.visualJudgmentCompleted = true;
        const allSearchFailed = pagesResult.status === "rejected" && (isHotel || commonsResult.status === "rejected");
        const layers = evidence.downloadFailures.map((item) => item.layer);
        const technicalStatus = allSearchFailed ? "search_failed" : !allPages.length && !directCandidates.length ? "no_search_results" : !evidence.extractedCandidates ? "page_extraction_empty" : layers.length && layers.every((item) => item === "size") ? "all_candidates_too_small" : layers.includes("decode") ? "candidate_decode_failed" : layers.includes("download") || layers.includes("page_access") ? "candidate_download_failed" : "no_technical_candidate";
        return { kind: allSearchFailed ? "search_failed" : "no_candidate", candidates: [], sourceEvidence: allPages.map((item) => item.pageUrl), actualSubject: null, technicalStatus };
      }
      if (!visionEnabled) return { kind: "visual_unavailable", candidates: downloaded.map((item) => publicCandidate(item)), sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: null, technicalStatus: "visual_judgment_unavailable" };
      let judgments;
      const visionCandidates = downloaded.slice(0, Math.max(1, Math.min(4, visionCandidatesPerSlot)));
      try {
        judgments = await visionQueue.add(() => tracked("visual_judgment", `${slot.slotId}:${layerName}`, async (recordAttempt) => { recordAttempt(); metrics.batchVisionCalls += 1; return measure("batchVision", () => judgeFn({ slot: { ...layerSlot, ...layerConstraints, label: text(layerSlot.subject) || slot.slotId, context: contextText(layerSlot.visualContext), module: layerSlot.moduleType }, candidates: visionCandidates, apiKey: visionApiKey, baseUrl: visionBaseUrl, model: visionModel, signal })); }));
      } catch (error) {
        warnings.push(`${layerName} 批量视觉判断未完成：${error?.message || error}`);
        return { kind: "visual_failed", candidates: downloaded.map((item) => publicCandidate(item)), sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: null, technicalStatus: "visual_judgment_failed" };
      }
      evidence.visualJudgmentCompleted = true;
      const judged = [];
      const candidateById = new Map(visionCandidates.map((candidate) => [candidate.candidateId, candidate]));
      for (const audit of judgments) {
        const candidate = candidateById.get(audit?.candidateId);
        if (!candidate) continue;
        if (!completeVisualJudgment(audit)) { judged.push({ candidate, audit, rejection: "needs_user_judgment" }); continue; }
        const rejection = failedHardRequirement(layerSlot, audit) || (fallbackPlan ? controlledFallbackRejection(fallbackPlan, audit) : null);
        if (rejection) { judged.push({ candidate, audit, rejection }); continue; }
        const duplicate = await withDedupeLock(candidate);
        if (!duplicate.accepted) { judged.push({ candidate, audit, rejection: duplicate.reason }); continue; }
        judged.push({ candidate, audit, rejection: null });
        return { kind: "success", selected: { ...publicCandidate(candidate, audit), dHash: duplicate.dHash, aspectRatio: slot.aspectRatio }, candidates: judged.map((item) => publicCandidate(item.candidate, item.audit, item.rejection)), sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: audit.actualSubject, matchReason: audit.reason || "事实匹配并完成真实视觉判断", technicalStatus: "downloaded_decoded_and_judged" };
      }
      const unresolved = judged.some((item) => ["needs_user_judgment", "hotel_identity_unconfirmed"].includes(item.rejection));
      return { kind: unresolved ? "inconclusive" : "no_eligible", candidates: judged.map((item) => publicCandidate(item.candidate, item.audit, item.rejection)), sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: judged.find((item) => item.audit?.actualSubject)?.audit.actualSubject || null, matchReason: unresolved ? "批量视觉判断未能确认可自动采用候选" : `${layerName} 候选均有明确事实、技术或重复问题`, technicalStatus: unresolved ? "visual_judgment_inconclusive" : "no_eligible_candidate" };
    }

    const exact = await runLayer(slot, constraints, queriesUsed, pipelineEvidence, "exact");
    const exactCandidates = exact.candidates || [];
    if (exact.kind === "success") {
      pipelineEvidence.exactMatchSuccess = true;
      const selected = { ...exact.selected, matchLevel: "exact_match" };
      return { slotId: slot.slotId, status: "success", matchLevel: "exact_match", selected, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: exact.matchReason, technicalStatus: exact.technicalStatus, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    if (["visual_unavailable", "visual_failed", "inconclusive"].includes(exact.kind)) {
      return { slotId: slot.slotId, status: "needs_user_action", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: exact.matchReason || "精确视觉判断未完成，不得进入 fallback", technicalStatus: exact.technicalStatus, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    if (exact.kind === "search_failed") {
      return { slotId: slot.slotId, status: "failed", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: "精确搜索失败，未进入 fallback", technicalStatus: exact.technicalStatus, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }

    const fallbackPlan = buildControlledFallbackPlan(slot, maxQueriesPerSlot);
    if (!fallbackPlan) {
      return { slotId: slot.slotId, status: "not_found", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: exact.matchReason || "精确层无合格候选，当前图片位不适用 controlled_fallback", technicalStatus: exact.technicalStatus, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    const fallbackSlot = { ...slot, activity: fallbackPlan.fallbackTheme, subject: fallbackPlan.fallbackTarget, visualGoal: `精确活动图未找到；仅允许${fallbackPlan.fallbackTarget}`, visualContext: { ...slot.visualContext, originalExactTarget: fallbackPlan.originalExactTarget, controlledFallbackTheme: fallbackPlan.fallbackTheme } };
    const fallbackConstraints = buildImageConstraints(fallbackSlot);
    const fallbackEvidence = layerEvidence();
    pipelineEvidence.controlledFallback = { entered: true, reason: "exact_activity_image_not_found", originalExactTarget: fallbackPlan.originalExactTarget, fallbackTarget: fallbackPlan.fallbackTarget, fallbackTheme: fallbackPlan.fallbackTheme, queries: fallbackPlan.queries, evidence: fallbackEvidence };
    const fallback = await runLayer(fallbackSlot, fallbackConstraints, fallbackPlan.queries, fallbackEvidence, "controlled_fallback", fallbackPlan);
    const allCandidates = [...exactCandidates, ...(fallback.candidates || [])].filter((item, index, array) => array.findIndex((other) => other.candidateId === item.candidateId && other.rejection === item.rejection) === index);
    const allQueries = unique([...queriesUsed, ...fallbackPlan.queries]);
    const allSources = unique([...(exact.sourceEvidence || []), ...(fallback.sourceEvidence || [])]);
    if (fallback.kind === "success") {
      const fallbackAllowedBecause = `精确活动图未找到；候选经视觉判断确认为${fallback.actualSubject}，同时满足目标地点、${fallbackPlan.fallbackTheme}体验主题和真实摄影要求`;
      const selected = { ...fallback.selected, matchLevel: "controlled_fallback", fallbackReason: "exact_activity_image_not_found", originalExactTarget: fallbackPlan.originalExactTarget, fallbackTarget: fallbackPlan.fallbackTarget, fallbackTheme: fallbackPlan.fallbackTheme, fallbackAllowedBecause };
      return { slotId: slot.slotId, status: "success", matchLevel: "controlled_fallback", fallbackReason: "exact_activity_image_not_found", originalExactTarget: fallbackPlan.originalExactTarget, fallbackTarget: fallbackPlan.fallbackTarget, fallbackTheme: fallbackPlan.fallbackTheme, fallbackAllowedBecause, selected, candidates: allCandidates, queriesUsed: allQueries, sourceEvidence: allSources, actualSubject: fallback.actualSubject, matchReason: fallbackAllowedBecause, technicalStatus: fallback.technicalStatus, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    const fallbackNeedsUser = ["visual_unavailable", "visual_failed", "inconclusive"].includes(fallback.kind);
    return { slotId: slot.slotId, status: fallbackNeedsUser ? "needs_user_action" : "not_found", matchLevel: null, fallbackReason: "exact_activity_image_not_found", originalExactTarget: fallbackPlan.originalExactTarget, fallbackTarget: fallbackPlan.fallbackTarget, fallbackTheme: fallbackPlan.fallbackTheme, selected: null, candidates: allCandidates, queriesUsed: allQueries, sourceEvidence: allSources, actualSubject: fallback.actualSubject || exact.actualSubject, matchReason: fallbackNeedsUser ? "controlled_fallback 视觉判断未完成" : "精确层与 controlled_fallback 均无合格候选", technicalStatus: fallback.technicalStatus, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
  }

  const results = await Promise.all(slots.map((slot) => slotQueue.add(async () => {
    try { return await processSlot(slot); }
    catch (error) { return { slotId: slot?.slotId || null, status: "failed", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: error?.message || String(error), technicalStatus: "slot_failed", warnings: [], constraints: null, durationMs: 0 }; }
  })));
  return { batchId, status: resultStatus(results), results, warnings: [], metrics: { ...metrics, concurrencyPeak: { slots: slotQueue.peak, search: searchQueue.peak, pages: pageQueue.peak, downloads: downloadQueue.peak, vision: visionQueue.peak }, durationMs: Date.now() - startedAt } };
}
