import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeCandidatesBatch } from "./image-audit.mjs";
import { completeVisualJudgment, visualSemanticConflict } from "./image-audit-contract.mjs";
export { completeVisualJudgment } from "./image-audit-contract.mjs";
import { ImageDeduper } from "./image-dedupe.mjs";
import { downloadCandidate, imageResolutionPolicyForSlot, withDayGalleryLayout } from "./image-download.mjs";
import { searchWebBatch } from "./image-search.mjs";
import { normalizeImageSourceMode, searchKnowledgeImages } from "./knowledge-image-search.mjs";
import { applyKnowledgeScopeToQueryPlan, buildKnowledgeQueryPlan, buildKnowledgeScopePlan, buildKnowledgeVisualTarget, classifyKnowledgeImagePurpose, explicitEntityRoute, createKnowledgeScopeResolver, knowledgeSourcePathMatches, knowledgeEntityProbeEvidence, knowledgeEntityProbeAuditCandidate, knowledgeTransportRootPathEvidence } from "./knowledge-scope-resolver.mjs";
import { IMAGE_AUDIT_EVIDENCE_VERSION, isHardRejectionCode, isIdentityEvidenceUnresolved, normalizeHardRejectCode } from "./image-candidate-eligibility.mjs";
import { canonicalImageAssetKey, createImageRetrievalSession, extractPageImages, fetchImagePageContent } from "./page-images.mjs";
import { searchCommonsImages } from "./commons-search.mjs";
import { buildWebExecutionQueries, classifyWebFallback } from "./image-web-execution.mjs";
import { buildImageSearchDiagnostic } from "./image-search-diagnostics.mjs";
import { prepareWebCandidates, gateWebCandidates, webEntityOwnedPageImageEvidence, webHotelIdentityEvidence, webHotelPropertyPage, webImageAssetKey } from "./web-image-candidates.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const diagnosticCode = (value) => /^[a-z][a-z0-9_]{0,79}$/i.test(String(value || "")) ? String(value) : null;

// Keep a compact, URL-free account of where each slot stopped. Detailed query
// and source evidence stays in the existing server-side knowledge/Web records.
export function buildImagePipelineStageTrace(slot = {}, result = {}, sourceMode = "web_only") {
  const evidence = result.pipelineEvidence || {};
  const knowledge = evidence.knowledgeSearch || {};
  const web = evidence.webExecution || {};
  const attempts = Array.isArray(knowledge.attempts) ? knowledge.attempts : [];
  const failedAttempts = attempts.filter((attempt) => ["failed", "timeout"].includes(attempt.status)).length;
  const knowledgeFailureBreakdown = {
    terminalFailed: attempts.filter((attempt) => attempt.status === "failed" && attempt.knowledgeFailureKind === "terminal_failure").length,
    pollTransportFailed: attempts.filter((attempt) => attempt.status === "failed" && attempt.knowledgeStage === "poll" && attempt.knowledgeFailureKind === "transport").length,
    clientDeadlineExceeded: attempts.filter((attempt) => attempt.status === "timeout" && attempt.knowledgeStage === "poll" && attempt.knowledgeFailureKind === "client_deadline").length,
  };
  const webCandidates = (result.candidates || []).filter((candidate) => candidate?.sourceKind !== "knowledge_library");
  const plannerIssues = (slot.plannerValidationIssues || []).map((issue) => diagnosticCode(issue?.code)).filter(Boolean);
  const plannerStatus = slot.plannerSlotStatus === "unresolved" || slot.needsUserAction === true
    ? "unresolved" : slot.plannerSlotStatus === "user_requested" ? "user_requested" : slot.plannerSlotStatus === "locally_repaired" ? "locally_repaired" : "ready";
  const hierarchy = knowledge.hierarchyLookup || {};
  const hierarchyStatus = sourceMode === "web_only" ? "not_requested"
    : hierarchy.status || (knowledge.rootScopeResolution || attempts.length ? "loaded" : knowledge.status === "failed" ? "failed" : "not_requested");
  const root = knowledge.rootScopeResolution || {};
  const scopePlan = knowledge.scopePlan || {};
  const directoryStatus = hierarchyStatus === "failed" || hierarchyStatus === "timeout" || hierarchyStatus === "cancelled"
    ? "not_evaluated"
    : root.status === "ambiguous" ? "ambiguous"
      : scopePlan.scopes?.length ? "planned"
        : root.status === "unresolved" || knowledge.status === "entity_directory_missing" || ["knowledge_hotel_scope_unresolved", "knowledge_scope_unresolved"].includes(result.technicalStatus)
          ? "unresolved" : "not_evaluated";
  const queryStatus = !attempts.length ? "not_executed"
    : knowledge.previewReturned > 0 || knowledge.candidateCount > 0 ? "candidates_returned"
      : knowledge.status === "needs_clarification" ? "needs_clarification"
        : ["failed", "timeout"].includes(knowledge.status) || ["failed", "timeout"].includes(attempts.at(-1)?.status) ? "failed"
          : "completed_empty";
  const webEntered = evidence.sourceFallback?.entered === true || Boolean(web.executedQueries?.length);
  const finalStatus = result.status === "success" ? "auto_adopted"
    : result.technicalStatus === "planner_slot_unresolved" ? "planner_unresolved"
      : result.status === "needs_user_action" ? "needs_user_action"
        : result.status === "not_found" ? "not_found" : "failed";
  return {
    planner: { status: plannerStatus, issueCodes: plannerIssues,
      ...(slot.plannerLocalRepairs?.length ? { localRepairs: structuredClone(slot.plannerLocalRepairs) } : {}),
      ...(slot.manualSearchOverride ? { manualSearchOverride: slot.manualSearchOverride } : {}) },
    hierarchy: { status: hierarchyStatus, failureCode: diagnosticCode(hierarchy.failureCode), attempts: Number(hierarchy.attempts || 0), technicalRetries: Number(hierarchy.technicalRetries || 0) },
    directory: { status: directoryStatus, reasonCode: diagnosticCode(scopePlan.blockedReason || knowledge.failureReason), scopeCount: scopePlan.scopes?.length || 0 },
    knowledgeQuery: { status: sourceMode === "web_only" ? "not_requested" : queryStatus, attempts: attempts.length, failedAttempts, failureBreakdown: knowledgeFailureBreakdown, returnedCandidates: Number(knowledge.previewReturned || 0), sourcePathRejected: Number(knowledge.sourcePathRejectedCount || 0), previewsAudited: Number(knowledge.previewAudited || 0), originalsSaved: Number(knowledge.originalDownloadSavedCount || 0) },
    web: { entered: webEntered, fallbackReason: diagnosticCode(evidence.sourceFallback?.reason), queryCount: web.executedQueries?.length || 0, pagesAccessed: Number(web.pagesUsed || 0), candidates: webCandidates.length, rejectedCandidates: webCandidates.filter((candidate) => candidate.qualificationStatus === "rejected").length, eligibleCandidates: webCandidates.filter((candidate) => candidate.qualificationStatus === "eligible").length },
    terminal: {
      status: finalStatus,
      reasonCode: diagnosticCode(result.technicalStatus),
      selectedSource: result.selected
        ? result.selected.sourceKind || (result.selected.knowledgeAssetKey ? "knowledge_library" : "web")
        : null,
    },
  };
}

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
  const queryCore = slot.queryCore && typeof slot.queryCore === "object" ? slot.queryCore : {};
  const subject = text(queryCore.subject) || text(slot.subject);
  const action = text(queryCore.action);
  const plannedIdentity = text(queryCore.identity);
  const transportType = classifyTransportType({
    ...slot,
    minimumVisualProof: { subject, action, identityRequirement: plannedIdentity },
  });
  const knowledgePurpose = slot.knowledgeImagePurpose || classifyKnowledgeImagePurpose(slot);
  const hotelIdentityRequired = ["hotel_space", "hotel_experience"].includes(knowledgePurpose);
  const locationRole = slot.locationRole === "visual_identity" ? "visual_identity" : "scope_only";
  const identityRequirement = unique([
    slot.exactIdentityRequired === true && plannedIdentity,
    hotelIdentityRequired && hotel,
    transportType && (transportType || text(slot.category) || subject),
  ]).join("；");
  const minimumVisualProof = {
    subject,
    action,
    identityRequirement,
    visualLocation: locationRole === "visual_identity" ? location : "",
    scopeLocation: locationRole === "scope_only" ? location : "",
  };
  const mustHave = unique([
    subject && `核心主体：${subject}`,
    action && `核心动作：${action}`,
    identityRequirement && `必要身份：${identityRequirement}`,
    minimumVisualProof.visualLocation && `必须可识别地点/实体：${minimumVisualProof.visualLocation}`,
  ]);
  const visualContext = slot.visualContext && typeof slot.visualContext === "object" ? slot.visualContext : {};
  const avoid = Array.isArray(visualContext.avoid) ? visualContext.avoid : Array.isArray(visualContext.avoidVisuals) ? visualContext.avoidVisuals : [];
  const prefer = unique([
    text(slot.visualGoal) && `理想完整画面：${text(slot.visualGoal)}`,
    ...positiveVisualContext(visualContext).map((item) => `表现偏好：${item}`),
    ...avoid.map((item) => `差异化偏好：尽量避免${item}`),
    slot.aspectRatio && `构图适配 ${slot.aspectRatio}`,
    "真实自然、干净、有品质",
    String(slot.moduleType).toLowerCase().includes("cover") && "具有目的地代表性并留有标题空间",
  ]);
  const forbid = unique([
    "与核心主体、核心动作、必要身份或事实地点明确冲突",
    "错误类别或不可替代身份冲突",
    "明显水印",
    "破图、不可解码或达不到正式使用的技术质量",
    "AI生成图、地图、示意图、信息图、截图或纯文字海报",
  ]);
  return { minimumVisualProof, core: minimumVisualProof, mustHave, prefer, forbid, transportType, locationRole };
}

export function classifyTransportType(slot = {}) {
  const queryCore = slot.queryCore && typeof slot.queryCore === "object" ? slot.queryCore : {};
  const minimumVisualProof = slot.minimumVisualProof && typeof slot.minimumVisualProof === "object"
    ? slot.minimumVisualProof
    : slot.core && typeof slot.core === "object" ? slot.core : {};
  const moduleIsTransport = String(slot.moduleType || "").trim().toLowerCase() === "transport";
  const coreSubject = text(minimumVisualProof.subject) || text(queryCore.subject);
  const coreIdentity = text(minimumVisualProof.identityRequirement) || text(queryCore.identity);
  const value = unique([
    coreSubject,
    coreIdentity,
    moduleIsTransport && !coreSubject && text(slot.subject),
    moduleIsTransport && !coreSubject && text(slot.category),
    moduleIsTransport && !coreSubject && text(slot.label),
  ]).join(" ").toLowerCase();
  if (!value) return null;
  if (/bush\s*plane|light\s*aircraft|airstrip|草原飞机|轻型飞机|小飞机|内陆飞行|飞抵|飞往/.test(value)) return "bush_plane";
  if (/safari\s*vehicle|game\s*drive|open[- ]?top|游猎车|开顶|越野车|园区.*用车|保护区.*用车/.test(value)) return "safari_vehicle";
  if (/business\s*transfer|transfer\s*vehicle|car\s*transfer|airport\s*transfer|商务用车|商务车|机场接送|酒店接送|城市接送|接送车辆/.test(value)) return "business_transfer_vehicle";
  return null;
}

export function buildImageQueries(slot = {}, maxQueries = 3) {
  const prepared = buildKnowledgeQueryPlan(slot, null, { maxQueries: Math.max(2, Math.min(4, maxQueries)) });
  const preparedQueries = prepared.queries || [];
  if (!preparedQueries.length) return [];
  return unique(preparedQueries.map(text).map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))
    .slice(0, Math.max(1, Math.min(4, maxQueries)));
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
  return { searchPages: 0, searchPageUrls: [], officialSourcePages: 0, extractedCandidates: 0, officialExtractedCandidates: 0, semanticRelevantCandidates: 0, downloadAttempts: 0, downloadedCandidates: 0, pageFailures: [], downloadFailures: [], groundingRedirectUnresolved: [], searchCompleted: false, semanticExtractionCompleted: false, visualJudgmentCompleted: false, knowledgeSearch: null };
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
        expanded.push({ ...page, pageUrl: landing.href, title: `${text(slot.hotel) || page.title} official lodge page`, derivedFromPageUrl: page.pageUrl, sourceKind: "derived_official_lodge_page", searchRank: Number(page.searchRank || 1) + 0.5 });
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
  const extractionQuality = (/og:image|image-srcset|picture-srcset|gallery-link|media-link|json-ld/i.test(candidate.kind || "") ? 12 : candidate.highResHint ? 6 : 0)
    + (candidate.pagePosition === "content" ? 20 : candidate.pagePosition === "chrome" ? -30 : 0);
  const knowledgeLibraryPriority = candidate.sourceKind === "knowledge_library" ? 1200 : 0;
  return knowledgeLibraryPriority + (candidate.officialHint ? 40 : 0) + extractionQuality + hotelCandidateScore(candidate, slot) + Number(candidate.semanticScore || 0) - Number(candidate.genericActivityPenalty || 0) + localMatch * 8 + pageMatch * 2 + Math.min(20, Math.round(pixels / 500_000)) - Number(candidate.searchRank || 0);
}

function candidateRankScore(candidate, slot) {
  // An official homepage is weaker evidence than a property-specific image.
  return Number(candidate.downloadRelevance?.rankBoost || 0) + basicScore(candidate, slot);
}

export function selectDiverseWebDownloads(rankedCandidates, allowance) {
  const budget = Math.max(0, Math.floor(Number(allowance) || 0));
  if (!budget) return [];
  const perPageLimit = Math.max(1, Math.ceil(budget * 0.6));
  const perPage = new Map();
  const selected = [];
  const selectedKeys = new Set();
  for (const candidate of rankedCandidates) {
    if (selected.length >= budget) break;
    const key = candidate.pageUrl || candidate.sourcePage || candidate.imageUrl;
    const count = perPage.get(key) || 0;
    if (count >= perPageLimit) continue;
    selected.push(candidate);
    selectedKeys.add(webImageAssetKey(candidate.imageUrl));
    perPage.set(key, count + 1);
  }
  // A single productive page may fill the remaining allowance. Diversity is
  // a bounded ordering policy, not an extra rejection or search round.
  for (const candidate of rankedCandidates) {
    if (selected.length >= budget) break;
    const key = webImageAssetKey(candidate.imageUrl);
    if (!selectedKeys.has(key)) { selected.push(candidate); selectedKeys.add(key); }
  }
  return selected;
}

function pageSourcePriority(page = {}, slot = {}) {
  const value = `${page.pageUrl || ""} ${page.title || ""}`;
  if (webHotelPropertyPage(page.pageUrl, slot)) return /\/(?:gallery|photos?|media)(?:\/|$)/i.test(page.pageUrl || "") ? 550 : 500;
  if (/\/(?:gallery|photos?|media)(?:\/|$)|\b(?:gallery|photos?|media)\b/i.test(value)) return 300;
  if (page.sourceKind === "derived_official_lodge_page") return 200;
  if (/\/(?:lodge|hotel|camp|resort|experience|destination)\//i.test(value)) return 150;
  return 0;
}

const weakSearchTokens = new Set(["photo", "photos", "photography", "image", "images", "travel", "experience", "landscape", "hotel", "lodge", "camp", "safari"]);

function lexicalTokens(value) {
  return String(value || "").toLocaleLowerCase("en").split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !weakSearchTokens.has(token));
}

function knowledgeCandidateLexicalScore(candidate = {}, slot = {}) {
  const haystack = [candidate.title, candidate.alt, candidate.knowledgeFragmentContent, ...(candidate.knowledgeSourcePaths || [])]
    .join(" ").toLocaleLowerCase("en");
  const anchors = unique([slot.primaryVisualSubject, slot.subject, slot.activity, ...(candidate.knowledgeQueries || [])]);
  const phraseMatches = anchors.filter((anchor) => {
    const normalizedAnchor = String(anchor || "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return normalizedAnchor.length >= 4 && haystack.includes(normalizedAnchor);
  }).length;
  const tokens = unique(anchors.flatMap(lexicalTokens));
  const tokenMatches = tokens.filter((token) => haystack.includes(token)).length;
  return phraseMatches * 30 + tokenMatches * 8;
}

function metadataStronglyMatchesVisualTarget(candidate = {}, slot = {}) {
  const normalize = (value) => String(value || "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, "");
  const metadata = normalize([candidate.title, ...(candidate.knowledgeSourcePaths || [])].join(" "));
  const targets = unique([slot.primaryVisualSubject, slot.subject, slot.activity]).map(normalize).filter((value) => value.length >= 4);
  if (targets.some((target) => metadata.includes(target))) return true;
  const rawTarget = `${text(slot.primaryVisualSubject)} ${text(slot.subject)} ${text(slot.activity)}`.toLocaleLowerCase("en");
  const rawMetadata = [candidate.title, ...(candidate.knowledgeSourcePaths || [])].join(" ").toLocaleLowerCase("en");
  const distinctiveActions = [
    [/walking\s*safari|bush\s*walk|步行\s*(?:safari|游猎)|徒步\s*(?:safari|游猎)/, /walking|bush[-_\s]*walk|步行|徒步/],
    [/night\s*(?:safari|game\s*drive)|夜间\s*游猎|夜巡/, /night|thermal|夜间|夜巡|热成像/],
    [/river\s*crossing|渡河/, /river[-_\s]*crossing|渡河|过河/],
    [/starlit\s*dinner|星空\s*(?:晚餐|晚宴)/, /starlit|dinner|星空晚|晚宴/],
    [/bush\s*breakfast|丛林早餐|草原早餐/, /bush[-_\s]*breakfast|丛林早餐|草原早餐/],
    [/sundowner|日落酒会|落日酒会/, /sundowner|日落酒会|落日酒会/],
    [/star\s*bed|sleep\s*out|星空床/, /star[-_\s]*bed|sleep[-_\s]*out|星空床/],
  ];
  return distinctiveActions.some(([target, evidence]) => target.test(rawTarget) && evidence.test(rawMetadata));
}

function knowledgeCandidateRankScore(candidate, slot) {
  const pixels = Number(candidate.width || 0) * Number(candidate.height || 0);
  const technicalHint = Math.min(20, Math.round(pixels / 500_000));
  return knowledgeCandidateLexicalScore(candidate, slot) * 10
    + Number(candidate.semanticScore || 0)
    + technicalHint
    - Number(candidate.searchRank || 0);
}

function knowledgeAssetIdentity(candidate = {}) {
  const explicitId = String(candidate.knowledgeAssetId || "").trim();
  if (explicitId) return `asset:${explicitId}`;
  const versionId = String(candidate.knowledgeMatchedFile?.versionId || candidate.knowledgePreview?.versionId || "").trim();
  if (versionId) return `version:${versionId}`;
  const knowledgeId = String(candidate.knowledgeMatchedFile?.knowledgeId || candidate.knowledgePreview?.knowledgeId || "").trim();
  if (knowledgeId) return `knowledge:${knowledgeId}`;
  try {
    const parsed = new URL(String(candidate.imageUrl || ""));
    parsed.search = "";
    parsed.hash = "";
    if (parsed.pathname) return `url:${createHash("sha256").update(parsed.href).digest("hex")}`;
  } catch { /* Fall through to the source-backed identity below. */ }
  const sourcePaths = unique(Array.isArray(candidate.knowledgeSourcePaths) ? candidate.knowledgeSourcePaths : []).sort();
  const sourceIdentity = [sourcePaths.join("|"), candidate.title, candidate.knowledgeMimeType].map((value) => String(value || "").trim()).join("|");
  return sourceIdentity ? `source:${createHash("sha256").update(sourceIdentity).digest("hex")}` : "";
}

function fillProbeDescriptor(previous, incoming) {
  if (!previous || !incoming) return previous || incoming || null;
  for (const field of ["versionId", "knowledgeId", "sourcePathId", "filename"]) {
    if (text(previous[field]) && text(incoming[field]) && text(previous[field]) !== text(incoming[field])) return previous;
  }
  if (previous.url && incoming.url) {
    try {
      const before = new URL(previous.url), after = new URL(incoming.url);
      if (before.origin !== after.origin || before.pathname !== after.pathname) return previous;
    } catch { if (previous.url !== incoming.url) return previous; }
  }
  const filled = { ...previous };
  for (const field of ["filename", "sourceDisplayPath", "sourcePathId", "knowledgeId", "versionId"]) {
    if (!text(filled[field]) && text(incoming[field])) filled[field] = incoming[field];
  }
  return filled;
}

function mergeKnowledgeCandidate(previous, candidate, { queryText, queryId, recordId } = {}) {
  const queries = unique([...(previous?.knowledgeQueries || []), queryText]);
  const queryIds = unique([...(previous?.knowledgeQueryIds || []), queryId]);
  const recordIds = unique([...(previous?.knowledgeRecordIds || []), recordId, candidate.knowledgeRecordId]);
  const sourcePaths = unique([...(previous?.knowledgeSourcePaths || []), ...(candidate.knowledgeSourcePaths || [])]);
  const assetKey = knowledgeAssetIdentity(candidate);
  const sameProbeAsset = previous?.knowledgeSourcePathMode === "entity_probe" && candidate.knowledgeSourcePathMode === "entity_probe"
    && /^(?:asset|version|knowledge):/.test(assetKey) && knowledgeAssetIdentity(previous) === assetKey;
  const merged = {
    ...(previous || candidate),
    ...candidate,
    knowledgeAssetKey: previous?.knowledgeAssetKey || candidate.knowledgeAssetKey || knowledgeAssetIdentity(candidate),
    knowledgeQueries: queries,
    knowledgeQueryIds: queryIds,
    knowledgeRecordIds: recordIds,
    knowledgeSourcePaths: sourcePaths,
    knowledgePreview: sameProbeAsset ? fillProbeDescriptor(previous?.knowledgePreview, candidate.knowledgePreview) : previous?.knowledgePreview || candidate.knowledgePreview || null,
    knowledgeMatchedFile: sameProbeAsset ? fillProbeDescriptor(previous?.knowledgeMatchedFile, candidate.knowledgeMatchedFile) : previous?.knowledgeMatchedFile || candidate.knowledgeMatchedFile || null,
    semanticScore: Math.max(Number(previous?.semanticScore || 0), Number(candidate.semanticScore || 0)),
    searchRank: Math.min(Number(previous?.searchRank || Number.POSITIVE_INFINITY), Number(candidate.searchRank || Number.POSITIVE_INFINITY)),
  };
  merged.knowledgeRecordId = previous?.knowledgeRecordId || candidate.knowledgeRecordId;
  merged.knowledgeQueryId = previous?.knowledgeQueryId || candidate.knowledgeQueryId;
  if (!Number.isFinite(merged.searchRank)) merged.searchRank = 0;
  return merged;
}

function auditQualityScore(audit = {}, candidate = {}, slot = {}) {
  const matchPriority = audit.matchLevel === "exact" || audit.matchLevel === "exact_match" ? 2_000
    : audit.matchLevel === "representative" ? 1_000 : 0;
  return matchPriority
    + Number(audit.score || 0) * 4
    + Number(audit.relevance || 0) * 4
    + Number(audit.composition || 0) * 2
    + Number(audit.luxury || 0) * 2
    + Number(audit.cleanliness || 0)
    + candidateRankScore(candidate, slot) / 100;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

export function buildKnowledgeQueryCacheKey({ source = "", accessIdentity = "", scopeNodeIds = [], query = "", topK = 5, resultType = "image", options = {} } = {}) {
  return JSON.stringify(stableObject({
    source: String(source || "").trim().replace(/\/$/, ""),
    accessIdentity: String(accessIdentity || ""),
    scopeNodeIds: unique(scopeNodeIds || []).sort(),
    query: String(query || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en"),
    topK: Math.max(1, Math.min(10, Number(topK) || 5)),
    resultType: String(resultType || "image"),
    options: options && typeof options === "object" && !Array.isArray(options) ? options : {},
  }));
}

function stableCandidateId(slotId, candidate = {}) {
  const identity = [slotId, candidate.knowledgeAssetKey, candidate.knowledgeAssetId, candidate.sha256, candidate.previewSha256, candidate.imageUrl, candidate.pageUrl].map((item) => String(item || "").trim()).join("|");
  return `candidate-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function hardJudgment(audit = null) {
  if (!audit) return null;
  return {
    ...(audit.auditEvidenceVersion ? { auditEvidenceVersion: audit.auditEvidenceVersion, identityEvidence: audit.identityEvidence } : {}),
    locationMatch: audit.locationMatch,
    visibleLocationConflict: audit.visibleLocationConflict,
    hotelIdentityMatch: audit.hotelIdentityMatch,
    visibleIdentityConflict: audit.visibleIdentityConflict,
    activityMatch: audit.activityMatch,
    coreActionMatch: audit.coreActionMatch,
    subjectMatch: audit.subjectMatch,
    coreSubjectMatch: audit.coreSubjectMatch,
    identityMatch: audit.identityMatch,
    subjectClear: audit.subjectClear,
    subjectLargeEnough: audit.subjectLargeEnough,
    subjectPrimary: audit.subjectPrimary,
    transportType: audit.transportType || null,
    transportTypeMatch: audit.transportTypeMatch,
    watermarkFree: audit.watermarkFree,
    nonAI: audit.nonAI,
    photographic: audit.photographic,
    technicalUsable: audit.technicalUsable,
    eligible: audit.eligible,
    hardRejectCode: normalizeHardRejectCode(audit.hardRejectCode),
    matchLevel: audit.matchLevel || null,
    ...(audit.auditContract ? { auditContract: audit.auditContract } : {}),
  };
}

function commonsApiFailureSummary(failure) {
  return { code: failure?.code || "commons_api_failed", status: Number.isInteger(failure?.status) ? failure.status : null, challengeDetected: failure?.challengeDetected === true };
}

function publicCandidate(candidate, audit = null, rejection = null) {
  const fromKnowledgeLibrary = candidate.sourceKind === "knowledge_library";
  const normalizedRejection = normalizeHardRejectCode(rejection);
  const autoRejected = isHardRejectionCode(normalizedRejection);
  const reviewTimeout = rejection === "review_timeout";
  const originalDownloadFailed = rejection === "preview_found_original_download_failed";
  const originalFailureCode = candidate.originalDownloadFailureCode || null;
  const effectiveAudit = autoRejected && audit ? { ...audit, eligible: false, matchLevel: "mismatch", hardRejectCode: normalizedRejection } : audit;
  const incompleteReview = ["needs_user_judgment", "review_timeout"].includes(rejection) || effectiveAudit?.auditContract?.complete === false;
  const qualificationStatus = autoRejected ? "rejected" : !incompleteReview && effectiveAudit?.eligible === true ? "eligible" : "unreviewed";
  const originalDownloaded = Boolean(candidate.originalDownloaded && candidate.publicUrl && candidate.filePath);
  const previewUrl = candidate.previewPublicUrl || candidate.knowledgePreview?.url || candidate.previewUrl || (fromKnowledgeLibrary ? candidate.imageUrl : candidate.publicUrl);
  const reviewStatus = autoRejected ? "hard_reject"
    : reviewTimeout ? "audit_timeout"
      : rejection === "needs_user_judgment" ? "needs_user_judgment"
        : originalDownloadFailed ? (originalFailureCode === "resolution_failed" ? "original_resolution_insufficient" : "original_download_failed")
          : effectiveAudit?.eligible === true && effectiveAudit?.matchLevel === "representative" ? "representative"
            : effectiveAudit?.eligible === true ? "approved_not_selected"
              : rejection ? "not_auto_selected" : "needs_user_judgment";
  const candidateStatus = originalDownloaded ? "downloaded_not_selected"
    : originalDownloadFailed ? "manual_only"
      : autoRejected || (audit && rejection && !["review_timeout", "needs_user_judgment"].includes(rejection)) ? "review_rejected"
      : reviewTimeout ? "review_timeout"
        : incompleteReview ? "needs_user_judgment"
        : rejection === "not_auto_reviewed" || !audit ? "not_auto_reviewed"
          : "review_approved_not_selected";
  return {
    candidateId: candidate.candidateId,
    imageUrl: fromKnowledgeLibrary ? previewUrl : candidate.imageUrl,
    previewUrl: fromKnowledgeLibrary ? previewUrl : candidate.publicUrl,
    localPreviewUrl: candidate.previewPublicUrl || candidate.publicUrl || null,
    localUrl: originalDownloaded || !fromKnowledgeLibrary ? candidate.publicUrl : null,
    sourcePage: candidate.pageUrl,
    sourceTitle: candidate.title || "",
    sourceKind: candidate.sourceKind || null,
    acquisitionMethod: candidate.acquisitionMethod || null,
    originalImageUrl: fromKnowledgeLibrary ? null : candidate.originalImageUrl || null,
    originalMime: originalDownloaded || !fromKnowledgeLibrary
      ? candidate.sourceContentType || candidate.originalMime || candidate.knowledgeMatchedFile?.mimeType || candidate.knowledgeMimeType || null
      : candidate.knowledgeMatchedFile?.mimeType || candidate.knowledgeMimeType || candidate.originalMime || null,
    storedMime: originalDownloaded || !fromKnowledgeLibrary ? candidate.contentType || null : null,
    sourceFormat: originalDownloaded || !fromKnowledgeLibrary ? candidate.sourceFormat || null : null,
    conversion: originalDownloaded || !fromKnowledgeLibrary ? candidate.conversion || null : null,
    sourceBytes: originalDownloaded || !fromKnowledgeLibrary ? candidate.sourceBytes || null : null,
    mediaType: candidate.mediaType || null,
    originalBytes: Number(candidate.originalBytes || 0) || null,
    license: candidate.license || null,
    licenseUrl: candidate.licenseUrl || null,
    creator: candidate.creator || null,
    ...(candidate.commonsApiFailure ? { commonsApiFailure: commonsApiFailureSummary(candidate.commonsApiFailure) } : {}),
    downloadedImageUrl: fromKnowledgeLibrary ? null : candidate.downloadedImageUrl || null,
    downloadVariantAttempts: Number(candidate.downloadVariantAttempts || 0),
    knowledgeAssetKey: candidate.knowledgeAssetKey || null,
    knowledgeAssetId: candidate.knowledgeAssetId || null,
    knowledgePreview: candidate.knowledgePreview ? { ...candidate.knowledgePreview, url: candidate.previewPublicUrl ? null : candidate.knowledgePreview.url } : null,
    knowledgeMatchedFile: candidate.knowledgeMatchedFile ? { ...candidate.knowledgeMatchedFile, url: null } : null,
    knowledgeQueryId: candidate.knowledgeQueryId || null,
    knowledgeQueryIds: Array.isArray(candidate.knowledgeQueryIds) ? candidate.knowledgeQueryIds : [candidate.knowledgeQueryId].filter(Boolean),
    knowledgeQueries: Array.isArray(candidate.knowledgeQueries) ? candidate.knowledgeQueries : [],
    knowledgeRecordIds: Array.isArray(candidate.knowledgeRecordIds) ? candidate.knowledgeRecordIds : [candidate.knowledgeRecordId].filter(Boolean),
    knowledgeFragmentContent: candidate.knowledgeFragmentContent || null,
    knowledgeSourcePaths: Array.isArray(candidate.knowledgeSourcePaths) ? candidate.knowledgeSourcePaths : [],
    officialSource: Boolean(candidate.officialHint),
    width: originalDownloaded ? candidate.width : candidate.previewWidth,
    height: originalDownloaded ? candidate.height : candidate.previewHeight,
    sha256: originalDownloaded ? candidate.sha256 : candidate.previewSha256,
    originalDownloaded,
    originalDownloadStatus: candidate.originalDownloadStatus || (originalDownloaded ? "success" : "not_requested"),
    originalDownloadFailureCode: originalFailureCode,
    originalDownloadFailureReason: candidate.originalDownloadFailureReason || null,
    ...(candidate.webDownloadAdmission ? {
      webDownloadAdmission: candidate.webDownloadAdmission,
      webDownloadDeferredReason: candidate.webDownloadDeferredReason || null,
      webQueries: candidate.webQueries || [],
    } : {}),
    originalWidth: Number(candidate.originalWidth || 0) || null,
    originalHeight: Number(candidate.originalHeight || 0) || null,
    minimumWidth: Number(candidate.minimumWidth || 0) || null,
    minimumHeight: Number(candidate.minimumHeight || 0) || null,
    semanticScore: Number(candidate.semanticScore || 0),
    semanticMatches: Array.isArray(candidate.semanticMatches) ? candidate.semanticMatches : [],
    actualSubject: effectiveAudit?.actualSubject || null,
    matchReason: effectiveAudit?.reason || null,
    matchLevel: effectiveAudit?.matchLevel || null,
    hardJudgment: hardJudgment(effectiveAudit),
    rejection: originalFailureCode === "resolution_failed" ? originalFailureCode : normalizedRejection || rejection,
    candidateStatus,
    autoReviewStatus: reviewStatus,
    autoRejected,
    qualificationStatus,
    reviewTimeout,
    notAutoSelected: true,
    manualOnly: qualificationStatus !== "eligible",
  };
}

function mergePublicCandidates(existing = [], incoming = []) {
  const byId = new Map(existing.filter(Boolean).map((item) => [item.candidateId, item]));
  for (const item of incoming.filter(Boolean)) {
    const previous = byId.get(item.candidateId);
    byId.set(item.candidateId, previous ? { ...previous, ...item } : item);
  }
  return [...byId.values()];
}

function resultStatus(results) {
  if (results.every((item) => item.status === "success")) return "success";
  if (results.some((item) => item.status === "success")) return "partial_success";
  if (results.some((item) => item.status === "needs_user_action")) return "needs_user_action";
  if (results.every((item) => item.status === "not_found")) return "not_found";
  return "failed";
}

export function failedHardRequirement(slot, audit, candidate = {}) {
  const semanticConflict = visualSemanticConflict(slot, audit, candidate);
  if (semanticConflict) return semanticConflict;
  if (isIdentityEvidenceUnresolved(audit)) return "needs_user_judgment";
  const constraints = buildImageConstraints(slot);
  const core = constraints.core;
  const identityBound = ["hotel_space", "hotel_experience", "explicit_entity"].includes(slot.knowledgeImagePurpose || classifyKnowledgeImagePurpose(slot));
  if (audit.technicalUsable !== true) return "low_quality_unusable";
  if (audit.watermarkFree !== true) return "watermark";
  if (audit.nonAI !== true) return "ai_generated";
  if (audit.photographic !== true || /地图|示意图|信息图|截图|\bmap\b|diagram|infographic|screenshot/i.test(`${audit.actualSubject || ""} ${audit.reason || ""}`)) return "non_photographic";
  if (audit.subjectClear === false) return "subject_not_clear";
  const explicitHardCode = normalizeHardRejectCode(audit.hardRejectCode);
  const scopeOnlyLocationWithoutVisibleConflict = explicitHardCode === "wrong_location" && constraints.locationRole === "scope_only" && audit.visibleLocationConflict === false;
  const contextualHotelWithoutVisibleConflict = explicitHardCode === "wrong_hotel" && !identityBound && audit.visibleIdentityConflict === false;
  const auxiliaryTransportWithoutCoreRequirement = explicitHardCode === "wrong_transport_type" && !constraints.transportType;
  if (isHardRejectionCode(explicitHardCode) && !scopeOnlyLocationWithoutVisibleConflict && !contextualHotelWithoutVisibleConflict && !auxiliaryTransportWithoutCoreRequirement) return explicitHardCode;
  if (audit.visibleLocationConflict === true) return "wrong_location";
  if (audit.visibleIdentityConflict === true) return identityBound && text(slot.hotel) ? "wrong_hotel" : "wrong_subject";
  if (core.visualLocation && audit.locationMatch !== true) return "wrong_location";
  if (identityBound && text(slot.hotel) && audit.hotelIdentityMatch !== true) return "wrong_hotel";
  if (constraints.transportType && audit.transportTypeMatch !== true) return "wrong_transport_type";
  // A broad safari_vehicle verdict cannot override an explicit vehicle shape
  // conflict visible in the model's own factual description.
  if (constraints.transportType === "safari_vehicle"
    && /(?:四驱|四轮|4\s*[x×]\s*4|four[- ]?wheel)/i.test(core.subject)
    && /(?:六轮|6轮|6\s*[x×]\s*6|six[- ]?wheel)/i.test(text(audit.actualSubject))) return "wrong_transport_type";
  if (core.identityRequirement && audit.identityMatch === false) return identityBound && text(slot.hotel) ? "wrong_hotel" : constraints.transportType ? "wrong_transport_type" : "wrong_subject";
  if (core.action && (audit.coreActionMatch ?? audit.activityMatch) !== true) return "wrong_activity";
  if (core.subject && (audit.coreSubjectMatch ?? audit.subjectMatch) !== true) return "wrong_subject";
  return null;
}

// This is a draft-only exception. The ordinary eligibility and selected gates
// continue to reject an image whose exact entity has not been proven.
export function provisionalIdentityOnly(slot, audit, candidate = {}, rejection = null) {
  if (slot?.exactIdentityRequired !== true || rejection !== "needs_user_judgment"
    || !completeVisualJudgment(audit) || !isIdentityEvidenceUnresolved(audit)
    || audit.identityEvidence?.status !== "insufficient") return false;
  const withoutMissingIdentity = {
    ...audit,
    identityEvidence: { ...audit.identityEvidence, status: "supported" },
    identityMatch: true,
    hotelIdentityMatch: true,
  };
  return failedHardRequirement(slot, withoutMissingIdentity, candidate) === null;
}

function finalizeAuditEligibility(audit, rejection = null) {
  if (!audit) return audit;
  const hardCode = isHardRejectionCode(rejection) ? normalizeHardRejectCode(rejection) : null;
  if (rejection) {
    return {
      ...audit,
      eligible: false,
      hardRejectCode: hardCode || normalizeHardRejectCode(audit.hardRejectCode),
      matchLevel: hardCode ? "mismatch" : audit.matchLevel,
    };
  }
  return {
    ...audit,
    eligible: true,
    hardRejectCode: "none",
    matchLevel: audit.matchLevel === "mismatch" ? "representative" : audit.matchLevel,
  };
}

const countryBoundKnowledgeMode = (mode) => mode === "country_context" || mode === "transport_root_context";

function knowledgeCandidateContextLocation(candidate, fallback) {
  const mode = candidate?.knowledgeSourcePathMode;
  const resolution = mode === "transport_root_context" ? candidate?.knowledgeEvidenceResolution : candidate?.knowledgeScopeResolution;
  return countryBoundKnowledgeMode(mode) ? resolution?.node?.formalName || fallback : fallback;
}

function knowledgeCandidateGateSlot(slot, candidate) {
  if (!countryBoundKnowledgeMode(candidate?.knowledgeSourcePathMode)) return slot;
  return {
    ...slot,
    // A root-scope transport result is still bound to the confirmed country.
    // Never turn a required visible location into a softer country boundary.
    location: slot.locationRole === "visual_identity" ? slot.location : knowledgeCandidateContextLocation(candidate, slot.location),
    hotel: null,
    knowledgeSourcePathMode: candidate.knowledgeSourcePathMode,
    knowledgeImagePurpose: classifyKnowledgeImagePurpose(slot),
  };
}

export function applyKnowledgeSourcePathEvidence(slot, audit, pathDecision = {}) {
  if (!audit) return audit;
  if (pathDecision.mode === "entity_probe") {
    if (isHardRejectionCode(audit.hardRejectCode) || audit.visibleIdentityConflict === true || audit.visibleLocationConflict === true || audit.identityEvidence?.status === "conflict") return audit;
    if (pathDecision.match === false) return { ...audit, eligible: false, identityMatch: false, hardRejectCode: text(slot.hotel) ? "wrong_hotel" : "wrong_subject" };
    if (pathDecision.match === true) return {
      ...audit, identityMatch: true, hotelIdentityMatch: true,
      identityEvidence: { status: "supported", basis: pathDecision.basis, quote: pathDecision.quote, evidenceIds: [], explanation: "目标完整身份与当前图片文件的独立元数据相符" },
      auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION,
    };
    if (audit.auditEvidenceVersion === IMAGE_AUDIT_EVIDENCE_VERSION && audit.identityEvidence?.status === "supported" && audit.identityEvidence.basis === "visible_identifier") return audit;
    return {
      ...audit, eligible: false, identityMatch: false, hotelIdentityMatch: false,
      auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION,
      identityEvidence: { status: "insufficient", basis: "none", evidenceIds: [], explanation: "父级地区和结果共用说明不能证明当前图片的具体实体身份" },
    };
  }
  if (pathDecision.match === false) {
    const identityBound = pathDecision.mode === "entity_identity";
    return { ...audit, locationMatch: identityBound ? audit.locationMatch : false, hotelIdentityMatch: identityBound && text(slot.hotel) ? false : audit.hotelIdentityMatch, eligible: false, hardRejectCode: identityBound && text(slot.hotel) ? "wrong_hotel" : "wrong_location", reason: [audit.reason, `知识库来源路径与目标 scope 不一致：${pathDecision.scopePath || "unknown"}`].filter(Boolean).join("；") };
  }
  if (pathDecision.match !== true) return audit;
  const explicitHardCode = normalizeHardRejectCode(audit.hardRejectCode);
  // A matching folder can resolve missing identity evidence, but cannot
  // overrule a fresh photo/caption conflict or an explicit identity rejection.
  if (audit.auditEvidenceVersion === IMAGE_AUDIT_EVIDENCE_VERSION
    && (audit.identityEvidence?.status === "conflict" || ["wrong_hotel", "wrong_location", "knowledge_source_path_mismatch"].includes(explicitHardCode))) return audit;
  const countryContext = countryBoundKnowledgeMode(pathDecision.mode);
  const next = {
    ...audit,
    locationMatch: pathDecision.mode === "entity_identity" && text(slot.location) && explicitHardCode !== "wrong_location" ? true : audit.locationMatch,
    hotelIdentityMatch: pathDecision.mode === "entity_identity" && text(slot.hotel) && explicitHardCode !== "wrong_hotel" ? true : audit.hotelIdentityMatch,
    reason: [audit.reason, countryContext ? "知识库 source_path 已确认国家范围；普通体验不以素材所在酒店或同国小地区作为身份限制" : "知识库 source_path 已确认目标地点/酒店身份"].filter(Boolean).join("；"),
  };
  if (pathDecision.mode === "entity_identity") {
    if (explicitHardCode === "wrong_location" && audit.visibleLocationConflict === false) {
      next.locationMatch = true;
      next.hardRejectCode = "none";
    }
    if (explicitHardCode === "wrong_hotel" && audit.visibleIdentityConflict === false) {
      next.hotelIdentityMatch = true;
      next.hardRejectCode = "none";
    }
    if (audit.auditEvidenceVersion === IMAGE_AUDIT_EVIDENCE_VERSION && !audit.visibleIdentityConflict && !audit.visibleLocationConflict) {
      next.identityMatch = true;
      next.identityEvidence = { status: "supported", basis: "knowledge_path", evidenceIds: [], explanation: "已通过程序核验的知识库来源路径与目标实体一致", quote: pathDecision.scopePath || "", visibleIdentifier: "" };
    }
  }
  return next;
}

export function applyWebImageIdentityEvidence(slot, candidate, audit) {
  const hotelProof = webHotelIdentityEvidence(candidate, slot);
  const entityProof = hotelProof ? null : webEntityOwnedPageImageEvidence(candidate, slot);
  const proof = hotelProof || entityProof;
  if (!proof || !completeVisualJudgment(audit) || audit.auditEvidenceVersion !== IMAGE_AUDIT_EVIDENCE_VERSION) return audit;
  if (audit.identityEvidence?.status !== "insufficient") return audit;
  if (audit.identityEvidence?.status === "conflict" || audit.visibleIdentityConflict === true || audit.visibleLocationConflict === true) return audit;
  if (isHardRejectionCode(audit.hardRejectCode) || audit.matchLevel === "mismatch") return audit;
  if (["coreSubjectMatch", "coreActionMatch", "subjectMatch", "activityMatch", "subjectClear", "watermarkFree", "nonAI", "photographic", "technicalUsable"].some((field) => audit[field] === false)) return audit;
  if (entityProof && slot.locationRole === "visual_identity" && audit.locationMatch !== true) return audit;
  return {
    ...audit,
    hotelIdentityMatch: true,
    identityMatch: true,
    identityEvidence: { status: "supported", basis: proof.basis, evidenceIds: proof.evidenceIds, quote: proof.quote, explanation: "实体专属来源与图片级证据经程序核验，且画面审核未发现冲突", visibleIdentifier: audit.identityEvidence?.visibleIdentifier || "" },
    reason: [audit.reason, "实体专属来源已核验；原身份字段不一致已纠正"].filter(Boolean).join("；"),
  };
}

function retryableTechnicalError(error) {
  if (error?.technicalRetryHandled) return false;
  if (["search_quota_rejected", "search_rate_limited"].includes(error?.code)) return false;
  if (error?.code === "search_provider_failed") return Number(error.status) >= 500;
  const value = `${error?.code || ""} ${error?.name || ""} ${error?.message || error || ""}`;
  if (/page_access_blocked|page_redirect_mismatch|分辨率不足|文件过大|资源上限|不支持的图片格式|下载失败（4\d\d）/i.test(value)) return false;
  return /invalid_json|JSON|parse|解析|decode|解码|corrupt|sharp|unsupported image|network|网络错误|fetch|socket|ECONN|ETIMEDOUT|timeout|timed out|超时|aborted|abort|unavailable|请求失败|下载失败/i.test(value);
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
  if (/文件过大|超过.*(?:MB|大小)|payload.*large|content.*length/i.test(value)) return "oversized_original";
  if (/分辨率不足|比例不适合/i.test(value)) return "size";
  if (/decode|解码|corrupt|sharp|unsupported image|不支持的图片格式/i.test(value)) return "decode";
  if (/下载|network|fetch|socket|ECONN|ENOTFOUND|ETIMEDOUT|timeout|aborted|terminated|HTTP|\（\d{3}\）/i.test(value)) return "download";
  return "other";
}

export async function runImageSearchSkill({
  slots = [], root = appRoot, searchApiKey, searchBaseUrl, searchModel, visionApiKey, visionBaseUrl, visionModel,
  maxQueriesPerSlot = 2, sourcePagesPerSlot = 4, downloadsPerSlot = 6, visionCandidatesPerSlot = 4,
  sourceMode = "web_only", knowledgeBaseUrl = "", knowledgeTopK = 5, knowledgeScopeNodeIds = [], knowledgeQueriesPerSlot = 4,
  knowledgeTimeoutMs = 120_000, knowledgeRequestTimeoutMs = 30_000, knowledgePollIntervalMs = 2_000,
  trustedKnowledgeOrigins = [], knowledgeAccessIdentity = "", knowledgeQueryOptions = {},
  concurrency = {}, existingImages = [], signal, adapters = {}, onCapabilityCall,
} = {}) {
  const retrievalSession = adapters.retrievalSession || (adapters.createImageRetrievalSession || createImageRetrievalSession)({ signal });
  const ownsRetrievalSession = !adapters.retrievalSession;
  try {
  const startedAt = Date.now();
  const batchId = randomUUID();
  const searchFn = adapters.searchWebBatch || searchWebBatch;
  const knowledgeFn = adapters.searchKnowledgeImages || searchKnowledgeImages;
  const knowledgeScopeResolver = createKnowledgeScopeResolver({
    baseUrl: knowledgeBaseUrl,
    root,
    signal,
    fetchImpl: adapters.knowledgeFetch || fetch,
    hierarchyLoader: adapters.loadKnowledgeHierarchy,
  });
  const commonsFn = adapters.searchCommonsImages || searchCommonsImages;
  const extractFn = adapters.extractPageImages || extractPageImages;
  const downloadFn = adapters.downloadCandidate || downloadCandidate;
  const judgeFn = adapters.judgeCandidatesBatch || judgeCandidatesBatch;
  const slotQueue = new TaskQueue(concurrency.slots || 4);
  const searchQueue = new TaskQueue(concurrency.search || 4);
  const pageQueue = new TaskQueue(concurrency.pages || 3);
  const downloadQueue = new TaskQueue(concurrency.downloads || 3);
  const visionQueue = new TaskQueue(concurrency.vision || 3);
  const deduper = new ImageDeduper();
  deduper.seed(existingImages);
  const provisionalPool = new Map();
  const rememberProvisional = (slotId, item) => {
    const entries = provisionalPool.get(slotId) || [];
    if (!entries.some((entry) => entry.candidate.candidateId === item.candidate.candidateId)) entries.push(item);
    provisionalPool.set(slotId, entries);
  };
  let dedupeTail = Promise.resolve();
  const withDedupeLock = (candidate) => { const operation = dedupeTail.then(() => deduper.accept(candidate)); dedupeTail = operation.catch(() => undefined); return operation; };
  const resolvedSourceMode = normalizeImageSourceMode(sourceMode);
  const timingsMs = { knowledgeSearch: 0, searchProvider: 0, commons: 0, pageExtraction: 0, download: 0, previewAudit: 0, originalDownload: 0, batchVision: 0, topConfirmation: 0 };
  const metrics = { businessBatches: 1, automaticFollowupRounds: 0, sourceMode: resolvedSourceMode, slotCount: Array.isArray(slots) ? slots.length : 0, knowledgeCalls: 0, knowledgeLogicalQueries: 0, knowledgeActualRequests: 0, knowledgeQueryReused: 0, knowledgeQueryInFlightReused: 0, knowledgeCompleted: 0, knowledgeNotFound: 0, knowledgeNeedsClarification: 0, knowledgeClarificationRetries: 0, knowledgeClarificationResolved: 0, knowledgeScopeResolved: 0, knowledgeScopeUnresolved: 0, knowledgeFailed: 0, knowledgeTimeouts: 0, knowledgeCandidates: 0, knowledgeUniqueCandidates: 0, knowledgeMergedDuplicates: 0, knowledgeSourcePathRejected: 0, knowledgeFirstWebFallbacks: 0, previewReturned: 0, previewUnique: 0, previewAudited: 0, previewFetchAttempts: 0, matchedFileDownloadAttempts: 0, matchedFileDownloadSuccess: 0, originalDownloadSavedCount: 0, previewAuditTimeMs: 0, originalDownloadTimeMs: 0, searchCalls: 0, commonsCalls: 0, pageExtractionCalls: 0, downloadAttempts: 0, batchVisionCalls: 0, topConfirmationCalls: 0, technicalRetries: { search: 0, pageExtraction: 0, download: 0 }, timingsMs, timingsSemantics: "各阶段所有并发操作耗时累计；阶段间存在重叠，不应相加作为总耗时" };
  metrics.technicalRetries.vision = 0;
  // These maps belong only to this invocation. Never cache slot semantics or judgments.
  const pageCache = new Map();
  const downloadCache = new Map();
  const knowledgeQueryCache = new Map();
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
  const knowledgeQueryKey = ({ queryText, scopeNodeIds }) => buildKnowledgeQueryCacheKey({ source: knowledgeBaseUrl, accessIdentity: knowledgeAccessIdentity, scopeNodeIds, query: queryText, topK: knowledgeTopK, resultType: "image", options: knowledgeQueryOptions });
  const runKnowledgeQuery = ({ queryText, scopeNodeIds, target }) => {
    metrics.knowledgeLogicalQueries += 1;
    const key = knowledgeQueryKey({ queryText, scopeNodeIds });
    const previous = knowledgeQueryCache.get(key);
    if (previous) {
      metrics.knowledgeQueryReused += 1;
      if (!previous.settled) metrics.knowledgeQueryInFlightReused += 1;
      const reuseState = previous.settled ? "cache" : "in_flight";
      return previous.promise.then((value) => ({ value, reuse: reuseState }));
    }
    const entry = { settled: false };
    entry.promise = searchQueue.add(() => tracked("image_knowledge_search", target, async (recordAttempt) => {
      recordAttempt();
      metrics.knowledgeCalls += 1;
      metrics.knowledgeActualRequests += 1;
      return measure("knowledgeSearch", () => knowledgeFn({ queries: [queryText], baseUrl: knowledgeBaseUrl, topK: knowledgeTopK, scopeNodeIds, options: knowledgeQueryOptions, timeoutMs: knowledgeTimeoutMs, requestTimeoutMs: knowledgeRequestTimeoutMs, pollIntervalMs: knowledgePollIntervalMs, signal }));
    })).then((value) => {
      entry.settled = true;
      if (["failed", "timeout"].includes(String(value?.status || "").toLowerCase()) && knowledgeQueryCache.get(key) === entry) knowledgeQueryCache.delete(key);
      return value;
    }, (error) => {
      if (knowledgeQueryCache.get(key) === entry) knowledgeQueryCache.delete(key);
      throw error;
    });
    knowledgeQueryCache.set(key, entry);
    return entry.promise.then((value) => ({ value, reuse: "none" }));
  };
  const loadPage = (url) => reuse(pageCache, metrics.resourceReuse.pages, url, () => pageQueue.add(() => withOneTechnicalRetry(async () => {
    metrics.pageExtractionCalls += 1;
    metrics.resourceReuse.pages.attempts += 1;
    increment(metrics.resourceReuse.pages.attemptsByUrl, url);
    return measure("pageExtraction", () => (adapters.fetchImagePageContent || fetchImagePageContent)(url, { signal, retrievalSession, onRequest: networkEvent(metrics.resourceReuse.pages) }));
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
    if (slot?.plannerSlotStatus === "unresolved" || slot?.needsUserAction === true) {
      return {
        slotId: slot?.slotId || null,
        status: "needs_user_action",
        selected: null,
        candidates: [],
        queriesUsed: [],
        sourceEvidence: [],
        actualSubject: null,
        matchReason: "Planner单次输出中的当前图片位无法可靠局部修复，已跳过自动搜索并保留到Step4",
        technicalStatus: "planner_slot_unresolved",
        warnings: Array.isArray(slot?.plannerValidationIssues) ? slot.plannerValidationIssues : [],
        constraints: null,
        plannerValidationIssues: slot?.plannerValidationIssues || [],
        durationMs: Date.now() - slotStartedAt,
      };
    }
    const contractErrors = validateImageSlot(slot);
    if (contractErrors.length) return { slotId: slot?.slotId || null, status: "failed", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: null, technicalStatus: "invalid_slot_contract", warnings: contractErrors, constraints: null, durationMs: Date.now() - slotStartedAt };
    const constraints = buildImageConstraints(slot);
    const resolutionPolicy = imageResolutionPolicyForSlot(Number.isInteger(slot.dayCardCount) ? slot : withDayGalleryLayout(slot, slots));
    const resolutionCacheKey = `${resolutionPolicy.minWidth}x${resolutionPolicy.minHeight}`;
    const queriesUsed = buildImageQueries(slot, maxQueriesPerSlot);
    if (slot.userLocked) return { slotId: slot.slotId, status: "needs_user_action", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: "图片位已由用户锁定，未执行自动搜索", technicalStatus: "user_locked", warnings: [], constraints, durationMs: Date.now() - slotStartedAt };
    const warnings = [];
    const pipelineEvidence = layerEvidence();
    const recordContractRepair = (recordAttempt, queryReport) => ({ candidates }) => {
      recordAttempt();
      metrics.batchVisionCalls += 1;
      metrics.technicalRetries.vision += 1;
      pipelineEvidence.auditContractRepairs ||= [];
      pipelineEvidence.auditContractRepairs.push({ candidates });
      if (queryReport) {
        queryReport.visionAudits += candidates.length;
        queryReport.visionBatchSizes.push(candidates.length);
      }
      warnings.push(`视觉判断缺字段，已对 ${candidates.length} 张候选执行一次技术补全`);
    };
    if (!queriesUsed.length) {
      const queryFailure = buildKnowledgeQueryPlan(slot, null, { maxQueries: maxQueriesPerSlot }).validationError;
      pipelineEvidence.knowledgeSearch = { status: "blocked", queryPlan: { queries: [], validationError: queryFailure || null } };
      return { slotId: slot.slotId, status: "needs_user_action", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: queryFailure?.message || "当前图片位无法从Planner主体与动作中形成安全Query，已保留到Step4人工处理", technicalStatus: queryFailure?.code || "query_core_unrecoverable", pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    const visionEnabled = Boolean(visionApiKey && visionBaseUrl && visionModel && process.env.IMAGE_VISUAL_AUDIT !== "off");
    pipelineEvidence.exactMatchSuccess = false;
    pipelineEvidence.controlledFallback = { entered: false, reason: "disabled_by_query_scope_plan", originalExactTarget: null, fallbackTarget: null, fallbackTheme: null, evidence: null };

    async function runKnowledgeSourceLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName, fallbackPlan = null) {
      const attempts = [];
      const recordMap = new Map();
      const candidatePool = new Map();
      const publicCandidates = [];
      const sourceEvidence = new Set();
      const downloadAttempted = new Set();
      const downloadedContent = new Map();
      const sourcePathRejected = new Set();
      const downloadBudget = Math.max(0, Number(downloadsPerSlot) || 0);
      const auditBatchSize = Math.max(1, Math.min(4, Number(visionCandidatesPerSlot) || 4));
      let downloadsUsed = 0;
      let auditBatches = 0;
      let rootResolution = null;
      let clarificationResolution = null;
      let scopeResolution = null;
      let scopePlan = null;
      let childScopeDecision = null;
      let hierarchyLookup = { status: "not_requested", failureCode: null, attempts: 0, technicalRetries: 0 };
      let queryPlan = null;
      let lastResult = null;
      let lastScopeFeedback = null;
      let anyCandidates = false;
      let anyPathValidCandidates = false;
      let anyDownloaded = false;
      let incompleteJudgment = false;
      let outcomeCounted = false;

      const retainCandidates = (items = []) => {
        const merged = mergePublicCandidates(publicCandidates, items);
        publicCandidates.splice(0, publicCandidates.length, ...merged);
      };
      const countOutcome = (kind) => {
        if (outcomeCounted) return;
        outcomeCounted = true;
        if (kind === "completed") metrics.knowledgeCompleted += 1;
        else if (kind === "not_found") metrics.knowledgeNotFound += 1;
        else if (kind === "failed") metrics.knowledgeFailed += 1;
      };
      const candidateRecord = (candidate) => recordMap.get(candidate?.knowledgeAssetKey);
      const pathDecisionFor = (candidate) => candidate.knowledgeSourcePathMode === "entity_probe" ? knowledgeEntityProbeEvidence(layerSlot, candidate) : candidate.knowledgeSourcePathMode === "transport_root_context" ? knowledgeTransportRootPathEvidence(candidate) : knowledgeSourcePathMatches(candidate.knowledgeEvidenceResolution, candidate.knowledgeSourcePaths, {
        mode: candidate.knowledgeSourcePathMode,
        identityAnchors: candidate.knowledgeIdentityAnchors,
      });
      const upsertCandidate = (candidate, rawRecord, provenance) => {
        const assetKey = knowledgeAssetIdentity(candidate);
        if (!assetKey) return null;
        const previous = candidatePool.get(assetKey);
        const merged = mergeKnowledgeCandidate(previous, {
          ...candidate,
          knowledgeFragmentContent: candidate.knowledgeFragmentContent || rawRecord?.fragmentContent || "",
          knowledgeSourcePaths: unique([...(candidate.knowledgeSourcePaths || []), ...(rawRecord?.sourcePaths || [])]),
          knowledgeMimeType: candidate.knowledgeMimeType || rawRecord?.mimeType || null,
          knowledgeAssetKey: assetKey,
          knowledgeEvidenceResolution: provenance.evidenceResolution,
          knowledgeScopeResolution: provenance.scopeResolution,
          knowledgeSourcePathMode: provenance.sourcePathMode,
          knowledgeIdentityAnchors: provenance.identityAnchors || [],
          knowledgeScopePath: provenance.scopeResolution?.fullPath || null,
          knowledgeScopeNodeIds: [...(provenance.scopeResolution?.nodeIds || [])],
        }, { queryText: provenance.queryText, queryId: provenance.queryId, recordId: rawRecord?.recordId });
        candidatePool.set(assetKey, merged);
        if (previous) metrics.knowledgeMergedDuplicates += 1;
        else metrics.knowledgeUniqueCandidates += 1;
        const priorRecord = recordMap.get(assetKey);
        recordMap.set(assetKey, {
          ...(priorRecord || rawRecord || {}),
          recordId: priorRecord?.recordId || rawRecord?.recordId || merged.knowledgeRecordId || assetKey,
          assetId: priorRecord?.assetId || rawRecord?.assetId || merged.knowledgeAssetId || null,
          assetKey,
          recordIds: unique([...(priorRecord?.recordIds || []), rawRecord?.recordId, candidate.knowledgeRecordId]),
          queryIds: unique([...(priorRecord?.queryIds || []), provenance.queryId]),
          queryTexts: unique([...(priorRecord?.queryTexts || []), provenance.queryText]),
          sourcePaths: unique([...(priorRecord?.sourcePaths || []), ...(rawRecord?.sourcePaths || []), ...(merged.knowledgeSourcePaths || [])]),
          downloadStatus: priorRecord?.downloadStatus || "pending",
          judgmentStatus: priorRecord?.judgmentStatus || "pending",
          selected: priorRecord?.selected || false,
          failureReason: priorRecord?.failureReason || null,
        });
        return merged;
      };
      const markUnprocessed = (reason) => {
        for (const candidate of candidatePool.values()) {
          if (downloadAttempted.has(candidate.knowledgeAssetKey)) continue;
          const decision = pathDecisionFor(candidate);
          if (decision.match === false) continue;
          const record = candidateRecord(candidate);
          if (record) {
            record.downloadStatus = "skipped";
            record.judgmentStatus = "not_evaluated";
            record.failureReason = reason;
          }
        }
      };
      const syncEvidence = (status = lastResult?.status || "completed", failureReason = null) => {
        evidence.knowledgeSearch = {
          source: "knowledge_library",
          mode: resolvedSourceMode,
          slot: { slotId: layerSlot.slotId || slot.slotId, label: layerSlot.label || layerSlot.subject || null, moduleType: layerSlot.moduleType || null, dayNumber: layerSlot.dayNumber || null },
          searchIntent: Array.isArray(layerSlot.searchIntent) ? layerSlot.searchIntent : [layerSlot.searchIntent].filter(Boolean),
          webQueries: layerQueries,
          queryText: lastResult?.queryText || attempts.at(-1)?.queryText || "",
          queryPlan: queryPlan || { queries: [], strategy: "single_business_batch_finite_expressions", sharedScopeNodeIds: [] },
          hierarchyLookup,
          scope: lastResult?.scope ?? (scopeResolution?.nodeIds?.length ? { node_ids: scopeResolution.nodeIds } : null),
          rootScopeResolution: rootResolution ? { status: rootResolution.status, nodeIds: rootResolution.nodeIds || [], fullPath: rootResolution.fullPath || null, reason: rootResolution.reason || null } : null,
          clarificationScopeResolution: clarificationResolution ? { status: clarificationResolution.status, nodeIds: clarificationResolution.nodeIds || [], fullPath: clarificationResolution.fullPath || null, reason: clarificationResolution.reason || null } : null,
          scopeResolution: scopeResolution ? { status: scopeResolution.status, nodeIds: scopeResolution.nodeIds || [], fullPath: scopeResolution.fullPath || null, reason: scopeResolution.reason || null } : null,
          scopePlan: scopePlan ? {
            purpose: scopePlan.purpose,
            strategy: scopePlan.strategy,
            stopBoundary: scopePlan.stopBoundary,
            scopes: scopePlan.scopes.map((item) => ({ role: item.role, nodeIds: item.resolution?.nodeIds || [], fullPath: item.resolution?.fullPath || null, sourcePathMode: item.sourcePathMode || null, identityAnchors: item.identityAnchors || [] })),
          } : null,
          childScopeDecision,
          queryId: lastResult?.queryId || attempts.at(-1)?.queryId || null,
          status,
          scopeState: lastResult ? lastResult.scopeState || null : lastScopeFeedback?.scopeState || null,
          message: lastResult ? lastResult.message || null : lastScopeFeedback?.message || null,
          durationMs: attempts.reduce((sum, attempt) => sum + Number(attempt.durationMs || 0), 0),
          candidateCount: recordMap.size,
          mergedDuplicateCount: [...recordMap.values()].reduce((sum, record) => sum + Math.max(0, (record.recordIds?.length || 1) - 1), 0),
          downloadBudget: { limit: downloadBudget, used: downloadsUsed, remaining: Math.max(0, downloadBudget - downloadsUsed) },
          auditBatches,
          unprocessedCandidateCount: [...recordMap.values()].filter((record) => record.judgmentStatus === "not_evaluated").length,
          clarificationNodeIds: lastResult?.clarificationNodeIds || [],
          failureReason,
          attempts,
          sourcePathRejectedCount: [...recordMap.values()].filter((record) => record.failureReason === "knowledge_source_path_mismatch").length,
          candidates: [...recordMap.values()],
        };
      };
      const invoke = async (queryText, currentScope, suffix = "") => runKnowledgeQuery({
        queryText,
        scopeNodeIds: [...(currentScope?.nodeIds || [])],
        target: `${slot.slotId}:${layerName}${suffix}`,
      });
      const pendingCandidates = () => [...candidatePool.values()]
        .filter((candidate) => !downloadAttempted.has(candidate.knowledgeAssetKey) && pathDecisionFor(candidate).match !== false)
        .sort((left, right) => knowledgeCandidateRankScore(right, layerSlot) - knowledgeCandidateRankScore(left, layerSlot));

      const evaluatePending = async ({ force = false, scopeIndex = 0, queryIndex = 0 } = {}) => {
        const remainingBudget = Math.max(0, downloadBudget - downloadsUsed);
        if (!remainingBudget) return { kind: "budget_exhausted" };
        const pending = pendingCandidates();
        if (!pending.length) return { kind: "need_more" };
        const currentBatchSize = Math.min(auditBatchSize, remainingBudget);
        const hasLowCostEvidence = pending.some((candidate) => knowledgeCandidateLexicalScore(candidate, layerSlot) > 0);
        if (!force && (pending.length < currentBatchSize || !hasLowCostEvidence)) return { kind: "need_more" };
        const downloadBatch = pending.slice(0, currentBatchSize);
        downloadsUsed += downloadBatch.length;
        downloadBatch.forEach((candidate) => downloadAttempted.add(candidate.knowledgeAssetKey));
        const downloadedResults = await Promise.all(downloadBatch.map(async (candidate) => {
          const record = candidateRecord(candidate);
          try {
            const technical = await reuse(downloadCache, metrics.resourceReuse.images, `${candidate.imageUrl}:${resolutionCacheKey}`, () => downloadQueue.add(() => withOneTechnicalRetry(async () => {
              metrics.downloadAttempts += 1;
              evidence.downloadAttempts += 1;
              metrics.resourceReuse.images.attempts += 1;
              increment(metrics.resourceReuse.images.attemptsByUrl, candidate.knowledgeAssetKey || candidate.imageUrl);
              const result = await measure("download", () => downloadFn(candidate, { directory: assetDirectory, publicPrefix, signal, retrievalSession, ...resolutionPolicy, onRequest: () => { metrics.resourceReuse.images.networkRequests += 1; increment(metrics.resourceReuse.images.networkRequestsByUrl, candidate.knowledgeAssetKey || candidate.imageUrl); }, trustedKnowledgeOrigins }));
              return Object.fromEntries(["filePath", "publicUrl", "sha256", "width", "height", "bytes", "contentType", "sourceContentType", "sourceFormat", "sourceBytes", "conversion", "downloadedImageUrl", "downloadVariantAttempts", "acquisitionMethod"].map((key) => [key, result[key]]));
            }, () => { metrics.technicalRetries.download += 1; })));
            if (record) record.downloadStatus = "success";
            return { ...candidate, ...technical };
          } catch (error) {
            const layer = failureLayer(error);
            evidence.downloadFailures.push({ imageUrl: candidate.knowledgeAssetKey || candidate.knowledgeRecordId || candidate.imageUrl, layer, reason: error?.message || String(error) });
            if (record) { record.downloadStatus = "failed"; record.failureReason = error?.message || String(error); }
            return null;
          }
        }));
        const downloaded = [];
        for (const item of downloadedResults.filter((candidate) => candidate?.filePath && candidate?.sha256)) {
          const record = candidateRecord(item);
          if (downloadedContent.has(item.sha256)) {
            if (record) { record.judgmentStatus = "skipped_duplicate_content"; record.failureReason = "duplicate_candidate_content"; }
            continue;
          }
          const prepared = { ...item, candidateId: stableCandidateId(slot.slotId, item) };
          downloadedContent.set(item.sha256, prepared);
          downloaded.push(prepared);
        }
        downloaded.sort((left, right) => knowledgeCandidateRankScore(right, layerSlot) - knowledgeCandidateRankScore(left, layerSlot));
        evidence.downloadedCandidates += downloaded.length;
        anyDownloaded ||= downloaded.length > 0;
        if (!downloaded.length) return { kind: "continue" };
        retainCandidates(downloaded.map((candidate) => publicCandidate(candidate, null, "not_auto_selected")));
        if (!visionEnabled) {
          for (const candidate of downloaded) { const record = candidateRecord(candidate); if (record) record.judgmentStatus = "visual_unavailable"; }
          return { kind: "terminal", result: { kind: "visual_unavailable", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: "visual_judgment_unavailable" } };
        }
        let judgments;
        try {
          auditBatches += 1;
          const representative = downloaded.find((candidate) => candidate.knowledgeSourcePathMode === "transport_root_context") || downloaded[0];
          const representativeMode = representative.knowledgeSourcePathMode;
          const visualTarget = buildKnowledgeVisualTarget(layerSlot);
          const auditSlot = {
            ...layerSlot,
            ...layerConstraints,
            ...visualTarget,
            subject: visualTarget.coreVisualTarget,
            visualGoal: `${visualTarget.visualDuty}；查询可放宽非核心载体或细节，但审核必须保留核心视觉结果${visualTarget.representativeAllowed ? "，可在不误导事实时判为 representative" : "，不得用代表性氛围替代身份或类型证据"}`,
            location: layerSlot.locationRole === "visual_identity" ? layerSlot.location : knowledgeCandidateContextLocation(representative, layerSlot.location),
            originalLocation: layerSlot.location || null,
            knowledgeSourcePathMode: representativeMode,
            knowledgeImagePurpose: classifyKnowledgeImagePurpose(layerSlot),
            label: text(layerSlot.subject) || slot.slotId,
            context: contextText(layerSlot.visualContext),
            module: layerSlot.moduleType,
          };
          judgments = await visionQueue.add(() => tracked("visual_judgment", `${slot.slotId}:${layerName}:scope-${scopeIndex + 1}:query-${queryIndex + 1}:batch-${auditBatches}`, async (recordAttempt) => withOneTechnicalRetry(async (attempt) => {
            recordAttempt();
            metrics.batchVisionCalls += 1;
            return measure("batchVision", () => judgeFn({ slot: auditSlot, candidates: downloaded.map(knowledgeEntityProbeAuditCandidate), apiKey: visionApiKey, baseUrl: visionBaseUrl, model: visionModel, signal, allowContractRepair: attempt === 1, onContractRepair: recordContractRepair(recordAttempt) }));
          }, (error) => { metrics.technicalRetries.vision += 1; warnings.push(`${layerName} 视觉判断技术重试：${error?.message || error}`); })));
        } catch (error) {
          const reviewStatus = error?.code === "audit_timeout" ? "review_timeout" : "not_auto_selected";
          for (const candidate of downloaded) {
            const record = candidateRecord(candidate);
            if (record) { record.judgmentStatus = "visual_failed"; record.failureReason = error?.message || String(error); }
          }
          retainCandidates(downloaded.map((candidate) => publicCandidate(candidate, null, reviewStatus)));
          return { kind: "terminal", result: { kind: "visual_failed", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: "visual_judgment_failed" } };
        }
        evidence.visualJudgmentCompleted = true;
        const candidateById = new Map(downloaded.map((candidate) => [candidate.candidateId, candidate]));
        const returnedIds = new Set();
        const judged = [];
        for (const audit of Array.isArray(judgments) ? judgments : []) {
          const candidate = candidateById.get(audit?.candidateId);
          if (!candidate) continue;
          returnedIds.add(candidate.candidateId);
          const pathDecision = pathDecisionFor(candidate);
          const effectiveAudit = applyKnowledgeSourcePathEvidence(layerSlot, audit, pathDecision);
          const record = candidateRecord(candidate);
          if (!completeVisualJudgment(effectiveAudit)) {
            incompleteJudgment = true;
            if (record) record.judgmentStatus = "needs_user_judgment";
            judged.push({ candidate, audit: effectiveAudit, rejection: "needs_user_judgment" });
            continue;
          }
          const gateSlot = knowledgeCandidateGateSlot(layerSlot, candidate);
          const hardRejection = failedHardRequirement(gateSlot, effectiveAudit, candidate);
          const fallbackRejection = fallbackPlan ? controlledFallbackRejection(fallbackPlan, effectiveAudit) : null;
          const rejection = hardRejection || fallbackRejection;
          if (!fallbackRejection && pathDecision.match !== false && provisionalIdentityOnly(gateSlot, effectiveAudit, candidate, hardRejection)) {
            rememberProvisional(slot.slotId, { candidate: { ...candidate, originalDownloaded: true }, audit: effectiveAudit, resolutionPolicy, sourceKind: "knowledge_library", remainingOriginalBudget: () => Math.max(0, downloadBudget - downloadsUsed) });
          }
          const qualifiedAudit = finalizeAuditEligibility(effectiveAudit, rejection);
          if (rejection) {
            if (rejection === "needs_user_judgment") incompleteJudgment = true;
            if (record) { record.judgmentStatus = rejection === "needs_user_judgment" ? "needs_user_judgment" : "rejected"; record.failureReason = rejection; }
            judged.push({ candidate, audit: qualifiedAudit, rejection });
            continue;
          }
          if (record) { record.judgmentStatus = "approved_not_selected"; record.failureReason = null; }
          judged.push({ candidate, audit: qualifiedAudit, rejection: null });
        }
        for (const candidate of downloaded) if (!returnedIds.has(candidate.candidateId)) {
          incompleteJudgment = true;
          const record = candidateRecord(candidate);
          if (record) record.judgmentStatus = "needs_user_judgment";
          judged.push({ candidate, audit: null, rejection: "needs_user_judgment" });
        }
        const eligible = judged.filter((item) => !item.rejection)
          .sort((left, right) => auditQualityScore(right.audit, right.candidate, layerSlot) - auditQualityScore(left.audit, left.candidate, layerSlot));
        let selectedEntry = null;
        let selectedDuplicate = null;
        for (const entry of eligible) {
          const duplicate = await withDedupeLock(entry.candidate);
          if (duplicate.accepted) {
            selectedEntry = entry;
            selectedDuplicate = duplicate;
            break;
          }
          entry.rejection = duplicate.reason;
          const record = candidateRecord(entry.candidate);
          if (record) { record.judgmentStatus = "rejected"; record.failureReason = duplicate.reason; }
        }
        for (const entry of judged) {
          if (entry === selectedEntry) {
            retainCandidates([{ ...publicCandidate(entry.candidate, entry.audit, null), autoReviewStatus: "auto_selected", selected: true, notAutoSelected: false, manualOnly: false }]);
          } else if (entry.rejection) {
            retainCandidates([publicCandidate(entry.candidate, entry.audit, entry.rejection)]);
          } else {
            retainCandidates([{ ...publicCandidate(entry.candidate, entry.audit, null), autoReviewStatus: "not_auto_selected", selected: false, notAutoSelected: true, manualOnly: false }]);
          }
        }
        if (selectedEntry) {
          const record = candidateRecord(selectedEntry.candidate);
          if (record) { record.judgmentStatus = "approved"; record.selected = true; }
          markUnprocessed("not_processed_after_selected");
          countOutcome("completed");
          syncEvidence("completed");
          return {
            kind: "success",
            result: {
              kind: "success",
              selected: { ...publicCandidate(selectedEntry.candidate, selectedEntry.audit), autoReviewStatus: "auto_selected", selected: true, dHash: selectedDuplicate.dHash, aspectRatio: slot.aspectRatio },
              candidates: publicCandidates,
              sourceEvidence: [...sourceEvidence],
              actualSubject: selectedEntry.audit.actualSubject,
              matchReason: selectedEntry.audit.reason || "事实匹配并完成真实视觉判断",
              technicalStatus: "downloaded_decoded_and_judged",
            },
          };
        }
        return { kind: downloadsUsed >= downloadBudget ? "budget_exhausted" : "continue" };
      };
      const drainPendingWithinBudget = async ({ scopeIndex = 0, queryIndex = 0 } = {}) => {
        while (downloadsUsed < downloadBudget) {
          const downloadsBefore = downloadsUsed;
          const evaluated = await evaluatePending({ force: true, scopeIndex, queryIndex });
          if (["success", "terminal", "budget_exhausted"].includes(evaluated.kind)) return evaluated;
          if (evaluated.kind === "need_more" || downloadsUsed === downloadsBefore) return evaluated;
        }
        return { kind: "budget_exhausted" };
      };

      try {
        if (knowledgeScopeNodeIds.length) {
          hierarchyLookup = { status: "bypassed_configured_scope", failureCode: null, attempts: 0, technicalRetries: 0 };
          scopeResolution = { status: "resolved", nodeIds: knowledgeScopeNodeIds.map(String), node: null, fullPath: null, reason: "configured_scope" };
        } else if (adapters.searchKnowledgeImages && !adapters.loadKnowledgeHierarchy) {
          hierarchyLookup = { status: "bypassed_test_adapter", failureCode: null, attempts: 0, technicalRetries: 0 };
          scopeResolution = { status: "unresolved", nodeIds: [], node: null, fullPath: null, reason: "test_adapter_without_hierarchy" };
        } else {
          try {
            scopeResolution = await knowledgeScopeResolver.resolve(layerSlot);
            const stats = knowledgeScopeResolver.hierarchyStats();
            hierarchyLookup = { status: "loaded", failureCode: null, attempts: stats.attempts, technicalRetries: stats.technicalRetries };
          } catch (error) {
            const stats = knowledgeScopeResolver.hierarchyStats();
            const cancelled = signal?.aborted === true;
            const timeout = !cancelled && (error?.name === "AbortError" || /timeout/i.test(String(error?.code || "")));
            hierarchyLookup = {
              status: cancelled ? "cancelled" : timeout ? "timeout" : "failed",
              failureCode: diagnosticCode(error?.code) || diagnosticCode(stats.failureCode) || (cancelled ? "cancelled" : timeout ? "knowledge_hierarchy_timeout" : "knowledge_hierarchy_failed"),
              attempts: stats.attempts,
              technicalRetries: stats.technicalRetries,
            };
            throw error;
          }
        }
        rootResolution = scopeResolution;
        if (scopeResolution.status === "resolved") metrics.knowledgeScopeResolved += 1;
        else metrics.knowledgeScopeUnresolved += 1;
        if (scopeResolution.status === "resolved" && scopeResolution.node && scopeResolution.reason !== "test_adapter_without_hierarchy") {
          scopePlan = await knowledgeScopeResolver.plan(layerSlot, scopeResolution);
          childScopeDecision = scopePlan.childScopeDecision;
        } else {
          childScopeDecision = { entered: false, category: null, availableChildren: [], matchingChildren: [], reason: "resolved_hierarchy_node_unavailable" };
          scopePlan = buildKnowledgeScopePlan(layerSlot, scopeResolution, null);
        }
        const emptyScopeBlocked = scopeResolution.status === "unresolved"
          && scopeResolution.reason !== "test_adapter_without_hierarchy"
          && !knowledgeScopeNodeIds.length;
        const scopePlanBlocked = Boolean(scopePlan.blockedReason)
          && scopeResolution.status !== "ambiguous"
          && scopeResolution.reason !== "test_adapter_without_hierarchy";
        if (scopePlanBlocked || emptyScopeBlocked) {
          const hotelScopeBlocked = scopePlanBlocked;
          lastResult = { status: "completed", queryId: null, queryText: "", scope: null, durationMs: 0, records: [], candidates: [], message: hotelScopeBlocked ? "酒店目录及地区/国家兜底Scope均未解析，未向知识库发出空Scope请求" : "知识库Scope未解析，未向知识库发出空Scope请求" };
          countOutcome("not_found");
          syncEvidence("completed", scopePlan.blockedReason || "knowledge_scope_unresolved");
          return { kind: "inconclusive", candidates: [], sourceEvidence: [], actualSubject: null, matchReason: lastResult.message, technicalStatus: hotelScopeBlocked ? "knowledge_hotel_scope_unresolved" : "knowledge_scope_unresolved" };
        }
        const plannedScopes = scopePlan.scopes.length ? scopePlan.scopes : [{ role: "unresolved", resolution: scopeResolution, evidenceResolution: scopeResolution }];
        scopeResolution = plannedScopes[0].resolution;
        queryPlan = { ...buildKnowledgeQueryPlan(layerSlot, null, { maxQueries: knowledgeQueriesPerSlot }), byScope: [] };
        queryPlan.scopePlan = scopePlan.scopes.map((item) => ({ role: item.role, nodeIds: item.resolution?.nodeIds || [], fullPath: item.resolution?.fullPath || null, sourcePathMode: item.sourcePathMode || null, identityAnchors: item.identityAnchors || [] }));
        if (queryPlan.validationError) {
          lastResult = { status: "blocked", queryId: null, queryText: "", scope: null, durationMs: 0, records: [], candidates: [], message: queryPlan.validationError.message };
          countOutcome("not_found");
          syncEvidence("blocked", queryPlan.validationError.code);
          return { kind: "inconclusive", candidates: [], sourceEvidence: [], actualSubject: null, matchReason: queryPlan.validationError.message, technicalStatus: queryPlan.validationError.code };
        }
        if (!queryPlan.queries.length && layerQueries[0]) queryPlan.queries.push(layerQueries[0]);
        if (scopeResolution.status === "ambiguous" && scopeResolution.candidates?.length) {
          metrics.knowledgeNeedsClarification += 1;
          lastResult = { status: "needs_clarification", queryId: null, queryText: queryPlan.queries[0] || "", scope: null, durationMs: 0, clarificationNodeIds: scopeResolution.candidates.map((candidate) => candidate.nodeId), records: [], candidates: [] };
          syncEvidence("needs_clarification");
          return { kind: "knowledge_needs_clarification", candidates: [], sourceEvidence: [], actualSubject: null, technicalStatus: "knowledge_needs_clarification" };
        }
        let clarificationUsed = false;
        let stopForBudget = false;
        for (let scopeIndex = 0; scopeIndex < plannedScopes.length && !stopForBudget; scopeIndex += 1) {
          const plannedScope = plannedScopes[scopeIndex];
          scopeResolution = plannedScope.resolution;
          queryPlan.sharedScopeNodeIds = [...(scopeResolution.nodeIds || [])];
          const scopedPlan = applyKnowledgeScopeToQueryPlan(queryPlan, layerSlot, scopeResolution);
          if (scopedPlan.validationError) {
            lastResult = { status: "blocked", queryId: null, queryText: "", scope: scopeResolution.fullPath || null, durationMs: 0, records: [], candidates: [], message: scopedPlan.validationError.message };
            countOutcome("not_found");
            syncEvidence("blocked", scopedPlan.validationError.code);
            return { kind: "inconclusive", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, matchReason: scopedPlan.validationError.message, technicalStatus: scopedPlan.validationError.code };
          }
          const scopedQueries = scopedPlan.queries;
          queryPlan.byScope.push({ role: plannedScope.role, nodeIds: [...(scopeResolution.nodeIds || [])], fullPath: scopeResolution.fullPath || null, queries: [...scopedQueries] });
          let scopeCannotSearch = false;
          for (let queryIndex = 0; queryIndex < scopedQueries.length; queryIndex += 1) {
            const queryText = scopedQueries[queryIndex];
            const attemptStartedAt = Date.now();
            let invoked;
            try {
              invoked = await invoke(queryText, scopeResolution, `:scope-${scopeIndex + 1}:query-${queryIndex + 1}`);
              lastResult = invoked.value;
            } catch (error) {
              attempts.push({ queryText, queryId: error?.queryId || null, status: error?.code === "knowledge_timeout" ? "timeout" : "failed", requestReuse: "none", scopeNodeIds: [...(scopeResolution.nodeIds || [])], scopePath: scopeResolution.fullPath || null, startedAt: new Date(attemptStartedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: error?.durationMs ?? Date.now() - attemptStartedAt, candidateCount: 0, diagnosticId: error?.diagnosticId || null, knowledgeStage: error?.knowledgeStage || null, knowledgeFailureKind: error?.knowledgeFailureKind || null, requestId: error?.requestId || null, errorId: error?.errorId || null, httpStatus: error?.status || null, failureReason: error?.message || String(error) });
              if (error?.code === "knowledge_timeout") metrics.knowledgeTimeouts += 1;
              countOutcome("failed");
              syncEvidence(error?.code === "knowledge_timeout" ? "timeout" : "failed", error?.message || String(error));
              warnings.push(`${layerName} 知识库搜索失败：${error?.message || error}`);
              return { kind: "search_failed", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: error?.code === "knowledge_timeout" ? "knowledge_timeout" : "knowledge_failed" };
            }
            if (lastResult?.status === "completed" && !lastResult?.candidates?.length) lastScopeFeedback = lastResult.message ? { scopeState: lastResult.scopeState || null, message: lastResult.message } : null;
            else if (lastResult?.status === "completed") lastScopeFeedback = null;
            attempts.push({ queryText, queryId: lastResult?.queryId || null, status: lastResult?.status || "failed", requestReuse: invoked.reuse, scopeState: lastResult?.scopeState || null, message: lastResult?.message || null, scopeIndex, scopeRole: plannedScope.role, scopeNodeIds: [...(scopeResolution.nodeIds || [])], scopePath: scopeResolution.fullPath || null, scope: lastResult?.scope || null, startedAt: new Date(attemptStartedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: lastResult?.durationMs ?? Date.now() - attemptStartedAt, candidateCount: lastResult?.candidates?.length || 0, diagnosticId: lastResult?.diagnosticId || null, knowledgeStage: lastResult?.knowledgeStage || null, knowledgeFailureKind: lastResult?.knowledgeFailureKind || null, requestId: lastResult?.requestId || null, errorId: lastResult?.errorId || null });
            if (lastResult?.status === "needs_clarification") {
              metrics.knowledgeNeedsClarification += 1;
              if (plannedScope.role !== "entity_parent_probe" && !clarificationUsed && lastResult.clarificationNodeIds?.length && scopeResolution.reason !== "test_adapter_without_hierarchy") {
                clarificationUsed = true;
                clarificationResolution = await knowledgeScopeResolver.clarify(layerSlot, lastResult.clarificationNodeIds);
                if (clarificationResolution.status === "resolved") {
                  metrics.knowledgeClarificationRetries += 1;
                  const refined = await knowledgeScopeResolver.refine(layerSlot, clarificationResolution);
                  scopeResolution = refined.scopeResolution;
                  childScopeDecision = refined.decision;
                  queryPlan.sharedScopeNodeIds = [...(scopeResolution.nodeIds || [])];
                  const correctedStartedAt = Date.now();
                  const corrected = await invoke(queryText, scopeResolution, `:query-${queryIndex + 1}:clarification`);
                  lastResult = corrected.value;
                  attempts.push({ queryText, queryId: lastResult?.queryId || null, status: lastResult?.status || "failed", requestReuse: corrected.reuse, scopeState: lastResult?.scopeState || null, message: lastResult?.message || null, scopeNodeIds: [...(scopeResolution.nodeIds || [])], scopePath: scopeResolution.fullPath || null, scope: lastResult?.scope || null, startedAt: new Date(correctedStartedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: lastResult?.durationMs ?? Date.now() - correctedStartedAt, candidateCount: lastResult?.candidates?.length || 0, diagnosticId: lastResult?.diagnosticId || null, knowledgeStage: lastResult?.knowledgeStage || null, knowledgeFailureKind: lastResult?.knowledgeFailureKind || null, requestId: lastResult?.requestId || null, errorId: lastResult?.errorId || null, clarificationCorrection: true });
                  if (lastResult?.status !== "needs_clarification") metrics.knowledgeClarificationResolved += 1;
                }
              }
            }
            syncEvidence(lastResult?.status || "failed");
            if (lastResult?.status === "needs_clarification") return { kind: "knowledge_needs_clarification", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: "knowledge_needs_clarification" };
            if (lastResult?.status !== "completed") {
              countOutcome("failed");
              return { kind: "search_failed", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: "knowledge_failed" };
            }
            evidence.searchCompleted = true;
            if (!lastResult?.candidates?.length && ["empty", "unavailable"].includes(lastResult?.scopeState)) {
              scopeCannotSearch = true;
              const evaluated = await drainPendingWithinBudget({ scopeIndex, queryIndex });
              if (evaluated.kind === "success" || evaluated.kind === "terminal") return evaluated.result;
              if (evaluated.kind === "budget_exhausted") stopForBudget = true;
              syncEvidence("completed");
              break;
            }
            const rawRecords = new Map((lastResult?.records || []).map((record) => [record.recordId, record]));
            const raw = (lastResult?.candidates || []).filter((candidate) => candidate?.imageUrl);
            metrics.knowledgeCandidates += raw.length;
            evidence.extractedCandidates += raw.length;
            evidence.semanticExtractionCompleted = true;
            anyCandidates ||= raw.length > 0;
            for (const candidate of raw) {
              if (candidate.pageUrl) sourceEvidence.add(candidate.pageUrl);
              const merged = upsertCandidate(candidate, rawRecords.get(candidate.knowledgeRecordId), {
                queryText,
                queryId: lastResult.queryId,
                scopeResolution,
                evidenceResolution: plannedScope.evidenceResolution || scopeResolution,
                sourcePathMode: plannedScope.sourcePathMode,
                identityAnchors: plannedScope.identityAnchors,
              });
              if (!merged) continue;
              const decision = pathDecisionFor(merged);
              const record = candidateRecord(merged);
              if (decision.match === false) {
                if (!sourcePathRejected.has(merged.knowledgeAssetKey)) {
                  sourcePathRejected.add(merged.knowledgeAssetKey);
                  metrics.knowledgeSourcePathRejected += 1;
                }
                if (record) { record.downloadStatus = "skipped"; record.judgmentStatus = "rejected"; record.failureReason = decision.reason; }
              } else {
                anyPathValidCandidates = true;
                if (record?.failureReason === "knowledge_source_path_mismatch") { record.downloadStatus = "pending"; record.judgmentStatus = "pending"; record.failureReason = null; }
              }
            }
            const forceEvaluation = queryIndex === scopedQueries.length - 1;
            const evaluated = forceEvaluation
              ? await drainPendingWithinBudget({ scopeIndex, queryIndex })
              : await evaluatePending({ force: false, scopeIndex, queryIndex });
            if (evaluated.kind === "success" || evaluated.kind === "terminal") return evaluated.result;
            if (evaluated.kind === "budget_exhausted") { stopForBudget = true; break; }
          }
          if (!scopeCannotSearch && !stopForBudget) {
            const evaluated = await drainPendingWithinBudget({ scopeIndex, queryIndex: Math.max(0, scopedQueries.length - 1) });
            if (evaluated.kind === "success" || evaluated.kind === "terminal") return evaluated.result;
            if (evaluated.kind === "budget_exhausted") stopForBudget = true;
          }
        }
        if (stopForBudget) markUnprocessed("download_budget_exhausted");
        countOutcome(anyCandidates ? "completed" : "not_found");
        syncEvidence("completed");
        const terminalScopeStatus = lastScopeFeedback?.scopeState === "empty"
          ? "knowledge_scope_empty"
          : lastScopeFeedback?.scopeState === "unavailable"
            ? "knowledge_scope_unavailable"
            : null;
        const downloadLayers = evidence.downloadFailures.map((item) => item.layer);
        const technicalStatus = !anyCandidates ? terminalScopeStatus || "knowledge_not_found"
          : !anyPathValidCandidates ? "knowledge_no_valid_candidate"
            : !anyDownloaded && stopForBudget ? "candidate_download_budget_exhausted"
              : !anyDownloaded && downloadLayers.length && downloadLayers.every((layer) => layer === "oversized_original") ? "candidate_oversized_original"
                : !anyDownloaded ? "candidate_download_failed"
                  : incompleteJudgment ? "visual_judgment_inconclusive" : "no_eligible_candidate";
        const kind = incompleteJudgment ? "inconclusive" : anyDownloaded ? "no_eligible" : "no_candidate";
        return { kind, candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: publicCandidates.find((item) => item.actualSubject)?.actualSubject || null, matchReason: incompleteJudgment ? "批量视觉判断存在缺项或矛盾，未默认采用" : anyDownloaded ? `${layerName} 候选均有明确事实、技术或重复问题` : lastScopeFeedback?.message || null, technicalStatus };
      } catch (error) {
        if (error?.code === "knowledge_timeout") metrics.knowledgeTimeouts += 1;
        countOutcome("failed");
        syncEvidence(error?.code === "knowledge_timeout" ? "timeout" : "failed", error?.message || String(error));
        return { kind: "search_failed", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: error?.code === "knowledge_timeout" ? "knowledge_timeout" : "knowledge_failed" };
      }
    }

    async function runKnowledgePreviewFirstLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName) {
      const hotelKnowledgeModule = String(layerSlot.moduleType || "").trim().toLowerCase() === "hotel";
      const eligibilitySlot = layerSlot;
      const eligibilityConstraints = layerConstraints;
      const attempts = [];
      const recordMap = new Map();
      const candidatePool = new Map();
      const sourceEvidence = new Set();
      const sourcePathRejected = new Set();
      const originalDownloadBudget = Math.max(0, Number(downloadsPerSlot) || 0);
      const initialReviewWaveSize = Math.min(4, Math.max(1, Number(visionCandidatesPerSlot) || 4));
      const auditBatchSize = initialReviewWaveSize;
      let originalDownloadsUsed = 0;
      let auditBatches = 0;
      let previewAudited = 0;
      let rootResolution = null;
      let clarificationResolution = null;
      let scopeResolution = null;
      let scopePlan = null;
      let childScopeDecision = null;
      let hierarchyLookup = { status: "not_requested", failureCode: null, attempts: 0, technicalRetries: 0 };
      let queryPlan = null;
      let lastResult = null;
      let lastScopeFeedback = null;
      let outcomeCounted = false;
      let anyCandidates = false;
      let anyPathValidCandidates = false;
      let earlyStopReason = null;

      const countOutcome = (kind) => {
        if (outcomeCounted) return;
        outcomeCounted = true;
        if (kind === "completed") metrics.knowledgeCompleted += 1;
        else if (kind === "not_found") metrics.knowledgeNotFound += 1;
        else if (kind === "failed") metrics.knowledgeFailed += 1;
      };
      const candidateRecord = (candidate) => recordMap.get(candidate?.knowledgeAssetKey);
      const pathDecisionFor = (candidate) => candidate.knowledgeSourcePathMode === "entity_probe" ? knowledgeEntityProbeEvidence(layerSlot, candidate) : candidate.knowledgeSourcePathMode === "transport_root_context" ? knowledgeTransportRootPathEvidence(candidate) : knowledgeSourcePathMatches(candidate.knowledgeEvidenceResolution, candidate.knowledgeSourcePaths, {
        mode: candidate.knowledgeSourcePathMode,
        identityAnchors: candidate.knowledgeIdentityAnchors,
      });
      const upsertCandidate = (candidate, rawRecord, provenance) => {
        const assetKey = knowledgeAssetIdentity(candidate);
        if (!assetKey) return null;
        const previous = candidatePool.get(assetKey);
        const merged = mergeKnowledgeCandidate(previous, {
          ...candidate,
          knowledgeFragmentContent: candidate.knowledgeFragmentContent || rawRecord?.fragmentContent || "",
          knowledgeSourcePaths: unique([...(candidate.knowledgeSourcePaths || []), ...(rawRecord?.sourcePaths || [])]),
          knowledgeMimeType: candidate.knowledgeMimeType || rawRecord?.mimeType || null,
          knowledgePreview: candidate.knowledgePreview || rawRecord?.preview || null,
          knowledgeMatchedFile: candidate.knowledgeMatchedFile || rawRecord?.matchedFile || null,
          knowledgeAssetKey: assetKey,
          knowledgeEvidenceResolution: provenance.evidenceResolution,
          knowledgeScopeResolution: provenance.scopeResolution,
          knowledgeSourcePathMode: provenance.sourcePathMode,
          knowledgeIdentityAnchors: provenance.identityAnchors || [],
          knowledgeScopePath: provenance.scopeResolution?.fullPath || null,
          knowledgeScopeNodeIds: [...(provenance.scopeResolution?.nodeIds || [])],
        }, { queryText: provenance.queryText, queryId: provenance.queryId, recordId: rawRecord?.recordId });
        candidatePool.set(assetKey, merged);
        if (previous) metrics.knowledgeMergedDuplicates += 1;
        else {
          metrics.knowledgeUniqueCandidates += 1;
          metrics.previewUnique += 1;
        }
        const priorRecord = recordMap.get(assetKey);
        recordMap.set(assetKey, {
          ...(priorRecord || rawRecord || {}),
          recordId: priorRecord?.recordId || rawRecord?.recordId || merged.knowledgeRecordId || assetKey,
          assetId: priorRecord?.assetId || rawRecord?.assetId || merged.knowledgeAssetId || null,
          assetKey,
          recordIds: unique([...(priorRecord?.recordIds || []), rawRecord?.recordId, candidate.knowledgeRecordId]),
          queryIds: unique([...(priorRecord?.queryIds || []), provenance.queryId]),
          queryTexts: unique([...(priorRecord?.queryTexts || []), provenance.queryText]),
          sourcePaths: unique([...(priorRecord?.sourcePaths || []), ...(rawRecord?.sourcePaths || []), ...(merged.knowledgeSourcePaths || [])]),
          preview: merged.knowledgeSourcePathMode === "entity_probe" ? merged.knowledgePreview : priorRecord?.preview || rawRecord?.preview || merged.knowledgePreview || null,
          matchedFile: merged.knowledgeSourcePathMode === "entity_probe" ? merged.knowledgeMatchedFile : priorRecord?.matchedFile || rawRecord?.matchedFile || merged.knowledgeMatchedFile || null,
          previewStatus: priorRecord?.previewStatus || "pending",
          downloadStatus: priorRecord?.downloadStatus || "not_requested",
          judgmentStatus: priorRecord?.judgmentStatus || "pending",
          selected: priorRecord?.selected || false,
          failureReason: priorRecord?.failureReason || null,
        });
        return merged;
      };
      const syncEvidence = (status = lastResult?.status || "completed", failureReason = null) => {
        const records = [...recordMap.values()];
        evidence.knowledgeSearch = {
          source: "knowledge_library",
          mode: resolvedSourceMode,
          pipeline: "preview_first",
          slot: { slotId: layerSlot.slotId || slot.slotId, label: layerSlot.label || layerSlot.subject || null, moduleType: layerSlot.moduleType || null, dayNumber: layerSlot.dayNumber || null },
          searchIntent: Array.isArray(layerSlot.searchIntent) ? layerSlot.searchIntent : [layerSlot.searchIntent].filter(Boolean),
          webQueries: layerQueries,
          queryText: lastResult?.queryText || attempts.at(-1)?.queryText || "",
          queryPlan: queryPlan || { queries: [], strategy: "single_business_batch_finite_expressions", sharedScopeNodeIds: [] },
          hierarchyLookup,
          scope: lastResult?.scope ?? (scopeResolution?.nodeIds?.length ? { node_ids: scopeResolution.nodeIds } : null),
          rootScopeResolution: rootResolution ? { status: rootResolution.status, nodeIds: rootResolution.nodeIds || [], fullPath: rootResolution.fullPath || null, reason: rootResolution.reason || null } : null,
          clarificationScopeResolution: clarificationResolution ? { status: clarificationResolution.status, nodeIds: clarificationResolution.nodeIds || [], fullPath: clarificationResolution.fullPath || null, reason: clarificationResolution.reason || null } : null,
          scopeResolution: scopeResolution ? { status: scopeResolution.status, nodeIds: scopeResolution.nodeIds || [], fullPath: scopeResolution.fullPath || null, reason: scopeResolution.reason || null } : null,
          scopePlan: scopePlan ? {
            purpose: scopePlan.purpose,
            strategy: scopePlan.strategy,
            stopBoundary: scopePlan.stopBoundary,
            blockedReason: scopePlan.blockedReason || null,
            scopes: scopePlan.scopes.map((item) => ({ role: item.role, nodeIds: item.resolution?.nodeIds || [], fullPath: item.resolution?.fullPath || null, sourcePathMode: item.sourcePathMode || null, identityAnchors: item.identityAnchors || [] })),
          } : null,
          childScopeDecision,
          queryId: lastResult?.queryId || attempts.at(-1)?.queryId || null,
          status,
          scopeState: lastResult ? lastResult.scopeState || null : lastScopeFeedback?.scopeState || null,
          message: lastResult ? lastResult.message || null : lastScopeFeedback?.message || null,
          durationMs: attempts.reduce((sum, attempt) => sum + Number(attempt.durationMs || 0), 0),
          candidateCount: recordMap.size,
          previewReturned: attempts.reduce((sum, attempt) => sum + Number(attempt.candidateCount || 0), 0),
          previewUnique: recordMap.size,
          previewAudited,
          autoReviewLimit: initialReviewWaveSize,
          initialReviewWaveSize,
          reviewStrategy: "dynamic_batches_until_strong_or_pool_exhausted",
          earlyStopReason,
          notAutoReviewedCount: records.filter((record) => record.judgmentStatus === "not_auto_reviewed").length,
          matchedFileDownloadAttempts: records.filter((record) => record.downloadStatus !== "not_requested").length,
          matchedFileDownloadSuccess: records.filter((record) => record.downloadStatus === "success").length,
          originalDownloadSavedCount: records.filter((record) => record.selected && record.downloadStatus === "success").length,
          originalDownloadBudget: { limit: originalDownloadBudget, used: originalDownloadsUsed, remaining: Math.max(0, originalDownloadBudget - originalDownloadsUsed) },
          auditBatches,
          clarificationNodeIds: lastResult?.clarificationNodeIds || [],
          failureReason,
          attempts,
          sourcePathRejectedCount: records.filter((record) => record.failureReason === "knowledge_source_path_mismatch").length,
          candidates: records,
        };
      };
      const invoke = async (queryText, currentScope, suffix = "") => runKnowledgeQuery({
        queryText,
        scopeNodeIds: [...(currentScope?.nodeIds || [])],
        target: `${slot.slotId}:${layerName}${suffix}`,
      });
      const previewTechnicalByAsset = new Map();
      const previewFailedAssets = new Set();
      const judgmentsByAsset = new Map();
      const originalAttemptedAssets = new Set();
      const rescuedOriginalByAsset = new Map();
      let originalPreviewRescueAttempted = false;

      const assessCurrentCandidates = async ({ final = false } = {}) => {
        const allCandidates = [...candidatePool.values()]
          .map((candidate) => ({ ...candidate, candidateId: stableCandidateId(slot.slotId, candidate) }))
          .sort((left, right) => knowledgeCandidateRankScore(right, layerSlot) - knowledgeCandidateRankScore(left, layerSlot));
        if (!allCandidates.length) {
          if (!final) return null;
          countOutcome("not_found");
          syncEvidence("completed");
          const technicalStatus = lastScopeFeedback?.scopeState === "empty" ? "knowledge_scope_empty" : lastScopeFeedback?.scopeState === "unavailable" ? "knowledge_scope_unavailable" : "knowledge_not_found";
          return { kind: "no_candidate", candidates: [], sourceEvidence: [...sourceEvidence], actualSubject: null, matchReason: lastScopeFeedback?.message || null, technicalStatus };
        }

        const prepared = [];
        for (const candidate of allCandidates) {
          const record = candidateRecord(candidate);
          const pathDecision = pathDecisionFor(candidate);
          const existingJudgment = judgmentsByAsset.get(candidate.knowledgeAssetKey);
          // A later query may fill this same asset's missing per-image path.
          // Reuse its completed visual decision; shared result text remains
          // excluded by pathDecisionFor and incomplete/failed audits stay manual.
          if (candidate.knowledgeSourcePathMode === "entity_probe" && pathDecision.match !== null
            && /^(?:asset|version|knowledge):/.test(candidate.knowledgeAssetKey)
            && existingJudgment?.rejection === "needs_user_judgment" && completeVisualJudgment(existingJudgment.audit)
            && isIdentityEvidenceUnresolved(existingJudgment.audit)) {
            const effectiveAudit = applyKnowledgeSourcePathEvidence(layerSlot, existingJudgment.audit, pathDecision);
            const rejection = failedHardRequirement(eligibilitySlot, effectiveAudit, candidate);
            const audit = finalizeAuditEligibility(effectiveAudit, rejection);
            judgmentsByAsset.set(candidate.knowledgeAssetKey, { candidate: { ...existingJudgment.candidate, ...candidate }, audit, rejection });
            if (record) {
              record.judgmentStatus = rejection === "needs_user_judgment" ? "needs_user_judgment" : rejection ? "rejected" : audit.matchLevel === "representative" ? "representative" : "approved_not_selected";
              record.failureReason = rejection || null;
            }
          }
          const sourcePathMismatch = pathDecision.match === false;
          const preview = candidate.knowledgePreview || (!candidate.knowledgeMatchedFile && candidate.imageUrl ? { url: candidate.imageUrl, filename: candidate.title, relation: "legacy_preview" } : null);
          if (!preview?.url) {
            if (record) {
              record.previewStatus = "missing";
              if (!sourcePathMismatch) { record.judgmentStatus = "needs_user_judgment"; record.failureReason = "preview_unavailable"; }
            }
          }
          if (preview?.url && !previewTechnicalByAsset.has(candidate.knowledgeAssetKey) && !previewFailedAssets.has(candidate.knowledgeAssetKey)) {
            try {
              const cacheKey = `preview:${candidate.knowledgeAssetKey}`;
              const technical = await reuse(downloadCache, metrics.resourceReuse.images, cacheKey, () => downloadQueue.add(async () => {
                metrics.previewFetchAttempts += 1;
                const result = await downloadFn({ ...candidate, imageUrl: preview.url, title: preview.filename || candidate.title }, { directory: assetDirectory, publicPrefix, signal, retrievalSession, minWidth: 1, minHeight: 1, maxBytes: 14 * 1024 * 1024, onRequest: () => { metrics.resourceReuse.images.networkRequests += 1; increment(metrics.resourceReuse.images.networkRequestsByUrl, cacheKey); }, trustedKnowledgeOrigins });
                return Object.fromEntries(["filePath", "publicUrl", "sha256", "width", "height", "bytes", "contentType", "sourceContentType", "sourceFormat", "sourceBytes", "conversion", "downloadedImageUrl", "downloadVariantAttempts", "acquisitionMethod"].map((key) => [key, result[key]]));
              }));
              previewTechnicalByAsset.set(candidate.knowledgeAssetKey, technical);
              if (record) record.previewStatus = "success";
            } catch (error) {
              previewFailedAssets.add(candidate.knowledgeAssetKey);
              if (record) {
                record.previewStatus = "failed";
                if (!sourcePathMismatch) { record.judgmentStatus = "needs_user_judgment"; record.failureReason = `preview_download_failed:${error?.message || error}`; }
              }
            }
          }
          const technical = previewTechnicalByAsset.get(candidate.knowledgeAssetKey);
          if (technical && record) record.previewStatus = "success";
          if (technical && !sourcePathMismatch) prepared.push({ ...candidate, filePath: technical.filePath, publicUrl: technical.publicUrl, previewFilePath: technical.filePath, previewPublicUrl: technical.publicUrl, previewSha256: technical.sha256, previewWidth: technical.width, previewHeight: technical.height, previewBytes: technical.bytes, previewContentType: technical.contentType });
          if (!technical && !sourcePathMismatch && !originalPreviewRescueAttempted && originalDownloadsUsed < originalDownloadBudget && metadataStronglyMatchesVisualTarget(candidate, layerSlot)) {
            originalPreviewRescueAttempted = true;
            const matchedFile = candidate.knowledgeMatchedFile || null;
            if (!matchedFile?.url) continue;
            originalDownloadsUsed += 1;
            originalAttemptedAssets.add(candidate.knowledgeAssetKey);
            try {
              const cacheKey = `original:${candidate.knowledgeAssetKey}:${resolutionCacheKey}`;
              const rescued = await reuse(downloadCache, metrics.resourceReuse.images, cacheKey, () => downloadQueue.add(async () => {
                metrics.downloadAttempts += 1;
                metrics.matchedFileDownloadAttempts += 1;
                evidence.downloadAttempts += 1;
                const result = await measure("originalDownload", () => measure("download", () => downloadFn({ ...candidate, imageUrl: matchedFile.url, title: matchedFile.filename || candidate.title }, { directory: assetDirectory, publicPrefix, signal, retrievalSession, ...resolutionPolicy, onRequest: () => { metrics.resourceReuse.images.networkRequests += 1; increment(metrics.resourceReuse.images.networkRequestsByUrl, cacheKey); }, trustedKnowledgeOrigins })));
                return Object.fromEntries(["filePath", "publicUrl", "sha256", "width", "height", "bytes", "contentType", "sourceContentType", "sourceFormat", "sourceBytes", "conversion", "downloadedImageUrl", "downloadVariantAttempts", "acquisitionMethod"].map((key) => [key, result[key]]));
              }));
              metrics.matchedFileDownloadSuccess += 1;
              const localized = { ...candidate, ...rescued, originalDownloaded: true, originalDownloadStatus: "success", previewFilePath: rescued.filePath, previewPublicUrl: rescued.publicUrl, previewSha256: rescued.sha256, previewWidth: rescued.width, previewHeight: rescued.height, previewBytes: rescued.bytes, previewContentType: rescued.contentType };
              rescuedOriginalByAsset.set(candidate.knowledgeAssetKey, localized);
              prepared.push(localized);
              if (record) { record.previewStatus = "rescued_original"; record.downloadStatus = "success"; record.judgmentStatus = "pending"; record.failureReason = null; }
            } catch (error) {
              const message = error?.message || String(error);
              if (record) { record.downloadStatus = "failed"; record.judgmentStatus = "needs_user_judgment"; record.failureReason = `preview_rescue_failed:${message}`; }
              evidence.downloadFailures.push({ imageUrl: candidate.knowledgeAssetKey, layer: failureLayer(error), reason: message, code: "preview_rescue_failed" });
            }
          }
        }

        const validCandidates = allCandidates.filter((candidate) => pathDecisionFor(candidate).match !== false);
        if (!validCandidates.length) {
          if (!final) return null;
          countOutcome("completed");
          syncEvidence("completed");
          return {
            kind: "no_candidate",
            candidates: allCandidates.map((candidate) => {
              const technical = previewTechnicalByAsset.get(candidate.knowledgeAssetKey);
              const localized = technical ? { ...candidate, filePath: technical.filePath, publicUrl: technical.publicUrl, previewFilePath: technical.filePath, previewPublicUrl: technical.publicUrl, previewSha256: technical.sha256, previewWidth: technical.width, previewHeight: technical.height, previewBytes: technical.bytes, previewContentType: technical.contentType } : candidate;
              return publicCandidate(localized, null, "knowledge_source_path_mismatch");
            }),
            sourceEvidence: [...sourceEvidence],
            actualSubject: null,
            matchReason: `${layerName} 候选均不满足现有来源路径约束`,
            technicalStatus: "knowledge_no_valid_candidate",
          };
        }

        if (visionEnabled) {
          while (true) {
            const reviewable = prepared.filter((candidate) => !judgmentsByAsset.has(candidate.knowledgeAssetKey));
            if (!reviewable.length) break;
            const reviewWave = reviewable.slice(0, initialReviewWaveSize);
            for (let start = 0; start < reviewWave.length; start += auditBatchSize) {
            const batch = reviewWave.slice(start, start + auditBatchSize);
            auditBatches += 1;
            previewAudited += batch.length;
            metrics.previewAudited += batch.length;
            let judgments;
            try {
              const representative = batch.find((candidate) => candidate.knowledgeSourcePathMode === "transport_root_context") || batch[0];
              const representativeMode = representative.knowledgeSourcePathMode;
              const visualTarget = buildKnowledgeVisualTarget(layerSlot);
              const auditSlot = {
                ...eligibilitySlot, ...eligibilityConstraints,
                ...visualTarget,
                subject: visualTarget.coreVisualTarget,
                visualGoal: `${visualTarget.visualDuty}；查询可放宽非核心载体或细节，但审核必须保留核心视觉结果${visualTarget.representativeAllowed ? "，可在不误导事实时判为 representative" : "，不得用代表性氛围替代身份或类型证据"}`,
                location: layerSlot.locationRole === "visual_identity" ? layerSlot.location : knowledgeCandidateContextLocation(representative, layerSlot.location),
                originalLocation: layerSlot.location || null,
                knowledgeSourcePathMode: representativeMode,
                knowledgeImagePurpose: classifyKnowledgeImagePurpose(layerSlot),
                label: text(layerSlot.subject) || slot.slotId,
                context: contextText(layerSlot.visualContext),
                module: layerSlot.moduleType,
              };
              judgments = await visionQueue.add(() => tracked("visual_judgment", `${slot.slotId}:${layerName}:preview-batch-${auditBatches}`, async (recordAttempt) => withOneTechnicalRetry(async (attempt) => {
                recordAttempt();
                metrics.batchVisionCalls += 1;
                return measure("previewAudit", () => measure("batchVision", () => judgeFn({ slot: auditSlot, candidates: batch.map(knowledgeEntityProbeAuditCandidate), apiKey: visionApiKey, baseUrl: visionBaseUrl, model: visionModel, signal, allowContractRepair: attempt === 1, onContractRepair: recordContractRepair(recordAttempt) })));
              }, (error) => { metrics.technicalRetries.vision += 1; warnings.push(`${layerName} 视觉判断技术重试：${error?.message || error}`); })));
            } catch (error) {
              const rejection = error?.code === "audit_timeout" ? "review_timeout" : "needs_user_judgment";
              for (const candidate of batch) {
                const record = candidateRecord(candidate);
                if (record) { record.judgmentStatus = rejection === "review_timeout" ? "audit_timeout" : "needs_user_judgment"; record.failureReason = error?.message || String(error); }
                judgmentsByAsset.set(candidate.knowledgeAssetKey, { candidate, audit: null, rejection });
              }
              continue;
            }
            const byId = new Map(batch.map((candidate) => [candidate.candidateId, candidate]));
            const returnedIds = new Set();
            for (const audit of Array.isArray(judgments) ? judgments : []) {
              const candidate = byId.get(audit?.candidateId);
              if (!candidate) continue;
              returnedIds.add(candidate.candidateId);
              const effectiveAudit = applyKnowledgeSourcePathEvidence(layerSlot, audit, pathDecisionFor(candidate));
              const record = candidateRecord(candidate);
              if (!completeVisualJudgment(effectiveAudit)) {
                if (record) { record.judgmentStatus = "needs_user_judgment"; record.failureReason = "incomplete_visual_judgment"; }
                judgmentsByAsset.set(candidate.knowledgeAssetKey, { candidate, audit: effectiveAudit, rejection: "needs_user_judgment" });
                continue;
              }
              const gateSlot = knowledgeCandidateGateSlot(eligibilitySlot, candidate);
              const rejection = failedHardRequirement(gateSlot, effectiveAudit, candidate);
              if (pathDecisionFor(candidate).match !== false && provisionalIdentityOnly(gateSlot, effectiveAudit, candidate, rejection)) {
                rememberProvisional(slot.slotId, { candidate, audit: effectiveAudit, resolutionPolicy, sourceKind: "knowledge_library", remainingOriginalBudget: () => Math.max(0, originalDownloadBudget - originalDownloadsUsed) });
              }
              const qualifiedAudit = finalizeAuditEligibility(effectiveAudit, rejection);
              if (record) {
                record.judgmentStatus = rejection === "needs_user_judgment" ? "needs_user_judgment" : rejection ? "rejected" : qualifiedAudit.matchLevel === "representative" ? "representative" : "approved_not_selected";
                record.failureReason = rejection || null;
              }
              judgmentsByAsset.set(candidate.knowledgeAssetKey, { candidate, audit: qualifiedAudit, rejection });
            }
            for (const candidate of batch) if (!returnedIds.has(candidate.candidateId)) {
              const record = candidateRecord(candidate);
              if (record) { record.judgmentStatus = "needs_user_judgment"; record.failureReason = "missing_visual_judgment"; }
              judgmentsByAsset.set(candidate.knowledgeAssetKey, { candidate, audit: null, rejection: "needs_user_judgment" });
            }
            }
            evidence.visualJudgmentCompleted = true;
            const currentEligible = [...judgmentsByAsset.values()]
              .filter((entry) => !entry.rejection && entry.audit?.eligible === true)
              .sort((left, right) => auditQualityScore(right.audit, right.candidate, layerSlot) - auditQualityScore(left.audit, left.candidate, layerSlot));
            const exact = currentEligible.find((entry) => ["exact", "exact_match"].includes(entry.audit?.matchLevel));
            const highQuality = currentEligible.find((entry) => Number(entry.audit?.score || 0) >= 85 && Number(entry.audit?.relevance || 0) >= 85);
            if (exact || highQuality) {
              earlyStopReason = exact ? "exact_eligible" : "high_quality_eligible";
              break;
            }
          }
        }

        const eligible = [...judgmentsByAsset.values()]
          .filter((entry) => !entry.rejection && entry.audit?.eligible === true)
          .sort((left, right) => auditQualityScore(right.audit, right.candidate, layerSlot) - auditQualityScore(left.audit, left.candidate, layerSlot));
        let selectedEntry = null;
        let selectedCandidate = null;
        let selectedDuplicate = null;
        for (const entry of eligible) {
          const rescuedCandidate = rescuedOriginalByAsset.get(entry.candidate.knowledgeAssetKey);
          if (rescuedCandidate) {
            const record = candidateRecord(entry.candidate);
            const duplicate = await withDedupeLock(rescuedCandidate);
            if (!duplicate.accepted) {
              entry.rejection = duplicate.reason;
              if (record) { record.downloadStatus = "success"; record.judgmentStatus = "rejected"; record.failureReason = duplicate.reason; }
              continue;
            }
            selectedEntry = entry;
            selectedCandidate = rescuedCandidate;
            selectedDuplicate = duplicate;
            metrics.originalDownloadSavedCount += 1;
            if (record) { record.downloadStatus = "success"; record.judgmentStatus = "approved"; record.selected = true; record.failureReason = null; }
            break;
          }
          if (originalDownloadsUsed >= originalDownloadBudget) break;
          if (originalAttemptedAssets.has(entry.candidate.knowledgeAssetKey)) continue;
          originalAttemptedAssets.add(entry.candidate.knowledgeAssetKey);
          const matchedFile = entry.candidate.knowledgeMatchedFile || (entry.candidate.imageUrl ? { url: entry.candidate.imageUrl, filename: entry.candidate.title, relation: "legacy_matched_file" } : null);
          const record = candidateRecord(entry.candidate);
          if (!matchedFile?.url) {
            entry.rejection = "preview_found_original_download_failed";
            if (record) { record.downloadStatus = "failed"; record.failureReason = "matched_file_missing"; }
            continue;
          }
          originalDownloadsUsed += 1;
          try {
            const cacheKey = `original:${entry.candidate.knowledgeAssetKey}:${resolutionCacheKey}`;
            const technical = await reuse(downloadCache, metrics.resourceReuse.images, cacheKey, () => downloadQueue.add(async () => {
              metrics.downloadAttempts += 1;
              metrics.matchedFileDownloadAttempts += 1;
              evidence.downloadAttempts += 1;
              const result = await measure("originalDownload", () => measure("download", () => downloadFn({ ...entry.candidate, imageUrl: matchedFile.url, title: matchedFile.filename || entry.candidate.title }, { directory: assetDirectory, publicPrefix, signal, retrievalSession, ...resolutionPolicy, onRequest: () => { metrics.resourceReuse.images.networkRequests += 1; increment(metrics.resourceReuse.images.networkRequestsByUrl, cacheKey); }, trustedKnowledgeOrigins })));
              return Object.fromEntries(["filePath", "publicUrl", "sha256", "width", "height", "bytes", "contentType", "sourceContentType", "sourceFormat", "sourceBytes", "conversion", "downloadedImageUrl", "downloadVariantAttempts", "acquisitionMethod"].map((key) => [key, result[key]]));
            }));
            metrics.matchedFileDownloadSuccess += 1;
            const localized = { ...entry.candidate, ...technical, originalDownloaded: true, originalDownloadStatus: "success" };
            entry.candidate = localized;
            const duplicate = await withDedupeLock(localized);
            if (!duplicate.accepted) {
              entry.rejection = duplicate.reason;
              if (record) { record.downloadStatus = "success"; record.judgmentStatus = "rejected"; record.failureReason = duplicate.reason; }
              continue;
            }
            selectedEntry = entry;
            selectedCandidate = localized;
            selectedDuplicate = duplicate;
            metrics.originalDownloadSavedCount += 1;
            if (record) { record.downloadStatus = "success"; record.judgmentStatus = "approved"; record.selected = true; record.failureReason = null; }
            break;
          } catch (error) {
            entry.rejection = "preview_found_original_download_failed";
            const message = error?.message || String(error);
            const failureCode = error?.code === "image_resolution_insufficient" || /分辨率不足/i.test(message) ? "resolution_failed"
              : /不支持的图片格式/i.test(message) ? "unsupported_format"
                : /文件过大|资源上限/i.test(message) ? "file_too_large" : "preview_found_original_download_failed";
            entry.candidate = {
              ...entry.candidate,
              originalDownloaded: false,
              originalDownloadStatus: "failed",
              originalDownloadFailureCode: failureCode,
              originalDownloadFailureReason: message,
              originalWidth: Number(error?.actualWidth || 0) || null,
              originalHeight: Number(error?.actualHeight || 0) || null,
              minimumWidth: Number(error?.minWidth || 0) || null,
              minimumHeight: Number(error?.minHeight || 0) || null,
            };
            if (record) { record.downloadStatus = "failed"; record.judgmentStatus = "original_download_failed"; record.failureReason = failureCode; }
            evidence.downloadFailures.push({
              imageUrl: entry.candidate.knowledgeAssetKey,
              layer: failureLayer(error),
              reason: message,
              code: failureCode,
              actualWidth: Number(error?.actualWidth || 0) || null,
              actualHeight: Number(error?.actualHeight || 0) || null,
              minimumWidth: Number(error?.minWidth || 0) || null,
              minimumHeight: Number(error?.minHeight || 0) || null,
            });
          }
        }

        if (!selectedEntry && visionEnabled && prepared.some((candidate) => !judgmentsByAsset.has(candidate.knowledgeAssetKey))) {
          return assessCurrentCandidates({ final });
        }

        const publicCandidates = allCandidates.map((candidate) => {
          const technical = previewTechnicalByAsset.get(candidate.knowledgeAssetKey);
          const localized = technical ? { ...candidate, filePath: technical.filePath, publicUrl: technical.publicUrl, previewFilePath: technical.filePath, previewPublicUrl: technical.publicUrl, previewSha256: technical.sha256, previewWidth: technical.width, previewHeight: technical.height, previewBytes: technical.bytes, previewContentType: technical.contentType } : candidate;
          const entry = judgmentsByAsset.get(candidate.knowledgeAssetKey);
          const record = candidateRecord(candidate);
          const isSelected = selectedEntry?.candidate?.knowledgeAssetKey === candidate.knowledgeAssetKey;
          const published = publicCandidate(isSelected ? selectedCandidate : (entry?.candidate || localized), entry?.audit || null, isSelected ? null : entry?.rejection || (pathDecisionFor(candidate).match === false ? "knowledge_source_path_mismatch" : record?.failureReason || "not_auto_reviewed"));
          if (isSelected) return { ...published, candidateStatus: "selected", autoReviewStatus: "auto_selected", selected: true, notAutoSelected: false, manualOnly: false };
          if (entry?.rejection === "preview_found_original_download_failed") return {
            ...published,
            autoReviewStatus: entry.candidate.originalDownloadFailureCode === "resolution_failed" ? "original_resolution_insufficient" : "original_download_failed",
            originalDownloadStatus: "failed",
          };
          return published;
        });
        metrics.previewAuditTimeMs = timingsMs.previewAudit;
        metrics.originalDownloadTimeMs = timingsMs.originalDownload;
        if (selectedEntry) {
          for (const candidate of prepared) if (!judgmentsByAsset.has(candidate.knowledgeAssetKey)) {
            const record = candidateRecord(candidate);
            if (record) { record.judgmentStatus = "not_auto_reviewed"; record.failureReason = null; }
          }
          if (!earlyStopReason) earlyStopReason = "candidate_pool_exhausted_with_eligible";
          countOutcome("completed");
          syncEvidence("completed");
          const mergedPublic = mergePublicCandidates([], publicCandidates);
          const selected = mergedPublic.find((candidate) => candidate.candidateId === selectedCandidate.candidateId) || { ...publicCandidate(selectedCandidate, selectedEntry.audit), candidateStatus: "selected", autoReviewStatus: "auto_selected", selected: true, notAutoSelected: false, manualOnly: false };
          return { kind: "success", selected: { ...selected, dHash: selectedDuplicate.dHash, aspectRatio: slot.aspectRatio }, candidates: mergedPublic, sourceEvidence: [...sourceEvidence], actualSubject: selectedEntry.audit.actualSubject, matchReason: selectedEntry.audit.reason || "按动态批次审核当前候选池并择优采用", technicalStatus: "preview_audited_original_downloaded" };
        }
        if (!final) return null;
        countOutcome("completed");
        if (!visionEnabled) {
          for (const candidate of prepared) {
            const record = candidateRecord(candidate);
            if (record) record.judgmentStatus = "not_auto_reviewed";
          }
          syncEvidence("completed");
          return { kind: "visual_unavailable", candidates: mergePublicCandidates([], publicCandidates), sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: "visual_judgment_unavailable" };
        }
        for (const candidate of prepared) if (!judgmentsByAsset.has(candidate.knowledgeAssetKey)) {
          const record = candidateRecord(candidate);
          if (record) { record.judgmentStatus = "not_auto_reviewed"; record.failureReason = null; }
        }
        syncEvidence("completed");
        const mergedPublic = mergePublicCandidates([], publicCandidates);
        const judged = [...judgmentsByAsset.values()];
        const originalFailedEntries = judged.filter((entry) => entry.rejection === "preview_found_original_download_failed");
        const originalFailed = originalFailedEntries.length > 0;
        const onlyResolutionFailures = originalFailed && originalFailedEntries.every((entry) => entry.candidate.originalDownloadFailureCode === "resolution_failed");
        const resolutionSummary = originalFailedEntries
          .map((entry) => entry.candidate.originalWidth && entry.candidate.originalHeight ? `${entry.candidate.originalWidth}×${entry.candidate.originalHeight}` : null)
          .filter(Boolean).join("、");
        const unresolved = validCandidates.some((candidate) => {
          const entry = judgmentsByAsset.get(candidate.knowledgeAssetKey);
          return !entry || !completeVisualJudgment(entry.audit)
            || (["needs_user_judgment", "review_timeout"].includes(entry.rejection)
              && !(entry.candidate.knowledgeSourcePathMode === "entity_probe" && isIdentityEvidenceUnresolved(entry.audit)));
        });
        return {
          kind: originalFailed || unresolved ? "inconclusive" : "no_eligible",
          visualAuditComplete: !unresolved,
          candidates: mergedPublic,
          sourceEvidence: [...sourceEvidence],
          actualSubject: judged.find((entry) => entry.audit?.actualSubject)?.audit.actualSubject || null,
          matchReason: unresolved ? "部分 preview 审核未完成，需要人工判断"
            : onlyResolutionFailures
            ? `preview 已找到并审核，但知识库原件尺寸不足${resolutionSummary ? `（${resolutionSummary}）` : ""}，未降低清晰度门槛`
            : originalFailed ? "preview 已找到并审核，但原件下载或技术检查失败"
              : `${layerName} preview 均有明确硬拒绝或不满足采用条件`,
          technicalStatus: unresolved ? "visual_judgment_inconclusive"
            : onlyResolutionFailures ? "knowledge_original_resolution_insufficient"
            : originalFailed ? "preview_found_original_download_failed"
              : "no_eligible_candidate",
        };
      };

      try {
        if (knowledgeScopeNodeIds.length) {
          hierarchyLookup = { status: "bypassed_configured_scope", failureCode: null, attempts: 0, technicalRetries: 0 };
          scopeResolution = { status: "resolved", nodeIds: knowledgeScopeNodeIds.map(String), node: null, fullPath: null, reason: "configured_scope" };
        } else if (adapters.searchKnowledgeImages && !adapters.loadKnowledgeHierarchy) {
          hierarchyLookup = { status: "bypassed_test_adapter", failureCode: null, attempts: 0, technicalRetries: 0 };
          scopeResolution = { status: "unresolved", nodeIds: [], node: null, fullPath: null, reason: "test_adapter_without_hierarchy" };
        } else {
          try {
            scopeResolution = await knowledgeScopeResolver.resolve(layerSlot);
            const stats = knowledgeScopeResolver.hierarchyStats();
            hierarchyLookup = { status: "loaded", failureCode: null, attempts: stats.attempts, technicalRetries: stats.technicalRetries };
          } catch (error) {
            const stats = knowledgeScopeResolver.hierarchyStats();
            const cancelled = signal?.aborted === true;
            const timeout = !cancelled && (error?.name === "AbortError" || /timeout/i.test(String(error?.code || "")));
            hierarchyLookup = {
              status: cancelled ? "cancelled" : timeout ? "timeout" : "failed",
              failureCode: diagnosticCode(error?.code) || diagnosticCode(stats.failureCode) || (cancelled ? "cancelled" : timeout ? "knowledge_hierarchy_timeout" : "knowledge_hierarchy_failed"),
              attempts: stats.attempts,
              technicalRetries: stats.technicalRetries,
            };
            throw error;
          }
        }
        rootResolution = scopeResolution;
        if (scopeResolution.status === "resolved") metrics.knowledgeScopeResolved += 1;
        else metrics.knowledgeScopeUnresolved += 1;
        if (scopeResolution.status === "resolved" && scopeResolution.node && scopeResolution.reason !== "test_adapter_without_hierarchy") {
          scopePlan = await knowledgeScopeResolver.plan(layerSlot, scopeResolution);
          childScopeDecision = scopePlan.childScopeDecision;
        } else {
          childScopeDecision = { entered: false, category: null, availableChildren: [], matchingChildren: [], reason: "resolved_hierarchy_node_unavailable" };
          scopePlan = buildKnowledgeScopePlan(layerSlot, scopeResolution, null);
        }
        const emptyScopeBlocked = scopeResolution.status === "unresolved"
          && scopeResolution.reason !== "test_adapter_without_hierarchy"
          && !knowledgeScopeNodeIds.length;
        const scopePlanBlocked = Boolean(scopePlan.blockedReason)
          && scopeResolution.status !== "ambiguous"
          && scopeResolution.reason !== "test_adapter_without_hierarchy";
        if (scopePlanBlocked || emptyScopeBlocked) {
          const hotelScopeBlocked = scopePlanBlocked;
          lastResult = { status: "completed", queryId: null, queryText: "", scope: null, durationMs: 0, records: [], candidates: [], message: hotelScopeBlocked ? "酒店目录及地区/国家兜底Scope均未解析，未向知识库发出空Scope请求" : "知识库Scope未解析，未向知识库发出空Scope请求" };
          countOutcome("not_found");
          syncEvidence("completed", scopePlan.blockedReason || "knowledge_scope_unresolved");
          return { kind: "inconclusive", candidates: [], sourceEvidence: [], actualSubject: null, matchReason: lastResult.message, technicalStatus: hotelScopeBlocked ? "knowledge_hotel_scope_unresolved" : "knowledge_scope_unresolved" };
        }
        const plannedScopes = scopePlan.scopes.length ? scopePlan.scopes : [{ role: "unresolved", resolution: scopeResolution, evidenceResolution: scopeResolution }];
        scopeResolution = plannedScopes[0].resolution;
        queryPlan = { ...buildKnowledgeQueryPlan(layerSlot, null, { maxQueries: knowledgeQueriesPerSlot }), byScope: [] };
        queryPlan.scopePlan = scopePlan.scopes.map((item) => ({ role: item.role, nodeIds: item.resolution?.nodeIds || [], fullPath: item.resolution?.fullPath || null, sourcePathMode: item.sourcePathMode || null, identityAnchors: item.identityAnchors || [] }));
        if (queryPlan.validationError) {
          lastResult = { status: "blocked", queryId: null, queryText: "", scope: null, durationMs: 0, records: [], candidates: [], message: queryPlan.validationError.message };
          countOutcome("not_found");
          syncEvidence("blocked", queryPlan.validationError.code);
          return { kind: "inconclusive", candidates: [], sourceEvidence: [], actualSubject: null, matchReason: queryPlan.validationError.message, technicalStatus: queryPlan.validationError.code };
        }
        if (!queryPlan.queries.length && layerQueries[0]) queryPlan.queries.push(layerQueries[0]);
        if (scopeResolution.status === "ambiguous" && scopeResolution.candidates?.length) {
          metrics.knowledgeNeedsClarification += 1;
          lastResult = { status: "needs_clarification", queryId: null, queryText: queryPlan.queries[0] || "", scope: null, durationMs: 0, clarificationNodeIds: scopeResolution.candidates.map((candidate) => candidate.nodeId), records: [], candidates: [] };
          syncEvidence("needs_clarification");
          return { kind: "knowledge_needs_clarification", candidates: [], sourceEvidence: [], actualSubject: null, technicalStatus: "knowledge_needs_clarification" };
        }
        let clarificationUsed = false;
        for (let scopeIndex = 0; scopeIndex < plannedScopes.length; scopeIndex += 1) {
          const plannedScope = plannedScopes[scopeIndex];
          scopeResolution = plannedScope.resolution;
          queryPlan.sharedScopeNodeIds = [...(scopeResolution.nodeIds || [])];
          const scopedPlan = applyKnowledgeScopeToQueryPlan(queryPlan, layerSlot, scopeResolution);
          if (scopedPlan.validationError) {
            lastResult = { status: "blocked", queryId: null, queryText: "", scope: scopeResolution.fullPath || null, durationMs: 0, records: [], candidates: [], message: scopedPlan.validationError.message };
            countOutcome("not_found");
            syncEvidence("blocked", scopedPlan.validationError.code);
            return { kind: "inconclusive", candidates: publicCandidates, sourceEvidence: [...sourceEvidence], actualSubject: null, matchReason: scopedPlan.validationError.message, technicalStatus: scopedPlan.validationError.code };
          }
          const probe = plannedScope.role === "entity_parent_probe";
          const availableScopedQueries = probe ? scopedPlan.queries.map(query => {
            const anchors = plannedScope.identityAnchors || [];
            const normalized = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
            if (anchors.some(anchor => normalized(query).includes(normalized(anchor)))) return query;
            const identity = anchors.find(anchor => /[\u3400-\u9fff]/u.test(anchor) === /[\u3400-\u9fff]/u.test(query)) || anchors[0] || layerSlot.queryCore?.identity;
            return identity ? `${identity} ${query}` : query;
          }) : scopedPlan.queries;
          const scopedQueries = probe ? unique(availableScopedQueries).slice(0, Math.max(0, Math.min(2, plannedScope.maxQueries || 2, knowledgeQueriesPerSlot))) : hotelKnowledgeModule
            ? (plannedScope.role === "hotel_child" ? availableScopedQueries.slice(0, 2) : availableScopedQueries)
            : availableScopedQueries.slice(0, 2);
          queryPlan.byScope.push({ role: plannedScope.role, nodeIds: [...(scopeResolution.nodeIds || [])], fullPath: scopeResolution.fullPath || null, queries: [...scopedQueries] });
          for (let queryIndex = 0; queryIndex < scopedQueries.length; queryIndex += 1) {
            const queryText = scopedQueries[queryIndex];
            const attemptStartedAt = Date.now();
            let invoked;
            try {
              invoked = await invoke(queryText, scopeResolution, `:scope-${scopeIndex + 1}:query-${queryIndex + 1}`);
              lastResult = invoked.value;
            } catch (error) {
              attempts.push({ queryText, queryId: error?.queryId || null, status: error?.code === "knowledge_timeout" ? "timeout" : "failed", requestReuse: "none", scopeNodeIds: [...(scopeResolution.nodeIds || [])], scopePath: scopeResolution.fullPath || null, startedAt: new Date(attemptStartedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: error?.durationMs ?? Date.now() - attemptStartedAt, candidateCount: 0, diagnosticId: error?.diagnosticId || null, knowledgeStage: error?.knowledgeStage || null, knowledgeFailureKind: error?.knowledgeFailureKind || null, requestId: error?.requestId || null, errorId: error?.errorId || null, httpStatus: error?.status || null, failureReason: error?.message || String(error) });
              if (error?.code === "knowledge_timeout") metrics.knowledgeTimeouts += 1;
              if (candidatePool.size) {
                warnings.push(`${layerName} 后续知识库搜索失败，继续审核此前已找到的候选：${error?.message || error}`);
                return await assessCurrentCandidates({ final: true });
              }
              countOutcome("failed");
              syncEvidence(error?.code === "knowledge_timeout" ? "timeout" : "failed", error?.message || String(error));
              return { kind: "search_failed", candidates: [], sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: error?.code === "knowledge_timeout" ? "knowledge_timeout" : "knowledge_failed" };
            }
            if (lastResult?.status === "completed" && !lastResult?.candidates?.length) lastScopeFeedback = lastResult.scopeState || lastResult.message ? { scopeState: lastResult.scopeState || null, message: lastResult.message || null } : null;
            else if (lastResult?.status === "completed") lastScopeFeedback = null;
            attempts.push({ queryText, queryId: lastResult?.queryId || null, status: lastResult?.status || "failed", requestReuse: invoked.reuse, scopeState: lastResult?.scopeState || null, message: lastResult?.message || null, scopeIndex, scopeRole: plannedScope.role, scopeNodeIds: [...(scopeResolution.nodeIds || [])], scopePath: scopeResolution.fullPath || null, scope: lastResult?.scope || null, startedAt: new Date(attemptStartedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: lastResult?.durationMs ?? Date.now() - attemptStartedAt, candidateCount: lastResult?.candidates?.length || 0, diagnosticId: lastResult?.diagnosticId || null, knowledgeStage: lastResult?.knowledgeStage || null, knowledgeFailureKind: lastResult?.knowledgeFailureKind || null, requestId: lastResult?.requestId || null, errorId: lastResult?.errorId || null });
            if (lastResult?.status === "needs_clarification") {
              metrics.knowledgeNeedsClarification += 1;
              if (plannedScope.role !== "entity_parent_probe" && !clarificationUsed && lastResult.clarificationNodeIds?.length && scopeResolution.reason !== "test_adapter_without_hierarchy") {
                clarificationUsed = true;
                clarificationResolution = await knowledgeScopeResolver.clarify(layerSlot, lastResult.clarificationNodeIds);
                if (clarificationResolution.status === "resolved") {
                  metrics.knowledgeClarificationRetries += 1;
                  const refined = await knowledgeScopeResolver.refine(layerSlot, clarificationResolution);
                  scopeResolution = refined.scopeResolution;
                  childScopeDecision = refined.decision;
                  const correctedStartedAt = Date.now();
                  const corrected = await invoke(queryText, scopeResolution, `:query-${queryIndex + 1}:clarification`);
                  lastResult = corrected.value;
                  attempts.push({ queryText, queryId: lastResult?.queryId || null, status: lastResult?.status || "failed", requestReuse: corrected.reuse, scopeState: lastResult?.scopeState || null, message: lastResult?.message || null, scopeNodeIds: [...(scopeResolution.nodeIds || [])], scopePath: scopeResolution.fullPath || null, scope: lastResult?.scope || null, startedAt: new Date(correctedStartedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: lastResult?.durationMs ?? Date.now() - correctedStartedAt, candidateCount: lastResult?.candidates?.length || 0, diagnosticId: lastResult?.diagnosticId || null, knowledgeStage: lastResult?.knowledgeStage || null, knowledgeFailureKind: lastResult?.knowledgeFailureKind || null, requestId: lastResult?.requestId || null, errorId: lastResult?.errorId || null, clarificationCorrection: true });
                  if (lastResult?.status !== "needs_clarification") metrics.knowledgeClarificationResolved += 1;
                }
              }
            }
            if (lastResult?.status === "needs_clarification") {
              if (candidatePool.size) {
                const assessed = await assessCurrentCandidates({ final: true });
                if (assessed?.kind === "success") return assessed;
                // A later ambiguous directory remains terminal even when an
                // earlier preview was usable but its original was not.
                syncEvidence("needs_clarification");
                return {
                  kind: "knowledge_needs_clarification",
                  candidates: assessed?.candidates || [],
                  sourceEvidence: [...sourceEvidence],
                  actualSubject: assessed?.actualSubject || null,
                  matchReason: "知识库后续查询需要明确目录范围，保留已审核候选供人工处理",
                  technicalStatus: "knowledge_needs_clarification",
                };
              }
              syncEvidence("needs_clarification");
              return { kind: "knowledge_needs_clarification", candidates: [], sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: "knowledge_needs_clarification" };
            }
            if (lastResult?.status !== "completed") {
              if (candidatePool.size) return await assessCurrentCandidates({ final: true });
              countOutcome("failed");
              syncEvidence("failed");
              return { kind: "search_failed", candidates: [], sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: "knowledge_failed" };
            }
            evidence.searchCompleted = true;
            if (!lastResult?.candidates?.length) {
              const scopeState = String(lastResult?.scopeState || "").trim();
              if (["empty", "unavailable"].includes(scopeState)) break;
              if (scopeState !== "no_match") break;
            }
            const rawRecords = new Map((lastResult?.records || []).map((record) => [record.recordId, record]));
            const raw = (lastResult?.candidates || []).filter((candidate) => candidate?.knowledgePreview?.url || candidate?.imageUrl);
            metrics.knowledgeCandidates += raw.length;
            metrics.previewReturned += raw.length;
            evidence.extractedCandidates += raw.length;
            evidence.semanticExtractionCompleted = true;
            anyCandidates ||= raw.length > 0;
            for (const candidate of raw) {
              if (candidate.pageUrl) sourceEvidence.add(candidate.pageUrl);
              const merged = upsertCandidate(candidate, rawRecords.get(candidate.knowledgeRecordId), {
                queryText, queryId: lastResult.queryId, scopeResolution,
                evidenceResolution: plannedScope.evidenceResolution || scopeResolution,
                sourcePathMode: plannedScope.sourcePathMode,
                identityAnchors: plannedScope.identityAnchors,
              });
              if (!merged) continue;
              const decision = pathDecisionFor(merged);
              const record = candidateRecord(merged);
              if (decision.match === false) {
                if (!sourcePathRejected.has(merged.knowledgeAssetKey)) {
                  sourcePathRejected.add(merged.knowledgeAssetKey);
                  metrics.knowledgeSourcePathRejected += 1;
                }
                if (record) { record.previewStatus = "not_fetched"; record.judgmentStatus = "rejected"; record.failureReason = "knowledge_source_path_mismatch"; }
              } else {
                anyPathValidCandidates = true;
                if (record?.failureReason === "knowledge_source_path_mismatch") { record.previewStatus = "pending"; record.judgmentStatus = "pending"; record.failureReason = null; }
              }
            }
            const earlyResult = await assessCurrentCandidates({ final: false });
            if (earlyResult) return earlyResult;
          }
          // Scope fallback is progressive: current candidates are always audited
          // first. An empty or unavailable scope moves on immediately, while an
          // explicit no_match may try the next query (two per ordinary scope).
          if (scopeIndex < plannedScopes.length - 1) {
            const scopedResult = await assessCurrentCandidates({ final: false });
            if (scopedResult) return scopedResult;
          }
        }

        return await assessCurrentCandidates({ final: true });

      } catch (error) {
        if (error?.code === "knowledge_timeout") metrics.knowledgeTimeouts += 1;
        if (candidatePool.size) return await assessCurrentCandidates({ final: true });
        countOutcome("failed");
        syncEvidence(error?.code === "knowledge_timeout" ? "timeout" : "failed", error?.message || String(error));
        return { kind: "search_failed", candidates: [], sourceEvidence: [...sourceEvidence], actualSubject: null, technicalStatus: error?.code === "knowledge_timeout" ? "knowledge_timeout" : "knowledge_failed" };
      }
    }

    const webBudget = { pages: 0, effectivePages: new Set(), downloads: 0, commonsCalled: false, pageUrls: new Set(), assets: new Set(), hashes: new Set() };
    const networkPageLimit = sourcePagesPerSlot * 2;
    const summarizeWebCandidatePool = (result, evidence) => {
      if (!["no_candidate", "no_eligible"].includes(result.kind)) return result;
      const candidates = result.candidates || [];
      const reasons = {};
      for (const candidate of candidates) {
        const reason = candidate.rejection && candidate.rejection !== "not_auto_selected" ? candidate.rejection
          : candidate.originalDownloadFailureCode === "size" ? "resolution_failed"
            : candidate.originalDownloadFailureCode || candidate.hardJudgment?.hardRejectCode || "unreviewed";
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
      evidence.webExecution.candidateReasons = reasons;
      // An explicit hard rejection is final even if other audit fields are
      // absent. Only undecided candidates should make the pool inconclusive.
      const hardRejected = (candidate) => candidate.autoReviewStatus === "hard_reject"
        || isHardRejectionCode(candidate.rejection)
        || isHardRejectionCode(candidate.hardJudgment?.hardRejectCode);
      const incomplete = candidates.some((candidate) => !hardRejected(candidate) && (
        ["needs_user_judgment", "hotel_identity_unconfirmed", "review_timeout"].includes(candidate.rejection)
        || candidate.hardJudgment?.auditContract?.complete === false
        || candidate.originalDownloadStatus === "success" && candidate.hardJudgment?.auditContract?.complete !== true));
      if (incomplete) return { ...result, kind: "inconclusive", technicalStatus: "visual_judgment_inconclusive" };
      const reviewed = candidates.some((candidate) => hardRejected(candidate) || candidate.hardJudgment?.auditContract?.complete === true);
      if (reviewed) return { ...result, kind: "no_eligible", technicalStatus: "no_eligible_candidate" };
      const failures = evidence.downloadFailures || [];
      const allCandidateFailuresAreSize = candidates.length > 0 && candidates.every((candidate) => candidate.originalDownloadStatus === "failed" && candidate.originalDownloadFailureCode === "size");
      if (allCandidateFailuresAreSize && failures.length && failures.every((item) => item.layer === "size")) {
        return { ...result, technicalStatus: "all_candidates_too_small" };
      }
      if (failures.some((item) => item.layer === "decode")) return { ...result, technicalStatus: "candidate_decode_failed" };
      if (failures.some((item) => ["download", "page_access"].includes(item.layer))) return { ...result, technicalStatus: "candidate_download_failed" };
      if (result.technicalStatus === "all_candidates_too_small") return { ...result, technicalStatus: "no_technical_candidate" };
      return result;
    };
    async function runSourceLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName, fallbackPlan = null, sourceChoice = "web") {
      if (sourceChoice === "knowledge") return runKnowledgePreviewFirstLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName);
      const started = Date.now();
      const queries = buildWebExecutionQueries(layerSlot, layerQueries, classifyKnowledgeImagePurpose(layerSlot), evidence.explicitEntityFastPath);
      evidence.webExecution ||= { plannedQueries: queries, executedQueries: [], wallClockMs: 0, stopReason: null };
      let result = { kind: "no_candidate", candidates: [], sourceEvidence: [], technicalStatus: "web_identity_or_query_empty" };
      evidence.webExecution.queryReports ||= [];
      const pendingPages = new Map();
      const terminal = (kind) => ["success", "visual_unavailable", "visual_failed", "inconclusive"].includes(kind);
      const hasBudget = () => webBudget.pages < networkPageLimit && webBudget.effectivePages.size < sourcePagesPerSlot && webBudget.downloads < downloadsPerSlot;
      const mergeResult = (current) => {
        const candidates = mergePublicCandidates(result.candidates, current.candidates || []);
        const sourceEvidence = unique([...result.sourceEvidence, ...(current.sourceEvidence || [])]);
        const reasons = {};
        for (const candidate of candidates) {
          const reason = candidate.rejection || candidate.hardJudgment?.hardRejectCode || candidate.qualificationStatus || "unreviewed";
          reasons[reason] = (reasons[reason] || 0) + 1;
        }
        evidence.webExecution.candidateReasons = reasons;
        const incomplete = candidates.some((item) => item.autoReviewStatus === "needs_user_judgment" || item.autoReviewStatus === "audit_timeout" || item.hardJudgment?.auditContract?.complete === false);
        const reviewed = candidates.some((item) => item.hardJudgment);
        const base = ["success", "visual_unavailable", "visual_failed"].includes(current.kind) ? current
          : incomplete ? { ...current, kind: "inconclusive", technicalStatus: "visual_judgment_inconclusive" }
            : reviewed ? { ...current, kind: "no_eligible", technicalStatus: "no_eligible_candidate" } : current;
        result = { ...base, candidates, sourceEvidence };
      };
      for (const [queryIndex, query] of queries.entries()) {
        if (signal?.aborted) { evidence.webExecution.stopReason = "aborted"; break; }
        if (webBudget.pages >= networkPageLimit || webBudget.effectivePages.size >= sourcePagesPerSlot || webBudget.downloads >= downloadsPerSlot) { evidence.webExecution.stopReason = "slot_resource_budget"; break; }
        // Admit a bounded current-query pool while keeping one real opportunity
        // for the next expression. Finish this admitted pool before advancing.
        const reserve = queryIndex < queries.length - 1 ? 1 : 0;
        const pageRemaining = Math.min(networkPageLimit - webBudget.pages, sourcePagesPerSlot - webBudget.effectivePages.size);
        const downloadRemaining = downloadsPerSlot - webBudget.downloads;
        evidence.webExecution.currentAllowance = {
          pages: pageRemaining - Math.min(reserve, Math.max(0, pageRemaining - 1)),
          downloads: downloadRemaining - Math.min(reserve, Math.max(0, downloadRemaining - 1)),
          reservedPages: Math.min(reserve, Math.max(0, pageRemaining - 1)),
          reservedDownloads: Math.min(reserve, Math.max(0, downloadRemaining - 1)),
        };
        evidence.webExecution.executedQueries.push(query);
        const current = await runWebQueryLayer(layerSlot, layerConstraints, [query], evidence, `${layerName}:q${evidence.webExecution.executedQueries.length}`, fallbackPlan, { pendingPages });
        mergeResult(current);
        if (["success", "search_failed", "visual_unavailable", "visual_failed", "inconclusive"].includes(current.kind)) { evidence.webExecution.stopReason = current.kind === "success" ? evidence.webExecution.qualityStopReason || "eligible_pool_exhausted" : current.kind; break; }
      }
      // Reserve opportunities for later expressions first, then use already
      // discovered pages. This does not call the search provider again.
      while (!signal?.aborted && !terminal(result.kind) && hasBudget() && pendingPages.size) {
        const query = pendingPages.values().next().value.query;
        const pages = [...pendingPages.values()].filter(item => item.query === query).map(item => item.page);
        for (const page of pages) pendingPages.delete(page.pageUrl);
        evidence.webExecution.currentAllowance = {
          pages: Math.min(networkPageLimit - webBudget.pages, sourcePagesPerSlot - webBudget.effectivePages.size),
          downloads: downloadsPerSlot - webBudget.downloads, reservedPages: 0, reservedDownloads: 0,
        };
        const current = await runWebQueryLayer(layerSlot, layerConstraints, [query], evidence, `${layerName}:pending`, fallbackPlan, { pendingPages, pages });
        mergeResult(current);
        if (terminal(current.kind)) evidence.webExecution.stopReason = current.kind === "success" ? evidence.webExecution.qualityStopReason || "eligible_pool_exhausted" : current.kind;
      }
      evidence.webExecution.pendingPages = pendingPages.size;
      evidence.webExecution.remainingPages = Math.max(0, Math.min(networkPageLimit - webBudget.pages, sourcePagesPerSlot - webBudget.effectivePages.size));
      evidence.webExecution.remainingDownloads = Math.max(0, downloadsPerSlot - webBudget.downloads);
      if (signal?.aborted) evidence.webExecution.stopReason = "aborted";
      else if (!terminal(result.kind) && !hasBudget()) evidence.webExecution.stopReason = "slot_resource_budget";
      evidence.webExecution.wallClockMs += Date.now() - started;
      evidence.webExecution.pagesUsed = webBudget.pages;
      evidence.webExecution.effectivePagesUsed = webBudget.effectivePages.size;
      evidence.webExecution.networkPageLimit = networkPageLimit;
      evidence.webExecution.downloadsUsed = webBudget.downloads;
      evidence.webExecution.stopReason ||= queries.length ? "queries_exhausted" : "target_identity_or_query_empty";
      return summarizeWebCandidatePool(result, evidence);
    }
    async function runWebQueryLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName, fallbackPlan = null, { pendingPages = new Map(), pages: resumedPages = null } = {}) {
      const sourceChoice = "web";
      const webMeasure = async (stage, worker) => {
        const started = Date.now();
        try { return await measure(stage, worker); }
        finally { evidence.webExecution.operationMs ||= {}; evidence.webExecution.operationMs[stage] = (evidence.webExecution.operationMs[stage] || 0) + Date.now() - started; }
      };
      if (sourceChoice === "knowledge") return runKnowledgePreviewFirstLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName);
      const isHotel = String(layerSlot.moduleType).toLowerCase().includes("hotel");
      const knowledgeResult = null;
      const knowledgeError = null;
      const knowledgeScopeResolution = null;
      const knowledgeRawCandidates = [];
      const knowledgeCandidates = [];
      const commonsSkipped = Boolean(resumedPages || isHotel || webBudget.commonsCalled);
      const [pagesResult, commonsResult] = await Promise.allSettled([
        resumedPages ? Promise.resolve(resumedPages) : searchQueue.add(() => tracked("image_search", `${slot.slotId}:${layerName}`, async (recordAttempt) => withOneTechnicalRetry(async () => {
          recordAttempt(); metrics.searchCalls += 1;
          return webMeasure("searchProvider", () => searchFn({ queries: layerQueries, apiKey: searchApiKey, baseUrl: searchBaseUrl, model: searchModel, count: sourcePagesPerSlot, signal }));
        }, (error) => { metrics.technicalRetries.search += 1; warnings.push(`${layerName} 搜索技术重试：${error?.message || error}`); }))),
        commonsSkipped ? Promise.resolve([]) : searchQueue.add(async () => { webBudget.commonsCalled = true; metrics.commonsCalls += 1; return webMeasure("commons", () => commonsFn(layerQueries[0], { signal, count: downloadsPerSlot })); }),
      ]);
      evidence.searchCompleted = evidence.searchCompleted || (sourceChoice === "knowledge" ? knowledgeResult?.status === "completed" : pagesResult.status === "fulfilled");
      if (pagesResult.status === "rejected") warnings.push(`${layerName} 搜索失败：${pagesResult.reason?.message || pagesResult.reason}`);
      if (commonsResult.status === "rejected") warnings.push(`${layerName} Commons 搜索失败：${commonsResult.reason?.message || commonsResult.reason}`);
      if (commonsResult.status === "rejected") {
        evidence.commonsFailures ||= [];
        const error = commonsResult.reason;
        evidence.commonsFailures.push({ code: error?.code || "commons_search_failed", status: Number.isInteger(error?.status) ? error.status : null, challengeDetected: error?.challengeDetected === true });
      } else if (Array.isArray(commonsResult.value?.diagnostics)) {
        evidence.commonsDiagnostics ||= [];
        evidence.commonsDiagnostics.push(...commonsResult.value.diagnostics);
      }
      if (knowledgeError) warnings.push(`${layerName} 知识库搜索失败：${knowledgeError.message || knowledgeError}`);
      if (knowledgeResult?.status === "needs_clarification") warnings.push(`${layerName} 知识库需要明确目录范围`);
      if (knowledgeResult?.status === "failed") warnings.push(`${layerName} 知识库查询失败：${knowledgeResult.errorId || "unknown"}`);
      if (pagesResult.status === "fulfilled" && Array.isArray(pagesResult.value?.diagnostics)) {
        evidence.groundingRedirectUnresolved = pagesResult.value.diagnostics.filter((item) => item?.code === "grounding_redirect_unresolved");
        for (const item of evidence.groundingRedirectUnresolved) warnings.push(`${layerName} 搜索来源未解析：grounding_redirect_unresolved：${item.title || item.pageUrl}`);
      }
      const searchedPages = (pagesResult.status === "fulfilled" ? pagesResult.value : []).filter((item, index, array) => item?.pageUrl && array.findIndex((other) => other.pageUrl === item.pageUrl) === index);
      const queryReport = { query: layerQueries[0], allowance: { ...evidence.webExecution.currentAllowance }, returnedPages: searchedPages.length, accessedPages: 0, pageFailures: 0, effectivePages: 0, rawResources: 0, technicalFiltered: 0, resizeDuplicates: 0, relevanceFiltered: 0, downloadPool: 0, admittedCandidates: 0, deferredCandidates: 0, downloadAttempts: 0, downloadSuccess: 0, visionAudits: 0, selected: false };
      const sourceOutcome = (settled, count) => settled.status === "rejected" ? "failed" : count ? "success" : "success_empty";
      queryReport.sources = {
        web: { status: resumedPages ? "reused" : sourceOutcome(pagesResult, searchedPages.length), ...(pagesResult.status === "rejected" ? { errorCode: diagnosticCode(pagesResult.reason?.code) || "search_provider_failed", httpStatus: Number.isInteger(pagesResult.reason?.status) ? pagesResult.reason.status : null } : {}) },
        commons: { status: commonsSkipped ? "skipped" : sourceOutcome(commonsResult, Array.isArray(commonsResult.value) ? commonsResult.value.length : 0), ...(commonsResult.status === "rejected" ? { errorCode: diagnosticCode(commonsResult.reason?.code) || "commons_search_failed" } : {}) },
      };
      evidence.webExecution.queryReports.push(queryReport);
      queryReport.resumed = Boolean(resumedPages);
      const failureStart = evidence.pageFailures.length;
      const expandedPages = expandHotelSourcePages(searchedPages, layerSlot)
        .filter((page) => !webBudget.pageUrls.has(page.pageUrl))
        .sort((a, b) => pageSourcePriority(b, layerSlot) - pageSourcePriority(a, layerSlot) || basicScore(b, layerSlot) - basicScore(a, layerSlot));
      const availablePages = expandedPages.filter((page) => !retrievalSession?.unavailablePageReason?.(page.pageUrl));
      queryReport.cachedUnavailablePages = expandedPages.length - availablePages.length;
      const pageAllowance = evidence.webExecution.currentAllowance.pages;
      const selectedPages = availablePages.slice(0, pageAllowance);
      queryReport.deferredPages = availablePages.length - selectedPages.length;
      for (const page of availablePages.slice(pageAllowance)) if (!pendingPages.has(page.pageUrl)) pendingPages.set(page.pageUrl, { page, query: layerQueries[0] });
      for (const page of selectedPages) pendingPages.delete(page.pageUrl);
      if (resumedPages) evidence.webExecution.resumedPages = (evidence.webExecution.resumedPages || 0) + selectedPages.length;
      const allPages = selectedPages;
      queryReport.accessedPages = allPages.length;
      for (const page of allPages) webBudget.pageUrls.add(page.pageUrl);
      webBudget.pages += allPages.length;
      evidence.searchPages = (evidence.searchPages || 0) + allPages.length;
      evidence.searchPageUrls = unique([...(evidence.searchPageUrls || []), ...allPages.map((item) => item.pageUrl)]);
      evidence.officialSourcePages = (evidence.officialSourcePages || 0) + allPages.filter((item) => item.officialHint).length;
      const directCandidates = [...knowledgeCandidates, ...(commonsResult.status === "fulfilled" ? commonsResult.value : [])];
      const semanticTerms = unique([text(layerSlot.activity), text(layerSlot.subject), text(layerSlot.location), ...(isHotel ? [text(layerSlot.hotel), "hotel lodge camp tented suite guest room interior exterior public space lounge restaurant dining deck pool spa accommodation"] : []), ...(Array.isArray(layerSlot.searchKeywords) ? layerSlot.searchKeywords : []), ...layerQueries]);
      const extractedGroups = await Promise.all(allPages.map(async (page) => {
        try {
          // Legacy test adapters can own extraction; production shares only the raw page.
          if (adapters.extractPageImages) return await pageQueue.add(() => withOneTechnicalRetry(async () => { metrics.pageExtractionCalls += 1; return webMeasure("pageExtraction", () => extractFn(page, { signal, retrievalSession, maxImages: 24, semanticTerms })); }, (error) => { metrics.technicalRetries.pageExtraction += 1; warnings.push(`${layerName} 网页提图技术重试：${page.pageUrl}：${error?.message || error}`); }));
          const started = Date.now();
          try { return await extractFn(page, { signal, retrievalSession, maxImages: 24, semanticTerms, loadPage: async (url) => {
            const content = await loadPage(url);
            if (content.commonsApiFailure) {
              evidence.commonsApiFallbacks ||= [];
              evidence.commonsApiFallbacks.push({ pageUrl: url, ...commonsApiFailureSummary(content.commonsApiFailure), acquisitionMethod: content.acquisitionMethod || "http" });
            }
            return content;
          } }); }
          finally { evidence.webExecution.operationMs ||= {}; evidence.webExecution.operationMs.pageExtraction = (evidence.webExecution.operationMs.pageExtraction || 0) + Date.now() - started; }
        }
        catch (error) { retrievalSession?.rememberUnavailablePage?.(page.pageUrl, error); const classified = failureLayer(error); const failure = classified === "download" ? "page_fetch" : classified; evidence.pageFailures.push({ pageUrl: page.pageUrl, layer: failure, code: error?.code || null, status: Number.isInteger(error?.status) ? error.status : null, challengeDetected: error?.challengeDetected === true, ...(error?.commonsApiFailure ? { commonsApiFailure: commonsApiFailureSummary(error.commonsApiFailure) } : {}), reason: error?.message || String(error) }); warnings.push(`${layerName} 网页图片提取失败：${page.pageUrl}：${error?.message || error}`); return []; }
      }));
      evidence.semanticExtractionCompleted = true;
      const webPreparation = prepareWebCandidates([...extractedGroups.flat(), ...directCandidates]);
      const relevance = gateWebCandidates(webPreparation.candidates, { ...layerSlot, minimumVisualProof: layerConstraints.minimumVisualProof });
      queryReport.pageFailures = evidence.pageFailures.length - failureStart;
      queryReport.rawResources = webPreparation.before;
      queryReport.resizeDuplicates = webPreparation.filtered.filter(item => item.reason === 'resize_duplicate').length;
      queryReport.technicalFiltered = webPreparation.filtered.length - queryReport.resizeDuplicates;
      queryReport.relevanceFiltered = relevance.filtered.length;
      Object.assign(queryReport, relevance.counts, { insufficientInDownloadPool: 0, visionBatchSizes: [] });
      evidence.webExecution.relevanceCounts ||= { strong_match: 0, explicit_mismatch: 0, insufficient_evidence: 0, insufficientInDownloadPool: 0 };
      for (const [key,value] of Object.entries(relevance.counts)) evidence.webExecution.relevanceCounts[key] += value;
      const accepted = new Map(relevance.candidates.map(candidate => [candidate.imageUrl,candidate]));
      // Only pages actually opened for extraction consume the effective-page
      // budget. Provider-direct image provenance is not another page visit.
      const effective = new Set(allPages.filter((page, index) => extractedGroups[index].some(candidate => accepted.has(candidate.imageUrl))).map(page => page.pageUrl));
      queryReport.effectivePages = effective.size;
      queryReport.directSourcePages = new Set(directCandidates.filter(candidate => accepted.has(candidate.imageUrl)).map(candidate => candidate.pageUrl).filter(Boolean)).size;
      for (const url of effective) webBudget.effectivePages.add(url);
      queryReport.downloadPool = relevance.candidates.length;
      evidence.webCandidateFiltering ||= { before: 0, after: 0, filtered: [] };
      evidence.webCandidateFiltering.before += webPreparation.before;
      evidence.webCandidateFiltering.after += webPreparation.after;
      evidence.webCandidateFiltering.filtered.push(...webPreparation.filtered);
      evidence.webCandidateFiltering.filtered.push(...relevance.filtered);
      for (let i = 0; i < extractedGroups.length; i += 1) extractedGroups[i] = extractedGroups[i].filter(candidate=>accepted.has(candidate.imageUrl)).map(candidate=>accepted.get(candidate.imageUrl));
      for (let i = directCandidates.length - 1; i >= 0; i -= 1) { if (!accepted.has(directCandidates[i].imageUrl)) directCandidates.splice(i, 1); else directCandidates[i]=accepted.get(directCandidates[i].imageUrl); }
      const perPageCap = Math.max(2, Math.ceil(downloadsPerSlot / Math.max(1, allPages.length)));
      const diverseExtracted = extractedGroups.flatMap((group, index) => [...group].sort((a, b) => candidateRankScore(b, layerSlot) - candidateRankScore(a, layerSlot)).slice(0, isHotel && allPages[index]?.officialHint ? Math.max(4, downloadsPerSlot) : perPageCap));
      const returnedCandidates = uniqueImageAssets([...extractedGroups.flat(), ...directCandidates].filter((item) => item?.imageUrl && !webBudget.assets.has(webImageAssetKey(item.imageUrl))));
      const remainingDownloadBudget = Math.min(Math.max(0, downloadsPerSlot - webBudget.downloads), evidence.webExecution.currentAllowance.downloads);
      const rankedCandidates = uniqueImageAssets([...diverseExtracted, ...directCandidates].filter((item) => item?.imageUrl && !webBudget.assets.has(webImageAssetKey(item.imageUrl))).sort((a, b) => candidateRankScore(b, layerSlot) - candidateRankScore(a, layerSlot)));
      const propertyCandidates = isHotel ? rankedCandidates.filter((candidate) => webHotelPropertyPage(candidate.pageUrl, layerSlot)) : [];
      // Order target property pages first, then independently identifiable
      // images. Keep all remaining candidates at the tail: pre-download
      // evidence cannot safely become a new exclusion rule.
      const otherCandidates = rankedCandidates.filter((candidate) => !webHotelPropertyPage(candidate.pageUrl, layerSlot)
        && webHotelIdentityEvidence(candidate, layerSlot));
      const prioritizedCandidates = propertyCandidates.length
        ? [...propertyCandidates.slice(0, 1), ...otherCandidates.slice(0, 1), ...propertyCandidates.slice(1),
          ...otherCandidates.slice(1), ...rankedCandidates.filter((candidate) => !propertyCandidates.includes(candidate) && !otherCandidates.includes(candidate))]
        : rankedCandidates;
      const strongHotelCount = isHotel ? prioritizedCandidates.filter((item) => item.downloadRelevance?.state === "strong_match").length : 0;
      // Keep one weaker fallback if strong hotel evidence exists. Downloading
      // five weak homepage images beside one property image wastes the budget.
      const focusedAllowance = strongHotelCount ? Math.min(remainingDownloadBudget, strongHotelCount + 1) : remainingDownloadBudget;
      const rawCandidates = selectDiverseWebDownloads(prioritizedCandidates, focusedAllowance);
      const admittedKeys = new Set(rawCandidates.map(candidate => webImageAssetKey(candidate.imageUrl)));
      const rankedKeys = new Set(rankedCandidates.map(candidate => webImageAssetKey(candidate.imageUrl)));
      for (const candidate of returnedCandidates) {
        const key = webImageAssetKey(candidate.imageUrl);
        candidate.webDownloadAdmission = admittedKeys.has(key) ? "admitted" : "deferred";
        candidate.webDownloadDeferredReason = admittedKeys.has(key) ? null : rankedKeys.has(key) ? "query_download_allowance" : "source_diversity_limit";
        candidate.webQueries = [...layerQueries];
      }
      queryReport.admittedCandidates = rawCandidates.length;
      queryReport.deferredCandidates = returnedCandidates.length - rawCandidates.length;
      for (const candidate of rawCandidates) { webBudget.assets.add(webImageAssetKey(candidate.imageUrl)); candidate.candidateId = stableCandidateId(slot.slotId, candidate); }
      webBudget.downloads += rawCandidates.length;
      queryReport.insufficientInDownloadPool = rawCandidates.filter(candidate=>candidate.downloadRelevance?.state==='insufficient_evidence').length;
      evidence.webExecution.relevanceCounts.insufficientInDownloadPool += queryReport.insufficientInDownloadPool;
      const retainedCandidates = returnedCandidates.map((item) => ({ ...publicCandidate({ ...item, candidateId: stableCandidateId(slot.slotId, item) }, null, "not_auto_selected"), webQueries: [...layerQueries] }));
      const retain = (items) => mergePublicCandidates(retainedCandidates, items);
      evidence.extractedCandidates = (evidence.extractedCandidates || 0) + extractedGroups.flat().length + directCandidates.length;
      evidence.officialExtractedCandidates = (evidence.officialExtractedCandidates || 0) + extractedGroups.reduce((sum, group, index) => sum + (allPages[index]?.officialHint ? group.length : 0), 0);
      evidence.semanticRelevantCandidates = (evidence.semanticRelevantCandidates || 0) + extractedGroups.flat().filter((item) => Number(item.semanticScore || 0) > 0).length + directCandidates.filter((item) => Number(item.semanticScore || 0) > 0).length;
      const downloadedResults = await Promise.all(rawCandidates.map(async (candidate) => {
        const knowledgeRecord = evidence.knowledgeSearch?.candidates?.find((item) => item.recordId === candidate.knowledgeRecordId);
        try {
          const technical = await reuse(downloadCache, metrics.resourceReuse.images, `${candidate.imageUrl}:${resolutionCacheKey}`, () => downloadQueue.add(() => withOneTechnicalRetry(async () => {
            metrics.downloadAttempts += 1; evidence.downloadAttempts += 1;
            queryReport.downloadAttempts += 1;
            metrics.resourceReuse.images.attempts += 1;
            const metricKey = candidate.sourceKind === "knowledge_library" ? candidate.knowledgeRecordId : candidate.imageUrl;
            increment(metrics.resourceReuse.images.attemptsByUrl, metricKey);
            const result = await webMeasure("download", () => downloadFn(candidate, { directory: assetDirectory, publicPrefix, signal, retrievalSession, ...resolutionPolicy, onRequest: candidate.sourceKind === "knowledge_library" ? () => { metrics.resourceReuse.images.networkRequests += 1; increment(metrics.resourceReuse.images.networkRequestsByUrl, metricKey); } : networkEvent(metrics.resourceReuse.images), trustedKnowledgeOrigins }));
            return Object.fromEntries(["filePath", "publicUrl", "sha256", "width", "height", "bytes", "contentType", "sourceContentType", "sourceFormat", "sourceBytes", "conversion", "downloadedImageUrl", "downloadVariantAttempts", "acquisitionMethod"].map((key) => [key, result[key]]));
          }, (error) => { metrics.technicalRetries.download += 1; warnings.push(`${layerName} 候选下载技术重试：${error?.message || error}`); })));
          if (knowledgeRecord) knowledgeRecord.downloadStatus = "success";
          queryReport.downloadSuccess += 1;
          return { ...candidate, ...technical, originalDownloaded: true, originalDownloadStatus: "success", originalWidth: technical.width, originalHeight: technical.height };
        }
        catch (error) {
          const failure = failureLayer(error);
          const safeImageReference = candidate.sourceKind === "knowledge_library" ? candidate.knowledgeRecordId : candidate.imageUrl;
          evidence.downloadFailures.push({ imageUrl: safeImageReference, layer: failure, reason: error?.message || String(error) });
          if (knowledgeRecord) { knowledgeRecord.downloadStatus = "failed"; knowledgeRecord.failureReason = error?.message || String(error); }
          warnings.push(`${layerName} 候选下载失败：${error?.message || error}`);
          const retained = retainedCandidates.find((item) => item.candidateId === stableCandidateId(slot.slotId, candidate));
          if (retained) { retained.originalDownloadStatus = "failed"; retained.originalDownloadFailureCode = failure; retained.originalDownloadFailureReason = error?.message || String(error); }
          return null;
        }
      }));
      const downloaded = [];
      queryReport.contentDuplicates = 0;
      for (const candidate of downloadedResults.filter(item => item?.filePath && item?.sha256)) {
        // Downloaded duplicates remain traceable local candidates even though
        // they do not consume another visual judgment.
        const retained = retainedCandidates.find(item => item.candidateId === candidate.candidateId);
        if (retained) Object.assign(retained, publicCandidate(candidate, null, "not_auto_reviewed"));
        if (webBudget.hashes.has(candidate.sha256)) {
          queryReport.contentDuplicates += 1;
          if (retained) retained.webProcessingReason = "duplicate_downloaded_content";
          continue;
        }
        webBudget.hashes.add(candidate.sha256);
        downloaded.push(candidate);
      }
      downloaded.sort((a, b) => candidateRankScore(b, layerSlot) - candidateRankScore(a, layerSlot));
      evidence.downloadedCandidates = (evidence.downloadedCandidates || 0) + downloaded.length;
      if (!downloaded.length) {
        evidence.visualJudgmentCompleted = true;
        const knowledgeOnlyStatus = sourceChoice === "knowledge" ? evidence.knowledgeSearch?.status : null;
        const allSearchFailed = resolvedSourceMode === "knowledge_only"
          ? ["failed", "timeout"].includes(knowledgeOnlyStatus)
          : pagesResult.status === "rejected" && !allPages.length && !directCandidates.length;
        const layers = evidence.downloadFailures.map((item) => item.layer);
        const knowledgeTechnicalStatus = knowledgeOnlyStatus === "needs_clarification" ? "knowledge_needs_clarification" : knowledgeOnlyStatus === "timeout" ? "knowledge_timeout" : knowledgeOnlyStatus === "failed" ? "knowledge_failed" : knowledgeOnlyStatus === "completed" && knowledgeRawCandidates.length && !knowledgeCandidates.length ? "knowledge_no_valid_candidate" : knowledgeOnlyStatus === "completed" && !directCandidates.length ? "knowledge_not_found" : null;
        const technicalStatus = knowledgeTechnicalStatus || (allSearchFailed ? "search_failed" : !allPages.length && !directCandidates.length ? "no_search_results" : !evidence.extractedCandidates ? "page_extraction_empty" : layers.length && layers.every((item) => item === "size") ? "all_candidates_too_small" : layers.includes("decode") ? "candidate_decode_failed" : layers.includes("download") || layers.includes("page_access") ? "candidate_download_failed" : "no_technical_candidate");
        const kind = knowledgeOnlyStatus === "needs_clarification" ? "knowledge_needs_clarification" : allSearchFailed ? "search_failed" : "no_candidate";
        return { kind, candidates: retain([]), sourceEvidence: unique([...allPages.map((item) => item.pageUrl), ...knowledgeCandidates.map((item) => item.pageUrl)]), actualSubject: null, technicalStatus };
      }
      if (!visionEnabled) {
        for (const record of evidence.knowledgeSearch?.candidates || []) if (record.downloadStatus === "success") record.judgmentStatus = "visual_unavailable";
        return { kind: "visual_unavailable", candidates: retain(downloaded.map((item) => publicCandidate(item))), sourceEvidence: unique(downloaded.map((item) => item.pageUrl)), actualSubject: null, technicalStatus: "visual_judgment_unavailable" };
      }
      const judged = [];
      const sourceEvidence = unique(returnedCandidates.map((item) => item.pageUrl));
      const preserve = () => retain(mergePublicCandidates(downloaded.map((item) => publicCandidate(item, null, "not_auto_selected")), judged.map((item) => publicCandidate(item.candidate, item.audit, item.rejection))));
      const chooseBest = async () => {
        const eligible = judged.filter((item) => !item.rejection && item.audit?.eligible).sort((a, b) => auditQualityScore(b.audit, b.candidate, layerSlot) - auditQualityScore(a.audit, a.candidate, layerSlot));
        for (const item of eligible) {
          const duplicate = await withDedupeLock(item.candidate);
          if (!duplicate.accepted) { item.rejection = duplicate.reason; item.audit = finalizeAuditEligibility(item.audit, duplicate.reason); continue; }
          const selected = { ...publicCandidate(item.candidate, item.audit), autoReviewStatus: "auto_selected", selected: true, notAutoSelected: false, manualOnly: false, dHash: duplicate.dHash, aspectRatio: slot.aspectRatio };
          queryReport.selected = true;
          return { kind: "success", selected, candidates: mergePublicCandidates(preserve(), [selected]), sourceEvidence, actualSubject: item.audit.actualSubject, matchReason: item.audit.reason || "候选池择优", technicalStatus: "downloaded_decoded_and_judged" };
        }
        return null;
      };
      const batchSize = Math.max(1, Math.min(4, visionCandidatesPerSlot));
      evidence.webExecution.auditBatches ||= [];
      for (let offset = 0; offset < downloaded.length; offset += batchSize) {
        const wave = downloaded.slice(offset, offset + batchSize);
        let judgments;
        const started = Date.now();
        try {
          judgments = await visionQueue.add(() => tracked("visual_judgment", `${slot.slotId}:${layerName}:wave${offset / batchSize + 1}`, async (recordAttempt) => withOneTechnicalRetry(async (attempt) => {
            recordAttempt(); metrics.batchVisionCalls += 1;
            queryReport.visionAudits += wave.length;
            queryReport.visionBatchSizes.push(wave.length);
            return webMeasure("batchVision", () => judgeFn({ slot: { ...layerSlot, ...layerConstraints, label: text(layerSlot.subject) || slot.slotId, context: contextText(layerSlot.visualContext), module: layerSlot.moduleType }, candidates: wave, apiKey: visionApiKey, baseUrl: visionBaseUrl, model: visionModel, signal, allowContractRepair: attempt === 1, onContractRepair: recordContractRepair(recordAttempt, queryReport) }));
          }, (error) => { metrics.technicalRetries.vision += 1; warnings.push(`${layerName} 视觉判断技术重试：${error?.message || error}`); })));
        } catch (error) {
          warnings.push(`${layerName} 批量视觉判断未完成：${error?.message || error}`);
          const reviewStatus = error?.code === "audit_timeout" ? "review_timeout" : "not_auto_selected";
          return { kind: "visual_failed", candidates: retain(mergePublicCandidates(preserve(), wave.map((item) => publicCandidate(item, null, reviewStatus)))), sourceEvidence, technicalStatus: "visual_judgment_failed" };
        }
        evidence.webExecution.auditBatches.push({ candidateIds: wave.map((item) => item.candidateId), durationMs: Date.now() - started });
        const auditMap = new Map((Array.isArray(judgments) ? judgments : []).map((audit) => [audit?.candidateId, audit]));
        for (const candidate of wave) {
          const audit = applyWebImageIdentityEvidence(layerSlot, candidate, auditMap.get(candidate.candidateId));
          if (!completeVisualJudgment(audit)) { judged.push({ candidate, audit: audit || null, rejection: "needs_user_judgment" }); continue; }
          const hardRejection = failedHardRequirement(layerSlot, audit, candidate);
          const fallbackRejection = fallbackPlan ? controlledFallbackRejection(fallbackPlan, audit) : null;
          const rejection = hardRejection || fallbackRejection;
          if (!fallbackRejection && provisionalIdentityOnly(layerSlot, audit, candidate, hardRejection)) {
            rememberProvisional(slot.slotId, { candidate, audit, resolutionPolicy, sourceKind: "web" });
          }
          judged.push({ candidate, audit: finalizeAuditEligibility(audit, rejection), rejection });
        }
        const earlyStop = judged.some((item) => !item.rejection && item.audit?.eligible && (["exact", "exact_match"].includes(item.audit.matchLevel) || (Number(item.audit.score) >= 85 && Number(item.audit.relevance) >= 85)));
        if (earlyStop) {
          const selected = await chooseBest();
          if (selected) { evidence.webExecution.qualityStop = true; evidence.webExecution.qualityStopReason = ["exact", "exact_match"].includes(selected.selected.matchLevel) ? "exact" : "high_quality_eligible"; return selected; }
        }
        if (judged.some((item) => item.rejection === "needs_user_judgment")) {
          // An incomplete judgment must not hide a fully judged usable peer.
          const selected = await chooseBest();
          if (selected) return selected;
          return { kind: "inconclusive", candidates: preserve(), sourceEvidence, technicalStatus: "visual_judgment_inconclusive" };
        }
      }
      evidence.visualJudgmentCompleted = true;
      const selected = await chooseBest();
      if (selected) return selected;
      const unresolved = judged.some((item) => ["needs_user_judgment", "hotel_identity_unconfirmed"].includes(item.rejection));
      return { kind: unresolved ? "inconclusive" : "no_eligible", candidates: preserve(), sourceEvidence, actualSubject: judged.find((item) => item.audit?.actualSubject)?.audit.actualSubject || null, technicalStatus: unresolved ? "visual_judgment_inconclusive" : "no_eligible_candidate" };
    }

    async function runLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName, fallbackPlan = null) {
      evidence.explicitEntityFastPath = { ...explicitEntityRoute(layerSlot), enteredWeb: false, webQueries: [], finalSource: null, knowledgeStopReason: null };
      evidence.explicit_entity_fast_path = evidence.explicitEntityFastPath.matched;
      if (resolvedSourceMode === "web_only") return runSourceLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName, fallbackPlan, "web");
      const knowledgeStarted = Date.now();
      const knowledge = await runSourceLayer(layerSlot, layerConstraints, layerQueries, evidence, layerName, fallbackPlan, "knowledge");
      evidence.knowledgeWallClockMs = Date.now() - knowledgeStarted;
      const route = evidence.explicitEntityFastPath;
      if (evidence.knowledgeSearch) {
        evidence.knowledgeSearch.knowledgeQueryExecuted = Boolean(evidence.knowledgeSearch.attempts?.length);
        if (!evidence.knowledgeSearch.knowledgeQueryExecuted && evidence.knowledgeSearch.status === "completed") evidence.knowledgeSearch.status = "not_executed";
      }
      if (route.matched) {
        const search = evidence.knowledgeSearch;
        route.parentProbeUsed = Boolean(search?.scopePlan?.scopes?.some(scope => scope.role === "entity_parent_probe"));
        route.knowledgeStopReason = !route.identityKnown ? "identity_unknown"
          : ["knowledge_scope_unresolved", "knowledge_hotel_scope_unresolved", "knowledge_entity_directory_missing"].includes(knowledge.technicalStatus) ? "entity_directory_missing"
          : knowledge.kind === "success" ? null
          : ["no_candidate", "no_eligible"].includes(knowledge.kind)
            ? search?.scopeState === "empty" || search?.scopeState === "unavailable" ? "entity_directory_empty" : "entity_directory_no_match" : null;
        if (knowledge.kind === "success") route.finalSource = "knowledge_library";
        if (route.knowledgeStopReason === "entity_directory_missing" && search) {
          search.status = "entity_directory_missing";
          search.failureReason = route.knowledgeStopReason;
          search.message = "明确实体目录未定位，未执行地区/国家扩搜";
          search.entityType = route.entityType;
        }
        if (route.knowledgeStopReason === "identity_unknown" && search) {
          search.status = "target_identity_unresolved";
          search.failureReason = "target_identity_unresolved";
          search.message = "原始目标实体身份不明确，保留人工处理";
        }
      }
      if (resolvedSourceMode === "knowledge_only" || knowledge.kind === "success") return knowledge;
      if (route.parentProbeUsed && knowledge.kind === "knowledge_needs_clarification") {
        evidence.sourceFallback = { entered: false, reason: "entity_parent_probe_needs_clarification", knowledgeStatus: knowledge.technicalStatus };
        return knowledge;
      }
      const fallback = classifyWebFallback(knowledge, layerSlot, route, layerQueries);
      evidence.sourceFallback = { entered: false, reason: fallback.reason, knowledgeStatus: knowledge.technicalStatus || knowledge.kind };
      if (!fallback.allowed) return knowledge;
      metrics.knowledgeFirstWebFallbacks += 1;
      evidence.sourceFallback = {
        entered: true,
        from: "knowledge_library",
        to: "web",
        reason: fallback.reason,
        knowledgeStatus: knowledge.technicalStatus || knowledge.kind,
      };
      const web = await runSourceLayer(layerSlot, layerConstraints, layerQueries, evidence, `${layerName}:web`, fallbackPlan, "web");
      route.enteredWeb = true;
      route.webQueries = [...(evidence.webExecution?.executedQueries || [])];
      if (web.kind === "success") route.finalSource = "web";
      return summarizeWebCandidatePool({
        ...web,
        candidates: [...(knowledge.candidates || []), ...(web.candidates || [])],
        sourceEvidence: unique([...(knowledge.sourceEvidence || []), ...(web.sourceEvidence || [])]),
        knowledgeFallbackReason: knowledge.technicalStatus || knowledge.kind,
      }, evidence);
    }

    const exact = await runLayer(slot, constraints, queriesUsed, pipelineEvidence, "exact");
    const exactCandidates = exact.candidates || [];
    const fallbackDiagnostic = exact.knowledgeFallbackReason ? { knowledgeFallbackReason: exact.knowledgeFallbackReason } : {};
    if (exact.kind === "success") {
      pipelineEvidence.exactMatchSuccess = true;
      const auditedMatchLevel = exact.selected?.matchLevel || exact.selected?.hardJudgment?.matchLevel;
      const matchLevel = auditedMatchLevel === "representative" ? "representative" : "exact_match";
      const selected = { ...exact.selected, matchLevel };
      return { slotId: slot.slotId, status: "success", matchLevel, selected, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: exact.matchReason, technicalStatus: exact.technicalStatus, ...fallbackDiagnostic, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    if (exact.kind === "knowledge_needs_clarification") {
      return { slotId: slot.slotId, status: "needs_user_action", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: null, matchReason: "知识库存在同名目录，需要明确 scope / node_id", technicalStatus: exact.technicalStatus, ...fallbackDiagnostic, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    if (["visual_unavailable", "visual_failed", "inconclusive"].includes(exact.kind)) {
      return { slotId: slot.slotId, status: "needs_user_action", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: exact.matchReason || "精确视觉判断未完成，不得进入 fallback", technicalStatus: exact.technicalStatus, ...fallbackDiagnostic, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    if (exact.kind === "search_failed") {
      return { slotId: slot.slotId, status: "failed", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: resolvedSourceMode === "knowledge_only" ? "知识库查询失败，未调用公网搜索" : "精确搜索失败，未进入 fallback", technicalStatus: exact.technicalStatus, ...fallbackDiagnostic, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }
    if (resolvedSourceMode === "knowledge_only") {
      return { slotId: slot.slotId, status: "not_found", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: exact.matchReason || "知识库未找到可用候选，未调用公网搜索", technicalStatus: exact.technicalStatus, ...fallbackDiagnostic, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
    }

    return { slotId: slot.slotId, status: "not_found", matchLevel: null, selected: null, candidates: exactCandidates, queriesUsed, sourceEvidence: exact.sourceEvidence, actualSubject: exact.actualSubject, matchReason: exact.matchReason || "当前图片位的 Query Plan 与 Scope Plan 均未找到合格候选", technicalStatus: exact.technicalStatus, ...fallbackDiagnostic, pipelineEvidence, warnings, constraints, durationMs: Date.now() - slotStartedAt };
  }

  let completedSlots = 0;
  onCapabilityCall?.({ phase: "slot_progress", capabilityId: "image_slot_progress", completedSlots, totalSlots: slots.length });
  const results = await Promise.all([...slots].sort((a, b) => imageSlotPriority(a) - imageSlotPriority(b)).map((slot) => slotQueue.add(async () => {
    try {
      const result = await processSlot(slot);
      return { ...result, pipelineEvidence: { ...(result.pipelineEvidence || {}), searchTrace: buildImagePipelineStageTrace(slot, result, resolvedSourceMode) }, searchDiagnostic: buildImageSearchDiagnostic(result) };
    } catch (error) {
      const result = { slotId: slot?.slotId || null, status: "failed", selected: null, candidates: [], queriesUsed: [], sourceEvidence: [], actualSubject: null, matchReason: error?.message || String(error), technicalStatus: "slot_failed", warnings: [], constraints: null, durationMs: 0 };
      return { ...result, pipelineEvidence: { searchTrace: buildImagePipelineStageTrace(slot, result, resolvedSourceMode) }, searchDiagnostic: buildImageSearchDiagnostic(result) };
    }
    finally { completedSlots += 1; onCapabilityCall?.({ phase: "slot_progress", capabilityId: "image_slot_progress", completedSlots, totalSlots: slots.length, target: slot.slotId }); }
  })));
  // Formal selections have already reserved their files in the deduper. Only
  // now may a fully judged, identity-only unresolved image be used in a draft.
  const resultById = new Map(results.map((result) => [result.slotId, result]));
  for (const slot of [...slots].sort((a, b) => imageSlotPriority(a) - imageSlotPriority(b))) {
    const result = resultById.get(slot.slotId);
    if (!result || result.status === "success" || result.selected || slot.userLocked) continue;
    const entries = [...(provisionalPool.get(slot.slotId) || [])]
      .sort((a, b) => auditQualityScore(b.audit, b.candidate, slot) - auditQualityScore(a.audit, a.candidate, slot));
    let originalAttempts = 0;
    for (const entry of entries) {
      let original = entry.candidate;
      if (entry.sourceKind === "knowledge_library" && original.originalDownloaded !== true) {
        if (originalAttempts >= Number(entry.remainingOriginalBudget?.() || 0)) continue;
        const matched = original.knowledgeMatchedFile;
        if (!matched?.url) continue;
        originalAttempts += 1;
        metrics.matchedFileDownloadAttempts += 1;
        metrics.downloadAttempts += 1;
        try {
          const technical = await downloadQueue.add(() => measure("originalDownload", () => downloadFn({ ...original, imageUrl: matched.url, title: matched.filename || original.title }, { directory: assetDirectory, publicPrefix, signal, retrievalSession, ...entry.resolutionPolicy, trustedKnowledgeOrigins })));
          metrics.matchedFileDownloadSuccess += 1;
          metrics.originalDownloadSavedCount += 1;
          original = { ...original, ...technical, originalDownloaded: true, originalDownloadStatus: "success" };
        } catch (error) {
          const failed = publicCandidate({ ...original, originalDownloadStatus: "failed", originalDownloadFailureCode: error?.code === "image_resolution_insufficient" ? "resolution_failed" : "preview_found_original_download_failed", originalDownloadFailureReason: error?.message || String(error) }, entry.audit, "preview_found_original_download_failed");
          result.candidates = mergePublicCandidates(result.candidates, [failed]);
          continue;
        }
      }
      if (!original.filePath || !original.publicUrl || !original.sha256) continue;
      const duplicate = await withDedupeLock(original);
      if (!duplicate.accepted) continue;
      const provisionalSelected = {
        ...publicCandidate({ ...original, originalDownloaded: true }, entry.audit, "needs_user_judgment"),
        localUrl: original.publicUrl,
        originalDownloaded: true,
        dHash: duplicate.dHash,
        aspectRatio: slot.aspectRatio,
        provisional: true,
        selected: false,
        candidateStatus: "provisional_pending_confirmation",
        autoReviewStatus: "identity_pending_confirmation",
      };
      result.provisionalSelected = provisionalSelected;
      result.status = "needs_user_action";
      result.matchReason = "主体与必要动作已审核，具体实体身份仍待人工确认";
      result.technicalStatus = "identity_evidence_pending_confirmation";
      result.candidates = mergePublicCandidates(result.candidates, [provisionalSelected]);
      break;
    }
  }
  const stageOutcomes = {
    plannerUnresolved: results.filter((item) => item.pipelineEvidence?.searchTrace?.planner.status === "unresolved").length,
    hierarchyUnavailable: results.filter((item) => ["failed", "timeout"].includes(item.pipelineEvidence?.searchTrace?.hierarchy.status)).length,
    directoryUnresolved: results.filter((item) => ["unresolved", "ambiguous"].includes(item.pipelineEvidence?.searchTrace?.directory.status)).length,
    knowledgeQueried: results.filter((item) => item.pipelineEvidence?.searchTrace?.knowledgeQuery.attempts > 0).length,
    knowledgeEmpty: results.filter((item) => item.pipelineEvidence?.searchTrace?.knowledgeQuery.status === "completed_empty").length,
    webEntered: results.filter((item) => item.pipelineEvidence?.searchTrace?.web.entered).length,
    autoAdopted: results.filter((item) => item.pipelineEvidence?.searchTrace?.terminal.status === "auto_adopted").length,
  };
  const knowledgeSlotOutcomes = {
    selected: results.filter((item) => item.status === "success" && item.selected?.sourceKind === "knowledge_library").length,
    notFound: results.filter((item) => item.status === "not_found").length,
    needsClarification: results.filter((item) => item.technicalStatus === "knowledge_needs_clarification").length,
    failedOrTimeout: results.filter((item) => ["knowledge_failed", "knowledge_timeout"].includes(item.technicalStatus)).length,
  };
  metrics.previewAuditTimeMs = timingsMs.previewAudit;
  metrics.originalDownloadTimeMs = timingsMs.originalDownload;
  if (ownsRetrievalSession) await retrievalSession.close();
  metrics.imageRetrieval = retrievalSession.getDiagnostics();
  return { batchId, status: resultStatus(results), results, warnings: [], metrics: { ...metrics, stageOutcomes, knowledgeHierarchy: knowledgeScopeResolver.hierarchyStats(), knowledgeAverageSlotSearchMs: metrics.knowledgeCalls ? Math.round(timingsMs.knowledgeSearch / metrics.knowledgeCalls) : 0, knowledgeSlotOutcomes, knowledgeOnlyVerified: resolvedSourceMode === "knowledge_only" && metrics.searchCalls === 0 && metrics.commonsCalls === 0, concurrencyPeak: { slots: slotQueue.peak, search: searchQueue.peak, pages: pageQueue.peak, downloads: downloadQueue.peak, vision: visionQueue.peak }, durationMs: Date.now() - startedAt } };
  } finally {
    if (ownsRetrievalSession) await retrievalSession.close();
  }
}

export function imageSlotPriority(slot) {
  if (slot.moduleType === "day" && slot.required) return 0;
  if (slot.required) return 1;
  return slot.moduleType === "day" ? 2 : 3;
}
