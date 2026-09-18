import test from 'node:test';
import assert from 'node:assert/strict';
import { imageRelevanceDecision, prepareWebCandidates } from '../server/web-image-candidates.mjs';
import { extractImageCandidatesFromHtml } from '../server/page-images.mjs';
import { runImageSearchSkill } from '../server/simple-image-skill.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
const slot = {exactIdentityRequired:false,queryCore:{subjectEn:'wildebeest herd',actionEn:'river crossing'}};
test('page relevance cannot substitute for photo-local proof',()=>{
  const c={imageUrl:'https://example.com/pool.jpg',title:'wildebeest river crossing',summary:'wildebeest herd river crossing',semanticText:'wildebeest river crossing',semanticScore:100};
  assert.equal(imageRelevanceDecision(c,slot).state,'insufficient_evidence');
  assert.equal(imageRelevanceDecision({...c,alt:'wildebeest herd river crossing'},slot).pass,true);
  assert.equal(imageRelevanceDecision({...c,alt:'wildebeest herd grazing'},slot).state,'insufficient_evidence');
});
test('arbitrary exact identity needs local support, context identity does not',()=>{
  const s={queryCore:{subjectEn:'glass sculpture',identityEn:'Arbitrary Azure Pavilion'},exactIdentityRequired:true};
  const c={imageUrl:'https://example.com/123.jpg',alt:'glass sculpture',title:'Arbitrary Azure Pavilion'};
  assert.equal(imageRelevanceDecision(c,s).state,'insufficient_evidence');
  assert.equal(imageRelevanceDecision({...c,caption:'Glass sculpture in Arbitrary Azure Pavilion'},s).pass,true);
  assert.equal(imageRelevanceDecision(c,{...s,exactIdentityRequired:false}).pass,true);
});
test('figure caption and image-specific structured metadata rescue opaque filenames',()=>{
  const page={pageUrl:'https://example.com/page'};
  const c=extractImageCandidatesFromHtml('<figure><img src="123.jpg"><figcaption>wildebeest herd river crossing</figcaption></figure><script type="application/ld+json">{"image":{"contentUrl":"https://example.com/456.jpg","caption":"wildebeest herd river crossing"}}</script>',page);
  assert.equal(c.filter(x=>imageRelevanceDecision(x,slot).pass).length,2);
});
test('nested proxy decoration and fonts filtered before download',()=>{
  const c=['https://proxy.example/img?url=https%3A%2F%2Fexample.com%2Flogo.png','https://example.com/font.woff2','https://example.com/123.jpg'].map(imageUrl=>({imageUrl,resourceRole:imageUrl.endsWith('123.jpg')?'ui':'media'}));
  assert.equal(prepareWebCandidates(c).after,0);
});
test('failed or irrelevant pages leave a real second-query opportunity without resetting slot budgets',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'web-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const searches=[];const visits=[];let calls=0;
  const s={...slot,queryCore:{...slot.queryCore,subject:'角马群',action:'渡河'},slotId:'budget-slot',moduleType:'day',subject:'角马群',primaryVisualSubject:'角马群渡河',fidelityQuery:'角马渡河',alternateQueries:['wildebeest river crossing'],searchIntent:['角马渡河','wildebeest river crossing'],location:'Kenya',destination:'Kenya',required:true,aspectRatio:'16:9',userLocked:false,copyTargetId:'copy:day:5'};
  s.visualGoal='角马渡河';s.visualContext={destination:'Kenya'};
  const r=await runImageSearchSkill({root,slots:[s],sourceMode:'web_only',sourcePagesPerSlot:4,searchApiKey:'fixture',searchModel:'fixture',adapters:{searchWebBatch:async({queries})=>{searches.push(queries);const n=++calls;return Array.from({length:4},(_,i)=>({pageUrl:`https://example.com/q${n}/p${i}`}));},searchCommonsImages:async()=>[],extractPageImages:async(page)=>{visits.push(page.pageUrl);if(page.pageUrl.endsWith('q1/p0'))throw Error('HTTP 403');return [{...page,imageUrl:'https://example.com/unrelated-pool.jpg',caption:'No wildebeest in this image'}];},downloadCandidate:async()=>{throw Error('explicit mismatch reached download');}}});
  assert.equal(searches.length,2,JSON.stringify(r.results[0]));assert.ok(searches.every(q=>q.length===1));
  const e=r.results[0].pipelineEvidence.webExecution;
  assert.ok(e.queryReports[0].accessedPages<4);assert.ok(e.queryReports[1].accessedPages>0);
  assert.equal(e.queryReports[0].pageFailures,1);assert.equal(e.effectivePagesUsed,0);assert.equal(e.downloadsUsed,0);assert.equal(e.pagesUsed,new Set(visits).size);assert.ok(e.pagesUsed<=e.networkPageLimit);
});
test('full nested resource path is evidence; an absent formal name is not a rejection',()=>{
  const c={imageUrl:'https://proxy.example/image?url=https%3A%2F%2Fexample.com%2Flocations%2Fcarnivore%2Ffood%2F01.jpeg'};
  const d=imageRelevanceDecision(c,{exactIdentityRequired:true,queryCore:{subject:'烤肉',identityEn:'The Carnivore restaurant'}});
  assert.match(d.resourcePath,/locations\/carnivore\/food/);assert.equal(d.state,'insufficient_evidence');assert.equal(d.pass,true);
  const cycle=imageRelevanceDecision({imageUrl:'https://example.com/opaque.jpg',alt:'Two cyclists riding on a dirt trail'},{exactIdentityRequired:false,queryCore:{subjectEn:'cyclists',actionEn:'cycling',identityEn:'Some National Park'}});
  assert.equal(cycle.pass,true);assert.ok(cycle.subjectMatches.length);
});
test('only demonstrated conflict is excluded; partial composite identity stays uncertain',()=>{
  const s={entityName:'Azure Pavilion',exactIdentityRequired:true,queryCore:{subjectEn:'glass sculpture',identityEn:'Azure Pavilion with mountain backdrop'}};
  assert.equal(imageRelevanceDecision({imageUrl:'https://example.com/x.jpg',depictedIdentity:'Other Pavilion'},s).state,'explicit_mismatch');
  assert.equal(imageRelevanceDecision({imageUrl:'https://example.com/azure-pavilion/x.jpg',alt:'glass sculpture'},s).state,'strong_match');
  assert.equal(imageRelevanceDecision({imageUrl:'https://example.com/x.jpg'},s).state,'insufficient_evidence');
});
test('accommodation context is not the hard identity of a different experience',()=>{
  const s={moduleType:'day',hotel:'Background Hotel',entityName:'Azure Pavilion',exactIdentityRequired:true,queryCore:{subjectEn:'glass sculpture',identityEn:'Azure Pavilion'}};
  const d=imageRelevanceDecision({imageUrl:'https://example.com/azure-pavilion/photo.jpg',alt:'glass sculpture',depictedIdentity:'Azure Pavilion'},s);
  assert.equal(d.state,'strong_match');assert.equal(d.pass,true);
});
test('og extraction does not discard later figure caption; page-level JSONLD is not local proof',()=>{
  const c=extractImageCandidatesFromHtml('<meta property="og:image" content="/123.jpg"><figure><img src="/123.jpg"><figcaption>wildebeest herd river crossing</figcaption></figure><script type="application/ld+json">{"@type":"WebPage","description":"wildebeest herd river crossing","image":"https://example.com/456.jpg"}</script>',{pageUrl:'https://example.com/page'});
  assert.equal(imageRelevanceDecision(c.find(x=>x.imageUrl.endsWith('123.jpg')),slot).state,'strong_match');
  assert.equal(imageRelevanceDecision(c.find(x=>x.imageUrl.endsWith('456.jpg')),slot).state,'insufficient_evidence');
});
test('uncertain candidates use a bounded pool and Vision continues 4 then 2 within six downloads',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'web-uncertain-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const waves=[];let downloaded=0;
  const s={slotId:'uncertain-six',moduleType:'day',required:true,subject:'glass sculpture',primaryVisualSubject:'glass sculpture',queryCore:{subject:'glass sculpture',subjectEn:'glass sculpture'},exactIdentityRequired:false,searchIntent:['glass sculpture','glass object'],fidelityQuery:'glass sculpture',alternateQueries:['glass object'],visualGoal:'glass sculpture',visualContext:{},copyTargetId:'copy-test',aspectRatio:'16:9',userLocked:false};
  const r=await runImageSearchSkill({root,slots:[s],sourceMode:'web_only',downloadsPerSlot:6,visionCandidatesPerSlot:4,visionApiKey:'fixture',visionBaseUrl:'https://vision.invalid',visionModel:'fixture',adapters:{
    searchWebBatch:async()=>[{pageUrl:'https://example.com/gallery'}],searchCommonsImages:async()=>[],
    extractPageImages:async(page)=>Array.from({length:20},(_,i)=>({...page,imageUrl:`https://example.com/opaque-${i}.jpg`,pagePosition:'content'})),
    downloadCandidate:async(c,{directory,publicPrefix})=>{const i=downloaded++;const filePath=path.join(directory,`photo-${i}.jpg`);await sharp({create:{width:1400,height:900,channels:3,background:'#347859'}}).jpeg().toFile(filePath);return {filePath,publicUrl:`${publicPrefix}/photo-${i}.jpg`,sha256:`unique-${i}`,width:1400,height:900};},
    judgeCandidatesBatch:async({candidates})=>{waves.push(candidates.length);const good=waves.length===2;return candidates.map(c=>({candidateId:c.candidateId,actualSubject:good?'glass sculpture':'unrelated scene',reason:'controlled visual result',matchLevel:good?'exact':'mismatch',locationMatch:true,visibleLocationConflict:false,hotelIdentityMatch:true,visibleIdentityConflict:false,activityMatch:true,coreActionMatch:true,subjectMatch:good,coreSubjectMatch:good,identityMatch:true,subjectClear:true,subjectLargeEnough:true,subjectPrimary:true,transportType:'none',transportTypeMatch:true,watermarkFree:true,nonAI:true,photographic:true,technicalUsable:true,eligible:good,hardRejectCode:good?'none':'subject_mismatch',relevance:good?95:20,luxury:90,cleanliness:90,composition:90,score:good?95:20}));}
  }});
  assert.equal(r.results[0].status,'success',JSON.stringify(r.results[0]));assert.equal(downloaded,6);assert.deepEqual(waves,[4,2]);
  const e=r.results[0].pipelineEvidence.webExecution;assert.equal(e.relevanceCounts.insufficient_evidence,20);assert.equal(e.relevanceCounts.insufficientInDownloadPool,6);assert.deepEqual(e.queryReports[0].visionBatchSizes,[4,2]);
});
