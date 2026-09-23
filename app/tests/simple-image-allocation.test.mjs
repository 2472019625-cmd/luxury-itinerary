import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { allocateCompatibleImageCandidates, imageTargetFingerprint } from '../server/simple-image-allocation.mjs';
import { IMAGE_AUDIT_EVIDENCE_VERSION } from '../server/image-candidate-eligibility.mjs';

const slot = (id, patch = {}) => ({ slotId: id, moduleType: 'hotel', hotel: 'Example Hotel', location: 'Nairobi', locationRole: 'scope_only', queryCore: { subject: '酒店公共空间', action: '', identity: 'Example Hotel' }, exactIdentityRequired: true, required: true, ...patch });
const approved = (id, localUrl) => ({ candidateId: id, localUrl, sha256: id, originalDownloaded: true, qualificationStatus: 'eligible', hardJudgment: { eligible: true, technicalUsable: true, auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION, auditContract: { complete: true } }, width: 1600, height: 900, semanticScore: 90 });

test('same-core unoccupied original fills a required slot without crossing hotel identity or user lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-allocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetDir = path.join(root, 'output', 'image-assets');
  await mkdir(assetDir, { recursive: true });
  const image = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#806640' } }).jpeg().toBuffer();
  await writeFile(path.join(assetDir, 'available.jpg'), image);
  const a = slot('hotel-a');
  const b = slot('hotel-b');
  const other = slot('hotel-other', { hotel: 'Different Hotel', queryCore: { subject: '酒店公共空间', action: '', identity: 'Different Hotel' } });
  const locked = slot('hotel-locked', { userLocked: true });
  const used = approved('used', '/image-assets/used.jpg');
  const spare = approved('spare', '/image-assets/available.jpg');
  const execution = { results: [
    { slotId: a.slotId, status: 'success', selected: { ...used, selected: true }, candidates: [{ ...used, selected: true }, spare] },
    { slotId: b.slotId, status: 'not_found', candidates: [] },
    { slotId: other.slotId, status: 'not_found', candidates: [] },
    { slotId: locked.slotId, status: 'not_found', candidates: [] },
  ], metrics: {} };
  const allocated = allocateCompatibleImageCandidates({ slots: [a, b, other, locked], execution, root });
  assert.equal(allocated.results[1].status, 'success');
  assert.equal(allocated.results[1].selected.localUrl, spare.localUrl);
  assert.equal(allocated.results[1].selected.reusedFromSlotId, a.slotId);
  assert.equal(allocated.results[2].status, 'not_found');
  assert.equal(allocated.results[3].status, 'not_found');
  assert.equal(allocated.metrics.compatibleCandidateAllocations, 1);
  assert.equal(execution.results[1].status, 'not_found', 'source execution remains immutable');
});

test('ambiguous or unsupported target has no fingerprint and a preview-only asset is never auto adopted', () => {
  assert.equal(imageTargetFingerprint(slot('bad', { queryCore: { subject: '' } })), '');
  assert.equal(imageTargetFingerprint(slot('bad', { plannerSlotStatus: 'unresolved' })), '');
});

test('the fingerprint separates the same core when visual duty, context, or rendered size differs', () => {
  const base = slot('base', { subject: '酒店泳池', visualGoal: '展示室外泳池', visualDuty: '酒店公共空间', visualContext: { avoid: ['室内泳池'], landscape: '山景' }, aspectRatio: '16:9', displayLayout: 'standard' });
  const identity = imageTargetFingerprint(base);
  assert.equal(imageTargetFingerprint(slot('another-id', { ...base, slotId: 'another-id' })), identity);
  assert.notEqual(imageTargetFingerprint({ ...base, visualGoal: '展示客房内部' }), identity);
  assert.notEqual(imageTargetFingerprint({ ...base, visualContext: { ...base.visualContext, avoid: ['室内泳池', '人物'] } }), identity);
  assert.notEqual(imageTargetFingerprint({ ...base, displayLayout: 'wide' }), identity);
  assert.notEqual(imageTargetFingerprint({ ...base, aspectRatio: '4:3' }), identity);
  assert.notEqual(imageTargetFingerprint({ ...base, activity: '泳池日落酒会' }), identity);
});

test('a source-approved image is not auto-filled into a different visual duty or wider card', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-allocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetDir = path.join(root, 'output', 'image-assets');
  await mkdir(assetDir, { recursive: true });
  await writeFile(path.join(assetDir, 'available.jpg'), await sharp({ create: { width: 800, height: 600, channels: 3, background: '#806640' } }).jpeg().toBuffer());
  const source = slot('source', { visualGoal: '酒店公共空间', displayLayout: 'standard' });
  const differentDuty = slot('different-duty', { visualGoal: '酒店客房内部', displayLayout: 'standard' });
  const wideCard = slot('wide-card', { visualGoal: '酒店公共空间', displayLayout: 'wide' });
  const candidate = { ...approved('available', '/image-assets/available.jpg'), width: 800, height: 600 };
  const execution = { results: [
    { slotId: source.slotId, status: 'not_found', candidates: [candidate] },
    { slotId: differentDuty.slotId, status: 'not_found', candidates: [] },
    { slotId: wideCard.slotId, status: 'not_found', candidates: [] },
  ] };
  const allocated = allocateCompatibleImageCandidates({ slots: [source, differentDuty, wideCard], execution, root });
  assert.equal(allocated.results[1].status, 'not_found');
  assert.equal(allocated.results[2].status, 'not_found');
  assert.equal(allocated.metrics.compatibleCandidateAllocations, 0);
});

test('old evidence contract cannot authorize cross-slot automatic allocation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-allocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetDir = path.join(root, 'output', 'image-assets');
  await mkdir(assetDir, { recursive: true });
  await writeFile(path.join(assetDir, 'available.jpg'), await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#806640' } }).jpeg().toBuffer());
  const a = slot('hotel-a');
  const b = slot('hotel-b');
  const legacy = approved('legacy', '/image-assets/available.jpg');
  delete legacy.hardJudgment.auditEvidenceVersion;
  const execution = { results: [
    { slotId: a.slotId, status: 'success', selected: approved('used', '/image-assets/used.jpg'), candidates: [legacy] },
    { slotId: b.slotId, status: 'not_found', candidates: [] },
  ] };
  const allocated = allocateCompatibleImageCandidates({ slots: [a, b], execution, root });
  assert.equal(allocated.results[1].status, 'not_found');
  assert.equal(allocated.metrics.compatibleCandidateAllocations, 0);
});

test('an existing locked asset or a duplicate-rejected candidate is not reassigned', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-allocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetDir = path.join(root, 'output', 'image-assets');
  await mkdir(assetDir, { recursive: true });
  const image = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#806640' } }).jpeg().toBuffer();
  await writeFile(path.join(assetDir, 'locked.jpg'), image);
  await writeFile(path.join(assetDir, 'duplicate.jpg'), image);
  const source = slot('source');
  const target = slot('target');
  const execution = { results: [
    { slotId: source.slotId, status: 'not_found', candidates: [approved('locked', '/image-assets/locked.jpg'), { ...approved('duplicate', '/image-assets/duplicate.jpg'), rejection: 'duplicate_candidate_content' }] },
    { slotId: target.slotId, status: 'not_found', candidates: [] },
  ] };
  const allocated = allocateCompatibleImageCandidates({ slots: [source, target], execution, root,
    preparedData: { hotels: [{ images: [{ src: '/image-assets/locked.jpg' }] }] } });
  assert.equal(allocated.results[1].status, 'not_found');
  assert.equal(allocated.metrics.compatibleCandidateAllocations, 0);
});
