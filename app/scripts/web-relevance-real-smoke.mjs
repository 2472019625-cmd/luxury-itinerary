import fs from 'node:fs';
import path from 'node:path';
import {runImageSearchSkill} from '../server/simple-image-skill.mjs';
const configRoot=process.argv[2];
for(const file of ['.env.local','.env.image-search.local','.env.knowledge.local']) {
  const p=path.join(configRoot,file);if(!fs.existsSync(p))continue;
  for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
}
const previous=JSON.parse(fs.readFileSync('output/full-pipeline-real-runs/2026-09-18T09-24-52-450Z/result.json'));
const plan=JSON.parse(fs.readFileSync(`output/simple-pipeline/projects/${previous.projectId}/plans/${previous.plannerResult.planId}.json`));
const ids=['image:day:5:primary','image:day:2:primary','image:day:4:primary','image:day:3:supporting:2','image:dining:imported-dining-restaurant-the-carnivore-day-7:primary','image:hotel:imported-hotel-1:primary'];
const slots=ids.map(id=>plan.imageSlots.find(s=>s.slotId===id));if(slots.some(s=>!s))throw Error('Missing saved real slot');
const directory=path.resolve('output/web-relevance-smoke',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'input-slots.json'),JSON.stringify(slots,null,2));
const events=[];const started=Date.now();console.log(JSON.stringify({directory,started:true,slots:ids}));
try {
  const result=await runImageSearchSkill({root:process.cwd(),slots,sourceMode:'web_only',searchApiKey:process.env.IMAGE_SEARCH_API_KEY,searchBaseUrl:process.env.IMAGE_SEARCH_BASE_URL,searchModel:process.env.IMAGE_SEARCH_MODEL,visionApiKey:process.env.BIGMODEL_API_KEY,visionBaseUrl:process.env.BIGMODEL_BASE_URL,visionModel:process.env.BIGMODEL_MODEL,concurrency:{slots:4,search:4,pages:3,downloads:3,vision:3},onCapabilityCall:event=>{events.push(event);fs.writeFileSync(path.join(directory,'events.json'),JSON.stringify(events,null,2));if(event.phase==='slot_progress')console.log(JSON.stringify(event));}});
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));
  const report={wallClockMs:Date.now()-started,slots:result.results.map(r=>({slotId:r.slotId,status:r.status,execution:r.pipelineEvidence?.webExecution,filtering:r.pipelineEvidence?.webCandidateFiltering,selected:r.selected,baseline:previous.imageExecution.results.find(x=>x.slotId===r.slotId)?.pipelineEvidence?.webExecution})),metrics:result.metrics};
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({finished:true,directory,wallClockMs:report.wallClockMs,statuses:result.results.map(r=>({slotId:r.slotId,status:r.status}))}));
}catch(error){fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({message:error.message,wallClockMs:Date.now()-started}));throw error;}
