import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { imageResolutionPolicyForSlot } from '../server/image-download.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((value) => value && existsSync(value));

test('DAY resolution policy follows actual 2000px gallery frames from one to four cards', { skip: !browserPath }, async () => {
  const css = await readFile(path.join(appRoot, 'src/styles.css'), 'utf8');
  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
    for (const count of [1, 2, 3, 4]) {
      const cards = Array.from({ length: count }, () => '<article class="spot-card"><div class="spot-image"><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22850%22 height=%22550%22/%3E"></div><div class="spot-copy">体验</div></article>').join('');
      await page.setContent(`<style>${css}</style><div class="itinerary-canvas"><section class="day-section"><div class="day-body"><div class="spot-galleries"><div class="spot-gallery spot-count-${count}">${cards}</div></div></div></section></div>`);
      const frames = await page.$$eval('.spot-image img', (images) => images.map((image) => {
        const box = image.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }));
      assert.equal(frames.length, count);
      for (const [index, frame] of frames.entries()) {
        const policy = imageResolutionPolicyForSlot({ moduleType: 'day', dayCardCount: count, dayCardIndex: index });
        assert.equal(policy.minWidth, Math.ceil(frame.width / 1.35));
        if (count === 3 && index === 2) {
          // The editorial third card may grow with source aspect ratio or copy.
          // Its fixed minimum is 470px; final DOM QA measures any extra growth.
          assert.equal(policy.minHeight, Math.ceil(470 / 1.35));
          assert.ok(frame.height >= 470);
        } else {
          assert.equal(policy.minHeight, Math.ceil(frame.height / 1.35), JSON.stringify({ count, index, frame, policy }));
        }
      }
      if (count <= 2) {
        const scale = Math.max(frames[0].width / 850, frames[0].height / 550);
        assert.equal(scale <= 1.35, count === 2);
      }
    }
  } finally {
    await browser.close();
  }
});
