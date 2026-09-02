import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { createProductionDefaultData } from "../src/lib/itineraryRules.js";

const [sourceValue, agentProjectId] = process.argv.slice(2);
const sourcePath = path.resolve(sourceValue || "");
if (!existsSync(sourcePath) || !agentProjectId) throw new Error("需要提供真实 Excel 路径与已有智能体项目 ID");

const bytes = readFileSync(sourcePath);
const recognition = await importItineraryWorkbook({
  name: path.basename(sourcePath),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
}, createProductionDefaultData());
const outputDir = path.resolve("../audit/evidence/2026-09-02-智能体接入原美化工具前端纠偏/页面截图");
mkdirSync(outputDir, { recursive: true });
const executablePath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error("未找到 Chrome/Edge");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto("http://127.0.0.1:4174/agent", { waitUntil: "networkidle0", timeout: 60000 });
  await page.evaluate(({ data, report, sourceName, projectId }) => {
    const user = { id: "visual-review", name: "视觉复核", login: "visualreview", pin: "123456", isAdmin: true, active: true };
    const project = {
      id: "visual-existing-project",
      flowKind: "agent_v1",
      agentProjectId: projectId,
      ownerId: user.id,
      title: data.title || "智能体前端视觉复核",
      customerName: "",
      requirements: "",
      data,
      recognition: report,
      files: [{ name: sourceName, size: 1, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
      workflowStage: "agent-planning",
      visibility: {},
      versions: [],
      updatedAt: Date.now(),
    };
    localStorage.clear();
    localStorage.setItem("sheyou-agent-users-v1", JSON.stringify([user]));
    localStorage.setItem("sheyou-agent-session-v1", JSON.stringify({ userId: user.id }));
    localStorage.setItem("sheyou-agent-projects-v1", JSON.stringify([project]));
  }, { data: recognition.data, report: recognition.report, sourceName: path.basename(sourcePath), projectId: agentProjectId });
  await page.reload({ waitUntil: "networkidle0", timeout: 60000 });
  await page.click(".project-row");
  await page.waitForSelector(".confirm-layout", { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".flow-footer .ws-button-primary")?.disabled, { timeout: 30000 });
  await page.click(".flow-footer .ws-button-primary");
  await page.waitForSelector(".agent-workspace-generation", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector(".agent-workspace-generation h1")?.textContent.includes("计划已经准备好"), { timeout: 30000 });
  const summaryText = await page.$eval(".workspace-agent-plan > summary", (element) => element.innerText.trim());
  const summaryLabelStyle = await page.$eval(".workspace-agent-plan > summary > small", (element) => {
    const style = getComputedStyle(element);
    return { display: style.display, color: style.color, fontSize: style.fontSize, opacity: style.opacity, visibility: style.visibility, width: element.getBoundingClientRect().width };
  });
  if (!summaryText.includes("查看本次规划") || !summaryText.includes("当前计划")) throw new Error(`规划折叠栏标题异常：${summaryText}`);
  await page.screenshot({ path: path.join(outputDir, "04-4174-智能体生成页.png"), fullPage: true });
  await page.click(".workspace-agent-plan > summary");
  await page.screenshot({ path: path.join(outputDir, "05-4174-生成页展开规划.png"), fullPage: true });
  console.log(JSON.stringify({ passed: true, agentProjectId, summaryText, summaryLabelStyle }, null, 2));
} finally {
  await browser.close();
}
