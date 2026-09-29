import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { AgentPlanStore } from '../server/agent-plan-store.mjs';
import { reconcileProvisionalImageSelections } from '../server/simple-image-allocation.mjs';
import { applySimpleSkillResults } from '../server/simple-pipeline-writeback.mjs';
import { buildSimpleManualImagePayload, chooseSimpleImageCandidate, rejectSimpleImageCandidate, researchSimpleImageSlots } from '../server/simple-manual-images.mjs';
import { fixture } from './support/manual-image-fixture.mjs';

const coverId = 'image:cover:primary';
const dayId = 'image:day:1:primary';
const optionalId = 'image:day:1:supporting:1';
const runtimeDir = path.resolve(process.env.PROVISIONAL_TEST_RUNTIME_DIR || path.join(os.tmpdir(), 'codex-runtime', 'luxury-itinerary', 'provisional-selection-tests'));
const render = async ({ mode }) => ({ status: 'success', mode, outputPath: `${mode}-synthetic.png`, rendererCalls: 1 });

async function setup(t, options) {
  await mkdir(runtimeDir, { recursive: true });
  const previous = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
  process.env.TMP = runtimeDir;
  process.env.TEMP = runtimeDir;
  process.env.TMPDIR = runtimeDir;
  let value;
  try { value = await fixture(options); }
  finally {
    for (const [key, old] of Object.entries(previous)) {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  }
  assert.equal(path.dirname(value.root), runtimeDir);
  t.after(() => rm(value.root, { recursive: true, force: true }));
  return value;
}

async function original(value, id, width, height, color) {
  const name = `${id}.jpg`;
  // A distinct visual pattern matters here: flat-color images share a dHash
  // and would correctly be removed by the real cross-slot deduper.
  let state = [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 17);
  const cells = [];
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 9; x += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const shade = 35 + state % 200;
    cells.push(`<rect x="${x * 100}" y="${y * 100}" width="100" height="100" fill="rgb(${shade},${shade},${shade})"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="800"><rect width="900" height="800" fill="${color}"/>${cells.join('')}</svg>`;
  await writeFile(path.join(value.root, 'output', 'image-assets', 'test', name), await sharp(Buffer.from(svg)).resize(width, height).jpeg().toBuffer());
  return {
    candidateId: id,
    localUrl: `/image-assets/test/${name}`,
    originalDownloaded: true,
    originalDownloadStatus: 'success',
    width,
    height,
    hardJudgment: { technicalUsable: true, eligible: false, identityEvidence: 'insufficient' },
  };
}

function planFor(value) {
  return value.store.getPlan(value.projectId, value.store.getProject(value.projectId).activePlanId);
}

function row(result, slotId) {
  return result.imageExecution.results.find((item) => item.slotId === slotId);
}

function taskId(slotId) {
  return `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function reload(value) {
  const store = new AgentPlanStore(path.join(value.root, 'output', 'simple-pipeline', 'projects'));
  return { store, result: store.getFinalResult(value.projectId, value.executionRunId), payload: buildSimpleManualImagePayload(store, value.projectId) };
}

async function seed(value, { provisionalSlot, formalSlots = [], lockedSlot = null, provisional } = {}) {
  const plan = planFor(value);
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const preparedData = structuredClone(plan.preparedData);
  const slots = plan.imageSlots.map((slot) => ({ ...slot, userLocked: slot.slotId === lockedSlot }));
  for (const slotId of formalSlots) {
    const candidate = await original(value, `formal-${slotId.replaceAll(':', '-')}`, 1600, 900, slotId === coverId ? '#224466' : '#447722');
    Object.assign(row(result, slotId), { status: 'success', selected: candidate, candidates: [candidate] });
  }
  if (lockedSlot) {
    preparedData.heroImage = provisional.localUrl;
    preparedData.imageLocks = { [lockedSlot]: { source: 'user_selection', lockedAt: Date.now() } };
    Object.assign(row(result, lockedSlot), { status: 'needs_user_action', selected: null });
  }
  const pending = row(result, provisionalSlot);
  Object.assign(pending, {
    status: 'needs_user_action', selected: null, provisionalSelected: provisional,
    candidates: [provisional],
    manualAction: { ...(pending.manualAction || {}), selectableCandidates: [provisional] },
  });
  const execution = await reconcileProvisionalImageSelections({ slots, execution: result.imageExecution, root: value.root, preparedData, slotBindings: plan.slotBindings });
  const written = applySimpleSkillResults({ preparedData, imageSlots: slots, slotBindings: plan.slotBindings, imageExecution: execution });
  value.store.saveFinalResult(value.projectId, value.executionRunId, {
    ...result, imageExecution: execution, data: { ...written.data, simpleImageSlotBindings: plan.slotBindings },
    unresolvedItems: written.unresolvedItems, writeback: { copy: [], images: written.imageWriteback },
    renderStatus: 'success', render: { status: 'success', mode: 'draft' }, outputPath: 'draft-synthetic.png',
  });
  for (const item of execution.results) value.store.saveTaskResult(value.projectId, value.executionRunId, taskId(item.slotId), item);
  return reload(value);
}

test('optional provisional is visible in direct writeback and blocks final output after store reload', async (t) => {
  const value = await setup(t, { includeOptionalDay: true });
  const pending = await original(value, 'optional-pending', 850, 550, '#715324');
  const { result, payload } = await seed(value, { provisionalSlot: optionalId, formalSlots: [coverId, dayId], provisional: pending });
  assert.equal(row(result, optionalId).selected, null);
  assert.equal(row(result, optionalId).provisionalSelected.candidateId, pending.candidateId);
  assert.equal(result.data.days[0].spots[0].images[1].src, pending.localUrl);
  assert.equal(result.data.days[0].spots[0].images[1].provisional, true);
  assert.equal(result.writeback.images.find((item) => item.slotId === optionalId).status, 'provisional_written');
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === optionalId).status, 'provisional_pending_confirmation');
  assert.equal(payload.canEnterFinal, false);
  assert.ok(payload.unresolvedRequiredSlotIds.includes(optionalId), 'displayed optional prefill is a final-output blocker');
});

test('provisional requires explicit confirmation, then persists human selection and clears blocker', async (t) => {
  const value = await setup(t, { oneSlot: true });
  const pending = await original(value, 'cover-pending', 1200, 700, '#345647');
  await seed(value, { provisionalSlot: coverId, provisional: pending });
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: coverId, candidateId: pending.candidateId, render }), (error) => error.code === 'manual_confirmation_required');
  assert.equal(reload(value).result.imageExecution.results[0].provisionalSelected.candidateId, pending.candidateId);
  await chooseSimpleImageCandidate({ ...value, slotId: coverId, candidateId: pending.candidateId, manualConfirmed: true, render });
  const { result, payload } = reload(value);
  assert.equal(row(result, coverId).provisionalSelected, undefined);
  assert.equal(row(result, coverId).selected.candidateId, pending.candidateId);
  assert.equal(row(result, coverId).selected.userSelected, true);
  assert.equal(payload.imageReview.slots[0].status, 'human_selected');
  assert.equal(result.data.heroImage, pending.localUrl);
  assert.equal(payload.unresolvedRequiredCount, 0);
  assert.equal(payload.canEnterFinal, true);
});

test('reject removes optional prefill and completes, while required reject stays missing', async (t) => {
  const optionalValue = await setup(t, { includeOptionalDay: true });
  const optional = await original(optionalValue, 'optional-rejected', 850, 550, '#836427');
  await seed(optionalValue, { provisionalSlot: optionalId, formalSlots: [coverId, dayId], provisional: optional });
  await rejectSimpleImageCandidate({ ...optionalValue, slotId: optionalId, candidateId: optional.candidateId, render });
  const removed = reload(optionalValue);
  assert.equal(row(removed.result, optionalId).provisionalSelected, null);
  assert.equal(removed.result.data.days[0].spots[0].images[1], null);
  assert.equal(removed.payload.unresolvedImageCount, 0);
  assert.equal(removed.payload.canEnterFinal, true);

  const requiredValue = await setup(t, { oneSlot: true });
  const required = await original(requiredValue, 'required-rejected', 1200, 700, '#345576');
  await seed(requiredValue, { provisionalSlot: coverId, provisional: required });
  await rejectSimpleImageCandidate({ ...requiredValue, slotId: coverId, candidateId: required.candidateId, render });
  const missing = reload(requiredValue);
  assert.equal(row(missing.result, coverId).provisionalSelected, null);
  assert.equal(missing.result.data.heroImage, '');
  assert.ok(missing.payload.unresolvedRequiredSlotIds.includes(coverId));
  assert.equal(missing.payload.canEnterFinal, false);
});

test('850x550 provisional move requires explicit confirmation while preserving the larger frame quality policy', async (t) => {
  const value = await setup(t, { includeOptionalDay: true });
  const pending = await original(value, 'day-small-pending', 850, 550, '#725833');
  const before = await seed(value, { provisionalSlot: optionalId, formalSlots: [coverId, dayId], provisional: pending });
  assert.equal(before.payload.imageReview.slots.find((slot) => slot.slotId === dayId).resolutionPolicyByMovedSourceSlotId[optionalId].minWidth, 1181);
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: dayId, candidateId: pending.candidateId, manualConfirmed: false, render }), (error) => error.code === 'manual_confirmation_required');
  const after = reload(value);
  assert.equal(row(after.result, optionalId).provisionalSelected.candidateId, pending.candidateId);
  assert.equal(row(after.result, dayId).selected.candidateId, row(before.result, dayId).selected.candidateId);
  assert.equal(after.result.data.days[0].spots[0].images[1].src, pending.localUrl);
  assert.equal(after.payload.canEnterFinal, false);
  await chooseSimpleImageCandidate({ ...value, slotId: dayId, candidateId: pending.candidateId, manualConfirmed: true, render });
  const confirmed = reload(value);
  assert.equal(row(confirmed.result, optionalId).provisionalSelected, null);
  assert.equal(confirmed.result.data.days[0].spots[0].images[1], null);
  assert.equal(row(confirmed.result, dayId).selected.candidateId, pending.candidateId);
  assert.equal(confirmed.result.data.imageLocks[dayId].source, 'user_selection');
  assert.equal(confirmed.result.data.imageLocks[dayId].candidateId, pending.candidateId);
  assert.equal(row(confirmed.result, dayId).selected.humanDecision.riskConfirmed, true);
  assert.equal(confirmed.payload.imageReview.slots.find((slot) => slot.slotId === dayId).resolutionPolicy.minWidth, 1181);
});

test('confirmed move of a large provisional original clears its old slot after reload', async (t) => {
  const value = await setup(t, { includeOptionalDay: true });
  const pending = await original(value, 'day-movable-pending', 1600, 900, '#557733');
  await seed(value, { provisionalSlot: optionalId, formalSlots: [coverId], provisional: pending });
  await chooseSimpleImageCandidate({ ...value, slotId: dayId, candidateId: pending.candidateId, manualConfirmed: true, render });
  const { store, result, payload } = reload(value);
  assert.equal(row(result, optionalId).provisionalSelected, null);
  assert.equal(row(result, dayId).selected.localUrl, pending.localUrl);
  assert.deepEqual(row(result, dayId).selected.humanDecision.movedFrom, [optionalId]);
  assert.equal(store.getTaskResult(value.projectId, value.executionRunId, taskId(optionalId)).provisionalSelected, null);
  assert.equal(store.getTaskResult(value.projectId, value.executionRunId, taskId(dayId)).selected.localUrl, pending.localUrl);
  assert.equal(result.data.days[0].spots[0].images[0].src, pending.localUrl);
  assert.equal(result.data.days[0].spots[0].images[1], null);
  assert.equal(result.unresolvedItems.some((item) => item.id === optionalId), false);
  assert.equal(payload.canEnterFinal, true);
});

test('batch retry retains A provisional while B selects the same original, then clears A consistently', async (t) => {
  const value = await setup(t, { includeOptionalDay: true });
  const pending = await original(value, 'shared-search-original', 1600, 900, '#665522');
  await seed(value, { provisionalSlot: optionalId, formalSlots: [coverId], provisional: pending });
  const searched = await researchSimpleImageSlots({ ...value, slotIds: [optionalId, dayId], render, runImage: async ({ slots }) => {
    assert.deepEqual(slots.map((slot) => slot.slotId), [optionalId, dayId], 'both provisional A and missing B must be retried');
    return { status: 'needs_user_action', results: [
      { slotId: optionalId, status: 'not_found', selected: null, candidates: [] },
      { slotId: dayId, status: 'success', selected: { ...pending, hardJudgment: { technicalUsable: true, eligible: true } }, candidates: [pending] },
    ] };
  } });
  assert.deepEqual(searched.repair.slotIds, [optionalId, dayId]);
  const { store, result, payload } = reload(value);
  const taskA = store.getTaskResult(value.projectId, value.executionRunId, taskId(optionalId));
  const taskB = store.getTaskResult(value.projectId, value.executionRunId, taskId(dayId));
  assert.equal(taskA.provisionalSelected, null);
  assert.equal(row(result, optionalId).provisionalSelected, null);
  assert.equal(taskB.selected.localUrl, pending.localUrl);
  assert.equal(row(result, dayId).selected.localUrl, pending.localUrl);
  assert.equal(result.data.days[0].spots[0].images[0].src, pending.localUrl);
  assert.equal(result.data.days[0].spots[0].images[1], null);
  assert.equal(result.unresolvedItems.some((item) => item.id === optionalId), false);
  assert.equal(payload.canEnterFinal, true);
});

test('existing user lock owns its displayed asset even when task selected is null', async (t) => {
  const value = await setup(t);
  const shared = await original(value, 'locked-original', 1600, 900, '#324671');
  const { result, payload } = await seed(value, { provisionalSlot: dayId, lockedSlot: coverId, provisional: shared });
  assert.equal(row(result, coverId).selected, null);
  assert.equal(result.data.heroImage, shared.localUrl);
  assert.ok(result.data.imageLocks[coverId]);
  assert.equal(row(result, dayId).provisionalSelected, null);
  assert.equal(result.data.days[0].spots[0].images[0], undefined);
  assert.equal(payload.canEnterFinal, false);
  assert.ok(payload.unresolvedRequiredSlotIds.includes(dayId));
});
