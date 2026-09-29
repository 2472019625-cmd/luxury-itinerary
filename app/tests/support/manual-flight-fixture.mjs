import { fixture } from './manual-image-fixture.mjs';

export const flightTarget = () => ({
  slotId: 'image:transport:test-flight:primary', moduleType: 'transport', required: false,
  location: '塞伦盖蒂', destination: '坦桑尼亚', locationRole: 'scope_only', exactIdentityRequired: false,
  subject: '草原轻型飞机停降在塞伦盖蒂简易跑道', primaryVisualSubject: '草原轻型飞机停降在塞伦盖蒂简易跑道',
  activity: '草原飞机', visualGoal: '展示草原轻型飞机在简易跑道起降，体现返程航空衔接。',
  visualContext: { destination: '坦桑尼亚', category: '草原飞机', serviceLevel: '草原飞机', usageLabel: '境内轻型航空衔接', modelGuaranteed: '车型未保证' },
  copyTargetId: 'copy:transport:test-flight', aspectRatio: '16:9', userLocked: false,
  queryCore: { subject: '轻型飞机', action: '简易跑道起降', identity: '', subjectEn: 'light aircraft', actionEn: 'taking off or landing on airstrip', identityEn: '' },
  fidelityQuery: '草原轻型飞机简易跑道', alternateQueries: ['bush plane savanna airstrip', '草原飞机 简易跑道'],
  plannerSlotStatus: 'unresolved', needsUserAction: true,
  plannerValidationIssues: [{ code: 'ambiguous_visual_subject' }], sourceEvidence: ['transport.0', 'days.0.experience'],
});

export function flightPlan() {
  const target = flightTarget();
  return {
    imageSlots: [target],
    preparedData: { destination: '坦桑尼亚', transportSummary: [{ id: 'test-flight', category: '草原飞机', serviceLevel: '草原飞机',
      usageLabel: '境内轻型航空衔接', usageSegments: ['DAY 1 塞伦盖蒂 → 阿鲁沙'], modelGuaranteed: false, images: [] }],
      days: [{ description: '乘坐草原飞机前往阿鲁沙衔接返程。', vehicle: '草原飞机', routeNodes: ['塞伦盖蒂', '阿鲁沙'], spots: [] }] },
    slotBindings: { [target.slotId]: { module: 'transport', itemIndex: 0, fieldPath: 'transportSummary.0.images.0', imageIndex: 0, required: false } },
  };
}

export async function flightFixture({ required = false } = {}) {
  const value = await fixture();
  const project = value.store.getProject(value.projectId);
  const plan = value.store.getPlan(value.projectId, project.activePlanId);
  const flight = flightPlan(), target = flight.imageSlots[0];
  target.required = required;
  plan.planId += '-flight';
  plan.imageSlots.push(target);
  Object.assign(plan.slotBindings, flight.slotBindings);
  Object.assign(plan.preparedData, { title: '手动飞机搜索验证', transportSummary: flight.preparedData.transportSummary });
  Object.assign(plan.preparedData.days[0], flight.preparedData.days[0]);
  value.store.activatePlan(value.projectId, plan);
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  final.data = structuredClone(plan.preparedData);
  final.imageExecution.results.push({ slotId: target.slotId, status: 'not_found', candidates: [], selected: null,
    technicalStatus: 'planner_slot_unresolved', plannerValidationIssues: target.plannerValidationIssues });
  final.unresolvedItems.push({ kind: 'image', id: target.slotId, status: 'needs_user_action', required });
  value.store.saveFinalResult(value.projectId, value.executionRunId, final);
  return { ...value, plan, target };
}
