// Real HTTP/browser verification of a freshly generated isolated project.
// Never clones a historical project or supplies mocked API/image responses.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";
import { createAgentPlannerServer } from "../server/agent-planner-app.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf("=");
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
if (!args["run-root"] || !args["evidence-dir"]) throw new Error("Require --run-root and --evidence-dir, both registered private paths");
const runRoot = await realpath(args["run-root"]);
const evidenceDir = await realpath(args["evidence-dir"]);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith("..") && !path.isAbsolute(relative); };
if (inside(repoRoot, runRoot) || inside(repoRoot, evidenceDir)) throw new Error("Execution state must be outside the repository");
const summary = JSON.parse(await readFile(path.join(runRoot, "summary.json"), "utf8"));
const projectId = summary.projectId;
const store = new AgentPlanStore(path.join(runRoot, "projects"));
const project = store.getProject(projectId);
assert.equal(project.flowKind, "simple_skill_v1");
const initialResult = store.getFinalResult(projectId, project.activeExecutionRunId);
const save = (name, data) => writeFile(path.join(evidenceDir, name), JSON.stringify(data, null, 2), { flag: "wx" });
const ownership = { owner: "simple-existing-project-editor-regression", purpose: "fresh generated project, real HTTP and browser editor verification", runRoot, evidenceDir,
  resources: ["loopback HTTP server", "fresh Chrome profile", "private browser temp", "editor catalog", "screenshots and before/after evidence"],
  consumers: [{ pid: process.pid }], retirement: "close server and browser in finally; preserve evidence until independent review" };
await save("ownership.json", ownership);
await save("before-result.json", initialResult);
const temp = path.join(evidenceDir, "temp");
await mkdir(temp);
for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = temp;
const runtime = createAgentPlannerServer({ port: 0, simpleStore: store, simpleRuntimeRoot: runRoot,
  workspaceRoot: path.join(evidenceDir, "agent", "projects"), catalogFile: path.join(evidenceDir, "catalog.sqlite"),
  cleanupIntervalMs: 0, auth: { enabled: false } });
const checks = [];
const check = (name, details = {}) => checks.push({ name, status: "PASS", ...details });
let browser;
let outcome = "FAIL";
try {
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  ownership.port = runtime.server.address().port;
  const endpoint = `/api/simple/projects/${projectId}/manual-images`;
  const get = async () => { const response = await fetch(origin + endpoint); assert.equal(response.status, 200); return response.json(); };
  let payload = await get();
  await save("before-payload.json", payload);
  assert.equal(payload.canEnterEditor, true);
  const provisional = payload.project.data.imageReview.slots.filter((slot) => slot.status === "provisional_pending_confirmation");
  for (const slot of provisional) {
    const candidate = slot.provisionalSelected;
    assert.ok(candidate?.localUrl?.startsWith("/image-assets/"));
    const asset = await fetch(origin + candidate.localUrl);
    assert.equal(asset.status, 200);
    assert.ok((await asset.arrayBuffer()).byteLength > 0);
  }
  if (provisional.length) check("prefill_originals_load", { count: provisional.length });
  else checks.push({ name: "prefill_originals_load", status: "NOT_TRIGGERED", count: 0, reason: "Fresh generation has no provisional candidates" });
  if (!payload.canEnterFinal) {
    assert.notEqual((await fetch(`${origin}/api/simple/projects/${projectId}/output`)).status, 200);
    check("unresolved_blocks_final_download");
  }
  if (provisional.length) {
    assert.equal(payload.canEnterFinal, false);
    assert.notEqual((await fetch(`${origin}/api/simple/projects/${projectId}/output`)).status, 200);
    check("pending_prefill_blocks_final_download");
  }
  const executablePath = [process.env.LUXURY_TRAVEL_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((item) => item && existsSync(item));
  assert.ok(executablePath);
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: path.join(evidenceDir, "browser-profile"), args: ["--disable-gpu"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/simple/projects/${projectId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".editor-page", { timeout: 30000 });
  if (provisional.length) await page.waitForFunction(() => document.body.innerText.includes("已预填·待确认"));
  await page.screenshot({ path: path.join(evidenceDir, "editor-initial.png") });
  check("fresh_browser_editor_loads", { provisionalCount: provisional.length });
  await save("ui-controls.json", await page.evaluate(() => ({
    buttons: [...document.querySelectorAll("button")].map((button) => ({ text: button.textContent.trim(), title: button.title })).filter((item) => item.text || item.title),
    fields: [...document.querySelectorAll("input, textarea")].map((field) => ({ tag: field.tagName, placeholder: field.placeholder, label: field.closest("label")?.textContent?.slice(0, 40) })),
  })));
  if (args["checks"] !== "images") {
  // Exercise the actual autosave UI with an invisible trailing newline. No
  // itinerary fact changes; the exact original text is restored after reload.
  await page.locator('.day-nav-group button[title^="DAY 01"]').click();
  await page.waitForSelector(".day-info-section");
  const toggle = await page.$(".day-info-section .day-section-toggle");
  if (await toggle.evaluate((element) => element.getAttribute("aria-expanded") !== "true")) await toggle.click();
  const fields = await page.$$(".day-info-fields textarea");
  let descriptionField;
  for (const field of fields) if (await field.evaluate((element) => element.closest("label")?.textContent.startsWith("当日行程"))) descriptionField = field;
  assert.ok(descriptionField, "actual DAY description field must be present");
  const originalDescription = await descriptionField.evaluate((element) => element.value);
  await descriptionField.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  const saving = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/day-editor/0`), { timeout: 60000 });
  // Observe immediately so a later browser failure cannot leave an unhandled
  // rejection while the original diagnostic is being saved.
  saving.catch(() => {});
  await descriptionField.press("Enter");
  const savedResponse = await saving;
  assert.equal(savedResponse.status(), 200);
  const savedPayload = await savedResponse.json();
  assert.ok(savedPayload.manualVersion > payload.manualVersion);
  const reloadedStore = new AgentPlanStore(path.join(runRoot, "projects"));
  const persisted = reloadedStore.getFinalResult(projectId, project.activeExecutionRunId);
  assert.equal(persisted.manualImageCompletion.version, savedPayload.manualVersion);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".editor-page", { timeout: 30000 });
  payload = await get();
  assert.equal(payload.manualVersion, savedPayload.manualVersion);
  assert.equal(payload.project.data.days[0].description, savedPayload.project.data.days[0].description);
  check("browser_autosave_disk_read_and_reload", { manualVersion: payload.manualVersion });
  await page.screenshot({ path: path.join(evidenceDir, "editor-after-reload.png") });
  assert.deepEqual(errors, []);
  await save("after-payload.json", payload);
  const restoredData = payload.project.data;
  const restoredDay = { ...restoredData.days[0], description: originalDescription };
  const restoredBindings = Object.fromEntries(Object.entries(restoredData.simpleImageSlotBindings || {}).filter(([, binding]) => binding.module === "day" && binding.dayIndex === 0));
  const restored = await fetch(`${origin}/api/simple/projects/${projectId}/day-editor/0`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ day: restoredDay, bindings: restoredBindings, included: restoredData.included || [], excluded: restoredData.excluded || [], pendingConfirmations: restoredData.pendingConfirmations || [] }) });
  assert.equal(restored.status, 200);
  assert.equal((await get()).project.data.days[0].description, originalDescription);
  check("original_copy_restored");
  }
  if (args["checks"] === "images") {
    // The caller must inspect the actual picture and both subjects before
    // supplying these IDs. Never invent candidates to force a live scenario.
    const sourceId = args["source-slot"];
    const targetId = args["target-slot"];
    const originalResults = initialResult.imageExecution.results;
    const source = originalResults.find((item) => item.slotId === sourceId);
    const target = originalResults.find((item) => item.slotId === targetId);
    assert.ok(source?.selected?.candidateId && source.selected.localUrl);
    assert.ok(target && !target.selected && !target.provisionalSelected, "move test requires an empty target");
    const post = async (slotId, action, body) => {
      const response = await fetch(`${origin}${endpoint}/${encodeURIComponent(slotId)}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const beforeVersion = (await get()).manualVersion;
    const hardSlot = payload.project.data.imageReview.slots.find((slot) => slot.candidates.some((candidate) => candidate.status === "hard_rejected"));
    assert.ok(hardSlot, "requires an actual hard-rejected candidate");
    const hard = hardSlot.candidates.find((candidate) => candidate.status === "hard_rejected");
    const deniedHard = await post(hardSlot.slotId, "select", { candidateId: hard.candidateId, manualConfirmed: true });
    assert.equal(deniedHard.status, 400);
    assert.equal(deniedHard.body.code, "candidate_hard_rejected");
    const deniedMove = await post(targetId, "select", { candidateId: source.selected.candidateId, manualConfirmed: false });
    assert.equal(deniedMove.status, 400);
    assert.equal(deniedMove.body.code, "manual_confirmation_required");
    assert.equal((await get()).manualVersion, beforeVersion);
    check("hard_rejection_and_unconfirmed_move_preserve_state");
    const moved = await post(targetId, "select", { candidateId: source.selected.candidateId, manualConfirmed: true });
    assert.equal(moved.status, 200);
    const movedResult = new AgentPlanStore(path.join(runRoot, "projects")).getFinalResult(projectId, project.activeExecutionRunId);
    assert.equal(movedResult.imageExecution.results.find((item) => item.slotId === sourceId).selected, null);
    assert.equal(movedResult.imageExecution.results.find((item) => item.slotId === targetId).selected.candidateId, source.selected.candidateId);
    assert.equal(moved.body.canEnterFinal, false);
    await save("moved-payload.json", moved.body);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".editor-page");
    await page.screenshot({ path: path.join(evidenceDir, "editor-after-move.png") });
    check("real_http_move_persists_source_and_target_then_browser_reload", { sourceId, targetId });
    const restored = await post(sourceId, "select", { candidateId: source.selected.candidateId, manualConfirmed: true });
    assert.equal(restored.status, 200);
    const restoredResult = store.getFinalResult(projectId, project.activeExecutionRunId);
    assert.equal(restoredResult.imageExecution.results.find((item) => item.slotId === sourceId).selected.candidateId, source.selected.candidateId);
    assert.equal(restoredResult.imageExecution.results.find((item) => item.slotId === targetId).selected, null);
    await save("restored-image-payload.json", restored.body);
    check("original_image_placement_restored", { manualVersion: restored.body.manualVersion });
    checks.push({ name: "provisional_confirm_and_reject", status: "NOT_TRIGGERED", reason: "No actual provisional or selectable manual candidates in this generation; no synthetic substitution" });
  } else {
    checks.push({ name: "candidate_confirmation_rejection_move", status: "NOT_RUN", reason: "Run image checks after inspecting actual candidate and both subjects" });
  }
  outcome = "PARTIAL";
} catch (error) {
  await save("failure.json", { message: error.message, code: error.code || null, stack: error.stack });
  process.exitCode = 1;
} finally {
  await browser?.close();
  // Day saving schedules a real render; wait for this owned work to settle
  // before retiring its HTTP origin.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const pending = store.getFinalResult(projectId, project.activeExecutionRunId)?.renderStatus === "pending_manual_render";
    if (!pending) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (runtime.server.listening) { runtime.server.closeAllConnections(); await new Promise((resolve) => runtime.server.close(resolve)); }
  ownership.consumers = [];
  ownership.closedAt = new Date().toISOString();
  await writeFile(path.join(evidenceDir, "ownership.json"), JSON.stringify(ownership, null, 2));
  await save("summary.json", { outcome, projectId, checks });
  console.log(JSON.stringify({ outcome, checks }));
}
