import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { fixture } from './support/manual-image-fixture.mjs';
import { buildSimpleManualImagePayload, prepareExplicitImageSearchSlot, researchSimpleImageSlot, researchSimpleImageSlots } from '../server/simple-manual-images.mjs';
import { runImageSearchSkill } from '../server/simple-image-skill.mjs';

const render = async ({ mode }) => ({ status: 'success', mode, outputPath: 'synthetic-draft.png' });
const duplicateTarget = () => ({
  slotId: 'image:day:1:primary', moduleType: 'day', required: true, removable: false, userLocked: false,
  location: '塞伦盖蒂', destination: '坦桑尼亚', locationRole: 'scope_only', exactIdentityRequired: false,
  subject: '草原象群', primaryVisualSubject: '草原象群行走', visualGoal: '展示象群行走',
  visualContext: { dayIndex: 0 }, copyTargetId: 'copy:day:1', aspectRatio: '16:9',
  queryCore: { subject: '象群', action: '行走', subjectEn: 'elephant herd', actionEn: 'walking', identity: '' },
  fidelityQuery: '塞伦盖蒂象群行走', alternateQueries: ['elephant herd walking'],
  plannerSlotStatus: 'unresolved', needsUserAction: true,
  plannerValidationIssues: [{ code: 'duplicate_visual_responsibility', conflictingRole: 'cover' }, { code: 'scope_only_location_in_query' }],
});

const backgroundTarget = () => ({
  ...duplicateTarget(), location: '恩戈罗恩戈罗火山区域',
  subject: '马赛部落村民身着传统红色服饰在村落或草原上行走',
  primaryVisualSubject: '马赛部落村民身着传统红色服饰在村落或草原上行走',
  queryCore: { subject: '马赛村民', action: '身着传统红色服饰行走', identity: '',
    subjectEn: 'Maasai villagers', actionEn: 'walking in traditional red clothing', identityEn: '' },
  fidelityQuery: '马赛部落 传统服饰', alternateQueries: ['Maasai people traditional clothing village', '坦桑尼亚 马赛人'],
  visualContext: { dayIndex: 0, experienceStatus: 'optional_paid', statusLabel: '自费可选', feeBoundary: 'excluded' },
  plannerValidationIssues: [{ code: 'ambiguous_visual_subject' }],
});

function installTarget(value, target = duplicateTarget()) {
  const project = value.store.getProject(value.projectId);
  const original = value.store.getPlan(value.projectId, project.activePlanId);
  const plan = { ...original, planId: `${original.planId}-manual-search`, imageSlots: original.imageSlots.map(slot => slot.slotId === target.slotId ? target : slot) };
  value.store.activatePlan(value.projectId, plan);
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  const current = final.imageExecution.results.find(item => item.slotId === target.slotId);
  Object.assign(current, { technicalStatus: 'planner_slot_unresolved', plannerValidationIssues: target.plannerValidationIssues,
    manualAction: { currentSearchFallbackResult: { previousStatus: 'needs_user_action', technicalStatus: 'planner_slot_unresolved', searchDiagnostic: { planning: { blocked: true } } } } });
  value.store.saveFinalResult(value.projectId, value.executionRunId, final);
  return plan;
}

test('explicit request waives only composition duplication, cleans scope query, and leaves the saved target intact', () => {
  const target = duplicateTarget(), before = structuredClone(target);
  const prepared = prepareExplicitImageSearchSlot(target);
  assert.equal(prepared.needsUserAction, false);
  assert.equal(prepared.plannerSlotStatus, 'user_requested');
  assert.doesNotMatch(prepared.fidelityQuery, /塞伦盖蒂/);
  for (const field of ['queryCore', 'location', 'locationRole', 'exactIdentityRequired', 'primaryVisualSubject', 'required', 'removable']) assert.deepEqual(prepared[field], target[field]);
  assert.equal(prepared.manualSearchOverride.reason, 'duplicate_visual_responsibility');
  assert.deepEqual(target, before);
});

test('explicit duplicate search cannot waive ambiguous subjects, wrong identities, missing sources or unknown planner errors', () => {
  for (const code of ['ambiguous_visual_subject', 'composite_visual_subject', 'visual_query_branch_conflict', 'image_source_binding_unproven', 'hotel_identity_required', 'image_exact_identity_invalid', 'unknown_future_error']) {
    const target = duplicateTarget(); target.plannerValidationIssues.push({ code });
    assert.equal(prepareExplicitImageSearchSlot(target).needsUserAction, true, code);
  }
  for (const extra of [{ queryCore: {} }, { exactIdentityRequired: 'false' }, { exactIdentityRequired: true }, { location: '' }, { locationRole: 'invalid' }, { plannerValidationIssues: [] }]) {
    assert.equal(prepareExplicitImageSearchSlot({ ...duplicateTarget(), ...extra }).needsUserAction, true);
  }
});

test('manual search treats a background choice inside an action as a preference and rebuilds queries from unchanged Core', () => {
  const target = backgroundTarget(), before = structuredClone(target);
  const prepared = prepareExplicitImageSearchSlot(target);
  assert.equal(prepared.plannerSlotStatus, 'user_requested');
  assert.equal(prepared.manualSearchOverride.reason, 'non_core_background_choice');
  assert.equal(prepared.manualSearchOverride.backgroundPreference, '村落或草原上');
  assert.match(prepared.fidelityQuery, /Maasai villagers walking in traditional red clothing/i);
  assert.ok(prepared.alternateQueries.includes('马赛村民'));
  assert.doesNotMatch(prepared.primaryVisualSubject, /或/);
  assert.deepEqual(prepared.queryCore, target.queryCore);
  for (const field of ['location', 'destination', 'exactIdentityRequired', 'locationRole', 'required', 'removable']) assert.deepEqual(prepared[field], target[field]);
  for (const field of ['experienceStatus', 'statusLabel', 'feeBoundary']) assert.equal(prepared.visualContext[field], target.visualContext[field]);
  assert.deepEqual(target, before);
});

test('manual background recovery supports other subjects and English without a destination or activity whitelist', () => {
  for (const [visual, core] of [
    ['骑行者在道路或小径上骑行', { subject: '骑行者', action: '骑行', subjectEn: 'cyclists', actionEn: 'cycling' }],
    ['Cyclists cycling in a park or on a road', { subject: '骑行者', action: '骑行', subjectEn: 'Cyclists', actionEn: 'cycling' }],
  ]) {
    const prepared = prepareExplicitImageSearchSlot({ ...backgroundTarget(), primaryVisualSubject: visual, queryCore: core });
    assert.equal(prepared.plannerSlotStatus, 'user_requested', visual);
    assert.deepEqual(prepared.queryCore, core);
  }
});

test('manual background recovery never drops a choice of Core subject, action, identity or a separate blocking issue', () => {
  const target = backgroundTarget();
  const cases = [
    { primaryVisualSubject: '马赛村民或咖啡农身着传统红色服饰行走' },
    { primaryVisualSubject: '马赛村民身着传统红色服饰行走或跳舞' },
    { primaryVisualSubject: '马赛村民身着传统红色服饰行走，或村民在跳舞' },
    { primaryVisualSubject: '马赛村民身着传统红色服饰行走，马赛村民跳舞或坐下' },
    { queryCore: { ...target.queryCore, subject: '马赛村民或咖啡农' } },
    { queryCore: { ...target.queryCore, actionEn: 'walking or dancing' } },
    { queryCore: { ...target.queryCore, identity: 'village A or village B' } },
    { queryCore: { ...target.queryCore, action: '跳舞', actionEn: 'dancing' } },
    { primaryVisualSubject: '马赛村民在服饰或草原上行走' },
    { exactIdentityRequired: true, queryCore: { ...target.queryCore, identity: 'specific village' } },
    { locationRole: 'visual_identity' },
    { plannerValidationIssues: [...target.plannerValidationIssues, { code: 'image_source_binding_unproven' }] },
    { plannerValidationIssues: [...target.plannerValidationIssues, { code: 'visual_query_branch_conflict' }] },
  ];
  for (const extra of cases) assert.equal(prepareExplicitImageSearchSlot({ ...target, ...extra }).needsUserAction, true, JSON.stringify(extra));
});

test('a separate supporting choice cannot block explicit search when all Core words remain in the main clause', () => {
  const target = { ...backgroundTarget(), primaryVisualSubject: '草原飞机停降在塞伦盖蒂简易土跑道，乘客登机或下机',
    queryCore: { subject: '草原飞机', action: '停降在简易跑道', identity: '', subjectEn: 'bush plane', actionEn: 'landing on a dirt airstrip', identityEn: '' },
  };
  const before = structuredClone(target), prepared = prepareExplicitImageSearchSlot(target);
  assert.equal(prepared.needsUserAction, false);
  assert.equal(prepared.manualSearchOverride.reason, 'non_core_supporting_choice');
  assert.equal(prepared.manualSearchOverride.supportingPreference, '乘客登机或下机');
  assert.deepEqual(prepared.queryCore, target.queryCore);
  assert.deepEqual(target, before);
  assert.equal(prepareExplicitImageSearchSlot({ ...target, primaryVisualSubject: '草原飞机正在空中飞行，乘客登机或下机' }).needsUserAction, true);
  assert.equal(prepareExplicitImageSearchSlot({ ...target, primaryVisualSubject: '草原飞机停降在简易跑道，随后乘客登机或下机' }).needsUserAction, true);
});

for (const multi of [false, true]) test(`automatic duplicate remains skipped; explicit ${multi ? 'batch' : 'single'} search actually reaches Knowledge then Web`, async t => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const plan = installTarget(value), target = plan.imageSlots.find(slot => slot.slotId === 'image:day:1:primary');
  const stages = [], inputs = [];
  const options = { sourceMode: 'knowledge_first', knowledgeScopeNodeIds: ['test-scope'], knowledgeQueriesPerSlot: 1,
    adapters: {
      searchKnowledgeImages: async () => { stages.push('knowledge'); return { status: 'completed', scopeState: 'empty', records: [], candidates: [] }; },
      searchWebBatch: async () => { stages.push('web'); return []; }, searchCommonsImages: async () => [],
    },
  };
  const automatic = await runImageSearchSkill({ ...options, root: value.root, slots: [target] });
  assert.equal(automatic.results[0].technicalStatus, 'planner_slot_unresolved'); assert.deepEqual(stages, []);
  const before = value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[0];
  const fn = multi ? researchSimpleImageSlots : researchSimpleImageSlot;
  await fn({ ...value, slotId: target.slotId, slotIds: [target.slotId], imageOptions: options, render,
    runImage: input => { inputs.push(input.slots.map(slot => slot.slotId)); return runImageSearchSkill(input); },
  });
  assert.equal(stages[0], 'knowledge'); assert.ok(stages.includes('web'));
  assert.deepEqual(inputs, [[target.slotId]]);
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  const searched = final.imageExecution.results.find(item => item.slotId === target.slotId);
  assert.notEqual(searched.technicalStatus, 'planner_slot_unresolved');
  assert.equal(searched.pipelineEvidence.searchTrace.planner.status, 'user_requested');
  assert.equal(searched.pipelineEvidence.searchTrace.planner.manualSearchOverride.reason, 'duplicate_visual_responsibility');
  assert.ok(searched.searchDiagnostic.knowledge.queryExecuted); assert.ok(searched.searchDiagnostic.web.entered);
  assert.deepEqual(final.imageExecution.results[0], before);
  assert.deepEqual(value.store.getPlan(value.projectId, plan.planId), plan);
  assert.equal(final.imageExecution.metrics.automaticFollowupRounds, 0);
});

for (const multi of [false, true]) test(`successful explicit ${multi ? 'batch' : 'single'} recovery clears stale blocked feedback`, async t => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  installTarget(value);
  const fn = multi ? researchSimpleImageSlots : researchSimpleImageSlot;
  const payload = await fn({ ...value, slotId: 'image:day:1:primary', slotIds: ['image:day:1:primary'], render,
    runImage: async ({ slots }) => ({ status: 'success', results: [{ slotId: slots[0].slotId, status: 'success', technicalStatus: 'selected',
      selected: { ...value.candidate, candidateId: 'new-photo', userSelected: true }, candidates: [], searchDiagnostic: { planning: { blocked: false }, web: { entered: true } } }] }),
  });
  const review = payload.imageReview.slots.find(slot => slot.slotId === 'image:day:1:primary');
  assert.notEqual(review.currentResult.technicalStatus, 'planner_slot_unresolved');
  assert.equal(review.searchDiagnostic.planning.blocked, false);
  assert.equal(payload.project.data.days[0].spots[0].images[0].src, value.candidate.localUrl);
});

for (const multi of [false, true]) test(`background-blocked slot reaches Knowledge and Web through explicit ${multi ? 'batch' : 'single'} search`, async t => {
  const value = await fixture({ includeOptionalDay: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  // Batch repair deliberately includes only required missing positions; a
  // single request must also recover an optional supporting position.
  const target = { ...backgroundTarget(), slotId: multi ? 'image:day:1:primary' : 'image:day:1:supporting:1', required: multi, removable: !multi };
  const plan = installTarget(value, target), stages = [];
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots.find(item => item.slotId === target.slotId).searchDiagnostic.planning.reason, 'scene_preference');
  const imageOptions = { sourceMode: 'knowledge_first', knowledgeScopeNodeIds: ['test-scope'], knowledgeQueriesPerSlot: 1,
    adapters: {
      searchKnowledgeImages: async () => { stages.push('knowledge'); return { status: 'completed', scopeState: 'empty', records: [], candidates: [] }; },
      searchWebBatch: async () => { stages.push('web'); return []; }, searchCommonsImages: async () => [],
    },
  };
  const automatic = await runImageSearchSkill({ ...imageOptions, root: value.root, slots: [target] });
  assert.equal(automatic.results[0].technicalStatus, 'planner_slot_unresolved'); assert.deepEqual(stages, []);
  const fn = multi ? researchSimpleImageSlots : researchSimpleImageSlot;
  await fn({ ...value, slotId: target.slotId, slotIds: [target.slotId], render, imageOptions, runImage: runImageSearchSkill });
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  const result = final.imageExecution.results.find(item => item.slotId === target.slotId);
  assert.equal(stages[0], 'knowledge'); assert.ok(stages.includes('web'));
  assert.notEqual(result.technicalStatus, 'planner_slot_unresolved');
  assert.equal(result.pipelineEvidence.searchTrace.planner.manualSearchOverride.reason, 'non_core_background_choice');
  assert.deepEqual(value.store.getPlan(value.projectId, plan.planId), plan);
  assert.equal(final.imageExecution.metrics.automaticFollowupRounds, 0);
});

test('searching a locked populated position preserves it and seeds every displayed photo, including the target', async t => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const target = { ...duplicateTarget(), userLocked: true }; installTarget(value, target);
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  final.imageExecution.results[0] = { ...final.imageExecution.results[0], status: 'success', selected: { ...value.candidate, sha256: 'cover-hash' } };
  final.imageExecution.results[1] = { ...final.imageExecution.results[1], status: 'success', selected: { ...value.candidate, candidateId: 'locked-photo', localUrl: '/image-assets/test/locked.jpg', sha256: 'locked-hash', userSelected: true } };
  final.data.days[0].spots[0].images = [{ src: '/image-assets/test/locked.jpg', userSelected: true }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, final);
  const payload = await researchSimpleImageSlot({ ...value, slotId: target.slotId, render, runImage: async ({ slots, existingImages }) => {
    assert.equal(slots[0].userLocked, false);
    assert.deepEqual(existingImages.map(image => image.sha256), ['cover-hash', 'locked-hash']);
    return { status: 'success', results: [{ slotId: target.slotId, status: 'success', selected: { ...value.candidate, candidateId: 'different-photo', sha256: 'new-hash' }, candidates: [] }] };
  } });
  assert.equal(payload.project.data.days[0].spots[0].images[0].src, '/image-assets/test/locked.jpg');
  assert.ok(payload.project.data.imageCandidates.some(candidate => candidate.candidateId === 'different-photo'));
});
