import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createAgentPlannerServer } from '../server/agent-planner-app.mjs';
import { fixture } from './support/manual-image-fixture.mjs';

async function editor(t) {
  const executablePath = [process.env.LUXURY_TRAVEL_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync);
  assert.ok(executablePath, 'A browser is required for editor interaction verification');
  const value = await fixture();
  const runtime = createAgentPlannerServer({ port: 0, workspaceRoot: path.join(value.root, 'agent'),
    simpleRuntimeRoot: value.root, simpleStore: value.store, auth: { enabled: false },
    simpleRenderer: async ({ mode }) => ({ status: 'success', mode, outputPath: `${mode}.png`, rendererCalls: 1 }) });
  let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise(resolve => runtime.server.close(resolve));
    await rm(value.root, { recursive: true, force: true });
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: path.join(value.root, 'browser'), args: ['--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 720 });
  await page.goto(`http://127.0.0.1:${runtime.server.address().port}/simple/projects/${value.projectId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.editor-grid');
  return { ...value, page };
}

async function field(page, label, kind = 'textarea') {
  const handle = await page.evaluateHandle((label, kind) => [...document.querySelectorAll('.inspector-body label')]
    .find(node => node.textContent.startsWith(label))?.querySelector(kind), label, kind);
  assert.ok(handle.asElement(), `Missing editor field ${label}`);
  return handle.asElement();
}

async function replaceText(page, input, text) {
  await input.focus(); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace'); if (text) await page.keyboard.type(text);
}

test('manual experience title can be cleared, saved, reloaded and replaced without default regeneration', async t => {
  const value = await editor(t), { page } = value;
  await page.click('.day-nav-group > button');
  const added = page.waitForResponse(response => response.url().includes('/day-editor/0') && response.request().method() === 'PUT' && response.ok());
  await page.click('.day-section-heading .ws-button');
  await added;
  await page.waitForSelector('.day-card-editor-item.is-active .day-experience-fields');
  await page.waitForFunction(() => !document.querySelector('.manual-image-feedback')?.textContent?.includes('失败'));
  const input = await field(page, '体验名称', 'input');
  await replaceText(page, input, '');
  assert.equal(await input.evaluate(node => node.value), '', 'Clearing must not normalize into a numbered experience');
  await page.waitForResponse(response => response.url().includes('/day-editor/0') && response.request().method() === 'PUT' && response.ok());
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).data.days[0].spots.at(-1).name, '');
  await page.reload({ waitUntil: 'networkidle0' }); await page.click('.day-nav-group > button');
  await page.click('.day-card-editor-item:last-child .day-card-editor-summary');
  const reloaded = await field(page, '体验名称', 'input');
  assert.equal(await reloaded.evaluate(node => node.value), '');
  await replaceText(page, reloaded, '人工体验');
  await page.waitForResponse(response => response.url().includes('/day-editor/0') && response.request().method() === 'PUT' && response.ok());
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).data.days[0].spots.at(-1).name, '人工体验');
});

test('route textarea keeps Enter and blank draft lines while persisting normalized route nodes', async t => {
  const value = await editor(t), { page } = value;
  await page.click('.day-nav-group > button'); await page.click('.day-info-section .day-section-toggle');
  const input = await field(page, '路线节点');
  await replaceText(page, input, 'Nairobi');
  await page.keyboard.press('Enter');
  assert.equal(await input.evaluate(node => node.value), 'Nairobi\n');
  await page.keyboard.press('Enter'); await page.keyboard.type('Mara');
  assert.equal(await input.evaluate(node => node.value), 'Nairobi\n\nMara');
  await page.waitForResponse(response => response.url().includes('/day-editor/0') && response.request().method() === 'PUT' && response.ok());
  assert.deepEqual(value.store.getFinalResult(value.projectId, value.executionRunId).data.days[0].routeNodes, ['Nairobi', 'Mara']);
  await page.reload({ waitUntil: 'networkidle0' }); await page.click('.day-nav-group > button');
  await page.click('.day-info-section .day-section-toggle');
  const reloaded = await field(page, '路线节点');
  assert.equal(await reloaded.evaluate(node => node.value), 'Nairobi\nMara');
});

test('module visibility remains entirely inside short desktop viewports and outside scrollable content', async t => {
  const { page } = await editor(t);
  // Optional expenses has a long form and an enabled visibility switch.
  await page.click('.structure-panel nav > button[title="费用说明"]');
  for (const [width, height] of [[1440, 720], [1280, 600], [1024, 520], [900, 520]]) {
    await page.setViewport({ width, height });
    const geometry = await page.$eval('.module-toggle', node => {
      const rect = node.getBoundingClientRect(), body = node.parentElement.querySelector('.inspector-body');
      const bodyRect = body.getBoundingClientRect(), inputRect = node.querySelector('input').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: innerHeight,
        bodyBottom: bodyRect.bottom, switchBottom: inputRect.bottom,
        ancestors: ['.workspace-shell', '.editor-page', '.editor-grid', '.inspector-panel'].map(selector => {
          const element = document.querySelector(selector), bounds = element.getBoundingClientRect();
          return { selector, top: bounds.top, height: bounds.height, bottom: bounds.bottom };
        }) };
    });
    assert.ok(geometry.bottom <= height + 1, `${width}x${height}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.top >= 0 && geometry.height >= 78, 'Visibility footer must not shrink away');
    assert.ok(geometry.bodyBottom <= geometry.top + 1, 'Scrollable fields must not cover visibility controls');
    await page.$eval('.inspector-body', node => { node.scrollTop = node.scrollHeight; });
    const reachable = await page.$eval('.module-toggle .switch', node => {
      const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit && node.contains(hit);
    });
    assert.equal(reachable, true, 'Visibility switch must remain clickable after scrolling fields');
  }
  const checked = await page.$eval('.module-toggle input', node => node.checked);
  await page.click('.module-toggle .switch');
  await page.waitForFunction(previous => document.querySelector('.module-toggle input').checked !== previous, {}, checked);
  if (process.env.EDITOR_FEEDBACK_SCREENSHOT) await page.screenshot({ path: process.env.EDITOR_FEEDBACK_SCREENSHOT });
});
