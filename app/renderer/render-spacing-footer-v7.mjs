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

  const sections = ["expense-section", "booking-section", "security-section", "notes-section"];
  for (const className of sections) {
    const clip = await page.evaluate((name) => {
      const section = document.querySelector(`.${name}`);
      const title = section?.querySelector(".section-title");
      if (!section || !title) return null;
      const sectionBox = section.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      return { x: 0, y: Math.max(0, titleBox.top - 45), width: 2000, height: Math.min(920, sectionBox.bottom - titleBox.top + 45) };
    }, className);
    if (!clip) throw new Error(`未找到 ${className}`);
    await page.screenshot({ path: path.join(root, "output", `proof-${className}-spacing-v7.png`), clip });
  }

  const footerClip = await page.evaluate(() => {
    const footer = document.querySelector(".brand-footer-fixed");
    if (!footer) return null;
    const box = footer.getBoundingClientRect();
    return { x: 0, y: Math.max(0, box.top - 360), width: 2000, height: Math.min(2500, document.documentElement.scrollHeight - box.top + 360) };
  });
  if (!footerClip) throw new Error("未找到固定页尾");
  await page.screenshot({ path: path.join(root, "output", "proof-footer-seam-v7.png"), clip: footerClip });
  console.log(JSON.stringify({ sections, footer: "output/proof-footer-seam-v7.png" }, null, 2));
} finally {
  await browser.close();
}
