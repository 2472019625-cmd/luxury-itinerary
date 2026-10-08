import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateCopyCommitments, runCopyWriterSkill } from '../server/simple-copy-skill.mjs';
import { applySimpleSkillResults } from '../server/simple-pipeline-writeback.mjs';
import { buildSimpleManualImagePayload } from '../server/simple-manual-images.mjs';
import { daySpotIssueSelection } from '../src/lib/editorPending.js';
import { fixture } from './support/manual-image-fixture.mjs';

const paid = { moduleType: 'day_spot', facts: { name: '向导徒步', description: '可自费参加向导徒步', status: 'optional_paid', feeBoundary: 'excluded' } };
for (const text of [
  '此项为自费可选，需与定制师确认后安排。',
  '可自费参加向导徒步，具体需提前确认。',
  '此项为自费可选，需提前与定制师确认。',
  '此项为自费可选，需提前确认。',
]) test(`有原始费用事实的普通确认不被判为预约：${text}`, () => assert.deepEqual(validateCopyCommitments(text, paid), []));

for (const text of [
  '此项为自费可选，必须提前确认。',
  '此项为自费可选，务必与定制师确认。',
  '此项为自费可选，需要提前3天确认。',
  '此项为自费可选，需要提前预约。',
  '此项为自费可选，需要确认预约后安排。',
  '此项为自费可选，需要申请后安排。',
  '此项为自费可选，需提前确认。保证看到狮子。',
]) test(`真实期限、预约或保证继续拒绝：${text}`, () => assert.ok(validateCopyCommitments(text, paid).length));

test('不能用输出自称自费或另一句费用提醒证明当前确认要求', () => {
  assert.ok(validateCopyCommitments('此项为自费可选，需提前确认。', { moduleType: 'day_spot', facts: { description: '徒步已包含。', status: 'included' } }).length);
  assert.ok(validateCopyCommitments('徒步自费。车辆需要提前确认。', paid).length);
});

test('单次Writer成功写回，不再制造该文案待处理，不改变源状态', async () => {
  const task = { ...paid, targetId: 'copy:spot', targetPath: 'days.0.spots.0.description', factStatuses: { sourceState: 'confirmed' }, plannerGoal: '说明已确认的自费体验', relevantContext: { destination: '测试目的地' }, outputSchema: { type: 'string', minLength: 1 }, required: true };
  let calls = 0;
  const execution = await runCopyWriterSkill({ tasks: [task], requestJson: async () => { calls++; return { json: { results: [{ targetId: task.targetId, targetPath: task.targetPath, value: '此项为自费可选，需与定制师确认后安排。' }] } }; } });
  const result = applySimpleSkillResults({ preparedData: { days: [{ spots: [{ ...paid.facts }] }] }, copyTasks: [task], copyExecution: execution });
  assert.equal(calls, 1);
  assert.deepEqual(result.unresolvedItems, []);
  assert.equal(result.data.days[0].spots[0].status, 'optional_paid');
  assert.match(result.data.days[0].spots[0].description, /需与定制师确认/);
});

test('普通体验定位使用稳定身份选择卡片；独立视觉卡不能冒充体验文案', () => {
  const data = { days: [{ spots: [{ id: 'spot-b' }, { id: 'spot-a' }, { id: 'no-picture' }] }], simpleImageSlotBindings: {
    visual: { module: 'day', useSpotCopy: false, spotId: 'spot-a', fieldPath: 'days.0.spots.0.images.0' },
    main: { module: 'day', spotId: 'spot-a', fieldPath: 'days.0.spots.0.images.1', imageIndex: 1 },
  } };
  assert.deepEqual(daySpotIssueSelection(data, 0, 1), { module: 'days', itemIndex: 0, subItemIndex: 1, imageIndex: 1, spotId: 'spot-a', slotId: 'main' });
  assert.equal(daySpotIssueSelection(data, 0, 2).slotId, null);
  assert.equal(daySpotIssueSelection(data, 1, 0), null);
  assert.equal(daySpotIssueSelection(data, 0, 0).slotId, null);
});

test('旧项目无spotId时按字段位置定位；不同DAY绑定不能串位', () => {
  const data = { days: [{ spots: [{ name: '旧体验' }] }], simpleImageSlotBindings: { other: { module: 'day', fieldPath: 'days.1.spots.0.images.0' }, legacy: { module: 'day', fieldPath: 'days.0.spots.0.images.0' } } };
  assert.equal(daySpotIssueSelection(data, 0, 0).slotId, 'legacy');
});

test('已有文字的失败项准确提示，并保留必需待处理；真正空文案仍提示未生成', async t => {
  const value = await fixture({ includeCopyFailure: true });
  t.after(async () => { assert.equal(path.dirname(value.root), os.tmpdir()); await rm(value.root, { recursive: true, force: true }); });
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const issue = result.unresolvedItems.find(x => x.kind === 'copy');
  issue.error = { code: 'unsupported_copy_commitment', message: 'internal-only detail' };
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const pending = () => buildSimpleManualImagePayload(value.store, value.projectId).blockingItems.find(x => x.kind === 'copy');
  assert.match(pending().message, /已有文字.*未通过内容检查/);
  assert.doesNotMatch(pending().message, /internal-only|尚未生成完成/);
  assert.equal(pending().required, true);
  assert.equal(pending().action, 'retry_copy');
  result.data.days[0].description = '';
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  assert.match(pending().message, /尚未生成完成/);
  result.data.days[0].description = '保留人工文字';
  issue.error.code = 'copy_request_failed';
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  assert.match(pending().message, /已有文字.*本次文案生成未完成/);
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).unresolvedItems.filter(x => x.kind === 'copy').length, 1);
});
