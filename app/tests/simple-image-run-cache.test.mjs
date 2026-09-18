import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { runImageSearchSkill } from '../server/simple-image-skill.mjs';

test('单次执行共享原始HTML与图片技术结果，语义排序、来源和判断仍逐槽独立', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-resource-cache-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const pageUrl = 'https://example.com/gallery';
  const html = '<img src="/walking.jpg" alt="guided walking safari"><img src="/night.jpg" alt="night safari leopard">';
  let fetches = 0, downloads = 0, searches = 0, commons = 0;
  const judged = [];
  const events = [];
  const slots = ['walking safari', 'night safari leopard'].map((subject, i) => ({
    slotId:`image:day:${i+1}:supporting:1`, moduleType:'day', required:false,
    location:'Amboseli', activity:subject, subject, visualGoal:subject,
    visualContext:{dayRole:subject}, searchIntent:`Amboseli ${subject}`,
    copyTargetId:`copy-${i}`, aspectRatio:'16:9', userLocked:false,
  }));
  const adapters = {
    searchWebBatch:async ({queries}) => { searches++; return [{pageUrl,title:queries[0],officialHint:queries[0].includes('walking')}]; },
    searchCommonsImages:async () => { commons++; return []; },
    fetchImagePageContent:async (url, {onRequest}) => {
      fetches++; onRequest(url);
      await new Promise(resolve => setTimeout(resolve, 10));
      return {html,responseUrl:url};
    },
    downloadCandidate:async (candidate, {directory,publicPrefix,onRequest}) => {
      downloads++; onRequest(candidate.imageUrl);
      await new Promise(resolve => setTimeout(resolve, 10));
      const name = candidate.imageUrl.endsWith('walking.jpg') ? 'walking' : 'night';
      const filePath = path.join(directory, name+'.jpg');
      await sharp({create:{width:1200,height:800,channels:3,background:'#987654'}}).jpeg().toFile(filePath);
      return {...candidate,filePath,publicUrl:`${publicPrefix}/${name}.jpg`,sha256:name,width:1200,height:800,bytes:100,contentType:'image/jpeg',eligible:true};
    },
    judgeCandidatesBatch:async ({slot,candidates}) => {
      judged.push({subject:slot.subject,candidates:structuredClone(candidates)});
      return candidates.map(c=>({candidateId:c.candidateId,actualSubject:c.alt,locationMatch:true,hotelIdentityMatch:true,activityMatch:false,subjectMatch:false,watermarkFree:true,nonAI:true,photographic:true,technicalUsable:true,eligible:false,hardRejectCode:'activity_mismatch',score:50}));
    },
  };
  const run = () => runImageSearchSkill({root,slots,adapters,visionApiKey:'test',visionBaseUrl:'https://example.com',visionModel:'test',onCapabilityCall:e=>events.push(e)});
  const first = await run();
  assert.equal(fetches,1);
  assert.equal(downloads,2);
  assert.equal(searches,2); assert.equal(commons,2);
  assert.equal(judged.length,2);
  for(const entry of judged){
    assert.equal(entry.candidates[0].alt.includes(entry.subject.split(' ')[0]),true);
    assert.ok(entry.candidates.every(c=>c.officialHint===entry.subject.startsWith('walking')));
    assert.ok(entry.candidates.every(c=>c.eligible===undefined));
  }
  assert.equal(first.metrics.resourceReuse.pages.hits,1);
  assert.equal(first.metrics.resourceReuse.pages.inFlightHits,1);
  assert.equal(first.metrics.resourceReuse.images.hits,2);
  assert.deepEqual(events.filter(e=>e.phase==='slot_progress').map(e=>e.completedSlots),[0,1,2]);
  assert.ok(first.results.every(s=>s.selected===null));
  await run();
  assert.equal(fetches,2); assert.equal(downloads,4); assert.equal(judged.length,4);
});

test('图片与文案真实完成数进入总百分比', async () => {
  const server = await readFile(new URL('../server/agent-planner-app.mjs',import.meta.url),'utf8');
  const frontend = await readFile(new URL('../src/Workspace.jsx',import.meta.url),'utf8');
  assert.match(server,/event\.capabilityId === "image_slot_progress"[\s\S]*?job\.imageSlotProgress/);
  assert.match(server,/event\.capabilityId === "copy_task_progress"[\s\S]*?job\.copyTaskProgress/);
  assert.match(server,/calculateSimplePipelineProgress/);
  assert.doesNotMatch(server,/Math\.min\(74/);
  assert.match(frontend,/copyTasks\.completed.*copyTasks\.total/);
  assert.match(frontend,/imageSlots\.completed.*imageSlots\.total/);
});
