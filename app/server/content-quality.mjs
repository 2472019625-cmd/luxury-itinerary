import { COPY_RULE_IDS } from '../config/copy-rule-runtime.mjs';
import { validateNotesSchema } from '../src/lib/notesSchema.js';
import { buildFactProvenanceReport, hasAuthoritativeSupport, SPECIFIC_TIME_CLAIM, TIME_SENSITIVE_CONTEXT } from './fact-provenance.mjs';

const INTERNAL = /成本|利润|毛利|供应商底价|采购价|结算价|内部报价|基本房型报价|报价测算逻辑|加价倍率|图片未通过终审|审核分数|候选状态|来源账本|内部路径|原始资料照片|经地点核验/i;
const UNSUPPORTED_PROMISE = /保证(?:看到|升级|包场|入住|使用)|百分之百|100%|全球唯一|世界第一|一定会|必然出现|必定(?:看到|遇见|升级)|确保(?:看到|升级)|(?:国际航班|机票).{0,10}(?:安排妥当|已安排|已确认)|通常(?:提供|设有).{0,12}(?:保险箱|设施)/i;
const SUPPLIER_TONE = /参考酒店|报价(?:包含|不含)|按报价|接待标准|我司|贵宾|客人自理|产生费用|费用另计|具体以现场为准|如有变动恕不另行通知/i;
const ENCYCLOPEDIA_TONE = /占地(?:面积)?\s*\d|面积(?:约|为)?\s*\d|平方公里|共有\d+(?:种|间|座)|隶属于|行政区划|始建于\d{4}|海拔\d{3,}/i;
const DISCOUNT_TONE = /超值|必冲|打卡|网红爆款|性价比(?:拉满|之选)|闭眼入|限时抢|买到就是赚到|特价|特惠/i;
const COLD_DISCLAIMER = /后果自负|概不负责|不能保证|无法保证|完全取决于|具有不确定性|一切以现场为准|以现场观察为准/i;
const FACILITY = /泳池|健身房|水疗|SPA|餐厅|酒吧|会议室|Wi-?Fi|空调|迷你吧|电视|吹风机|保险箱|停车场|洗衣服务/ig;
const HOTEL_ROUTE_VALUE = /路线|动线|折返|转场|衔接|承接|过渡|清晨|黄金时段|节奏|抵达|下一段|停留|省去|从容/;
const HOTEL_SCENE = /景观|草原|旷野|营地|露台|日出|日落|星空|泳池|帐篷|庭院|森林|海岸|沙滩|野生动物|篝火|私密/;
const PROGRESSION = /清晨|早餐后|上午|白天|今天|随后|随即|落地|抵达后|午后|日暮|暮色|傍晚|夜晚|启程后|途中|入夜|返程前|最后一(?:个|天)|连续几日/;
const CUSTOMER_ACTION = /你(?:将|可以|会)|客人(?:将|可以|会)|乘坐|搭乘|步入|走进|深入|抵达|出发|守候|追踪|俯瞰|漫步|品尝|享用|休整|入住|观赏|探索|体验|返回/;
const SCENE = /眼前|视野|耳畔|草原|旷野|星空|日出|日落|暮色|晨光|海风|浪花|兽群|动物|火山|森林|湖面|帐篷|营地|沙滩|珊瑚|篝火|香气|水面|天际线/;
const EXPERIENCE_VALUE = /值得|意义|从容|节奏|省去|免去|避开|留给|更完整|更深入|更舒适|更私密|第一排|黄金时段|衔接|承接|铺垫|收束|揭幕|见面礼|转换为|不必|减少|保留体力|独特价值|视角|分量|无法替代|无法给予|重新认识|认识它|读懂|理解|感知|给不了|维度|人文厚度|才完整|带来|记住|难忘|截然不同|高潮|珍贵|难得|不同的眼光/;
const ACTIONABLE = /建议|请|可(?:提前|准备|携带|联系|选择)|准备|留意|听从|联系|确认|核对|穿戴|避免|预留/;
const DAY_WARNING = /重要说明|安全须知|红色警告|后果自负|概不负责/;
const ACTION_ONLY_THEME = /^(?:全天)?(?:游猎|抵达|返程|离境|自由活动|前往[^，。；]{0,16}|入住[^，。；]{0,16}|乘车|飞行|转场)$/i;

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const chars = (value) => [...text(value)].length;
const canonical = (value) => text(value).toLowerCase().replace(/[，。！？、；：,.!?;:\s”“"'（）()—→\-]/g, '');
const list = (value) => Array.isArray(value) ? value : [];

function charBigrams(value) {
  const source = canonical(value).replace(/第?\d+天|day\d+/ig, '');
  const result = new Set();
  for (let index = 0; index < source.length - 1; index += 1) result.add(source.slice(index, index + 2));
  return result;
}

function similarity(left, right) {
  const a = charBigrams(left); const b = charBigrams(right);
  if (!a.size || !b.size) return 0;
  let same = 0; for (const item of a) if (b.has(item)) same += 1;
  return (2 * same) / (a.size + b.size);
}

function isSimpleTransitDay(day = {}) {
  const body = `${day.theme || ''} ${day.description || ''}`;
  return day.overnightType === 'inflight' || day.overnightType === 'none' || /返程|离境|送机|抵达|转场|飞往/.test(body) && list(day.spots).length <= 1;
}

function issue(ruleIds, code, path, message, action = 'targeted_rewrite', severity = 'quality') {
  return { ruleIds: Array.isArray(ruleIds) ? ruleIds : [ruleIds], code, path, message, action, severity };
}

function moduleText(data) {
  return JSON.stringify({
    title: data.title, subtitle: data.subtitle, highlights: data.highlights, hotels: data.hotels,
    diningExperiences: data.diningExperiences, transportSummary: data.transportSummary, days: data.days,
    includedCustomer: data.includedCustomer, excludedCustomer: data.excludedCustomer,
    included: data.included, excluded: data.excluded, notes: data.notes, consultant: data.consultant,
  });
}

function customerCopyFields(data) {
  return [
    ['title', data.title], ['subtitle', data.subtitle], ['highlights', list(data.highlights).join('；')],
    ...list(data.hotels).flatMap((item, index) => [[`hotels.${index}.editorialCopy`, item.editorialCopy], [`hotels.${index}.proofPoints`, list(item.proofPoints).join('；')]]),
    ...list(data.diningExperiences).map((item, index) => [`diningExperiences.${index}.editorialCopy`, item.editorialCopy]),
    ...list(data.transportSummary).map((item, index) => [`transportSummary.${index}.editorialCopy`, item.editorialCopy]),
    ...list(data.days).flatMap((day, index) => [
      [`days.${index}.theme`, day.theme], [`days.${index}.description`, day.description],
      ...list(day.spots).map((spot, spotIndex) => [`days.${index}.spots.${spotIndex}.description`, spot.description]),
      [`days.${index}.dayNotices`, list(day.dayNotices).map((item) => item?.text).join('；')],
    ]),
    ...list(data.notes).map((item, index) => [`notes.${index}`, `${item?.title || ''} ${list(item?.items).join('；')}`]),
    ...list(data.includedCustomer).map((value, index) => [`includedCustomer.${index}`, value]),
    ...list(data.excludedCustomer).map((value, index) => [`excludedCustomer.${index}`, value]),
    ...list(data.cancellationCustomer).map((value, index) => [`cancellationCustomer.${index}`, value]),
  ].filter(([, value]) => text(value));
}

function checkTitle(data, issues) {
  const count = data.dayCount || data.days?.length || 0;
  const expected = `${count}天${Math.max(0, count - 1)}晚`;
  if (!text(data.title).includes(expected) || chars(data.title) > 24) issues.push(issue('COPY-003','title_format','title',`标题须包含${expected}且不超过24字`));
  if (!/(?:定制游|深度游|Safari定制游)/i.test(text(data.title))) issues.push(issue('COPY-003','title_product_form','title','标题须说明定制游或深度游产品形态'));
  if (/\d+人|两人|定制团|私家团|独立成团|两人成团/.test(text(data.title))) issues.push(issue('COPY-003','title_group_language','title','标题不得写具体人数或组团形态'));
}

function checkSubtitle(data, issues) {
  const value = text(data.subtitle);
  if (!value || chars(value) < 14 || /^(?:尊享|奢华|非凡|探索|发现|顶奢).{0,8}(?:之旅|旅程)$/.test(value)) issues.push(issue('COPY-004','subtitle_generic','subtitle','副标题须用具体路线、体验画面和定制节奏说明价值'));
  if (list(data.hotels).filter((hotel) => text(hotel.shortName || hotel.officialName) && value.includes(text(hotel.shortName || hotel.officialName))).length > 1) issues.push(issue('COPY-004','subtitle_hotel_list','subtitle','副标题不应成为酒店清单'));
  const clauses = value.split(/[，,、；]/).map(text).filter(Boolean);
  const narrativeSignals = value.match(/以|从|串联|穿行|深入|抵达|守候|把|让|形成|展开|收束|安排|衔接|进入|走向|留给/g) || [];
  if (clauses.length >= 4 && narrativeSignals.length < 2) issues.push(issue('COPY-004','subtitle_selling_point_list','subtitle','副标题不能用逗号罗列交通、酒店和卖点，须写成一条有路线推进与旅程意义的完整叙事句'));
  if (chars(value) > 76) issues.push(issue('COPY-004','subtitle_too_long','subtitle','副标题应控制为封面可读的2—3行完整叙事句，不超过76字'));
  const groundedAnchors = [...new Set([
    ...list(data.days).flatMap((day) => [...list(day.routeNodes), ...list(day.spots).map((spot) => spot?.name || spot?.experience)]),
    ...list(data.transportSummary).map((item) => item?.category),
  ].map(text).filter((item) => chars(item) >= 3 && !/国际机场$/.test(item)))];
  const groundedHits = groundedAnchors.filter((anchor) => value.includes(anchor) || (chars(anchor) >= 6 && value.includes(anchor.slice(0, 4))));
  if ((data.dayCount || data.days?.length || 0) >= 5 && groundedHits.length < 2) issues.push(issue('COPY-004','subtitle_grounding_thin','subtitle','长行程副标题至少应承接两个已确认的路线、核心体验或交通锚点，不能只写目的地和泛化服务价值'));
  const hasNarrativeStart = /(?:以|从|自).{2,}(?:串联|穿行|深入|抵达|进入|换乘|走向|展开)/.test(value);
  const hasNarrativeOutcome = /(?:把|让|形成|安排成|收束为|完成|成为|留下一段|展开一段).{0,16}(?:旅程|之旅|体验)/.test(value);
  if ((data.dayCount || data.days?.length || 0) >= 5 && (!hasNarrativeStart || !hasNarrativeOutcome)) issues.push(issue('COPY-004','subtitle_narrative_arc_missing','subtitle','长行程副标题需要形成“从哪里/以何种节奏展开—串联或深入哪些核心体验—最终为客户形成什么旅程”的叙事关系，不能只是换一种方式继续列卖点'));
}

function checkHighlights(data, sourceData, issues) {
  const items = list(data.highlights).map(text).filter(Boolean);
  if (!items.length || items.length > 6) issues.push(issue('COPY-005','highlight_count','highlights','产品亮点应存在且最多6条'));
  const normalized = items.map(canonical);
  if (new Set(normalized).size !== normalized.length) issues.push(issue('COPY-005','highlight_duplicate','highlights','产品亮点存在完全重复'));
  items.forEach((item, index) => {
    const parts = item.split(/[：:]/);
    if (parts.length < 2 || chars(parts.slice(1).join('：')) < 8) issues.push(issue('COPY-005','highlight_bare_value',`highlights.${index}`,'亮点必须使用“短标题：客户具体价值”，不能只有裸标签'));
    if (/^(?:顶奢连住|私人保护区|一价全包|草原飞机|一家一团|专属用车|深度游猎)$/.test(item)) issues.push(issue('COPY-005','highlight_bare_label',`highlights.${index}`,'亮点是裸卖点，没有解释客户得到的价值'));
    if (parts[0] && chars(parts[0]) > 8) issues.push(issue('COPY-005','highlight_title_long',`highlights.${index}`,'亮点冒号前应是2—8字价值锚点，不能写成长句'));
    if (DISCOUNT_TONE.test(item)) issues.push(issue('COPY-005','highlight_discount_tone',`highlights.${index}`,'产品亮点不得使用特惠、超值等廉价促销表达'));
  });
  for (let index = 1; index < items.length; index += 1) if (similarity(items[index - 1], items[index]) > 0.72) issues.push(issue('COPY-005','highlight_near_duplicate',`highlights.${index}`,'相邻亮点只是换词重复'));
  if (items.length >= 3) {
    const service = items.filter((item) => /一家一团|1V1|定制师|专属|不拼车|灵活|在地资源|服务/.test(item)).length;
    const route = items.length - service;
    if (!service || !route) issues.push(issue('COPY-005','highlight_value_mix','highlights','亮点须同时包含奢游服务价值和路线独有价值'));
    else if (route <= service) issues.push(issue('COPY-005','highlight_route_not_primary','highlights','产品亮点应以路线独有价值为主，服务价值只占1—2条'));
  }
  const tripDays = Number(data.dayCount || data.days?.length || 0);
  if (tripDays >= 6 && items.length < 5) issues.push(issue('COPY-005','highlight_incomplete','highlights','六天以上且内容丰富的行程应提炼5—6条完整亮点，不能只保留少量概括标签'));
  const sourceHighlights = list(sourceData?.sourcePosterHighlights).map(canonical).filter((item) => item.length >= 4);
  const generated = canonical(items.join(' '));
  const preserved = sourceHighlights.some((source) => {
    if (generated.includes(source.slice(0, Math.min(8, source.length))) || similarity(source, generated) > 0.28) return true;
    const signals = ['春节','住六付五','连住','vip','接驳','私人保护区','草原飞机','热气球','全包','一家一团'].filter((token) => source.includes(token));
    return signals.length > 0 && signals.filter((token) => generated.includes(token)).length >= Math.min(2, signals.length);
  });
  if (sourceHighlights.length && !preserved) issues.push(issue('COPY-005','source_highlight_lost','highlights','原始资料中的主推亮点没有被保留或转译'));
}

function checkOverview(data, issues) {
  list(data.days).forEach((day, index) => {
    if (!text(day.theme) || chars(day.theme) > 18) issues.push(issue('COPY-006','overview_theme',`days.${index}.theme`,'每日主题须简洁并说明当天旅行意义'));
    if (ACTION_ONLY_THEME.test(text(day.theme))) issues.push(issue('COPY-006','overview_theme_action_only',`days.${index}.theme`,'每日主题不能用游猎、抵达、返程、自由活动或前往某地等动作直接充当旅行意义'));
    const hotelNames = list(data.hotels).flatMap((hotel) => [text(hotel.shortName), text(hotel.officialName)]).filter(Boolean);
    if (hotelNames.some((name) => canonical(day.theme) === canonical(name))) issues.push(issue('COPY-006','overview_theme_hotel_name',`days.${index}.theme`,'酒店名称不能直接充当每日主题'));
    if (!list(day.routeNodes).length) issues.push(issue('COPY-006','overview_route',`days.${index}.routeNodes`,'行程总览缺少清晰路线节点','block','structure'));
    const overview = `${day.theme || ''} ${list(day.routeNodes).join(' ')}`;
    if (/早餐|午餐|晚餐|全餐|含餐/.test(overview)) issues.push(issue('COPY-006','overview_meal_dump',`days.${index}`,'行程总览不应重复三餐'));
  });
}

function checkHotels(data, sourceData, issues) {
  if (list(sourceData?.hotels).length && !list(data.hotels).length) issues.push(issue(['COPY-002','COPY-007'],'hotel_module_missing','hotels','存在住宿事实但臻选下榻模块缺失','block','structure'));
  list(data.hotels).forEach((hotel, index) => {
    const copy = text(hotel.editorialCopy);
    if (chars(copy) < 34) issues.push(issue('COPY-007','hotel_thin',`hotels.${index}.editorialCopy`,'酒店文案没有完整说明住宿价值'));
    if (!HOTEL_ROUTE_VALUE.test(copy)) issues.push(issue('COPY-007','hotel_route_value',`hotels.${index}.editorialCopy`,'酒店文案缺少位置对路线节奏或衔接的价值'));
    if (!HOTEL_SCENE.test(copy)) issues.push(issue('COPY-007','hotel_scene',`hotels.${index}.editorialCopy`,'酒店文案缺少客户抵达后可感知的场景'));
    const facilities = copy.match(FACILITY) || [];
    if (facilities.length >= 4 || /设有.+、.+、.+(?:及|和)/.test(copy)) issues.push(issue('COPY-007','hotel_facility_dump',`hotels.${index}.editorialCopy`,'酒店文案退化为设施堆叠'));
    const points = list(hotel.proofPoints).map(text).filter(Boolean);
    if (points.length < 2 || points.length > 3 || points.some((point) => chars(point) < 4 || chars(point) > 10)) issues.push(issue('COPY-007','hotel_proof_points',`hotels.${index}.proofPoints`,'酒店关键点应为2—3条、每条4—10字的短锚点'));
    if (points.some((point) => copy.includes(point) && chars(point) > 8)) issues.push(issue('COPY-007','hotel_proof_repeat',`hotels.${index}.proofPoints`,'酒店关键点不应复述正文长句'));
  });
}

function checkDining(data, sourceData, issues) {
  if (list(data.diningExperiences).some((item) => !Number.isInteger(item.sourceDay) && !list(item.sourceEvidence).length)) issues.push(issue('COPY-008','dining_without_evidence','diningExperiences','特色餐饮缺少原始事实依据','block','fact'));
  list(data.diningExperiences).forEach((item, index) => {
    const copy = text(item.editorialCopy);
    if (copy && chars(copy) < 20) issues.push(issue('COPY-008','dining_thin',`diningExperiences.${index}.editorialCopy`,'特色餐饮须说明场景、氛围或旅程记忆点'));
    if (/普通早餐|午餐盒|酒店晚餐/.test(`${item.title || ''}${item.officialName || ''}`)) issues.push(issue('COPY-008','ordinary_meal_promoted',`diningExperiences.${index}`,'普通餐食不得包装成特色餐饮','block','fact'));
  });
}

function checkTransport(data, sourceData, issues) {
  if (list(sourceData?.transportSummary).length && !list(data.transportSummary).length) issues.push(issue(['COPY-002','COPY-009'],'transport_module_missing','transportSummary','存在交通事实但全程交通模块缺失','block','structure'));
  list(data.transportSummary).forEach((item, index) => {
    const copy = text(item.editorialCopy);
    if (chars(copy) < 24 || !/(舒适|从容|衔接|效率|空间|体力|时间|少折返|专属)/.test(copy)) issues.push(issue('COPY-009','transport_value',`transportSummary.${index}.editorialCopy`,'交通文案须说明舒适度、时间或衔接价值'));
    if (item.model && item.modelGuaranteed !== true && copy.includes(text(item.model))) issues.push(issue('COPY-009','transport_unverified_model',`transportSummary.${index}.editorialCopy`,'未保证车型不得在客户文案中作型号承诺','block','fact'));
    if (COLD_DISCLAIMER.test(copy)) issues.push(issue(['COPY-009','COPY-015'],'transport_cold_disclaimer',`transportSummary.${index}.editorialCopy`,'交通卡片不应堆冷硬免责声明'));
  });
}

function checkDays(data, sourceData, issues) {
  const days = list(data.days);
  if (!days.length) issues.push(issue(['COPY-002','COPY-010'],'days_missing','days','每日行程模块缺失','block','structure'));
  days.forEach((day, index) => {
    const body = text(day.description); const simple = isSimpleTransitDay(day);
    if (chars(body) < (simple ? 24 : 46)) issues.push(issue('COPY-010','day_thin',`days.${index}.description`, `DAY ${index + 1} 文案过薄，未形成客户体验`));
    const maximum = simple ? 130 : 220;
    if (chars(body) > maximum) issues.push(issue('COPY-010','day_overlong',`days.${index}.description`, `DAY ${index + 1} 正文超过${maximum}字，信息密度过高；应只保留当天最重要的动作、画面、价值和承接`));
    if (body.split(/[。！？；]/).map(text).filter(Boolean).length > (simple ? 3 : 5)) issues.push(issue('COPY-010','day_fact_dump',`days.${index}.description`, `DAY ${index + 1} 细节堆叠过多，须压缩成客户可读的核心体验叙事`));
    if (!PROGRESSION.test(body)) issues.push(issue('COPY-010','day_no_progression',`days.${index}.description`, `DAY ${index + 1} 缺少基于事实的自然推进`));
    if (!CUSTOMER_ACTION.test(body) && !SCENE.test(body)) issues.push(issue('COPY-010','day_no_action_scene',`days.${index}.description`, `DAY ${index + 1} 没有客户动作或现场画面`));
    if (!simple && !SCENE.test(body)) issues.push(issue('COPY-010','day_no_scene',`days.${index}.description`, `DAY ${index + 1} 没有可感知的现场画面`));
    if (!simple && !EXPERIENCE_VALUE.test(body)) issues.push(issue('COPY-010','day_no_value',`days.${index}.description`, `DAY ${index + 1} 没有解释体验价值或路线意义`));
    if (/^(?:早餐后|随后)?(?:乘车|驱车|前往|抵达).{0,28}(?:参观|游览|入住|返回酒店)[。.]?$/.test(body) || /前往.+参观.+结束后.+(?:酒店|入住)/.test(body)) issues.push(issue(['COPY-001','COPY-010'],'day_supplier_log',`days.${index}.description`, `DAY ${index + 1} 仍是供应商流水账`));
    if (DAY_WARNING.test(body)) issues.push(issue(['COPY-012','COPY-013'],'day_warning_stack',`days.${index}.description`,'安全与免责信息不应堆在每日正文'));
    const tips = list(day.dayNotices).filter((item) => item?.type === 'tip');
    if (tips.length > 1) issues.push(issue('COPY-012','too_many_tips',`days.${index}.dayNotices`, `DAY ${index + 1} 最多一条今日贴士`));
    tips.forEach((tip) => { if (!ACTIONABLE.test(text(tip.text))) issues.push(issue('COPY-012','tip_not_actionable',`days.${index}.dayNotices`,'今日贴士必须提供实际准备价值')); });
    list(day.spots).forEach((spot, spotIndex) => {
      if (['optional_paid','reservation_required','pending'].includes(spot.status) && !text(spot.statusLabel)) issues.push(issue('COPY-011','experience_status_missing',`days.${index}.spots.${spotIndex}`,'可选、预约或待确认体验缺少客户可见状态','block','fact'));
    });
    if (index > 0 && similarity(days[index - 1].description, body) > 0.67) issues.push(issue('COPY-010','day_near_duplicate',`days.${index}.description`, `DAY ${index + 1} 与相邻日期高度同义重复`));
  });
}

function checkNotes(data, issues) {
  const notes = list(data.notes);
  if (!notes.length) issues.push(issue(['COPY-002','COPY-013'],'notes_missing','notes','最终注意事项缺失','block','structure'));
  const schema = validateNotesSchema(notes);
  if (notes.length && !schema.valid) {
    issues.push(issue('COPY-013','notes_invalid_structure','notes',`注意事项必须是“分类标题＋条目数组”：${schema.errors.join('；')}`,'block','structure'));
    return;
  }
  if (notes.some((item) => item?.legacyConverted)) issues.push(issue('COPY-013','notes_legacy_structure','notes','历史字符串注意事项已兼容转换，仍需按正式分类结构复核'));
  const all = notes.flatMap((item) => [item?.title, ...list(item?.items)]).map(text).join(' ');
  if (COLD_DISCLAIMER.test(all) || /后果自负|概不负责/.test(all)) issues.push(issue(['COPY-013','COPY-015'],'notes_cold_tone','notes','注意事项语气冷硬或推责'));
  if (notes.some((item) => !/自然/.test(text(item.title)) && list(item.items).some((entry) => text(entry) && !ACTIONABLE.test(text(entry)) && chars(entry) > 12))) issues.push(issue('COPY-013','notes_not_actionable','notes','注意事项应温和、具体并给出可执行建议'));
  notes.forEach((group, groupIndex) => list(group?.items).forEach((entry, itemIndex) => {
    if (chars(entry) > 82) issues.push(issue('COPY-013','notes_item_overlong',`notes.${groupIndex}.items.${itemIndex}`,'单条注意事项过长；应拆为一个明确主题和一条可执行建议，避免重新拼成大段落'));
  }));
  if ((data.days?.length || 0) >= 5) {
    const categories = [/运营|行程/,/气候|穿着|健康/,/安全|游猎|水上/,/自然|天气|动物|海况/,/证件|财物|行李/,/儿童|长者|特殊/].filter((pattern) => pattern.test(all)).length;
    if (categories < 3) issues.push(issue('COPY-013','notes_category_thin','notes','长行程注意事项覆盖面不足，须按相关性补充运营、健康、安全、自然、行李或特殊人群提醒'));
  }
}

function checkExpenses(data, sourceData, issues) {
  const included = list(data.includedCustomer).length ? data.includedCustomer : list(data.included);
  const excluded = list(data.excludedCustomer).length ? data.excludedCustomer : list(data.excluded);
  const sourceIncluded = list(sourceData?.included);
  const sourceExcluded = list(sourceData?.excluded);
  if (sourceIncluded.length && included.length !== sourceIncluded.length) issues.push(issue('COPY-014','fee_included_count_mismatch','includedCustomer',`费用包含客户表达应与源数据${sourceIncluded.length}项逐项一致，当前为${included.length}项`,'block','fact'));
  if (sourceExcluded.length && excluded.length !== sourceExcluded.length) issues.push(issue('COPY-014','fee_excluded_count_mismatch','excludedCustomer',`费用不含客户表达应与源数据${sourceExcluded.length}项逐项一致，当前为${excluded.length}项`,'block','fact'));
  const importIncluded = list(sourceData?.sourceImportCoverage?.included);
  if (importIncluded.length && sourceIncluded.length !== importIncluded.length) issues.push(issue('COPY-014','fee_source_coverage_mismatch','included',`原文件${importIncluded.length}项费用包含没有完整进入确定性费用数组`,'block','fact'));
  const all = [...included, ...excluded].map(text).join(' ');
  if (SUPPLIER_TONE.test(all)) issues.push(issue('COPY-014','fee_supplier_language','expenses','费用表达仍是供应商或报价清单口吻'));
  if (INTERNAL.test(all)) issues.push(issue(['COPY-014','COPY-017'],'fee_internal_leak','expenses','费用模块包含内部经营信息','block','safety'));
}

function checkFactualEvidence(data, sourceData, issues) {
  const provenance = buildFactProvenanceReport(data, sourceData);
  for (const entry of provenance.unsupported) {
    const path = entry.path;
    const ruleId = path.startsWith('hotels.') ? 'COPY-007' : path.startsWith('diningExperiences.') ? 'COPY-008' : path.startsWith('transportSummary.') ? 'COPY-009' : path.startsWith('days.') ? 'COPY-010' : 'COPY-013';
    issues.push(issue([ruleId,'COPY-015'],'factual_sentence_without_evidence',path,`客户文案中的具体事实缺少原始依据：${entry.missingClaims.join('、') || entry.sentence}`,'safe_fact_fallback','fact'));
  }
  const segments = customerCopyFields(data).flatMap(([path, value]) => text(value).split(/[。！？；]/).filter(Boolean).map((segment) => [path, segment]));
  for (const [path, segment] of segments.filter(([, value]) => TIME_SENSITIVE_CONTEXT.test(value) && SPECIFIC_TIME_CLAIM.test(value))) {
    if (!hasAuthoritativeSupport(segment, sourceData.authoritativeFacts || data.authoritativeFacts)) issues.push(issue(['COPY-013','COPY-015'],'time_sensitive_specific_without_authority',path,'具体签证、健康、入境或季节窗口结论缺少权威来源和核验日期','safe_time_sensitive_fallback','fact'));
  }
  return provenance;
}

function checkGlobalTone(data, issues) {
  for (const [path, value] of customerCopyFields(data)) {
    const all = text(value);
    if (INTERNAL.test(all)) issues.push(issue('COPY-017','internal_leak',path,'客户内容含内部术语','block','safety'));
    if (UNSUPPORTED_PROMISE.test(all)) issues.push(issue('COPY-015','unsupported_promise',path,'客户内容含无依据保证或可核验最高级','block','safety'));
    if (SUPPLIER_TONE.test(all)) issues.push(issue('COPY-001','supplier_tone',path,'客户内容仍带供应商或内部操作口吻'));
    if (ENCYCLOPEDIA_TONE.test(all)) issues.push(issue('COPY-001','encyclopedia_tone',path,'客户内容退化为百科资料罗列'));
    if (DISCOUNT_TONE.test(all)) issues.push(issue('COPY-001','discount_tone',path,'客户内容出现廉价促销语言'));
    if (COLD_DISCLAIMER.test(all)) issues.push(issue(['COPY-001','COPY-015'],'cold_disclaimer',path,'客户内容出现冷硬免责口吻'));
  }
  const consultant = data.consultant || data.advisor || {};
  if ((consultant.years || consultant.orders || consultant.rating || consultant.phone) && !consultant.userConfigured) issues.push(issue('COPY-016','advisor_unverified_claim','consultant','定制师模块包含未经用户配置的个人业绩或联系方式','block','fact'));
}

function ruleApplicability(ruleId, data, sourceData) {
  if (ruleId === 'COPY-008') return list(sourceData?.diningExperiences).length > 0;
  if (ruleId === 'COPY-009') return list(sourceData?.transportSummary).length > 0 || list(sourceData?.sourceImportCoverage?.dailyTransport).length > 0;
  if (ruleId === 'COPY-014') return list(sourceData?.included).length > 0 || list(sourceData?.excluded).length > 0;
  if (ruleId === 'COPY-016') return Boolean(data.consultant || data.advisor);
  return true;
}

const SUBJECTIVE_OR_PARTIAL = new Set(['COPY-001','COPY-004','COPY-005','COPY-007','COPY-010','COPY-013','COPY-015']);

function buildRuleResults(issues, data, sourceData) {
  return COPY_RULE_IDS.map((ruleId) => {
    const related = issues.filter((item) => item.ruleIds.includes(ruleId));
    const applicable = ruleApplicability(ruleId, data, sourceData);
    const evidenceProblem = related.some((item) => /evidence|authority|source_coverage/.test(item.code));
    const status = related.length ? (evidenceProblem ? 'evidence_insufficient' : 'failed') : !applicable ? 'no_applicable_data' : SUBJECTIVE_OR_PARTIAL.has(ruleId) ? 'partial_check_pass' : 'complete_rule_pass';
    return { ruleId, status, passed: status === 'complete_rule_pass', applicable, issues: related.map(({ code, path, message, action, severity }) => ({ code, path, message, action, severity })) };
  });
}

export function reviewCustomerContent(data = {}, options = {}) {
  const issues = [];
  const sourceData = options.sourceData || data;
  checkTitle(data, issues); checkSubtitle(data, issues); checkHighlights(data, sourceData, issues);
  checkOverview(data, issues); checkHotels(data, sourceData, issues); checkDining(data, sourceData, issues);
  checkTransport(data, sourceData, issues); checkDays(data, sourceData, issues); checkNotes(data, issues);
  checkExpenses(data, sourceData, issues); const factProvenance = checkFactualEvidence(data, sourceData, issues); checkGlobalTone(data, issues);
  return { version: '3.2', passed: issues.length === 0, checkedAt: new Date().toISOString(), issues, factProvenance, ruleResults: buildRuleResults(issues, data, sourceData) };
}

// Compatibility export: this is now a pure gate. Brand problems are never disguised by deleting words.
export function applyContentSafetyGate(data = {}, options = {}) {
  const report = reviewCustomerContent(data, options);
  return { data: structuredClone(data), report: { ...report, attempts: 0, initialIssues: report.issues, remainingIssues: report.issues, fallbackUsed: false } };
}
