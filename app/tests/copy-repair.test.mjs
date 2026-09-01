import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopyTargetContext, composeCurrentFinalIssues, finalControlledRepairDecision, mergeTargetRepairIssues, planCopyRepairs } from '../server/copy-repair.mjs';
import { collectCopyIssues, copyExportEligibility, groupCopyIssueTargets, groupCopyIssues, generationStateLabel } from '../src/lib/copyIssuePresentation.js';
import { recheckCopyData } from '../server/copy-recheck.mjs';

test('routes structure and fact issues to blockers, complex DAY directly to high reasoning, simple subtitle to low', () => {
  const plan = planCopyRepairs([
    { ruleIds:['COPY-013'], code:'notes_invalid_structure', path:'notes', message:'非法结构', severity:'structure', action:'block' },
    { ruleIds:['COPY-010'], code:'day_no_value', path:'days.2.description', message:'缺少价值', severity:'quality' },
    { ruleIds:['COPY-004'], code:'subtitle_generic', path:'subtitle', message:'空泛', severity:'quality' },
  ]);
  assert.equal(plan.blockers.length, 1);
  assert.equal(plan.targets.find((item) => item.key === 'day:2').firstReasoning, 'high');
  assert.equal(plan.targets.find((item) => item.key === 'field:subtitle').firstReasoning, 'low');
});

test('DAY target context contains only target DAY, adjacent summaries, facts, role and rule cards', () => {
  const target = planCopyRepairs([{ ruleIds:['COPY-010'], code:'day_no_progression', path:'days.1.description', message:'缺少推进', severity:'quality' }]).targets[0];
  const facts = { days:[{index:0,description:'前一天'},{index:1,description:'当天',routeNodes:['A','B']},{index:2,description:'后一天'}] };
  const context = buildCopyTargetContext(facts, facts, { journeyPromise:'整程承诺', dayRoles:[{index:1,contentRole:'高潮'}] }, target);
  assert.equal(context.currentTarget.index, 1);
  assert.equal(context.context.previousDay.index, 0);
  assert.equal(context.context.nextDay.index, 2);
  assert.equal(context.context.sourcePreviousDay.description, '前一天');
  assert.equal(context.context.sourceNextDay.description, '后一天');
  assert.deepEqual(context.ruleCards.map((item) => item.id), ['COPY-010']);
  assert.equal(JSON.stringify(context).includes('COPY-001'), false);
});

test('generated unsupported fact is repaired as a target, while a real source conflict remains blocking', () => {
  const plan = planCopyRepairs([
    { ruleIds:['COPY-010','COPY-015'], code:'factual_sentence_without_evidence', path:'days.1.description', message:'客户文案中的具体事实缺少原始依据：泳池', severity:'fact', action:'safe_fact_fallback' },
    { ruleIds:['COPY-014'], code:'fee_source_coverage_mismatch', path:'included', message:'原文件费用未完整导入', severity:'fact', action:'block' },
  ]);
  assert.ok(plan.targets.some((item) => item.key === 'day:1'));
  assert.ok(plan.blockers.some((item) => item.code === 'fee_source_coverage_mismatch'));
});

test('DAY repair receives original adjacent facts separately from current generated copy', () => {
  const target = planCopyRepairs([{ ruleIds:['COPY-010'], code:'day_near_duplicate', path:'days.1.description', message:'相邻日重复', severity:'quality' }]).targets[0];
  const facts = { days:[{description:'源前一天'},{description:'源当天'},{description:'源后一天'}] };
  const current = { days:[{description:'生成前一天错误'},{description:'生成当天'},{description:'生成后一天错误'}] };
  const context = buildCopyTargetContext(facts, current, {}, target);
  assert.equal(context.context.previousDay.description, '源前一天');
  assert.equal(context.context.nextDay.description, '源后一天');
  assert.equal(context.context.currentPreviousDay.description, '生成前一天错误');
});

test('subtitle repair receives the full route spine, key experiences, stays and transport instead of one old sentence', () => {
  const target = planCopyRepairs([{ ruleIds:['COPY-004'], code:'subtitle_selling_point_list', path:'subtitle', message:'缺少路线推进', severity:'quality' }]).targets[0];
  assert.equal(target.firstReasoning, 'low');
  const facts = {
    destination:'坦桑尼亚', dayCount:2, subtitle:'旧副标题',
    days:[{routeNodes:['机场','塞伦盖蒂'],spots:[{name:'私人保护区游猎'}]},{routeNodes:['塞伦盖蒂','机场'],spots:[]}],
    hotels:[{officialName:'Test Lodge',region:'塞伦盖蒂',nights:2}],
    transportSummary:[{category:'草原飞机',serviceLevel:'轻型航空'}],
    sourcePosterHighlights:['草原飞机减少长途陆路'],
  };
  const context = buildCopyTargetContext(facts, facts, { journeyPromise:'从城市深入草原' }, target);
  assert.equal(context.currentTarget, '旧副标题');
  assert.deepEqual(context.sourceTarget.routeSummary[0].routeNodes, ['机场','塞伦盖蒂']);
  assert.equal(context.sourceTarget.routeSummary[0].coreExperiences[0], '私人保护区游猎');
  assert.equal(context.sourceTarget.transport[0].category, '草原飞机');
  assert.equal(context.context.journeyPromise, '从城市深入草原');
});

test('final issue composition uses only the current final review, not historical repaired issues', () => {
  const historical = [{ code:'old_issue', path:'days.0.description', message:'已经修复' }];
  const current = composeCurrentFinalIssues([], { reviewIssues:[], unresolvedIssues:[] }, []);
  assert.equal(current.length, 0);
  assert.equal(current.includes(historical[0]), false);
});

test('final controlled repair runs once when final review finds issues and never loops automatically', () => {
  const issues = [{ ruleId:'COPY-010', path:'days.3.description', message:'缺少旅行意义' }];
  assert.equal(finalControlledRepairDecision(issues).shouldRun, true);
  assert.equal(finalControlledRepairDecision(issues, { attempted:true }).shouldRun, false);
  assert.equal(finalControlledRepairDecision([]).shouldRun, false);
});

test('issue presentation keeps every issue and groups by DAY/module', () => {
  const quality = { allIssues:[{ruleIds:['COPY-010'],path:'days.2.description',message:'A'},{ruleId:'COPY-010',path:'days.4.description',message:'B'},{ruleId:'COPY-013',path:'notes',message:'C'}] };
  assert.equal(collectCopyIssues(quality).length, 3);
  const groups = groupCopyIssues(quality);
  assert.deepEqual(Object.keys(groups), ['DAY 3','DAY 5','注意事项']);
  assert.match(generationStateLabel({status:'needs_copy_revision'},3).title,/3项/);
});

test('user-facing issue count merges duplicate checks for the same actual edit target', () => {
  const quality = { allIssues:[
    {ruleId:'COPY-010',path:'days.3.description',message:'流水账',severity:'quality',action:'targeted_rewrite'},
    {ruleId:'COPY-010',path:'days.3.description',message:'缺少旅行意义',severity:'quality',action:'targeted_rewrite'},
    {ruleId:'COPY-014',path:'included',message:'原始费用缺失',severity:'fact',action:'block'},
  ] };
  const targets = groupCopyIssueTargets(quality);
  assert.equal(targets.length, 2);
  assert.equal(targets.find((item) => item.targetPath === 'days.3').issues.length, 2);
  assert.equal(targets.find((item) => item.targetPath === 'expenses').aiRepairable, false);
});

test('revision recheck promotes only a fully valid draft and blocks structural notes errors', () => {
  const valid = {
    destination:'坦桑尼亚',dayCount:2,title:'坦桑尼亚2天1晚深度定制游',subtitle:'从城市走向旷野，以从容衔接完成草原初见',
    highlights:['一家一团：专属节奏不用迁就陌生团友','草原初见：把晨昏光线留给旷野体验','从容转场：减少城市与营地之间的无效折返'],hotels:[],diningExperiences:[],transportSummary:[],included:[],excluded:[],
    days:[{theme:'从城市走向旷野',routeNodes:['城市','营地'],overnightType:'hotel',spots:[],description:'抵达后乘坐专车离开城市，眼前景色逐渐转向开阔旷野；傍晚在营地休整，让第一天从容完成节奏转换。'},{theme:'晨光中的草原收束',routeNodes:['营地','机场'],overnightType:'none',spots:[],description:'清晨乘车深入草原，在晨光中完成最后一段旷野体验；随后返回整理行装，再从容衔接机场，为旅程留下完整收束。'}],
    notes:[{title:'行程安排',items:['请在出发前与定制师核对集合时间。'],tone:'gold'}],
  };
  assert.equal(recheckCopyData(valid).contentQuality.status, 'passed');
  const blocked = recheckCopyData({ ...valid, notes:['错误字符串'] }).contentQuality;
  assert.equal(blocked.status, 'blocked_generation');
  assert.ok(blocked.allIssues.some((item) => item.code === 'notes_invalid_structure'));
});

test('single-target repair preserves every unrelated issue and replaces only the selected target results', () => {
  const previous = [
    {ruleId:'COPY-004',path:'subtitle',message:'副标题问题'},
    {ruleId:'COPY-010',path:'days.3.description',message:'旧DAY问题'},
    {ruleId:'COPY-013',path:'notes',message:'注意事项问题'},
  ];
  const merged = mergeTargetRepairIssues(previous, ['days.3'], [{ruleId:'COPY-010',path:'days.3.description',message:'修正后仍缺少价值'}]);
  assert.equal(merged.some((item) => item.message === '旧DAY问题'), false);
  assert.equal(merged.some((item) => item.message === '修正后仍缺少价值'), true);
  assert.equal(merged.some((item) => item.message === '副标题问题'), true);
  assert.equal(merged.some((item) => item.message === '注意事项问题'), true);
});

test('ordinary copy warnings may export after acknowledgement while hard issues remain blocked', () => {
  const warningProject = { workflowStage:'needs-copy-revision', data:{ days:[{}], copyQuality:{passed:false,blocked:false,hardIssueCount:0} } };
  assert.deepEqual(copyExportEligibility(warningProject), {allowed:true,hardBlocked:false,hasWarnings:true,requiresWarningAcknowledgement:true});
  const blockedProject = { workflowStage:'blocked', data:{ days:[{}], copyQuality:{passed:false,blocked:true,hardIssueCount:1} } };
  assert.equal(copyExportEligibility(blockedProject).allowed, false);
});
