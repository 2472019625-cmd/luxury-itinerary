// Explicit, opt-in live validation. Configuration is read in memory, never copied.
// Supply an access-controlled --evidence directory outside the repository.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { normalizeItineraryFacts, validateItineraryFacts } from "../src/lib/itineraryRules.js";
import { buildAgentFactBasis, fingerprintFacts, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { applyApprovedFixedModules } from "../server/simple-fixed-modules.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.dirname(appRoot);
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf("=");
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
const required = name => { if (!args[name]) throw new Error(`Missing --${name}`); return args[name]; };
const evidenceRoot = path.resolve(required("evidence"));
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
if (inside(repoRoot, evidenceRoot)) throw new Error("Live evidence must be outside the repository");
const mode = required("mode");
if (!["plan", "images", "pipeline"].includes(mode)) throw new Error("Mode must be plan, images or pipeline");
const configRoot = path.resolve(required("config-dir"));
for (const name of [".env.local", ".env.image-search.local", ".env.knowledge.local"]) {
  let contents;
  try { contents = await fs.readFile(path.join(configRoot, name), "utf8"); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}
const secretValues = Object.entries(process.env).filter(([key]) => /(?:API_KEY|BASE_URL|MODEL_NAME|_MODEL)$/.test(key)).map(([, value]) => value).filter(value => value && value.length > 5);
const safeJson = value => JSON.stringify(value, (key, item) => {
  if (/^(?:apiKey|baseUrl|model|searchModel|visionModel|cookie|authorization)$/i.test(key)) return undefined;
  if (typeof item !== "string") return item;
  return secretValues.reduce((text, secret) => text.split(secret).join("[configuration omitted]"), item);
}, 2);
const save = async (name, value) => fs.writeFile(path.join(evidenceRoot, name), `${safeJson(value)}\n`, { flag: "wx" });
const csv = value => String(value || "").split(",").map(item => item.trim()).filter(Boolean);
const textOptions = { apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: process.env.TEXT_MODEL_BASE_URL, model: process.env.TEXT_MODEL_NAME };
const imageOptions = {
  searchApiKey: process.env.IMAGE_SEARCH_API_KEY, searchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL, searchModel: process.env.IMAGE_SEARCH_MODEL,
  visionApiKey: process.env.BIGMODEL_API_KEY, visionBaseUrl: process.env.BIGMODEL_BASE_URL, visionModel: process.env.BIGMODEL_MODEL,
  sourceMode: args["web-only"] === "true" ? "web_only" : process.env.IMAGE_SOURCE_MODE || "web_only",
  knowledgeBaseUrl: process.env.IMAGE_KNOWLEDGE_BASE_URL,
  knowledgeScopeNodeIds: csv(process.env.IMAGE_KNOWLEDGE_NODE_IDS),
  knowledgeTopK: Number(process.env.IMAGE_KNOWLEDGE_TOP_K || 5),
  knowledgeTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_TIMEOUT_MS || 120000),
  knowledgeRequestTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_REQUEST_TIMEOUT_MS || 30000),
  knowledgePollIntervalMs: Number(process.env.IMAGE_KNOWLEDGE_POLL_INTERVAL_MS || 2000),
  trustedKnowledgeOrigins: csv(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS),
};

// Compare only changed image modules from a Git revision, in memory. Reuse the
// same unchanged dependency tree; do not copy a repository or its installations.
async function loadBaseline(revision) {
  if (!/^[a-f0-9]{7,40}$/i.test(revision)) throw new Error("Baseline must be a commit SHA");
  const modules = new Set(["simple-image-skill.mjs", "image-web-execution.mjs", "image-audit.mjs", "image-candidate-eligibility.mjs", "image-download.mjs", "page-images.mjs"].map(name => `app/server/${name}`));
  const require = createRequire(path.join(appRoot, "package.json"));
  const cache = new Map();
  const encode = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  function moduleUrl(file) {
    if (cache.has(file)) return cache.get(file);
    const absolute = path.join(repoRoot, file);
    let source = execFileSync("git", ["show", `${revision}:${file}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    source = source.replace(/import\.meta\.url/g, JSON.stringify(pathToFileURL(absolute).href));
    source = source.replace(/(\bfrom\s*|\bimport\s*)["']([^"']+)["']/g, (match, prefix, specifier) => {
      if (specifier.startsWith("node:")) return match;
      let url;
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(absolute), specifier);
        const relative = path.relative(repoRoot, target).replaceAll("\\", "/");
        url = modules.has(relative) ? moduleUrl(relative) : pathToFileURL(target).href;
      } else url = pathToFileURL(require.resolve(specifier)).href;
      return `${prefix}${JSON.stringify(url)}`;
    });
    const url = encode(source); cache.set(file, url); return url;
  }
  return import(moduleUrl("app/server/simple-image-skill.mjs"));
}

await fs.mkdir(evidenceRoot, { recursive: true });
const started = Date.now();
try {
  if (mode === "plan") {
    if (!textOptions.apiKey || !textOptions.baseUrl || !textOptions.model) throw Object.assign(new Error("Existing text configuration is incomplete"), { code: "configuration_missing" });
    const workbook = path.resolve(required("workbook"));
    const bytes = await fs.readFile(workbook);
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const sourceFile = { name: path.basename(workbook), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    const imported = await importItineraryWorkbook(sourceFile, applyApprovedFixedModules({}));
    const data = normalizeItineraryFacts(imported.data);
    const validation = validateItineraryFacts(data);
    if (!validation.valid || !data.days?.length) throw Object.assign(new Error("Workbook core facts require confirmation"), { code: "core_fact_conflict" });
    await save("source.json", { data, report: imported.report, sourceName: sourceFile.name, sourceSha256 });
    console.log(JSON.stringify({ event: "planner_started", days: data.days.length }));
    const planning = await generateAgentPlan({ project: { factBasis: buildAgentFactBasis(data, imported.report) }, ...textOptions, simpleSkillContract: true });
    const plan = materializeSimpleSkillPlan({ data, report: imported.report, agentPlan: planning.plan });
    await save("plan.json", plan);
    await save("planning.json", planning);
    await save("input-fingerprint.json", { sourceSha256, inputFingerprint: fingerprintFacts(data), slotFingerprint: fingerprintFacts(plan.imageSlots) });
    console.log(JSON.stringify({ event: "planner_finished", slotCount: plan.imageSlots.length, slots: plan.imageSlots.map(slot => ({ slotId: slot.slotId, moduleType: slot.moduleType, planned: !slot.needsUserAction })), durationMs: Date.now() - started }));
  } else if (mode === "pipeline") {
    // Replay the fresh, real Planner result to keep the image comparison fixed.
    // The new project still executes real Copy/Image Skills, writeback and renderer.
    const plan = JSON.parse(await fs.readFile(path.resolve(required("plan")), "utf8"));
    const source = JSON.parse(await fs.readFile(path.resolve(required("source")), "utf8"));
    const planning = JSON.parse(await fs.readFile(path.resolve(required("planning")), "utf8"));
    const [{ runSimplePipeline }, { AgentPlanStore }, { createAgentPlannerServer }, { createImageRetrievalSession }, { default: puppeteer }, { runImageSearchSkill }, { runSimpleRenderer }] = await Promise.all([
      import("../server/simple-pipeline-executor.mjs"), import("../server/agent-plan-store.mjs"),
      import("../server/agent-planner-app.mjs"), import("../server/image-retrieval-session.mjs"), import("puppeteer-core"),
      import("../server/simple-image-skill.mjs"), import("../server/simple-renderer.mjs"),
    ]);
    const store = new AgentPlanStore(path.join(evidenceRoot, "projects"));
    const port = Number(args.port || 4174);
    const { server } = createAgentPlannerServer({ port, workspaceRoot: path.join(evidenceRoot, "workspace"), simpleStore: store });
    const originalHandler = server.listeners("request")[0];
    server.removeListener("request", originalHandler);
    server.on("request", async (request, response) => {
      const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
      if (!pathname.startsWith("/image-assets/")) return originalHandler(request, response);
      const imageRoot = path.join(evidenceRoot, "output", "image-assets");
      try {
        const target = path.resolve(imageRoot, decodeURIComponent(pathname.slice("/image-assets/".length)));
        if (!inside(imageRoot, target) || !["GET", "HEAD"].includes(request.method)) { response.writeHead(403).end(); return; }
        const bytes = await fs.readFile(target);
        response.writeHead(200, { "content-type": target.endsWith(".png") ? "image/png" : target.endsWith(".webp") ? "image/webp" : "image/jpeg" });
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch { response.writeHead(404).end(); }
    });
    const signal = AbortSignal.timeout(30 * 60 * 1000);
    const retrievalSession = createImageRetrievalSession({ signal, runtimeDirectory: path.join(evidenceRoot, "retrieval-browser") });
    let browser;
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      await save("ownership.json", { owner: "image-retrieval-live-validation", purpose: "isolated new-project validation", consumers: [{ pid: process.pid, port }], path: evidenceRoot, retirement: "server and browsers stop in finally; retain evidence until user review" });
      const events = [];
      const result = await runSimplePipeline({ sourceData: { ...source, fileName: source.sourceName }, root: appRoot,
        origin: `http://127.0.0.1:${port}`, adapters: { store, planAgent: async () => structuredClone(planning), adaptPlan: () => structuredClone(plan),
          runImage: options => runImageSearchSkill({ ...options, root: evidenceRoot }),
          render: options => runSimpleRenderer({ ...options, outputDirectory: path.join(evidenceRoot, "render") }),
        },
        plannerOptions: textOptions, copyOptions: { ...textOptions, researchApiKey: imageOptions.searchApiKey, researchBaseUrl: imageOptions.searchBaseUrl },
        imageOptions: { ...imageOptions, adapters: { retrievalSession } }, signal,
        onEvent: event => {
          events.push(event);
          if (event.capabilityId === "image_slot_progress") console.log(JSON.stringify({ event: "image_progress", completed: event.completedSlots, total: event.totalSlots }));
          else if (event.stage !== "capability" && event.phase !== "progress") console.log(JSON.stringify({ event: "pipeline_stage", stage: event.stage, phase: event.phase, status: event.status }));
        },
      });
      await save("result.json", result); await save("events.json", events);
      const ownershipPath = path.join(evidenceRoot, "ownership.json");
      browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
        userDataDir: path.join(evidenceRoot, "editor-profile"), args: ["--no-first-run", "--disable-background-networking"] });
      await fs.writeFile(ownershipPath, safeJson({ owner: "image-retrieval-live-validation", consumers: [{ pid: process.pid, port }, { pid: browser.process()?.pid }], path: evidenceRoot, retirement: "stop on completion; retain evidence until user review" }));
      const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
      const pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/simple/projects/${result.projectId}`, { waitUntil: "networkidle0", timeout: 60000 });
      await page.waitForSelector(".workspace-shell", { timeout: 30000 });
      await page.screenshot({ path: path.join(evidenceRoot, "editor.png"), fullPage: false });
      const payload = await fetch(`http://127.0.0.1:${port}/api/simple/projects/${result.projectId}/manual-images`).then(response => response.json());
      const summary = { projectId: result.projectId, plannerReusedFromFreshLiveRun: true, pipelineStatus: result.pipelineStatus,
        renderStatus: result.render?.status, renderMode: result.render?.mode, outputPath: result.outputPath,
        renderWidth: result.render?.qa?.layout?.width, renderIssues: result.render?.qa?.issues,
        selectedImages: result.imageExecution?.results?.filter(item => item.selected).length,
        imageSlots: result.imageExecution?.results?.length, unresolvedCount: result.unresolvedItems?.length,
        canEnterEditor: payload.canEnterEditor, canEnterFinal: payload.canEnterFinal, pageErrors,
        durationMs: Date.now() - started,
      };
      await save("summary.json", summary);
      console.log(JSON.stringify({ event: "pipeline_finished", projectId: result.projectId, pipelineStatus: result.pipelineStatus, renderStatus: summary.renderStatus, renderWidth: summary.renderWidth, selectedImages: summary.selectedImages, pageErrors: pageErrors.length }));
    } finally {
      await browser?.close(); await retrievalSession.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  } else {
    if (!imageOptions.searchApiKey || !imageOptions.visionApiKey) throw Object.assign(new Error("Existing image configuration is incomplete"), { code: "configuration_missing" });
    const plan = JSON.parse(await fs.readFile(path.resolve(required("plan")), "utf8"));
    const ids = new Set(required("slots").split(","));
    const slots = plan.imageSlots.filter(slot => ids.has(slot.slotId));
    if (slots.length !== ids.size) throw new Error("Unknown or duplicate slot selection");
    const implementation = args.baseline ? await loadBaseline(args.baseline) : await import("../server/simple-image-skill.mjs");
    console.log(JSON.stringify({ event: "images_started", slotCount: slots.length, baseline: args.baseline || null }));
    const signal = AbortSignal.timeout(15 * 60 * 1000);
    const { createImageRetrievalSession } = await import("../server/image-retrieval-session.mjs");
    const retrievalSession = createImageRetrievalSession({ signal, runtimeDirectory: path.join(evidenceRoot, "browser") });
    let result;
    try {
      result = await implementation.runImageSearchSkill({ slots, root: evidenceRoot, ...imageOptions,
        signal, adapters: { retrievalSession },
      });
    } finally { await retrievalSession.close(); }
    await save("result.json", result);
    const summary = { durationMs: Date.now() - started, baseline: args.baseline || null, slotFingerprint: fingerprintFacts(slots),
      slots: result.results.map(item => ({ slotId: item.slotId, status: item.status, selected: Boolean(item.selected), technicalStatus: item.technicalStatus,
        queries: item.pipelineEvidence?.webExecution?.executedQueries?.length || 0,
        downloads: item.pipelineEvidence?.downloadAttempts || 0,
        web: item.pipelineEvidence?.webExecution?.queryReports || [],
      })), metrics: result.metrics,
    };
    await save("summary.json", summary);
    console.log(JSON.stringify({ event: "images_finished", durationMs: summary.durationMs, results: summary.slots.map(({ slotId, status, selected }) => ({ slotId, status, selected })) }));
  }
} catch (error) {
  await save("failure.json", { code: error.code || "validation_failed", message: error.message, durationMs: Date.now() - started });
  console.log(JSON.stringify({ event: "validation_failed", code: error.code || "validation_failed", durationMs: Date.now() - started }));
  process.exitCode = 1;
}
