import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.AGENT_PREVIEW_URL || "http://127.0.0.1:4174";
const outputDir = path.resolve(process.argv[2] || "../audit/evidence/2026-09-08-generation-state-ui");
const executablePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const updatedAt = new Date().toISOString();
const createdAt = new Date(Date.now() - (8 * 60 + 20) * 1000).toISOString();

const stageDefinitions = [
  ["parser", "资料解析"],
  ["planner", "整程规划"],
  ["copy_skill", "文案生成"],
  ["image_skill", "图片处理"],
  ["program_writeback", "结果写回"],
  ["renderer", "成品渲染"],
];

function snapshot(mode) {
  const status = mode === "running" ? "running" : mode === "completed" ? "complete" : "failed";
  const stageStatuses = mode === "running"
    ? ["complete", "complete", "running", "running", "pending", "pending"]
    : mode === "completed"
      ? stageDefinitions.map(() => "complete")
      : ["complete", "complete", "failed", "pending", "pending", "pending"];
  const progress = mode === "completed" ? 100 : 54;
  return {
    project: {
      projectId: `state-${mode}`,
      flowKind: "simple_skill_v1",
      status,
      progress,
      currentStage: mode === "failed" ? "Copy Skill failure" : mode === "completed" ? "complete" : "copy_skill",
      createdAt,
      updatedAt,
      lastError: mode === "failed" ? "copy_request_failed: upstream response ended before a valid result was returned" : null,
      factBasis: { destination: "肯尼亚", coreExperiences: ["顶奢连住", "C位蹲守", "私人保护区游猎", "草原飞机接驳"] },
    },
    plan: {
      planId: "preview-plan",
      planVersion: "preview",
      preparedData: { title: "肯尼亚8日顶奢" },
      copyTasks: new Array(12).fill({}),
      imageSlots: new Array(28).fill({}),
    },
    executionRun: {
      executionRunId: `run-${mode}`,
      status,
      progress,
      createdAt,
      updatedAt,
      error: mode === "failed" ? { code: "copy_request_failed", message: "upstream response ended before a valid result was returned" } : null,
      events: [],
    },
    activeJob: {
      status,
      progress,
      createdAt,
      updatedAt,
      completedActions: mode === "completed" ? 40 : 18,
      totalWorkItems: 40,
      currentAction: mode === "running" ? "正在完善第 5 天的客户版行程介绍" : mode === "completed" ? "客户版行程已制作完成" : "文案生成任务已停止",
      error: mode === "failed" ? "copy_request_failed: upstream response ended before a valid result was returned" : null,
      imageSlotProgress: { completed: mode === "completed" ? 28 : 22, total: 28 },
      stages: stageDefinitions.map(([id, label], index) => ({ id, label, status: stageStatuses[index] })),
    },
  };
}

await mkdir(outputDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu"], defaultViewport: { width: 1600, height: 1050, deviceScaleFactor: 1 } });

try {
  for (const mode of ["running", "failed", "completed"]) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().includes(`/api/simple/projects/state-${mode}`)) {
        request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot(mode)) });
      } else request.continue();
    });
    await page.goto(`${baseUrl}/agent`, { waitUntil: "domcontentloaded" });
    await page.evaluate(({ mode, createdAt }) => {
      const user = { id: "preview-user", name: "苏苏", login: "preview", pin: "000000", isAdmin: true, active: true };
      const project = {
        id: `local-${mode}`,
        flowKind: "simple_skill_v1",
        agentProjectId: `state-${mode}`,
        ownerId: user.id,
        title: "肯尼亚8日顶奢",
        workflowStage: "simple-running",
        updatedAt: Date.parse(createdAt),
        files: [{ name: "肯尼亚8日顶奢.xlsx", size: 1024 }],
        versions: [],
        data: { title: "肯尼亚8日顶奢", destination: "肯尼亚", days: new Array(8).fill({}), highlights: ["顶奢连住", "C位蹲守", "私人保护区游猎", "草原飞机接驳"] },
      };
      localStorage.setItem("sheyou-agent-users-v1", JSON.stringify([user]));
      localStorage.setItem("sheyou-agent-session-v1", JSON.stringify({ userId: user.id }));
      localStorage.setItem("sheyou-agent-projects-v1", JSON.stringify([project]));
    }, { mode, createdAt });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".project-row");
    await page.click(".project-row");
    await page.waitForSelector(`.agent-progress-card-${mode}`);
    await page.evaluate(() => document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outputDir, `${mode}.png`), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(outputDir);
