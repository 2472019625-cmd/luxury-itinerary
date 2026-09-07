import assert from 'node:assert/strict';
import test from 'node:test';
import { transportConfigurationLabels, transportProductName, transportUsageLabel } from '../src/lib/transportPresentation.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';

test('customer transport cards use a compact scene label instead of full DAY route mapping', () => {
  const item = { category:'四驱开顶式越野车', usageSegments:['DAY 1 机场 → 营地','DAY 2 营地 → 保护区'] };
  assert.equal(transportUsageLabel(item), '园区与保护区游猎用车');
  const customer = selectCustomerRenderData({ title:'测试', days:[{}], transportSummary:[item] });
  assert.equal('usageSegments' in customer.transportSummary[0], false);
});

test('transport presentation separates product name from configuration role without duplicate labels', () => {
  const city = { category: '商务用车', serviceLevel: '商务用车', usageLabel: '内罗毕接机 · 城市游览 · 送机' };
  assert.equal(transportUsageLabel(city), '内罗毕接机 · 城市游览 · 送机');
  assert.equal(transportProductName(city), '城市与机场商务用车');
  assert.deepEqual(transportConfigurationLabels(city), ['市区商务车']);

  const safari = { category: '四驱开顶式越野车', serviceLevel: '四驱敞篷越野车', seatCount: 7 };
  assert.equal(transportProductName(safari), '四驱开顶式越野车');
  assert.deepEqual(transportConfigurationLabels(safari), ['园区与保护区游猎车辆', '7座']);

  const flight = { category: '草原飞机', serviceLevel: '草原飞机' };
  assert.deepEqual(transportConfigurationLabels(flight), ['境内轻型航空衔接']);
});
