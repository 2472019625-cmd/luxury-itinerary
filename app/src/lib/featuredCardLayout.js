const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const TEXT_FIELDS = {
  hotel: ["shortName", "officialName", "region", "editorialCopy"],
  dining: ["title", "officialName", "location", "editorialCopy"],
  transport: ["category", "serviceLevel", "usageLabel", "model", "editorialCopy"],
};

function itemText(item, module) {
  const fields = TEXT_FIELDS[module] || Object.keys(item || {});
  const direct = fields.map((field) => item?.[field]);
  const lists = [item?.proofPoints, item?.features].flat().filter(Boolean);
  return clean([...direct, ...lists].join(" "));
}

function stableKey(item, module) {
  const text = itemText(item, module).toLocaleLowerCase("zh-CN");
  return `${clean(item?.id).toLocaleLowerCase("zh-CN")}|${text}`;
}

function imageScore(item) {
  const images = (item?.images?.length ? item.images : item?.image ? [item.image] : []).filter(Boolean);
  if (!images.length) return 0;
  const bestMetadataScore = images.reduce((best, image) => {
    if (!image || typeof image !== "object") return best;
    const width = Number(image.width || image.naturalWidth || image.audit?.width || 0);
    const height = Number(image.height || image.naturalHeight || image.audit?.height || 0);
    const quality = Number(image.qualityScore || image.score || image.audit?.score || 0);
    const resolution = width > 0 && height > 0 ? Math.min(12, (width * height) / 1_000_000 * 2) : 0;
    const subject = clean(image.actualSubject || image.label || image.alt) ? 4 : 0;
    return Math.max(best, Math.min(18, quality) + resolution + subject);
  }, 0);
  return 18 + Math.min(images.length, 2) * 3 + bestMetadataScore;
}

function explicitPriorityScore(item) {
  if (item?.layout === "wide") return 1000;
  if (item?.featured === true || item?.isFeatured === true || item?.isCore === true || item?.core === true) return 800;
  const value = clean(item?.priority || item?.importance || item?.role).toLowerCase();
  if (/^(?:featured|hero|core|primary|high|signature|重点|核心|特色)$/.test(value)) return 620;
  const numeric = Number(item?.priorityScore ?? item?.businessPriority);
  return Number.isFinite(numeric) ? Math.max(-100, Math.min(500, numeric)) : 0;
}

function contentCompletenessScore(item, module) {
  const fields = TEXT_FIELDS[module] || [];
  const populatedFields = fields.filter((field) => clean(item?.[field])).length;
  const textLength = itemText(item, module).length;
  const supportingPoints = [item?.proofPoints, item?.features].flat().filter((value) => clean(value)).length;
  return populatedFields * 4 + Math.min(12, textLength / 40) + Math.min(8, supportingPoints * 2);
}

function duplicatePenalty(item, items, module) {
  const signature = itemText(item, module).toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
  if (!signature) return 0;
  const duplicates = items.filter((candidate) => itemText(candidate, module).toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "") === signature).length;
  return duplicates > 1 ? -80 * (duplicates - 1) : 0;
}

export function featuredCardScore(item, module, items = []) {
  return explicitPriorityScore(item) + contentCompletenessScore(item, module) + imageScore(item) + duplicatePenalty(item, items, module);
}

function nearestPairedBoundary(originalIndex, remainingCount) {
  const center = remainingCount / 2;
  return Array.from({ length: Math.floor(remainingCount / 2) + 1 }, (_, index) => index * 2)
    .sort((left, right) => (
      Math.abs(left - originalIndex) - Math.abs(right - originalIndex)
      || Math.abs(left - center) - Math.abs(right - center)
      || left - right
    ))[0];
}

export function deriveFeaturedCardLayout(items = [], module = "") {
  const entries = items.map((item, originalIndex) => ({ item, originalIndex, isFeatured: item?.layout === "wide" }));
  if (entries.length < 3 || entries.length % 2 === 0) {
    return { entries, hasFeatured: entries.some((entry) => entry.isFeatured) };
  }

  const ranked = entries.map((entry) => ({
    ...entry,
    score: featuredCardScore(entry.item, module, items),
    key: stableKey(entry.item, module),
  })).sort((left, right) => right.score - left.score || (left.key < right.key ? -1 : left.key > right.key ? 1 : left.originalIndex - right.originalIndex));
  const featuredIndex = ranked[0].originalIndex;
  const featured = { ...entries[featuredIndex], isFeatured: true };
  const remaining = entries.filter((entry) => entry.originalIndex !== featuredIndex).map((entry) => ({ ...entry, isFeatured: false }));
  const insertionIndex = nearestPairedBoundary(featuredIndex, remaining.length);
  const arranged = [...remaining];
  arranged.splice(insertionIndex, 0, featured);
  return { entries: arranged, hasFeatured: true };
}
