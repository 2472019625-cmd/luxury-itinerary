import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import * as XLSX from "xlsx";

const browserPath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((candidate) => candidate && fs.existsSync(candidate));
if (!browserPath) throw new Error("未找到浏览器");

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ["肯尼亚8日顶奢（8.4W起）"],
  ["海报下方亮点"],
  ["顶奢连住｜国际品牌+私保营地"],
  ["天数", "日期", "路线", "行程内容", "早餐", "午餐", "晚餐", "住宿", "交通"],
  ["D1", "2026-10-15", "内罗毕→安博塞利", "接机并前往营地", "酒店早餐", "机上午餐", "营地晚餐", "Angama Amboseli", "商务车"],
  ["D2", "2026-10-16", "安博塞利", "全天私人游猎", "营地早餐", "丛林早餐", "星空晚宴", "Angama Amboseli", "4x4游猎车"],
  ["海报价83,880元/人起"],
  ["内部成本70,000元，按2人1车1间房测算"],
]), "行程");
const file = path.join(os.tmpdir(), `luxury-travel-import-${Date.now()}.xlsx`);
fs.writeFileSync(file, Buffer.from(XLSX.write(workbook, { type: "array", bookType: "xlsx" })));

const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle0" });
  await page.$$eval(".auth-tabs button", (buttons) => buttons[1].click());
  const inputs = await page.$$(".auth-panel input");
  await inputs[0].type("SHEYOU2026");
  await inputs[1].type("测试定制师");
  await inputs[2].type("tester");
  await inputs[3].type("123456");
  await page.click('.auth-panel button[type="submit"]');
  await page.waitForSelector(".projects-page");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("新建行程"))?.click());
  await page.waitForSelector('.upload-zone input[type="file"]');
  const uploader = await page.$('.upload-zone input[type="file"]');
  await uploader.uploadFile(file);
  await page.waitForSelector(".recognition-strip", { timeout: 30000 });
  const summary = await page.$eval(".recognition-strip", (element) => element.textContent);
  assert.match(summary, /2逐日行程/);
  assert.match(summary, /1内部信息已隔离/);
  await page.screenshot({ path: "output/qa-generator-upload.png", fullPage: true });
  console.log(JSON.stringify({ passed: true, summary, screenshot: "output/qa-generator-upload.png" }, null, 2));
} finally {
  await browser.close();
  fs.rmSync(file, { force: true });
}
