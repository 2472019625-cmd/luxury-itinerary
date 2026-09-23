import puppeteer from 'puppeteer-core';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const evidenceDir=path.resolve('../audit/evidence/2026-09-22-generation-progress-ui');
await fs.mkdir(evidenceDir,{recursive:true});
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
 if(req.url().includes('/api/auth/session'))return req.respond({status:200,contentType:'application/json',body:JSON.stringify({enabled:false})});
 if(req.url().includes('/api/simple/projects/smoke')){
 count++;if(count===4)return req.respond({status:502,contentType:'text/html',body:'<!DOCTYPE html>gateway failed'});
 const failed=count>=6;
 return req.respond({status:200,contentType:'application/json',body:JSON.stringify({project:{projectId:'smoke',flowKind:'simple_skill_v1',status:failed?'failed':'running',createdAt:new Date(Date.now()-60000).toISOString(),updatedAt:new Date().toISOString()},activeJob:{status:failed?'failed':'running',progress:45,stages:[{id:'copy_skill',status:'running'}]},confirmations:[]})});
 }if(/\.(otf|png|jpg)$/.test(req.url()))return req.abort();req.continue();
 });
 await page.evaluateOnNewDocument(()=>{
 localStorage.setItem('sheyou-agent-users-v1',JSON.stringify([{id:'test',name:'测试',login:'test',pin:'000000',isAdmin:true,active:true}]));
 localStorage.setItem('sheyou-agent-session-v1',JSON.stringify({userId:'test'}));
 localStorage.setItem('sheyou-agent-projects-v1',JSON.stringify([{id:'smoke',agentProjectId:'smoke',ownerId:'test',flowKind:'simple_skill_v1',title:'连接测试',updatedAt:Date.now(),data:{title:'连接测试',days:[],hotels:[]},files:[],workflowStage:'generating'}]));
 });
 await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
 await page.goto(`http://127.0.0.1:${server.address().port}/agent`);
 await page.waitForSelector('.workspace-recent-card',{timeout:10000}).catch(async e=>{console.log({errors,text:await page.$eval('body',e=>e.innerText)});throw e;});await page.click('.workspace-recent-card');
 await page.waitForSelector('.agent-connection-status',{timeout:10000});
 const disconnectedText=await page.$eval('.agent-progress-overview',e=>e.innerText);
 assert.ok(disconnectedText.includes('正在重新连接')&&disconnectedText.includes('当前显示最近一次同步进度')&&disconnectedText.includes('上次状态')&&!disconnectedText.includes('请勿重复生成'),disconnectedText);
 assert.equal(await page.$('.generation-error'),null);
 await page.screenshot({path:path.join(evidenceDir,'disconnected.png'),fullPage:true});
 await page.waitForFunction(()=>!document.querySelector('.agent-connection-status'));
 assert.ok(await page.$eval('.agent-progress-overview',e=>e.innerText.includes('进行中')));
 assert.equal(await page.$('.generation-error'),null);
 await page.waitForSelector('.agent-progress-card-failed',{timeout:10000});
 assert.ok(await page.$eval('.agent-progress-overview',e=>!e.innerText.includes('进行中')));
 assert.deepEqual(errors,[]);console.log('PASS: HTML connection loss -> recovered running -> confirmed failure; no stale active state');
}finally{await browser.close();server.close();}
