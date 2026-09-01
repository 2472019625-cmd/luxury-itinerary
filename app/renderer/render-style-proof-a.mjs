import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error("未找到 Edge/Chrome。");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 2000, height: 1800, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:4173/?styleProof=A", { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  const target = await page.$("#style-proof-a");
  if (!target) throw new Error("未找到 #style-proof-a 渲染节点");
  const output = path.join(root, "output", "style-proof-a-2000.png");
  await target.screenshot({ path: output, type: "png", captureBeyondViewport: true });
  const box = await target.boundingBox();
  console.log(JSON.stringify({ output, renderedBox: box }, null, 2));
} finally {
  await browser.close();
}
