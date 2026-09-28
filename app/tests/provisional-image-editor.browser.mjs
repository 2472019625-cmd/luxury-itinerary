// MOCK API browser check of the real AgentWorkspace/Editor components.
// Run from app/: node tests/provisional-image-editor.browser.mjs --runtime-dir=<private task runtime>
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { createProductionDefaultData } from "../src/lib/itineraryRules.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.dirname(appRoot);
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime-dir="))?.slice("--runtime-dir=".length);
if (!runtimeArg || !path.isAbsolute(runtimeArg)) throw new Error("Require absolute --runtime-dir outside repository");
const runtimeDir = await fs.realpath(runtimeArg);
if (path.relative(repoRoot, runtimeDir) === "" || (!path.relative(repoRoot, runtimeDir).startsWith("..") && !path.isAbsolute(path.relative(repoRoot, runtimeDir)))) throw new Error("Runtime must be outside repository");
const executablePath = [process.env.LUXURY_TRAVEL_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error("Chrome or Edge not found");

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#b9c9bb"/><circle cx="760" cy="115" r="70" fill="#f4ddb3"/><path d="M0 380 Q250 235 470 365 T960 310 V540 H0Z" fill="#739383"/><path d="M0 455 Q310 340 590 435 T960 390 V540 H0Z" fill="#496e63"/><text x="55" y="88" font-size="42" fill="#233b34">MOCK IMAGE</text></svg>')}`;
const runId = randomUUID();
const screenshots = [];
const screenshot = async (page, name) => { const file = path.join(runtimeDir, `${runId}-${name}.png`); await page.screenshot({ path: file }); screenshots.push(file); };
let projectId = randomUUID();
let slotId = "image:cover:primary";
let candidateId = "synthetic-provisional-cover";
let candidate = { candidateId, slotId, pipelineSlotId: slotId, localUrl: image, localPreviewUrl: image, sourceTitle: "合成测试图片", status: "manual_review", qualificationStatus: "eligible", manualSelectable: true, libraryEligible: true, adoptable: true };
const data = createProductionDefaultData();
data.title = "合成行程";
data.destination = "测试目的地";
data.heroImage = image;
data.designer = { name: "测试定制师" };
data.days = [{ id: "synthetic-day-1", date: "2026-10-01", theme: "城市漫步", description: "在城市公园沿步道漫步并观察环境。", routeNodes: ["城市"], spots: [{ id: "synthetic-spot-1", name: "公园步道", description: "沿步道漫步。", images: [] }] }];
data.dayCount = 1;
data.simpleImageSlotBindings = { [slotId]: { module: "cover", fieldPath: "heroImage", required: true } };
data.imageCandidates = [candidate];
data.imageReview = { slots: [{ slotId, module: "封面", label: "封面主图", required: true, status: "provisional_pending_confirmation", provisionalSelected: candidate, candidates: [candidate], resolutionPolicy: { minWidth: 1, minHeight: 1 } }] };
let payload = {
  project: { id: projectId, projectId, title: data.title, data, versions: [], workflowStage: "partial", status: "partial" },
  manualVersion: 1, manualRevision: "synthetic-1", renderPending: false, draftRendered: true,
  canEnterEditor: true, canEnterFinal: false, unresolvedRequiredSlotIds: [slotId], unresolvedCopyCount: 0,
  unresolvedNotices: [{ message: "封面主图已预填，待确认。" }],
  blockingItems: [{ kind: "image", action: "handle_image", id: slotId, label: "封面主图", message: "待确认" }],
};
const calls = [];
const send = (response, status, value) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
const mockApi = {
  name: "strict-mock-api",
  configureServer(server) {
    server.middlewares.use("/api", async (request, response) => {
      const pathname = new URL(request.url, "http://mock.local").pathname;
      const method = request.method || "GET";
      if (pathname === "/auth/session" && method === "GET") return send(response, 200, { enabled: false });
      const base = `/simple/projects/${projectId}/manual-images`;
      if (pathname === base && method === "GET") return send(response, 200, payload);
      if (pathname === `${base}/${encodeURIComponent(slotId)}/select` && method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body);
        calls.push({ method, pathname, body: parsed });
        if (parsed.candidateId !== candidateId || parsed.manualConfirmed !== true) return send(response, 400, { error: "Bad confirmation request" });
        payload = structuredClone(payload);
        payload.manualVersion += 1;
        payload.manualRevision = "synthetic-confirmed";
        payload.project.data.imageReview.slots[0].status = "human_selected";
        payload.project.data.imageReview.slots[0].provisionalSelected = null;
        payload.blockingItems = [];
        payload.unresolvedRequiredSlotIds = [];
        payload.unresolvedNotices = [];
        payload.canEnterFinal = true;
        return send(response, 200, payload);
      }
      if (pathname === `${base}/${encodeURIComponent(slotId)}/reject` && method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body);
        calls.push({ method, pathname, body: parsed });
        if (parsed.candidateId !== candidateId) return send(response, 400, { error: "Bad rejection request" });
        payload = structuredClone(payload);
        payload.manualVersion += 1;
        payload.manualRevision = "synthetic-rejected";
        payload.project.data.imageReview.slots[0].status = "not_found";
        payload.project.data.imageReview.slots[0].provisionalSelected = null;
        if (slotId === "image:cover:primary") payload.project.data.heroImage = "";
        else payload.project.data.days[0].spots[0].images = [];
        payload.unresolvedNotices = slotId === "image:cover:primary" ? [{ message: "封面主图仍需补图。" }] : [];
        payload.blockingItems = slotId === "image:cover:primary" ? [{ kind: "image", action: "handle_image", id: slotId, label: "封面主图", message: "仍需补图" }] : [];
        payload.unresolvedRequiredSlotIds = slotId === "image:cover:primary" ? [slotId] : [];
        payload.canEnterFinal = slotId !== "image:cover:primary";
        return send(response, 200, payload);
      }
      calls.push({ method, pathname, unexpected: true });
      return send(response, 500, { error: "Unexpected mock API request" });
    });
  },
};

const vite = await createServer({ configFile: false, root: appRoot, plugins: [react(), mockApi], cacheDir: path.join(runtimeDir, "vite-cache"), logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false, proxy: {}, warmup: { clientFiles: [] } } });
let browser;
let page;
const browserErrors = [];
try {
  await vite.listen();
  const address = vite.httpServer.address();
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: path.join(runtimeDir, `chrome-${projectId}`), args: ["--disable-gpu", "--font-render-hinting=none"] });
  page = await browser.newPage();
  page.on("pageerror", (error) => browserErrors.push(String(error)));
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${address.port}/simple/projects/${projectId}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes("已预填·待确认"), { timeout: 30000 });
  const before = await page.evaluate(() => ({ hasImage: Boolean(document.querySelector(".focus-preview img")), pending: document.body.innerText.includes("已预填·待确认"), download: document.body.innerText.includes("查看并下载") }));
  assert.deepEqual(before, { hasImage: true, pending: true, download: false });
  await screenshot(page, "cover-before-confirm");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "换图")?.click());
  await page.waitForSelector('.image-picker-modal');
  await page.evaluate(() => [...document.querySelectorAll(".image-picker-modal button")].find((button) => button.textContent.trim() === "确认使用此图")?.click());
  await page.waitForFunction(() => !document.body.innerText.includes("已预填·待确认") && document.body.innerText.includes("查看并下载"), { timeout: 30000 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { candidateId, manualConfirmed: true });
  assert.equal(payload.project.data.imageReview.slots[0].status, "human_selected");
  await screenshot(page, "cover-after-confirm");
  await page.close();

  projectId = randomUUID();
  slotId = "image:day:1:supporting:1";
  candidateId = "synthetic-provisional-optional";
  candidate = { ...candidate, candidateId, slotId, pipelineSlotId: slotId };
  const optionalData = structuredClone(data);
  optionalData.days[0].spots[0].images = [{ src: image, focus: "50% 50%" }];
  optionalData.simpleImageSlotBindings[slotId] = { module: "day", dayIndex: 0, spotIndex: 0, spotId: "synthetic-spot-1", itemIndex: 0, imageIndex: 0, fieldPath: "days.0.spots.0.images.0", required: false, useSpotCopy: true };
  optionalData.imageCandidates = [candidate];
  optionalData.imageReview = { slots: [{ slotId, module: "DAY 1", label: "可选体验图", required: false, status: "provisional_pending_confirmation", provisionalSelected: candidate, candidates: [candidate], resolutionPolicy: { minWidth: 1, minHeight: 1 } }] };
  payload = { project: { id: projectId, projectId, title: optionalData.title, data: optionalData, versions: [], workflowStage: "partial", status: "partial" }, manualVersion: 1, manualRevision: "synthetic-optional-1", renderPending: false, draftRendered: true, canEnterEditor: true, canEnterFinal: false, unresolvedRequiredSlotIds: [], unresolvedCopyCount: 0, unresolvedNotices: [{ message: "可选图片已预填，待确认。" }], blockingItems: [{ kind: "image", action: "handle_image", id: slotId, label: "可选体验图", message: "待确认" }] };
  calls.length = 0;
  const optionalContext = await browser.createBrowserContext();
  page = await optionalContext.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${address.port}/simple/projects/${projectId}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.evaluate(() => document.querySelector('.day-nav-group button[title^="DAY 01"]')?.click());
  await page.waitForSelector('.day-card-editor-summary');
  await page.evaluate(() => document.querySelector('.day-card-editor-summary')?.click());
  await page.waitForFunction(() => document.body.innerText.includes("已预填·待确认") && document.body.innerText.includes("不使用此图"), { timeout: 30000 });
  assert.equal(await page.evaluate(() => document.body.innerText.includes("查看并下载")), false);
  await screenshot(page, "optional-before-reject");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "不使用此图")?.click());
  await page.waitForFunction(() => !document.body.innerText.includes("已预填·待确认") && document.body.innerText.includes("查看并下载"), { timeout: 30000 });
  assert.deepEqual(calls[0].body, { candidateId });
  assert.equal(payload.project.data.days[0].spots[0].images.length, 0);
  await screenshot(page, "optional-after-reject");
  await optionalContext.close();

  projectId = randomUUID();
  slotId = "image:cover:primary";
  candidateId = "synthetic-provisional-required-reject";
  candidate = { ...candidate, candidateId, slotId, pipelineSlotId: slotId };
  const requiredData = structuredClone(data);
  requiredData.imageCandidates = [candidate];
  requiredData.imageReview = { slots: [{ slotId, module: "封面", label: "封面主图", required: true, status: "provisional_pending_confirmation", provisionalSelected: candidate, candidates: [candidate], resolutionPolicy: { minWidth: 1, minHeight: 1 } }] };
  payload = { project: { id: projectId, projectId, title: requiredData.title, data: requiredData, versions: [], workflowStage: "partial", status: "partial" }, manualVersion: 1, manualRevision: "synthetic-required-reject-1", renderPending: false, draftRendered: true, canEnterEditor: true, canEnterFinal: false, unresolvedRequiredSlotIds: [slotId], unresolvedCopyCount: 0, unresolvedNotices: [{ message: "封面主图已预填，待确认。" }], blockingItems: [{ kind: "image", action: "handle_image", id: slotId, label: "封面主图", message: "待确认" }] };
  calls.length = 0;
  const requiredContext = await browser.createBrowserContext();
  page = await requiredContext.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${address.port}/simple/projects/${projectId}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes("不使用此图（仍需补图）"), { timeout: 30000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "不使用此图（仍需补图）")?.click());
  await page.waitForFunction(() => !document.body.innerText.includes("已预填·待确认") && document.body.innerText.includes("此位置仍需补图"), { timeout: 30000 });
  assert.deepEqual(calls[0].body, { candidateId });
  assert.equal(payload.canEnterFinal, false);
  assert.equal(await page.evaluate(() => document.body.innerText.includes("查看并下载")), false);
  await requiredContext.close();

  const report = { status: "PASS", api: "MOCK API only", browser: "fresh profile and isolated contexts", runId, screenshots, assertions: ["required provisional image visible with pending label and final download blocked", "select request manualConfirmed true and server human_selected clears notice", "optional reject request removes image and server canEnterFinal enables continue", "required reject request clears provisional but final download remains blocked"] };
  await fs.writeFile(path.join(runtimeDir, `${runId}-browser-report.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const diagnostic = { status: "FAIL", api: "MOCK API only", browserErrors, calls, body: await page?.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => "") };
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  throw error;
} finally {
  await browser?.close();
  await vite.close();
}
