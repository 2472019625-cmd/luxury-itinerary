import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { AgentPlanStore } from '../server/agent-plan-store.mjs';
import { dayVisualCards } from '../src/lib/dayVisualCards.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';
import { buildImageQueries } from '../server/simple-image-skill.mjs';
const [projectId, origin='http://127.0.0.1:4175'] = process.argv.slice(2);
assert.ok(projectId);
const store = new AgentPlanStore('output/simple-pipeline/projects');
const project = store.getProject(projectId);
const final = store.getFinalResult(projectId, project.activeExecutionRunId);
assert.ok(final?.data);
const plan = store.getPlan(projectId, project.activePlanId);
const directory = path.resolve('../audit/evidence/day-search-title-split', projectId);
await fs.mkdir(directory, {recursive:true});
const rows = plan.imageSlots.filter(slot=>slot.moduleType==='day').map(slot=>{
  const binding = final.data.simpleImageSlotBindings[slot.slotId];
  const image = final.imageExecution.results.find(item=>item.slotId===slot.slotId);
  const copy = final.copyExecution.results.find(item=>item.targetId===`copy:visual:${slot.slotId}`);
  assert.deepEqual(buildImageQueries({...slot, cardTitle:'更换客户标题',cardDescription:'更换客户描述'}), buildImageQueries(slot));
  return {day:slot.visualContext.dayIndex+1,slotId:slot.slotId,tier:slot.visualTier,primaryVisualSubject:slot.primaryVisualSubject,searchIntent:slot.searchIntent,cardTitle:binding.cardTitle||'',cardDescription:binding.cardDescription||'',queries:image?.queriesUsed||[],imageFound:!!image?.selected,copyStatus:copy?.status,copyError:copy?.error,displayed:slot.required||!!image?.selected};
});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});
const pageErrors=[];
let presentation, clicks=0;
try {
  const page=await browser.newPage();
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.setViewport({width:1600,height:1000});
  await page.goto(`${origin}/simple/projects/${projectId}`,{waitUntil:'networkidle0'});
  await page.waitForSelector('.day-section');
  presentation=await page.$$eval('.day-section',days=>days.map(day=>[...day.querySelectorAll('.spot-card')].map(card=>({title:card.querySelector('h4')?.textContent,description:card.querySelector('.spot-copy p')?.textContent,badges:card.querySelectorAll('.experience-status').length}))));
  const customer=selectCustomerRenderData(final.data);
  for(const [index,day] of final.data.days.entries()){
    const expected=dayVisualCards(day,index,final.data.simpleImageSlotBindings);
    assert.deepEqual(presentation[index].map(({title,description})=>({title,description})),customer.days[index].spots.map(s=>({title:s.name,description:s.description})));
    assert.ok(presentation[index].every(card=>card.badges===0));
    for(const card of expected){
      await page.click(`.day-section [data-edit-path="days.${index}.spots.${card.spotIndex}"][data-edit-image="${card.imageIndex}"]`);
      await page.waitForSelector('.image-picker-modal');
      assert.equal(await page.$eval('.image-picker-modal h2',el=>el.textContent),card.spot.name);
      await page.click('.image-picker-modal header button');
      clicks++;
    }
    const section=(await page.$$('.day-section'))[index];
    const gallery=await section.$('.spot-galleries');
    if(gallery) await gallery.screenshot({path:path.join(directory,`day-${index+1}.png`)});
  }
  assert.deepEqual(pageErrors,[]);
} finally {await browser.close();}
const report={projectId,executionRunId:project.activeExecutionRunId,baseline:'21833f9e7291a32c60760d154f4e3392578b2bbf',concurrency:final.concurrency,rows,presentation,clicks,pageErrors,missingCopy:rows.filter(r=>!r.cardTitle||!r.cardDescription).map(r=>r.slotId)};
await fs.writeFile(path.join(directory,'comparison.json'),JSON.stringify(report,null,2));
const esc=value=>String(value??'').replaceAll('|','／').replaceAll('\n',' ');
const lines=['# DAY 搜索语义与客户标题对照','',`项目：${projectId}`,`执行：${project.activeExecutionRunId}`,`基线：${report.baseline}`,`Copy/Image并发：${final.concurrency.copyImage.parallel}`,`浏览器逐卡换图入口：${clicks}；页面错误：${pageErrors.length}`,`缺少标题/描述：${report.missingCopy.length}`,''];
for(let day=1;day<=8;day++){
  lines.push(`## DAY${day}`,'','|角色|primaryVisualSubject|searchIntent|cardTitle|cardDescription|实际 query|有图|展示|','|---|---|---|---|---|---|---|---|');
  for(const r of rows.filter(r=>r.day===day))lines.push(`|${[r.tier,r.primaryVisualSubject,r.searchIntent,r.cardTitle,r.cardDescription,r.queries.join('；'),r.imageFound?'是':'否',r.displayed?'是':'否'].map(esc).join('|')}|`);
  lines.push('');
}
await fs.writeFile(path.join(directory,'DAY1-8-comparison.md'),lines.join('\n'));
console.log(JSON.stringify(report));
