import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageQueries, buildImageConstraints } from '../server/simple-image-skill.mjs';
import { validateCopyCommitments } from '../server/simple-copy-skill.mjs';
import { dayVisualCards } from '../src/lib/dayVisualCards.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';

test('DAY query直接使用searchIntent，客户标题不改变查询和图片硬条件', () => {
  const slot = { moduleType: 'day', location: 'Naboisho私人保护区', primaryVisualSubject: 'Naboisho保护区中一只花豹栖于树上', subject: 'Naboisho保护区中一只花豹栖于树上', searchIntent: 'Naboisho leopard safari' };
  assert.deepEqual(buildImageQueries(slot, 2), ['Naboisho leopard safari', 'Naboisho leopard safari photos']);
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
