import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';
import { highlightToText, normalizeHighlightForDisplay, normalizeHighlightsForDisplay } from '../src/lib/highlightDisplay.js';

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

test('recovers legacy service labels without splitting dashes inside descriptions', () => {
  assert.deepEqual(normalizeHighlightForDisplay('一家一团——同一行程只围绕本组同行者安排。'), { title: '一家一团', description: '同一行程只围绕本组同行者安排。' });
  assert.deepEqual(normalizeHighlightForDisplay('1V1专属定制——从路线到在地体验，持续跟进。'), { title: '1V1专属定制', description: '从路线到在地体验，持续跟进。' });
  assert.deepEqual(normalizeHighlightForDisplay('私享节奏——服务重点：按实际需求持续沟通。'), { title: '私享节奏', description: '服务重点：按实际需求持续沟通。' });
  assert.deepEqual(normalizeHighlightForDisplay('从容安排：保留停留时间——按现场情况调整。'), { title: '从容安排', description: '保留停留时间——按现场情况调整。' });
  const paragraph = '按行程安排游猎与休息，途中保留充足时间——按现场情况调整。';
  assert.deepEqual(normalizeHighlightForDisplay(paragraph), { title: paragraph, description: '' });
  const structured = { title: '一家一团', description: '每天的节奏——由同行者共同商量。' };
  assert.deepEqual(normalizeHighlightForDisplay(structured), structured);
  assert.equal(highlightToText(structured), '一家一团：每天的节奏——由同行者共同商量。');
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
