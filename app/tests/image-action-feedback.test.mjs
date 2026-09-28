import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateResolutionAllowsManualChoice, candidateResolutionForTarget, imageActionFailureMessage } from '../src/lib/imageActionFeedback.js';

test('size failure asks for a clearer original while transient failure remains retryable', () => {
  for (const kind of ['select', 'upload']) {
    const message = imageActionFailureMessage(kind, Object.assign(new Error('实际 850×550，当前位置至少需要 1181×665'), { code: 'image_resolution_insufficient' }));
    assert.match(message, /850×550.*1181×665/);
    assert.doesNotMatch(message, /重试/);
  }
  assert.match(imageActionFailureMessage('select', Object.assign(new Error('连接暂时中断'), { code: 'network_error' })), /请重试/);
});

test('candidate list prechecks known originals and leaves previews pending', () => {
  const paired = { minWidth: 575, minHeight: 384 };
  const single = { minWidth: 1181, minHeight: 665 };
  const original = { localUrl: '/image-assets/test/original.jpg', width: 850, height: 550, originalDownloaded: true };
  assert.equal(candidateResolutionForTarget(original, paired).status, 'sufficient');
  assert.equal(candidateResolutionForTarget(original, single).status, 'insufficient');
  assert.equal(candidateResolutionAllowsManualChoice(original, single), false);
  assert.equal(candidateResolutionForTarget({ localPreviewUrl: '/image-assets/test/preview.jpg', width: 850, height: 550, originalDownloaded: false }, paired).status, 'pending');
  assert.equal(candidateResolutionAllowsManualChoice({ localPreviewUrl: '/image-assets/test/preview.jpg', width: 850, height: 550, originalDownloaded: false }, paired), true);
  assert.equal(candidateResolutionForTarget({ originalWidth: 850, originalHeight: 550, originalDownloaded: false }, paired).status, 'sufficient');
});
