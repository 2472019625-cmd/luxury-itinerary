import test from 'node:test';
import assert from 'node:assert/strict';
import { hotelFactPresentation, STRUCTURED_HOTEL_FACT_FORMAT } from '../src/lib/hotelFactPresentation.js';

test('new structured hotels stay structured with zero, one, or four verified rows', () => {
  const rows = [
    { key: 'location', label: '位置', text: '位置事实' },
    { key: 'rooms', label: '客房', text: '' },
    { key: 'design', label: '设计', text: '设计事实' },
    { key: 'facilities', label: '设施', text: '  ' },
  ];
  const hotel = { factRows: rows, editorialCopy: '旧模板文字', proofPoints: ['旧卖点'] };
  assert.deepEqual(hotelFactPresentation({ ...hotel, factRows: [] }), { structured: false, rows: [], showLegacy: true });
  assert.deepEqual(hotelFactPresentation({ ...hotel, factRows: [], hotelFactFormat: STRUCTURED_HOTEL_FACT_FORMAT }), { structured: true, rows: [], showLegacy: false });
  assert.deepEqual(hotelFactPresentation(hotel).rows.map((row) => row.key), ['location', 'design']);
  assert.equal(hotelFactPresentation(hotel).showLegacy, false);
  assert.equal(hotelFactPresentation({ editorialCopy: '历史项目段落' }).showLegacy, true);
  assert.equal(hotelFactPresentation({ factRows: [], proofPoints: ['历史卖点'] }).showLegacy, true);
  assert.equal(hotelFactPresentation({ factRows: [{ key: 'unknown', text: '旧版数据' }], editorialCopy: '历史项目段落' }).showLegacy, true);
});
