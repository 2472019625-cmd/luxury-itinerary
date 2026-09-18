import fs from 'node:fs/promises';
import path from 'node:path';
import {importItineraryWorkbook} from '../src/lib/itineraryImport.js';
import {createProductionDefaultData} from '../src/lib/itineraryRules.js';
import {buildAgentFactBasis,fingerprintFacts,generateAgentPlan} from '../server/agent-trip-planner.mjs';
import {materializeSimpleSkillPlan} from '../server/simple-plan-adapter.mjs';
import {loadKnowledgeHierarchy,resolveKnowledgeScope,buildKnowledgeScopePlan,buildKnowledgeQueryPlan,explicitEntityRoute} from '../server/knowledge-scope-resolver.mjs';
const [input,configRoot]=process.argv.slice(2);
for(const file of ['.env.local','.env.knowledge.local']){
 const content=await fs.readFile(path.join(configRoot,file),'utf8').catch(()=> '');
 for(const line of content.split(/\r?\n/)){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
}
const directory=path.resolve('output/presearch-tanzania',new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(directory,{recursive:true});console.log(JSON.stringify({directory}));
const save=(name,value)=>fs.writeFile(path.join(directory,name),JSON.stringify(value,null,2));
const start=Date.now(),buf=await fs.readFile(input);
const imported=await importItineraryWorkbook({name:path.basename(input),arrayBuffer:async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)},createProductionDefaultData());
await save('parser.json',imported);const factBasis=buildAgentFactBasis(imported.data,imported.report);
console.log(JSON.stringify({hotels:imported.data.hotels.map(h=>({name:h.officialName,nights:h.nights})),transport:imported.data.transportSummary.map(t=>({category:t.category,service:t.serviceLevel}))}));
const plannerStart=Date.now();let attempts=0;
const planner=await generateAgentPlan({project:{projectId:'presearch-tanzania-'+Date.now(),inputFingerprint:fingerprintFacts(factBasis),factBasis,planIds:[]},simpleSkillContract:true,apiKey:process.env.TEXT_MODEL_API_KEY,baseUrl:process.env.TEXT_MODEL_BASE_URL,model:process.env.TEXT_MODEL_NAME,onModelAttempt:async a=>{attempts++;await save('model-attempt-'+attempts+'.json',a);},onStatus:e=>{if(!e.provider)console.log(JSON.stringify({status:e.status,message:e.message}));}});
await save('planner.json',planner);const plannerMs=Date.now()-plannerStart;
const runtime=materializeSimpleSkillPlan({data:imported.data,report:imported.report,agentPlan:planner.plan});await save('runtime.json',runtime);
let hierarchy=null,hierarchyError=null;try{hierarchy=await loadKnowledgeHierarchy({baseUrl:process.env.IMAGE_KNOWLEDGE_BASE_URL});await save('hierarchy.json',hierarchy);}catch(e){hierarchyError=e.message;}
const slots=runtime.imageSlots.map(s=>{const resolution=hierarchy?resolveKnowledgeScope(s,hierarchy):null;const scope=resolution?buildKnowledgeScopePlan(s,resolution,hierarchy):null;return {slotId:s.slotId,module:s.moduleType,visual:s.primaryVisualSubject||s.subject,why:s.visualDuty||s.visualGoal,identity:s.queryCore?.identity,exactIdentityRequired:s.exactIdentityRequired,needsUserAction:s.needsUserAction,sourceRefs:s.sourceEvidence,route:explicitEntityRoute(s),plannerQueries:[s.fidelityQuery,...(s.alternateQueries||[])].filter(Boolean),finalQueries:buildKnowledgeQueryPlan(s,resolution).queries,resolution,scope};});
await save('report.json',{input,plannerMs,totalMs:Date.now()-start,attempts,hierarchyError,guarantees:{knowledgeImageQueries:0,webSearches:0,downloads:0,vision:0,copy:0,renderer:0},slots});
console.log(JSON.stringify({finished:true,directory,plannerMs,attempts,slots:slots.map(s=>({slot:s.slotId,visual:s.visual,exact:s.exactIdentityRequired,identity:s.identity,fast:s.route.matched,needsUserAction:s.needsUserAction,scope:s.scope?.blockedReason}))}));
