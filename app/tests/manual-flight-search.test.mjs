import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { flightTarget, flightPlan, flightFixture } from './support/manual-flight-fixture.mjs';
import { buildSimpleManualImagePayload, prepareExplicitImageSearchSlot, researchSimpleImageSlot, researchSimpleImageSlots } from '../server/simple-manual-images.mjs';
import { runImageSearchSkill, buildImageConstraints } from '../server/simple-image-skill.mjs';

test('a saved single scene with English pose alternatives can be searched using its bound transport facts', () => {
  const target = flightTarget(), plan = flightPlan(), before = structuredClone({ target, plan });
  const prepared = prepareExplicitImageSearchSlot(target, { plan });
  assert.equal(prepared.plannerSlotStatus, 'user_requested');
  assert.equal(prepared.needsUserAction, false);
  assert.equal(prepared.manualSearchOverride.reason, 'transport_overview_pose');
  assert.deepEqual(prepared.manualSearchOverride.originalQueryCore, target.queryCore);
  assert.deepEqual(prepared.searchIntent, ['轻型飞机', 'light aircraft']);
  assert.equal(prepared.queryCore.action, '');
  for (const field of ['subject', 'subjectEn', 'identity', 'identityEn']) assert.equal(prepared.queryCore[field], target.queryCore[field]);
  for (const field of ['location', 'destination', 'locationRole', 'exactIdentityRequired', 'required', 'visualGoal']) assert.deepEqual(prepared[field], target[field]);
  const constraints = buildImageConstraints(prepared);
  assert.equal(constraints.minimumVisualProof.action, '');
  assert.ok(constraints.minimumVisualProof.identityRequirement);
  assert.ok(constraints.prefer.some(value => value.includes('跑道起降')));
  assert.deepEqual({ target, plan }, before);
});

test('manual pose recovery requires matching sources and cannot erase specific experiences or identities', () => {
  const cases = [
    (slot, plan) => { plan.slotBindings = {}; },
    (slot, plan) => { plan.slotBindings[slot.slotId].itemIndex = 1; },
    slot => { slot.sourceEvidence = ['transport.1']; },
    slot => { slot.moduleType = 'day'; },
    slot => { slot.exactIdentityRequired = true; slot.queryCore.identity = 'specific aircraft'; },
    slot => { slot.locationRole = 'visual_identity'; },
    slot => { slot.queryCore.subjectEn = 'aircraft or helicopter'; },
    slot => { slot.queryCore.actionEn = 'taking off or sightseeing'; },
    slot => { slot.primaryVisualSubject = '轻型飞机先起飞随后降落'; },
    slot => { slot.plannerValidationIssues.push({ code: 'image_source_binding_unproven' }); },
    slot => { slot.visualGoal = '体验低空飞越观景飞行'; },
    (slot, plan) => { plan.preparedData.transportSummary[0].usageSegments = []; },
    (slot, plan) => { plan.preparedData.transportSummary[0].category = '直升机'; plan.preparedData.transportSummary[0].serviceLevel = '直升机'; },
    (slot, plan) => { plan.preparedData.transportSummary[0].modelGuaranteed = true; },
    (slot, plan) => { plan.preparedData.transportSummary[0].model = 'confirmed model'; },
    (slot, plan) => { plan.preparedData.days[0].description = '草原飞机起飞观光体验'; },
    (slot, plan) => { plan.preparedData.days[0].spots = [{ name: '航拍体验' }]; },
    (slot, plan) => { plan.preparedData.transportSummary[0].features = ['体验降落']; },
  ];
  assert.equal(prepareExplicitImageSearchSlot(flightTarget()).needsUserAction, true);
  for (const change of cases) {
    const slot = flightTarget(), plan = flightPlan(); change(slot, plan);
    assert.equal(prepareExplicitImageSearchSlot(slot, { plan }).needsUserAction, true, String(change));
  }
});

test('transport source indices survive unrelated category-less entries in confirmed input', () => {
  const slot = flightTarget(), plan = flightPlan();
  plan.preparedData.transportSummary.unshift({ id: 'incomplete' });
  plan.slotBindings[slot.slotId].itemIndex = 1; slot.sourceEvidence = ['transport.1'];
  assert.equal(prepareExplicitImageSearchSlot(slot, { plan }).needsUserAction, false);
});

for (const batch of [false, true]) test(`saved unresolved flight: explicit ${batch ? 'batch' : 'single'} search reaches Knowledge then Web`, async t => {
  const value = await flightFixture({ required: batch });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const before = structuredClone(value.plan), stages = [];
  const imageOptions = { sourceMode: 'knowledge_first', knowledgeScopeNodeIds: ['test-scope'], knowledgeQueriesPerSlot: 1,
    adapters: { searchKnowledgeImages: async () => { stages.push('knowledge'); return { status: 'completed', scopeState: 'empty', records: [], candidates: [] }; },
      searchWebBatch: async () => { stages.push('web'); return []; }, searchCommonsImages: async () => [] } };
  const automatic = await runImageSearchSkill({ ...imageOptions, root: value.root, slots: [value.target] });
  assert.equal(automatic.results[0].technicalStatus, 'planner_slot_unresolved'); assert.deepEqual(stages, []);
  const initial = buildSimpleManualImagePayload(value.store, value.projectId).imageReview.slots.find(s => s.slotId === value.target.slotId);
  assert.equal(initial.searchDiagnostic.planning.reason, 'scene_preference');
  const fn = batch ? researchSimpleImageSlots : researchSimpleImageSlot;
  await fn({ ...value, slotId: value.target.slotId, slotIds: [value.target.slotId], imageOptions, runImage: runImageSearchSkill,
    render: async ({ mode }) => ({ status: 'success', mode, outputPath: 'synthetic-draft.png' }) });
  assert.equal(stages[0], 'knowledge'); assert.ok(stages.includes('web'));
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  const result = final.imageExecution.results.find(s => s.slotId === value.target.slotId);
  assert.notEqual(result.technicalStatus, 'planner_slot_unresolved');
  assert.equal(result.pipelineEvidence.searchTrace.planner.manualSearchOverride.reason, 'transport_overview_pose');
  assert.equal(final.imageExecution.metrics.automaticFollowupRounds, 0);
  assert.deepEqual(value.store.getPlan(value.projectId, value.plan.planId), before);
});
