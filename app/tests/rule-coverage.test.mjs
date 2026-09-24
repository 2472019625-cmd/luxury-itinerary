import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_COVERAGE } from '../config/rule-coverage.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..');
const ruleFiles = ['01-产品流程与完成状态.md','02-数据事实与字段映射.md','03-品牌文案与模块内容.md','04-图片搜索与使用规范.md','05-模板版式与品牌资产.md','06-技术运行与文件保存.md'];

function officialRules() {
  return ruleFiles.flatMap((name) => [...readFileSync(path.join(projectRoot, 'rules', name), 'utf8').matchAll(/^\| ((?:FLOW|DATA|COPY|IMG|VIS|OPS)-\d{3}) \|.*?\| ([ABCD](?:\+[ABCD])*) \|/gm)].map((match) => ({ id: match[1], type: [...new Set(match[2].split('+'))].sort().join('+') })));
}

test('all current official rules are registered exactly once with matching execution types', () => {
  const official = officialRules();
  assert.equal(official.length, 95);
  assert.equal(new Set(official.map(({ id }) => id)).size, official.length);
  assert.equal(new Set(RULE_COVERAGE.map(({ id }) => id)).size, RULE_COVERAGE.length);
  assert.deepEqual(RULE_COVERAGE.map(({ id }) => id).sort(), official.map(({ id }) => id).sort());
  const registry = new Map(RULE_COVERAGE.map((record) => [record.id, record]));
  official.forEach(({ id, type }) => assert.equal(registry.get(id).type, type, `${id} 执行类型漂移`));
});

test('coverage records have executable evidence paths and cannot claim independent approval', () => {
  const allowed = new Set(['implemented_pending_review','human_required','external_blocked']);
  for (const record of RULE_COVERAGE) {
    assert.ok(record.stage && record.failure, `${record.id} 缺阶段或失败处理`);
    assert.ok(allowed.has(record.status), `${record.id} 状态不允许`);
    assert.ok(!/通过|approved/i.test(record.status), `${record.id} 不得自行宣布验收通过`);
    for (const relative of [...record.implementation, ...record.tests]) assert.ok(existsSync(path.join(appRoot, relative)), `${record.id} 引用不存在：${relative}`);
  }
});
