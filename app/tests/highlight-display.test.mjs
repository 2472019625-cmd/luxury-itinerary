import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';
import { normalizeHighlightForDisplay, normalizeHighlightsForDisplay } from '../src/lib/highlightDisplay.js';

test('normalizes legacy highlight strings without changing their count or wording', () => {
  const source = [
    '标题：中文冒号说明',
    '标题:英文冒号说明',
    '标题｜全角竖线说明',
    '标题|半角竖线说明',
    '没有分隔符的原文',
  ];

  assert.deepEqual(normalizeHighlightsForDisplay(source), [
    { title: '标题', description: '中文冒号说明' },
    { title: '标题', description: '英文冒号说明' },
    { title: '标题', description: '全角竖线说明' },
    { title: '标题', description: '半角竖线说明' },
    { title: '没有分隔符的原文', description: '' },
  ]);
  assert.equal(normalizeHighlightsForDisplay(source).length, source.length);
});

test('keeps already structured highlights in the single display shape', () => {
  assert.deepEqual(normalizeHighlightForDisplay({ title: '标题', description: '说明' }), { title: '标题', description: '说明' });
});

test('customer render data exposes only structured product highlights', () => {
  const customer = selectCustomerRenderData({
    title: '测试行程',
    days: [{}],
    highlights: ['Singita 顶奢营地连住｜全程入住 Singita 旗下营地。'],
  });

  assert.deepEqual(customer.highlights, [
    { title: 'Singita 顶奢营地连住', description: '全程入住 Singita 旗下营地。' },
  ]);
});
