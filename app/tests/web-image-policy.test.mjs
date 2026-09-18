import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { explicitEntityRoute } from '../server/knowledge-scope-resolver.mjs';
import { buildWebExecutionQueries } from '../server/image-web-execution.mjs';
import { prepareWebCandidates } from '../server/web-image-candidates.mjs';
import { extractImageCandidatesFromHtml } from '../server/page-images.mjs';
import { runImageSearchSkill } from '../server/simple-image-skill.mjs';

const ordinary = (subject, subjectEn, action, actionEn, location) => ({moduleType:'day',subject,primaryVisualSubject:subject,location,locationRole:'visual_identity',destination:'Kenya',queryCore:{subject,subjectEn,action,actionEn,identity:location}});
test('地点身份不能把渡河、湿地、送机、夜游变成实体主体',()=>{
  for(const s of [ordinary('角马群','wildebeest herd','横渡河流','crossing the river','马拉河'),ordinary('湿地','wetlands','俯瞰','aerial view','Observation Hill'),ordinary('送机车辆','drop-off vehicle','停靠航站楼','parked at the terminal','乔莫·肯雅塔国际机场'),ordinary('鬣狗','hyena','夜间游猎','night safari','安博塞利')]) assert.equal(explicitEntityRoute(s).matched,false,JSON.stringify(s));
  assert.equal(explicitEntityRoute({moduleType:'dining',subject:'The Carnivore 餐厅烤肉',queryCore:{subject:'烤肉',identity:'The Carnivore'},exactIdentityRequired:true,entityName:'The Carnivore'}).matched,true);
  assert.equal(explicitEntityRoute({moduleType:'day',subject:'Karen Blixen Museum 建筑',queryCore:{identity:'Karen Blixen Museum'},exactIdentityRequired:true}).matched,true);
  assert.equal(explicitEntityRoute({moduleType:'day',subject:'Karen Blixen Museum 建筑'}).matched,false,'不能从名称猜Core');
  assert.equal(explicitEntityRoute({...ordinary('Blue Observatory','observatory','','','Blue Observatory'),exactIdentityRequired:true}).matched,true);
});
test('英文首先使用核心主体动作，车辆不被机场替代',()=>{
  const s=ordinary('送机车辆','drop-off vehicle','停靠航站楼','parked at the terminal','乔莫·肯雅塔国际机场');
  const q=buildWebExecutionQueries(s,['机场航站楼送机','Jomo Kenyatta Airport terminal drop-off']);
  assert.equal(q[0],'Nairobi drop-off vehicle parked at the terminal');
  assert.equal(q[1],'Nairobi 送机车辆 停靠航站楼');
});
test('任意名字由Core语义决定，地点角色和实体类型标签不决定路由',()=>{
  for(const entityName of ['Arbitrary Target','餐厅','博物馆','机场','村庄']) {
    const s={moduleType:'day',entityName,location:entityName,locationRole:'visual_identity',queryCore:{identity:entityName}};
    assert.equal(explicitEntityRoute(s).matched,false);
    assert.equal(explicitEntityRoute({...s,entityType:'restaurant'}).matched,false);
    assert.equal(explicitEntityRoute({...s,exactIdentityRequired:true}).matched,true);
    assert.equal(explicitEntityRoute({...s,exactIdentityRequired:false,minimumVisualProof:{identityIsCore:true}}).matched,false);
  }
});
test('垃圾与resize归并不扩大审核调用；正文优先且不误杀真实顶部照片',()=>{
  const c=(url,attrs={})=>({imageUrl:'https://example.com/'+url,...attrs});
  const r=prepareWebCandidates(['logo.png','placeholder.jpg','404.png','patterns/pattern1.png','icons/whatsapp.png','badge.png'].map(x=>c(x)).concat([c('photo-600x400.jpg'),c('photo-1536x1024.jpg'),c('photo.jpg',{pagePosition:'content'}),c('hotel-building.jpg',{pagePosition:'chrome'})]));
  assert.equal(r.before,10);assert.equal(r.after,2);assert.equal(r.filtered.length,8);assert.equal(r.candidates[0].imageUrl,'https://example.com/photo.jpg');
  const html='<header><img src="header-photo.jpg" /></header><main><img class="brand-pattern" src="resource.jpg" /><img src="gallery.jpg" /></main>';
  const extracted=extractImageCandidatesFromHtml(html,{pageUrl:'https://example.com/page'});
  const processed=prepareWebCandidates(extracted);assert.equal(processed.candidates.length,2);assert.equal(processed.candidates[0].pagePosition,'content');assert.equal(processed.filtered.length,1);
});
test('Image-only:英文成功后不执行中文，过滤候选不占下载/审核预算',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'web-policy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const queries=[],downloads=[],audits=[];
  const s={...ordinary('角马群','wildebeest herd','渡河','river crossing','马拉河'),slotId:'image:day:4:primary',required:true,visualGoal:'展示角马渡河',visualContext:{destination:'Kenya'},copyTargetId:'copy:day:4',aspectRatio:'16:9',userLocked:false,searchIntent:['角马渡河','wildebeest river crossing'],fidelityQuery:'角马渡河',alternateQueries:['wildebeest river crossing']};
  const result=await runImageSearchSkill({root,slots:[s],sourceMode:'web_only',searchApiKey:'fixture',searchModel:'fixture',visionApiKey:'fixture',visionBaseUrl:'https://vision.invalid',visionModel:'fixture',sourcePagesPerSlot:2,downloadsPerSlot:6,adapters:{
    searchWebBatch:async({queries:q})=>{queries.push(...q);return [{pageUrl:'https://example.com/gallery'}];},searchCommonsImages:async()=>[],
    extractPageImages:async(page)=>['logo.png','placeholder.jpg','404.png','patterns/pattern1.png','photo-600x400.jpg','photo.jpg'].map(x=>({...page,imageUrl:'https://example.com/'+x,alt:'wildebeest herd river crossing'})),
    downloadCandidate:async(c,{directory,publicPrefix})=>{downloads.push(c.imageUrl);const filePath=path.join(directory,'photo.jpg');await sharp({create:{width:1400,height:900,channels:3,background:'#347859'}}).jpeg().toFile(filePath);return {filePath,publicUrl:publicPrefix+'/photo.jpg',sha256:'fixture-photo',width:1400,height:900};},
    judgeCandidatesBatch:async({candidates})=>{audits.push(candidates.length);return candidates.map(c=>({candidateId:c.candidateId,actualSubject:'角马渡河',reason:'fixture完整审核',matchLevel:'exact',locationMatch:true,visibleLocationConflict:false,hotelIdentityMatch:true,visibleIdentityConflict:false,activityMatch:true,coreActionMatch:true,subjectMatch:true,coreSubjectMatch:true,identityMatch:true,subjectClear:true,subjectLargeEnough:true,subjectPrimary:true,transportType:'none',transportTypeMatch:true,watermarkFree:true,nonAI:true,photographic:true,technicalUsable:true,eligible:true,hardRejectCode:'none',relevance:95,luxury:95,cleanliness:95,composition:95,score:95}));}
  }});
  assert.equal(result.results[0].status,'success',JSON.stringify(result.results[0]));assert.equal(queries.length,1);assert.match(queries[0],/wildebeest herd river crossing/);assert.doesNotMatch(queries[0],/[\u4e00-\u9fff]/);assert.equal(downloads.length,1);assert.deepEqual(audits,[1]);assert.equal(result.results[0].pipelineEvidence.webCandidateFiltering.before,6);assert.equal(result.results[0].pipelineEvidence.webCandidateFiltering.after,1);
});
