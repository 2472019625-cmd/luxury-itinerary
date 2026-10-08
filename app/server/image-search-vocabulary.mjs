// A deliberately small, versioned vocabulary for rejected planner targets.
// Matching is bounded; fact binding and unchanged hard requirements are checked
// by the caller. The separate business overview entry also normalizes ready
// ordinary vehicle poses; the older OR entries still require rejected targets.
export const IMAGE_SEARCH_VOCABULARY_VERSION = "image-search-vocabulary-v1";
export const BUSINESS_TRANSFER_OVERVIEW_VERSION = "business-transfer-overview-v1";
const clean = value => typeof value === "string" ? value.trim() : "";
const choice = /或者|或|二选一|\bor\b|\//i;
const entries = [
  { id: "bush-plane", module: "transport", subject: "草原小飞机", subjectEn: "light bush plane",
    aliases: ["草原飞机", "草原小飞机", "轻型草原飞机", "轻型草原小飞机"],
    english: /^(?:(?:light|small|lightweight)\s+)?bush\s+(?:plane|aircraft)$/i,
    action: /^(?:乘客)?(?:登机或下机|登机或下飞机|上机或下机|上下机)$/,
    actionEn: /^(?:passengers?\s+)?(?:boarding\s+or\s+disembarking|boarding\s+or\s+alighting)$/i,
    scenery: /停降|停靠|停放|在|于|草原|跑道|机场|乘客|登机|下机|下飞机|上机|上下机|或者|或/g,
    promised: /登机|下机|上下机|起飞|降落|起降|航拍|空中观光|观景飞行|低空飞越|\b(?:boarding|disembarking|landing|takeoff|scenic|aerial)\b/i },
  { id: "business-transfer", module: "transport", subject: "商务用车", subjectEn: "chauffeured business vehicle",
    aliases: ["商务用车", "商务车", "商务接待车辆", "商务接送车辆"],
    english: /^(?:chauffeured\s+)?business\s+(?:car|vehicle|transfer vehicle)$/i,
    action: /^接送乘客$/, actionEn: /^(?:picking up passengers|transporting passengers|passenger transfer)$/i,
    scenery: /接送乘客|在|于|城市|市区|机场|道路|或者|或/g },
  { id: "leopard-display", module: "day", subject: "花豹", subjectEn: "leopard", aliases: ["花豹"], english: /^leopards?$/i,
    action: /^(?:在树上)?(?:休息或观察|休息或警戒)$/,
    actionEn: /^(?:resting(?: in (?:a )?tree)?|resting or (?:watching|observing|alert))$/i,
    scenery: /趴在|在|草原|上|树枝|树上|地面|休息|观察|警戒|或者|或/g,
    promised: /树上|树枝|休息|警戒|捕猎|猎杀|追逐|攀爬|爬树|保证|必见|不得|不能|不含|不安排|\b(?:resting|hunting|climbing|guaranteed)\b/i },
];

// Ordinary transport overviews have a confirmed vehicle category, not a
// promised driving experience. Keep this separate from the older OR repairs.
export function lookupBusinessTransferOverview(slot, transport) {
  const entry = entries.find(item => item.id === "business-transfer");
  const core = slot.queryCore || {};
  const englishCategory = /^(?:(?:chauffeured\s+)?business\s+(?:car|van|vehicle|transfer vehicle)|business_transfer_vehicle)$/i;
  const category = value => !clean(value) || entry.aliases.includes(clean(value)) || englishCategory.test(clean(value));
  if (!transport || slot.userLocked || slot.exactIdentityRequired !== false || slot.locationRole !== "scope_only"
    || transport.modelGuaranteed || clean(transport.model)
    || ![transport.category, transport.serviceLevel].some(value => entry.aliases.includes(clean(value)))
    || !entry.aliases.includes(clean(core.subject)) || !category(core.subjectEn)
    || !category(core.identity) || !category(core.identityEn)) return null;
  if (!/^(?:(?:在|于)?(?:城市|市区)?(?:公路|道路|街道)?上?)?(?:行驶|停靠|停放)$/.test(clean(core.action))
    || !/^(?:(?:driving|parked|stopped)(?:\s+(?:on|in|at|along)\s+(?:(?:a|the)\s+)?(?:(?:city|urban)\s+)?(?:road|street|airport))?)?$/i.test(clean(core.actionEn))) return null;
  const visual = clean(slot.primaryVisualSubject);
  if (!visual || choice.test(visual)
    || /乘客|登车|上车|下车|上下客|迎宾|开门|行李|游猎|飞机|船|骑行|奔驰|丰田|宝马|车型|品牌|型号|体验|观景|观星|摄影|拍摄|指定|专属|保证|不得|不能|不安排|passenger|boarding|alighting|welcome|luggage|safari|plane|boat|bicycle|mercedes|toyota|bmw|guaranteed/i.test(visual)) return null;
  return { id: "business-transfer-overview", subject: "商务用车", subjectEn: "business transfer vehicle" };
}

export function lookupImageSearchVocabulary(slot) {
  const core = slot.queryCore || {};
  if (slot.userLocked || slot.exactIdentityRequired !== false || slot.locationRole !== "scope_only"
    || clean(core.identity) || clean(core.identityEn)) return null;
  const module = clean(slot.role).split(":")[0] || slot.moduleType;
  const entry = entries.find(item => item.module === module && item.aliases.includes(clean(core.subject))
    && item.english.test(clean(core.subjectEn)) && item.action.test(clean(core.action)) && item.actionEn.test(clean(core.actionEn)));
  if (!entry || !choice.test(clean(slot.primaryVisualSubject))) return null;
  // Every non-punctuation fragment must belong to this entry. An extra animal,
  // vehicle type, named airport or new activity cannot disappear in a repair.
  let remaining = clean(slot.primaryVisualSubject);
  for (const alias of [...entry.aliases].sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(alias, "");
  remaining = remaining.replace(entry.scenery, "").replace(/[\s，,。.;；]+/g, "");
  if (remaining) return null;
  return entry;
}

export function vocabularySourceAllows(entry, sourceText) {
  return !/保证|必见|仅限|不得|不能|不含|不安排|\b(?:guaranteed|excluded)\b/i.test(sourceText)
    && !entry.promised?.test(sourceText);
}
