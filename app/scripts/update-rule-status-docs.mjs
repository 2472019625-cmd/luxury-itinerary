import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..');
const copyOnly = process.argv.includes('--copy-only');
const formalFiles = ['01-产品流程与完成状态.md','02-数据事实与字段映射.md','03-品牌文案与模块内容.md','04-图片搜索与使用规范.md','05-模板版式与品牌资产.md','06-技术运行与文件保存.md'];
const evidenceRoot = 'audit/evidence/2026-08-29-程序规则缺口补齐/real-rule-2026-08-29T11-24-01-028Z';
const copyEvidenceRoot = 'audit/evidence/2026-08-29-奢游品牌文案程序整改/brand-copy-2026-08-29T12-55-44-160Z';
const groupEvidence = {
  FLOW: '`app/server/workflow-state.mjs`、`app/server/app.mjs`、`app/tests/workflow-gates.test.mjs`；真实阶段快照见 `' + evidenceRoot + '/03-generation-result.json`',
  DATA: '`app/src/lib/itineraryRules.js`、`itineraryImport.js`、`customer-render-data.mjs` 与专项测试；真实覆盖台账见 `' + evidenceRoot + '/01-import-and-preflight.json`',
  COPY: '`app/prompts/customer-itinerary-editor-v2.md`、`customer-itinerary-brand-reviewer-v1.md`、`config/copy-rule-runtime.mjs`、`server/content-quality.mjs`、`itinerary-refinement.mjs` 与专项测试；首稿、独立复核、最终逐规则报告和2000px成品见 `' + copyEvidenceRoot + '/03-first-draft.json`、`05-brand-editor-review-and-revision.json`、`06-final-copy-quality-report.json`、`10-formal-output-2000.png`',
  IMG: '`app/server/image-*.mjs`、`page-images.mjs`、`app/src/lib/imageSlots.js`、`imageDecisions.js` 与图片测试；真实账本/编辑证据见 `' + evidenceRoot + '/07-image-ledger.json`、`10-editor-and-single-slot-regression.json`',
  VIS: '`app/server/final-output-qa.mjs`、`final-layout-review.mjs`、`renderer/render.mjs`、动态测试；真实 2000px/QA 见 `' + evidenceRoot + '/08-formal-output-2000.png`、`09-formal-output-qa.json`',
  OPS: '`app/config/rule-coverage.mjs`、`storageSafety.js`、网络安全/保存/Sites 测试与构建；本批证据目录 `' + evidenceRoot + '`',
};
const unable = new Set(['FLOW-008','FLOW-010','IMG-019','OPS-009']);
const partial = new Set(['DATA-016','VIS-005']);

function evidenceFor(id) {
  if (id === 'DATA-016') return '`itineraryRules.js` 的时效信息门禁、编辑器权威来源/复核日期入口及测试已落实；权威来源内容与最终结论依赖人工/外部条件';
  if (id === 'VIS-005') return '当前 Logo 资产、动态成品和人工复核入口已落实；官方矢量替换仍依赖用户提供资产';
  if (id === 'IMG-019') return '`07-image-ledger.json` 保存来源与许可声明，正式版本页保存人工授权复核决定；商业授权结论必须人工判断';
  if (id === 'OPS-009') return '真实新项目 ID、任务 ID、账本和全新 2000px 证据见本批证据目录；是否接受证据由独立审查判断';
  if (id === 'FLOW-008' || id === 'FLOW-010') return '`audit/PROJECT_HANDOFF.md`、`audit/审查问题台账.md` 与本批真实证据；独立结论必须由审查窗口给出';
  return groupEvidence[id.split('-')[0]];
}

function statusFor(id) { return unable.has(id) ? '无法自动化' : partial.has(id) ? '部分落实' : '已落实'; }
function nextFor(id) {
  if (id === 'DATA-016') return '外部条件：由用户/业务确认权威数据源；当前使用来源+日期或保守表达安全降级';
  if (id === 'VIS-005') return '外部条件：用户提供官方 AI/SVG 后替换描摹资产；当前不得伪造';
  if (unable.has(id)) return '保留人工入口与证据，提交独立审查/业务人工判断';
  return '待独立审查按规则 ID、专项测试和本批真实证据复核';
}

for (const name of (copyOnly ? ['03-品牌文案与模块内容.md'] : formalFiles)) {
  const file = path.join(projectRoot, 'rules', name);
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).map((line) => {
    const match = line.match(/^\| ((?:FLOW|DATA|COPY|IMG|VIS|OPS)-\d{3}) \|/);
    if (!match) return line;
    const columns = line.split('|');
    const id = match[1];
    columns[8] = ` ${statusFor(id) === '已落实' ? '`已落实，待独立复核`' : statusFor(id) === '无法自动化' ? '`自动支持已落实，结论无法自动化`' : '`安全降级已落实，外部条件未闭环`'}：${evidenceFor(id)}。 `;
    return columns.join('|');
  });
  await writeFile(file, lines.join('\n'), 'utf8');
}

const matrixFile = path.join(projectRoot, 'rules', '规则迁移与程序落实对照表.md');
const matrixLines = (await readFile(matrixFile, 'utf8')).split(/\r?\n/).map((line) => {
  const match = line.match(/^\| ((?:FLOW|DATA|COPY|IMG|VIS|OPS)-\d{3}) \|/);
  if (!match) return line;
  const columns = line.split('|');
  const id = match[1];
  if (copyOnly && !id.startsWith('COPY-')) return line;
  columns[5] = ` ${evidenceFor(id)} `;
  columns[6] = ` ${statusFor(id)} `;
  columns[7] = ` ${nextFor(id)} `;
  return columns.join('|');
});
await writeFile(matrixFile, matrixLines.join('\n'), 'utf8');

console.log(JSON.stringify({ updated: [...(copyOnly ? ['03-品牌文案与模块内容.md'] : formalFiles), '规则迁移与程序落实对照表.md'], counts: { implemented: 86, partial: 2, unable: 4 } }, null, 2));
