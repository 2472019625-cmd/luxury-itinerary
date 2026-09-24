import test from 'node:test';
import assert from 'node:assert/strict';
import { dayVisualCards } from '../src/lib/dayVisualCards.js';
import { buildLayoutImageSlots } from '../src/lib/imageSlots.js';
import { createManualDayCard, deleteDaySpotPreservingSlots, reorderDaySpots, resolveDayPreviewSpotIndex, resolveDaySpotIndex } from '../src/lib/dayEditorState.js';

function fixture() {
  return {
    days: [{
      spots: [
        { id: 'spot-sundowner', name: 'Sundowner 落日酒会', description: '落日时分享酒饮', status: 'included', images: [{ src: '/sunset.jpg' }] },
        { id: 'spot-safari', name: '全天游猎', description: '全天追踪动物', status: 'included', images: [{ src: '/safari.jpg' }] },
      ],
    }],
    simpleImageSlotBindings: {
      'slot-sundowner': { module: 'day', dayIndex: 0, itemIndex: 0, spotId: 'spot-sundowner', spotIndex: 0, imageIndex: 0, fieldPath: 'days.0.spots.0.images.0', useSpotCopy: true, required: true, cardTitle: '旧的生成标题', cardDescription: '旧的生成介绍' },
      'slot-visual': { module: 'day', dayIndex: 0, itemIndex: 0, spotIndex: 1, imageIndex: 0, fieldPath: 'days.0.spots.1.images.0', useSpotCopy: false, required: false, cardTitle: '草原光影', cardDescription: '独立视觉说明' },
    },
  };
}

test('spotId is authoritative and a failed identity lookup never falls back to spot zero', () => {
  const data = fixture();
  assert.equal(resolveDaySpotIndex(data.days[0], { spotId: 'spot-safari', subItemIndex: 0 }), 1);
  assert.equal(resolveDaySpotIndex(data.days[0], { spotId: 'missing' }), -1);
  assert.equal(resolveDaySpotIndex(data.days[0], { subItemIndex: 0 }), 0);
  assert.equal(resolveDayPreviewSpotIndex(data.days[0], { slotId: 'day-visual-only', spotIndex: 0 }), -1);
  assert.equal(resolveDayPreviewSpotIndex(data.days[0], { spotId: 'spot-safari', slotId: 'day-real', spotIndex: 0 }), 1);
});

test('reordering experiences keeps semantic spot and visual-only storage bindings stable', () => {
  const data = fixture();
  assert.equal(reorderDaySpots(data, 0, 'spot-sundowner', 'spot-safari'), true);
  assert.deepEqual(data.days[0].spots.map((spot) => spot.id), ['spot-safari', 'spot-sundowner']);
  assert.equal(data.simpleImageSlotBindings['slot-sundowner'].spotId, 'spot-sundowner');
  assert.equal(data.simpleImageSlotBindings['slot-sundowner'].spotIndex, 1);
  assert.equal(data.simpleImageSlotBindings['slot-sundowner'].fieldPath, 'days.0.spots.1.images.0');
  assert.equal(data.simpleImageSlotBindings['slot-visual'].spotIndex, 0);
  assert.equal(data.days[0].spots[1].images[0].src, '/sunset.jpg');
});

test('deleting a real experience preserves Planner slots without rebinding them to the next experience', () => {
  const data = fixture();
  const removed = deleteDaySpotPreservingSlots(data, 0, 'spot-sundowner');
  assert.equal(removed.id, 'spot-sundowner');
  assert.deepEqual(data.days[0].spots.map((spot) => spot.id), ['spot-safari']);
  const preserved = data.simpleImageSlotBindings['slot-sundowner'];
  assert.equal(preserved.useSpotCopy, false);
  assert.equal(preserved.spotId, undefined);
  assert.equal(preserved.cardTitle, '旧的生成标题');
  assert.equal(data.days[0].spots[0].images[preserved.imageIndex].src, '/sunset.jpg');
  assert.ok(data.simpleImageSlotBindings['slot-visual']);
});

test('matched Spot keeps factual name while card and editor use the same display title', () => {
  const data = fixture();
  data.days[0].spots[0].name = '定制师修改后的落日酒会';
  data.days[0].spots[0].description = '定制师修改后的介绍';
  data.days[0].spots.push({ id: 'spot-new', name: '新体验', description: '刚刚新增', userProvided: true, images: [] });
  const customerCards = dayVisualCards(data.days[0], 0, data.simpleImageSlotBindings);
  assert.equal(data.days[0].spots[0].name, '定制师修改后的落日酒会');
  assert.equal(customerCards.find((card) => card.spotId === 'spot-sundowner').spot.name, '旧的生成标题');
  assert.equal(buildLayoutImageSlots(data).find((slot) => slot.slotId === 'slot-sundowner').label, '旧的生成标题');
  assert.equal(customerCards.find((card) => card.spotId === 'spot-sundowner').spot.description, '定制师修改后的介绍');
  assert.equal(customerCards.some((card) => card.spotId === 'spot-new'), false);
  assert.equal(customerCards.some((card) => card.spotId === 'spot-safari'), false);
  assert.equal(customerCards.find((card) => card.slotId === 'slot-visual').spot.name, '草原光影');
});

test('manual card continues to follow its edited experience name', () => {
  const data = fixture();
  const created = createManualDayCard(data, 0, { spotId: 'spot-manual', slotId: 'manual:day:1:spot-manual:primary' });
  created.spot.name = '定制师新增的体验';
  created.spot.images[0] = { src: '/manual.jpg' };
  assert.equal(dayVisualCards(data.days[0], 0, data.simpleImageSlotBindings).find((card) => card.slotId === created.slotId).spot.name, created.spot.name);
  assert.ok(buildLayoutImageSlots(data).find((slot) => slot.slotId === created.slotId).label.startsWith(created.spot.name));
});

test('manual experience card stays editor-only until it has an image and deletes without touching Planner slots', () => {
  const data = fixture();
  const created = createManualDayCard(data, 0, { spotId: 'spot-manual', slotId: 'manual:day:1:spot-manual:primary' });
  assert.equal(created.spot.id, 'spot-manual');
  assert.equal(dayVisualCards(data.days[0], 0, data.simpleImageSlotBindings).some((card) => card.slotId === created.slotId), false);
  data.days[0].spots.find((spot) => spot.id === 'spot-manual').images[0] = { src: '/manual.jpg' };
  assert.equal(dayVisualCards(data.days[0], 0, data.simpleImageSlotBindings).find((card) => card.slotId === created.slotId).spotId, 'spot-manual');
  deleteDaySpotPreservingSlots(data, 0, 'spot-manual');
  assert.equal(data.simpleImageSlotBindings[created.slotId], undefined);
  assert.ok(data.simpleImageSlotBindings['slot-sundowner']);
  assert.ok(data.simpleImageSlotBindings['slot-visual']);
});

test('preview identity opens an experience by spotId and a visual-only card by slotId', () => {
  const cards = dayVisualCards(fixture().days[0], 0, fixture().simpleImageSlotBindings);
  const experience = cards.find((card) => card.slotId === 'slot-sundowner');
  const visual = cards.find((card) => card.slotId === 'slot-visual');
  assert.equal(experience.spotId, 'spot-sundowner');
  assert.equal(resolveDayPreviewSpotIndex(fixture().days[0], experience), 0);
  assert.equal(visual.spotId, null);
  assert.equal(resolveDayPreviewSpotIndex(fixture().days[0], visual), -1);
});
