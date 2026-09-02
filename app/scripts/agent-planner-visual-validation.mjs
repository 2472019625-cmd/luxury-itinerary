import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

let projectIds = process.argv.slice(2).filter((item) => !item.startsWith("--"));
if (!projectIds.length) {
  const projectRoot = path.resolve("workspace/agent-v1/projects");
  projectIds = readdirSync(projectRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => {
    const file = path.join(projectRoot, item.name, "project.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }).filter((project) => project?.activePlanId).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 3).map((project) => project.projectId);
}
if (!projectIds.length) throw new Error("没有找到已通过校验的真实规划项目");
const outputArg = process.argv.find((item) => item.startsWith("--output="));
const outputDir = path.resolve(outputArg?.slice("--output=".length) || "../audit/evidence/2026-09-02-可视化自主影子规划器MVP/页面截图");
mkdirSync(outputDir, { recursive: true });
const candidates = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error("未找到可用于页面验收的 Chrome/Edge");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
const results = [];
try {
  for (const [index, projectId] of projectIds.entries()) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    const url = `http://127.0.0.1:4174/agent-planner?project=${encodeURIComponent(projectId)}`;
    const response = await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(".agent-plan", { timeout: 30000 });
    const check = await page.evaluate(() => {
      const text = document.body.innerText;
      const technical = document.querySelector("details pre")?.textContent || "";
      return {
        title: document.querySelector(".agent-plan-heading h1")?.textContent || "",
        planId: document.querySelector(".agent-plan-heading code")?.textContent || "",
        sectionCount: document.querySelectorAll(".agent-section").length,
        dynamicTaskText: [...document.querySelectorAll(".agent-section")].find((section) => section.innerText.includes("任务怎样同时进行"))?.innerText || "",
        hasForbiddenAction: /开始正式生成|进入编辑器|导出客户成品/.test(text),
        hasExecutionOffNotice: text.includes("执行开关已关闭") && text.includes("只做规划，不会开始生成成品"),
        hasInternalReasoning: /内部推理|system prompt|api[_ ]?key/i.test(text),
        hasError: Boolean(document.querySelector(".agent-error")),
        activePlanTraceable: technical.includes(`\"activePlanId\": \"${document.querySelector(".agent-plan-heading code")?.textContent || "missing"}\"`),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    const screenshot = path.join(outputDir, `${String(index + 1).padStart(2, "0")}-${projectId.slice(0, 8)}-规划页面.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({ projectId, url, httpStatus: response?.status() || null, screenshot, ...check });
    await page.close();
  }
} finally { await browser.close(); }

const failed = results.filter((item) => item.httpStatus !== 200 || item.sectionCount !== 9 || item.hasForbiddenAction || !item.hasExecutionOffNotice || item.hasInternalReasoning || item.hasError || !item.activePlanTraceable || item.horizontalOverflow);
writeFileSync(path.join(outputDir, "visual-validation.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), results, passed: failed.length === 0 }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputDir, results, passed: failed.length === 0 }, null, 2));
if (failed.length) process.exitCode = 1;
