import test from 'node:test';
import assert from 'node:assert/strict';
import { cropImageStyle, fitCropToRatio, initialCrop, normalizedCrop } from '../src/lib/imageCrop.js';
import { getSlotImage, setSlotImage } from '../src/lib/imageSlots.js';

test('legacy focus becomes a fixed-aspect crop without changing the source', () => {
  const crop = initialCrop(2000, 1000, 1, '75% 50%');
  assert.deepEqual(crop, { x: .375, y: 0, width: .5, height: 1 });
});

test('crop stays within image and adapts to a changed card ratio', () => {
  const crop = fitCropToRatio({ x: .7, y: .6, width: .25, height: .25 }, 2000, 1000, 2);
  assert.ok(crop.x >= 0 && crop.y >= 0);
  assert.ok(crop.x + crop.width <= 1 && crop.y + crop.height <= 1);
  assert.equal(crop.width, crop.height);
  assert.equal(normalizedCrop({ x: 0, y: 0, width: 0, height: 1 }), null);
});

test('render geometry fills viewport from selected source rectangle', () => {
  const style = cropImageStyle({ x: .25, y: .25, width: .5, height: .5 }, 2000, 1000, 1000, 500);
  assert.equal(style.width, '2000px');
  assert.equal(style.height, '1000px');
  assert.equal(style.left, '-500px');
  assert.equal(style.top, '-250px');
});

test('crop persists on both cover and daily experience slots', () => {
  const data = { heroImage: '/cover.jpg', heroFocus: '50% 50%', days: [{ spots: [{ id: 'spot-1', images: [{ src: '/day.jpg' }] }] }] };
  const crop = { x: .1, y: .2, width: .6, height: .6 };
  const cover = { module: 'cover' };
  const day = { module: 'day', itemIndex: 0, dayIndex: 0, spotIndex: 0, spotId: 'spot-1', imageIndex: 0 };
  setSlotImage(data, cover, { src: '/cover.jpg', focus: '50% 50%', crop });
  setSlotImage(data, day, { src: '/day.jpg', focus: '50% 50%', crop });
  assert.deepEqual(getSlotImage(data, cover).crop, crop);
  assert.deepEqual(getSlotImage(data, day).crop, crop);
});
