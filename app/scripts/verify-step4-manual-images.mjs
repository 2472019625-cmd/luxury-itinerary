import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { fixture } from '../tests/support/manual-image-fixture.mjs';
import { createProductionDefaultData } from '../src/lib/itineraryRules.js';
import { buildSimpleManualImagePayload, chooseSimpleImageCandidate, uploadSimpleImage, researchSimpleImageSlot } from '../server/simple-manual-images.mjs';

// Isolated new test project, real persistence + production UI; no paid AI or real export.
const app = process.cwd();
const evidence = path.join(app, '../audit/evidence/2026-09-08-step4-manual-images');
await mkdir(evidence, { recursive: true });
const value = await fixture();
const final = value.store.getFinalResult(value.projectId, value.executionRunId);
value.store.saveFinalResult(value.projectId, value.executionRunId, { ...final, data: { ...createProductionDefaultData(), ...final.data } });
let searchMode = 'new', searchStarted = 0, saveFails = false;
const render = async ({ mode }) => { await new Promise(resolve => setTimeout(resolve, 1500)); return { status: 'success', mode, outputPath: 'test-only.png' }; };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/auth/session') return json(res, 200, { enabled: false });
    const match = url.pathname.match(/^\/api\/simple\/projects\/[^/]+\/manual-images(?:\/([^/]+)\/(select|upload|research))?$/);
    if (match) {
      if (req.method === 'GET') return json(res, 200, buildSimpleManualImagePayload(value.store, value.projectId));
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const input = { ...value, slotId: decodeURIComponent(match[1]), render, deferRender: true };
      if (saveFails && match[2] !== 'research') throw Error('测试保存失败');
      const result = match[2] === 'select' ? await chooseSimpleImageCandidate({ ...input, ...JSON.parse(buffer) }) : match[2] === 'upload' ? await uploadSimpleImage({ ...input, dataUrl: `data:${req.headers['content-type']};base64,${buffer.toString('base64')}`, fileName: decodeURIComponent(req.headers['x-file-name']) }) : await researchSimpleImageSlot({ ...input, runImage: async () => {
        searchStarted++;
        const mode = searchMode;
        await new Promise(resolve => setTimeout(resolve, 2200));
        if (mode === 'fail') throw Error('测试搜索服务不可用');
        return { results: [{ slotId: input.slotId, status: 'not_found', candidates: mode === 'new' ? [{ candidateId: 'new-browser-candidate', localUrl: '/image-assets/test/new.jpg', sourceTitle: '新增浏览器候选', hardJudgment: { eligible: true } }] : [] }] };
      } });
      return json(res, 200, result);
    }
    const relative = url.pathname.startsWith('/image-assets/') ? path.join(value.root, 'output', url.pathname) : path.join(app, 'dist/client', url.pathname === '/' || url.pathname.startsWith('/simple/') ? 'index.html' : url.pathname);
    const content = await readFile(relative);
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' })[path.extname(relative)] || 'application/octet-stream' }); res.end(content);
  } catch (error) { json(res, 400, { error: error.message }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(path.join(value.root, 'output/image-assets/test/new.jpg'), await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#987640' } }).jpeg().toBuffer());
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => { errors.push(`Unexpected native dialog: ${dialog.message()}`); dialog.dismiss(); });
const click = async (text, selector = 'button') => { await page.waitForFunction((text, selector) => [...document.querySelectorAll(selector)].some(node => node.textContent.trim() === text && !node.disabled), {}, text, selector); await page.evaluate((text, selector) => [...document.querySelectorAll(selector)].find(node => node.textContent.trim() === text && !node.disabled).click(), text, selector); };
const visible = text => page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
const expectImage = src => page.waitForFunction(src => [...document.querySelectorAll('.image-thumbnails img')].some(img => img.getAttribute('src') === src) && [...document.querySelectorAll('.canvas-stage img')].some(img => img.getAttribute('src') === src), {}, src);
try {
  await page.goto(`${origin}/simple/projects/${value.projectId}`, { waitUntil: 'networkidle0' });
  await click('换图');
  await page.waitForSelector('.image-picker-grid button');
  await page.evaluate(() => [...document.querySelectorAll('.image-picker-grid button')].find(button => button.textContent.includes('测试候选')).click()); await click('确认替换');
  await visible('图片替换成功');
  await expectImage(value.candidate.localUrl);
  await click('关闭', '.image-picker-modal button'); await click('换图'); await expectImage(value.candidate.localUrl);
  await page.reload({ waitUntil: 'networkidle0' });
  await click('封面', '.structure-panel button'); await click('图片', '.inspector-tabs button'); await expectImage(value.candidate.localUrl);
  // Reload selects the next unresolved DAY; return to cover explicitly.
  await click('封面', '.structure-panel button'); await click('图片', '.inspector-tabs button'); await click('换图');
  await click('本地上传', '.image-picker-modal nav button');
  const uploadPath = path.join(value.root, 'upload.png');
  await writeFile(uploadPath, await sharp({ create: { width: 1100, height: 650, channels: 3, background: '#3c7498' } }).png().toBuffer());
  await (await page.$('.image-picker-modal input[type=file]')).uploadFile(uploadPath);
  await visible('上传成功');
  const uploaded = buildSimpleManualImagePayload(value.store, value.projectId).project.data.heroImage;
  await expectImage(uploaded);
  await click('关闭', '.image-picker-modal button'); await click('换图'); await expectImage(uploaded);
  await page.reload({ waitUntil: 'networkidle0' });
  await click('封面', '.structure-panel button'); await click('图片', '.inspector-tabs button'); await expectImage(uploaded); await click('换图');
  await click('为当前位置搜索更多'); await visible('正在为「封面主图」搜索更多图片');
  await page.keyboard.press('Escape'); assert.equal(await page.$('.modal-backdrop'), null);
  await click('换图'); await visible('正在搜索…'); await click('关闭', '.image-picker-modal button');
  await click('行程总览', '.structure-panel button');
  await visible('已找到 1 张新候选');
  await click('封面', '.structure-panel button'); await click('图片', '.inspector-tabs button'); await click('换图'); await visible('新增浏览器候选');
  searchMode = 'empty'; await click('为当前位置搜索更多'); await visible('正在搜索…');
  await click('关闭', '.image-picker-modal button'); assert.equal(await page.$('.modal-backdrop'), null);
  await visible('暂未找到更多合适图片'); await click('换图');
  searchMode = 'fail'; await click('为当前位置搜索更多'); await visible('搜索失败，请重试');
  saveFails = true; await page.click('.image-picker-grid button'); await click('确认替换'); await visible('图片替换失败，请重试'); await expectImage(uploaded);
  await page.screenshot({ path: path.join(evidence, 'save-error-feedback.png') });
  await click('本地上传', '.image-picker-modal nav button');
  await (await page.$('.image-picker-modal input[type=file]')).uploadFile(uploadPath);
  await visible('上传或保存失败，请重试'); await expectImage(uploaded);
  assert.equal(searchStarted, 3); assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'browser-result.json'), JSON.stringify({ status: 'passed', environment: 'isolated fixture, production build, real manual-image persistence; AI and renderer mocked; NOT online acceptance', checks: ['candidate immediate/reopen/reload', 'upload immediate/reopen/reload', 'search start/new/empty/error', 'ESC and Close during search, other modules usable', 'save failure visible and old image retained'], browserErrors: errors }, null, 2));
  console.log('Step4 browser checks passed (isolated fixture, not online acceptance).');
} catch (error) {
  await page.screenshot({ path: path.join(evidence, 'browser-failure.png') });
  console.log('Browser errors:', errors);
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 1800));
  await rm(value.root, { recursive: true, force: true });
}
