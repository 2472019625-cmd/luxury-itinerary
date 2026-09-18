import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { runSimplePipeline } from '../server/simple-pipeline-executor.mjs';
import { createAgentPlannerServer } from '../server/agent-planner-app.mjs';
import { createProductionDefaultData } from '../src/lib/itineraryRules.js';

const root = path.resolve('.');
const configRoot = path.resolve(process.argv[3]);
for (const file of ['.env.local', '.env.image-search.local', '.env.knowledge.local']) {
  const target = path.join(configRoot, file);
  if (!existsSync(target)) continue;
  for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
for (const key of ['TEXT_MODEL_API_KEY', 'TEXT_MODEL_BASE_URL', 'TEXT_MODEL_NAME', 'IMAGE_SEARCH_API_KEY', 'IMAGE_SEARCH_BASE_URL', 'IMAGE_SEARCH_MODEL', 'BIGMODEL_API_KEY', 'BIGMODEL_BASE_URL', 'BIGMODEL_MODEL', 'IMAGE_KNOWLEDGE_BASE_URL']) if (!process.env[key]) throw new Error(`Required configuration missing: ${key}`);
const directory = path.join(root, 'output', 'full-pipeline-real-runs', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(root, 'output', 'full-pipeline-real-latest.json'), JSON.stringify({directory}));
const events = [];
const csv = (value) => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
const { server } = createAgentPlannerServer({ port: 0 });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const input = path.resolve(process.argv[2]);
const buffer = await readFile(input);
const sourceFile = { name: path.basename(input), arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
const started = Date.now();
try {
  const result = await runSimplePipeline({ root, origin, sourceFile, baseData: createProductionDefaultData(),
    plannerOptions: { apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: process.env.TEXT_MODEL_BASE_URL, model: process.env.TEXT_MODEL_NAME },
    copyOptions: { apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: process.env.TEXT_MODEL_BASE_URL, model: process.env.TEXT_MODEL_NAME, researchApiKey: process.env.IMAGE_SEARCH_API_KEY, researchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL, researchModel: 'gemini-3.7-flash-search' },
    imageOptions: { sourceMode: 'knowledge_first', knowledgeBaseUrl: process.env.IMAGE_KNOWLEDGE_BASE_URL, knowledgeTopK: Number(process.env.IMAGE_KNOWLEDGE_TOP_K || 5), trustedKnowledgeOrigins: csv(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS), searchApiKey: process.env.IMAGE_SEARCH_API_KEY, searchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL, searchModel: process.env.IMAGE_SEARCH_MODEL, visionApiKey: process.env.BIGMODEL_API_KEY, visionBaseUrl: process.env.BIGMODEL_BASE_URL, visionModel: process.env.BIGMODEL_MODEL, concurrency: {slots:4,search:4,pages:3,downloads:3,vision:3} },
    onEvent: event => {
      // Stream progress is not a durable result. Full model responses are
      // persisted by the production store; avoid synchronous O(n²) stream I/O.
      if (event.phase === 'progress') return;
      events.push(event);
      writeFileSync(path.join(directory, 'events.json'), JSON.stringify(events, null, 2));
      if (event.stage !== 'capability' || event.phase === 'slot_progress') console.log(JSON.stringify(event));
    },
  });
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  const exportStarted = Date.now();
  const response = await fetch(`${origin}/api/simple/projects/${result.projectId}/output`);
  const exportResult = { status: response.status, durationMs: 0, filePath: null, metadata: null };
  if (response.ok) {
    const output = path.join(directory, 'exported-itinerary-2000.png');
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    exportResult.metadata = await sharp(output).metadata();
    exportResult.filePath = output;
  } else exportResult.error = await response.text();
  exportResult.durationMs = Date.now() - exportStarted;
  const summary = { projectId: result.projectId, pipelineStatus: result.pipelineStatus, wallClockMs: Date.now() - started, timingsMs: result.timingsMs, callCounts: result.callCounts, export: exportResult, slotCount: result.imageExecution.results.length, imageMetrics: result.imageExecution.metrics, statuses: result.imageExecution.results.reduce((a,r) => ({...a,[r.status]:(a[r.status]||0)+1}),{}), unresolvedItems: result.unresolvedItems, render: result.render, legacyEvidence: result.legacyEvidence };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({finished:true,directory,projectId: result.projectId,pipelineStatus:result.pipelineStatus,exportStatus:response.status,wallClockMs:summary.wallClockMs}));
} catch (error) {
  await writeFile(path.join(directory, 'failure.json'), JSON.stringify({code:error.code,message:error.message,projectId:error.projectId,finalResultRef:error.finalResultRef,wallClockMs:Date.now()-started}, null, 2));
  console.log(JSON.stringify({failed:true,directory,code:error.code,message:error.message,projectId:error.projectId}));
  process.exitCode = 1;
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
