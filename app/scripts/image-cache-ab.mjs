import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { searchWebBatch } from '../server/image-search.mjs';
import { searchCommonsImages } from '../server/commons-search.mjs';
import { judgeCandidatesBatch } from '../server/image-audit.mjs';

const root=process.cwd();
const runId='7e69635a-ed03-43a8-b26f-ec9d24f4cc4c';
const project=path.join(root,'output/simple-pipeline/projects/c8ff1cf7-a6a5-4128-b726-8ed3d65f8d97');
const out=path.resolve('../audit/evidence/image-cache-ab',runId);
await fs.mkdir(out,{recursive:true});
const plan=JSON.parse(await fs.readFile(path.join(project,'plans/d8679a14-74ca-4f15-ac35-27b1565fcf96.json'),'utf8'));
const slots=plan.imageSlots;
assert.equal(slots.length,28);
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
await fs.writeFile(path.join(out,'slots.json'),JSON.stringify(slots,null,2));
// Match the running server's environment loading, without printing credentials.
for(const name of ['.env.local','.env.image-search.local']){
  const raw=await fs.readFile(path.join(root,name),'utf8').catch(()=> '');
  for(const line of raw.split(/\r?\n/)){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].trim();}
}
const options={searchApiKey:process.env.IMAGE_SEARCH_API_KEY,searchBaseUrl:process.env.IMAGE_SEARCH_BASE_URL,searchModel:process.env.IMAGE_SEARCH_MODEL,visionApiKey:process.env.BIGMODEL_API_KEY,visionBaseUrl:process.env.BIGMODEL_BASE_URL,visionModel:process.env.BIGMODEL_MODEL};
assert.ok(Object.values(options).every(Boolean),'Existing runtime configuration incomplete; stop without guessing');
const filename=path.join(root,'server/simple-image-skill.mjs');
const original=await fs.readFile(filename,'utf8');
assert.equal(original.split('const previous = cache.get(url);').length,2);
const load=async enabled=>{
  let source=enabled?original:original.replace('const previous = cache.get(url);','const previous = undefined; // A: no resource reuse');
  source=source.replace(/from "(\.\/[^\"]+)"/g,(_,relative)=>`from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(filename),relative)).href)}`);
  source=source.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(filename).href));
  return (await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).runImageSearchSkill;
};
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({runId,slotCount:slots.length,slotSha256:digest(slots),codeSha256:digest(original),change:'A bypasses cache lookup only; B original source',mode:'sequential live A then B; external responses recorded; no Planner/Copy/Writeback/Renderer'},null,2));
for(const label of ['A','B']){
  const target=path.join(out,label);
  await fs.mkdir(target,{recursive:true});
  const trace=[];
  const wrap=(kind,fn,key)=>async (...argsList)=>{
    const args=argsList[0];
    const record={kind,input:key(args),startedAt:Date.now()};trace.push(record);
    try{const result=await fn(...argsList);record.result=result;return result;}
    catch(e){record.error=String(e.message);throw e;}
    finally{record.durationMs=Date.now()-record.startedAt;}
  };
  const execute=await load(label==='B');
  console.log(JSON.stringify({label,phase:'started',at:new Date().toISOString(),slots:slots.length}));
  const result=await execute({...options,root:target,slots:structuredClone(slots),adapters:{
    searchWebBatch:wrap('search',searchWebBatch,a=>({queries:a.queries})),
    searchCommonsImages:wrap('commons',searchCommonsImages,a=>a),
    judgeCandidatesBatch:wrap('vision',judgeCandidatesBatch,a=>({slot:a.slot,candidates:a.candidates.map(c=>({candidateId:c.candidateId,imageUrl:c.imageUrl,sha256:c.sha256,title:c.title,alt:c.alt,officialHint:c.officialHint}))})),
  },onCapabilityCall:e=>{if(e.phase==='slot_progress')console.log(JSON.stringify({label,completed:e.completedSlots,total:e.totalSlots}));}});
  assert.equal(digest(slots),digest(plan.imageSlots));
  await fs.writeFile(path.join(target,'result.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(target,'trace.json'),JSON.stringify(trace,null,2));
  console.log(JSON.stringify({label,phase:'finished',durationMs:result.metrics.durationMs,found:result.results.filter(s=>s.selected).length}));
}
const A=JSON.parse(await fs.readFile(path.join(out,'A/result.json'),'utf8'));
const B=JSON.parse(await fs.readFile(path.join(out,'B/result.json'),'utf8'));
const describe=s=>({status:s.status,durationMs:s.durationMs,selected:s.selected?.imageUrl||null,queries:s.queriesUsed,hardRejectReasons:s.candidates.map(c=>({url:c.imageUrl,reason:c.hardRejectCode||c.judgment?.hardRejectCode||null})),evidence:s.pipelineEvidence});
const rows=A.results.map((a,i)=>{const b=B.results[i];assert.equal(a.slotId,b.slotId);assert.deepEqual(a.queriesUsed,b.queriesUsed);return {slotId:a.slotId,sameSelected:(a.selected?.imageUrl||null)===(b.selected?.imageUrl||null),sameStatus:a.status===b.status,A:describe(a),B:describe(b)};});
await fs.writeFile(path.join(out,'comparison.json'),JSON.stringify({A:A.metrics,B:B.metrics,rows},null,2));
console.log(JSON.stringify({phase:'complete',sameSelected:rows.filter(r=>r.sameSelected).length,total:rows.length}));
