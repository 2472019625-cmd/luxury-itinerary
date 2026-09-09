// Isolated typography fixture, NOT a real project/Renderer acceptance test.
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { servePublicStatic } from '../server/public-static.mjs';

const root = path.resolve(import.meta.dirname, '..');
const reportDir = path.join(root, 'output/font-loading-verification');
mkdirSync(reportDir, {recursive:true});
const manifest = JSON.parse(readFileSync(path.join(root, 'public/fonts/web/manifest.json')));
const text = '奢游国际 肯尼亚8日7晚顶奢游猎 安博塞利 马赛马拉 龘龖𠮷 餐食费用 ¥12,345 Angama Amboseli The Ritz-Carlton Saruni Leopard Hill café fi ffi';
const html = variant => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/${variant}-fonts.css"><style>body{margin:0;background:white;color:#222}.row{width:1900px;padding:8px 30px;font-size:28px;line-height:1.4;white-space:normal}</style>${manifest.map(f=>`<div class="row" style="font-family:'${f.family}';font-weight:${f.weight}">${text}</div>`).join('')}`;
const types = {'.css':'text/css', '.html':'text/html', '.otf':'font/otf', '.ttf':'font/ttf', '.png':'image/png', '.svg':'image/svg+xml', '.js':'text/javascript'};
const server = createServer((req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if (url.pathname === '/fixture') {res.setHeader('content-type','text/html; charset=utf-8'); return res.end(html(url.searchParams.get('variant') || 'web'));}
  const base = url.pathname.endsWith('-fonts.css') ? path.join(root,'src') : path.join(root,'public');
  const file = path.resolve(base,'.'+decodeURIComponent(url.pathname));
  if (!file.startsWith(base+path.sep) || !existsSync(file)) {res.statusCode=404; return res.end();}
  servePublicStatic(req,res,file,base,types);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
  const page = await browser.newPage();
  await page.setViewport({width:2000,height:1800,deviceScaleFactor:1});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const measurements=[];
  for (const variant of ['export','web','web']) {
    const start = Date.now();
    if (measurements.length === 2) await page.reload({waitUntil:'networkidle0',timeout:180000});
    else await page.goto(origin+`/fixture?variant=${variant}`,{waitUntil:'networkidle0',timeout:180000});
    await page.evaluate(()=>document.fonts.ready);
    const stats=await page.evaluate(()=>({
      rows:[...document.querySelectorAll('.row')].map(e=>({height:e.getBoundingClientRect().height,text:e.innerText})),
      resources:performance.getEntriesByType('resource').map(r=>({name:r.name,bytes:r.transferSize,duration:r.duration,protocol:r.nextHopProtocol})),
      fonts:[...document.fonts].filter(f=>f.status==='loaded').length,
    }));
    const fonts=stats.resources.filter(r=>/\.(woff2|otf|ttf)$/.test(r.name));
    measurements.push({variant,elapsedMs:Date.now()-start,fontTransferredBytes:fonts.reduce((n,r)=>n+r.bytes,0),fontRequests:fonts.length,rows:stats.rows,loadedFaces:stats.fonts});
    const file=path.join(reportDir,`${variant}.png`);
    await page.screenshot({path:file,fullPage:true});
  }
  const original=await sharp(path.join(reportDir,'export.png')).raw().toBuffer({resolveWithObject:true});
  const web=await sharp(path.join(reportDir,'web.png')).raw().toBuffer({resolveWithObject:true});
  const identical=original.data.equals(web.data);
  const report={fixtureOnly:true,text,measurements,pixelIdentical:identical,errors};
  writeFileSync(path.join(reportDir,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  assert.deepEqual(measurements[0].rows,measurements[1].rows);
  assert.ok(identical,'Typography pixels differ: do not deploy until reviewed');
  assert.deepEqual(errors,[]);
  assert.ok(measurements[2].fontTransferredBytes===0,'Warm font requests were not cached');
} finally {await browser.close();await new Promise(r=>server.close(r));}
