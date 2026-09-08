import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeCandidatesBatch } from "./image-audit.mjs";
import { ImageDeduper } from "./image-dedupe.mjs";
import { downloadCandidate } from "./image-download.mjs";
import { searchWebBatch } from "./image-search.mjs";
import { canonicalImageAssetKey, extractPageImages, fetchImagePageContent } from "./page-images.mjs";
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
  const subject = text(slot.primaryVisualSubject) || text(slot.subject);
  const mustHave = unique([location && `地点：${location}`, hotel && `酒店身份：${hotel}`, activity && `活动：${activity}`, subject && `主体：${subject}`]);
  const visualContext = slot.visualContext && typeof slot.visualContext === "object" ? slot.visualContext : {};
  const avoid = Array.isArray(visualContext.avoid) ? visualContext.avoid : Array.isArray(visualContext.avoidVisuals) ? visualContext.avoidVisuals : [];
  const prefer = unique([`符合视觉职责：${text(slot.visualGoal)}`, slot.aspectRatio && `构图适配 ${slot.aspectRatio}`, "真实自然、干净、有品质", String(slot.moduleType).toLowerCase().includes("cover") && "具有目的地代表性并留有标题空间", String(slot.moduleType).toLowerCase().includes("day") && "与相邻 DAY 形成可辨识的视觉职责差异"]);
  const forbid = unique(["错误地点", "错误酒店身份", "错误活动", "错误主体", "明显水印", "破图或不可解码", "AI 生成图", "地图、示意图、信息图或截图", "明显低质", ...(slot.moduleType === "day" ? ["地点exact必须由当前候选来源及实际主体支持，类似草原或湿地不能证明地点；安博塞利不得采用博茨瓦纳等其他国家图片，无法确认地点不得自动采用", "DAY活动主体优先于地点相近；游猎或豹类追踪不得用其他品牌营地、帐篷、客房、泳池或普通建筑替代", "Masai Mara是地理实体，不代表Maasai文化活动"] : []), ...avoid]);
  return { mustHave, prefer, forbid };
}

export function buildImageQueries(slot = {}, maxQueries = 3) {
  // DAY search language is independent of customer copy and detailed visual responsibility.
  if (String(slot.moduleType || '').toLowerCase() === 'day') {
    const intents = unique((Array.isArray(slot.searchIntent) ? slot.searchIntent : [slot.searchIntent]).map(text).map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean));
    if (intents.length) return unique([...intents, `${intents[0]} photos`]).slice(0, Math.max(1, Math.min(3, maxQueries)));
  }
  const location = text(slot.location);
  const hotel = text(slot.hotel);
  const activity = text(slot.activity);
  const subject = text(slot.primaryVisualSubject) || text(slot.subject);
  const moduleType = String(slot.moduleType || "").toLowerCase();
  const identity = hotel || activity || subject;
  const coreSubject = text(slot.primaryVisualSubject) || activity || subject;
  const candidates = moduleType.includes("hotel")
    ? [`${identity} ${location} official gallery`, `${identity} official photography`]
    : moduleType.includes("transport")
      ? [`${location} ${coreSubject} travel photography`, `${location} ${coreSubject} official photos`]
      : [`${location} ${coreSubject} travel photography`, `${location} ${coreSubject} safari photos`];
  const intent = Array.isArray(slot.searchIntent) ? slot.searchIntent.map(text) : [text(slot.searchIntent)];
  return unique([...intent.filter(Boolean).map((query) => `${location} ${coreSubject} ${query}`), ...candidates].map((query) => query.replace(/\s+/g, " ").trim())).slice(0, Math.max(1, Math.min(3, maxQueries)));
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
  } else if (/(?:maasai|masai)\s+(?:culture|cultural|people|village|community)|马赛(?:文化|部落|村|人)|马萨伊(?:文化|部落|村|人)/.test(target)) {
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
  return { searchPages: 0, searchPageUrls: [], officialSourcePages: 0, extractedCandidates: 0, officialExtractedCandidates: 0, semanticRelevantCandidates: 0, downloadAttempts: 0, downloadedCandidates: 0, pageFailures: [], downloadFailures: [], groundingRedirectUnresolved: [], searchCompleted: false, semanticExtractionCompleted: false, visualJudgmentCompleted: false };
}

const hotelSpacePattern = /\b(?:tented? (?:suite|room|interior|exterior)|suite|guest ?room|bedroom|interior|exterior|villa|salon|lounge|restaurant|dining|lunch|deck|terrace|pool|spa|bath(?:room|tub)?|pavilion|reception|living|fire ?pit|design)\b|帐篷(?:外观|内部|套房)|套房|客房|卧室|室内|外观|公共空间|休息区|餐厅|露台|泳池|水疗|浴室|浴缸|火塘/i;
const weakHotelIdentityPattern = /\b(?:moon|lill(?:y|ies)|reflection|wildlife|zebra|lion|elephant|bird|flower|sunset|sunrise|landscape|savanna|water)\b|月亮|睡莲|倒影|野生动物|斑马|狮子|大象|鸟类|花卉|日落|日出|纯风景|水面/i;

function hotelCandidateScore(candidate, slot) {
  if (!String(slot.moduleType || "").toLowerCase().includes("hotel")) return 0;
  const words = `${candidate.imageUrl || ""} ${candidate.alt || ""} ${candidate.semanticText || ""}`.toLowerCase().replace(/[_-]+/g, " ");
  const identityTokens = text(slot.hotel).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((token) => token.length >= 4 && !/^(?:singita|hotel|lodge|camp|tented|resort)$/.test(token));
  const identityMatches = identityTokens.filter((token) => words.includes(token)).length;
  const hasHotelSpace = hotelSpacePattern.test(words);
  const weakOnly = !hasHotelSpace && weakHotelIdentityPattern.test(words);
  return identityMatches * 16 + (hasHotelSpace ? 52 : 0) - (weakOnly ? 64 : 0);
}

function expandHotelSourcePages(pages, slot) {
  if (!String(slot.moduleType || "").toLowerCase().includes("hotel")) return pages;
  const expanded = [];
  for (const page of pages) {
    try {
      const parsed = new URL(page.pageUrl);
      const match = parsed.pathname.match(/^(\/lodge\/[^/]+)\/gallery\/?$/i);
      if (match) {
        const landing = new URL(parsed.href);
        landing.pathname = `${match[1]}/`;
        landing.search = "";
        landing.hash = "";
        expanded.push({ ...page, pageUrl: landing.href, title: `${text(slot.hotel) || page.title} official lodge page`, derivedFromPageUrl: page.pageUrl, sourceKind: "derived_official_lodge_page", searchRank: Math.max(0, Number(page.searchRank || 1) - 0.5) });
      }
    } catch { /* Keep the original search result below. */ }
    expanded.push(page);
  }
  return expanded.filter((page, index, array) => page?.pageUrl && array.findIndex((other) => other.pageUrl === page.pageUrl) === index);
}

function uniqueImageAssets(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = canonicalImageAssetKey(candidate?.imageUrl);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function basicScore(candidate, slot) {
  const localWords = `${candidate.alt || ""} ${candidate.semanticText || ""}`.toLowerCase();
  const pageWords = `${candidate.title || ""} ${candidate.summary || ""}`.toLowerCase();
  const anchors = [text(slot.location), text(slot.hotel), text(slot.activity), text(slot.subject), ...positiveVisualContext(slot.visualContext)].flatMap((value) => String(value).toLowerCase().split(/\s+|[-–—·]/)).filter((value) => value.length >= 3);
  const localMatch = anchors.filter((anchor) => localWords.includes(anchor)).length;
  const pageMatch = anchors.filter((anchor) => pageWords.includes(anchor)).length;
  const pixels = Number(candidate.width || 0) * Number(candidate.height || 0);
  const extractionQuality = /og:image|image-srcset|picture-srcset|gallery-link|media-link|json-ld/i.test(candidate.kind || "") ? 12 : candidate.highResHint ? 6 : 0;
  return (candidate.officialHint ? 40 : 0) + extractionQuality + hotelCandidateScore(candidate, slot) + Number(candidate.semanticScore || 0) - Number(candidate.genericActivityPenalty || 0) + localMatch * 8 + pageMatch * 2 + Math.min(20, Math.round(pixels / 500_000)) - Number(candidate.searchRank || 0);
}

function candidateRankScore(candidate, slot) {
  const officialHotelPriority = String(slot.moduleType || "").toLowerCase().includes("hotel") && candidate.officialHint ? 1000 : 0;
  return officialHotelPriority + basicScore(candidate, slot);
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

export function failedHardRequirement(slot, audit) {
  if (audit.technicalUsable !== true) return "technical_unusable";
  if (audit.watermarkFree !== true) return "watermark";
  if (audit.nonAI !== true) return "ai_generated";
  if (audit.photographic !== true || /地图|示意图|信息图|截图|\bmap\b|diagram|infographic|screenshot/i.test(`${audit.actualSubject || ""} ${audit.reason || ""}`)) return "non_photographic";
  const explicitDayActivity = /游猎|safari|game drive|象群|大象|花豹|狮群|角马|鬣狗|猎豹|长颈鹿|elephant|leopard|lion|wildebeest|wildlife|giraffe|草原飞机|bush plane|light aircraft|airstrip|徒步|walking|bush walk|夜游|night game|文化|maasai|masai|反偷猎|anti[- ]?poaching|ranger|conservation|observation post|热气球|hot air balloon/i.test(`${text(slot.activity)} ${text(slot.subject)}`);
  const genericHotelSpace = /酒店泳池|泳池|躺椅|客房|卧室|餐厅|酒廊|酒店空间|酒店室内|营地室内|帐篷室内|pool|sun lounger|guest room|bedroom|restaurant|dining room|lounge|hotel interior|lodge interior|room interior|tent interior/i.test(`${audit.actualSubject || ""} ${audit.reason || ""}`);
  const dayActivity = String(slot.moduleType).toLowerCase() === "day" && explicitDayActivity;
  const lodgingSubject = /酒店外观|营地帐篷|营地外观|帐篷营地|客房|泳池|建筑|\b(?:lodge|camp|tents?|building|accommodation)\b/i.test(audit.actualSubject || "");
  const plannedLodging = /酒店|入住|客房|营地空间|lodge|hotel|room|camp architecture/i.test(text(slot.primaryVisualSubject) || text(slot.subject));
  if (dayActivity && !plannedLodging && (genericHotelSpace || lodgingSubject)) return "activity_mismatch";
  const expectedKenya = /肯尼亚|安博塞利|马赛马拉|纳博伊绍|kenya|amboseli|ma[as]*sai mara|naboisho/i.test(text(slot.location));
  if (expectedKenya && /博茨瓦纳|奥卡万戈|南非|纳米比亚|坦桑尼亚|botswana|okavango|south africa|namibia|tanzania/i.test(audit.actualSubject || "")) return "place_mismatch";
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
  concurrency = {}, existingImages = [], signal, adapters = {}, onCapabilityCall,
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
  deduper.seed(existingImages);
  let dedupeTail = Promise.resolve();
  const withDedupeLock = (candidate) => { const operation = dedupeTail.then(() => deduper.accept(candidate)); dedupeTail = operation.catch(() => undefined); return operation; };
  const timingsMs = { searchProvider: 0, commons: 0, pageExtraction: 0, download: 0, batchVision: 0, topConfirmation: 0 };
  const metrics = { businessBatches: 1, automaticFollowupRounds: 0, slotCount: Array.isArray(slots) ? slots.length : 0, searchCalls: 0, commonsCalls: 0, pageExtractionCalls: 0, downloadAttempts: 0, batchVisionCalls: 0, topConfirmationCalls: 0, technicalRetries: { search: 0, pageExtraction: 0, download: 0 }, timingsMs, timingsSemantics: "各阶段所有并发操作耗时累计；阶段间存在重叠，不应相加作为总耗时" };
  // These maps belong only to this invocation. Never cache slot semantics or judgments.
  const pageCache = new Map();
  const downloadCache = new Map();
  const resourceStats = () => ({ requests: 0, hits: 0, inFlightHits: 0, attempts: 0, networkRequests: 0, attemptsByUrl: {}, networkRequestsByUrl: {} });
  metrics.resourceReuse = { pages: resourceStats(), images: resourceStats() };
  const increment = (counts, url) => { counts[url] = (counts[url] || 0) + 1; };
  const networkEvent = (stats) => (url) => { stats.networkRequests += 1; increment(stats.networkRequestsByUrl, url); };
  const reuse = (cache, stats, url, worker) => {
    stats.requests += 1;
    const previous = cache.get(url);
    if (previous) { stats.hits += 1; if (!previous.settled) stats.inFlightHits += 1; return previous.promise; }
    const entry = { settled: false };
    entry.promise = Promise.resolve().then(worker).then((value) => { entry.settled = true; return value; }, (error) => { if (cache.get(url) === entry) cache.delete(url); throw error; });
    cache.set(url, entry);
    return entry.promise;
  };
  const loadPage = (url) => reuse(pageCache, metrics.resourceReuse.pages, url, () => pageQueue.add(() => withOneTechnicalRetry(async () => {
    metrics.pageExtractionCalls += 1;
    metrics.resourceReuse.pages.attempts += 1;
    increment(metrics.resourceReuse.pages.attemptsByUrl, url);
    return measure("pageExtraction", () => (adapters.fetchImagePageContent || fetchImagePageContent)(url, { signal, onRequest: networkEvent(metrics.resourceReuse.pages) }));
  }, () => { metrics.technicalRetries.pageExtraction += 1; })));
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
      const searchedPages = (pagesResult.status === "fulfilled" ? pagesResult.value : []).filter((item, index, array) => item?.pageUrl && array.findIndex((other) => other.pageUrl === item.pageUrl) === index);
      const allPages = expandHotelSourcePages(searchedPages, layerSlot).sort((a, b) => basicScore(b, layerSlot) - basicScore(a, layerSlot)).slice(0, sourcePagesPerSlot);
      evidence.searchPages = allPages.length;
      evidence.searchPageUrls = allPages.map((item) => item.pageUrl);
      evidence.officialSourcePages = allPages.filter((item) => item.officialHint).length;
      const directCandidates = commonsResult.status === "fulfilled" ? commonsResult.value : [];
      const semanticTerms = unique([text(layerSlot.activity), text(layerSlot.subject), text(layerSlot.location), ...(isHotel ? [text(layerSlot.hotel), "hotel lodge camp tented suite guest room interior exterior public space lounge restaurant dining deck pool spa accommodation"] : []), ...(Array.isArray(layerSlot.searchKeywords) ? layerSlot.searchKeywords : []), ...layerQueries]);
      const extractedGroups = await Promise.all(allPages.map(async (page) => {
        try {
          // Legacy test adapters can own extraction; production shares only the raw page.
          if (adapters.extractPageImages) return await pageQueue.add(() => withOneTechnicalRetry(async () => { metrics.pageExtractionCalls += 1; return measure("pageExtraction", () => extractFn(page, { signal, maxImages: 24, semanticTerms })); }, (error) => { metrics.technicalRetries.pageExtraction += 1; warnings.push(`${layerName} 网页提图技术重试：${page.pageUrl}：${error?.message || error}`); }));
          return await extractFn(page, { signal, maxImages: 24, semanticTerms, loadPage });
        }
        catch (error) { const classified = failureLayer(error); const failure = classified === "download" ? "page_fetch" : classified; evidence.pageFailures.push({ pageUrl: page.pageUrl, layer: failure, reason: error?.message || String(error) }); warnings.push(`${layerName} 网页图片提取失败：${page.pageUrl}：${error?.message || error}`); return []; }
      }));
      evidence.semanticExtractionCompleted = true;
      const perPageCap = Math.max(2, Math.ceil(downloadsPerSlot / Math.max(1, allPages.length)));
      const diverseExtracted = extractedGroups.flatMap((group, index) => [...group].sort((a, b) => candidateRankScore(b, layerSlot) - candidateRankScore(a, layerSlot)).slice(0, isHotel && allPages[index]?.officialHint ? Math.max(4, downloadsPerSlot) : perPageCap));
      const rawCandidates = uniqueImageAssets([...diverseExtracted, ...directCandidates].filter((item) => item?.imageUrl).sort((a, b) => candidateRankScore(b, layerSlot) - candidateRankScore(a, layerSlot))).slice(0, downloadsPerSlot);
      evidence.extractedCandidates = extractedGroups.flat().length + directCandidates.length;
      evidence.officialExtractedCandidates = extractedGroups.reduce((sum, group, index) => sum + (allPages[index]?.officialHint ? group.length : 0), 0);
      evidence.semanticRelevantCandidates = extractedGroups.flat().filter((item) => Number(item.semanticScore || 0) > 0).length + directCandidates.filter((item) => Number(item.semanticScore || 0) > 0).length;
      const downloadedResults = await Promise.all(rawCandidates.map(async (candidate) => {
        try {
          const technical = await reuse(downloadCache, metrics.resourceReuse.images, candidate.imageUrl, () => downloadQueue.add(() => withOneTechnicalRetry(async () => {
            metrics.downloadAttempts += 1; evidence.downloadAttempts += 1;
            metrics.resourceReuse.images.attempts += 1;
            increment(metrics.resourceReuse.images.attemptsByUrl, candidate.imageUrl);
            const result = await measure("download", () => downloadFn(candidate, { directory: assetDirectory, publicPrefix, signal, onRequest: networkEvent(metrics.resourceReuse.images) }));
            return Object.fromEntries(["filePath", "publicUrl", "sha256", "width", "height", "bytes", "contentType"].map((key) => [key, result[key]]));
          }, (error) => { metrics.technicalRetries.download += 1; warnings.push(`${layerName} 候选下载技术重试：${error?.message || error}`); })));
          return { ...candidate, ...technical };
        }
        catch (error) { const failure = failureLayer(error); evidence.downloadFailures.push({ imageUrl: candidate.imageUrl, layer: failure, reason: error?.message || String(error) }); warnings.push(`${layerName} 候选下载失败：${error?.message || error}`); return null; }
      }));
      const contentSeen = new Set();
      const downloaded = downloadedResults.filter((item) => item?.filePath && item?.sha256 && !contentSeen.has(item.sha256) && contentSeen.add(item.sha256)).sort((a, b) => candidateRankScore(b, layerSlot) - candidateRankScore(a, layerSlot)).map((item) => ({ ...item, candidateId: stableCandidateId(slot.slotId, item) }));
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

  let completedSlots = 0;
  onCapabilityCall?.({ phase: "slot_progress", capabilityId: "image_slot_progress", completedSlots, totalSlots: slots.length });
  const results = await Promise.all([...slots].sort((a, b) => imageSlotPriority(a) - imageSlotPriority(b)).map((slot) => slotQueue.add(async () => {
    try { return await processSlot(slot); }
    catch (error) { return { slotId: slot?.slotId || null, status: "failed", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: error?.message || String(error), technicalStatus: "slot_failed", warnings: [], constraints: null, durationMs: 0 }; }
    finally { completedSlots += 1; onCapabilityCall?.({ phase: "slot_progress", capabilityId: "image_slot_progress", completedSlots, totalSlots: slots.length, target: slot.slotId }); }
  })));
  return { batchId, status: resultStatus(results), results, warnings: [], metrics: { ...metrics, concurrencyPeak: { slots: slotQueue.peak, search: searchQueue.peak, pages: pageQueue.peak, downloads: downloadQueue.peak, vision: visionQueue.peak }, durationMs: Date.now() - startedAt } };
}

export function imageSlotPriority(slot) {
  if (slot.moduleType === "day" && slot.required) return 0;
  if (slot.required) return 1;
  return slot.moduleType === "day" ? 2 : 3;
}
