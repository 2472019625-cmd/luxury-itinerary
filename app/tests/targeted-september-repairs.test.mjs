import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {importItineraryWorkbook} from '../src/lib/itineraryImport.js';
import {normalizeItineraryFacts,validateItineraryFacts} from '../src/lib/itineraryRules.js';
import {buildConfirmationActionItems,matchingPriceOffers} from '../src/lib/confirmationActionItems.js';
import {createKnowledgeScopeResolver,buildKnowledgeHierarchy} from '../server/knowledge-scope-resolver.mjs';
import {repairHotelRepresentativeChoice,repairTransportOverviewPose} from '../server/agent-trip-planner.mjs';
import {knowledgeEntityProbeEvidence} from '../server/knowledge-scope-resolver.mjs';
import {independentVisualRejection} from '../server/image-audit-contract.mjs';

test('split property paths require a matching adjacent region and image filename',()=>{
 const slot={moduleType:'hotel',hotel:'Ngorongoro Serena Safari Lodge',exactIdentityRequired:true,queryCore:{identity:'Ngorongoro Serena Safari Lodge'}};
 const candidate={knowledgeMatchedFile:{filename:'photo.jpg'},knowledgeSourcePaths:['Data/坦桑尼亚/恩戈罗恩戈罗/Serena/photo.jpg']};
 assert.equal(knowledgeEntityProbeEvidence(slot,candidate).match,true);
 for(const paths of [['Data/肯尼亚/内罗毕/Serena/photo.jpg'],['Data/坦桑尼亚/恩戈罗恩戈罗/Other/photo.jpg'],
   ['Data/坦桑尼亚/恩戈罗恩戈罗/Serena/another.jpg'],['Data/Serena/photo.jpg'],
   [candidate.knowledgeSourcePaths[0],'Data/肯尼亚/内罗毕/Serena/photo.jpg']]) {
   assert.notEqual(knowledgeEntityProbeEvidence(slot,{...candidate,knowledgeSourcePaths:paths}).match,true);
 }
});

test('explicit watermarks remain terminal rejection despite unrelated contradictory fields',()=>{
 assert.equal(independentVisualRejection({actualSubject:'帐篷与水印',watermarkFree:false,coreActionMatch:false,eligible:true}),'watermark');
 assert.equal(independentVisualRejection(null),null);
 assert.equal(independentVisualRejection({actualSubject:'帐篷',watermarkFree:true,coreActionMatch:false,eligible:true}),null);
});

test('generated DAY prefix is recognized without accepting another experience',()=>{
 const d=normalizeItineraryFacts({days:[{spots:[{name:'机场送机',status:'pending'}]}]});
 assert.ok(d.pendingConfirmations.some(x=>x.includes('DAY 1')));
 assert.ok(!validateItineraryFacts(d).issues.some(x=>x.code==='pending_not_synchronized'));
 d.pendingConfirmations=['DAY 1 酒店接机：待确认'];
 assert.ok(validateItineraryFacts(d).issues.some(x=>x.code==='pending_not_synchronized'));
});

test('adult/child table retains prices and group total without choosing a child starting price',async()=>{
 const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet([
 ['坦桑尼亚8天'],['日期','简要行程','详细','用餐','参考酒店','用车'],['DAY 1','阿鲁沙','送机','早餐','飞机','商务用车'],
 ['成人68800元/人，儿童39800元/人；三人合计177,400元。'],
 ['人数','价格（元/人）','有效期'],['2成人',68800,'2027.07.05'],['1儿童',39800,'2027.07.05']]),'行程');
 const {data}=await importItineraryWorkbook(new File([XLSX.write(w,{type:'array',bookType:'xlsx'})],'test.xlsx'),{days:[],highlights:[]});
 assert.equal(data.totalPrice,null);assert.equal(data.sourceImportCoverage.sourceGroupTotal,177400);
 assert.deepEqual(data.sourceImportCoverage.priceOffers.map(x=>[x.audience,x.sourceCount,x.amount]),[['adult',2,68800],['child',1,39800]]);
 assert.deepEqual(matchingPriceOffers('2027-07-05',data.sourceImportCoverage.priceOffers),[]);
 const project={data,confirmationSelections:{priceOffer:{mode:'source',amount:39800,unit:'元/人'}}};
 assert.ok(buildConfirmationActionItems({project}).some(x=>x.id==='source:groupPrice'));
 project.confirmationSelections.priceOffer={mode:'custom',amount:100000,unit:'元/团'};
 assert.ok(!buildConfirmationActionItems({project}).some(x=>x.id==='source:groupPrice'));
});

test('cache write failure cannot poison scope resolution; parallel resolvers preserve both mappings',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mapping-repair-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const index=buildKnowledgeHierarchy([{node_id:'r',formal_name:'根知识库'},{node_id:'k',formal_name:'Kenya',parent_node_id:'r'},
 {node_id:'a',formal_name:'Alpha Hotel',parent_node_id:'k'},{node_id:'b',formal_name:'Beta Hotel',parent_node_id:'k'}]);
 const make=()=>createKnowledgeScopeResolver({root,hierarchyLoader:async()=>index});
 const slot=name=>({moduleType:'hotel',hotel:name,location:'Kenya',queryCore:{identity:name},exactIdentityRequired:true});
 const file=path.join(root,'output','knowledge-node-mappings.json');await mkdir(file,{recursive:true});
 const first=make();assert.equal((await first.resolve(slot('Alpha Hotel'))).status,'resolved');
 assert.ok(first.hierarchyStats().cacheWriteFailure);
 await rm(file,{recursive:true});
 const second=make();await Promise.all([first.resolve(slot('Alpha Hotel')),second.resolve(slot('Beta Hotel'))]);
 const values=Object.values(JSON.parse(await readFile(file,'utf8'))).map(x=>x.nodeId).sort();assert.deepEqual(values,['a','b']);
});

test('canonical hotel representative details recover without changing identity or guaranteed rooms',()=>{
 for(const detail of ['天际甲板或帐篷套房与草原景观','面向肯尼亚山与保护区的营地外观或泳池区','Westlands 城市酒店大堂或客房城市景观']){
 const hotel={name:'Sample Lodge'};const slot={role:'hotel:1',exactIdentityRequired:true,primaryVisualSubject:`Sample Lodge 代表性空间，${detail}`,queryCore:{subject:'酒店代表性空间',subjectEn:'representative hotel space',identity:hotel.name,identityEn:hotel.name}};
 assert.equal(repairHotelRepresentativeChoice(slot,{hotels:[hotel]}).queryCore.identity,hotel.name);
 assert.equal(repairHotelRepresentativeChoice(slot,{hotels:[{...hotel,roomType:'指定套房'}]}),null);
 for (const forbidden of ['Other Lodge 外观或大堂','私人泳池或套房','酒店泳池游泳或大堂用餐']) {
   assert.equal(repairHotelRepresentativeChoice({...slot,primaryVisualSubject:`Sample Lodge 代表性空间，${forbidden}`},{hotels:[hotel]}),null);
 }
 }
});

test('business vehicle overview drops only parking/driving pose and preserves guaranteed-model protection',()=>{
 const slot={role:'transport:1',exactIdentityRequired:false,locationRole:'scope_only',primaryVisualSubject:'内罗毕城市道路上的商务用车，车辆停靠或行驶于市区',queryCore:{subject:'商务用车',subjectEn:'business vehicle',action:'在城市道路行驶',actionEn:'driving on city road',identity:''}};
 const transport={category:'商务用车',usageSegments:['DAY 1 送机']};
 assert.equal(repairTransportOverviewPose(slot,{transport:[transport]}).queryCore.action,'');
 assert.equal(repairTransportOverviewPose(slot,{transport:[{...transport,modelGuaranteed:true}]}),null);
});
