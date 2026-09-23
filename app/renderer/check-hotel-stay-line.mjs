import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(root, "..", "workspace", "output", "qa");
const output = path.join(outputDir, "hotel-stay-line.png");
const browserPath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((candidate) => candidate && fs.existsSync(candidate));

if (!browserPath) throw new Error("未找到 Edge/Chrome");
fs.mkdirSync(outputDir, { recursive: true });

const baseUrl = process.env.LUXURY_TRAVEL_BASE_URL || "http://127.0.0.1:4174";
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/session") request.respond({ status: 200, contentType: "application/json", body: '{"enabled":false}' });
    else request.continue();
  });
  await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/?export=1&width=2000&dataset=kenya-luxury-8d`, { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".hotels-section", { timeout: 30000 }).catch(async () => {
    throw new Error(`酒店模块未渲染；页面错误：${pageErrors.join(" | ") || "无"}；正文：${(await page.$eval("body", (body) => body.innerText)).slice(0, 500)}`);
  });
  const metrics = await page.evaluate(() => {
    const section = document.querySelector(".hotels-section");
    const lines = [...document.querySelectorAll(".hotel-stay-line")].map((line) => ({
      text: line.textContent.trim(),
      clientWidth: line.clientWidth,
      scrollWidth: line.scrollWidth,
      height: line.getBoundingClientRect().height,
      fontSize: getComputedStyle(line).fontSize,
      whiteSpace: getComputedStyle(line).whiteSpace,
    }));
    return {
      oldKickerCount: document.querySelectorAll(".hotel-kicker").length,
      stayPillCount: document.querySelectorAll(".hotel-stay-pill").length,
      cardCount: document.querySelectorAll(".hotels-section .hotel-card").length,
      lines,
      sectionRect: section && { x: section.getBoundingClientRect().x, y: section.getBoundingClientRect().y, width: section.getBoundingClientRect().width, height: section.getBoundingClientRect().height },
    };
  });
  if (metrics.oldKickerCount !== 0) throw new Error(`仍存在 ${metrics.oldKickerCount} 个旧地区/晚数标签`);
  if (metrics.lines.length !== metrics.cardCount) throw new Error(`酒店卡 ${metrics.cardCount} 张，但入住动线仅 ${metrics.lines.length} 条`);
  if (metrics.stayPillCount !== metrics.cardCount) throw new Error(`酒店卡 ${metrics.cardCount} 张，但住宿节奏胶囊仅 ${metrics.stayPillCount} 个`);
  const overflowing = metrics.lines.filter((line) => line.scrollWidth > line.clientWidth + 1 || line.height > 40);
  if (overflowing.length) throw new Error(`入住动线发生溢出或换行：${JSON.stringify(overflowing)}`);
  const section = await page.$(".hotels-section");
  await section.screenshot({ path: output, type: "png", captureBeyondViewport: true });
  console.log(JSON.stringify({ passed: true, output, ...metrics }, null, 2));
} finally {
  await browser.close();
}
