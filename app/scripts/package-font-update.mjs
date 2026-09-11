// Build a narrowly-scoped deployment package. Does not touch cloud files.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,mkdtempSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
const destination=path.resolve(root,'../demo-access');
const stage=mkdtempSync(path.join(destination,'sheyou-font-update-'));
const files=new Set(['app/server/agent-planner-app.mjs','app/server/public-static.mjs','app/dist/client/index.html']);
const manifest=JSON.parse(readFileSync(path.join(root,'app/public/fonts/web/manifest.json')));
for(const face of manifest) for(const shard of face.shards) files.add('app/dist/client/fonts/web/'+shard.file);
for(const file of readdirSync(path.join(root,'app/public/fonts/web'))) if(file.endsWith('.txt')) files.add('app/dist/client/fonts/web/'+file);
// Include just the entry's reachable built chunks/styles, not old dist assets.
const queue=['app/dist/client/index.html'];
while(queue.length) {
 const file=queue.shift();
 const content=readFileSync(path.join(root,file),'utf8');
 for(const match of content.matchAll(/(?:\/assets\/|\.\/)([A-Za-z0-9_.-]+\.(?:js|css))/g)) {
   const next='app/dist/client/assets/'+match[1];
   if(!files.has(next)){files.add(next);queue.push(next);}
 }
}
const hash=b=>createHash('sha256').update(b).digest('hex');
const payload=[];
for(const file of files){const target=path.join(stage,file);mkdirSync(path.dirname(target),{recursive:true});copyFileSync(path.join(root,file),target);payload.push({path:file,sha256:hash(readFileSync(target))});}
const previous=path.join(destination,'sheyou-auth-update.tar.gz');
const expected={};
for(const file of ['app/server/agent-planner-app.mjs','app/dist/client/index.html']) expected[file]=hash(execFileSync('tar',['-xOf',previous,file]));
writeFileSync(path.join(stage,'font-update-manifest.json'),JSON.stringify({payload,expected},null,2));
for(const file of ['deploy-font-update.py','enable-sheyou-http2.py']) copyFileSync(path.join(root,'app/scripts',file),path.join(stage,file));
const archive=path.join(destination,path.basename(stage)+'.tar.gz');
execFileSync('tar',['-czf',archive,'-C',stage,'.']);
console.log(JSON.stringify({archive,sha256:hash(readFileSync(archive)),bytes:readFileSync(archive).length,files:files.size},null,2));
