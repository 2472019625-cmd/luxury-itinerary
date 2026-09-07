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
  const agentPlan = { selectedHighlights: [], dayRoles: [{ index: 0, role: '雪山下的象群', primaryVisualSubject: '角色层视觉', differenceFromAdjacent: '开启旅程' }], imagePlan: { slots: [{ role: 'day:1', required: true, primaryVisualSubject: subject, visualDuty: '突出雪山下的野生象群', differentiation: '建立旅程记忆', searchIntent: 'Amboseli elephants Kilimanjaro', sourceRefs: ['days.0'] }, ...supporting.map((s, i) => ({ role: `day:1:supporting:${i + 1}`, primaryVisualSubject: s, required: false, removable: true, searchIntent: s }))] } };
  return { data, agentPlan, plan: materializeSimpleSkillPlan({ data, agentPlan }) };
}

test('Planner视觉保真、无同名Spot合法、地理字段不受活动污染且原始Spot不变', () => {
  const { data, plan } = fixture();
  const slot = plan.imageSlots.find(s => s.moduleType === 'day');
  assert.equal(slot.primaryVisualSubject, '大象与乞力马扎罗');
  assert.equal(slot.subject, slot.primaryVisualSubject);
  assert.equal(slot.activity, slot.primaryVisualSubject);
  assert.equal(slot.searchIntent, 'Amboseli elephants Kilimanjaro');
  assert.match(slot.visualGoal, /突出雪山下的野生象群/);
  assert.equal(slot.location, '安博塞利');
  assert.deepEqual(plan.preparedData.days[0].spots, data.days[0].spots);
  assert.ok(buildImageQueries(slot).every(q => q.includes('大象与乞力马扎罗')));
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
  assert.equal(validateSimpleDayVisuals({ imagePlan: { slots: [{ role: 'day:1', primaryVisualSubject: '大象与乞力马扎罗' }] } }).length, 0);
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
  assert.equal(cards[0].spot.name, '大象与乞力马扎罗');
  assert.equal(cards[0].spot.description, '');
  const customer = selectCustomerRenderData(data);
  assert.equal(dayVisualCards(customer.days[0], 0, customer.simpleImageSlotBindings).length, 2);
  assert.equal(customer.simpleImageSlotBindings, undefined);
});

test('独立视觉短文案随Copy批次写回，不复制泛化Spot；客户投影一致', () => {
  const { plan } = fixture(undefined, ['步行Safari', '夜间游猎']);
  const tasks = plan.copyTasks.filter(task => task.moduleType === 'visual_card');
  assert.equal(tasks.length, 3);
  const texts = ['清晨寻找象群，天气允许时欣赏雪山背景。', '跟随向导步行，从地面角度观察草原。', '夜间开启游猎，感受与白天不同的观察体验。'];
  const result = applySimpleSkillResults({ ...plan, copyTasks: tasks, copyExecution: { results: tasks.map((task, i) => ({ ...task, status: 'success', value: texts[i] })) }, imageExecution: { results: plan.imageSlots.filter(s => s.moduleType === 'day').map(s => ({ slotId: s.slotId, status: 'success', selected: { localUrl: '/image-assets/test.jpg' } })) } });
  const cards = dayVisualCards(result.data.days[0], 0, result.data.simpleImageSlotBindings);
  assert.deepEqual(cards.map(c => c.spot.description), texts);
  assert.equal(new Set(cards.map(c => c.spot.description)).size, 3);
  assert.deepEqual(selectCustomerRenderData(result.data).days[0].spots.map(s => s.description), texts);
  assert.equal(fixture().plan.imageSlots.filter(s => s.moduleType === 'day').length, 1);
});

test('同名Spot继续保留原文、状态与费用', () => {
  const { plan } = fixture('安博塞利游猎');
  plan.preparedData.days[0].spots[0].description = '已有的游猎体验介绍';
  const card = dayVisualCards(plan.preparedData.days[0], 0, plan.preparedData.simpleImageSlotBindings)[0].spot;
  assert.equal(card.description, '已有的游猎体验介绍');
  assert.equal(card.status, 'included');
  assert.equal(card.feeBoundary, 'included');
  assert.equal(plan.copyTasks.filter(t => t.moduleType === 'visual_card').length, 0);
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
  const pass = { technicalUsable: true, watermarkFree: true, nonAI: true, photographic: true, locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, eligible: true };
  const slot = { moduleType: 'day', location: '马赛马拉 Naboisho Kenya', subject: '私保区游猎与豹类追踪', activity: '游猎', required: true };
  assert.equal(failedHardRequirement(slot, { ...pass, actualSubject: 'Great Plains Mara Nyika Camp tents' }), 'activity_mismatch');
  assert.equal(failedHardRequirement({ ...slot, activity: 'Naboisho私人保护区丛林中的花豹', subject: 'Naboisho私人保护区丛林中的花豹' }, { ...pass, actualSubject: 'Great Plains Mara Nyika Camp tents' }), 'activity_mismatch');
  assert.equal(failedHardRequirement({ ...slot, location: '安博塞利' }, { ...pass, actualSubject: 'Botswana Okavango safari boat with elephants' }), 'place_mismatch');
  assert.equal(buildControlledFallbackPlan({ ...slot, slotId: 'image:day:6:primary', activity: '马赛马拉全天游猎', subject: 'Masai Mara game drive' }), null);
  assert.equal(imageSlotPriority(slot), 0);
  assert.equal(imageSlotPriority({ moduleType: 'hotel', required: true }), 1);
  assert.equal(imageSlotPriority({ moduleType: 'day', required: false }), 2);
  assert.equal(imageSlotPriority({ moduleType: 'transport', required: false }), 3);
});
