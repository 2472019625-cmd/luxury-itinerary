// Explicit one-run, real-capability regression. Customer data and generated
// evidence stay under the caller's access-controlled runtime root.
// Usage: node scripts/simple-generation-chain-live-regression.mjs
//   --input=<supplier.xlsx> --runtime-root=<private-directory> --config-dir=<existing-config-directory>
import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";
import { createImageRetrievalSession } from "../server/image-retrieval-session.mjs";
import { runImageSearchSkill } from "../server/simple-image-skill.mjs";
import { runSimpleRenderer } from "../server/simple-renderer.mjs";
import { runSimplePipeline } from "../server/simple-pipeline-executor.mjs";
import { createProductionDefaultData } from "../src/lib/itineraryRules.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.dirname(appRoot);
const clientRoot = path.join(appRoot, "dist", "client");
const args = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
  const at = arg.indexOf("=");
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: node scripts/simple-generation-chain-live-regression.mjs --input=<supplier.xlsx> --runtime-root=<private-directory> --config-dir=<existing-config-directory>\n");
  process.exit(0);
}
const required = (name) => { if (!args[name]) throw new Error(`缺少 --${name}`); return args[name]; };
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
const csv = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

const input = await realpath(path.resolve(required("input")));
if (!/\.xlsx?$/i.test(input) || !(await stat(input)).isFile()) throw new Error("输入必须是一份存在的 .xlsx/.xls 文件");
const runtimeRoot = await realpath(path.resolve(required("runtime-root")));
const configRoot = await realpath(path.resolve(required("config-dir")));
if (!(await stat(runtimeRoot)).isDirectory() || inside(repoRoot, runtimeRoot) || inside(await realpath(os.tmpdir()), runtimeRoot)) {
  throw new Error("runtime-root 必须是仓库及操作系统临时目录之外、预先配置私有权限的目录");
}
if (!(await stat(configRoot)).isDirectory()) throw new Error("config-dir 必须是现有配置目录");
if (!existsSync(path.join(clientRoot, "index.html"))) throw new Error("缺少 app/dist/client/index.html，请先在 app 内完成当前源码构建");

// Match the local production service's read-only env precedence. Never emit
// file contents, endpoints, credentials or model names to logs or summaries.
for (const name of [".env.local", ".env.image-search.local", ".env.knowledge.local"]) {
  let contents;
  try { contents = await readFile(path.join(configRoot, name), "utf8"); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}
for (const key of ["TEXT_MODEL_API_KEY", "IMAGE_SEARCH_API_KEY", "BIGMODEL_API_KEY"]) {
  if (!process.env[key]) throw new Error("现有生产能力配置不完整；没有发起真实调用");
}

const runId = `live-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runRoot = path.join(runtimeRoot, runId);
const imageRoot = path.join(runRoot, "output", "image-assets");
const ownershipPath = path.join(runRoot, "ownership.json");
await mkdir(runRoot, { recursive: false });
const privateTemp = path.join(runRoot, "temp");
const save = (name, value) => writeFile(path.join(runRoot, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const ownership = { owner: "simple-generation-chain-live-regression", purpose: "one fresh real Planner/Copy/Image/2000px run", runId, runRoot, runDirectoryGroup: ["projects", "output/image-assets", "render", "retrieval-browser", "temp", "events.jsonl", "summary.json"], consumers: [{ pid: process.pid }], retirement: "server and retrieval session close in finally; retain project evidence for independent review" };
await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, { flag: "wx" });
await mkdir(privateTemp);
// The renderer launches a child Chrome process whose default user profile
// otherwise lands in the operating-system temp directory with customer data.
// These process-local variables are inherited only by this run's children.
for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = privateTemp;
const store = new AgentPlanStore(path.join(runRoot, "projects"));
const eventLog = createWriteStream(path.join(runRoot, "events.jsonl"), { flags: "wx" });
const log = (value) => { const line = `${JSON.stringify(value)}\n`; eventLog.write(line); process.stdout.write(line); };

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".otf": "font/otf", ".ttf": "font/ttf" };
const server = createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname); }
  catch { response.writeHead(400).end(); return; }
  const isImage = pathname.startsWith("/image-assets/");
  const base = isImage ? imageRoot : clientRoot;
  const relative = isImage ? pathname.slice("/image-assets/".length) : pathname === "/" ? "index.html" : pathname.slice(1);
  const target = path.resolve(base, relative);
  if (!inside(base, target)) { response.writeHead(403).end(); return; }
  try {
    const details = await stat(target);
    if (!details.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": mime[path.extname(target).toLowerCase()] || "application/octet-stream", "content-length": details.size, "cache-control": "no-store" });
    if (request.method === "HEAD") response.end();
    else createReadStream(target).on("error", () => response.destroy()).pipe(response);
  } catch { response.writeHead(404).end(); }
});

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("本轮回归达到40分钟进程上限")), 40 * 60 * 1000);
const onInterrupt = () => controller.abort(new Error("本轮回归被中断"));
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);
const retrievalSession = createImageRetrievalSession({ signal: controller.signal, runtimeDirectory: path.join(runRoot, "retrieval-browser") });
const startedAt = Date.now();
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  ownership.consumers.push({ pid: process.pid, port, type: "loopback_static_server" });
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  const origin = `http://127.0.0.1:${port}`;
  const bytes = await readFile(input);
  const sourceFile = { name: path.basename(input), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  await save("input-fingerprint.json", { sha256: createHash("sha256").update(bytes).digest("hex"), fileName: path.basename(input), bytes: bytes.length });
  const textOptions = { apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: process.env.TEXT_MODEL_BASE_URL || "https://api.deepseek.com", model: process.env.TEXT_MODEL_NAME || "deepseek-v4-flash" };
  const imageOptions = {
    sourceMode: process.env.IMAGE_SOURCE_MODE || "web_only",
    knowledgeBaseUrl: process.env.IMAGE_KNOWLEDGE_BASE_URL,
    knowledgeScopeNodeIds: csv(process.env.IMAGE_KNOWLEDGE_NODE_IDS),
    knowledgeTopK: Number(process.env.IMAGE_KNOWLEDGE_TOP_K || 5),
    knowledgeTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_TIMEOUT_MS || 120000),
    knowledgeRequestTimeoutMs: Number(process.env.IMAGE_KNOWLEDGE_REQUEST_TIMEOUT_MS || 30000),
    knowledgePollIntervalMs: Number(process.env.IMAGE_KNOWLEDGE_POLL_INTERVAL_MS || 2000),
    trustedKnowledgeOrigins: csv(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS),
    searchApiKey: process.env.IMAGE_SEARCH_API_KEY, searchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL || "https://api.vveai.com/v1", searchModel: process.env.IMAGE_SEARCH_MODEL || "gemini-3.6-flash-search",
    visionApiKey: process.env.BIGMODEL_API_KEY, visionBaseUrl: process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4", visionModel: process.env.BIGMODEL_MODEL || "glm-5.3-flash",
    adapters: { retrievalSession },
  };
  log({ event: "live_regression_started", runRoot });
  const result = await runSimplePipeline({ sourceFile, baseData: createProductionDefaultData(), root: appRoot,
    storeRoot: path.join(runRoot, "projects"), origin, adapters: { store,
      runImage: (options) => runImageSearchSkill({ ...options, root: runRoot }),
      render: (options) => runSimpleRenderer({ ...options, root: appRoot, outputDirectory: path.join(runRoot, "render", options.projectId), origin }),
    }, plannerOptions: textOptions,
    copyOptions: { ...textOptions, researchApiKey: process.env.IMAGE_SEARCH_API_KEY, researchBaseUrl: process.env.IMAGE_SEARCH_BASE_URL || "https://api.vveai.com/v1" },
    imageOptions, signal: controller.signal,
    onEvent: (event) => {
      if (event.stage !== "capability" && event.phase !== "progress") log({ event: "stage", stage: event.stage, phase: event.phase, status: event.status || null });
    },
  });
  const outcome = result.pipelineStatus === "complete" && result.render?.status === "success" && result.render?.qa?.layout?.width === 2000
    ? "complete" : result.render?.status === "success" && ["partial", "awaiting_user_action"].includes(result.pipelineStatus)
      ? "editable_draft_needs_followup" : "incomplete_requires_attention";
  const summary = { runId, projectId: result.projectId, pipelineStatus: result.pipelineStatus, outcome, renderStatus: result.render?.status,
    renderWidth: result.render?.qa?.layout?.width || null, outputPath: result.outputPath,
    imageSlots: result.imageExecution?.results?.length || 0, selectedImages: result.imageExecution?.results?.filter((item) => item.selected).length || 0,
    unresolvedCount: result.unresolvedItems?.length || 0, callCounts: result.callCounts, timingsMs: result.timingsMs, durationMs: Date.now() - startedAt };
  await save("summary.json", summary);
  log({ event: "live_regression_finished", runRoot, projectId: summary.projectId, pipelineStatus: summary.pipelineStatus, outcome: summary.outcome, renderStatus: summary.renderStatus, renderWidth: summary.renderWidth });
  if (outcome !== "complete") process.exitCode = 2;
} catch (error) {
  await save("failure.json", { code: error?.code || "live_regression_failed", durationMs: Date.now() - startedAt });
  log({ event: "live_regression_failed", runRoot, code: error?.code || "live_regression_failed" });
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  await retrievalSession.close();
  if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  ownership.consumers = [];
  ownership.retirement = "owned loopback server and retrieval session closed; retain project evidence until independent review";
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  await new Promise((resolve) => eventLog.end(resolve));
}
