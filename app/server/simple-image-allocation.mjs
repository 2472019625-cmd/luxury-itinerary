import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { candidateQualification, IMAGE_AUDIT_EVIDENCE_VERSION } from './image-candidate-eligibility.mjs';
import { imageResolutionPolicyForSlot } from './image-download.mjs';

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
    module: clean(slot.moduleType),
    subject,
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
  try {
    const base = realpathSync(path.join(root, 'output', 'image-assets'));
    const relativeUrl = decodeURIComponent(candidate.localUrl.slice('/image-assets/'.length));
    const file = realpathSync(path.resolve(base, relativeUrl));
    const relative = path.relative(base, file);
    const fileStat = statSync(file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && fileStat.isFile() && fileStat.size > 0 && fileStat.size <= 14 * 1024 * 1024;
  } catch { return false; }
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
  const results = (execution.results || []).map((result) => ({ ...result, candidates: [...(result.candidates || [])] }));
  const resultById = new Map(results.map((result) => [result.slotId, result]));
  const slotById = new Map(slots.map((slot) => [slot.slotId, slot]));
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
  const targets = slots.filter((slot) => !slot.userLocked && resultById.has(slot.slotId)).sort((a, b) => Number(b.required) - Number(a.required) || a.slotId.localeCompare(b.slotId));
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
