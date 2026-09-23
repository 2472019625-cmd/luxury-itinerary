import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';
import { hotelFactPresentation, STRUCTURED_HOTEL_FACT_FORMAT } from '../src/lib/hotelFactPresentation.js';

test('customer hotel rows contain display facts but no research status or failure reason', () => {
  const data = { hotels: [{ id: 'hotel-a', officialName: 'Example Hotel', factRows: [
    { key: 'location', label: '位置', text: '位于城市中心', status: 'success', reason: 'verified', sourceUrl: 'https://example.org/hotel' },
    { key: 'design', label: '设计', text: '', status: 'not_found', reason: 'model_omitted' },
  ] }] };
  const rows = selectCustomerRenderData(data).hotels[0].factRows;
  assert.deepEqual(rows, [{ key: 'location', label: '位置', text: '位于城市中心' }]);
  assert.doesNotMatch(JSON.stringify(rows), /verified|model_omitted|example\.org|status/);
});

test('legacy empty rows keep hotel copy while current failed research stays empty', () => {
  const data = { hotels: [
    { id: 'legacy', factRows: [], editorialCopy: '旧项目酒店介绍', proofPoints: ['旧项目卖点'] },
    { id: 'current', hotelFactFormat: STRUCTURED_HOTEL_FACT_FORMAT, factRows: [], editorialCopy: '未经核验的旧式介绍', proofPoints: ['未经核验的卖点'] },
    { id: 'current-failed', hotelFactFormat: STRUCTURED_HOTEL_FACT_FORMAT, factRows: [
      { key: 'location', label: '位置', text: '', status: 'source_unavailable', reason: 'research_failed' },
    ], editorialCopy: '不应回退的介绍' },
  ] };
  const hotels = selectCustomerRenderData(data).hotels;
  assert.equal(hotelFactPresentation(hotels[0]).showLegacy, true);
  assert.equal(hotelFactPresentation(hotels[1]).showLegacy, false);
  assert.equal(hotelFactPresentation(hotels[2]).showLegacy, false);
  assert.deepEqual(hotelFactPresentation(hotels[1]).rows, []);
  assert.deepEqual(hotelFactPresentation(hotels[2]).rows, []);
  assert.equal(hotels[0].editorialCopy, '旧项目酒店介绍');
});
