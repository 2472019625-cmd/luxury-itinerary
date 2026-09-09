import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scryptSync} from 'node:crypto';
import {createServer} from 'node:http';
import {createDemoAuth} from '../server/demo-auth.mjs';

test('shared Demo auth: deny anonymous, origin, cookie, logout, expiry, throttle, internal renderer',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'sheyou-auth-')),file=path.join(dir,'auth.json');
 const salt='a'.repeat(32),password='test-long-password-only';
 writeFileSync(file,JSON.stringify({login:'demo',salt,hash:scryptSync(password,salt,64).toString('hex')}));
 let time=1000;
 const auth=createDemoAuth({enabled:true,file,origin:'https://sheyou-ai.cn',secure:true,now:()=>time});
 const server=createServer(async(req,res)=>{if(!await auth(req,res,new URL(req.url,'http://localhost'))){res.end('protected');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.close();rmSync(dir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}`;
 const request=(p,options={})=>fetch(url+p,{...options,headers:{host:'sheyou-ai.cn','x-forwarded-for':'203.0.113.1',...options.headers}});
 for(const p of ['/api/simple/projects/id','/api/agent/projects/id','/image-assets/a.jpg'])assert.equal((await request(p)).status,401);
 assert.equal((await request('/api/simple/projects',{method:'POST'})).status,403);
 const login=()=>request('/api/auth/login',{method:'POST',headers:{origin:'https://sheyou-ai.cn','content-type':'application/json'},body:JSON.stringify({login:'demo',password})});
 const res=await login();assert.equal(res.status,200);
 const setCookie=res.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);
 const cookie=setCookie.split(';')[0];
 assert.equal((await request('/api/simple/projects/id',{headers:{cookie}})).status,200);
 assert.equal((await request('/api/auth/session',{headers:{cookie}})).status,200);
 assert.equal((await request('/api/simple/projects/id',{method:'POST',headers:{cookie,origin:'https://evil.example'}})).status,403);
 await request('/api/auth/logout',{method:'POST',headers:{cookie,origin:'https://sheyou-ai.cn'}});
 assert.equal((await request('/api/simple/projects/id',{headers:{cookie}})).status,401);
 const again=(await login()).headers.get('set-cookie').split(';')[0];time+=8*3600*1000+1;
 assert.equal((await request('/api/simple/projects/id',{headers:{cookie:again}})).status,401);
 assert.equal((await request('/image-assets/a',{headers:{host:`127.0.0.1:${server.address().port}`}})).status,401);
 assert.equal((await fetch(url+'/image-assets/a')).status,200);
 assert.equal((await fetch(url+'/api/simple/projects/id')).status,401);
 for(let i=0;i<10;i++)await login();assert.equal((await login()).status,429);
});

test('production configuration fails closed',()=>{
 assert.throws(()=>createDemoAuth({enabled:true}),/requires/);
});
