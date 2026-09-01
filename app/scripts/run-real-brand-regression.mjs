import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { importItineraryWorkbook } from '../src/lib/itineraryImport.js';
import { createProductionDefaultData, normalizeItineraryFacts, validateItineraryFacts } from '../src/lib/itineraryRules.js';
import { compactForModel } from '../server/itinerary-refinement.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..');
const input = process.argv.find((value) => value.startsWith('--input='))?.slice(8);
const origin = process.argv.find((value) => value.startsWith('--origin='))?.slice(9) || 'http://127.0.0.1:4173';
if (!input) throw new Error('必须通过 --input= 提供真实供应商 Excel');

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const projectId = `brand-copy-remediation-${runStamp}`;
const evidenceDir = path.join(projectRoot, 'audit', 'evidence', '2026-08-31-奢游品牌文案独立验收整改', projectId);
await mkdir(evidenceDir, { recursive: true });

const buffer = await readFile(path.resolve(input));
const file = new File([buffer], path.basename(input), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const imported = await importItineraryWorkbook(file, createProductionDefaultData());
const data = normalizeItineraryFacts({ ...imported.data, adults: 2, children: 0 });
const validation = validateItineraryFacts(data);
const manifest = {
  projectId, createdAt: new Date().toISOString(), inputSource: path.resolve(input), sourcePreviouslySavedToLocalStorage: false,
  taskBook: 'audit/tasks/2026-08-31-奢游品牌文案独立验收整改.md',
  rules: Array.from({length:17}, (_, index) => `COPY-${String(index + 1).padStart(3,'0')}`), jobs: {}, outcome: 'running',
};
await writeFile(path.join(evidenceDir, '00-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '01-source-facts-and-import.json'), JSON.stringify({ projectId, inputSource:path.resolve(input), compactFacts:compactForModel(data), importReport:imported.report, validation }, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '01a-source-coverage-ledger.json'), JSON.stringify({
  sourceImportCoverage: data.sourceImportCoverage,
  structuredCounts: {
    included: data.included?.length || 0,
    excluded: data.excluded?.length || 0,
    dailyTransport: data.days?.filter((day) => String(day.vehicle || '').trim()).length || 0,
    transportSummary: data.transportSummary?.length || 0,
  },
  validation,
}, null, 2), 'utf8');
if (!validation.valid) throw new Error('真实输入预检未通过：' + validation.errors.join('；'));

async function post(url, body) {
  const response = await fetch(origin + url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `${url} 请求失败`);
  return payload;
}

async function waitJob(created, timeoutMs) {
  const started = Date.now(); const snapshots = []; let current = created;
  while (!['complete','failed'].includes(current.status)) {
    if (Date.now() - started > timeoutMs) throw new Error(`${created.id} 超过等待上限`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const response = await fetch(`${origin}/api/jobs/${created.id}`); current = await response.json();
    if (!response.ok) throw new Error(current.error || '读取任务失败');
    const snap = { at:new Date().toISOString(), status:current.status, phase:current.phase, progress:current.progress, currentAction:current.currentAction, stats:current.stats };
    if (!snapshots.length || JSON.stringify(snapshots.at(-1)) !== JSON.stringify(snap)) snapshots.push(snap);
    if (snapshots.length % 10 === 1) console.log(JSON.stringify(snap));
  }
  return { job:current, snapshots };
}

const created = await post('/api/generate', { data, context:{ customerPreferences:['重视野奢住宿价值与从容节奏'], specialRequests:'两位成人；严格保留所有供应商事实、体验状态和费用边界。' } });
manifest.jobs.generation = { id:created.id };
await writeFile(path.join(evidenceDir, '02-generation-created.json'), JSON.stringify(created, null, 2), 'utf8');
const generated = await waitJob(created, 60 * 60 * 1000);
await writeFile(path.join(evidenceDir, '08-generation-job-and-snapshots.json'), JSON.stringify(generated, null, 2), 'utf8');
const quality = generated.job.contentQuality || {};
await writeFile(path.join(evidenceDir, '03-first-draft.json'), JSON.stringify(quality.firstDraft || null, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '04-first-review-issues.json'), JSON.stringify(quality.initialReview || null, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '05-brand-editor-review-and-revision.json'), JSON.stringify(quality.brandEditor || null, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '05a-targeted-rewrite-diff.json'), JSON.stringify({
  reviewIssues: quality.brandEditor?.reviewIssues || [],
  patches: quality.brandEditor?.patches || [],
  changedPaths: quality.brandEditor?.changedPaths || [],
  untouchedModulesPolicy: 'Only paths named by reviewIssues may change; all other customer-copy fields retain first-draft values.',
  factComparison: quality.factComparison || null,
}, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '06-final-copy-quality-report.json'), JSON.stringify(quality.finalReview || quality, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '07-final-customer-json.json'), JSON.stringify(generated.job.data || null, null, 2), 'utf8');
if (generated.job.status !== 'complete') {
  manifest.outcome = 'generation_failed'; manifest.error = generated.job.error; manifest.completedAt = new Date().toISOString();
  await writeFile(path.join(evidenceDir, '00-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  throw new Error('真实生成失败：' + generated.job.error);
}

if (generated.job.imageResearch?.runId) {
  const ledger = path.join(appRoot, 'output', 'image-ledgers', `${generated.job.imageResearch.runId}-image-sources.json`);
  await copyFile(ledger, path.join(evidenceDir, '09-image-ledger.json'));
}
if (generated.job.finalLayoutReview?.outputFile) {
  await copyFile(generated.job.finalLayoutReview.outputFile, path.join(evidenceDir, '10-generation-review-output-2000.png'));
}
if (generated.job.finalLayoutReview?.layoutQa) {
  await writeFile(path.join(evidenceDir, '10a-generation-layout-qa.json'), JSON.stringify(generated.job.finalLayoutReview.layoutQa, null, 2), 'utf8');
}
const renderCreated = await post('/api/render', { data:generated.job.data });
manifest.jobs.render = { id:renderCreated.id };
const rendered = await waitJob(renderCreated, 30 * 60 * 1000);
await writeFile(path.join(evidenceDir, '12-render-job.json'), JSON.stringify(rendered, null, 2), 'utf8');
await writeFile(path.join(evidenceDir, '11-final-output-qa.json'), JSON.stringify(rendered.job.outputQa || null, null, 2), 'utf8');
if (rendered.job.status === 'complete') {
  await copyFile(path.join(appRoot, 'output', 'generated', path.basename(rendered.job.downloadUrl)), path.join(evidenceDir, '10-formal-output-2000.png'));
} else if (!quality.needsReview) {
  throw new Error('真实2000px导出失败：' + rendered.job.error);
}

manifest.completedAt = new Date().toISOString();
manifest.outcome = rendered.job.status === 'complete' ? 'pending_independent_review' : 'pending_editor_copy_review';
manifest.jobs.generation = { id:created.id, status:generated.job.status, imageRunId:generated.job.imageResearch?.runId, copyQualityPassed:quality.passed };
manifest.jobs.render = { id:renderCreated.id, status:rendered.job.status, downloadUrl:rendered.job.downloadUrl, error:rendered.job.error || null };
await writeFile(path.join(evidenceDir, '00-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ evidenceDir, projectId, generationJobId:created.id, imageRunId:generated.job.imageResearch?.runId, renderJobId:renderCreated.id, output:rendered.job.downloadUrl || null, outcome:manifest.outcome }, null, 2));
