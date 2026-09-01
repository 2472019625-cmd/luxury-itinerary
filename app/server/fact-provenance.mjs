const FACT_TERMS = [
  '私人保护区','泳池','水疗','SPA','健身房','餐厅','酒吧','保险箱','房间','客房','帐篷营地','营地',
  '狮子','猎豹','花豹','大象','黑犀牛','非洲五霸','五霸','兽群','渡河','迁徙','动物饮水',
  '热气球','徒步','夜间游猎','浮潜','潜水','反偷猎观察站','马赛部落','草原飞机','敞篷越野车','四驱动敞篷式越野车',
  '包场','活动开放','营业时间',
];

const FACTUAL_MARKER = /位于|坐落|毗邻|(?:距|距离).{0,12}(?:公里|分钟|小时|机场|公园|保护区)|仅有\d|共有\d|房间|泳池|水疗|SPA|健身房|餐厅|酒吧|私密|狮子|猎豹|花豹|大象|黑犀牛|五霸|兽群|渡河|迁徙|热气球|徒步|夜间游猎|浮潜|潜水|包场|活动开放|营业时间|反偷猎观察站|马赛部落/i;
export const TIME_SENSITIVE_CONTEXT = /签证|入境|海关|检疫|疫苗|黄热病|健康|运营季节|迁徙季节|季节窗口/i;
export const SPECIFIC_TIME_CLAIM = /\d+\s*(?:个?月|天|年|美元|美金|元)|\d{1,2}\s*月\s*(?:至|到|-|—)\s*\d{1,2}\s*月/i;

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const list = (value) => Array.isArray(value) ? value : [];
const canonical = (value) => text(value).toLowerCase().replace(/[，。！？、；：,.!?;:\s”“"'（）()—→\-]/g, '');
const unique = (items) => [...new Set(items.filter(Boolean))];

function record(sourcePath, value) {
  const content = text(value);
  return content ? { sourcePath, text: content } : null;
}

function objectText(value) {
  if (Array.isArray(value)) return value.map(objectText).filter(Boolean).join('；');
  if (!value || typeof value !== 'object') return text(value);
  return Object.values(value).map(objectText).filter(Boolean).join('；');
}

function dayRecords(day = {}, index, suffix = '') {
  const base = `days.${index}${suffix}`;
  return [
    record(`${base}.route`, list(day.routeNodes).join(' → ')), record(`${base}.city`, day.city), record(`${base}.theme`, day.theme),
    record(`${base}.description`, day.description), record(`${base}.hotel`, day.hotel), record(`${base}.vehicle`, day.vehicle),
    record(`${base}.mealPlan`, objectText(day.mealPlan)), record(`${base}.estimatedTravelTime`, day.estimatedTravelTime),
    ...list(day.spots).flatMap((spot, spotIndex) => [
      record(`${base}.spots.${spotIndex}.name`, spot.name), record(`${base}.spots.${spotIndex}.description`, spot.description),
      ...list(spot.sourceEvidence).map((entry, evidenceIndex) => record(`${base}.spots.${spotIndex}.sourceEvidence.${evidenceIndex}`, entry)),
    ]),
  ].filter(Boolean);
}

export function sourceRecordsForPath(path = '', sourceData = {}) {
  let match = String(path).match(/^hotels\.(\d+)/);
  if (match) {
    const index = Number(match[1]); const hotel = list(sourceData.hotels)[index] || {};
    const names = [hotel.officialName, hotel.shortName].filter(Boolean);
    const relatedDays = list(sourceData.days).flatMap((day, dayIndex) => names.some((name) => text(day.hotel).includes(text(name)) || text(name).includes(text(day.hotel))) ? dayRecords(day, dayIndex) : []);
    return [
      record(`hotels.${index}.identity`, [hotel.officialName, hotel.shortName, hotel.region, hotel.roomType, hotel.mealPlan, Number.isFinite(Number(hotel.nights)) ? `${hotel.nights}晚` : ''].filter(Boolean).join('；')),
      ...list(hotel.sourceEvidence).map((entry, evidenceIndex) => record(`hotels.${index}.sourceEvidence.${evidenceIndex}`, entry)), ...relatedDays,
    ].filter(Boolean);
  }
  match = String(path).match(/^transportSummary\.(\d+)/);
  if (match) {
    const index = Number(match[1]); const item = list(sourceData.transportSummary)[index] || {};
    const transportTerms = [item.category, item.serviceLevel, item.model].map(text).filter(Boolean);
    const relatedDays = list(sourceData.days).flatMap((day, dayIndex) => transportTerms.some((term) => text(day.vehicle).includes(term) || term.includes(text(day.vehicle))) ? dayRecords(day, dayIndex) : []);
    return [
      record(`transportSummary.${index}.identity`, [item.category, item.serviceLevel, item.model, item.seatCount ? `${item.seatCount}座` : '', ...list(item.usageSegments)].filter(Boolean).join('；')),
      ...list(item.sourceEvidence).map((entry, evidenceIndex) => record(`transportSummary.${index}.sourceEvidence.${evidenceIndex}`, entry)), ...relatedDays,
    ].filter(Boolean);
  }
  match = String(path).match(/^days\.(\d+)/);
  if (match) {
    const index = Number(match[1]); const days = list(sourceData.days);
    return [
      ...dayRecords(days[index] || {}, index),
      ...(index > 0 ? dayRecords(days[index - 1] || {}, index - 1, '.previous_context') : []),
      ...(days[index + 1] ? dayRecords(days[index + 1], index + 1, '.next_context') : []),
    ];
  }
  match = String(path).match(/^(includedCustomer|excludedCustomer|cancellationCustomer)\.(\d+)/);
  if (match) {
    const sourceKey = match[1] === 'includedCustomer' ? 'included' : match[1] === 'excludedCustomer' ? 'excluded' : 'cancellation';
    const index = Number(match[2]);
    return [record(`${sourceKey}.${index}`, list(sourceData[sourceKey])[index])].filter(Boolean);
  }
  if (String(path).startsWith('notes')) {
    return [
      ...['included','excluded','cancellation','importPendingConfirmations'].flatMap((key) => list(sourceData[key]).map((entry, index) => record(`${key}.${index}`, objectText(entry)))),
      ...list(sourceData.days).flatMap((day, index) => dayRecords(day, index)),
      ...list(sourceData.authoritativeFacts).map((entry, index) => record(`authoritativeFacts.${index}`, entry?.statement)),
    ].filter(Boolean);
  }
  return [record('source', objectText(sourceData))].filter(Boolean);
}

function factualFields(data = {}) {
  return [
    ...list(data.hotels).flatMap((item, index) => [[`hotels.${index}.editorialCopy`, item.editorialCopy], [`hotels.${index}.proofPoints`, list(item.proofPoints).join('；')]]),
    ...list(data.diningExperiences).map((item, index) => [`diningExperiences.${index}.editorialCopy`, item.editorialCopy]),
    ...list(data.transportSummary).map((item, index) => [`transportSummary.${index}.editorialCopy`, item.editorialCopy]),
    ...list(data.days).flatMap((day, index) => [[`days.${index}.theme`, day.theme], [`days.${index}.description`, day.description]]),
    ...list(data.notes).map((item, index) => [`notes.${index}`, `${item?.title || ''} ${list(item?.items).join('；')}`]),
  ];
}

function sentenceClaims(sentence) {
  const result = FACT_TERMS.filter((term) => text(sentence).toLowerCase().includes(term.toLowerCase()));
  const numeric = text(sentence).match(/\d+(?:\.\d+)?\s*(?:晚|间|座|公里|分钟|小时)/g) || [];
  return unique([...result, ...numeric.map((item) => item.replace(/\s+/g, ''))]);
}

function claimSupported(claim, records, validEvidence) {
  const needle = canonical(claim);
  return [...records, ...validEvidence].some((item) => canonical(item.text || item).includes(needle));
}

function validatedEvidence(path, data, sourceData) {
  const corpus = canonical(JSON.stringify(sourceData));
  return list(data.copyEvidence?.[path]).map(text).filter((entry) => entry && corpus.includes(canonical(entry))).map((entry) => ({ sourcePath: `copyEvidence.${path}`, text: entry }));
}

export function buildFactProvenanceReport(data = {}, sourceData = {}) {
  const entries = [];
  for (const [path, value] of factualFields(data)) {
    const records = sourceRecordsForPath(path, sourceData);
    const validEvidence = validatedEvidence(path, data, sourceData);
    const sentences = text(value).split(/[。！？；]/).map(text).filter(Boolean);
    for (const sentence of sentences) {
      if (!FACTUAL_MARKER.test(sentence)) continue;
      const claims = sentenceClaims(sentence);
      const missingClaims = claims.filter((claim) => !claimSupported(claim, records, validEvidence));
      const matchedSources = records.filter((item) => claims.some((claim) => claimSupported(claim, [item], [])));
      const supported = claims.length ? missingClaims.length === 0 : validEvidence.length > 0;
      entries.push({ path, sentence, claims, missingClaims, supported, matchedSources: matchedSources.map((item) => item.sourcePath), evidence: unique([...matchedSources.map((item) => item.text), ...validEvidence.map((item) => item.text)]) });
    }
  }
  return { version: '1.0', checkedAt: new Date().toISOString(), entries, unsupported: entries.filter((item) => !item.supported) };
}

export function hasAuthoritativeSupport(segment, authoritativeFacts = []) {
  const numericClaims = text(segment).match(SPECIFIC_TIME_CLAIM) || [];
  return list(authoritativeFacts).some((item) => {
    if (!item?.sourceUrl || !item?.verifiedAt || !text(item.statement)) return false;
    const statement = canonical(item.statement);
    return numericClaims.every((claim) => statement.includes(canonical(claim)));
  });
}

function conservativeTimeSensitiveText(value, path = '') {
  const source = text(value);
  if (/^(includedCustomer|excludedCustomer)/.test(path)) {
    const label = source.split(/[（(]/)[0].replace(/\d+\s*(?:个?月|天|年|美元|美金|元)/g, '').trim() || '相关费用';
    return `${label}（当前报价按供应商资料暂列，办理要求与最终费用请在出发前按官方最新信息复核）`;
  }
  if (/疫苗|黄热病|健康|检疫/.test(source)) return '健康、疫苗与检疫要求可能调整，请在出发前按官方最新信息复核，必要时咨询专业医疗机构。';
  if (/签证|入境|海关/.test(source)) return '签证与入境要求可能调整，请在出发前按目的地官方最新信息复核，定制师可协助核对。';
  return '相关运营时间与季节信息可能调整，请在出发前按官方最新信息复核。';
}

function getAtPath(target, path) {
  return String(path).split('.').reduce((value, part) => value?.[/^\d+$/.test(part) ? Number(part) : part], target);
}

function setAtPath(target, path, value) {
  const parts = String(path).split('.'); let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) cursor = cursor[/^\d+$/.test(parts[index]) ? Number(parts[index]) : parts[index]];
  cursor[/^\d+$/.test(parts.at(-1)) ? Number(parts.at(-1)) : parts.at(-1)] = value;
}

function timeSensitivePaths(data = {}) {
  return [
    ...list(data.notes).flatMap((group, groupIndex) => list(group?.items).map((_item, itemIndex) => `notes.${groupIndex}.items.${itemIndex}`)),
    ...list(data.includedCustomer).map((_item, index) => `includedCustomer.${index}`),
    ...list(data.excludedCustomer).map((_item, index) => `excludedCustomer.${index}`),
    ...list(data.cancellationCustomer).map((_item, index) => `cancellationCustomer.${index}`),
  ];
}

export function applySafeCopyCorrections(data = {}, sourceData = {}) {
  const corrected = structuredClone(data); const corrections = [];
  for (const path of timeSensitivePaths(corrected)) {
    const value = text(getAtPath(corrected, path));
    if (!TIME_SENSITIVE_CONTEXT.test(value) || !SPECIFIC_TIME_CLAIM.test(value) || hasAuthoritativeSupport(value, sourceData.authoritativeFacts)) continue;
    const replacement = conservativeTimeSensitiveText(value, path);
    setAtPath(corrected, path, replacement);
    corrections.push({ path, code: 'time_sensitive_safe_fallback', before: value, after: replacement, reason: '缺少权威来源URL与核验日期，已移除具体金额、期限或时间窗口' });
  }

  const report = buildFactProvenanceReport(corrected, sourceData);
  const evidence = { ...(corrected.copyEvidence || {}) };
  for (const entry of report.entries.filter((item) => item.supported && item.evidence.length)) evidence[entry.path] = unique([...(evidence[entry.path] || []), ...entry.evidence]);
  corrected.copyEvidence = evidence;
  corrected.factProvenance = buildFactProvenanceReport(corrected, sourceData);
  return { data: corrected, corrections, provenance: corrected.factProvenance };
}

