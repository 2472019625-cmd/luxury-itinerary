import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageQueries, buildImageConstraints } from '../server/simple-image-skill.mjs';
import { validateCopyCommitments, validateVisualCardSubjectRetention } from '../server/simple-copy-skill.mjs';
import { dayVisualCards } from '../src/lib/dayVisualCards.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';

test('DAY query直接使用searchIntent，客户标题不改变查询和图片硬条件', () => {
  const slot = { moduleType: 'day', location: 'Naboisho私人保护区', primaryVisualSubject: 'Naboisho保护区中一只花豹栖于树上', subject: 'Naboisho保护区中一只花豹栖于树上', searchIntent: ['Naboisho leopard safari', 'leopard tracking safari'] };
  assert.deepEqual(buildImageQueries(slot, 2), ['Naboisho leopard safari', 'leopard tracking safari']);
  const changed = {...slot, cardTitle: '客户编辑的新标题', cardDescription: '客户编辑的新描述'};
  assert.deepEqual(buildImageQueries(changed), buildImageQueries(slot));
  assert.deepEqual(buildImageConstraints(changed), buildImageConstraints(slot));
  assert.ok(buildImageConstraints(slot).mustHave.some(value => value.includes(slot.primaryVisualSubject)));
});

test('客户投影只用cardTitle/cardDescription，兼容旧描述但不泄漏内部视觉主题', () => {
  const data = { days: [{ spots: [{name:'普通Spot', images:[]}]}], simpleImageSlotBindings: { 'image:day:1:primary': {module:'day',dayIndex:0,spotIndex:0,imageIndex:0,required:true,useSpotCopy:false,visualSubject:'内部画面长句',searchIntent:'internal search query',cardTitle:'私保区追踪花豹',cardDescription:'跟随向导探访保护区，寻找花豹的活动踪迹。',status:'included',feeBoundary:'included'} } };
  const card = dayVisualCards(data.days[0],0,data.simpleImageSlotBindings)[0].spot;
  assert.equal(card.name,'私保区追踪花豹');
  assert.equal(card.status,'included');
  assert.equal(card.description, data.simpleImageSlotBindings['image:day:1:primary'].cardDescription);
  const customer = JSON.stringify(selectCustomerRenderData(data));
  assert.doesNotMatch(customer,/内部画面长句|internal search query/);
  delete data.simpleImageSlotBindings['image:day:1:primary'].cardTitle;
  assert.equal(dayVisualCards(data.days[0],0,data.simpleImageSlotBindings)[0].spot.name,'行程体验');
});

test('视觉卡对象的标题和描述仍经过原有承诺检查', () => {
  const task = {moduleType:'visual_card',facts:{source:'寻找动物'},factStatuses:{}};
  assert.ok(validateCopyCommitments({cardTitle:'保证看到花豹',cardDescription:'观察草原'},task).length);
  assert.ok(validateCopyCommitments({cardTitle:'花豹追踪',cardDescription:'保证看到花豹'},task).length);
  assert.deepEqual(validateCopyCommitments({cardTitle:'花豹追踪',cardDescription:'跟随向导寻找花豹踪迹。'},task),[]);
});

test('明确视觉主体不能被DAY视觉卡降级为泛化游猎标题', () => {
  const leopard = { moduleType: 'visual_card', facts: { visualSubject: 'Naboisho保护区中一只花豹栖于树上', titleCoreSubject: '花豹追踪' } };
  assert.match(validateVisualCardSubjectRetention({ cardTitle: '傍晚游猎', cardDescription: '进入保护区观察。' }, leopard)[0], /丢失了明确视觉主体/);
  assert.deepEqual(validateVisualCardSubjectRetention({ cardTitle: 'Naboisho私保区追踪花豹', cardDescription: '进入保护区观察。' }, leopard), []);
  const generic = { moduleType: 'visual_card', facts: { visualSubject: '马赛马拉全天游猎' } };
  assert.deepEqual(validateVisualCardSubjectRetention({ cardTitle: '马赛马拉全天游猎', cardDescription: '进入草原观察。' }, generic), []);
});
