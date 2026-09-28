import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const browsers = [
  process.env.LUXURY_TRAVEL_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter((path) => path && fs.existsSync(path));

test('2000px customer canvas renders saved crops in all editable photo sections', { skip: !browsers.length }, async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browsers[0], headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/session') request.respond({ status: 200, contentType: 'application/json', body: '{"enabled":false}' });
      else request.continue();
    });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${base}/?templatePreview=1`);
    const data = JSON.parse(fs.readFileSync(new URL('../data/sample-itinerary-africa.json', import.meta.url), 'utf8'));
    const crop = { x: .2, y: .2, width: .6, height: .6 };
    const fallbackSource = data.hotels[0].images[0].src;
    data.heroCrop = crop;
    data.diningExperiences = [{ title: '测试餐饮图片', editorialCopy: '只用于裁切显示测试', images: [{ src: fallbackSource, crop }] }];
    data.days[0].spots[0].images = [{ src: fallbackSource, crop }];
    for (const item of [data.hotels?.[0], data.diningExperiences?.[0], data.transportSummary?.[0], data.days?.[0]?.spots?.[0]]) {
      if (item?.images?.[0]) item.images[0] = { ...(typeof item.images[0] === 'string' ? { src: item.images[0] } : item.images[0]), crop };
    }
    await page.evaluate((value) => localStorage.setItem('sheyou-export-data-v1', JSON.stringify(value)), data);
    await page.goto(`${base}/?export=1&width=2000&dataset=workspace`, { waitUntil: 'networkidle0' });
    const result = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        canvasWidth: document.querySelector('#itinerary')?.getBoundingClientRect().width,
        classes: ['hero-frame', 'hotel-image', 'dining-image', 'transport-image', 'spot-image'].map((name) => {
          const viewport = document.querySelector(`.${name} .crop-slot-viewport`);
          const image = viewport?.querySelector('img');
          return { name, width: viewport?.clientWidth || 0, height: viewport?.clientHeight || 0, cropped: image?.style.position === 'absolute', imageWidth: image?.naturalWidth || 0 };
        }),
      };
    });
    assert.equal(result.canvasWidth, 2000, pageErrors.join(' | '));
    for (const item of result.classes) assert.ok(item.width > 0 && item.height > 0 && item.cropped && item.imageWidth > 0, JSON.stringify(item));
  } finally {
    await browser.close();
    await server.close();
  }
});
