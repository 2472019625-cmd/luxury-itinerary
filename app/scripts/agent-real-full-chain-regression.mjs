import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { createProductionDefaultData, normalizeItineraryFacts, validateItineraryFacts } from "../src/lib/itineraryRules.js";

const source = path.resolve(process.argv.find((value) => value.startsWith("--input="))?.slice(8) || "");
const origin = process.argv.find((value) => value.startsWith("--origin="))?.slice(9) || "http://127.0.0.1:4174";
if (!existsSync(source)) throw new Error("必须通过 --input= 提供一份存在的真实供应商 Excel");

const appRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(appRoot, "..");
const evidenceDir = path.join(projectRoot, "audit", "evidence", "2026-09-02-智能体六项能力接通与完整生成链路", "真实项目全链路回归");
mkdirSync(evidenceDir, { recursive: true });

const executablePath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error("未找到 Chrome/Edge");

const workbookBuffer = await readFile(source);
const workbookFile = new File([workbookBuffer], path.basename(source), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const imported = await importItineraryWorkbook(workbookFile, createProductionDefaultData());
const facts = normalizeItineraryFacts(imported.data);
const validation = validateItineraryFacts(facts);
writeFileSync(path.join(evidenceDir, "01-真实输入与确定性解析.json"), `${JSON.stringify({
  source,
  sourceName: path.basename(source),
  importedAt: new Date().toISOString(),
  report: imported.report,
  validation,
  coverage: {
    destination: facts.destination,
    dayCount: facts.days?.length || 0,
    hotelCount: new Set((facts.days || []).map((day) => day.hotel).filter(Boolean)).size,
    routeCount: (facts.days || []).filter((day) => day.route || day.routeNodes?.length).length,
    includedCount: facts.included?.length || 0,
    excludedCount: facts.excluded?.length || 0,
    hasInternalFormulaRisk: true,
  },
}, null, 2)}\n`);
if (!validation.valid) throw new Error(`真实输入确定性校验未通过：${validation.errors.join("；")}`);

const browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 1_800_000, args: ["--disable-gpu", "--font-render-hinting=none"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

const snapshots = [];
const runtimeDecisions = [];
let projectId = null;

async function fetchProject() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/agent/projects/${projectId}`);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "读取智能体项目失败");
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

async function saveProgressScreenshot(name) {
  await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
}

async function resolveRuntimeConfirmations(snapshot) {
  const pending = (snapshot.confirmations || []).filter((item) => item.status === "pending");
  if (!pending.length) return false;
  const decisions = pending.map((item) => {
    const choice = item.choices.find((candidate) => candidate.recommended) || item.choices[0];
    return { confirmationId: item.confirmationId, choiceId: choice?.choiceId };
  });
  const imageWaits = decisions.filter((item) => String(item.choiceId).startsWith("wait_for_image:"));
  if (imageWaits.length) {
    writeFileSync(path.join(evidenceDir, "07-必需图片位待处理.json"), `${JSON.stringify({ projectId, pending, decisions }, null, 2)}\n`);
    throw new Error(`真实项目有 ${imageWaits.length} 个必需图片位未自动通过，已保留候选证据，不能伪造完成`);
  }
  const response = await fetch(`${origin}/api/agent/projects/${projectId}/confirmations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "保存运行时确认失败");
  runtimeDecisions.push(...decisions);
  return true;
}

try {
  await page.goto(`${origin}/agent`, { waitUntil: "networkidle0", timeout: 120_000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0", timeout: 120_000 });
  await page.click(".auth-tabs button:nth-child(2)");
  const inputs = await page.$$(".auth-panel form input");
  for (const [index, value] of ["SHEYOU2026", "智能体真实回归", `agent-real-${Date.now()}`, "246810"].entries()) await inputs[index].type(value);
  await page.click('.auth-panel form button[type="submit"]');
  await page.waitForSelector(".projects-page", { timeout: 30_000 });
  await page.click(".projects-heading .ws-button-primary");
  await page.waitForSelector(".upload-zone");
  await saveProgressScreenshot("02-智能体独立工作区上传页.png");

  const picker = await page.$('.upload-zone input[type="file"]');
  await picker.uploadFile(source);
  await page.waitForSelector(".recognition-strip", { timeout: 120_000 });
  await page.click(".flow-footer .ws-button-primary");
  await page.waitForSelector(".confirm-layout", { timeout: 120_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector(".flow-footer .ws-button-primary");
    return button && !button.disabled;
  }, { timeout: 120_000 });
  await saveProgressScreenshot("03-真实资料确认与生成前门禁.png");
  await page.click(".flow-footer .ws-button-primary");
  await page.waitForSelector(".agent-workspace-generation", { timeout: 120_000 });

  projectId = await page.evaluate(() => {
    const projects = JSON.parse(localStorage.getItem("sheyou-agent-projects-v1") || "[]");
    return projects.find((item) => item.agentProjectId)?.agentProjectId || null;
  });
  if (!projectId) throw new Error("前端未保存智能体项目标识");

  const started = Date.now();
  let lastKey = "";
  let complete = null;
  let capturedMidRun = false;
  while (Date.now() - started < 90 * 60 * 1000) {
    const snapshot = await fetchProject();
    const key = JSON.stringify({ status: snapshot.project.status, stage: snapshot.project.currentStage, percent: snapshot.executionRun?.progress?.percent, taskStatuses: snapshot.executionRun?.taskRuns?.map((item) => item.status) });
    if (key !== lastKey) {
      snapshots.push({ at: new Date().toISOString(), status: snapshot.project.status, currentStage: snapshot.project.currentStage, progress: snapshot.executionRun?.progress, latestEvent: snapshot.executionRun?.events?.at(-1) || null });
      lastKey = key;
      process.stdout.write(`${snapshot.executionRun?.progress?.percent || 0}% ${snapshot.project.status} ${snapshot.project.currentStage}\n`);
    }
    if (!capturedMidRun && Number(snapshot.executionRun?.progress?.percent || 0) > 10) {
      await saveProgressScreenshot("04-七阶段真实进度总览.png");
      capturedMidRun = true;
    }
    if (snapshot.project.status === "awaiting_confirmation") {
      await saveProgressScreenshot("05-运行时关键确认门禁.png");
      await resolveRuntimeConfirmations(snapshot);
    } else if (snapshot.project.status === "ready_for_editor") {
      complete = snapshot;
      break;
    } else if (["execution_failed", "planning_failed", "cancelled"].includes(snapshot.project.status)) {
      writeFileSync(path.join(evidenceDir, "09-失败现场.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
      throw new Error(snapshot.project.lastError || `真实项目终止：${snapshot.project.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  if (!complete) throw new Error("真实项目全链路回归超过90分钟");

  writeFileSync(path.join(evidenceDir, "06-执行进度与关键确认.json"), `${JSON.stringify({ projectId, snapshots, runtimeDecisions }, null, 2)}\n`);
  writeFileSync(path.join(evidenceDir, "08-完整项目执行快照.json"), `${JSON.stringify(complete, null, 2)}\n`);

  await page.waitForSelector(".editor-grid", { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  await saveProgressScreenshot("10-百分百后自动进入原编辑器.png");
  const ui = await page.evaluate(() => {
    const projects = JSON.parse(localStorage.getItem("sheyou-agent-projects-v1") || "[]");
    const project = projects.find((item) => item.agentProjectId);
    return {
      stepLabels: [...document.querySelectorAll(".step-item strong")].map((item) => item.textContent),
      hasAgentModeStrip: Boolean(document.querySelector(".agent-mode-strip")),
      hasEditor: Boolean(document.querySelector(".editor-grid")),
      brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.alt || image.src),
      project: project ? { id: project.id, agentProjectId: project.agentProjectId, workflowStage: project.workflowStage, versionCount: project.versions?.length || 0, title: project.title } : null,
      storageKeys: Object.keys(localStorage).sort(),
    };
  });

  const run = complete.executionRun;
  const stats = Object.fromEntries((run.capabilityCallStats || []).map((item) => [item.capabilityId, item]));
  const assertions = {
    projectReadyForEditor: complete.project.status === "ready_for_editor",
    progressExactly100: run.progress?.percent === 100,
    allStagesComplete: run.progress?.stages?.every((item) => item.state === "complete"),
    brandReviewerExactlyOnce: stats.brand_reviewer?.actualCalls === 1,
    factSearchActuallyCalled: (stats.web_fact_search?.actualCalls || 0) >= 1,
    imageSearchActuallyCalled: (stats.image_search?.actualCalls || 0) >= 1,
    visualAuditActuallyCalled: (stats.visual_auditor?.actualCalls || 0) >= 1,
    copyWriterActuallyCalled: (stats.copy_writer?.actualCalls || 0) >= 1,
    outputIs2000px: complete.result?.width === 2000,
    finalQaPassed: complete.result?.finalQa?.passed === true,
    imageGatePassed: complete.result?.imageGate?.passed === true,
    originalFiveStepsRetained: JSON.stringify(ui.stepLabels) === JSON.stringify(["上传资料", "确认信息", "生成内容", "编辑预览", "下载版本"]),
    originalEditorEntered: ui.hasEditor,
    noBrokenImages: ui.brokenImages.length === 0,
    isolatedAgentStorage: ui.storageKeys.some((key) => key.startsWith("sheyou-agent-")) && !ui.storageKeys.some((key) => key.startsWith("sheyou-workspace-")),
    finalOutputDownloadable: false,
  };
  const outputResponse = await fetch(`${origin}/api/agent/projects/${projectId}/output`);
  assertions.finalOutputDownloadable = outputResponse.ok && String(outputResponse.headers.get("content-type") || "").includes("image/png");
  if (outputResponse.ok) writeFileSync(path.join(evidenceDir, "11-真实项目最终成品-2000px.png"), Buffer.from(await outputResponse.arrayBuffer()));
  const passed = Object.values(assertions).every(Boolean);
  const result = { createdAt: new Date().toISOString(), passed, projectId, source, assertions, ui, runSummary: { executionRunId: run.executionRunId, planId: run.planId, status: run.status, progress: run.progress, capabilityCallStats: run.capabilityCallStats, eventCount: run.events?.length || 0 }, output: { width: complete.result?.width, height: complete.result?.height, finalQa: complete.result?.finalQa, imageGate: complete.result?.imageGate } };
  writeFileSync(path.join(evidenceDir, "12-真实项目全链路回归结论.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!passed) throw new Error("真实项目已生成，但全链路断言未全部通过");
} finally {
  await browser.close();
}
