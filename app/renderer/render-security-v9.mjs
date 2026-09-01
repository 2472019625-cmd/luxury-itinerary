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
  const section = await page.$(".security-section");
  if (!section) throw new Error("未找到资金安全与支付组件");
  const output = path.join(root, "output", `proof-security-payment-v9-${width}.png`);
  await section.screenshot({ path: output, type: "png", captureBeyondViewport: true });
  const metrics = await page.evaluate(() => {
    const titleArea = document.querySelector(".security-title-area");
    const payment = document.querySelector(".payment-visual");
    const qr = document.querySelector(".payment-qr");
    const heading = document.querySelector(".payment-heading > span");
    const account = document.querySelector(".payment-account-lines");
    const box = (element) => element ? (() => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height }; })() : null;
    return {
      titleArea: box(titleArea),
      payment: { ...box(payment), borderRadius: getComputedStyle(payment).borderRadius },
      qr: box(qr),
      fonts: {
        paymentHeading: getComputedStyle(heading).fontSize,
        account: getComputedStyle(account).fontSize,
      },
      hasQr: Boolean(qr),
      accountLines: document.querySelectorAll(".payment-account-lines p").length,
      cardCount: document.querySelectorAll(".payment-visual dl, .payment-visual [class*='card']").length,
    };
  });
  await page.close();
  return { output, metrics };
}

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
try {
  const desktop = await capture(browser, 2000);
  const mobile = await capture(browser, 1080);
  console.log(JSON.stringify({ desktop, mobile }, null, 2));
} finally {
  await browser.close();
}
