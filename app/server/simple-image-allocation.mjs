import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { candidateQualification, IMAGE_AUDIT_EVIDENCE_VERSION } from './image-candidate-eligibility.mjs';
import { imageResolutionPolicyForSlot, withDayGalleryLayout } from './image-download.mjs';
import { differenceHash, ImageDeduper } from './image-dedupe.mjs';
import { getSlotImage } from '../src/lib/imageSlots.js';
import { IMAGE_MEDIA_POLICY_VERSION } from '../src/lib/imageMedia.js';

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : typeof value === 'string' ? clean(value) : value;

export function imageTargetFingerprint(slot = {}) {
  const core = slot.queryCore || {};
  const subject = clean(core.subject || core.subjectEn);
  if (!subject || slot.plannerSlotStatus === 'unresolved' || slot.needsUserAction === true) return '';
  return JSON.stringify({
    auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION,
    mediaPolicyVersion: IMAGE_MEDIA_POLICY_VERSION,
    module: clean(slot.moduleType),
    subject,
    ...(slot.animalSubjectOptions ? { animalSubjectOptions: stable(slot.animalSubjectOptions) } : {}),
    ...(slot.animalActionOptions ? { animalActionOptions: stable(slot.animalActionOptions) } : {}),
    action: clean(core.action || core.actionEn),
    identity: clean(core.identity || core.identityEn),
    hotel: clean(slot.hotel),
    location: clean(slot.location),
    locationRole: clean(slot.locationRole || 'scope_only'),
    exactIdentityRequired: slot.exactIdentityRequired === true,
    knowledgeImagePurpose: clean(slot.knowledgeImagePurpose),
    primaryVisualSubject: clean(slot.primaryVisualSubject),
    subjectName: clean(slot.subject),
    activity: clean(slot.activity),
    visualGoal: clean(slot.visualGoal),
    visualDuty: clean(slot.visualDuty),
    visualContext: stable(slot.visualContext || {}),
    aspectRatio: clean(slot.aspectRatio),
    displayLayout: clean(slot.displayLayout),
    resolutionPolicy: imageResolutionPolicyForSlot(slot),
  });
}

function localOriginalUsable(root, candidate = {}, slot = {}) {
  if (!candidate.originalDownloaded || !candidate.localUrl?.startsWith('/image-assets/') || candidate.hardJudgment?.technicalUsable !== true) return false;
  const { minWidth, minHeight } = imageResolutionPolicyForSlot(slot);
  if (Number(candidate.width || 0) < minWidth || Number(candidate.height || 0) < minHeight) return false;
  return Boolean(localAssetFile(root, candidate.localUrl));
}

function localAssetFile(root, localUrl) {
  if (!localUrl?.startsWith('/image-assets/')) return null;
  try {
    const base = realpathSync(path.join(root, 'output', 'image-assets'));
    const relativeUrl = decodeURIComponent(localUrl.slice('/image-assets/'.length));
    const file = realpathSync(path.resolve(base, relativeUrl));
    const relative = path.relative(base, file);
    const fileStat = statSync(file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && fileStat.isFile() && fileStat.size > 0 && fileStat.size <= 14 * 1024 * 1024 ? file : null;
  } catch { return null; }
}

function assetKey(candidate) {
  return candidate.sha256 || candidate.localUrl || '';
}

function occupiedImageUrls(data = {}) {
  const src = (item) => typeof item === 'string' ? item : item?.src;
  return new Set([
    src(data.heroImage),
    ...(data.hotels || []).flatMap((item) => (item.images || []).map(src)),
    ...(data.diningExperiences || []).flatMap((item) => (item.images || []).map(src)),
    ...(data.transportSummary || []).flatMap((item) => (item.images || []).map(src)),
    ...(data.days || []).flatMap((day) => (day.spots || []).flatMap((spot) => (spot.images || []).map(src))),
  ].filter(Boolean));
}

// Same-target eligible originals may be shared as evidence within this batch.
// A selected asset remains exclusive; a different available asset is required
// before another slot can be filled.
export function allocateCompatibleImageCandidates({ slots = [], execution = {}, root, preparedData = {} } = {}) {
  if (!root || !existsSync(path.join(root, 'output', 'image-assets'))) return execution;
  // A DAY original is judged against its source frame, then against the
  // destination frame. Both frames come from the same visible batch layout.
  const layoutSlots = slots.map((slot) => withDayGalleryLayout(slot, slots));
  const results = (execution.results || []).map((result) => ({ ...result, candidates: [...(result.candidates || [])] }));
  const resultById = new Map(results.map((result) => [result.slotId, result]));
  const slotById = new Map(layoutSlots.map((slot) => [slot.slotId, slot]));
  const selectedKeys = new Set(results.filter((result) => result.status === 'success' && result.selected).map((result) => assetKey(result.selected)).filter(Boolean));
  const occupiedUrls = occupiedImageUrls(preparedData);
  const available = new Map();
  for (const result of results) {
    const sourceSlot = slotById.get(result.slotId);
    const fingerprint = imageTargetFingerprint(sourceSlot);
    if (!fingerprint) continue;
    for (const candidate of result.candidates || []) {
      if (candidate.selected === true || !['', 'none'].includes(clean(candidate.rejection)) || candidateQualification(candidate) !== 'eligible' || candidate.hardJudgment?.eligible !== true || candidate.hardJudgment?.auditEvidenceVersion !== IMAGE_AUDIT_EVIDENCE_VERSION || candidate.hardJudgment?.auditContract?.complete !== true || occupiedUrls.has(candidate.localUrl) || !localOriginalUsable(root, candidate, sourceSlot)) continue;
      const key = assetKey(candidate);
      if (!key || selectedKeys.has(key)) continue;
      const list = available.get(fingerprint) || [];
      list.push({ candidate, sourceSlotId: result.slotId, key });
      available.set(fingerprint, list);
    }
  }
  for (const list of available.values()) list.sort((a, b) => Number(b.candidate.semanticScore || 0) - Number(a.candidate.semanticScore || 0) || Number(b.candidate.width || 0) - Number(a.candidate.width || 0) || a.key.localeCompare(b.key) || a.sourceSlotId.localeCompare(b.sourceSlotId));
  let allocations = 0;
  const targets = layoutSlots.filter((slot) => !slot.userLocked && resultById.has(slot.slotId)).sort((a, b) => Number(b.required) - Number(a.required) || a.slotId.localeCompare(b.slotId));
  for (const slot of targets) {
    const target = resultById.get(slot.slotId);
    if (target.status === 'success') continue;
    const fingerprint = imageTargetFingerprint(slot);
    const pool = available.get(fingerprint) || [];
    const match = pool.find(({ key, sourceSlotId, candidate }) => sourceSlotId !== slot.slotId && !selectedKeys.has(key) && !occupiedUrls.has(candidate.localUrl) && localOriginalUsable(root, candidate, slot));
    if (!match) continue;
    const candidateId = `candidate-reuse-${createHash('sha256').update(`${slot.slotId}|${match.key}`).digest('hex').slice(0, 20)}`;
    const selected = { ...match.candidate, candidateId, selected: true, notAutoSelected: false, manualOnly: false, autoReviewStatus: 'auto_selected', candidateStatus: 'selected', reusedFromSlotId: match.sourceSlotId, targetFingerprint: fingerprint };
    target.status = 'success';
    target.selected = selected;
    target.candidates.push(selected);
    target.actualSubject = selected.actualSubject || target.actualSubject;
    target.matchReason = '复用同一批次、相同核心目标已完整审核的未占用原图';
    target.technicalStatus = 'compatible_batch_candidate_allocated';
    target.allocation = { sourceSlotId: match.sourceSlotId, targetFingerprint: fingerprint, assetKey: match.key };
    selectedKeys.add(match.key);
    occupiedUrls.add(selected.localUrl);
    allocations += 1;
  }
  const statuses = new Set(results.map((item) => item.status));
  const status = allocations === 0 ? execution.status : statuses.size === 1 && statuses.has('success') ? 'success' : statuses.has('success') ? 'partial_success' : execution.status;
  return { ...execution, status, results, metrics: { ...(execution.metrics || {}), compatibleCandidateAllocations: allocations } };
}

// Run after formal compatible-candidate allocation and after any editor
// research merge. Formal and user-locked images own their files first.
export async function reconcileProvisionalImageSelections({ slots = [], execution = {}, root, preparedData = {}, slotBindings = {} } = {}) {
  const results = (execution.results || []).map((item) => ({ ...item }));
  const slotById = new Map(slots.map((slot) => [slot.slotId, slot]));
  const deduper = new ImageDeduper();
  const lockedUrls = new Set();
  for (const slot of slots) {
    if (!slot.userLocked && !preparedData.imageLocks?.[slot.slotId]) continue;
    const binding = slotBindings[slot.slotId] || preparedData.simpleImageSlotBindings?.[slot.slotId];
    const image = binding ? getSlotImage(preparedData, binding) : null;
    const src = typeof image === 'string' ? image : image?.src;
    if (!src) continue;
    lockedUrls.add(src);
    const file = localAssetFile(root, src);
    if (file) { try { deduper.seed([{ dHash: await differenceHash(file), publicUrl: src }]); } catch { /* Missing lock file remains an output blocker. */ } }
  }
  const formal = results.filter((item) => item.status === 'success' && item.selected);
  for (const item of formal) {
    const selected = item.selected;
    const file = localAssetFile(root, selected.localUrl);
    let dHash = selected.dHash || null;
    if (!dHash && file) { try { dHash = await differenceHash(file); } catch { /* Renderer will report an unusable formal file. */ } }
    deduper.seed([{ ...selected, dHash }]);
  }
  let retained = 0;
  let cleared = 0;
  for (const slot of [...slots].sort((a, b) => Number(b.required) - Number(a.required) || a.slotId.localeCompare(b.slotId))) {
    const result = results.find((item) => item.slotId === slot.slotId);
    const provisional = result?.provisionalSelected;
    if (!provisional) continue;
    const file = localAssetFile(root, provisional.localUrl);
    const valid = result.status !== 'success' && !result.selected && !slot.userLocked && slotById.has(result.slotId)
      && provisional.originalDownloaded === true && provisional.hardJudgment?.technicalUsable === true && file && !lockedUrls.has(provisional.localUrl);
    const duplicate = valid ? await deduper.accept({ ...provisional, filePath: file }) : { accepted: false };
    if (!duplicate.accepted) {
      result.provisionalSelected = null;
      cleared += 1;
    } else {
      result.provisionalSelected = { ...provisional, dHash: duplicate.dHash };
      retained += 1;
    }
  }
  return { ...execution, results, metrics: { ...(execution.metrics || {}), provisionalRetained: retained, provisionalClearedByPriorityOrDedupe: cleared } };
}
