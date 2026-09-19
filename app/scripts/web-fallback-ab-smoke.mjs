// Isolated A/B harness for comparing legacy and current Web fallback behavior.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runImageSearchSkill as runCurrent } from '../server/simple-image-skill.mjs';
import { searchWebBatch as currentSearch } from '../server/image-search.mjs';
import { applySimpleSkillResults } from '../server/simple-pipeline-writeback.mjs';
import { getSlotImage, setSlotImage } from '../src/lib/imageSlots.js';

const appRoot = path.resolve('.');
const oldAppRoot = path.resolve(process.argv[2]);
const configRoot = path.resolve(process.argv[3]);
for (const file of ['.env.local','.env.image-search.local','.env.knowledge.local']) {
  const target=path.join(configRoot,file); if(!fs.existsSync(target)) continue;
  for(const line of fs.readFileSync(target,'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
}
for(const key of ['IMAGE_SEARCH_API_KEY','IMAGE_SEARCH_BASE_URL','IMAGE_SEARCH_MODEL','BIGMODEL_API_KEY','BIGMODEL_BASE_URL','BIGMODEL_MODEL']) if(!process.env[key]) throw new Error(`Required configuration missing: ${key}`);

const runDir=path.join(appRoot,'output','web-fallback-ab',new Date().toISOString().replace(/[:.]/g,'-'));
await fsp.mkdir(runDir,{recursive:true});
const baselineRun=JSON.parse(await fsp.readFile(path.join(appRoot,'output/full-pipeline-real-runs/2026-09-18T13-21-21-974Z/result.json'),'utf8'));
const projectId=baselineRun.projectId, planId=baselineRun.plannerResult.planId;
const plan=JSON.parse(await fsp.readFile(path.join(appRoot,'output/simple-pipeline/projects',projectId,'plans',`${planId}.json`),'utf8'));
const wanted=['image:cover:primary','image:hotel:imported-hotel-1:primary','image:day:5:primary','image:day:5:supporting:1','image:dining:imported-dining-bush-breakfast-day-7:primary','image:transport:imported-transport-2:primary'];
const slots=wanted.map(id=>plan.imageSlots.find(slot=>slot.slotId===id));
if(slots.some(Boolean)===false||slots.some(slot=>!slot)) throw new Error('Saved Planner output is missing one of the six fixed slots');
await fsp.writeFile(path.join(runDir,'input-slots.json'),JSON.stringify({projectId,planId,slots},null,2));

const oldSkill=(await import(pathToFileURL(path.join(oldAppRoot,'server/simple-image-skill.mjs')).href)).runImageSearchSkill;
const oldSearch=(await import(pathToFileURL(path.join(oldAppRoot,'server/image-search.mjs')).href)).searchWebBatch;
const csv=value=>String(value||'').split(',').map(v=>v.trim()).filter(Boolean);
const common={slots,searchApiKey:process.env.IMAGE_SEARCH_API_KEY,searchBaseUrl:process.env.IMAGE_SEARCH_BASE_URL,searchModel:process.env.IMAGE_SEARCH_MODEL,visionApiKey:process.env.BIGMODEL_API_KEY,visionBaseUrl:process.env.BIGMODEL_BASE_URL,visionModel:process.env.BIGMODEL_MODEL,sourcePagesPerSlot:4,downloadsPerSlot:6,visionCandidatesPerSlot:4,concurrency:{slots:4,search:4,pages:3,downloads:3,vision:3},trustedKnowledgeOrigins:csv(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS)};

async function execute(label, runner, searchFn, current=false){
  const root=path.join(runDir,label,'runtime'); await fsp.mkdir(root,{recursive:true});
  const queries=[]; const started=Date.now();
  const result=await runner({...common,root,...(current?{sourceMode:'knowledge_first',knowledgeBaseUrl:'http://knowledge-empty.test',adapters:{searchKnowledgeImages:async({queries:q,scopeNodeIds})=>({status:'completed',scopeState:'no_match',message:'A/B simulated normal empty result',queryId:`ab-empty-${queries.length}`,queryText:q[0],records:[],candidates:[],durationMs:0,scopeNodeIds}),searchWebBatch:async args=>{queries.push(...args.queries);return searchFn(args);}}}:{adapters:{searchWebBatch:async args=>{queries.push(...args.queries);return searchFn(args);}}})});
  result.ab={label,wallClockMs:Date.now()-started,actualWebQueries:queries,knowledgeSimulation:current?{status:'completed',scopeState:'no_match',candidates:0}: {status:'completed',scopeState:'no_match',candidates:0,note:'simulated before invoking legacy Web-only runner'}};
  await fsp.writeFile(path.join(runDir,label,'result.json'),JSON.stringify(result,null,2));
  return {root,result};
}

const A=await execute('A-legacy-web',oldSkill,oldSearch,false);
const B=await execute('B-current-web',runCurrent,currentSearch,true);

function reportSlot(result,slot){
  const r=result.results.find(x=>x.slotId===slot.slotId)||{}; const e=r.pipelineEvidence||{}; const w=e.webExecution||{};
  return {slotId:slot.slotId,moduleType:slot.moduleType,plannerSubject:slot.primaryVisualSubject||slot.subject,searchIntent:slot.searchIntent,knowledgeStatus:result.ab.knowledgeSimulation,fallbackReason:w.fallbackReason||'knowledge_normal_empty_to_web',actualWebQueries:w.executedQueries||result.ab.actualWebQueries,sourcePages:e.searchPageUrls||[],extractedCandidates:e.extractedCandidates||0,downloadAttempts:e.downloadAttempts||0,visionBatches:w.auditBatches?.length||null,visionCount:w.queryReports?.reduce((n,q)=>n+(q.visionAudits||0),0)||null,status:r.status,selected:r.selected||null,notSelectedReasons:(r.candidates||[]).filter(c=>!c.selected).map(c=>c.rejection||c.autoReviewStatus||c.candidateStatus),technicalStatus:r.technicalStatus||null};
}

async function materialize(label,execution,root){
  const sixBindings=Object.fromEntries(wanted.map(id=>[id,plan.slotBindings[id]]));
  const writeback=applySimpleSkillResults({preparedData:plan.preparedData,copyTasks:plan.copyTasks,copyExecution:baselineRun.copyExecution,imageSlots:slots,slotBindings:sixBindings,imageExecution:execution});
  for(const slot of slots){const binding=sixBindings[slot.slotId], image=getSlotImage(writeback.data,binding), selected=execution.results.find(r=>r.slotId===slot.slotId)?.selected;if(!image?.src||!selected?.localUrl)continue;const disk=path.join(root,'public',selected.localUrl.replace(/^\//,''));if(!fs.existsSync(disk))continue;const ext=path.extname(disk).slice(1)||'jpeg';const uri=`data:image/${ext==='jpg'?'jpeg':ext};base64,${fs.readFileSync(disk).toString('base64')}`;setSlotImage(writeback.data,binding,{...image,src:uri});}
  const dataFile=path.join(runDir,label,'render-data.json'); const png=path.join(runDir,label,'itinerary-2000.png'); const qa=path.join(runDir,label,'layout-qa.json');
  await fsp.writeFile(dataFile,JSON.stringify(writeback.data));
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(appRoot,'renderer/render.mjs'),'--width=2000','--dataset=workspace',`--data-file=${dataFile}`,`--output=${png}`,`--qa-output=${qa}`,'--origin=http://127.0.0.1:4174'],{cwd:appRoot,windowsHide:true,stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(err.slice(-2000))));});
  const rows=slots.map(slot=>reportSlot(execution,slot));
  const html=`<!doctype html><meta charset="utf-8"><title>${label}</title><style>body{font:16px sans-serif;max-width:1500px;margin:auto;background:#f6f3ed}h1{padding:20px}.g{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}.c{background:white;padding:16px;border-radius:12px}img{width:100%;height:320px;object-fit:cover;background:#ddd}pre{white-space:pre-wrap;font-size:13px}</style><h1>${label}</h1><div class=g>${rows.map((row,i)=>{const selected=execution.results.find(r=>r.slotId===row.slotId)?.selected;const disk=selected?.localUrl?path.join(root,'public',selected.localUrl.replace(/^\//,'')):'';const src=disk&&fs.existsSync(disk)?path.relative(path.join(runDir,label),disk).replaceAll('\\','/') : '';return `<div class=c><h2>${row.slotId}</h2>${src?`<img src="${src}">`:'<div>未采用</div>'}<pre>${escapeHtml(JSON.stringify(row,null,2))}</pre></div>`}).join('')}</div>`;
  await fsp.writeFile(path.join(runDir,label,'preview.html'),html);
  return {rows,png,preview:path.join(runDir,label,'preview.html'),writeback:{unresolved:writeback.unresolvedItems.length}};
}
function escapeHtml(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
const reportA=await materialize('A-legacy-web',A.result,A.root); const reportB=await materialize('B-current-web',B.result,B.root);
const report={runDir,baseline:{projectId,planId,slots:wanted},A:{wallClockMs:A.result.ab.wallClockMs,...reportA},B:{wallClockMs:B.result.ab.wallClockMs,...reportB}};
await fsp.writeFile(path.join(runDir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({finished:true,runDir,A:{time:A.result.ab.wallClockMs,png:reportA.png},B:{time:B.result.ab.wallClockMs,png:reportB.png}}));
