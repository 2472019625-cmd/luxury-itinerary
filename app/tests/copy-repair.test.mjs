import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopyTargetContext, planCopyRepairs } from '../server/copy-repair.mjs';
import { collectCopyIssues, groupCopyIssues, generationStateLabel } from '../src/lib/copyIssuePresentation.js';
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
  assert.deepEqual(context.ruleCards.map((item) => item.id), ['COPY-010']);
  assert.equal(JSON.stringify(context).includes('COPY-001'), false);
});

test('issue presentation keeps every issue and groups by DAY/module', () => {
  const quality = { allIssues:[{ruleIds:['COPY-010'],path:'days.2.description',message:'A'},{ruleId:'COPY-010',path:'days.4.description',message:'B'},{ruleId:'COPY-013',path:'notes',message:'C'}] };
  assert.equal(collectCopyIssues(quality).length, 3);
  const groups = groupCopyIssues(quality);
  assert.deepEqual(Object.keys(groups), ['DAY 3','DAY 5','注意事项']);
  assert.match(generationStateLabel({status:'needs_copy_revision'},3).title,/3项/);
});

test('revision recheck promotes only a fully valid draft and blocks structural notes errors', () => {
  const valid = {
    destination:'坦桑尼亚',dayCount:2,title:'坦桑尼亚2天1晚深度定制游',subtitle:'从城市走向旷野，以从容衔接完成草原初见',
    highlights:['一家一团：专属节奏不用迁就陌生团友','在地服务：定制师协同减少无效等待','草原初见：把晨昏光线留给旷野体验'],hotels:[],diningExperiences:[],transportSummary:[],included:[],excluded:[],
    days:[{theme:'从城市走向旷野',routeNodes:['城市','营地'],overnightType:'hotel',spots:[],description:'抵达后乘坐专车离开城市，眼前景色逐渐转向开阔旷野；傍晚在营地休整，让第一天从容完成节奏转换。'},{theme:'晨光中的草原收束',routeNodes:['营地','机场'],overnightType:'none',spots:[],description:'清晨乘车深入草原，在晨光中完成最后一段旷野体验；随后返回整理行装，再从容衔接机场，为旅程留下完整收束。'}],
    notes:[{title:'行程安排',items:['请在出发前与定制师核对集合时间。'],tone:'gold'}],
  };
  assert.equal(recheckCopyData(valid).contentQuality.status, 'passed');
  const blocked = recheckCopyData({ ...valid, notes:['错误字符串'] }).contentQuality;
  assert.equal(blocked.status, 'blocked_generation');
  assert.ok(blocked.allIssues.some((item) => item.code === 'notes_invalid_structure'));
});
