import puppeteer from 'puppeteer-core';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {scryptSync} from 'node:crypto';
import assert from 'node:assert/strict';
import {createDemoAuth} from '../server/demo-auth.mjs';
const dir=mkdtempSync(path.join(os.tmpdir(),'sheyou-browser-auth-'));
const file=path.join(dir,'account.json'),salt='a'.repeat(32),password='browser-test-password';
writeFileSync(file,JSON.stringify({login:'demo',salt,hash:scryptSync(password,salt,64).toString('hex')}));
let auth;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(await auth(req,res,url))return;
 if(url.pathname.startsWith('/api/')){res.writeHead(404,{'content-type':'application/json'});return res.end('{}');}
 let p=path.resolve('dist/client','.'+url.pathname);if(!existsSync(p)||url.pathname==='/')p=path.resolve('dist/client/index.html');
 res.setHeader('content-type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'application/octet-stream');res.end(readFileSync(p));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://localhost:${server.address().port}`;
auth=createDemoAuth({enabled:true,file,origin,secure:false});
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/agent');await page.waitForSelector('input[autocomplete="username"]');
 assert.ok(!(await page.$eval('body',e=>e.innerText)).includes('首次使用'));
 await page.type('input[autocomplete="username"]','demo');await page.type('input[type="password"]',password);await page.click('button[type="submit"]');
 await page.waitForFunction(()=>document.body.innerText.includes('退出'));
 await page.reload();await page.waitForFunction(()=>document.body.innerText.includes('退出'));
 assert.ok(!(await page.evaluate(()=>document.cookie)).includes('sheyou_session'));
 await page.evaluate(()=>window.dispatchEvent(new Event('sheyou-logout')));
 await page.waitForSelector('input[autocomplete="username"]');
 assert.equal(await page.evaluate(async()=> (await fetch('/api/simple/projects/x')).status),401);
 assert.deepEqual(errors,[]);console.log('PASS login, refresh, logout, no self-registration, protected API, no page errors');
}finally{await browser.close();server.close();rmSync(dir,{recursive:true,force:true});}
