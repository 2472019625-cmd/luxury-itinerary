import puppeteer from 'puppeteer-core';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{
 const file=path.resolve('dist/client',req.url.split('?')[0].slice(1));
 const content=await fs.readFile(file).catch(()=>fs.readFile('dist/client/index.html'));
 res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(content);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage();let count=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setRequestInterception(true);
 page.on('request',req=>{
 if(req.url().includes('/api/simple/projects/smoke')){
 count++;if(count===2)return req.respond({status:502,contentType:'text/html',body:'<!DOCTYPE html>gateway failed'});
 const failed=count>=4;
 return req.respond({status:200,contentType:'application/json',body:JSON.stringify({project:{projectId:'smoke',flowKind:'simple_skill_v1',status:failed?'failed':'running',createdAt:new Date(Date.now()-60000).toISOString(),updatedAt:new Date().toISOString()},activeJob:{status:failed?'failed':'running',progress:45,stages:[{id:'copy_skill',status:'running'}]},confirmations:[]})});
 }if(/\.(otf|png|jpg)$/.test(req.url()))return req.abort();req.continue();
 });
 await page.evaluateOnNewDocument(()=>{
 localStorage.setItem('sheyou-agent-users-v1',JSON.stringify([{id:'test',name:'测试',active:true}]));
 localStorage.setItem('sheyou-agent-session-v1',JSON.stringify({userId:'test'}));
 localStorage.setItem('sheyou-agent-projects-v1',JSON.stringify([{id:'smoke',agentProjectId:'smoke',ownerId:'test',flowKind:'simple_skill_v1',title:'连接测试',updatedAt:Date.now(),data:{title:'连接测试',days:[],hotels:[]},files:[],workflowStage:'generating'}]));
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/agent`);
 await page.waitForSelector('.project-row',{timeout:10000}).catch(async e=>{console.log({errors,text:await page.$eval('body',e=>e.innerText)});throw e;});await page.click('.project-row');
 await page.waitForFunction(()=>document.querySelector('h1')?.textContent.includes('连接异常'));
 assert.ok(await page.$eval('.agent-progress-overview',e=>e.innerText.includes('最后已知进度')&&!e.innerText.includes('进行中')));
 await page.waitForFunction(()=>document.querySelector('h1')?.textContent.includes('正在制作'));
 assert.equal(await page.$('.generation-error'),null);
 await page.waitForFunction(()=>document.querySelector('h1')?.textContent.includes('制作已中断'));
 assert.ok(await page.$eval('.agent-progress-overview',e=>!e.innerText.includes('进行中')));
 assert.deepEqual(errors,[]);console.log('PASS: HTML connection loss -> recovered running -> confirmed failure; no stale active state');
}finally{await browser.close();server.close();}
