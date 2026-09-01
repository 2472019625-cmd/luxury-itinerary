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

async function capture(browser, width) {
  const page = await browser.newPage();
  await page.setViewport({ width: Math.max(2000, width), height: 1200, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:4173/?export=1&width=${width}`, { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  const clip = await page.evaluate(() => {
    const section = document.querySelector(".booking-section");
    const title = section?.querySelector(".section-title");
    const card = section?.querySelector(".booking-flow");
    if (!section || !title || !card) return null;
    const titleBox = title.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return { x: 0, y: Math.max(0, titleBox.top), width: document.querySelector("#itinerary").getBoundingClientRect().width, height: cardBox.bottom - titleBox.top };
  });
  if (!clip) throw new Error("未找到预订流程组件");
  const output = path.join(root, "output", `proof-booking-component-v8-${width}.png`);
  await page.screenshot({ path: output, clip });
  const metrics = await page.evaluate(() => {
    const card = document.querySelector(".booking-flow");
    const nodes = [...document.querySelectorAll(".booking-step > strong")];
    const endpoint = document.querySelector(".booking-copy");
    const title = document.querySelector(".booking-copy h3");
    const copy = document.querySelector(".booking-copy p");
    const nodeCenters = nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const cardBox = card.getBoundingClientRect();
    const nodeBox = nodes[0].getBoundingClientRect();
    const titleStyle = getComputedStyle(title);
    const copyStyle = getComputedStyle(copy);
    return {
      card: { width: cardBox.width, height: cardBox.height, radius: getComputedStyle(card).borderRadius },
      node: { width: nodeBox.width, height: nodeBox.height, fontSize: getComputedStyle(nodes[0]).fontSize, fontWeight: getComputedStyle(nodes[0]).fontWeight },
      centerDistances: nodeCenters.slice(1).map((center, index) => Math.round((center - nodeCenters[index]) * 100) / 100),
      endpointSize: getComputedStyle(endpoint, "::before").width,
      connectorThickness: getComputedStyle(endpoint, "::after").height,
      title: { fontSize: titleStyle.fontSize, fontWeight: titleStyle.fontWeight, background: titleStyle.backgroundColor, marginBottom: titleStyle.marginBottom },
      copy: { fontSize: copyStyle.fontSize, fontWeight: copyStyle.fontWeight, background: copyStyle.backgroundColor },
    };
  });
  await page.close();
  return { output, clip, metrics };
}

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
try {
  const desktop = await capture(browser, 2000);
  const mobile = await capture(browser, 1080);
  console.log(JSON.stringify({ desktop, mobile }, null, 2));
} finally {
  await browser.close();
}
