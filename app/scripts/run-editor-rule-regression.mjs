import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { buildLayoutImageSlots, getSlotImage, moveImageToSlot } from '../src/lib/imageSlots.js';
import { recordImageDecision } from '../src/lib/imageDecisions.js';

const evidenceDir = path.resolve(process.argv.find((value) => value.startsWith('--evidence='))?.slice(11) || '');
const origin = process.argv.find((value) => value.startsWith('--origin='))?.slice(9) || 'http://127.0.0.1:4173';
if (!evidenceDir) throw new Error('必须提供 --evidence=');
const generation = JSON.parse(await readFile(path.join(evidenceDir, '03-generation-result.json'), 'utf8'));
let data = structuredClone(generation.result.data);
const originalLocks = structuredClone(data.imageLocks || {});
const slots = buildLayoutImageSlots(data);
const manual = (data.imageCandidates || []).find((item) => item.status === 'manual_review' && item.adoptable && item.libraryEligible && item.localPreviewUrl);
if (!manual) throw new Error('真实任务没有可供编辑器采用的 manual 候选');
const manualTarget = slots.find((slot) => slot.slotId === manual.slotId) || slots.find((slot) => !getSlotImage(data, slot));
data = moveImageToSlot(data, manualTarget.slotId, null, { src: manual.localPreviewUrl, focus: '50% 50%', candidateId: manual.candidateId, sourcePage: manual.sourcePage }, 'user_selection');
const adopted = (data.imageCandidates || []).find((item) => item.candidateId === manual.candidateId);
if (adopted) adopted.humanDecision = { action: 'adopt', decidedAt: Date.now(), targetSlotId: manualTarget.slotId, originalStatus: manual.status, originalRisk: manual.reason || '' };
recordImageDecision(data, { slotId: manualTarget.slotId, action: 'adopt', source: 'user_selection', candidateId: manual.candidateId });

const uploadBuffer = await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#b9974f' } }).jpeg({ quality: 88 }).toBuffer();
const uploadResponse = await fetch(origin + '/api/images/upload', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: uploadBuffer });
const uploaded = await uploadResponse.json();
if (!uploadResponse.ok) throw new Error(uploaded.error || '真实上传失败');
const uploadTarget = slots.find((slot) => slot.slotId !== manualTarget.slotId && !getSlotImage(data, slot));
data = moveImageToSlot(data, uploadTarget.slotId, null, { src: uploaded.src, focus: '50% 50%', userProvided: true, candidateId: uploaded.sha256 }, 'user_upload');
recordImageDecision(data, { slotId: uploadTarget.slotId, action: 'upload', source: 'user_upload', candidateId: uploaded.sha256, fileName: 'regression-authorized.jpg' });
const moveTarget = slots.find((slot) => ![manualTarget.slotId, uploadTarget.slotId].includes(slot.slotId) && !getSlotImage(data, slot));
data = moveImageToSlot(data, moveTarget.slotId, uploadTarget.slotId, { src: uploaded.src, focus: '50% 50%', userProvided: true, candidateId: uploaded.sha256 }, 'user_selection');
recordImageDecision(data, { slotId: moveTarget.slotId, sourceSlotId: uploadTarget.slotId, action: 'move', source: 'user_selection', candidateId: uploaded.sha256 });

const serialized = JSON.stringify(data);
const restored = JSON.parse(serialized);
const researchTarget = slots.find((slot) => ![manualTarget.slotId, uploadTarget.slotId, moveTarget.slotId].includes(slot.slotId) && !restored.imageLocks?.[slot.slotId]);
if (!researchTarget) throw new Error('没有可用于单槽重搜的未锁位置');
const nonTargetBefore = Object.fromEntries(buildLayoutImageSlots(restored).filter((slot) => slot.slotId !== researchTarget.slotId).map((slot) => [slot.slotId, getSlotImage(restored, slot)?.src || null]));

const createdResponse = await fetch(origin + '/api/images/research-slot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: restored, slotId: researchTarget.slotId }) });
let job = await createdResponse.json();
if (!createdResponse.ok) throw new Error(job.error || '单槽重搜任务创建失败');
const snapshots = [];
const deadline = Date.now() + 15 * 60 * 1000;
while (!['complete','failed'].includes(job.status)) {
  if (Date.now() > deadline) throw new Error('单槽重搜超时');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const response = await fetch(`${origin}/api/jobs/${job.id}`);
  job = await response.json();
  snapshots.push({ at: new Date().toISOString(), status: job.status, phase: job.phase, progress: job.progress, currentAction: job.currentAction, stats: job.stats });
}
if (job.status !== 'complete') throw new Error(job.error || '单槽重搜失败');
const nonTargetAfter = Object.fromEntries(buildLayoutImageSlots(job.data).filter((slot) => slot.slotId !== researchTarget.slotId).map((slot) => [slot.slotId, getSlotImage(job.data, slot)?.src || null]));
const checks = {
  manualAdoptedAndLocked: Boolean(restored.imageLocks?.[manualTarget.slotId] && adopted?.humanDecision),
  uploadPersisted: getSlotImage(restored, moveTarget)?.src === uploaded.src,
  movedSourceCleared: !getSlotImage(restored, uploadTarget),
  bothMoveEndsLocked: Boolean(restored.imageLocks?.[moveTarget.slotId] && restored.imageLocks?.[uploadTarget.slotId]),
  decisionsPersistAfterSerialization: restored.imageDecisions?.length >= 3,
  priorLocksPreserved: Object.keys(originalLocks).every((slotId) => restored.imageLocks?.[slotId]),
  singleSlotResearchPreservedOtherPlacements: JSON.stringify(nonTargetBefore) === JSON.stringify(nonTargetAfter),
  singleSlotResearchPreservedUserLocks: Object.keys(restored.imageLocks || {}).every((slotId) => job.data.imageLocks?.[slotId]),
  targetLedgerHasUniqueRecordIds: new Set((job.data.imageCandidates || []).filter((item) => item.slotId === researchTarget.slotId).map((item) => item.candidateId)).size === (job.data.imageCandidates || []).filter((item) => item.slotId === researchTarget.slotId).length,
};
const result = { checkedAt: new Date().toISOString(), rules: ['IMG-013','IMG-014','IMG-015','IMG-019','OPS-011'], manualTarget: manualTarget.slotId, manualCandidateId: manual.candidateId, uploadTarget: uploadTarget.slotId, moveTarget: moveTarget.slotId, upload: uploaded, decisions: restored.imageDecisions, researchTarget: researchTarget.slotId, researchJobId: job.id, snapshots, checks, passed: Object.values(checks).every(Boolean) };
await writeFile(path.join(evidenceDir, '10-editor-and-single-slot-regression.json'), JSON.stringify(result, null, 2), 'utf8');
if (!result.passed) throw new Error('编辑器/单槽回归未通过：' + Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join('、'));
console.log(JSON.stringify({ evidenceDir, ...result }, null, 2));
