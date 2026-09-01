import assert from 'node:assert/strict';
import test from 'node:test';
import { transportUsageLabel } from '../src/lib/transportPresentation.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';

test('customer transport cards use a compact scene label instead of full DAY route mapping', () => {
  const item = { category:'四驱开顶式越野车', usageSegments:['DAY 1 机场 → 营地','DAY 2 营地 → 保护区'] };
  assert.equal(transportUsageLabel(item), '园区与保护区游猎用车');
  const customer = selectCustomerRenderData({ title:'测试', days:[{}], transportSummary:[item] });
  assert.equal('usageSegments' in customer.transportSummary[0], false);
});
