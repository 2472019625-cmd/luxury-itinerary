import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePaths = [...new Set(candidates.filter((candidate) => fs.existsSync(candidate)))];
if (!executablePaths.length) throw new Error("未找到 Edge/Chrome");

const scenarios = ["short", "standard", "long", "no-images", "four-images", "composite-images", "long-copy", "missing-services", "no-payment", "no-security", "payment-no-qr"];
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
if (!browser) throw new Error(`Edge/Chrome 均无法启动：${launchErrors.join(' | ')}`);
const results = [];

try {
  for (const scenario of scenarios) {
    const page = await browser.newPage();
    await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:4173/?export=1&width=2000&scenario=${scenario}`, { waitUntil: "networkidle0", timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);
    const metrics = await page.evaluate(() => {
      const canvas = document.querySelector("#itinerary");
      const missingImages = [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src);
      const overflowing = [...canvas.querySelectorAll("*")].filter((element) => element.scrollWidth > element.clientWidth + 2).map((element) => element.className || element.tagName).slice(0, 12);
      return {
        width: Math.round(canvas.getBoundingClientRect().width),
        height: Math.round(canvas.getBoundingClientRect().height),
        dayCount: canvas.querySelectorAll(".day-section").length,
        spotCardCount: canvas.querySelectorAll(".spot-card").length,
        serviceTagCount: canvas.querySelectorAll(".service-tags > span").length,
        missingImages,
        overflowing,
        slogan: canvas.querySelector(".slogan-lockup")?.textContent?.trim(),
        fontStatus: document.fonts.status,
        securitySectionCount: canvas.querySelectorAll(".security-section").length,
        paymentVisualCount: canvas.querySelectorAll(".payment-visual").length,
        paymentQrCount: canvas.querySelectorAll(".payment-qr").length,
        paymentFallback: canvas.querySelector(".payment-account-lines")?.textContent?.trim() || "",
      };
    });
    results.push({ scenario, ...metrics, consoleErrors: errors });
    await page.close();
  }
} finally {
  await browser.close();
}

const failures = results.filter((item) => {
  const wrongVisibility = item.scenario === "no-security"
    ? item.securitySectionCount !== 0
    : item.securitySectionCount !== 1 || (item.scenario === "no-payment" ? item.paymentVisualCount !== 0 : item.paymentVisualCount !== 1);
  const wrongQrFallback = item.scenario === "payment-no-qr"
    ? item.paymentQrCount !== 0 || item.paymentFallback !== "以正式合同所附账户为准"
    : item.scenario !== "no-payment" && item.scenario !== "no-security" && item.paymentQrCount !== 1;
  return item.width !== 2000 || item.missingImages.length || item.overflowing.length || item.consoleErrors.length || item.slogan !== "高品质度假管家，懂度假，更懂你" || item.fontStatus !== "loaded" || wrongVisibility || wrongQrFallback;
});
const output = path.join(root, "output", "dynamic-test-results.json");
fs.writeFileSync(output, `${JSON.stringify({ passed: failures.length === 0, results }, null, 2)}\n`);
console.log(JSON.stringify({ output, passed: failures.length === 0, results }, null, 2));
if (failures.length) process.exitCode = 1;
