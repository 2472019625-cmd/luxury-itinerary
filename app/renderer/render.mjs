import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv.find((item) => item.startsWith("--width="));
const width = Number(arg?.split("=")[1] || 2000);
const datasetArg = process.argv.find((item) => item.startsWith("--dataset="));
const dataset = datasetArg?.split("=")[1] || "africa";
const dataFileArg = process.argv.find((item) => item.startsWith("--data-file="));
const dataFile = dataFileArg ? path.resolve(dataFileArg.slice("--data-file=".length)) : null;
const outputArg = process.argv.find((item) => item.startsWith("--output="));
const requestedOutput = outputArg ? path.resolve(outputArg.slice("--output=".length)) : null;
const qaArg = process.argv.find((item) => item.startsWith("--qa-output="));
const qaOutput = qaArg ? path.resolve(qaArg.slice("--qa-output=".length)) : null;
const originArg = process.argv.find((item) => item.startsWith("--origin="));
const origin = originArg?.slice("--origin=".length) || "http://127.0.0.1:4173";
if (![2000, 1080].includes(width)) throw new Error("width 仅支持 2000 或 1080");

const candidates = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePaths = [...new Set(candidates.filter((candidate) => fs.existsSync(candidate)))];
if (!executablePaths.length) throw new Error("未找到 Edge/Chrome。可通过 LUXURY_TRAVEL_BROWSER 指定浏览器路径。");

let browser = null;
const launchErrors = [];
for (const executablePath of executablePaths) {
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
    break;
  } catch (error) {
    launchErrors.push(`${path.basename(executablePath)}: ${error?.message || String(error)}`);
  }
}
if (!browser) throw new Error(`Edge/Chrome 均无法启动：${launchErrors.join(" | ")}`);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Math.max(2000, width), height: 1200, deviceScaleFactor: 1 });
  if (dataFile) {
    const workspaceData = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    await page.evaluateOnNewDocument((data) => {
      localStorage.setItem("sheyou-export-data-v1", JSON.stringify(data));
    }, workspaceData);
  }
  const url = `${origin}/?export=1&width=${width}&dataset=${encodeURIComponent(dataFile ? "workspace" : dataset)}`;
  await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    await Promise.all([...document.images].map((image) => image.decode?.().catch(() => undefined)));
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.scrollTo(0, 0);
  });
  const target = await page.$("#itinerary");
  if (!target) throw new Error("未找到 #itinerary 渲染节点");
  const output = requestedOutput || path.join(root, "output", `${dataset}-itinerary-${width}.png`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const box = await target.boundingBox();
  await target.screenshot({ path: output, type: "png", captureBeyondViewport: true });

  const layoutQa = await page.evaluate(() => {
    const root = document.querySelector('#itinerary');
    const selectorFor = (element) => element.id ? `#${element.id}` : element.dataset?.editPath ? `[data-edit-path="${element.dataset.editPath}"]` : `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join('.')}`;
    const overflows = [...root.querySelectorAll('h1,h2,h3,h4,p,span,strong,li,section,article')].filter((element) => element.scrollWidth > element.clientWidth + 8 || element.scrollHeight - element.clientHeight > Math.max(24, element.clientHeight * 0.25)).slice(0, 50).map((element) => ({ selector: selectorFor(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    const brokenImages = [...root.querySelectorAll('img')].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => ({ selector: selectorFor(image), src: image.getAttribute('src') || '' }));
    const blocks = [...root.children].map((element) => ({ selector: selectorFor(element), top: element.offsetTop, bottom: element.offsetTop + element.offsetHeight })).sort((a, b) => a.top - b.top);
    const largeGaps = blocks.slice(1).map((item, index) => ({ after: blocks[index].selector, before: item.selector, gap: item.top - blocks[index].bottom })).filter((item) => item.gap > 900);
    return { width: Math.round(root.getBoundingClientRect().width), height: Math.round(root.getBoundingClientRect().height), overflows, brokenImages, largeGaps, footerPresent: Boolean(root.querySelector('.brand-footer-fixed')) };
  });
  if (qaOutput) {
    fs.mkdirSync(path.dirname(qaOutput), { recursive: true });
    fs.writeFileSync(qaOutput, JSON.stringify(layoutQa, null, 2), 'utf8');
  }

  const footer = await page.$(".brand-footer-fixed");
  if (!footer) throw new Error('固定品牌页脚缺失');
  console.log(JSON.stringify({ output, width, renderedBox: box, layoutQa }, null, 2));
} finally {
  await browser.close();
}
