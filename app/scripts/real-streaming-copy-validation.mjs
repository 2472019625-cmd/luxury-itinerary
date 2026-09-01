import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const appRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(appRoot, "..");
const workbook = process.env.REAL_TEST_XLSX;
if (!workbook || !fs.existsSync(workbook)) throw new Error("REAL_TEST_XLSX 未指向可用的真实 Excel");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceBatch = process.env.REAL_EVIDENCE_BATCH || "2026-08-31-DeepSeek文案流式并发整改";
const runLabel = process.env.REAL_RUN_LABEL || "real-run";
const evidenceDir = path.join(projectRoot, "audit", "evidence", evidenceBatch, `${runLabel}-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const executablePath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find(fs.existsSync);
if (!executablePath) throw new Error("未找到 Edge/Chrome");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
const timeline = [];
let generationId = null;
page.on("response", async (response) => {
  if (response.url().endsWith("/api/generate") && response.request().method() === "POST") {
    try { generationId = (await response.json()).id || generationId; } catch {}
  }
});

async function clickText(text) {
  const handle = await page.waitForFunction((wanted) => [...document.querySelectorAll("button,a")].find((node) => node.textContent.trim().includes(wanted) && !node.disabled) || null, { timeout: 120000 }, text);
  await handle.asElement().click();
}

async function setLabel(labelText, value) {
  await page.evaluate((wanted, nextValue) => {
    const label = [...document.querySelectorAll("label")].find((node) => node.textContent.trim().startsWith(wanted));
    const input = label?.querySelector("input,textarea");
    if (!input) throw new Error(`未找到字段：${wanted}`);
    const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(input, nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, labelText, value);
}

try {
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await clickText("首次使用");
  await setLabel("公司邀请码", "SHEYOU2026");
  await setLabel("姓名", "流式并发真实回归");
  await setLabel("登录账号", `stream-${Date.now()}`);
  await setLabel("6位PIN", "246810");
  await clickText("创建并进入");
  await clickText("新建行程");
  const upload = await page.waitForSelector('input[type="file"][accept*=".xlsx"]');
  await upload.uploadFile(workbook);
  await page.waitForFunction(() => document.body.innerText.includes("确认识别结果") && ![...document.querySelectorAll("button")].find((node) => node.textContent.includes("确认识别结果"))?.disabled, { timeout: 120000 });
  await clickText("确认识别结果");
  await page.waitForSelector(".confirm-form", { timeout: 120000 });
  await setLabel("成人", "2");
  await setLabel("儿童", "0");
  await setLabel("出发日期", "2026-10-01");
  await setLabel("返程日期", "2026-10-07");
  await page.screenshot({ path: path.join(evidenceDir, "01-confirmed-source.png"), fullPage: true });
  const startedAt = Date.now();
  await page.evaluate(() => { window.__SHEYOU_REAL_VALIDATION_DISABLE_COPY_CACHE__ = true; });
  await clickText("确认并生成内容");
  await page.waitForSelector(".generation-page", { timeout: 120000 });
  while (!generationId && Date.now() - startedAt < 30000) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!generationId) throw new Error("没有捕获到 generation job id");
  let previousSignature = "";
  let finalJob = null;
  while (Date.now() - startedAt < 60 * 60 * 1000) {
    const response = await fetch(`http://127.0.0.1:4173/api/jobs/${generationId}`);
    const job = await response.json();
    const snapshot = {
      atMs: Date.now() - startedAt,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      currentAction: job.currentAction,
      copyProgress: job.copyProgress,
      copyStream: job.copyStream,
      parallelStages: job.parallelStages,
      imageProgress: job.imageProgress,
      stats: job.stats,
    };
    const signature = JSON.stringify(snapshot);
    if (signature !== previousSignature) { timeline.push(snapshot); previousSignature = signature; console.log(JSON.stringify(snapshot)); }
    if (["complete", "needs_copy_revision", "blocked", "failed"].includes(job.status)) { finalJob = job; break; }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!finalJob) throw new Error("真实生成超过60分钟");
  fs.writeFileSync(path.join(evidenceDir, "02-generation-timeline.json"), JSON.stringify(timeline, null, 2));
  fs.writeFileSync(path.join(evidenceDir, "03-generation-job.json"), JSON.stringify(finalJob, null, 2));
  if (JSON.stringify(finalJob).includes("reasoning_content")) throw new Error("任务结果泄露了 reasoning_content");
  if (finalJob.status === "failed") throw new Error(finalJob.error || "真实生成失败");
  await page.waitForSelector(finalJob.status === 'complete' ? ".editor-grid" : ".generation-terminal", { timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(evidenceDir, `04-${finalJob.status}-state.png`), fullPage: true });
  if (finalJob.status === 'needs_copy_revision') {
    await clickText('进入修订模式');
    await page.waitForSelector('.editor-grid', { timeout: 120000 });
    await page.screenshot({ path: path.join(evidenceDir, '04a-editor-revision-mode.png'), fullPage: false });
  }
  const project = await page.evaluate(() => JSON.parse(localStorage.getItem("sheyou-workspace-projects-v1") || "[]")[0]);
  fs.writeFileSync(path.join(evidenceDir, "05-final-project.json"), JSON.stringify(project, null, 2));
  const internalPreview = finalJob.finalLayoutReview?.outputFile || finalJob.finalLayoutReview?.previewFile || finalJob.finalLayoutReview?.screenshotPath || null;
  if (internalPreview && fs.existsSync(internalPreview)) fs.copyFileSync(internalPreview, path.join(evidenceDir, "06-final-output-2000.png"));
  fs.writeFileSync(path.join(evidenceDir, "07-final-layout-qa.json"), JSON.stringify(finalJob.finalLayoutReview || null, null, 2));
  let imageLedger = null;
  if (finalJob.imageResearch?.ledgerUrl) {
    const ledgerResponse = await fetch(`http://127.0.0.1:4173${finalJob.imageResearch.ledgerUrl}`);
    if (ledgerResponse.ok) {
      imageLedger = await ledgerResponse.json();
      fs.writeFileSync(path.join(evidenceDir, "08-image-ledger.json"), JSON.stringify(imageLedger, null, 2));
    }
  }
  const blueprintStarted = timeline.find((item) => item.parallelStages?.blueprint === "running");
  const blueprintCompleted = timeline.find((item) => ["complete", "fallback"].includes(item.parallelStages?.blueprint));
  const imageStarted = timeline.find((item) => item.parallelStages?.images && !["waiting", "complete"].includes(item.parallelStages.images));
  const imageCompleted = timeline.find((item) => item.parallelStages?.images === "complete");
  const terminalStatuses = ['complete','needs_copy_revision','blocked'];
  const copyCompleted = timeline.find((item) => ["finalizing-images", ...terminalStatuses].includes(item.status));
  const generationCompleted = timeline.find((item) => terminalStatuses.includes(item.status));
  const summary = {
    evidenceDir,
    workbook,
    generationId,
    terminalStatus: finalJob.status,
    projectId: project?.id,
    totalMs: Date.now() - startedAt,
    firstProviderResponseMs: timeline.find((item) => item.copyStream?.providerResponded)?.atMs ?? null,
    firstContentMs: timeline.find((item) => item.copyStream?.receivedContentChars > 0)?.atMs ?? null,
    phaseDurations: {
      blueprintMs: blueprintStarted && blueprintCompleted ? blueprintCompleted.atMs - blueprintStarted.atMs : null,
      imagePipelineMs: imageStarted && imageCompleted ? imageCompleted.atMs - imageStarted.atMs : null,
      copyAndBrandMs: copyCompleted?.atMs ?? null,
      finalLayoutMs: imageCompleted && generationCompleted ? generationCompleted.atMs - imageCompleted.atMs : null,
      fullGenerationMs: generationCompleted?.atMs ?? null,
    },
    copyUnits: finalJob.copyUnits,
    contentQuality: finalJob.contentQuality && { passed: finalJob.contentQuality.passed, status: finalJob.contentQuality.status, remainingIssueCount: finalJob.contentQuality.remainingIssueCount, factsPreserved: finalJob.contentQuality.factsPreserved },
    parallelStages: finalJob.parallelStages,
    copyImageConsistency: finalJob.copyImageConsistency,
    imageResearch: finalJob.imageResearch,
    imageLedgerStats: imageLedger?.stats || null,
    imageConcurrency: imageLedger?.concurrency || null,
    cacheDisabled: imageLedger?.disableCache === true,
    modelTaskProfiles: {
      copy: (finalJob.usage?.copy?.modules || []).map(({ unitId, taskKind, requestProfile, attemptUsages }) => ({ unitId, taskKind, requestProfile, attempts: (attemptUsages || []).map(({ attempt, reasoningEffort, thinkingType, outcome }) => ({ attempt, reasoningEffort, thinkingType, outcome })) })),
      brand: (finalJob.usage?.copy?.brandReviews || []).map(({ taskKind, target, requestProfile, attemptUsages }) => ({ taskKind, target, requestProfile, attempts: (attemptUsages || []).map(({ attempt, reasoningEffort, thinkingType, outcome }) => ({ attempt, reasoningEffort, thinkingType, outcome })) })),
      blueprint: finalJob.usage?.blueprint?.requestProfile || null,
    },
    finalLayoutReview: finalJob.finalLayoutReview,
    repairTargets: finalJob.contentQuality?.brandEditor?.repairTargets || [],
    internalPreview,
  };
  fs.writeFileSync(path.join(evidenceDir, "00-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
