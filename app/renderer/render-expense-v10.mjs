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
if (!executablePath) throw new Error("未找到 Edge/Chrome");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:4173/?export=1&width=2000", { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  const grid = await page.$(".expense-grid");
  if (!grid) throw new Error("未找到费用卡片");
  const output = path.join(root, "output", "proof-expense-keywords-v10.png");
  await grid.screenshot({ path: output, type: "png", captureBeyondViewport: true });
  const metrics = await page.evaluate(() => ({
    cards: document.querySelectorAll(".expense-grid .list-card").length,
    keywords: [...document.querySelectorAll(".expense-grid .list-keyword")].map((node) => node.textContent.trim()),
    keywordFont: getComputedStyle(document.querySelector(".expense-grid .list-keyword")).fontFamily,
  }));
  console.log(JSON.stringify({ output, metrics }, null, 2));
} finally {
  await browser.close();
}
