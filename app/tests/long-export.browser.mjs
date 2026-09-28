// Pixel-level browser regression: a DOM-only check cannot detect a blank PNG tail.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { captureLongElement } from "../renderer/capture-long-element.mjs";

const argument = process.argv.find((item) => item.startsWith("--runtime-dir="));
assert.ok(argument, "Registered external runtime directory required");
const root = await realpath(argument.slice("--runtime-dir=".length));
const relative = path.relative(path.resolve(import.meta.dirname, "../.."), root);
assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "Runtime must be outside repository");
const executablePath = [process.env.LUXURY_TRAVEL_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((item) => item && existsSync(item));
const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: path.join(root, "browser-profile"), args: ["--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
  await page.setContent('<style>html,body{margin:0}#itinerary{position:relative;width:2000px;height:73674px;background:#fff}.marker{position:absolute;left:0;width:2000px;height:200px}</style><div id="itinerary"><div class="marker" style="top:0;background:#ff0000"></div><div class="marker" style="top:65500px;background:#00ff00"></div><div class="marker" style="top:73474px;background:#0000ff"></div></div>');
  const target = await page.$("#itinerary");
  const { png, capture } = await captureLongElement(page, target);
  await writeFile(path.join(root, "long-export.png"), png, { flag: "wx" });
  assert.equal(capture.mode, "viewport_tiles");
  const dimensions = await sharp(png).metadata();
  assert.equal(dimensions.width, 2000);
  assert.equal(dimensions.height, 73674);
  for (const [y, expected] of [[100, [255, 0, 0]], [65600, [0, 255, 0]], [73573, [0, 0, 255]]]) {
    const pixel = await sharp(png).extract({ left: 1000, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], expected, `Actual PNG pixel at y=${y}`);
  }
  await page.$eval("#itinerary", (element) => { element.style.height = "1200px"; element.querySelectorAll(".marker")[2].style.top = "1000px"; element.querySelectorAll(".marker")[1].remove(); });
  const short = await captureLongElement(page, target);
  assert.equal(short.capture.mode, "single");
  const bottom = await sharp(short.png).extract({ left: 1000, top: 1100, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...bottom], [0, 0, 255]);
  const summary = { outcome: "PASS", capture, checks: ["2000x73674 exact size", "top pixel", "pixel beyond 65535", "last-page pixel", "short export unchanged"] };
  await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
}
