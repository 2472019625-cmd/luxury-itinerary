import test from 'node:test';
import assert from 'node:assert/strict';
import {materializeSimpleSkillPlan} from '../server/simple-plan-adapter.mjs';
import {generateAgentPlan,buildAgentFactBasis,validateSimpleDayVisuals} from '../server/agent-trip-planner.mjs';
import {explicitEntityRoute,buildKnowledgeQueryPlan,buildKnowledgeScopePlan,buildKnowledgeHierarchy,resolveKnowledgeScope} from '../server/knowledge-scope-resolver.mjs';
import {buildWebExecutionQueries} from '../server/image-web-execution.mjs';
import {plannerRequestJson} from './helpers/simple-pipeline-fixture.mjs';
import {runImageSearchSkill} from '../server/simple-image-skill.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const examples=[
 ['The Carnivore',true,'炭火烤肉拼盘','charcoal grilled meat platter','The Carnivore'],
 ['Karen Blixen Museum',true,'故居建筑','historic museum house','Karen Blixen Museum'],
 ['Giraffe Centre建筑',true,'中心建筑','centre building','Giraffe Centre'],
 ['Giraffe Centre喂长颈鹿',false,'喂长颈鹿','feeding giraffes','Giraffe Centre'],
 ['角马渡河',false,'角马渡河','wildebeest river crossing','Mara River'],
 ['湿地俯瞰',false,'俯瞰湿地','wetland overlook','Observation Hill'],
 ['新月岛徒步',false,'向导带游客徒步','guided walking safari','Crescent Island'],
 ['地狱门骑行',false,'游客骑行','cyclists riding','Hell\'s Gate'],
 ['马赛串珠课程',false,'游客制作串珠','guests making beads','Maasai village'],
 ['机场送机',false,'送机车辆','airport drop-off vehicle','Jomo Kenyatta International Airport'],
 ['普通动物图',false,'象群','elephant herd','Amboseli'],
 ['酒店图',true,'酒店建筑','hotel exterior','Angama Amboseli'],
];
test('真实样例的路由只由布尔值与明确identity决定，不由名称决定',()=>{
 for(const [label,exact,subject,subjectEn,identity] of examples){
  const s={moduleType:label==='酒店图'?'hotel':'day',hotel:label==='酒店图'?identity:'',location:identity,locationRole:'visual_identity',exactIdentityRequired:exact,queryCore:{subject,subjectEn,identity,identityEn:identity},searchIntent:[subject,subjectEn]};
  assert.equal(explicitEntityRoute(s).matched,exact,label);
  assert.equal(explicitEntityRoute({...s,exactIdentityRequired:!exact}).matched,!exact,label+'反转值');
  assert.equal(explicitEntityRoute({...s,queryCore:{...s.queryCore,identity:''}}).matched,false,label+'空identity');
  const q=buildWebExecutionQueries(s,s.searchIntent,'',explicitEntityRoute(s));
  assert.doesNotMatch(q[0],/[\u4e00-\u9fff]/,label);
  if(exact)assert.ok(q.every(x=>x.includes(identity)),label);
  else assert.ok(q[0].includes(subjectEn),label);
  const a=buildKnowledgeQueryPlan(s,null),b=buildKnowledgeQueryPlan({...s,exactIdentityRequired:!exact},null);
  assert.deepEqual(a.queries,b.queries,label+'Knowledge词与顺序不变');
 }
 assert.equal(explicitEntityRoute({moduleType:'hotel',hotel:'Angama Amboseli',queryCore:{identity:'Angama Amboseli'},exactIdentityRequired:false}).matched,false);
 assert.equal(explicitEntityRoute({queryCore:{identity:'Target'},exactIdentityRequired:'true'}).matched,false);
});
test('普通体验仍先准备Knowledge逐级Scope，布尔值false不会触发实体目录门禁',()=>{
 const h=buildKnowledgeHierarchy([{node_id:'root',formal_name:'根知识库'},{node_id:'kenya',formal_name:'肯尼亚',parent_node_id:'root'},{node_id:'mara',formal_name:'马赛马拉',parent_node_id:'kenya'}]);
 for(const [,exact,subject,subjectEn,identity] of examples.filter(x=>!x[1])){
  const s={moduleType:'day',location:'马赛马拉',country:'肯尼亚',exactIdentityRequired:exact,queryCore:{subject,subjectEn,identity},fidelityQuery:subject,alternateQueries:[subjectEn]};
  const scope=buildKnowledgeScopePlan(s,resolveKnowledgeScope(s,h),h);assert.equal(scope.explicitEntityFastPath.matched,false);assert.ok(scope.scopes.length>0);
 }
});
test('受控Image调用顺序：普通体验携带具体地点仍先Knowledge，false不触发实体快速失败',async(t)=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'identity-knowledge-first-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const records=[{node_id:'root',formal_name:'根知识库'},{node_id:'kenya',formal_name:'肯尼亚',parent_node_id:'root'},{node_id:'mara',formal_name:'马赛马拉',parent_node_id:'kenya'},{node_id:'nairobi',formal_name:'内罗毕',parent_node_id:'kenya'}];
 for(const label of ['角马渡河','湿地俯瞰','新月岛徒步','地狱门骑行','马赛串珠课程','机场送机']){
  const [,exact,subject,subjectEn,identity]=examples.find(x=>x[0]===label),calls=[];
  const slot={slotId:'fixture-'+label,moduleType:'day',location:label==='机场送机'?'内罗毕':'马赛马拉',country:'Kenya',locationRole:'visual_identity',exactIdentityRequired:exact,queryCore:{subject,subjectEn,identity},subject,required:true,userLocked:false,visualGoal:subject,visualContext:{},copyTargetId:'copy-fixture',aspectRatio:'16:9',fidelityQuery:subject,alternateQueries:[subjectEn]};
  const out=await runImageSearchSkill({root,sourceMode:'knowledge_first',knowledgeBaseUrl:'http://knowledge.invalid',slots:[slot],adapters:{loadKnowledgeHierarchy:async()=>buildKnowledgeHierarchy(records),searchKnowledgeImages:async({queries})=>{calls.push('Knowledge');return {status:'completed',scopeState:'empty',queryText:queries[0],candidates:[],records:[]};},searchWebBatch:async()=>{calls.push('Web');return [];},searchCommonsImages:async()=>[]}});
  assert.equal(calls[0],'Knowledge',label);assert.equal(out.results[0].pipelineEvidence.explicit_entity_fast_path,false,label);assert.equal(out.results[0].pipelineEvidence.knowledgeSearch.knowledgeQueryExecuted,true,label);
 }
});
test('Adapter原值透传布尔值，不把酒店false或字符串true修成true',()=>{
 const data={destination:'Kenya',days:[{spots:[]}],hotels:[],diningExperiences:[],transportSummary:[]};
 const image={role:'day:1',primaryVisualSubject:'车辆送机',location:'Nairobi',locationRole:'visual_identity',queryCore:{subject:'车辆',identity:'Airport'},fidelityQuery:'车辆送机',alternateQueries:['vehicle drop-off'],sourceRefs:['days[0]']};
 const getPlan=value=>materializeSimpleSkillPlan({data,agentPlan:{selectedHighlights:[],modules:[],dayRoles:[],imagePlan:{slots:[{...image,exactIdentityRequired:value}]}}});
 const get=value=>getPlan(value).imageSlots.find(s=>s.slotId==='image:day:1:primary');
 assert.deepEqual(getPlan(true).copyTasks,getPlan(false).copyTasks,'布尔值不改变Copy输入');
 const before=get(false),after=get(true);delete before.exactIdentityRequired;delete after.exactIdentityRequired;assert.deepEqual(before,after,'除布尔字段外画面/词序/来源/位置不改变');
 for(const v of [true,false]){const s=get(v);assert.equal(s.exactIdentityRequired,v);assert.equal(s.needsUserAction,false);assert.deepEqual(s.sourceEvidence,['days[0]']);assert.equal(s.fidelityQuery,image.fidelityQuery);}
 const invalid=get('true');assert.equal(invalid.exactIdentityRequired,'true');assert.equal(invalid.needsUserAction,true);
 const hotelData={...data,hotels:[{id:'angama',officialName:'Angama Amboseli'}]};
 const hotel=materializeSimpleSkillPlan({data:hotelData,agentPlan:{selectedHighlights:[],modules:[],dayRoles:[],imagePlan:{slots:[{...image,role:'hotel:1',sourceRefs:['hotels[0]'],queryCore:{subject:'酒店建筑',identity:'Angama Amboseli'},exactIdentityRequired:false}]}}}).imageSlots.find(s=>s.moduleType==='hotel');
 assert.equal(hotel.exactIdentityRequired,false);assert.equal(hotel.needsUserAction,false);assert.equal(explicitEntityRoute(hotel).matched,false);
});
test('原有Planner请求收窄布尔字段含义，不新增模型调用；缺字段不猜值',async()=>{
 let calls=0;const factBasis=buildAgentFactBasis({destination:'Kenya',days:[{description:'草原飞机抵达'}]});
 await generateAgentPlan({project:{projectId:'identity-contract',inputFingerprint:'test',factBasis},simpleSkillContract:true,requestJson:async options=>{calls++;const p=options.messages[0].content;assert.match(p,/去掉这个具体身份以后/);assert.match(p,/不得靠固定关键词、实体类型或地点名称判断/);assert.match(p,/即使画面主体和动作都对，也会造成事实错误/);assert.match(p,/原始行程地点必须准确，不等于照片必须证明唯一地点身份/);assert.match(p,/主要展示的是主体\+动作时必须false/);assert.match(p,/identity非空、地点明确、locationRole=visual_identity也都不是true的依据/);return plannerRequestJson({delayMs:0})(options);}});
 assert.equal(calls,1);
 const issues=validateSimpleDayVisuals({imagePlan:{slots:[{role:'day:1',primaryVisualSubject:'车辆',location:'Nairobi',locationRole:'scope_only',queryCore:{subject:'车辆'},fidelityQuery:'车辆接送',alternateQueries:['vehicle transfer']}]}},factBasis);
 assert.ok(issues.some(x=>x.code==='image_exact_identity_invalid'));
});
