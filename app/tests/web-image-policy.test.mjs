import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { explicitEntityRoute } from '../server/knowledge-scope-resolver.mjs';
import { buildWebExecutionQueries } from '../server/image-web-execution.mjs';
import { imageRelevanceDecision, prepareWebCandidates, webHotelIdentityEvidence } from '../server/web-image-candidates.mjs';
import { extractImageCandidatesFromHtml } from '../server/page-images.mjs';
import { applyWebImageIdentityEvidence, failedHardRequirement, runImageSearchSkill } from '../server/simple-image-skill.mjs';

test('酒店网页只凭专属页面或图片自身证据确认身份，别家酒店文件提前排除', () => {
  const slot = { moduleType: 'hotel', hotel: 'Soroi Luxury\nMigration Camp', hotelOfficialName: 'Soroi Luxury\nMigration Camp', exactIdentityRequired: true, queryCore: { identity: 'Soroi Luxury Migration Camp', subject: '酒店外观' } };
  assert.equal(buildWebExecutionQueries(slot, [])[0], 'Soroi Luxury Migration Camp exterior');
  const homepage = { pageUrl: 'https://soroi.com/', imageUrl: 'https://soroi.com/wp-content/uploads/tent.jpg', alt: 'luxury tent' };
  const property = { ...homepage, pageUrl: 'https://soroi.com/maasai-mara-camp-portfolio/soroi-luxury-migration-camp/', alt: 'Soroi luxury tent', pagePosition: 'content' };
  assert.equal(webHotelIdentityEvidence(homepage, slot), null);
  assert.equal(webHotelIdentityEvidence(property, slot)?.basis, 'property_page');
  assert.equal(webHotelIdentityEvidence({ ...property, alt: 'luxury tent' }, slot), null);
  assert.equal(imageRelevanceDecision({ ...homepage, imageUrl: 'https://www.chaloafrica.com/wp-content/uploads/Lukimbi-Safari-Lodge.jpg' }, slot).reason, 'named_other_hotel_in_image_filename');
  const ritz = { moduleType: 'hotel', hotel: 'The Ritz-Carlton, Masai Mara Safari Camp' };
  const photo = { imageUrl: 'https://secure.s.forbestravelguide.com/img/properties/the-ritz-carlton-masai-mara-safari-camp/extra-large/the-ritz-carlton-masai-mara-safari-camp-two-bedroom-suite.jpg', pageUrl: 'https://www.forbestravelguide.com/hotels/maasai-mara-kenya/the-ritz-carlton-masai-mara-safari-camp' };
  assert.equal(webHotelIdentityEvidence(photo, ritz)?.basis, 'image_metadata');
  assert.equal(webHotelIdentityEvidence({ imageUrl: 'https://example.com/ritz-carlton.jpg', pageUrl: 'https://example.com/brands/ritz-carlton/' }, ritz), null);
});

test('图片身份字段矛盾时，确定性图片证据可自动纠正；真实冲突仍拒绝', () => {
  const slot = { moduleType: 'hotel', hotel: 'The Ritz-Carlton, Masai Mara Safari Camp', queryCore: { identity: 'The Ritz-Carlton, Masai Mara Safari Camp', subject: '酒店套房' }, exactIdentityRequired: true };
  const candidate = { imageUrl: 'https://secure.s.forbestravelguide.com/img/properties/the-ritz-carlton-masai-mara-safari-camp/extra-large/the-ritz-carlton-masai-mara-safari-camp-two-bedroom-suite.jpg' };
  const audit = { auditEvidenceVersion: 2, identityEvidence: { status: 'insufficient' }, candidateId: 'ritz-photo', actualSubject: '丽思卡尔顿营地套房', reason: '资源路径确认目标酒店', matchLevel: 'representative', hardRejectCode: 'none', locationMatch: true, visibleLocationConflict: false, hotelIdentityMatch: false, visibleIdentityConflict: false, activityMatch: true, coreActionMatch: true, subjectMatch: true, coreSubjectMatch: true, identityMatch: false, subjectClear: true, subjectLargeEnough: true, subjectPrimary: true, transportTypeMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: false };
  const corrected = applyWebImageIdentityEvidence(slot, candidate, audit);
  assert.equal(corrected.identityEvidence.status, 'supported');
  assert.equal(corrected.hotelIdentityMatch, true);
  assert.equal(failedHardRequirement(slot, corrected), null);
  assert.equal(applyWebImageIdentityEvidence(slot, candidate, { ...audit, visibleIdentityConflict: true }).hotelIdentityMatch, false);
  assert.equal(applyWebImageIdentityEvidence(slot, candidate, { ...audit, hardRejectCode: 'wrong_subject' }).hotelIdentityMatch, false);
});

test('Soroi 专属第三方页可在官网首页与别家酒店图之间优先下载并自动采用', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soroi-image-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slot = { slotId: 'image:hotel:soroi:primary', moduleType: 'hotel', hotel: 'Soroi Luxury\nMigration Camp', hotelOfficialName: 'Soroi Luxury\nMigration Camp', required: true, visualGoal: '酒店营地主图', visualContext: { destination: 'Kenya' }, copyTargetId: 'copy:hotel:soroi', aspectRatio: '16:9', userLocked: false, queryCore: { identity: 'Soroi Luxury Migration Camp', subject: '酒店外观' }, exactIdentityRequired: true };
  const downloaded = [];
  const propertyImage = 'https://travel.example.com/images/soroi-luxury-migration-camp-exterior.jpg';
  const result = await runImageSearchSkill({ root, slots: [slot], sourceMode: 'web_only', searchApiKey: 'fixture', searchModel: 'fixture', visionApiKey: 'fixture', visionBaseUrl: 'https://vision.invalid', visionModel: 'fixture', downloadsPerSlot: 6, sourcePagesPerSlot: 2, adapters: {
    searchWebBatch: async () => [
      { pageUrl: 'https://soroi.com/', officialHint: true, title: 'Soroi homepage' },
      { pageUrl: 'https://travel.example.com/hotels/soroi-luxury-migration-camp/', title: 'Soroi Luxury Migration Camp' },
    ],
    searchCommonsImages: async () => [],
    extractPageImages: async (page) => page.pageUrl === 'https://soroi.com/'
      ? [
        { ...page, imageUrl: 'https://soroi.com/wp-content/uploads/Lukimbi-Safari-Lodge.jpg', alt: 'safari lodge', pagePosition: 'content' },
        { ...page, imageUrl: 'https://soroi.com/wp-content/uploads/tent.jpg', alt: 'luxury tent', pagePosition: 'content' },
        { ...page, imageUrl: 'https://soroi.com/wp-content/uploads/savanna.jpg', alt: 'savanna', pagePosition: 'content' },
      ]
      : [{ ...page, imageUrl: propertyImage, alt: 'Soroi Luxury Migration Camp exterior', pagePosition: 'content' }],
    downloadCandidate: async (candidate, { directory, publicPrefix }) => {
      downloaded.push(candidate.imageUrl);
      const fileName = `soroi-${downloaded.length}.jpg`;
      const filePath = path.join(directory, fileName);
      await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#75855d' } }).jpeg().toFile(filePath);
      return { filePath, publicUrl: `${publicPrefix}/${fileName}`, sha256: fileName, width: 1600, height: 1000 };
    },
    judgeCandidatesBatch: async ({ candidates }) => candidates.map(candidate => ({ candidateId: candidate.candidateId, auditEvidenceVersion: 2, identityEvidence: { status: 'insufficient', basis: 'entity_page', quote: candidate.imageUrl }, actualSubject: '营地外观', reason: '来源页与画面符合目标酒店', matchLevel: 'representative', hardRejectCode: 'none', locationMatch: true, visibleLocationConflict: false, hotelIdentityMatch: false, visibleIdentityConflict: false, activityMatch: true, coreActionMatch: true, subjectMatch: true, coreSubjectMatch: true, identityMatch: false, subjectClear: true, subjectLargeEnough: true, subjectPrimary: true, transportType: 'none', transportTypeMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: false, relevance: 95, luxury: 90, cleanliness: 95, composition: 90, score: 93 })),
  } });
  assert.equal(downloaded.length, 1, '先查到专属页面且审核通过时不再打开品牌首页');
  assert.equal(downloaded[0], propertyImage);
  assert.ok(downloaded.every(url => !url.includes('Lukimbi')));
  assert.equal(result.results[0].status, 'success', JSON.stringify(result.results[0]));
  assert.equal(result.results[0].selected?.hardJudgment?.identityEvidence?.status, 'supported');
});

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

test('英文Core缺主体或动作时保留完整Planner英文词，不以半套英文覆盖', () => {
  for (const missing of ['subjectEn', 'actionEn']) {
    const s = ordinary('角马群', 'wildebeest herd', '横渡河流', 'crossing the river', '马拉河');
    s.queryCore[missing] = '';
    const queries = buildWebExecutionQueries(s, ['角马横渡河流', 'wildebeest herd crossing the river']);
    assert.equal(queries[0], 'Kenya wildebeest herd crossing the river');
    assert.equal(queries[1], 'Kenya 角马群 横渡河流');
  }
});

test('没有完整英文表达时使用完整中文Core；静态画面允许动作为空', () => {
  for (const missing of ['subjectEn', 'actionEn']) {
    const s = ordinary('角马群', 'wildebeest herd', '横渡河流', 'crossing the river', '未知地点');
    s.queryCore[missing] = '';
    const partial = missing === 'subjectEn' ? 'crossing the river' : 'wildebeest herd';
    const queries = buildWebExecutionQueries(s, ['角马横渡河流', partial]);
    assert.ok(queries.every(query => query.includes('角马') && query.includes('河流')));
    assert.ok(queries.every(query => !query.endsWith(partial)));
  }
  assert.equal(buildWebExecutionQueries(ordinary('雕塑', 'sculpture', '', '', '未知地点'), ['雕塑', 'sculpture'])[0], 'Kenya sculpture');
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
