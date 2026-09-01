import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const evidenceDir = path.join(root, "..", "audit", "evidence", "2026-08-28-first-batch-fix");
const data = JSON.parse(fs.readFileSync(path.join(evidenceDir, "generated-data-final.json"), "utf8"));
const executablePath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find(fs.existsSync);
if (!executablePath) throw new Error("未找到 Edge/Chrome");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate((projectData) => {
    const user = { id: "scroll-audit", name: "滚动回归", login: "scroll-audit", pin: "246810", active: true };
    const project = { id: "scroll-project", ownerId: user.id, title: projectData.title, data: projectData, files: [], workflowStage: "generated", versions: [], updatedAt: Date.now() };
    localStorage.setItem("sheyou-workspace-users-v1", JSON.stringify([user]));
    localStorage.setItem("sheyou-workspace-session-v1", JSON.stringify({ userId: user.id }));
    localStorage.setItem("sheyou-workspace-projects-v1", JSON.stringify([project]));
  }, data);
  await page.reload({ waitUntil: "networkidle0" });
  await page.click(".project-row");
  await page.waitForSelector(".canvas-stage", { timeout: 120000 });
  await page.focus(".canvas-stage");
  const readScroll = () => page.$eval(".canvas-stage", (stage) => ({ top: stage.scrollTop, clientHeight: stage.clientHeight, scrollHeight: stage.scrollHeight }));
  const initial = await readScroll();
  await page.keyboard.press("PageDown");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const pageDown = await readScroll();
  await page.keyboard.press("End");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const end = await readScroll();
  await page.keyboard.press("Home");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const home = await readScroll();
  const result = {
    initial,
    pageDown,
    end,
    home,
    passed: pageDown.top > initial.top && end.top + end.clientHeight >= end.scrollHeight - 4 && home.top <= 4,
  };
  fs.writeFileSync(path.join(evidenceDir, "scroll-validation.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  await browser.close();
}
