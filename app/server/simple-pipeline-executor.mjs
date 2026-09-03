import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { normalizeItineraryFacts, validateItineraryFacts } from "../src/lib/itineraryRules.js";
import { AgentPlanStore } from "./agent-plan-store.mjs";
import { buildAgentFactBasis, fingerprintFacts, generateAgentPlan } from "./agent-trip-planner.mjs";
import { materializeSimpleSkillPlan } from "./simple-plan-adapter.mjs";
import { runCopyWriterSkill } from "./simple-copy-skill.mjs";
import { runImageSearchSkill } from "./simple-image-skill.mjs";
import { applySimpleSkillResults } from "./simple-pipeline-writeback.mjs";
import { runSimpleRenderer } from "./simple-renderer.mjs";
import { applyApprovedFixedModules, SIMPLE_PIPELINE_DEFAULT_ORIGIN } from "./simple-fixed-modules.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disabledLegacyCapabilities = new Set(["brand_reviewer", "review_decision", "finding_package", "copy_regeneration", "image_second_round", "targeted_image_research", "stage_budget"]);

function elapsed(startedAt) { return Date.now() - startedAt; }
export function statusFor(unresolved, renderStatus) {
  if (renderStatus === "success" && !unresolved.length) return "complete";
  const required = unresolved.filter((item) => item.required);
  if (required.some((item) => item.kind !== "image")) return "partial";
  if (required.some((item) => item.kind === "image" && !["not_found", "needs_user_action"].includes(item.status))) return "partial";
  if (required.some((item) => item.kind === "image" && ["not_found", "needs_user_action"].includes(item.status) && item.requiredAction === "needs_user_action")) return "awaiting_user_action";
  if (required.length) return "partial";
  return renderStatus === "blocked" || renderStatus === "failed" ? "partial" : "ready_to_render";
}

function callCounts({ agentPlan, copyExecution, imageExecution, renderExecution }) {
  const plannerCalls = agentPlan?.capabilityCallStats?.find((item) => item.capabilityId === "trip_planner")?.actualCalls || 1;
  return {
    parserCalls: 1,
    plannerModelCalls: plannerCalls,
    copyBusinessBatches: copyExecution?.metrics?.businessBatches || 0,
    copyModelCalls: copyExecution?.metrics?.modelCalls || 0,
    imageBusinessBatches: imageExecution?.metrics?.businessBatches || 0,
    imageSearchCalls: imageExecution?.metrics?.searchCalls || 0,
    imageCommonsCalls: imageExecution?.metrics?.commonsCalls || 0,
    imagePageExtractionCalls: imageExecution?.metrics?.pageExtractionCalls || 0,
    imageDownloadAttempts: imageExecution?.metrics?.downloadAttempts || 0,
    imageVisualJudgmentCalls: (imageExecution?.metrics?.batchVisionCalls || 0) + (imageExecution?.metrics?.topConfirmationCalls || 0),
    rendererCalls: renderExecution?.rendererCalls || 0,
  };
}

function runtimeLegacyEvidence(events, copyExecution, imageExecution) {
  const invoked = [...new Set(events.map((item) => item.capabilityId).filter((id) => disabledLegacyCapabilities.has(id)))];
  const automaticCopyRegenerationRounds = Number(copyExecution?.metrics?.automaticBusinessRetryRounds || 0);
  const automaticImageFollowupRounds = Number(imageExecution?.metrics?.automaticFollowupRounds || 0);
  return {
    source: "executor_runtime_capability_events",
    observedEventCount: events.length,
    invoked,
    automaticCopyRegenerationRounds,
    automaticImageFollowupRounds,
    clear: invoked.length === 0 && automaticCopyRegenerationRounds === 0 && automaticImageFollowupRounds === 0,
    checked: [...disabledLegacyCapabilities],
  };
}

export async function runSimplePipeline({
  sourceFile,
  baseData = {},
  root = appRoot,
  storeRoot = path.join(root, "output", "simple-pipeline", "projects"),
  origin = SIMPLE_PIPELINE_DEFAULT_ORIGIN,
  plannerOptions = {},
  copyOptions = {},
  imageOptions = {},
  adapters = {},
  onEvent,
  signal,
} = {}) {
  const totalStartedAt = Date.now();
  const timingsMs = { parser: 0, planner: 0, copySkill: 0, imageSkill: 0, programWriteback: 0, renderer: 0, persistence: 0, total: 0 };
  const capabilityEvents = [];
  const emit = (event) => onEvent?.({ at: new Date().toISOString(), ...event });
  const capabilityEvent = (event) => { capabilityEvents.push({ at: Date.now(), ...event }); emit({ stage: "capability", ...event }); };
  const parse = adapters.parse || importItineraryWorkbook;
  const planAgent = adapters.planAgent || generateAgentPlan;
  const adaptPlan = adapters.adaptPlan || materializeSimpleSkillPlan;
  const runCopy = adapters.runCopy || runCopyWriterSkill;
  const runImage = adapters.runImage || runImageSearchSkill;
  const applyResults = adapters.applyResults || applySimpleSkillResults;
  const render = adapters.render || runSimpleRenderer;
  const store = adapters.store || new AgentPlanStore(storeRoot);
  if (!sourceFile || typeof sourceFile.arrayBuffer !== "function") {
    const error = new Error("主输入必须是一份可读取的 Excel 文件");
    error.code = "source_input_invalid";
    throw error;
  }

  emit({ stage: "parser", phase: "started" });
  const parserStartedAt = Date.now();
  let imported;
  try {
    imported = await parse(sourceFile, applyApprovedFixedModules(baseData));
  } catch (error) {
    error.code ||= "source_parse_failed";
    throw error;
  } finally {
    timingsMs.parser = elapsed(parserStartedAt);
  }
  const parsedData = normalizeItineraryFacts(imported?.data || {});
  const factValidation = validateItineraryFacts(parsedData);
  if (!parsedData.days?.length || !factValidation.valid) {
    const error = new Error(!parsedData.days?.length ? "核心事实结构无法建立：没有逐日行程" : `核心事实存在无法继续的冲突：${factValidation.errors.join("；")}`);
    error.code = !parsedData.days?.length ? "core_facts_unavailable" : "core_fact_conflict";
    error.validation = factValidation;
    throw error;
  }
  emit({ stage: "parser", phase: "finished", durationMs: timingsMs.parser, dayCount: parsedData.days.length });

  const projectId = randomUUID();
  const inputFingerprint = fingerprintFacts(parsedData);
  const now = new Date().toISOString();
  const project = {
    projectId,
    flowKind: "simple_skill_v1",
    status: "planning",
    currentStage: "Planner",
    progress: 10,
    createdAt: now,
    updatedAt: now,
    inputFingerprint,
    activePlanId: null,
    planIds: [],
    executionRunIds: [],
    factBasis: buildAgentFactBasis(parsedData, imported.report || {}),
  };
  const persistStartedAt = Date.now();
  try {
    store.createProject(project);
    store.saveSourceData(projectId, { fileName: sourceFile.name || "source.xlsx", inputFingerprint, data: parsedData, report: imported.report || {} });
  } catch (error) {
    const wrapped = new Error(`项目保存失败：${error.message}`);
    wrapped.code = "project_save_failed";
    throw wrapped;
  } finally {
    timingsMs.persistence += elapsed(persistStartedAt);
  }

  emit({ stage: "planner", phase: "started", projectId });
  const plannerStartedAt = Date.now();
  let agentPlanning;
  let simplePlan;
  const plannerAttemptFiles = [];
  const externalModelAttempt = plannerOptions.onModelAttempt;
  const onModelAttempt = async (attempt) => {
    plannerAttemptFiles.push(store.savePlannerModelAttempt(projectId, attempt));
    await externalModelAttempt?.(attempt);
  };
  try {
    agentPlanning = await planAgent({ project, simpleSkillContract: true, ...plannerOptions, onModelAttempt, signal, onStatus: (event) => emit({ stage: "planner", phase: "progress", detail: event }) });
    for (const attempt of agentPlanning.attempts || []) store.saveAttempt(projectId, attempt);
    simplePlan = adaptPlan({ data: parsedData, report: imported.report || {}, agentPlan: agentPlanning.plan || agentPlanning });
    simplePlan.projectId = projectId;
    simplePlan.inputFingerprint = inputFingerprint;
  } catch (error) {
    timingsMs.planner = elapsed(plannerStartedAt);
    timingsMs.total = elapsed(totalStartedAt);
    const executionRunId = randomUUID();
    const errorCode = error.code || "planner_system_failure";
    const errorRecord = { code: errorCode, message: error.message || String(error) };
    const unresolvedItems = [{ kind: "planner", id: "planner:system", status: "failed", required: true, error: { code: "planner_system_failure", message: errorRecord.message, causeCode: errorCode } }];
    const failureResult = {
      projectId,
      pipelineStatus: "failed",
      currentStage: "Planner failure",
      error: errorRecord,
      unresolvedItems,
      stageStatus: { parser: "success", planner: "failed", copy: "not_started", image: "not_started", programWriteback: "not_started", renderer: "not_started" },
      copyExecution: { status: "not_started", results: [], metrics: { businessBatches: 0, modelCalls: 0, durationMs: 0 } },
      imageExecution: { status: "not_started", results: [], metrics: { businessBatches: 0, searchCalls: 0, downloadAttempts: 0, batchVisionCalls: 0, durationMs: 0 } },
      renderStatus: "not_started",
      render: { status: "not_started", outputPath: null, rendererCalls: 0, durationMs: 0 },
      outputPath: null,
      timingsMs,
      callCounts: { parserCalls: 1, plannerModelCalls: Math.max(plannerAttemptFiles.length, Number(error.attemptUsages?.length || 0)), copyBusinessBatches: 0, copyModelCalls: 0, imageBusinessBatches: 0, imageSearchCalls: 0, imageCommonsCalls: 0, imagePageExtractionCalls: 0, imageDownloadAttempts: 0, imageVisualJudgmentCalls: 0, rendererCalls: 0 },
      plannerAttemptFiles,
    };
    const failedRun = { executionRunId, projectId, planId: null, inputFingerprint, flowKind: "simple_skill_v1", status: "failed", progress: 10, executionEnabled: false, currentStage: "Planner failure", error: errorRecord, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    try {
      for (const attempt of error.attempts || []) store.saveAttempt(projectId, attempt);
      store.saveExecutionRun(projectId, failedRun);
      const finalResultRef = store.saveFinalResult(projectId, executionRunId, failureResult);
      store.updateExecutionRun(projectId, { ...failedRun, finalResultRef, updatedAt: new Date().toISOString() });
      store.updateProject(projectId, { status: "failed", currentStage: "Planner failure", progress: 10, executionEnabled: false, lastError: errorRecord.message, errorCode, finalResultRef, outputPath: null });
      error.projectId = projectId;
      error.finalResultRef = finalResultRef;
    } catch (persistenceError) {
      error.persistenceError = persistenceError.message;
    }
    emit({ stage: "planner", phase: "failed", projectId, durationMs: timingsMs.planner, error: errorRecord });
    throw error;
  } finally {
    if (!timingsMs.planner) timingsMs.planner = elapsed(plannerStartedAt);
  }
  const planPersistStartedAt = Date.now();
  try {
    store.activatePlan(projectId, simplePlan);
  } catch (error) {
    const wrapped = new Error(`项目保存失败：${error.message}`);
    wrapped.code = "project_save_failed";
    throw wrapped;
  } finally {
    timingsMs.persistence += elapsed(planPersistStartedAt);
  }
  emit({ stage: "planner", phase: "finished", durationMs: timingsMs.planner, copyTaskCount: simplePlan.copyTasks.length, imageSlotCount: simplePlan.imageSlots.length });

  const executionRunId = randomUUID();
  const initialRun = { executionRunId, projectId, planId: simplePlan.planId, inputFingerprint, flowKind: "simple_skill_v1", status: "running", progress: 30, executionEnabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const runPersistStartedAt = Date.now();
  try { store.saveExecutionRun(projectId, initialRun); }
  catch (error) { const wrapped = new Error(`项目保存失败：${error.message}`); wrapped.code = "project_save_failed"; throw wrapped; }
  finally { timingsMs.persistence += elapsed(runPersistStartedAt); }

  const copyStartedAt = Date.now();
  emit({ stage: "copy_skill", phase: "started", targetCount: simplePlan.copyTasks.length, startedAtMs: copyStartedAt });
  let copyFinishedAt = null;
  const copyPromise = runCopy({ itineraryContext: simplePlan.itineraryContext, tasks: simplePlan.copyTasks, ...copyOptions, signal, onCapabilityCall: capabilityEvent }).finally(() => { copyFinishedAt = Date.now(); });
  const imageStartedAt = Date.now();
  emit({ stage: "image_skill", phase: "started", slotCount: simplePlan.imageSlots.length, startedAtMs: imageStartedAt });
  let imageFinishedAt = null;
  const imagePromise = runImage({ slots: simplePlan.imageSlots, root, ...imageOptions, signal, onCapabilityCall: capabilityEvent }).finally(() => { imageFinishedAt = Date.now(); });
  const [copySettled, imageSettled] = await Promise.allSettled([copyPromise, imagePromise]);
  copyFinishedAt ||= Date.now();
  imageFinishedAt ||= Date.now();
  timingsMs.copySkill = copySettled.status === "fulfilled" ? Number(copySettled.value?.metrics?.durationMs || copyFinishedAt - copyStartedAt) : copyFinishedAt - copyStartedAt;
  timingsMs.imageSkill = imageSettled.status === "fulfilled" ? Number(imageSettled.value?.metrics?.durationMs || imageFinishedAt - imageStartedAt) : imageFinishedAt - imageStartedAt;
  const copyExecution = copySettled.status === "fulfilled" ? copySettled.value : { status: "failed", results: simplePlan.copyTasks.map((task) => ({ targetId: task.targetId, targetPath: task.targetPath, status: "failed", error: { code: "copy_batch_failed", message: copySettled.reason?.message || String(copySettled.reason) } })), metrics: { businessBatches: 1, modelCalls: 0, durationMs: timingsMs.copySkill } };
  const imageExecution = imageSettled.status === "fulfilled" ? imageSettled.value : { status: "failed", results: simplePlan.imageSlots.map((slot) => ({ slotId: slot.slotId, status: "failed", selected: null, technicalStatus: "image_batch_failed", warnings: [imageSettled.reason?.message || String(imageSettled.reason)] })), metrics: { businessBatches: 1, durationMs: timingsMs.imageSkill } };
  const parallelEvidence = {
    copyStartedAtMs: copyStartedAt,
    imageStartedAtMs: imageStartedAt,
    copyFinishedAtMs: copyFinishedAt,
    imageFinishedAtMs: imageFinishedAt,
    startDeltaMs: Math.abs(copyStartedAt - imageStartedAt),
    overlapMs: Math.max(0, Math.min(copyFinishedAt, imageFinishedAt) - Math.max(copyStartedAt, imageStartedAt)),
    parallel: Math.min(copyFinishedAt, imageFinishedAt) > Math.max(copyStartedAt, imageStartedAt),
  };
  emit({ stage: "skills", phase: "finished", parallelEvidence });

  const writebackStartedAt = Date.now();
  const writeback = applyResults({ preparedData: simplePlan.preparedData, copyTasks: simplePlan.copyTasks, copyExecution, imageSlots: simplePlan.imageSlots, slotBindings: simplePlan.slotBindings, imageExecution });
  timingsMs.programWriteback = elapsed(writebackStartedAt);
  emit({ stage: "program_writeback", phase: "finished", durationMs: timingsMs.programWriteback, unresolvedCount: writeback.unresolvedItems.length });

  let renderExecution = { status: "not_started", outputPath: null, rendererCalls: 0, durationMs: 0 };
  if (!writeback.requiredUnresolved.length) {
    emit({ stage: "renderer", phase: "started" });
    const rendererStartedAt = Date.now();
    try { renderExecution = await render({ data: writeback.data, projectId, root, origin }); }
    catch (error) { renderExecution = { status: "failed", outputPath: null, rendererCalls: 1, error: { code: "renderer_failed", message: error.message } }; }
    timingsMs.renderer = elapsed(rendererStartedAt);
    renderExecution.durationMs ||= timingsMs.renderer;
    if (renderExecution.status !== "success") writeback.unresolvedItems.push(unresolvedRender(renderExecution));
    emit({ stage: "renderer", phase: "finished", durationMs: timingsMs.renderer, status: renderExecution.status });
  } else {
    renderExecution = { status: "blocked_by_required_items", outputPath: null, rendererCalls: 0, durationMs: 0 };
  }

  const pipelineStatus = statusFor(writeback.unresolvedItems, renderExecution.status);
  const progress = pipelineStatus === "complete" ? 100 : pipelineStatus === "awaiting_user_action" ? 85 : 75;
  timingsMs.total = elapsed(totalStartedAt);
  const legacyEvidence = runtimeLegacyEvidence(capabilityEvents, copyExecution, imageExecution);
  const result = {
    projectId,
    pipelineStatus,
    plannerResult: { planId: simplePlan.planId, sourceAgentPlanId: simplePlan.sourceAgentPlanId, moduleVisibility: simplePlan.moduleVisibility, copyTaskCount: simplePlan.copyTasks.length, imageSlotCount: simplePlan.imageSlots.length, warnings: simplePlan.warnings || [] },
    warnings: simplePlan.warnings || [],
    plannerAttemptFiles,
    copyExecution,
    imageExecution,
    writeback: { copy: writeback.copyWriteback, images: writeback.imageWriteback },
    unresolvedItems: writeback.unresolvedItems,
    renderStatus: renderExecution.status,
    outputPath: renderExecution.outputPath || null,
    timingsMs,
    callCounts: callCounts({ agentPlan: agentPlanning.plan || agentPlanning, copyExecution, imageExecution, renderExecution }),
    concurrency: { copyImage: parallelEvidence, imagePeak: imageExecution.metrics?.concurrencyPeak || null },
    legacyEvidence,
    callGraph: [
      "importItineraryWorkbook",
      "generateAgentPlan",
      "materializeSimpleSkillPlan",
      ["runCopyWriterSkill", "runImageSearchSkill"],
      "applySimpleSkillResults",
      "AgentPlanStore",
      "runSimpleRenderer",
      "renderer/render.mjs --width=2000",
    ],
  };
  const finalPersistStartedAt = Date.now();
  try {
    for (const item of copyExecution.results || []) store.saveTaskResult(projectId, executionRunId, `copy-${item.targetId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, item);
    for (const item of imageExecution.results || []) store.saveTaskResult(projectId, executionRunId, `image-${item.slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, item);
    const finalResultRef = store.saveFinalResult(projectId, executionRunId, { ...result, data: writeback.data, render: renderExecution });
    store.updateExecutionRun(projectId, { ...initialRun, status: pipelineStatus, progress, executionEnabled: false, updatedAt: new Date().toISOString(), finalResultRef });
    store.updateProject(projectId, { status: pipelineStatus, currentStage: pipelineStatus === "complete" ? "完成" : "等待处理", progress, outputPath: result.outputPath });
    result.finalResultRef = finalResultRef;
  } catch (error) {
    const wrapped = new Error(`项目保存失败：${error.message}`);
    wrapped.code = "project_save_failed";
    throw wrapped;
  } finally {
    timingsMs.persistence += elapsed(finalPersistStartedAt);
    timingsMs.total = elapsed(totalStartedAt);
  }
  return result;
}

function unresolvedRender(renderExecution) {
  return { kind: "renderer", id: "renderer:2000", status: renderExecution.status || "failed", required: true, error: renderExecution.error || { code: "render_blocked", message: "2000px 渲染或确定性版面检查未通过" } };
}
