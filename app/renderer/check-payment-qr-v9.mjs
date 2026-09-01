import fs from "node:fs";
import puppeteer from "puppeteer-core";

const candidates = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error("未找到 Edge/Chrome");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4173/?export=1&width=2000", { waitUntil: "networkidle0", timeout: 120000 });
  const result = await page.evaluate(async () => {
    if (!("BarcodeDetector" in window)) return { supported: false, decoded: false, reason: "浏览器未提供 BarcodeDetector" };
    const image = document.querySelector(".payment-qr");
    if (!image) return { supported: true, decoded: false, reason: "页面没有二维码" };
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const codes = await detector.detect(image);
    return { supported: true, decoded: codes.length > 0, rawValues: codes.map((code) => code.rawValue) };
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.supported && !result.decoded) process.exitCode = 1;
} finally {
  await browser.close();
}
