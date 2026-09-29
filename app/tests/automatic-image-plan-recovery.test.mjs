import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runImageSearchSkill } from '../server/simple-image-skill.mjs';
import { recoveryData, recoveryVisuals, recoveryPlan } from './support/automatic-image-plan-fixture.mjs';
import { buildKnowledgeHierarchy } from '../server/knowledge-scope-resolver.mjs';
import { imageAdapters } from './helpers/simple-pipeline-fixture.mjs';

test('first automatic plan recovers flight poses, cover/DAY elephants and dining/DAY breakfast without another Planner call', async () => {
  const { agentPlan, simple } = await recoveryPlan();
  for (const role of ['transport:1', 'day:1', 'day:2:supporting:1']) {
    const slot = agentPlan.imagePlan.slots.find(slot => slot.role === role);
    assert.equal(slot.plannerSlotStatus, 'locally_repaired', role);
    assert.equal(slot.needsUserAction, false, role);
    assert.ok(!agentPlan.validation.unresolvedSlotRoles.includes(role));
    if (role.startsWith('day:')) {
      assert.deepEqual(slot.queryCore, recoveryVisuals().find(s => s.role === role).queryCore);
      assert.ok(slot.plannerLocalRepairs.some(r => r.code === 'cross_module_distinct_photo_search' && r.requireDistinctPhoto));
    }
  }
  const flight = agentPlan.imagePlan.slots.find(slot => slot.role === 'transport:1');
  assert.equal(flight.queryCore.action, '');
  assert.equal(flight.queryCore.actionEn, '');
  assert.equal(flight.queryCore.subject, '草原小飞机');
  assert.equal(flight.plannerLocalRepairs[0].originalQueryCore.actionEn, 'taking off or landing');
  const breakfast = agentPlan.imagePlan.slots.find(slot => slot.role === 'day:2:supporting:1');
  assert.ok([breakfast.fidelityQuery, ...breakfast.alternateQueries].every(q => !q.includes('马赛马拉')));
  assert.equal(breakfast.required, false);
  assert.equal(breakfast.removable, true);
  assert.equal(simple.imageSlots.filter(s => s.needsUserAction).length, 0);
});

test('automatic recovery reaches Knowledge and Web in the original Image batch for all three targets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'automatic-image-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { simple } = await recoveryPlan();
  const slots = simple.imageSlots.filter(s => s.moduleType === 'transport' || s.slotId === 'image:day:1:primary' || s.slotId === 'image:day:2:supporting:1');
  assert.equal(slots.length, 3);
  const knowledge = [], web = [];
  const result = await runImageSearchSkill({ root, slots, sourceMode: 'knowledge_first', knowledgeQueriesPerSlot: 1,
    adapters: {
      loadKnowledgeHierarchy: async () => buildKnowledgeHierarchy([
        { node_id: 'root', formal_name: '根知识库' },
        { node_id: 'kenya', formal_name: '肯尼亚', parent_node_id: 'root' },
        { node_id: 'amboseli', formal_name: '安博塞利国家公园', parent_node_id: 'kenya' },
        { node_id: 'kilimanjaro', formal_name: '乞力马扎罗雪山', parent_node_id: 'amboseli' },
        { node_id: 'mara', formal_name: '马赛马拉', parent_node_id: 'kenya' },
      ]),
      searchKnowledgeImages: async input => { knowledge.push(input); return { status: 'completed', scopeState: 'empty', records: [], candidates: [] }; },
      searchWebBatch: async input => { web.push(input); return []; }, searchCommonsImages: async () => [],
    },
  });
  assert.ok(knowledge.length >= 3);
  assert.ok(web.length >= 3);
  for (const r of result.results) {
    assert.notEqual(r.technicalStatus, 'planner_slot_unresolved', r.slotId);
    assert.ok(r.pipelineEvidence.searchTrace.planner.localRepairs.length > 0);
    assert.ok(r.pipelineEvidence.searchTrace.knowledgeQuery.attempts > 0, r.slotId);
    assert.equal(r.pipelineEvidence.searchTrace.web.entered, true, r.slotId);
  }
  assert.equal(result.metrics.businessBatches, 1);
  assert.equal(result.metrics.automaticFollowupRounds, 0);
});

test('duplicate recovery preserves missing identities, ambiguous subjects, missing facts and same-DAY conflicts as blockers', async () => {
  for (const [label, change] of [
    ['missing identity', s => { s.queryCore.identity = ''; }],
    ['ambiguous subject', s => { s.queryCore.subject = '大象群或狮群'; }],
    ['unbound source', s => { s.sourceRefs = ['days.9.spots.0']; }],
    ['wrong day source', s => { s.sourceRefs = ['days.1.experience']; }],
    ['no source', s => { s.sourceRefs = []; }],
    ['invalid source list', s => { s.sourceRefs = 'days.0'; }],
    ['missing scope', s => { s.location = ''; }],
  ]) {
    const { agentPlan } = await recoveryPlan({ mutate: raw => change(raw.imagePlan.slots.find(s => s.role === 'day:1')) });
    assert.equal(agentPlan.imagePlan.slots.find(s => s.role === 'day:1').needsUserAction, true, label);
  }
  const { agentPlan } = await recoveryPlan({ mutate: raw => {
    const original = raw.imagePlan.slots.find(s => s.role === 'day:1');
    raw.imagePlan.slots.push({ ...structuredClone(original), role: 'day:1:supporting:1', required: false, removable: true });
    // Remove the cover collision to isolate a same-DAY repeated scene.
    raw.imagePlan.slots.find(s => s.role === 'cover').queryCore.subject = '雪山';
  } });
  assert.equal(agentPlan.imagePlan.slots.find(s => s.role === 'day:1:supporting:1').needsUserAction, true);
  const withCover = await recoveryPlan({ mutate: raw => {
    const original = raw.imagePlan.slots.find(s => s.role === 'day:1');
    raw.imagePlan.slots.push({ ...structuredClone(original), role: 'day:1:supporting:1', required: false, removable: true });
  } });
  assert.equal(withCover.agentPlan.imagePlan.slots.find(s => s.role === 'day:1').needsUserAction, false);
  assert.equal(withCover.agentPlan.imagePlan.slots.find(s => s.role === 'day:1:supporting:1').needsUserAction, true, 'cover-first ordering must not conceal same-DAY duplicates');
});

test('automatic flight recovery cannot erase promised flight experiences, model identity or missing transport bindings', async () => {
  for (const change of [
    data => { data.transportSummary[0].modelGuaranteed = true; },
    data => { data.transportSummary[0].model = 'Confirmed aircraft'; },
    data => { data.days[0].spots.push({ name: '航拍体验' }); },
    data => { data.transportSummary[0].usageSegments = []; },
    data => { data.transportSummary[0].features = ['体验降落']; },
  ]) {
    const data = recoveryData(); change(data);
    const { agentPlan } = await recoveryPlan({ data });
    assert.equal(agentPlan.imagePlan.slots.find(s => s.role === 'transport:1').needsUserAction, true, String(change));
  }
  const { agentPlan } = await recoveryPlan({ mutate: raw => { raw.imagePlan.slots.find(s => s.role === 'transport:1').sourceRefs = ['transport.9']; } });
  assert.equal(agentPlan.imagePlan.slots.find(s => s.role === 'transport:1').needsUserAction, true);
});

test('recovered cross-module breakfast slots still cannot adopt the same photo twice', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'automatic-image-dedup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { simple } = await recoveryPlan();
  const slots = simple.imageSlots.filter(s => s.moduleType === 'dining' || s.slotId === 'image:day:2:supporting:1');
  assert.equal(slots.length, 2);
  const adapters = imageAdapters({ appRoot: root, delayMs: 0 });
  const download = adapters.downloadCandidate;
  adapters.downloadCandidate = async (...args) => ({ ...await download(...args), sha256: 'same-source-photo' });
  const result = await runImageSearchSkill({ root, slots, sourceMode: 'web_only', adapters,
    visionApiKey: 'fixture', visionBaseUrl: 'https://vision.invalid', visionModel: 'fixture',
    sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1 });
  assert.equal(result.results.filter(r => r.selected).length, 1, 'only one placement may own the repeated source photo');
  assert.ok(result.results.some(r => r.candidates.some(c => c.rejection === 'exact-duplicate')));
  assert.ok(result.results.every(r => r.technicalStatus !== 'planner_slot_unresolved'));
  assert.equal(result.metrics.automaticFollowupRounds, 0);
});


test('explicit optional omission removes only an empty task, preserving populated conflicts', async () => {
  for (const populated of [false, true]) {
    const { agentPlan, simple } = await recoveryPlan({ mutate(raw) {
      raw.imagePlan.omittedOptionalRoles = [...(raw.imagePlan.omittedOptionalRoles || []), 'transport:1'];
      const slot = raw.imagePlan.slots.find(item => item.role === 'transport:1');
      if (!populated) Object.assign(slot, { primaryVisualSubject: '无用车安排，不单独规划图片',
        queryCore: { subject: '', action: '', identity: '', subjectEn: '', actionEn: '', identityEn: '' },
        fidelityQuery: '', alternateQueries: [], searchIntent: [], required: false, removable: true });
    } });
    assert.equal(agentPlan.imagePlan.slots.some(slot => slot.role === 'transport:1'), populated);
    assert.equal(agentPlan.validation.unresolvedSlotRoles.includes('transport:1'), populated);
    assert.equal(simple.imageSlots.some(slot => slot.moduleType === 'transport'), populated);
  }
});


test('empty optional omission cannot erase a locked slot or a surviving query', async () => {
  for (const patch of [{userLocked:true},{fidelityQuery:'飞机'},{role:'cover',required:true}]) {
    const role=patch.role || 'transport:1';
    const {agentPlan}=await recoveryPlan({mutate(raw){
      raw.imagePlan.omittedOptionalRoles=[role];
      Object.assign(raw.imagePlan.slots.find(slot=>slot.role===role),{
        queryCore:{subject:'',action:'',identity:'',subjectEn:'',actionEn:'',identityEn:''},
        fidelityQuery:'',alternateQueries:[],searchIntent:[],required:false,...patch});
    }});
    assert.ok(agentPlan.imagePlan.slots.some(slot=>slot.role===role));
    assert.ok(agentPlan.validation.unresolvedSlotRoles.includes(role));
  }
});
