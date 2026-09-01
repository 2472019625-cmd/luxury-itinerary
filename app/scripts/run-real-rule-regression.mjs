import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { importItineraryWorkbook } from '../src/lib/itineraryImport.js';
import { createProductionDefaultData, normalizeItineraryFacts, validateItineraryFacts } from '../src/lib/itineraryRules.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..');
const input = process.argv.find((value) => value.startsWith('--input='))?.slice(8);
const origin = process.argv.find((value) => value.startsWith('--origin='))?.slice(9) || 'http://127.0.0.1:4173';
if (!input) throw new Error('必须通过 --input= 提供真实供应商 Excel');

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const projectId = `real-rule-${runStamp}`;
const evidenceDir = path.join(projectRoot, 'audit', 'evidence', '2026-08-29-程序规则缺口补齐', projectId);
await mkdir(evidenceDir, { recursive: true });

const buffer = await readFile(path.resolve(input));
const file = new File([buffer], path.basename(input), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const imported = await importItineraryWorkbook(file, createProductionDefaultData());
const data = normalizeItineraryFacts({ ...imported.data, adults: 2, children: 0 });
const validation = validateItineraryFacts(data);
const manifest = {
  projectId, createdAt: new Date().toISOString(), inputSource: path.resolve(input), sourcePreviouslySavedToLocalStorage: false,
  rules: ['FLOW-001','FLOW-002','DATA-001','DATA-003','DATA-004','DATA-005','DATA-007','DATA-011','DATA-012','DATA-014','COPY-001','COPY-017','IMG-001','IMG-008','IMG-009','IMG-011','IMG-012','IMG-015','IMG-018','IMG-020','VIS-003','VIS-016','OPS-004','OPS-011'],
  import: { report: imported.report, validation },
  jobs: {},
};
await writeFile(path.join(evidenceDir, '01-import-and-preflight.json'), JSON.stringify(manifest, null, 2), 'utf8');
if (!validation.valid) throw new Error('真实输入预检未通过：' + validation.errors.join('；'));

async function post(url, body) {
  const response = await fetch(origin + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `${url} 请求失败`);
  return payload;
}

async function waitJob(job, timeoutMs) {
  const started = Date.now();
  const snapshots = [];
  let last = job;
  while (!['complete','failed'].includes(last.status)) {
    if (Date.now() - started > timeoutMs) throw new Error(`${job.id} 超过等待上限`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const response = await fetch(`${origin}/api/jobs/${job.id}`);
    last = await response.json();
    if (!response.ok) throw new Error(last.error || '无法读取任务状态');
    const snapshot = { at: new Date().toISOString(), status: last.status, phase: last.phase, progress: last.progress, currentAction: last.currentAction, stats: last.stats };
    if (!snapshots.length || JSON.stringify(snapshots.at(-1)) !== JSON.stringify(snapshot)) snapshots.push(snapshot);
    if (snapshots.length % 10 === 1) console.log(JSON.stringify(snapshot));
  }
  return { job: last, snapshots };
}

const created = await post('/api/generate', { data, context: { specialRequests: '两位成人；严格保留供应商事实与费用状态。' } });
manifest.jobs.generation = { id: created.id };
await writeFile(path.join(evidenceDir, '02-generation-created.json'), JSON.stringify({ projectId, jobId: created.id, created }, null, 2), 'utf8');
const generation = await waitJob(created, 60 * 60 * 1000);
await writeFile(path.join(evidenceDir, '03-generation-result.json'), JSON.stringify({ projectId, jobId: created.id, snapshots: generation.snapshots, result: generation.job }, null, 2), 'utf8');
if (generation.job.status !== 'complete') throw new Error('真实生成失败：' + generation.job.error);

const renderCreated = await post('/api/render', { data: generation.job.data });
manifest.jobs.render = { id: renderCreated.id };
const render = await waitJob(renderCreated, 30 * 60 * 1000);
await writeFile(path.join(evidenceDir, '04-render-result.json'), JSON.stringify({ projectId, jobId: renderCreated.id, snapshots: render.snapshots, result: render.job }, null, 2), 'utf8');
if (render.job.status !== 'complete') throw new Error('真实2000px导出失败：' + render.job.error);

const copyIf = async (source, name) => { if (!source) return; await copyFile(source, path.join(evidenceDir, name)); };
await copyIf(generation.job.finalLayoutReview?.outputFile, '05-generation-final-review-2000.png');
await copyIf(generation.job.finalLayoutReview?.qaFile, '06-generation-layout-qa.json');
if (generation.job.imageResearch?.runId) await copyIf(path.join(appRoot, 'output', 'image-ledgers', `${generation.job.imageResearch.runId}-image-sources.json`), '07-image-ledger.json');
if (render.job.downloadUrl) await copyIf(path.join(appRoot, 'output', 'generated', path.basename(render.job.downloadUrl)), '08-formal-output-2000.png');
if (render.job.outputQa) await writeFile(path.join(evidenceDir, '09-formal-output-qa.json'), JSON.stringify(render.job.outputQa, null, 2), 'utf8');

manifest.completedAt = new Date().toISOString();
manifest.jobs.generation = { id: created.id, status: generation.job.status, phase: generation.job.phase, imageRunId: generation.job.imageResearch?.runId, finalReviewRunId: generation.job.finalLayoutReview?.runId };
manifest.jobs.render = { id: renderCreated.id, status: render.job.status, outputQa: render.job.outputQa };
manifest.outcome = 'pending_independent_review';
await writeFile(path.join(evidenceDir, '00-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ evidenceDir, projectId, generationJobId: created.id, imageRunId: generation.job.imageResearch?.runId, renderJobId: renderCreated.id, downloadUrl: render.job.downloadUrl }, null, 2));
