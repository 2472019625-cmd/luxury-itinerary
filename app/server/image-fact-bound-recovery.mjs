const clean = value => typeof value === "string" ? value.trim() : "";
const choice = /或者|或|二选一|\bor\b|\//i;
const animals = {
  黑犀牛: "black rhinoceros", 犀牛: "rhinoceros", 狮子: "lion", 狮群: "lion pride",
  花豹: "leopard", 猎豹: "cheetah", 大象: "elephant", 象群: "elephant herd", 水牛: "buffalo",
};
const bigFive = ["狮子", "花豹", "大象", "犀牛", "水牛"];
const group = "非洲五霸";
const namedAnimals = Object.keys(animals).sort((a, b) => b.length - a.length).join("|");
const wildlifePair = new RegExp(`(${namedAnimals}|${group})\\s*(?:或者|或)\\s*(${namedAnimals}|${group})`);

function boundDay(slot, facts) {
  const match = /^day:(\d+)(?::supporting:\d+)?$/.exec(clean(slot.role));
  const index = match && Number(match[1]) - 1;
  const day = match && facts.days?.[index];
  if (!day || !(slot.sourceRefs || []).some(ref => {
    const parts = typeof ref === "string" && /^days\.\d+(?:\.[\w]+)*$/.test(ref) ? ref.split(".") : [];
    if (parts[0] !== "days" || Number(parts[1]) !== index) return false;
    let value = day;
    for (const part of parts.slice(2)) value = value?.[part];
    return value != null && value !== "";
  })) return null;
  return { day, index };
}

// This source-backed facility target does not promise a photograph of the
// moment its roof opens at night. Keep the named camp and roof feature hard.
export function repairStarBedFacilityVisual(slot, facts = {}) {
  const bound = boundDay(slot, facts), core = slot.queryCore || {};
  const key = value => clean(value).toLowerCase().replace(/\s+/g, ' ');
  if (!bound || slot.userLocked || slot.exactIdentityRequired !== true || slot.locationRole !== 'scope_only'
    || key(core.identity) !== 'saruni leopard hill' || key(core.identityEn) !== 'saruni leopard hill'
    || key(bound.day.hotel) !== key(core.identity)) return null;
  const source = clean(bound.day.experience);
  if (!/星空床/.test(source) || !/帐篷屋顶.{0,12}打开/.test(source)
    || /(?:必须|指定|仅限|保证).{0,20}(?:夜景|夜空|繁星|观星|星空)/.test(source)
    || /不(?:含|安排|提供|能体验).{0,12}星空床|星空床.{0,12}(?:不含|不安排|关闭)/.test(source)) return null;
  if (!/星空床/.test(clean(slot.primaryVisualSubject)) || /热气球|游猎|徒步|捕猎|淋浴|酒会|篝火/.test(clean(slot.primaryVisualSubject))
    || !/星空床.*帐篷.*(?:星空|夜空)/.test(clean(core.subject))
    || !/star bed.*tent.*roof.*(?:night sky|starry sky)/i.test(clean(core.subjectEn))
    || !['仰望星空', '仰望夜空'].includes(clean(core.action))
    || !/^gazing at (?:starry|night) sky$/i.test(clean(core.actionEn))) return null;
  const queryCore = { ...core, subject: '星空床及可开合帐篷屋顶', subjectEn: 'star bed with retractable tent roof', action: '', actionEn: '' };
  const queries = ['星空床 开合帐篷屋顶', 'star bed retractable tent roof'];
  return { queryCore, primaryVisualSubject: '星空床及可开合帐篷屋顶', fidelityQuery: queries[0], alternateQueries: queries.slice(1), searchIntent: queries,
    repair: { code: 'star_bed_facility_visual_normalized', version: 1,
      message: '有同日住宿及屋顶开合事实支持的星空床设施展示，夜景与繁星仅为偏好，具体营地及设施特征仍必需',
      originalQueryCore: structuredClone(core), originalPrimaryVisualSubject: slot.primaryVisualSubject,
      sourceRefs: [...slot.sourceRefs], softViewPreferences: ['夜晚、满天繁星、躺在星空床上仰望夜空；仅影响表现排序，不作为必要动作'] } };
}

function ordinaryAnimalActions(core, source) {
  if (![core.action, core.actionEn].some(value => choice.test(clean(value)))) return undefined;
  const zh = /^(?:(?:在|于)?(?:火山口)?(?:草原|谷底|盆地)(?:上|中)?)?(行走|伏卧|休息|捕猎)\s*(?:或者|或)\s*(行走|伏卧|休息|捕猎)$/.exec(clean(core.action));
  const en = /^(walking|resting|hunting)\s+or\s+(walking|resting|hunting)(?:\s+on\s+(?:the\s+)?(?:savanna|savannah|crater floor))?$/i.exec(clean(core.actionEn));
  const translation = { 行走: "walking", 伏卧: "resting", 休息: "resting", 捕猎: "hunting" };
  if (!zh || !en || zh[1] === zh[2] || ![1, 2].every(i => translation[zh[i]] === en[i].toLowerCase())
    || zh.slice(1).includes("捕猎") && !source.includes("捕猎")) return null;
  return { mode: "any", options: zh.slice(1).map(action => ({ action, actionEn: translation[action] })) };
}

// This is the observed animal + Big Five shape, not a generic OR bypass.
// The group remains one discovery branch; its individual members are explicit
// audit alternatives. A cheetah never becomes a member of the Big Five.
export function repairFactBoundWildlifeChoice(slot, facts = {}) {
  const bound = boundDay(slot, facts), core = slot.queryCore || {};
  if (!bound || slot.userLocked || slot.exactIdentityRequired !== false || slot.locationRole !== "scope_only"
    || clean(core.identity) || clean(core.identityEn)) return null;
  const pair = wildlifePair.exec(clean(slot.primaryVisualSubject));
  if (!pair || !pair[0].includes(group) || pair[1] === pair[2]) return null;
  const source = [bound.day.experience, ...(bound.day.spots || []).flatMap(spot => [spot.name, spot.description])].filter(Boolean).join(" ");
  if (!source.includes(group) || !/游猎|追踪|寻找|观赏/.test(source)
    || /保证|必见|仅限|不得|不能|不含|不安排|必须|指定/.test(source)) return null;
  const requested = [pair[1], pair[2]];
  const coreNames = clean(core.subject).split(/或者|或/).map(clean);
  const englishNames = clean(core.subjectEn).split(/\s+or\s+/i).map(value => value.toLowerCase());
  if (!coreNames.length || coreNames.length > 2 || new Set(coreNames).size !== coreNames.length || coreNames.length !== englishNames.length || !coreNames.every((name, i) => requested.includes(name)
    && (name === group ? /^big five(?: wildlife| animals)?$/.test(englishNames[i]) : animals[name] === englishNames[i]))) return null;
  const options = requested.filter(name => name === group || source.includes(name)
    || bigFive.includes(name) || ["狮群", "象群"].includes(name)).map(subject => subject === group
    ? { subject, subjectEn: "Big Five wildlife", members: bigFive.map(name => ({ subject: name, subjectEn: animals[name] })) }
    : { subject, subjectEn: animals[subject] });
  if (!options.length) return null;
  const actionOptions = ordinaryAnimalActions(core, source);
  if (actionOptions === null || /捕猎|hunting/i.test(`${core.action} ${core.actionEn}`) && !source.includes("捕猎")) return null;
  const withoutPair = clean(slot.primaryVisualSubject).replace(pair[0], "");
  const remainingChoices = actionOptions ? withoutPair.replace(/(?:行走|伏卧|休息|捕猎)\s*(?:或者|或)\s*(?:行走|伏卧|休息|捕猎)/g, "") : withoutPair;
  if (/飞机|直升机|热气球|船|徒步|潜水|骑行|餐饮|酒店|登机|下机/.test(withoutPair)
    || choice.test(remainingChoices)) return null;
  const actions = actionOptions?.options || [{ action: core.action, actionEn: core.actionEn }];
  const branches = options.length === 1 && actions.length === 2
    ? actions.map(action => ({ ...options[0], ...action }))
    : options.map((option, index) => ({ ...option, ...actions[index % actions.length] }));
  const queries = ["zh", "en"].flatMap(language => branches.map(branch => language === "zh"
    ? [branch.subject, branch.action].filter(Boolean).join(" ") : [branch.subjectEn, branch.actionEn].filter(Boolean).join(" ")));
  const queryCore = { ...core, subject: options[0].subject, subjectEn: options[0].subjectEn, ...actions[0] };
  return { queryCore, primaryVisualSubject: [options.map(option => option.subject).join("或"),
    actionOptions ? actions.map(option => option.action).join("或") : core.action].filter(Boolean).join(" "),
    fidelityQuery: queries[0], alternateQueries: [...new Set(queries)].slice(1, 4), searchIntent: [...new Set(queries)].slice(0, 4),
    animalSubjectOptions: { mode: "any", options, sourceRefs: [...slot.sourceRefs] },
    ...(actionOptions ? { animalActionOptions: { ...actionOptions, sourceRefs: [...slot.sourceRefs] } } : {}),
    repair: { code: "fact_bound_wildlife_choice_resolved", message: "同日游猎事实支持的动物集合与有限行为任选条件，搜索和审核共用；未获来源支持的分支不采用",
      originalQueryCore: structuredClone(core), originalPrimaryVisualSubject: slot.primaryVisualSubject,
      unsupportedBranches: requested.filter(name => !options.some(option => option.subject === name)) } };
}

const safariAnimalEnglish = {
  狮群: /\blion pride\b|\blions?\b/gi, 狮子: /\blions?\b/gi,
  花豹: /\bleopards?\b/gi, 猎豹: /\bcheetahs?\b/gi,
  大象: /\belephants?\b/gi, 象群: /\belephant herd\b|\belephants?\b/gi,
  斑马: /\bzebras?\b/gi, 长颈鹿: /\bgiraffes?\b/gi, 角马: /\bwildebeest\b/gi,
};
const safariAnimals = { ...animals, 斑马: 'zebra', 长颈鹿: 'giraffe', 角马: 'wildebeest' };
const safariPair = new RegExp(`(${Object.keys(safariAnimalEnglish).join('|')})\\s*(?:或者|或|/)\\s*(${Object.keys(safariAnimalEnglish).join('|')})`);
const scopeKey = value => clean(value).replace(/国家保护区|国家公园|保护区|\s/g, '');

// Recover a bounded safari animal choice from facts, not from model phrasing.
// A location labelled as non-essential is Scope only when it matches this
// day's geographical facts. A continued safari without named animals falls
// back to wildlife; it does not borrow species from another day.
export function repairSafariAnimalChoice(slot, facts = {}) {
  const bound = boundDay(slot, facts), core = slot.queryCore || {};
  if (!bound || slot.userLocked || slot.exactIdentityRequired !== false
    || !['scope_only', 'visual_identity'].includes(slot.locationRole)) return null;
  const visual = clean(slot.primaryVisualSubject), pair = safariPair.exec(visual);
  if (!pair || pair[1] === pair[2] || choice.test(visual.replace(pair[0], ''))
    || /飞机|热气球|船|徒步|骑行|餐饮|酒店|捕猎|猎杀|追逐|攀爬|进食|交配/.test(visual)) return null;
  const names = pair.slice(1), source = clean(bound.day.experience);
  if (!/游猎/.test(source) || /保证|必见|仅限|不得|不能|不含|不安排|必须|指定/.test(source)) return null;
  const place = clean(core.identity), location = clean(slot.location);
  const geography = [bound.day.route, ...(bound.day.routeNodes || []), source].filter(Boolean).join(' ');
  if (!location || !geography.includes(scopeKey(location))
    || place && (scopeKey(place) !== scopeKey(location) || /酒店|营地|餐厅|lodge|camp|hotel/i.test(place))
    || !place && clean(core.identityEn)
    || (facts.hotels || []).some(hotel => place && [hotel.name, hotel.officialName].some(name => clean(name) === place))) return null;
  // Both translations must describe the same pair, with only known framing
  // around it. Unknown subjects or an additional animal never get discarded.
  let zh = clean(core.subject), en = clean(core.subjectEn);
  const selectedNames = names.filter(name => zh.includes(name));
  if (!selectedNames.length || selectedNames.length === 1 && choice.test(zh)) return null;
  for (const name of selectedNames) {
    zh = zh.replaceAll(name, '');
    const expression = safariAnimalEnglish[name];
    expression.lastIndex = 0;
    if (!expression.test(en)) return null;
    expression.lastIndex = 0;
    en = en.replace(expression, '');
  }
  const vehicleFraming = /车|vehicle/i.test(`${zh} ${en}`);
  if (vehicleFraming && (!/车旁.*向导/.test(visual)
    || !/四驱|越野|游猎车/.test(clean(bound.day.vehicle))
    || /越野车|向导|交通工具/.test(clean(slot.visualDuty)))) return null;
  if (zh.replace(/四驱|开顶|游猎|越野车|草原|或者|或|与|和|及|[\s/]/g, '')
    || en.replace(/\b(?:safari|vehicle|and|or|on|in|the|savanna|savannah)\b|[\s/]/gi, '')) return null;
  const action = clean(core.action), actionEn = clean(core.actionEn);
  const observation = /^(?:追踪|寻找|观察|游猎|游猎观察)$/.test(action)
    && /^(?:tracking|searching|observing|safari|safari observation)$/i.test(actionEn);
  const ordinaryPose = /^(?:在草丛中活动|行走|休息|伏卧)$/.test(action)
    && /^(?:moving in grass|walking|resting)$/i.test(actionEn);
  if (!observation && !ordinaryPose && (action || actionEn)) return null;
  const explicit = names.every(name => source.includes(name));
  // Only this observed continuation shape may recover a generic wildlife
  // goal. A missing species source on an unrelated day stays unresolved.
  if (!explicit && (!/继续.{0,30}游猎/.test(source) || names.some(name => source.includes(name)))) return null;
  const options = explicit ? names.map(subject => ({ subject, subjectEn: safariAnimals[subject] })) : null;
  const queryCore = { ...core, subject: explicit ? options[0].subject : '野生动物',
    subjectEn: explicit ? options[0].subjectEn : 'wildlife',
    action: observation ? '' : action, actionEn: observation ? '' : actionEn, identity: '', identityEn: '' };
  const queries = explicit ? [
    ...options.map(option => [option.subject, queryCore.action].filter(Boolean).join(' ')),
    ...options.map(option => [option.subjectEn, queryCore.actionEn].filter(Boolean).join(' ')),
  ] : [[queryCore.subject, queryCore.action].filter(Boolean).join(' '), [queryCore.subjectEn, queryCore.actionEn].filter(Boolean).join(' ')];
  return { queryCore, locationRole: 'scope_only',
    primaryVisualSubject: [explicit ? names.join('或') : '游猎中的野生动物', queryCore.action].filter(Boolean).join(' '),
    fidelityQuery: queries[0], alternateQueries: [...new Set(queries)].slice(1, 4), searchIntent: [...new Set(queries)].slice(0, 4),
    animalSubjectOptions: options ? { mode: 'any', options, sourceRefs: [...slot.sourceRefs] } : undefined,
    repair: { code: explicit ? 'safari_animal_choice_resolved' : 'safari_continuation_visual_resolved',
      message: explicit ? '本日游猎来源支持两个动物任选；地理范围、车辆与向导陪体不转为图片身份或同框要求'
        : '继续游猎恢复为原文支持的野生动物目标，不借其他DAY补动物事实；原动物选择仅留作画面偏好',
      originalQueryCore: structuredClone(core), originalPrimaryVisualSubject: visual,
      originalLocationRole: slot.locationRole, softViewPreferences: [visual],
      sourceRefs: [...slot.sourceRefs], speciesSourceMode: explicit ? 'same_day_explicit' : 'same_day_generic_continuation' } };
}

export function wildlifeQueryBranches(slot) {
  const subjects = slot.animalSubjectOptions?.mode === "any" && slot.animalSubjectOptions.options;
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 2) return null;
  const actions = slot.animalActionOptions?.mode === "any" && slot.animalActionOptions.options;
  if (!actions) return subjects;
  if (!Array.isArray(actions) || actions.length !== 2) return null;
  return subjects.length === 1 ? actions.map(action => ({ ...subjects[0], ...action }))
    : subjects.map((subject, index) => ({ ...subject, ...actions[index] }));
}

// Common-category recovery is separate from distinct-animal OR. It never
// chooses the first subtype or removes a source's specific subject promise.
export function repairCommonVisualSubject(slot, facts = {}) {
  const bound = boundDay(slot, facts), core = slot.queryCore || {};
  if (!bound || slot.userLocked) return null;
  const visual = clean(slot.primaryVisualSubject), source = clean(bound.day.experience);
  let queryCore, primaryVisualSubject, code;
  const rhinoPair = /(黑犀牛|白犀牛)\s*(?:或者|或|\/)\s*(黑犀牛|白犀牛)/.exec(visual);
  if (rhinoPair && rhinoPair[1] !== rhinoPair[2]) {
    const namedSubtypes = ['黑犀牛', '白犀牛'].filter(name => source.includes(name));
    if (slot.exactIdentityRequired !== false || slot.locationRole !== 'scope_only'
      || clean(core.identity) || clean(core.identityEn)
      || !(namedSubtypes.length === 2 || namedSubtypes.length === 0 && source.includes('犀牛')) || !/游猎|观察|追踪/.test(source)
      || /保证|必见|仅限|不得|不能|不含|不安排|必须|指定|只看|只拍/.test(source)) return null;
    const zh = clean(core.subject), en = clean(core.subjectEn);
    const zhPair = /^(黑犀牛|白犀牛)\s*(?:或者|或|\/)\s*(黑犀牛|白犀牛)$/.exec(zh);
    const enPair = /^(black|white)\s+(?:rhinos?|rhinoceros(?:es)?)\s*(?:or|\/)\s*(black|white)\s+(?:rhinos?|rhinoceros(?:es)?)$/i.exec(en);
    if (!(zh === '犀牛' && /^(?:rhinos?|rhinoceros(?:es)?)$/i.test(en)
      || zhPair && enPair && zhPair[1] !== zhPair[2]
      && zhPair.slice(1).every((name, i) => ({黑犀牛:'black',白犀牛:'white'})[name] === enPair[i + 1].toLowerCase()))) return null;
    const remainder = visual.replace(rhinoPair[0], '').replace(clean(slot.location), '');
    if (remainder.replace(/草原|行走|休息|伏卧|游猎|场景|中的|中|上|在|的|[\s，。、：:]/g, '')
      || ![['',''],['行走','walking'],['休息','resting'],['伏卧','resting']].some(([zh, en]) => clean(core.action) === zh && clean(core.actionEn).toLowerCase() === en)) return null;
    queryCore = {...core, subject:'犀牛', subjectEn:zh === '犀牛' ? en : 'rhino'};
    primaryVisualSubject = ['犀牛',core.action].filter(Boolean).join(' ');
    code = 'common_animal_subject_resolved';
  } else {
    // Only the observed same-museum exterior/courtyard choice. The exact
    // entity remains mandatory and the common subject remains outdoors.
    if (slot.exactIdentityRequired !== true || slot.locationRole !== 'visual_identity'
      || !clean(core.identity) || clean(slot.location) !== clean(core.identity)
      || !/博物馆/.test(core.identity) || !source.includes(core.identity)
      || !/打卡|参观|前往|游览|到访/.test(source)
      || clean(core.action) || clean(core.actionEn)
      || !/^(?:博物馆建筑|博物馆外观|博物馆庭院|博物馆室外实景)$/.test(clean(core.subject))
      || !/^(?:museum building|museum exterior|museum courtyard|museum outdoor setting)$/i.test(clean(core.subjectEn))) return null;
    const pair = /(?:建筑)?外观\s*(?:或者|或|\/)\s*庭院|庭院\s*(?:或者|或|\/)\s*(?:建筑)?外观/.exec(visual);
    if (!pair || visual.replace(pair[0], '').replace(core.identity, '').replace(/[\s，。、：:的]/g, '')) return null;
    const entityClauses = source.split(/[。；;\n]/).filter(clause => clause.includes(core.identity)).join(' ');
    if (/保证|仅限|不得|不能|不含|不安排|必须|指定|只看|只拍|外观|庭院|室内|展厅|馆藏|展品/.test(entityClauses)
      || /室内|展厅|馆藏|展品|婚礼/.test(clean(slot.visualDuty))) return null;
    queryCore = {...core, subject:'博物馆室外实景',subjectEn:'museum outdoor setting'};
    primaryVisualSubject = `${core.identity}室外实景`;
    code = 'common_entity_view_resolved';
  }
  const queries = [[queryCore.subject, queryCore.action], [queryCore.subjectEn, queryCore.actionEn]].map(parts => parts.filter(Boolean).join(' '));
  if (slot.exactIdentityRequired) {
    queries[0] = `${queryCore.identity} ${queries[0]}`;
    queries[1] = `${queryCore.identityEn || queryCore.identity} ${queries[1]}`;
  }
  return {queryCore,primaryVisualSubject,fidelityQuery:queries[0],alternateQueries:queries.slice(1),searchIntent:queries,
    animalSubjectOptions:undefined,animalActionOptions:undefined,
    repair:{code,version:'common-visual-subject-v1',sourceRefs:[...slot.sourceRefs],
      message:code === 'common_animal_subject_resolved' ? '来源支持的同类动物选择归到犀牛共同主体，不预选亚类；必要动作与范围保留'
        : '同一博物馆外观与庭院归到代表性室外画面，具体场馆身份仍必需，不扩展到室内',
      originalQueryCore:structuredClone(core),originalPrimaryVisualSubject:visual,softViewPreferences:[visual]}};
}

export function repairFactBoundDepartureVisual(slot, facts = {}) {
  const bound = boundDay(slot, facts), core = slot.queryCore || {};
  if (!bound || bound.index !== facts.days.length - 1 || slot.role.includes(":supporting:") || slot.userLocked
    || slot.exactIdentityRequired !== false || slot.locationRole !== "scope_only" || clean(core.identity) || clean(core.identityEn)
    || !/^(?:机场送别|送机|送机离境|离境|返程|airport farewell|airport departure|send[- ]?off)$/i.test(clean(core.subject))
    || /或|二选一|\bor\b/i.test(`${core.action} ${core.actionEn}`)
    || !/送机|送往机场|前往机场.*离境/.test(clean(bound.day.experience))) return null;
  const vehicle = clean(bound.day.vehicle);
  if (!/^(?:商务用车|商务车|商务接送车辆|商务接待车辆)$/.test(vehicle)) return null;
  const queryCore = { ...core, subject: "商务用车", subjectEn: "business transfer vehicle", action: "机场接送", actionEn: "airport transfer" };
  const queries = ["商务用车 机场接送", "business vehicle airport transfer"];
  return { queryCore, primaryVisualSubject: "商务用车机场接送场景", fidelityQuery: queries[0], alternateQueries: queries.slice(1), searchIntent: queries,
    sourceRefs: [...new Set([...slot.sourceRefs, `days.${bound.index}.vehicle`])],
    repair: { code: "fact_bound_departure_visual_resolved", message: "仅从返程日送机事实及明确商务车类别恢复可拍画面，不增添酒店、机场、车型或人物承诺",
      originalQueryCore: structuredClone(core), originalPrimaryVisualSubject: slot.primaryVisualSubject } };
}
