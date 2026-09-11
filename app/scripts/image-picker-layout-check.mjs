import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const origin = process.argv[2] || 'http://127.0.0.1:4175';
const projectId = process.argv[3] || '715c71bb-0128-42f0-8691-81405646f4fe';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const evidence = '../audit/evidence/2026-09-07-image-picker-layout';
await fs.mkdir(evidence, { recursive: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${origin}/simple/projects/${projectId}`, { waitUntil: 'networkidle0' });
  await page.click('[data-edit-path="cover"][data-edit-image="0"]');
  await page.waitForSelector('.image-picker-modal');
  await page.click('.image-picker-modal nav button:nth-child(2)');
  const selectableCount = await page.$$eval('.image-picker-grid > button:not(:disabled)', cards => cards.length);
  assert.ok(selectableCount > 0, 'Saved candidates must allow manual selection');
  let confirmation = '';
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST') writes++; });
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
  await page.click('.image-picker-grid > button:not(:disabled)');
  assert.match(confirmation, /原判断/);
  assert.equal(writes, 0, 'Cancelling confirmation must not change the project');
  console.log(JSON.stringify({ selectableCount, confirmationCancelled: true, writes }));
  const results = [];
  for (const [width, height] of [[1440, 900], [800, 600], [390, 844]]) {
    await page.setViewport({ width, height });
    const metrics = await page.$eval('.image-picker-modal', modal => {
      const grid = modal.querySelector('.image-picker-grid');
      const cards = [...grid.querySelectorAll(':scope > button')];
      return { count: cards.length, gridHeight: grid.clientHeight, scrollHeight: grid.scrollHeight,
        modalHeight: modal.getBoundingClientRect().height, horizontalOverflow: grid.scrollWidth > grid.clientWidth + 1,
        clipped: cards.filter(card => card.scrollHeight > card.clientHeight + 2).length,
        imageHeights: cards.map(card => card.querySelector('img').getBoundingClientRect().height),
        contain: cards.every(card => getComputedStyle(card.querySelector('img')).objectFit === 'contain'),
      };
    });
    results.push({ width, height, ...metrics });
    await page.screenshot({ path: `${evidence}/${width}.png` });
  }
  console.log(JSON.stringify(results));
  await fs.writeFile(`${evidence}/layout-check.json`, JSON.stringify({ projectId, origin, results, errors }, null, 2));
  for (const r of results) {
    assert.ok(r.count > 10, 'Use a real many-candidate project');
    assert.equal(r.clipped, 0, 'Candidate image and description must not be clipped');
    assert.equal(r.horizontalOverflow, false);
    assert.ok(r.modalHeight <= r.height - 20);
    assert.ok(r.scrollHeight > r.gridHeight, 'Long list must scroll');
    assert.ok(Math.min(...r.imageHeights) > 100, 'Thumbnails must not collapse into strips');
    assert.equal(r.contain, true, 'Show the whole candidate image');
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
