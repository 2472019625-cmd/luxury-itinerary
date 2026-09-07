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
import { cancelExecutionRun, createExecutionRun, EXECUTION_CONFIG_VERSION, EXECUTION_ENABLED, resumeFailedExecutionRun, transitionExecutionTask } from "./agent-execution-scheduler.mjs";
import { AgentExecutionEngine } from "./agent-execution-engine.mjs";
import { applyRuntimeImageConfirmations, enrichPendingImageConfirmations, imageConfirmationChoices } from "./agent-image-confirmation.mjs";
import { evaluateAgentImageCompletion } from "./agent-image-plan.mjs";
import { runImageSearchSkill } from "./simple-image-skill.mjs";
import { runSimplePipeline } from "./simple-pipeline-executor.mjs";
import { buildSimpleManualImagePayload, chooseSimpleImageCandidate, rejectSimpleImageCandidate, researchSimpleImageSlot, uploadSimpleImage } from "./simple-manual-images.mjs";

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

async function requestBuffer(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 14 * 1024 * 1024) throw new Error("图片超过14MB限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".otf": "font/otf", ".ttf": "font/ttf" };
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
  const simpleStore = options.simpleStore || new AgentPlanStore(path.join(root, "output", "simple-pipeline", "projects"));
  const jobs = new Map();
  const controllers = new Map();
  const simpleJobs = new Map();
  const simpleControllers = new Map();
  const planner = options.planner || generateAgentPlan;
  const simplePipelineRunner = options.simplePipelineRunner || runSimplePipeline;
  const modelConfig = options.modelConfig || { apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: (process.env.TEXT_MODEL_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""), model: process.env.TEXT_MODEL_NAME || "deepseek-v4-flash" };
  const searchModelConfig = options.searchModelConfig || { apiKey: process.env.IMAGE_SEARCH_API_KEY, baseUrl: (process.env.IMAGE_SEARCH_BASE_URL || "https://api.vveai.com/v1").replace(/\/$/, ""), model: "gemini-3.7-flash-search", imageSearchModel: process.env.IMAGE_SEARCH_MODEL || "gemini-3.6-flash-search" };
  const visionModelConfig = options.visionModelConfig || { apiKey: process.env.BIGMODEL_API_KEY, baseUrl: (process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, ""), model: process.env.BIGMODEL_MODEL || "glm-5.3-flash" };
  const executor = options.executor || new AgentExecutionEngine({ store, root, origin: `http://127.0.0.1:${port}`, textModelConfig: modelConfig, searchModelConfig, visionModelConfig });

  const simpleStageDefinitions = [
    ["parser", "资料解析"],
    ["planner", "整程规划"],
    ["copy_skill", "文案生成"],
    ["image_skill", "图片处理"],
    ["program_writeback", "结果合并"],
    ["renderer", "成品渲染"],
  ];
  const simpleStageState = () => Object.fromEntries(simpleStageDefinitions.map(([id]) => [id, "pending"]));
  const simpleActionLabels = {
    parser: "正在解析并校验上传资料",
    planner: "正在建立整程内容与视觉计划",
    copy_skill: "正在生成客户文案",
    image_skill: "正在搜索并筛选图片",
    program_writeback: "正在合并文案与图片结果",
    renderer: "正在生成并检查 2000px 成品",
    copy_writer: "Copy Skill 正在生成客户文案",
    image_search: "Image Skill 正在搜索与下载图片",
    visual_judgment: "Image Skill 正在判断候选图片",
  };
  const updateSimpleJob = (job, event = {}) => {
    const now = new Date().toISOString();
    const stage = event.stage === "capability"
      ? (event.capabilityId === "copy_writer" || event.capabilityId === "copy_facts_research" ? "copy_skill" : "image_skill")
      : event.stage;
    const states = { ...job.stageStates };
    if (states[stage] && event.phase === "started") states[stage] = "running";
    if (states[stage] && event.phase === "finished") states[stage] = event.status === "failed" ? "failed" : "complete";
    if (event.stage === "skills" && event.phase === "finished") {
      states.copy_skill = "complete";
      states.image_skill = "complete";
    }
    let progress = Number(job.progress || 1);
    if (event.stage === "parser") progress = Math.max(progress, event.phase === "finished" ? 8 : 2);
    if (event.stage === "planner") progress = event.phase === "finished" ? Math.max(progress, 30) : Math.min(28, Math.max(progress + (event.phase === "progress" ? 1 : 2), 10));
    if (["copy_skill", "image_skill"].includes(event.stage) && event.phase === "started") progress = Math.max(progress, 34);
    if (event.stage === "capability" && event.phase === "finished") progress = Math.min(74, Math.max(progress + 1, 35));
    if (event.stage === "skills" && event.phase === "finished") progress = Math.max(progress, 75);
    if (event.stage === "program_writeback" && event.phase === "finished") progress = Math.max(progress, 82);
    if (event.stage === "renderer") progress = Math.max(progress, event.phase === "finished" ? 96 : 88);
    if (event.stage === "pipeline" && event.phase === "finished") progress = Number(event.progress || progress);
    const finishedAction = event.stage === "capability" && event.phase === "finished";
    const completedActions = Number(job.completedActions || 0) + (finishedAction ? 1 : 0);
    const detailMessage = event.detail?.message || event.detail?.currentAction;
    const target = event.target ? ` · ${event.target}` : "";
    Object.assign(job, {
      stageStates: states,
      stages: simpleStageDefinitions.map(([id, label]) => ({ id, label, status: states[id] })),
      progress,
      completedActions,
      currentAction: detailMessage || `${simpleActionLabels[event.capabilityId] || simpleActionLabels[stage] || "正在执行新版流程"}${target}`,
      latestEvent: event,
      updatedAt: now,
    });
    if (event.stage === "planner" && event.phase === "finished") job.totalWorkItems = Number(event.copyTaskCount || 0) + Number(event.imageSlotCount || 0);
  };
  const simpleProjectPayload = (projectId) => {
    const project = simpleStore.getProject(projectId);
    const job = simpleJobs.get(projectId) || null;
    if (!project && !job) return null;
    const plan = project?.activePlanId ? simpleStore.getPlan(projectId, project.activePlanId) : null;
    const executionRun = project?.activeExecutionRunId ? simpleStore.getExecutionRun(projectId, project.activeExecutionRunId) : null;
    const result = executionRun ? simpleStore.getFinalResult(projectId, executionRun.executionRunId) : null;
    return { project: project || job.project, plan, executionRun, result, activeJob: job, confirmations: [] };
  };
  const startSimplePipeline = (payload) => {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    const job = {
      jobId: randomUUID(), projectId, flowKind: "simple_skill_v1", status: "running", progress: 1,
      currentAction: "正在准备新版 Simple Pipeline", completedActions: 0, totalWorkItems: 0,
      stageStates: simpleStageState(), stages: simpleStageDefinitions.map(([id, label]) => ({ id, label, status: "pending" })),
      project: { projectId, flowKind: "simple_skill_v1", status: "planning", currentStage: "资料解析", progress: 1, createdAt: now, updatedAt: now },
      createdAt: now, updatedAt: now,
    };
    const controller = new AbortController();
    simpleJobs.set(projectId, job);
    simpleControllers.set(projectId, controller);
    const sourceData = { data: payload.facts, report: payload.report || {}, fileName: payload.sourceName || payload.report?.workbookName || "行程资料.xlsx" };
    setImmediate(async () => {
      try {
        const result = await simplePipelineRunner({
          projectId,
          sourceData,
          root,
          adapters: { store: simpleStore },
          plannerOptions: modelConfig,
          copyOptions: modelConfig,
          imageOptions: {
            searchApiKey: searchModelConfig.apiKey,
            searchBaseUrl: searchModelConfig.baseUrl,
            searchModel: searchModelConfig.imageSearchModel,
            visionApiKey: visionModelConfig.apiKey,
            visionBaseUrl: visionModelConfig.baseUrl,
            visionModel: visionModelConfig.model,
          },
          signal: controller.signal,
          onEvent: (event) => updateSimpleJob(job, event),
        });
        job.status = result.pipelineStatus;
        job.progress = result.pipelineStatus === "complete" ? 100 : result.pipelineStatus === "awaiting_user_action" ? 85 : 75;
        job.currentAction = result.pipelineStatus === "complete" ? "新版流程已完成" : result.pipelineStatus === "awaiting_user_action" ? "需要补充必需图片" : "部分责任单元需要处理";
      } catch (failure) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.currentAction = controller.signal.aborted ? "已取消" : "新版流程执行失败";
        job.error = failure.message || String(failure);
      } finally {
        job.updatedAt = new Date().toISOString();
        simpleControllers.delete(projectId);
      }
    });
    return job;
  };

  const run = async (job, project) => {
    let phase = "planning";
    try {
      const controller = controllers.get(job.jobId);
      const result = await planner({ project, ...modelConfig, signal: controller?.signal, onStatus: (state) => { if (!job.cancelRequested) Object.assign(job, state, { updatedAt: new Date().toISOString() }); } });
      for (const attempt of result.attempts || []) store.saveAttempt(project.projectId, attempt);
      if (job.cancelRequested) { Object.assign(job, { status: "cancelled", message: "已取消", updatedAt: new Date().toISOString() }); store.updateProject(project.projectId, { status: "cancelled" }); return; }
      const activated = store.activatePlan(project.projectId, result.plan);
      const executionRun = createExecutionRun(activated, result.plan);
      store.saveExecutionRun(project.projectId, executionRun);
      phase = "execution";
      Object.assign(job, { status: "running", message: "规划已完成，正在执行生成任务", planId: result.plan.planId, executionRunId: executionRun.executionRunId, updatedAt: new Date().toISOString() });
      const finalRun = await executor.execute(project.projectId, executionRun, { signal: controller?.signal });
      const status = finalRun.status === "complete" ? "complete" : finalRun.status === "cancelled" ? "cancelled" : finalRun.status === "waiting_confirmation" ? "waiting_confirmation" : "failed";
      Object.assign(job, { status, message: status === "complete" ? "完整成品已通过全部检查" : status === "waiting_confirmation" ? "等待处理关键确认" : status === "cancelled" ? "已取消" : "执行失败", updatedAt: new Date().toISOString() });
      store.updateProject(project.projectId, { activeJobId: null });
    } catch (failure) {
      for (const attempt of failure.attempts || []) store.saveAttempt(project.projectId, attempt);
      const status = job.cancelRequested ? "cancelled" : "failed";
      Object.assign(job, { status, message: status === "cancelled" ? "已取消" : phase === "planning" ? "规划失败" : "执行失败", error: failure.message, validationErrors: failure.validationErrors || [], updatedAt: new Date().toISOString() });
      if (phase === "planning") store.updateProject(project.projectId, { status: status === "cancelled" ? "cancelled" : "planning_failed", currentStage: status === "cancelled" ? "已取消" : "生成中断", activeJobId: null, lastError: failure.message });
      else store.updateProject(project.projectId, { activeJobId: null });
    } finally {
      controllers.delete(job.jobId);
    }
  };

  const startPlanning = (project, message = "正在理解行程") => {
    const now = new Date().toISOString();
    const job = { jobId: randomUUID(), projectId: project.projectId, status: "planning", message, createdAt: now, updatedAt: now, cancelRequested: false };
    jobs.set(job.jobId, job);
    controllers.set(job.jobId, new AbortController());
    const next = store.updateProject(project.projectId, { status: "planning", currentStage: "正在制定计划", activeJobId: job.jobId, lastError: null });
    setImmediate(() => run(job, next));
    return job;
  };

  const resumeExecution = (project, runRecord, message = "正在从确认位置继续") => {
    const now = new Date().toISOString();
    const job = { jobId: randomUUID(), projectId: project.projectId, status: "running", message, createdAt: now, updatedAt: now, cancelRequested: false, executionRunId: runRecord.executionRunId, planId: runRecord.planId };
    jobs.set(job.jobId, job);
    const controller = new AbortController();
    controllers.set(job.jobId, controller);
    store.updateProject(project.projectId, { status: "running", currentStage: message, activeJobId: job.jobId, lastError: null });
    setImmediate(async () => {
      try {
        const finalRun = await executor.execute(project.projectId, runRecord, { signal: controller.signal });
        job.status = finalRun.status === "complete" ? "complete" : finalRun.status;
        job.message = finalRun.status === "complete" ? "完整成品已通过全部检查" : finalRun.status === "waiting_confirmation" ? "等待处理关键确认" : finalRun.status === "cancelled" ? "已取消" : "执行结束";
      } catch (failure) { job.status = "failed"; job.message = "执行失败"; job.error = failure.message; }
      finally { job.updatedAt = new Date().toISOString(); controllers.delete(job.jobId); store.updateProject(project.projectId, { activeJobId: null }); }
    });
    return job;
  };

  const projectPayload = (projectId) => {
    const active = store.getActive(projectId);
    if (!active) return null;
    const executionRun = store.getActiveExecutionRun(projectId);
    let confirmations = store.getConfirmations(projectId);
    if (executionRun?.status === "waiting_confirmation") {
      const savedImages = store.getTaskResult(projectId, executionRun.executionRunId, "image-pipeline");
      if (savedImages?.data) {
        const enriched = enrichPendingImageConfirmations(confirmations, savedImages.data);
        if (JSON.stringify(enriched) !== JSON.stringify(confirmations)) store.saveConfirmations(projectId, enriched);
        confirmations = enriched;
      }
    }
    return { ...active, confirmations, executionRun, result: executionRun?.status === "complete" ? store.getFinalResult(projectId, executionRun.executionRunId) : null, activeJob: active.project.activeJobId ? jobs.get(active.project.activeJobId) || null : null };
  };

  const imageGapConfirmations = (plan, data) => {
    const imageGate = evaluateAgentImageCompletion(data);
    const gapTaskIds = plan.tasks.filter((task) => task.taskType === "image_gap_resolution").map((task) => task.taskId);
    return imageGate.missingRequired.map((item) => ({
      confirmationId: randomUUID(), category: "图片", status: "pending", imageSlotId: item.slotId,
      question: `必需图片位 ${item.slotId} 尚未自动通过，请看图确认、定向重搜或继续等待。`,
      reason: `当前状态：${item.status}。必需位不能留空进入成品。`, source: "图片搜索与视觉审核结果",
      affectedTaskIds: gapTaskIds, affectedTaskTypes: [], affectedPaths: [], choices: imageConfirmationChoices(data, item.slotId),
    }));
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === "POST" && url.pathname === "/api/simple/projects") {
      try {
        const payload = await requestBody(request);
        if (!payload?.facts?.days?.length) return json(response, 400, { error: "没有识别到可执行的逐日行程" });
        const job = startSimplePipeline(payload);
        return json(response, 202, { projectId: job.projectId, flowKind: job.flowKind, status: job.status, progress: job.progress });
      } catch (failure) { return json(response, 400, { error: failure.message || "无法启动新版 Simple Pipeline" }); }
    }
    const simpleProjectMatch = url.pathname.match(/^\/api\/simple\/projects\/([^/]+)$/);
    if (request.method === "GET" && simpleProjectMatch) {
      const active = simpleProjectPayload(decodeURIComponent(simpleProjectMatch[1]));
      return active ? json(response, 200, active) : json(response, 404, { error: "Simple Pipeline 项目不存在" });
    }
    const simpleCancelMatch = url.pathname.match(/^\/api\/simple\/projects\/([^/]+)\/cancel$/);
    if (request.method === "POST" && simpleCancelMatch) {
      const payload = await requestBody(request).catch(() => ({}));
      if (payload.confirmed !== true) return json(response, 400, { error: "取消需要明确确认" });
      const projectId = decodeURIComponent(simpleCancelMatch[1]);
      const job = simpleJobs.get(projectId);
      if (!job) return json(response, 404, { error: "Simple Pipeline 任务不存在" });
      simpleControllers.get(projectId)?.abort();
      job.status = "cancelled"; job.currentAction = "正在取消"; job.updatedAt = new Date().toISOString();
      return json(response, 202, simpleProjectPayload(projectId));
    }
    const simpleManualMatch = url.pathname.match(/^\/api\/simple\/projects\/([^/]+)\/manual-images$/);
    if (request.method === "GET" && simpleManualMatch) {
      try { return json(response, 200, buildSimpleManualImagePayload(simpleStore, decodeURIComponent(simpleManualMatch[1]))); }
      catch (failure) { return json(response, failure.code === "simple_project_incomplete" ? 409 : 404, { error: failure.message, code: failure.code || "simple_project_not_found" }); }
    }
    const simpleCandidateMatch = url.pathname.match(/^\/api\/simple\/projects\/([^/]+)\/manual-images\/([^/]+)\/(select|reject)$/);
    if (request.method === "POST" && simpleCandidateMatch) {
      try {
        const payload = await requestBody(request);
        const input = { store: simpleStore, root, projectId: decodeURIComponent(simpleCandidateMatch[1]), slotId: decodeURIComponent(simpleCandidateMatch[2]), candidateId: String(payload.candidateId || "") };
        const result = simpleCandidateMatch[3] === "select" ? await chooseSimpleImageCandidate(input) : await rejectSimpleImageCandidate(input);
        return json(response, 200, result);
      } catch (failure) { return json(response, 400, { error: failure.message, code: failure.code || "manual_image_decision_failed" }); }
    }
    const simpleUploadMatch = url.pathname.match(/^\/api\/simple\/projects\/([^/]+)\/manual-images\/([^/]+)\/upload$/);
    if (request.method === "POST" && simpleUploadMatch) {
      try {
        const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const buffer = await requestBuffer(request);
        const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
        const result = await uploadSimpleImage({ store: simpleStore, root, projectId: decodeURIComponent(simpleUploadMatch[1]), slotId: decodeURIComponent(simpleUploadMatch[2]), dataUrl, fileName: decodeURIComponent(String(request.headers["x-file-name"] || "用户上传图片")) });
        return json(response, 200, result);
      } catch (failure) { return json(response, 400, { error: failure.message, code: failure.code || "manual_image_upload_failed" }); }
    }
    const simpleResearchMatch = url.pathname.match(/^\/api\/simple\/projects\/([^/]+)\/manual-images\/([^/]+)\/research$/);
    if (request.method === "POST" && simpleResearchMatch) {
      try {
        const result = await researchSimpleImageSlot({
          store: simpleStore,
          root,
          projectId: decodeURIComponent(simpleResearchMatch[1]),
          slotId: decodeURIComponent(simpleResearchMatch[2]),
          runImage: runImageSearchSkill,
          imageOptions: {
            searchApiKey: searchModelConfig.apiKey,
            searchBaseUrl: searchModelConfig.baseUrl,
            searchModel: searchModelConfig.imageSearchModel,
            visionApiKey: visionModelConfig.apiKey,
            visionBaseUrl: visionModelConfig.baseUrl,
            visionModel: visionModelConfig.model,
            maxQueriesPerSlot: 3,
            sourcePagesPerSlot: 8,
            downloadsPerSlot: 12,
            visionCandidatesPerSlot: 4,
            concurrency: { slots: 1, search: 1, pages: 4, downloads: 3, vision: 1 },
          },
        });
        return json(response, 200, result);
      } catch (failure) { return json(response, 400, { error: failure.message, code: failure.code || "manual_image_research_failed" }); }
    }
    const simpleOutputMatch = url.pathname.match(/^\/api\/simple\/projects\/([^/]+)\/output$/);
    if (["GET", "HEAD"].includes(request.method) && simpleOutputMatch) {
      try {
        const projectId = decodeURIComponent(simpleOutputMatch[1]);
        const project = simpleStore.getProject(projectId);
        const activeRun = project?.activeExecutionRunId ? simpleStore.getExecutionRun(projectId, project.activeExecutionRunId) : null;
        const result = activeRun ? simpleStore.getFinalResult(projectId, activeRun.executionRunId) : null;
        const outputRoot = path.resolve(root, "output");
        const file = result?.pipelineStatus === "complete" && result.outputPath ? path.resolve(result.outputPath) : null;
        if (!file || !file.startsWith(`${outputRoot}${path.sep}`) || !existsSync(file)) return json(response, 404, { error: "正式成品文件不存在" });
        response.writeHead(200, { "content-type": "image/png", "content-disposition": `attachment; filename="itinerary-${projectId}.png"` });
        if (request.method === "HEAD") return response.end();
        return createReadStream(file).pipe(response);
      } catch (failure) { return json(response, 404, { error: failure.message || "正式成品文件不存在" }); }
    }
    if (request.method === "GET" && url.pathname === "/api/agent/health") return json(response, 200, { ok: true, flowKind: "agent_v1", port, executionEnabled: EXECUTION_ENABLED, executionConfigVersion: EXECUTION_CONFIG_VERSION, plannerConfigured: Boolean(modelConfig.apiKey), factSearchConfigured: Boolean(searchModelConfig.apiKey), imageSearchConfigured: Boolean(searchModelConfig.apiKey), visualAuditConfigured: Boolean(visionModelConfig.apiKey) });
    if (request.method === "POST" && url.pathname === "/api/agent/projects") {
      try {
        const payload = await requestBody(request);
        if (!payload?.facts?.days?.length) return json(response, 400, { error: "没有识别到可规划的逐日行程" });
        const factBasis = buildAgentFactBasis(payload.facts, payload.report);
        const inputFingerprint = fingerprintFacts({ factBasis, sourceSha256: payload.sourceSha256 || null });
        const now = new Date().toISOString();
        let project = store.createProject({ projectId: randomUUID(), flowKind: "agent_v1", executionEnabled: false, status: "preparing", currentStage: "正在准备", activePlanId: null, planIds: [], confirmationIds: [], executionRunIds: [], activeExecutionRunId: null, activeJobId: null, inputFingerprint, source: { name: String(payload.sourceName || payload.report?.workbookName || "行程资料.xlsx"), sha256: String(payload.sourceSha256 || ""), parser: "deterministic-itinerary-import-v1" }, factBasis, versions: { ruleProfileVersion: AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion: AGENT_CAPABILITY_VERSION, promptVersion: AGENT_PROMPT_VERSION, executionConfigVersion: EXECUTION_CONFIG_VERSION }, createdAt: now, updatedAt: now });
        store.saveSourceData(project.projectId, { facts: payload.facts, report: payload.report || {}, sourceName: payload.sourceName || null, sourceSha256: payload.sourceSha256 || null, inputFingerprint, savedAt: now });
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
        const activeBeforeConfirmation = store.getActiveExecutionRun(project.projectId);
        const savedImagesBeforeConfirmation = activeBeforeConfirmation?.status === "waiting_confirmation" ? store.getTaskResult(project.projectId, activeBeforeConfirmation.executionRunId, "image-pipeline") : null;
        const currentConfirmations = savedImagesBeforeConfirmation?.data ? enrichPendingImageConfirmations(store.getConfirmations(project.projectId), savedImagesBeforeConfirmation.data) : store.getConfirmations(project.projectId);
        const resolved = resolvePreflightConfirmations(currentConfirmations, payload.decisions);
        store.saveConfirmations(project.projectId, resolved);
        const pending = resolved.filter((item) => item.status === "pending");
        if (pending.length) {
          store.updateProject(project.projectId, { status: "awaiting_confirmation", currentStage: "等待确认", confirmationDecisions: resolved.filter((item) => item.selectedChoiceId) });
          return json(response, 200, projectPayload(project.projectId));
        }
        const next = store.updateProject(project.projectId, { confirmationDecisions: resolved, status: "preparing", currentStage: "正在准备" });
        const activeRun = store.getActiveExecutionRun(project.projectId);
        if (activeRun?.status === "waiting_confirmation") {
          const savedImages = store.getTaskResult(project.projectId, activeRun.executionRunId, "image-pipeline");
          if (savedImages?.data) {
            const appliedImages = applyRuntimeImageConfirmations(savedImages, resolved);
            if (appliedImages.appliedCount) store.saveTaskResult(project.projectId, activeRun.executionRunId, "image-pipeline", appliedImages);
            const imageGate = evaluateAgentImageCompletion(appliedImages.data);
            if (!imageGate.passed) return json(response, 409, { error: "仍有必需图片位等待确认", imageGate });
          }
          const plan = store.getPlan(project.projectId, activeRun.planId);
          let resumed = activeRun;
          for (const taskRun of resumed.taskRuns.filter((item) => item.status === "waiting_confirmation")) resumed = transitionExecutionTask(plan, resumed, taskRun.taskId, "user_resolved", { message: "用户已保存关键确认" });
          store.updateExecutionRun(project.projectId, resumed);
          return json(response, 202, resumeExecution(store.getProject(project.projectId), resumed));
        }
        return json(response, 202, startPlanning(next, "确认已记录，正在制定计划"));
      } catch (failure) { return json(response, 400, { error: failure.message || "无法记录确认" }); }
    }
    const imageRetryMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/image-retry$/);
    if (request.method === "POST" && imageRetryMatch) {
      try {
        const project = store.getProject(imageRetryMatch[1]);
        const activeRun = project ? store.getActiveExecutionRun(project.projectId) : null;
        if (!project || !activeRun) return json(response, 404, { error: "智能体项目或执行记录不存在" });
        if (activeRun.status !== "waiting_confirmation") return json(response, 409, { error: "当前项目不在必需图片等待阶段" });
        if (project.activeJobId) return json(response, 409, { error: "当前项目已有任务正在运行" });
        const savedImages = store.getTaskResult(project.projectId, activeRun.executionRunId, "image-pipeline");
        const gate = evaluateAgentImageCompletion(savedImages?.data || {});
        const retryable = new Set(gate.missingRequired.map((item) => item.slotId));
        const payload = await requestBody(request);
        const requested = [...new Set(Array.isArray(payload.slotIds) ? payload.slotIds.map(String) : [])].filter((slotId) => retryable.has(slotId));
        if (!requested.length) return json(response, 400, { error: "没有可定向重搜的必需图片位" });
        const now = new Date().toISOString();
        const job = { jobId: randomUUID(), projectId: project.projectId, kind: "image-targeted-retry", status: "running", message: `正在定向重搜 ${requested.length} 个图片位`, slotIds: requested, createdAt: now, updatedAt: now };
        jobs.set(job.jobId, job);
        const controller = new AbortController();
        controllers.set(job.jobId, controller);
        store.updateProject(project.projectId, { status: "running", currentStage: job.message, activeJobId: job.jobId, lastError: null });
        json(response, 202, job);
        setImmediate(async () => {
          try {
            const result = await executor.retryImageSlots(project.projectId, activeRun, requested, { signal: controller.signal, onProgress: (event) => { job.message = event.currentAction || "正在定向重搜图片"; job.stats = event.stats || {}; job.updatedAt = new Date().toISOString(); } });
            const plan = store.getPlan(project.projectId, activeRun.planId);
            const retained = store.getConfirmations(project.projectId).filter((item) => item.category !== "图片" || item.status === "resolved");
            const confirmations = imageGapConfirmations(plan, result.data);
            store.saveConfirmations(project.projectId, [...retained, ...confirmations]);
            if (confirmations.length) {
              job.status = "waiting_confirmation";
              job.message = `定向重搜完成，仍有 ${confirmations.length} 个必需图片位需要处理`;
              store.updateProject(project.projectId, { status: "awaiting_confirmation", currentStage: "等待处理必需图片位", activeJobId: null });
            } else {
              let resumed = result.run;
              for (const taskRun of resumed.taskRuns.filter((item) => item.status === "waiting_confirmation")) resumed = transitionExecutionTask(plan, resumed, taskRun.taskId, "user_resolved", { message: "定向重搜已补齐必需图片位" });
              store.updateExecutionRun(project.projectId, resumed);
              const finalRun = await executor.execute(project.projectId, resumed, { signal: controller.signal });
              job.status = finalRun.status === "complete" ? "complete" : finalRun.status;
              job.message = finalRun.status === "complete" ? "定向重搜及后续检查已完成" : "定向重搜后已继续执行";
            }
          } catch (failure) {
            job.status = "failed"; job.message = "定向重搜失败，已保留原检查点"; job.error = failure.message;
            store.updateProject(project.projectId, { status: "awaiting_confirmation", currentStage: "图片定向重搜失败，可再次尝试", activeJobId: null, lastError: failure.message });
          } finally {
            job.updatedAt = new Date().toISOString(); controllers.delete(job.jobId);
            const latest = store.getProject(project.projectId);
            if (latest?.activeJobId === job.jobId) store.updateProject(project.projectId, { activeJobId: null });
          }
        });
      } catch (failure) { return json(response, 400, { error: failure.message || "无法启动图片定向重搜" }); }
      return;
    }
    const imageDeferMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/image-defer-validation$/);
    if (request.method === "POST" && imageDeferMatch) {
      try {
        const payload = await requestBody(request);
        if (payload.validationOnly !== true) return json(response, 400, { error: "暂缓图片只能用于继续验证后续环节" });
        const project = store.getProject(imageDeferMatch[1]);
        const activeRun = project ? store.getActiveExecutionRun(project.projectId) : null;
        if (!project || !activeRun) return json(response, 404, { error: "智能体项目或执行记录不存在" });
        if (activeRun.status !== "waiting_confirmation") return json(response, 409, { error: "当前项目不在图片等待阶段" });
        const savedImages = store.getTaskResult(project.projectId, activeRun.executionRunId, "image-pipeline");
        const imageGate = evaluateAgentImageCompletion(savedImages?.data || {});
        if (imageGate.passed) return json(response, 409, { error: "必需图片已经完成，无需暂缓" });
        const plan = store.getPlan(project.projectId, activeRun.planId);
        const confirmations = store.getConfirmations(project.projectId).map((item) => item.status === "pending" && item.category === "图片" ? { ...item, status: "resolved", selectedChoiceId: "defer_image_for_downstream_validation", resolvedAt: new Date().toISOString() } : item);
        store.saveConfirmations(project.projectId, confirmations);
        const evidenceRef = store.saveEvidence(project.projectId, activeRun.executionRunId, "image-gap-deferred-for-validation", { validationOnly: true, requestedAt: new Date().toISOString(), missingRequired: imageGate.missingRequired, rule: "不得计为图片通过，不得绕过最终完成门禁" });
        let resumed = activeRun;
        for (const taskRun of resumed.taskRuns.filter((item) => item.status === "waiting_confirmation")) resumed = transitionExecutionTask(plan, resumed, taskRun.taskId, "user_accepted_suggestion", { message: "用户要求暂缓图片搜索，仅继续验证渲染与最终检查", evidenceRefs: [evidenceRef] });
        store.updateExecutionRun(project.projectId, resumed);
        return json(response, 202, resumeExecution(store.getProject(project.projectId), resumed, "图片缺口已保留，正在验证后续环节"));
      } catch (failure) { return json(response, 400, { error: failure.message || "无法暂缓图片并继续验证" }); }
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
        const current = store.getActiveExecutionRun(active.project.projectId);
        if (current && ["pending", "running", "waiting_confirmation"].includes(current.status)) return json(response, 200, { executionRun: current });
        if (current?.status === "failed") {
          const resumed = resumeFailedExecutionRun(active.plan, current);
          store.updateExecutionRun(active.project.projectId, resumed);
          const job = resumeExecution(store.getProject(active.project.projectId), resumed, "正在从失败阶段继续执行");
          return json(response, 202, { executionRun: resumed, job, resumedFromFailure: true });
        }
        const executionRun = createExecutionRun(active.project, active.plan);
        store.saveExecutionRun(active.project.projectId, executionRun);
        const job = resumeExecution(store.getProject(active.project.projectId), executionRun, "正在执行当前计划");
        return json(response, 202, { executionRun, job });
      } catch (failure) { return json(response, 409, { error: failure.message }); }
    }
    const executionCancelMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/execution-runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && executionCancelMatch) {
      const payload = await requestBody(request).catch(() => ({}));
      if (payload.confirmed !== true) return json(response, 400, { error: "取消需要明确确认" });
      const runRecord = store.getExecutionRun(executionCancelMatch[1], executionCancelMatch[2]);
      if (!runRecord) return json(response, 404, { error: "执行记录不存在" });
      const plan = store.getPlan(executionCancelMatch[1], runRecord.planId);
      const cancelled = cancelExecutionRun(plan, runRecord); store.updateExecutionRun(executionCancelMatch[1], cancelled);
      return json(response, 200, cancelled);
    }
    const projectCancelMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/cancel$/);
    if (request.method === "POST" && projectCancelMatch) {
      const payload = await requestBody(request).catch(() => ({}));
      if (payload.confirmed !== true) return json(response, 400, { error: "取消需要明确确认" });
      const project = store.getProject(projectCancelMatch[1]);
      if (!project) return json(response, 404, { error: "智能体项目不存在" });
      if (project.activeJobId && jobs.get(project.activeJobId)) { jobs.get(project.activeJobId).cancelRequested = true; controllers.get(project.activeJobId)?.abort(); }
      const activeRun = store.getActiveExecutionRun(project.projectId);
      if (activeRun && !["cancelled", "complete"].includes(activeRun.status)) {
        const plan = store.getPlan(project.projectId, activeRun.planId);
        store.updateExecutionRun(project.projectId, cancelExecutionRun(plan, activeRun));
      }
      store.updateProject(project.projectId, { status: "cancelled", currentStage: "已取消" });
      return json(response, 200, projectPayload(project.projectId));
    }
    const cancelMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return json(response, 404, { error: "规划任务不存在" });
      job.cancelRequested = true; job.message = "正在取消"; job.updatedAt = new Date().toISOString(); controllers.get(job.jobId)?.abort();
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
    const outputMatch = url.pathname.match(/^\/api\/agent\/projects\/([^/]+)\/output$/);
    if (["GET", "HEAD"].includes(request.method) && outputMatch) {
      const activeRun = store.getActiveExecutionRun(outputMatch[1]);
      const result = activeRun?.status === "complete" ? store.getFinalResult(outputMatch[1], activeRun.executionRunId) : null;
      const outputRoot = path.resolve(root, "output");
      const file = result?.outputFile ? path.resolve(result.outputFile) : null;
      if (!file || !file.startsWith(`${outputRoot}${path.sep}`) || !existsSync(file)) return json(response, 404, { error: "正式成品文件不存在" });
      response.writeHead(200, { "content-type": "image/png", "content-disposition": `attachment; filename="itinerary-${outputMatch[1]}.png"` });
      if (request.method === "HEAD") return response.end();
      return createReadStream(file).pipe(response);
    }
    if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "智能体规划服务未提供该能力" });
    if (["GET", "HEAD"].includes(request.method) && url.pathname.startsWith("/image-assets/")) {
      const assetRoot = path.resolve(root, "output", "image-assets");
      const relativeAsset = decodeURIComponent(url.pathname.slice("/image-assets/".length));
      const file = path.resolve(assetRoot, relativeAsset);
      if (!file.startsWith(`${assetRoot}${path.sep}`) || !existsSync(file)) return json(response, 404, { error: "图片素材不存在" });
      if (request.method === "HEAD") { response.writeHead(200, { "content-type": contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream" }); return response.end(); }
      return streamFile(response, file);
    }
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end("Method not allowed"); return; }
    const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
    const candidate = path.resolve(clientDir, relative);
    const file = candidate.startsWith(clientDir) && existsSync(candidate) ? candidate : path.join(clientDir, "index.html");
    if (!existsSync(file)) { response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("请先运行 npm run build"); return; }
    streamFile(response, file);
  });
  return { server, port, store, jobs, controllers, executor, simpleStore, simpleJobs, simpleControllers };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(".env.local");
  loadEnvFile(".env.image-search.local");
  const { server, port } = createAgentPlannerServer();
  server.listen(port, "127.0.0.1", () => console.log(`行程成品生成智能体：http://127.0.0.1:${port}/agent`));
}
