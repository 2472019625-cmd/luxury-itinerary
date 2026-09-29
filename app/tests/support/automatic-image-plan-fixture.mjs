import assert from 'node:assert/strict';
import { buildAgentFactBasis, generateAgentPlan } from '../../server/agent-trip-planner.mjs';
import { materializeSimpleSkillPlan } from '../../server/simple-plan-adapter.mjs';
import { plannerRequestJson } from '../helpers/simple-pipeline-fixture.mjs';

// Newly constructed input; never read or mutate a saved customer project.
export const recoveryData = () => ({ destination: '肯尼亚', hotels: [],
  transportSummary: [{ id: 'flight', category: '草原飞机', serviceLevel: '草原飞机', usageLabel: '境内航空衔接', usageSegments: ['DAY 1 安博塞利 → 马赛马拉'], images: [] }],
  diningExperiences: [{ id: 'breakfast', title: '丛林早餐', location: '马赛马拉', images: [] }],
  days: [
    { route: '安博塞利 → 马赛马拉', routeNodes: ['安博塞利', '马赛马拉'], description: '欣赏雪山下的象群，乘草原飞机前往马赛马拉。', vehicle: '草原飞机', spots: [{ name: '象群漫步', description: '雪山下的象群漫步。', images: [] }] },
    { route: '马赛马拉', routeNodes: ['马赛马拉'], description: '草原游猎与丛林早餐。', spots: [{ name: '草原游猎', description: '观察草原动物。', images: [] }, { name: '丛林早餐', description: '在草原享用早餐。', images: [] }] },
  ],
});

export function recoveryVisuals() {
  const elephant = { primaryVisualSubject: '乞力马扎罗雪山下的大象群漫步草原', location: '安博塞利国家公园', locationRole: 'visual_identity', exactIdentityRequired: true,
    queryCore: { subject: '大象群', action: '漫步', identity: '乞力马扎罗雪山', subjectEn: 'elephant herd', actionEn: 'walking', identityEn: 'Mount Kilimanjaro' },
    fidelityQuery: '乞力马扎罗山下大象群', alternateQueries: ['elephant herd below Mount Kilimanjaro'], sourceRefs: ['days.0.spots.0'] };
  const breakfast = { primaryVisualSubject: '草原丛林早餐餐桌上摆放的餐点', location: '马赛马拉', locationRole: 'scope_only', exactIdentityRequired: false,
    queryCore: { subject: '丛林早餐', action: '享用早餐', identity: 'Bush Breakfast', subjectEn: 'bush breakfast', actionEn: 'having breakfast', identityEn: 'Bush Breakfast' },
    fidelityQuery: '马赛马拉丛林早餐', alternateQueries: ['bush breakfast savanna', '草原早餐桌'] };
  return [
    { ...structuredClone(elephant), role: 'cover' },
    { ...structuredClone(elephant), role: 'day:1' },
    { ...structuredClone(breakfast), role: 'dining:1', sourceRefs: ['diningExperiences.0'] },
    { ...structuredClone(breakfast), role: 'day:2:supporting:1', sourceRefs: ['days.1.experience'], required: false, removable: true },
    { role: 'transport:1', primaryVisualSubject: '草原小飞机在草原简易跑道起降', location: '肯尼亚', locationRole: 'scope_only', exactIdentityRequired: false,
      queryCore: { subject: '草原小飞机', action: '起降', identity: '', subjectEn: 'bush plane', actionEn: 'taking off or landing', identityEn: '' },
      fidelityQuery: '草原小飞机简易跑道', alternateQueries: ['bush plane landing on grass airstrip', '轻型飞机草原起降'], sourceRefs: ['transport.0'] },
  ];
}

export async function recoveryPlan({ data = recoveryData(), mutate = () => {} } = {}) {
  const original = structuredClone(data), facts = buildAgentFactBasis(data);
  let calls = 0;
  const result = await generateAgentPlan({ project: { projectId: 'new-auto-recovery', inputFingerprint: 'synthetic', factBasis: facts, planIds: [] }, simpleSkillContract: true,
    requestJson: async options => {
      calls++;
      const response = await plannerRequestJson({ delayMs: 0 })(options);
      for (const visual of recoveryVisuals()) {
        const existing = response.json.imagePlan.slots.find(slot => slot.role === visual.role);
        if (existing) Object.assign(existing, visual);
        else response.json.imagePlan.slots.push(visual);
      }
      mutate(response.json, facts);
      return response;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(data, original);
  return { data, agentPlan: result.plan, simple: materializeSimpleSkillPlan({ data, agentPlan: result.plan }) };
}

