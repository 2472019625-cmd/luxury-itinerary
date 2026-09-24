import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeSimpleSkillPlan } from '../server/simple-plan-adapter.mjs';
import { validateSimpleDayVisuals } from '../server/agent-trip-planner.mjs';
import { buildImageQueries, buildControlledFallbackPlan, failedHardRequirement, imageSlotPriority } from '../server/simple-image-skill.mjs';
import { dayVisualCards } from '../src/lib/dayVisualCards.js';
import { buildLayoutImageSlots, getSlotImage, setSlotImage } from '../src/lib/imageSlots.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';
import { applySimpleSkillResults } from '../server/simple-pipeline-writeback.mjs';

function fixture(subject = '大象与乞力马扎罗', supporting = []) {
  const data = { destination: '肯尼亚', hotels: [], diningExperiences: [], transportSummary: [], notes: [], days: [{ city: '安博塞利', routeNodes: ['安博塞利', '夜间游猎', '星空床', 'Sundowner', 'Westgate'], description: '象群与雪山，步行Safari和夜间游猎', spots: [{ name: '安博塞利游猎', status: 'included', feeBoundary: 'included', sourceEvidence: ['原始事实'], images: [] }, { name: '接送入住', images: [] }] }] };
  const agentPlan = { selectedHighlights: [], dayRoles: [{ index: 0, role: '雪山下的象群', primaryVisualSubject: '角色层视觉', differenceFromAdjacent: '开启旅程' }], imagePlan: { slots: [{ role: 'day:1', required: true, primaryVisualSubject: subject, visualDuty: '突出雪山下的野生象群', differentiation: '建立旅程记忆', searchIntent: ['象群与雪山', '草原象群', 'elephants Kilimanjaro'], sourceRefs: ['days.0'] }, ...supporting.map((s, i) => ({ role: `day:1:supporting:${i + 1}`, primaryVisualSubject: s, required: false, removable: true, searchIntent: [s, `${s}场景`] }))] } };
  return { data, agentPlan, plan: materializeSimpleSkillPlan({ data, agentPlan }) };
}

test('Planner视觉保真、无同名Spot合法、地理字段不受活动污染且原始Spot不变', () => {
  const { data, plan } = fixture();
  const slot = plan.imageSlots.find(s => s.moduleType === 'day');
  assert.equal(slot.primaryVisualSubject, '大象与乞力马扎罗');
  assert.equal(slot.subject, slot.primaryVisualSubject);
  assert.equal(slot.activity, slot.primaryVisualSubject);
  assert.deepEqual(slot.searchIntent, ['象群与雪山', '草原象群', 'elephants Kilimanjaro']);
  assert.equal(slot.visualDuty, '突出雪山下的野生象群');
  assert.match(slot.visualGoal, /突出雪山下的野生象群/);
  assert.equal(slot.location, '安博塞利');
  assert.deepEqual(plan.preparedData.days[0].spots, data.days[0].spots);
  assert.deepEqual(buildImageQueries(slot), ['象群与雪山', '草原象群', 'elephants Kilimanjaro']);
});

test('Planner Query核心主体与动作完整传入图片位', () => {
  const { data, agentPlan } = fixture();
  agentPlan.imagePlan.slots[0].queryCore = { subject: '象群', action: '饮水', identity: '', subjectEn: 'elephants', actionEn: 'drinking', identityEn: '' };
  const slot = materializeSimpleSkillPlan({ data, agentPlan }).imageSlots.find((item) => item.moduleType === 'day');
  assert.deepEqual(slot.queryCore, { subject: '象群', action: '饮水', identity: '', subjectEn: 'elephants', actionEn: 'drinking', identityEn: '' });
});

test('长颈鹿中心视觉不回落到飞机Spot；slot缺主题时才用dayRole', () => {
  const { data, agentPlan } = fixture('长颈鹿中心');
  data.days[0].spots[0].name = '草原飞机抵达';
  let plan = materializeSimpleSkillPlan({ data, agentPlan });
  assert.equal(plan.imageSlots.find(s => s.moduleType === 'day').subject, '长颈鹿中心');
  delete agentPlan.imagePlan.slots[0].primaryVisualSubject;
  plan = materializeSimpleSkillPlan({ data, agentPlan });
  assert.equal(plan.imageSlots.find(s => s.moduleType === 'day').subject, '角色层视觉');
});

test('真实导入形态：国家级酒店region不能盖过保护区，酒店名及送机不是地理范围', () => {
  const { data, agentPlan } = fixture();
  data.hotels = [{ officialName: 'Saruni Leopard Hill', shortName: 'Saruni Leopard Hill', region: '肯尼亚' }];
  Object.assign(data.days[0], { hotel: 'Saruni Leopard Hill', city: '马赛马拉全天游猎', routeNodes: ['马赛马拉', 'Naboisho私人保护区中心', '夜间游猎', 'Saruni Leopard Hill'] });
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan }).imageSlots.find(s => s.moduleType === 'day').location, 'Naboisho私人保护区中心');
  Object.assign(data.days[0], { hotel: '', city: '内罗毕 - 送机离境', routeNodes: ['JW Marriott Hotel Nairobi', '乔莫·肯雅塔国际机场', '送机离境'] });
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan }).imageSlots.find(s => s.moduleType === 'day').location, '内罗毕');
});

test('1主+3辅助仅来自Planner，普通Spot不自动建图，二选一主题被拒绝', () => {
  const { plan } = fixture(undefined, ['Observation Hill', '步行Safari', '夜间游猎']);
  const slots = plan.imageSlots.filter(s => s.moduleType === 'day');
  assert.equal(slots.length, 4);
  assert.equal(slots.filter(s => s.required).length, 1);
  assert.ok(slots.slice(1).every(s => s.removable && s.visualTier === 'supporting'));
  assert.ok(slots.every(s => s.subject !== '接送入住'));
  assert.ok(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '狮群或营地酒会' }] } }).length);
  assert.ok(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '先乘船观察动物；随后上岸徒步' }] } }).some(error => error.code === 'composite_visual_subject'));
  assert.ok(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '上午参观工坊，然后前往餐厅用餐' }] } }).some(error => error.code === 'composite_visual_subject'));
  assert.equal(validateSimpleDayVisuals({ imagePlan: { slots: [
    { role: 'day:1', primaryVisualSubject: '游船追踪河马', searchIntent: ['游船追踪河马', '河马游船'] },
    { role: 'day:1:supporting:1', primaryVisualSubject: '鱼鹰俯冲捕鱼', required: false, removable: true, searchIntent: ['鱼鹰捕鱼', '鱼鹰俯冲'] },
    { role: 'day:1:supporting:2', primaryVisualSubject: '斑马与长颈鹿', required: false, removable: true, searchIntent: ['斑马与长颈鹿', '草原斑马长颈鹿'] },
  ] } }).length, 0);
  assert.equal(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '徒步观察斑马与长颈鹿', searchIntent: ['徒步观察斑马', '徒步观察长颈鹿'] }] } }).length, 0);
  assert.equal(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '导览徒步，动物在身旁自由漫步', searchIntent: ['导览徒步', '动物旁徒步'] }] } }).length, 0);
  assert.equal(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '大象与乞力马扎罗', searchIntent: ['象群与雪山', '草原象群'] }] } }).length, 0);
  assert.equal(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '热气球俯瞰迁徙兽群', searchIntent: ['热气球迁徙兽群', '热气球俯瞰草原'] }] } }).length, 0);
});

test('酒店、餐饮、交通与DAY统一执行具体画面和跨模块视觉职责校验', () => {
  const fields = (role, primaryVisualSubject, subject, action = '') => ({
    role,
    primaryVisualSubject,
    location: '示例地区',
    locationRole: 'scope_only',
    queryCore: { subject, action },
    fidelityQuery: `${subject}${action}`,
    alternateQueries: [`${subject}特写`],
  });
  const errors = validateSimpleDayVisuals({ imagePlan: { slots: [
    fields('cover', '草原动物群', '草原动物群'),
    fields('hotel:1', '客房或公共空间', '酒店空间'),
    fields('dining:1', '用餐体验', '用餐体验'),
    fields('transport:1', '送机离境', '送机离境'),
    fields('day:1', '篝火晚餐上桌', '篝火晚餐', '上桌'),
    fields('dining:2', '篝火晚餐上桌', '篝火晚餐', '上桌'),
  ] } }, { hotels: [{}], diningExperiences: [{}, {}], transport: [{}], days: [{}] });
  assert.ok(errors.some((error) => error.code === 'ambiguous_visual_subject' && /hotel:1/.test(error.message)));
  assert.ok(errors.some((error) => error.code === 'abstract_visual_subject' && /dining:1/.test(error.message)));
  assert.ok(errors.some((error) => error.code === 'abstract_visual_subject' && /transport:1/.test(error.message)));
  assert.ok(errors.some((error) => error.code === 'duplicate_visual_responsibility' && /dining:2/.test(error.message)));
});

test('DAY图片位分别决定地点，过滤车程假地点，并从主体中移除普通地点与酒店', () => {
  const { data, agentPlan } = fixture('安博塞利专业向导带队步行Safari', ['纳瓦沙湖畔Sopa度假村金合欢树间的长颈鹿与斑马', 'Observation Hill俯瞰湿地']);
  data.hotels = [{ officialName: 'Lake Naivasha Sopa Resort', shortName: 'Sopa度假村', region: '纳瓦沙湖' }];
  Object.assign(data.days[0], {
    hotel: 'Lake Naivasha Sopa Resort',
    city: '安博塞利 → 纳瓦沙湖（车程约5-6小时）',
    routeNodes: ['安博塞利', '5小时）', '（ ）', '纳瓦沙湖', 'Sopa度假村'],
    spots: [
      { name: '专业向导带队步行Safari', description: '在安博塞利步行观察', sourceEvidence: ['安博塞利步行Safari'], images: [] },
      { name: '度假村野生动物', description: '纳瓦沙湖Sopa度假村金合欢树间的长颈鹿与斑马', sourceEvidence: ['纳瓦沙湖', 'Sopa度假村'], images: [] },
      { name: 'Observation Hill', description: 'Observation Hill俯瞰湿地', sourceEvidence: ['Observation Hill'], images: [] },
    ],
  });
  agentPlan.imagePlan.slots[0].sourceRefs = ['days.0.spots.0'];
  agentPlan.imagePlan.slots[1].sourceRefs = ['days.0.spots.1'];
  agentPlan.imagePlan.slots[2].sourceRefs = ['days.0.spots.2'];
  const plan = materializeSimpleSkillPlan({ data, agentPlan });
  const slots = plan.imageSlots.filter(item => item.moduleType === 'day');
  assert.equal(slots[0].location, '安博塞利');
  assert.equal(slots[0].primaryVisualSubject, '专业向导带队步行Safari');
  assert.match(slots[1].location, /^纳瓦沙湖/);
  assert.match(slots[1].location, /Lake Naivasha Sopa Resort/);
  assert.equal(slots[1].primaryVisualSubject, '金合欢树间的长颈鹿与斑马');
  assert.equal(slots[2].location, 'Observation Hill / 安博塞利');
  assert.equal(slots[2].primaryVisualSubject, '俯瞰湿地');
  assert.ok(slots.every(item => !/5小时|（\s*）/.test(`${item.location} ${(item.visualContext.routeNodes || []).join(' ')}`)));
  const copyTask = plan.copyTasks.find(item => item.layoutHints?.slotId === slots[1].slotId);
  assert.equal(copyTask.facts.titleCoreSubject, '金合欢树间的长颈鹿与斑马');
});

test('Observation Hill作为拍摄位置时进入location；Adapter不再按案例词表替Planner拆图', () => {
  const { data, agentPlan } = fixture('Observation Hill山顶俯瞰湿地与象群', ['地狱门国家公园火山峭壁与地热蒸汽间骑行']);
  Object.assign(data.days[0], {
    city: '安博塞利 → 纳瓦沙湖',
    routeNodes: ['安博塞利', 'Observation Hill', '纳瓦沙湖', '探访地狱门国家公园'],
    description: '登上Observation Hill俯瞰湿地与象群；可自费探访地狱门国家公园，欣赏火山峭壁并在地热蒸汽间骑行。',
    spots: [
      { name: 'Observation Hill', description: '从山顶俯瞰湿地与象群', sourceEvidence: ['Observation Hill'], images: [] },
      { name: '地狱门国家公园', description: '火山峭壁与地热蒸汽间骑行', sourceEvidence: ['地狱门国家公园'], images: [] },
    ],
  });
  agentPlan.imagePlan.slots[0].sourceRefs = ['days.0.spots.0'];
  agentPlan.imagePlan.slots[1].sourceRefs = ['days.0.spots.1'];
  const slots = materializeSimpleSkillPlan({ data, agentPlan }).imageSlots.filter((slot) => slot.moduleType === 'day');
  assert.equal(slots.length, 2);
  assert.equal(slots[0].location, 'Observation Hill / 安博塞利');
  assert.equal(slots[0].primaryVisualSubject, '山顶俯瞰湿地与象群');
  assert.equal(slots[1].primaryVisualSubject, '火山峭壁与地热蒸汽间骑行');
  assert.ok(!/地狱门国家公园/.test(slots[1].primaryVisualSubject));
});

test('跨地区DAY按主体在当天原文中的邻近地点选择Scope，而不是共用终点', () => {
  const { data, agentPlan } = fixture('纳瓦沙湖夜间安全观景台观赏河马上岸觅食', ['新月岛导览徒步与岛上斑马长颈鹿']);
  Object.assign(data.days[0], {
    city: '纳瓦沙湖 → 马赛马拉（车程约4-5小时）',
    routeNodes: ['纳瓦沙湖', '马赛马拉国家保护区'],
    description: '乘游船深入纳瓦沙湖，夜间从安全观景台观赏河马上岸。登新月岛参与导览徒步，随后驱车前往马赛马拉国家保护区。',
    spots: [
      { name: '夜间观景', description: '夜间从安全观景台观赏河马上岸，随后前往马赛马拉国家保护区', sourceEvidence: [], images: [] },
      { name: '新月岛徒步', description: '登新月岛参与导览徒步，斑马与长颈鹿自由漫步', sourceEvidence: [], images: [] },
    ],
  });
  agentPlan.imagePlan.slots[0].sourceRefs = ['days.0.spots.0'];
  agentPlan.imagePlan.slots[1].sourceRefs = ['days.0.spots.1'];
  const slots = materializeSimpleSkillPlan({ data, agentPlan }).imageSlots.filter((slot) => slot.moduleType === 'day');
  assert.equal(slots[0].location, '纳瓦沙湖');
  assert.equal(slots[1].location, '新月岛');
});

test('真实binding保留空位索引，前端隐藏普通Spot及缺失辅助图，主视觉仍可编辑', () => {
  const { plan } = fixture(undefined, ['步行Safari', '夜间游猎']);
  const data = plan.preparedData;
  const bindings = data.simpleImageSlotBindings;
  const slots = buildLayoutImageSlots(data).filter(s => s.module === 'day');
  assert.equal(buildLayoutImageSlots(data).find(s => s.module === 'cover').label, '封面主图');
  assert.equal(buildLayoutImageSlots(data).find(s => s.module === 'cover').ratio, '5:3');
  setSlotImage(data, slots[2], { src: '/image-assets/night.jpg' });
  setSlotImage(data, slots[1], null);
  assert.equal(getSlotImage(data, slots[2]).src, '/image-assets/night.jpg');
  assert.equal(getSlotImage(data, slots[0]), null);
  const cards = dayVisualCards(data.days[0], 0, bindings);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(c => c.imageIndex), [0, 2]);
  assert.equal(cards[0].spot.images.length, 0);
  assert.equal(cards[0].spot.name, '行程体验');
  assert.equal(cards[0].spot.description, '');
  const customer = selectCustomerRenderData(data);
  assert.equal(dayVisualCards(customer.days[0], 0, customer.simpleImageSlotBindings).length, 2);
  assert.equal(customer.simpleImageSlotBindings, undefined);
});

test('独立视觉短文案随Copy批次写回，不复制泛化Spot；客户投影一致', () => {
  const { plan } = fixture(undefined, ['步行Safari', '夜间游猎']);
  const tasks = plan.copyTasks.filter(task => task.moduleType === 'visual_card');
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].facts.titleCoreSubject, plan.imageSlots.find(slot => slot.slotId === tasks[0].layoutHints.slotId).primaryVisualSubject);
  assert.match(tasks[0].plannerGoal, /不能用泛标题掩盖/);
  const texts = ['清晨寻找象群，天气允许时欣赏雪山背景。', '跟随向导步行，从地面角度观察草原。', '夜间开启游猎，感受与白天不同的观察体验。'];
  const titles = ['雪山下追踪象群', '步行 Safari', '夜间游猎'];
  const result = applySimpleSkillResults({ ...plan, copyTasks: tasks, copyExecution: { results: tasks.map((task, i) => ({ ...task, status: 'success', value: { cardTitle: titles[i], cardDescription: texts[i] } })) }, imageExecution: { results: plan.imageSlots.filter(s => s.moduleType === 'day').map(s => ({ slotId: s.slotId, status: 'success', selected: { localUrl: '/image-assets/test.jpg' } })) } });
  const cards = dayVisualCards(result.data.days[0], 0, result.data.simpleImageSlotBindings);
  assert.deepEqual(cards.map(c => c.spot.description), texts);
  assert.deepEqual(cards.map(c => c.spot.name), titles);
  assert.deepEqual(buildLayoutImageSlots(result.data).filter(s => s.module === 'day').map(s => s.label), titles);
  assert.equal(new Set(cards.map(c => c.spot.description)).size, 3);
  assert.deepEqual(selectCustomerRenderData(result.data).days[0].spots.map(s => s.description), texts);
  assert.equal(fixture().plan.imageSlots.filter(s => s.moduleType === 'day').length, 1);
});

test('同名Spot保留原名、原文、状态与费用，客户标题独立显示', () => {
  const { plan } = fixture('安博塞利游猎');
  const searchSlotsBeforeCopy = structuredClone(plan.imageSlots);
  plan.preparedData.days[0].spots[0].description = '已有的游猎体验介绍';
  const task = plan.copyTasks.find(t => t.moduleType === 'visual_card');
  const result = applySimpleSkillResults({ ...plan, copyTasks: [task], copyExecution: { results: [{ ...task, status: 'success', value: { cardTitle: '走进安博塞利的游猎时光', cardDescription: '乘车进入保护区，从车窗观察草原上的动物踪迹。' } }] }, imageExecution: { results: [] } });
  const card = dayVisualCards(result.data.days[0], 0, result.data.simpleImageSlotBindings)[0].spot;
  assert.equal(result.data.days[0].spots[0].name, '安博塞利游猎');
  assert.equal(card.name, '走进安博塞利的游猎时光');
  assert.equal(selectCustomerRenderData(result.data).days[0].spots[0].name, card.name);
  assert.equal(card.description, '已有的游猎体验介绍');
  assert.equal(card.status, 'included');
  assert.equal(card.feeBoundary, 'included');
  assert.equal(buildLayoutImageSlots(result.data).find(s => s.slotId === task.layoutHints.slotId).label, card.name);
  assert.equal(plan.copyTasks.filter(t => t.moduleType === 'visual_card').length, 1);
  assert.deepEqual(plan.imageSlots, searchSlotsBeforeCopy);
});

test('独立视觉通过括号来源引用保留自费状态，但不复制泛化描述', () => {
  const { data, agentPlan } = fixture('热气球俯瞰草原');
  Object.assign(data.days[0].spots[0], { name: '清晨热气球Safari', status: 'optional_paid', statusLabel: '自费可选', feeBoundary: 'optional_paid', description: '自费参加热气球' });
  agentPlan.imagePlan.slots[0].sourceRefs = ['factBasis.days[0].spots[0]'];
  const plan = materializeSimpleSkillPlan({ data, agentPlan });
  const card = dayVisualCards(plan.preparedData.days[0], 0, plan.preparedData.simpleImageSlotBindings)[0].spot;
  assert.equal(card.status, 'optional_paid');
  assert.equal(card.feeBoundary, 'optional_paid');
  assert.equal(card.description, '');
});

test('错误营地和错误国家不能冒充DAY活动；马赛马拉不触发文化fallback', () => {
  const pass = { technicalUsable: true, watermarkFree: true, nonAI: true, photographic: true, locationMatch: true, visibleLocationConflict: false, hotelIdentityMatch: true, visibleIdentityConflict: false, activityMatch: true, coreActionMatch: true, subjectMatch: true, coreSubjectMatch: true, identityMatch: true, subjectClear: true, subjectLargeEnough: true, subjectPrimary: true, transportTypeMatch: true, eligible: true };
  const slot = { moduleType: 'day', location: '马赛马拉 Naboisho Kenya', locationRole: 'scope_only', subject: '私保区游猎与豹类追踪', queryCore: { subject: '私保区游猎与豹类追踪', action: '游猎' }, required: true };
  assert.equal(failedHardRequirement(slot, { ...pass, coreSubjectMatch: false, actualSubject: 'Great Plains Mara Nyika Camp tents' }), 'wrong_subject');
  assert.equal(failedHardRequirement({ ...slot, queryCore: { subject: 'Naboisho私人保护区丛林中的花豹', action: '追踪花豹' } }, { ...pass, coreSubjectMatch: false, actualSubject: 'Great Plains Mara Nyika Camp tents' }), 'wrong_subject');
  assert.equal(failedHardRequirement({ ...slot, location: '安博塞利' }, { ...pass, locationMatch: false, visibleLocationConflict: true, hardRejectCode: 'wrong_location', actualSubject: 'Botswana Okavango safari boat with elephants' }), 'wrong_location');
  assert.equal(buildControlledFallbackPlan({ ...slot, slotId: 'image:day:6:primary', activity: '马赛马拉全天游猎', subject: 'Masai Mara game drive' }), null);
  assert.equal(imageSlotPriority(slot), 0);
  assert.equal(imageSlotPriority({ moduleType: 'hotel', required: true }), 1);
  assert.equal(imageSlotPriority({ moduleType: 'day', required: false }), 2);
  assert.equal(imageSlotPriority({ moduleType: 'transport', required: false }), 3);
});

test('关键动作未出现在实际画面时不自动采用，但不是身份硬拒绝', () => {
  const pass = { technicalUsable: true, watermarkFree: true, nonAI: true, photographic: true, locationMatch: true, visibleLocationConflict: false, hotelIdentityMatch: true, visibleIdentityConflict: false, activityMatch: true, coreActionMatch: true, subjectMatch: true, coreSubjectMatch: true, identityMatch: true, subjectClear: true, subjectLargeEnough: true, subjectPrimary: true, transportTypeMatch: true, eligible: true, matchLevel: 'exact', hardRejectCode: 'none' };
  const slot = (subject, action) => ({ moduleType: 'day', subject, queryCore: { subject, action } });
  assert.equal(failedHardRequirement(slot('向导带队步行Safari', '步行'), { ...pass, activityMatch: false, coreActionMatch: false, actualSubject: '一名向导站在草原上', reason: '人物清晰' }), 'wrong_activity');
  assert.equal(failedHardRequirement(slot('向导带队步行Safari', '步行'), { ...pass, activityMatch: false, coreActionMatch: false, matchLevel: 'representative', actualSubject: '一名向导站在草原上', reason: '人物清晰' }), 'wrong_activity');
  assert.equal(failedHardRequirement(slot('户外星空晚宴', '用餐'), { ...pass, activityMatch: false, coreActionMatch: false, actualSubject: '星空下的篝火与帐篷', reason: '夜景清晰' }), 'wrong_activity');
  assert.equal(failedHardRequirement(slot('鱼鹰俯冲捕鱼', '俯冲捕鱼'), { ...pass, activityMatch: false, coreActionMatch: false, actualSubject: '一只鱼鹰停在树枝上', reason: '鱼鹰清晰但没有捕鱼动作' }), 'wrong_activity');
  assert.equal(failedHardRequirement(slot('长颈鹿零距离互动', '游客近距离互动'), { ...pass, activityMatch: false, coreActionMatch: false, actualSubject: '一只长颈鹿单独站立', reason: '没有游客互动' }), 'wrong_activity');
  assert.equal(failedHardRequirement(slot('大象雪山与Sundowner落日酒会', '日落酒会'), { ...pass, activityMatch: false, coreActionMatch: false, actualSubject: '大象与乞力马扎罗雪山', reason: '虽无酒会元素，但黄昏光线契合Sundowner语境' }), 'wrong_activity');
  assert.equal(failedHardRequirement(slot('向导带队步行Safari', '步行'), { ...pass, actualSubject: '向导带领客人在草原徒步行走', reason: '步行活动清晰' }), null);
  assert.equal(failedHardRequirement(slot('长颈鹿零距离互动', '游客近距离互动'), { ...pass, actualSubject: '长颈鹿舔游客手掌，游客在旁近距离互动', reason: '人与长颈鹿互动清晰' }), null);
});
