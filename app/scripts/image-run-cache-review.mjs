import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const [id, phase='final'] = process.argv.slice(2);
const origin='http://127.0.0.1:4175';
const dir=path.resolve('output/simple-pipeline/projects',id);
const out=path.resolve('../audit/evidence/image-run-cache',id);
await fs.mkdir(out,{recursive:true});
if(phase==='progress'){
  const {data}=JSON.parse(await fs.readFile(path.join(dir,'inputs/source-data.json'),'utf8'));
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});
  try{
    const page=await browser.newPage();
    await page.setViewport({width:1600,height:1100});
    await page.evaluateOnNewDocument((id,data)=>{
      localStorage.setItem('sheyou-agent-users-v1',JSON.stringify([{id:'test-viewer',name:'复测定制师',active:true,isAdmin:false}]));
      localStorage.setItem('sheyou-agent-session-v1',JSON.stringify({userId:'test-viewer'}));
      localStorage.setItem('sheyou-agent-projects-v1',JSON.stringify([{id,agentProjectId:id,ownerId:'test-viewer',flowKind:'simple_skill_v1',title:'缓存复测当前项目',data,files:[],workflowStage:'generating',updatedAt:Date.now()}]));
    },id,data);
    await page.goto(origin+'/agent',{waitUntil:'networkidle0'});
    await page.waitForSelector('.project-row');
    await page.click('.project-row');
    await page.waitForFunction(()=>document.querySelector('.agent-progress-overview')?.textContent.includes('图片处理'),{timeout:30000});
    const text=await page.$eval('.agent-progress-overview',el=>el.innerText);
    const state=await (await fetch(origin+'/api/simple/projects/'+id)).json();
    assert.ok(state.activeJob.imageSlotProgress.total>0);
    await (await page.$('.agent-progress-overview')).screenshot({path:path.join(out,'progress.png')});
    await fs.writeFile(path.join(out,'progress.json'),JSON.stringify({at:new Date().toISOString(),text,backend:state.activeJob.imageSlotProgress},null,2));
    console.log(text);
  }finally{await browser.close();}
}else{
  const load=async projectId=>{
    const base=path.resolve('output/simple-pipeline/projects',projectId);
    const p=JSON.parse(await fs.readFile(path.join(base,'project.json'),'utf8'));
    return {project:p,result:JSON.parse(await fs.readFile(path.join(base,'execution-runs',p.activeExecutionRunId,'final-result.json'),'utf8'))};
  };
  const old=await load('483a1174-456b-41d5-b827-57579b78ffbf'), current=await load(id);
  const summary=({project,result})=>({projectId:project.projectId,executionRunId:project.activeExecutionRunId,imageMs:result.timingsMs.imageSkill,slots:result.imageExecution.results.length,found:result.imageExecution.results.filter(s=>s.selected).length,missing:result.imageExecution.results.filter(s=>!s.selected).length,visionCalls:result.imageExecution.metrics.batchVisionCalls,pageAttempts:result.imageExecution.metrics.pageExtractionCalls,downloadAttempts:result.imageExecution.metrics.downloadAttempts,resourceReuse:result.imageExecution.metrics.resourceReuse,concurrency:result.concurrency.copyImage,status:result.pipelineStatus,render:result.renderStatus,slotResults:result.imageExecution.results.map(s=>({slotId:s.slotId,query:s.queriesUsed,status:s.status,selected:s.selected?.imageUrl||null}))});
  const report={before:summary(old),after:summary(current)};
  await fs.writeFile(path.join(out,'comparison.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
