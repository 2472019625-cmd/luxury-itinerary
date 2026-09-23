import test from 'node:test';
import assert from 'node:assert/strict';
import { canManuallyChooseImageCandidate, canRecommendImageCandidateForSlot } from '../src/lib/imageReviewPolicy.js';

const target = { slotId: 'image:day:1:primary', pipelineSlotId: 'image:day:1:primary', fieldPath: 'days.0.spots.0.images.0' };
const candidate = (id, values = {}) => ({ candidateId: id, localPreviewUrl: `/image-assets/${id}.jpg`, pipelineSlotId: target.pipelineSlotId, fieldPath: target.fieldPath, ...values });

test('当前位置推荐保留可用及需要人工确认候选，排除三种既有硬拒绝标记', () => {
  const candidates = [
    candidate('eligible', { qualificationStatus: 'eligible', status: 'eligible_not_selected' }),
    candidate('manual', { qualificationStatus: 'unreviewed', status: 'manual_review', manualSelectable: false, libraryEligible: false }),
    candidate('hard-status', { status: 'hard_rejected' }),
    candidate('auto-rejected', { autoRejected: true }),
    candidate('rejected-qualification', { qualificationStatus: 'rejected' }),
  ];
  const original = structuredClone(candidates);
  assert.deepEqual(candidates.filter(item => canRecommendImageCandidateForSlot(item, target)).map(item => item.candidateId), ['eligible', 'manual']);
  assert.deepEqual(candidates, original, '推荐筛选不得改变原候选资格或全部图片集合');
  assert.deepEqual(candidates.map(canManuallyChooseImageCandidate), [true, true, false, false, false], '全部图片仍沿用已有可选与灰化规则');
});

test('旧候选不能凭另一个图片位的 subjectMatch 进入当前位置推荐', () => {
  const candidates = [
    candidate('same-legacy-slot', { pipelineSlotId: undefined, fieldPath: undefined, slotId: target.slotId, terminalAudit: { subjectMatch: true } }),
    candidate('other-legacy-slot', { pipelineSlotId: undefined, fieldPath: undefined, slotId: 'image:day:2:primary', terminalAudit: { subjectMatch: true } }),
    candidate('unbound', { pipelineSlotId: undefined, fieldPath: undefined, terminalAudit: { subjectMatch: true } }),
  ];
  assert.deepEqual(candidates.filter(item => canRecommendImageCandidateForSlot(item, target)).map(item => item.candidateId), ['same-legacy-slot']);
  assert.ok(candidates.every(canManuallyChooseImageCandidate), '其他图片位的可用图仍可从全部行程图片人工选择');
});

test('推荐按当前字段绑定匹配，缺字段时使用明确的图片位身份', () => {
  assert.equal(canRecommendImageCandidateForSlot(candidate('field', { slotId: 'legacy-layout-slot' }), target), true);
  assert.equal(canRecommendImageCandidateForSlot(candidate('other-field', { slotId: target.slotId, fieldPath: 'days.1.spots.0.images.0' }), target), false);
  assert.equal(canRecommendImageCandidateForSlot(candidate('pipeline-slot', { fieldPath: undefined, slotId: 'legacy-layout-slot' }), target), true);
  assert.equal(canRecommendImageCandidateForSlot(candidate('other-slot', { fieldPath: undefined, pipelineSlotId: 'image:day:2:primary' }), target), false);
  assert.equal(canRecommendImageCandidateForSlot(candidate('no-preview', { localPreviewUrl: '' }), target), false);
  assert.equal(canRecommendImageCandidateForSlot(candidate('no-target'), {}), false);
  assert.equal(canRecommendImageCandidateForSlot({ localPreviewUrl: '/image-assets/unbound.jpg' }, {}), false);
});

test('跨位只在相同完整目标指纹时推荐，身份不同或硬拒绝不会进入', () => {
  const targetWithCore = { ...target, targetFingerprint: 'hotel|same-identity|same-core' };
  assert.equal(canRecommendImageCandidateForSlot(candidate('same-core', { pipelineSlotId: 'image:hotel:other', fieldPath: 'hotels.1.images.0', targetFingerprint: targetWithCore.targetFingerprint }), targetWithCore), true);
  assert.equal(canRecommendImageCandidateForSlot(candidate('other-hotel', { pipelineSlotId: 'image:hotel:other', fieldPath: 'hotels.1.images.0', targetFingerprint: 'hotel|other-identity|same-core' }), targetWithCore), false);
  assert.equal(canRecommendImageCandidateForSlot(candidate('rejected', { pipelineSlotId: 'image:hotel:other', fieldPath: 'hotels.1.images.0', targetFingerprint: targetWithCore.targetFingerprint, qualificationStatus: 'rejected' }), targetWithCore), false);
});
