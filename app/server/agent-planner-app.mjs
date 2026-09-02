import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AgentPlanStore } from "./agent-plan-store.mjs";
import { AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";
import { AGENT_PROMPT_VERSION, buildAgentFactBasis, fingerprintFacts, generateAgentPlan } from "./agent-trip-planner.mjs";
import { analyzeAgentPreflight, resolvePreflightConfirmations } from "./agent-preflight.mjs";
import { cancelExecutionRun, createExecutionRun, EXECUTION_CONFIG_VERSION } from "./agent-execution-scheduler.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.join(root, "dist", "client");

function loadEnvFile(name) {
  const file = path.join(root, name);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("请求内容超过8MB限制");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".otf": "font/otf", ".ttf": "font/ttf" };
function streamFile(response, file) {
  response.writeHead(200, { "content-type": contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream" });
  createReadStream(file).pipe(response);
}

export function createAgentPlannerServer(options = {}) {
  const port = Number(options.port ?? process.env.AGENT_PLANNER_PORT ?? 4174);
  if (port === 4173) throw new Error("智能体规划服务禁止使用固定流程端口4173");
  const workspaceRoot = path.resolve(options.workspaceRoot || path.join(root, "workspace", "agent-v1", "projects"));
  mkdirSync(workspaceRoot, { recursive: true });
  const store = options.store || new AgentPlanStore(workspaceRoot);
  const jobs = new Map();
  const planner = options.planner || generateAgentPlan;
  const modelConfig = options.modelConfig || { apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: (process.env.TEXT_MODEL_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""), model: process.env.TEXT_MODEL_NAME || "deepseek-v4-flash" };

  const run = async (job, project) => {
    try {
      const result = await planner({ project, ...modelConfig, onStatus: (state) => { if (!job.cancelRequested) Object.assign(job, state, { updatedAt: new Date().toISOString() }); } });
      for (const attempt of result.attempts || []) store.saveAttempt(project.projectId, attempt);
      if (job.cancelRequested) { Object.assign(job, { status: "cancelled", message: "已取消", updatedAt: new Date().toISOString() }); store.updateProject(project.projectId, { status: "cancelled" }); return; }
      store.activatePlan(project.projectId, result.plan);
      store.updateProject(project.projectId, { activeJobId: null, lastError: null });
      Object.assign(job, { status: "complete", message: "规划已完成", planId: result.plan.planId, updatedAt: new Date().toISOString() });
    } catch (failure) {
      for (const attempt of failure.attempts || []) store.saveAttempt(project.projectId, attempt);
      const status = job.cancelRequested ? "cancelled" : "failed";
      Object.assign(job, { status, message: status === "cancelled" ? "已取消" : "规划失败", error: failure.message, validationErrors: failure.validationErrors || [], updatedAt: new Date().toISOString() });
      store.updateProject(project.projectId, { status: status === "cancelled" ? "cancelled" : "planning_failed", currentStage: status === "cancelled" ? "已取消" : "生成中断", activeJobId: null, lastError: failure.message });
    }
  };

  const startPlanning = (project, message = "正在理解行程") => {
    const now = new Date().toISOString();
    const job = { jobId: randomUUID(), projectId: project.projectId, status: "planning", message, createdAt: now, updatedAt: now, cancelRequested: false };
    jobs.set(job.jobId, job);
    const next = store.updateProject(project.projectId, { status: "planning", currentStage: "正在制定计划", activeJobId: job.jobId, lastError: null });
    setImmediate(() => run(job, next));
    return job;
  };

  const projectPayload = (projectId) => {
    const active = store.getActive(projectId);
    if (!active) return null;
    return { ...active, confirmations: store.getConfirmations(projectId), executionRun: store.getActiveExecutionRun(projectId), activeJob: active.project.activeJobId ? jobs.get(active.project.activeJobId) || null : null };
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/api/agent/health") return json(response, 200, { ok: true, flowKind: "agent_v1", port, executionEnabled: false, executionConfigVersion: EXECUTION_CONFIG_VERSION, plannerConfigured: Boolean(modelConfig.apiKey) });
    if (request.method === "POST" && url.pathname === "/api/agent/projects") {
      try {
        const payload = await requestBody(request);
        if (!payload?.facts?.days?.length) return json(response, 400, { error: "没有识别到可规划的逐日行程" });
        const factBasis = buildAgentFactBasis(payload.facts, payload.report);
        const inputFingerprint = fingerprintFacts({ factBasis, sourceSha256: payload.sourceSha256 || null });
        const now = new Date().toISOString();
        let project = store.createProject({ projectId: randomUUID(), flowKind: "agent_v1", executionEnabled: false, status: "preparing", currentStage: "正在准备", activePlanId: null, planIds: [], confirmationIds: [], executionRunIds: [], activeExecutionRunId: null, activeJobId: null, inputFingerprint, source: { name: String(payload.sourceName || payload.report?.workbookName || "行程资料.xlsx"), sha256: String(payload.sourceSha256 || ""), parser: "deterministic-itinerary-import-v1" }, factBasis, versions: { ruleProfileVersion: AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion: AGENT_CAPABILITY_VERSION, promptVersion: AGENT_PROMPT_VERSION, executionConfigVersion: EXECUTION_CONFIG_VERSION }, createdAt: now, updatedAt: now });
        const confirmations = analyzeAgentPreflight(factBasis);
        if (confirmations.length) {
          project = store.saveConfirmations(project.projectId, confirmations);
          project = store.updateProject(project.projectId, { status: "awaiting_confirmation", currentStage: "等待确认" });
          return json(response, 202, { projectId: project.projectId, status: project.status, confirmationRequired: true });
        }
        json(response, 202, startPlanning(project));
      } catch (failure) { json(response, 400, { error: failure.message || "无法创建规划项目" }); }
      return;
    }
    const confirmationMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/confirmations$/);
    if (request.method === "POST" && confirmationMatch) {
      try {
        const project = store.getProject(confirmationMatch[1]);
        if (!project) return json(response, 404, { error: "智能体项目不存在" });
        const payload = await requestBody(request);
        const resolved = resolvePreflightConfirmations(store.getConfirmations(project.projectId), payload.decisions);
        store.saveConfirmations(project.projectId, resolved);
        const pending = resolved.filter((item) => item.status === "pending");
        if (pending.length) {
          store.updateProject(project.projectId, { status: "awaiting_confirmation", currentStage: "等待确认", confirmationDecisions: resolved.filter((item) => item.selectedChoiceId) });
          return json(response, 200, projectPayload(project.projectId));
        }
        const next = store.updateProject(project.projectId, { confirmationDecisions: resolved, status: "preparing", currentStage: "正在准备" });
        return json(response, 202, startPlanning(next, "确认已记录，正在制定计划"));
      } catch (failure) { return json(response, 400, { error: failure.message || "无法记录确认" }); }
    }
    const replanMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/replan$/);
    if (request.method === "POST" && replanMatch) {
      const project = store.getProject(replanMatch[1]);
      if (!project) return json(response, 404, { error: "规划项目不存在" });
      const job = { jobId: randomUUID(), projectId: project.projectId, status: "planning", message: "正在重新规划", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelRequested: false };
      if (store.getConfirmations(project.projectId).some((item) => item.status === "pending")) return json(response, 409, { error: "仍有关键事实等待确认" });
      return json(response, 202, startPlanning(project, "正在重新规划"));
    }
    const executionMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/execution-runs$/);
    if (request.method === "POST" && executionMatch) {
      try {
        const active = store.getActive(executionMatch[1]);
        if (!active?.plan) return json(response, 409, { error: "当前项目还没有可用计划" });
        const executionRun = createExecutionRun(active.project, active.plan);
        store.saveExecutionRun(active.project.projectId, executionRun);
        return json(response, 403, { error: "执行能力尚未开放", executionRun });
      } catch (failure) { return json(response, 409, { error: failure.message }); }
    }
    const executionCancelMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/execution-runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && executionCancelMatch) {
      const payload = await requestBody(request).catch(() => ({}));
      if (payload.confirmed !== true) return json(response, 400, { error: "取消需要明确确认" });
      const runRecord = store.getExecutionRun(executionCancelMatch[1], executionCancelMatch[2]);
      if (!runRecord) return json(response, 404, { error: "执行记录不存在" });
      const cancelled = cancelExecutionRun(runRecord); store.saveExecutionRun(executionCancelMatch[1], cancelled);
      return json(response, 200, cancelled);
    }
    const projectCancelMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/cancel$/);
    if (request.method === "POST" && projectCancelMatch) {
      const payload = await requestBody(request).catch(() => ({}));
      if (payload.confirmed !== true) return json(response, 400, { error: "取消需要明确确认" });
      const project = store.getProject(projectCancelMatch[1]);
      if (!project) return json(response, 404, { error: "智能体项目不存在" });
      if (project.activeJobId && jobs.get(project.activeJobId)) jobs.get(project.activeJobId).cancelRequested = true;
      store.updateProject(project.projectId, { status: "cancelled", currentStage: "已取消" });
      return json(response, 200, projectPayload(project.projectId));
    }
    const cancelMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return json(response, 404, { error: "规划任务不存在" });
      job.cancelRequested = true; job.message = "正在取消"; job.updatedAt = new Date().toISOString();
      return json(response, 202, job);
    }
    const jobMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      return job ? json(response, 200, job) : json(response, 404, { error: "规划任务不存在" });
    }
    const projectMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)$/);
    if (request.method === "GET" && projectMatch) {
      const active = projectPayload(projectMatch[1]);
      return active ? json(response, 200, active) : json(response, 404, { error: "规划项目不存在" });
    }
    if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "智能体规划服务未提供该能力" });
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end("Method not allowed"); return; }
    const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
    const candidate = path.resolve(clientDir, relative);
    const file = candidate.startsWith(clientDir) && existsSync(candidate) ? candidate : path.join(clientDir, "index.html");
    if (!existsSync(file)) { response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("请先运行 npm run build"); return; }
    streamFile(response, file);
  });
  return { server, port, store, jobs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(".env.local");
  const { server, port } = createAgentPlannerServer();
  server.listen(port, "127.0.0.1", () => console.log(`行程成品生成智能体：http://127.0.0.1:${port}/agent`));
}
