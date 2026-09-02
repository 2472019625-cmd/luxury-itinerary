import { randomUUID } from "node:crypto";
import { AGENT_STAGE_BUDGETS } from "../config/agent-stage-budgets.mjs";
import { runAgentCopyPipeline } from "./agent-copy-engine.mjs";
import { materializeAgentImageBlueprint, evaluateAgentImageCompletion, prepareTargetedImageRetry } from "./agent-image-plan.mjs";
import { runWebFactSearch } from "./agent-web-fact-search.mjs";
import { resolveItineraryImages } from "./image-pipeline.mjs";
import { reviewFinalLayout } from "./final-layout-review.mjs";
import { reviewFinalOutputData } from "./final-output-qa.mjs";
import { beginCapabilityCall, cancelExecutionRun, finishCapabilityCall, recordCapabilityCall, transitionExecutionTask } from "./agent-execution-scheduler.mjs";
import { imageConfirmationChoices } from "./agent-image-confirmation.mjs";

const PLANNING_TYPES = ["project_setup", "source_intake", "fact_review", "confirmation", "journey_strategy", "module_strategy"];
const COPY_GENERATION_TYPES = ["copy_global", "copy_hotel_transport", "copy_day_group", "copy_closing"];
const COPY_REVIEW_TYPES = ["copy_review"];
const COPY_REPAIR_TYPES = ["targeted_copy_repair"];
const IMAGE_TYPES = ["image_search_plan", "visual_review", "image_placement"];
const terminalTaskStates = new Set(["succeeded", "user_resolved", "user_accepted_suggestion", "not_applicable", "removed_optional", "failed", "cancelled"]);

const taskIdsFor = (plan, taskTypes) => plan.tasks.filter((task) => taskTypes.includes(task.taskType)).map((task) => task.taskId);
const needsWork = (plan, run, taskTypes) => taskIdsFor(plan, taskTypes).some((taskId) => !terminalTaskStates.has(run.taskRuns.find((item) => item.taskId === taskId)?.status));

export async function runWithinStageBudget(stageId, work, { signal, onTargetExceeded = () => {}, budgetOverride } = {}) {
  const budget = budgetOverride || AGENT_STAGE_BUDGETS[stageId];
  if (!budget) return work(signal);
  const controller = new AbortController();
  let stoppedByBudget = false;
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort(); else signal?.addEventListener("abort", forwardAbort, { once: true });
  const targetTimer = setTimeout(onTargetExceeded, budget.targetMs);
  const stopTimer = setTimeout(() => { stoppedByBudget = true; controller.abort(new Error(`${stageId} 阶段超过停止线`)); }, budget.stopMs);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (stoppedByBudget) {
      const timeout = new Error(`${stageId} 阶段超过 ${Math.round(budget.stopMs / 60_000)} 分钟停止线，已保存检查点并中断`);
      timeout.code = "stage_timeout";
      timeout.stage = stageId;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(targetTimer);
    clearTimeout(stopTimer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function makeRuntimeConfirmation({ category, question, reason, source, affectedTaskIds, choices }) {
  return { confirmationId: randomUUID(), category, status: "pending", question, reason, source, affectedTaskIds, affectedTaskTypes: [], affectedPaths: [], choices };
}

export class AgentExecutionEngine {
  constructor({ store, root, origin, textModelConfig, searchModelConfig, visionModelConfig, adapters = {} }) {
    this.store = store;
    this.root = root;
    this.origin = origin;
    this.textModelConfig = textModelConfig;
    this.searchModelConfig = searchModelConfig;
    this.visionModelConfig = visionModelConfig;
    this.adapters = { runWebFactSearch, runAgentCopyPipeline, resolveItineraryImages, reviewFinalLayout, reviewFinalOutputData, ...adapters };
  }

  persistRun(plan, run) {
    this.store.updateExecutionRun(run.projectId, run);
    return run;
  }

  transition(plan, run, taskId, status, details = {}) {
    return this.persistRun(plan, transitionExecutionTask(plan, run, taskId, status, details));
  }

  transitionTypes(plan, run, types, status, details = {}) {
    let next = run;
    for (const taskId of taskIdsFor(plan, types)) {
      const current = next.taskRuns.find((item) => item.taskId === taskId);
      if (!current || terminalTaskStates.has(current.status) && status !== "user_resolved") continue;
      next = this.transition(plan, next, taskId, status, typeof details === "function" ? details(taskId) : details);
    }
    return next;
  }

  recordCall(plan, run, capabilityId, details) {
    return this.persistRun(plan, recordCapabilityCall(plan, run, capabilityId, details));
  }

  beginCall(plan, run, capabilityId, details) {
    return this.persistRun(plan, beginCapabilityCall(plan, run, capabilityId, details));
  }

  finishCall(plan, run, capabilityId, details) {
    return this.persistRun(plan, finishCapabilityCall(plan, run, capabilityId, details));
  }

  updateStage(projectId, currentStage, status = "running") {
    this.store.updateProject(projectId, { currentStage, status });
  }

  saveRuntimeConfirmations(projectId, confirmations) {
    const all = [...this.store.getConfirmations(projectId).filter((item) => item.status === "pending" || item.selectedChoiceId), ...confirmations];
    this.store.saveConfirmations(projectId, all);
  }

  async retryImageSlots(projectId, run, slotIds, { signal, onProgress = () => {} } = {}) {
    const active = this.store.getActive(projectId);
    if (!active?.plan || active.plan.planId !== run.planId) throw new Error("执行计划已不是项目当前计划");
    const savedImages = this.store.getTaskResult(projectId, run.executionRunId, "image-pipeline");
    if (!savedImages?.data) throw new Error("当前项目没有可续跑的图片检查点");
    const requested = [...new Set(slotIds)].filter(Boolean);
    if (!requested.length) throw new Error("没有指定需要重新搜索的图片位");
    const { plan } = active;
    let next = this.store.getExecutionRun(projectId, run.executionRunId) || run;
    const applyCapabilityEvent = (event) => {
      const taskId = event.capabilityId === "image_search" ? taskIdsFor(plan, ["image_search_plan"])[0] : taskIdsFor(plan, ["visual_review"])[0];
      const details = { ...event, taskId, message: event.phase === "started" ? `${event.target} 定向重搜开始` : event.failed ? `${event.target} 定向重搜失败` : `${event.target} 定向重搜完成` };
      next = event.phase === "started" ? this.beginCall(plan, next, event.capabilityId, details) : this.finishCall(plan, next, event.capabilityId, details);
      this.store.updateProject(projectId, { status: "running" });
    };
    const retryData = prepareTargetedImageRetry(savedImages.data, requested);
    const images = await runWithinStageBudget("images", (stageSignal) => this.adapters.resolveItineraryImages(retryData, {
      root: this.root,
      apiKey: this.visionModelConfig.apiKey,
      baseUrl: this.visionModelConfig.baseUrl,
      model: this.visionModelConfig.model,
      searchApiKey: this.searchModelConfig.apiKey,
      searchBaseUrl: this.searchModelConfig.baseUrl,
      searchModel: this.searchModelConfig.imageSearchModel || this.searchModelConfig.model,
      onlySlotIds: requested,
      disableCache: true,
      signal: stageSignal,
      onProgress: (event) => {
        this.updateStage(projectId, event.currentAction || "正在定向重搜图片");
        onProgress(event);
      },
      onCapabilityCall: applyCapabilityEvent,
    }), { signal, onTargetExceeded: () => this.updateStage(projectId, "图片定向重搜已超过目标时间，正在处理当前图片位") });
    const saved = { summary: images.summary, ledgerFile: images.ledgerFile, data: images.data, targetedRetry: { slotIds: requested, completedAt: new Date().toISOString() } };
    this.store.saveTaskResult(projectId, run.executionRunId, "image-pipeline", saved);
    return { ...saved, run: next, imageGate: evaluateAgentImageCompletion(images.data) };
  }

  async execute(projectId, run, { signal } = {}) {
    const active = this.store.getActive(projectId);
    if (!active?.plan || active.plan.planId !== run.planId) throw new Error("执行计划已不是项目当前计划");
    const { plan } = active;
    const hiddenModules = (plan.modules || []).filter((item) => item.decision === "hide").map((item) => item.moduleId);
    let sourceData = this.store.getSourceData(projectId)?.facts;
    if (!sourceData) throw new Error("项目缺少不可变原始资料快照");
    let next = run;
    const applyCapabilityEvent = (event, taskId) => {
      const details = { ...event, taskId, message: event.phase === "started" ? `${event.target} 调用开始` : event.failed ? `${event.target} 调用失败` : `${event.target} 调用完成` };
      next = event.phase === "started" ? this.beginCall(plan, next, event.capabilityId, details) : this.finishCall(plan, next, event.capabilityId, details);
    };
    try {
      this.updateStage(projectId, "正在应用已验证的整程规划");
      next = this.transitionTypes(plan, next, PLANNING_TYPES, "running", { message: "正在应用规划与已确认事实" });
      next = this.transitionTypes(plan, next, PLANNING_TYPES, "succeeded", { message: "整程规划、图片规划与事实边界已就绪" });

      const verificationTaskIds = taskIdsFor(plan, ["web_verification"]);
      if (verificationTaskIds.length && needsWork(plan, next, ["web_verification"])) {
        this.updateStage(projectId, "正在联网核验已有事实");
        next = this.transitionTypes(plan, next, ["web_verification"], "running", { message: "正在检索官方与权威公开来源" });
        const started = Date.now();
        const webCallId = randomUUID();
        next = this.beginCall(plan, next, "web_fact_search", { callId: webCallId, taskId: verificationTaskIds[0], stage: "verification", target: "web-verification", message: "联网事实核验调用开始" });
        let verification;
        try {
          verification = await runWithinStageBudget("verification", (stageSignal) => this.adapters.runWebFactSearch({ ...this.searchModelConfig, factBasis: plan.factBasis, verificationItems: plan.webVerification || [], signal: stageSignal }), { signal, onTargetExceeded: () => this.updateStage(projectId, "事实核验已超过目标时间，正在处理当前核验项") });
          next = this.finishCall(plan, next, "web_fact_search", { callId: webCallId, taskId: verificationTaskIds[0], stage: "verification", durationMs: verification.durationMs || Date.now() - started, usage: verification.usage, attemptCount: verification.attemptCount || 1, message: "联网事实核验完成" });
        } catch (error) {
          next = this.finishCall(plan, next, "web_fact_search", { callId: webCallId, taskId: verificationTaskIds[0], stage: "verification", durationMs: Date.now() - started, failed: error?.name !== "AbortError", cancelled: error?.name === "AbortError", reason: error.message, message: "联网事实核验失败" });
          throw error;
        }
        const evidenceRef = this.store.saveEvidence(projectId, run.executionRunId, "web-fact-search", verification);
        this.store.saveTaskResult(projectId, run.executionRunId, "web-verification", verification);
        if (verification.conflicts.length) {
          const confirmations = verification.conflicts.map((item) => makeRuntimeConfirmation({ category: "事实", question: `${item.subject} 的“${item.field}”公开来源与现有资料存在冲突，是否保留原始资料并使用保守表达？`, reason: item.statement || "联网核验发现来源冲突。", source: `${item.sourceName} · ${item.sourceUrl}`, affectedTaskIds: verificationTaskIds, choices: [{ choiceId: "keep_original_conservative", label: "保留原始资料并继续", recommended: true, reason: "不让联网结果覆盖本次供应商资料和用户确认事实。" }, { choiceId: "wait_for_fact_source", label: "等待补充依据", recommended: false, reason: "项目保持等待，取得更可靠依据后继续。" }] }));
          this.saveRuntimeConfirmations(projectId, confirmations);
          next = this.transitionTypes(plan, next, ["web_verification"], "waiting_confirmation", { message: "事实来源存在冲突，等待确认", waitingReason: "联网来源与现有资料冲突", evidenceRefs: [evidenceRef] });
          this.updateStage(projectId, "等待确认联网事实冲突", "awaiting_confirmation");
          return next;
        }
        next = this.transitionTypes(plan, next, ["web_verification"], "succeeded", { message: `事实核验完成：采用 ${verification.adoptedFacts.length} 条有来源事实`, evidenceRefs: [evidenceRef] });
      }

      const savedVerification = this.store.getTaskResult(projectId, run.executionRunId, "web-verification");
      if (savedVerification?.adoptedFacts?.length) sourceData = { ...sourceData, authoritativeFacts: [...(sourceData.authoritativeFacts || []), ...savedVerification.adoptedFacts.map((item) => ({ statement: item.statement, sourceName: item.sourceName, sourceUrl: item.sourceUrl, verifiedAt: item.verifiedAt, validUntil: item.validUntil, recheckAt: item.recheckAt }))] };
      const copyTaskIds = taskIdsFor(plan, [...COPY_GENERATION_TYPES, ...COPY_REVIEW_TYPES, ...COPY_REPAIR_TYPES]);
      const savedCopy = this.store.getTaskResult(projectId, run.executionRunId, "copy-pipeline");
      let workingData = savedCopy?.data || sourceData;
      if (copyTaskIds.length && needsWork(plan, next, [...COPY_GENERATION_TYPES, ...COPY_REVIEW_TYPES, ...COPY_REPAIR_TYPES])) {
        this.updateStage(projectId, "正在生成模块文案");
        next = this.transitionTypes(plan, next, COPY_GENERATION_TYPES, "running", { message: "正在按模块并行生成客户文案" });
        next = this.transitionTypes(plan, next, COPY_REVIEW_TYPES, "running", { message: "文案完成后将执行唯一一次品牌审查" });
        const copyCallsBefore = next.capabilityCallStats.find((item) => item.capabilityId === "copy_writer")?.actualCalls || 0;
        const brandCallsBefore = next.capabilityCallStats.find((item) => item.capabilityId === "brand_reviewer")?.actualCalls || 0;
        let copy;
        try {
          copy = await runWithinStageBudget("copy", (stageSignal) => this.adapters.runAgentCopyPipeline({ sourceData, businessPlan: plan, projectRoot: this.root, executionRunId: run.executionRunId, modelConfig: this.textModelConfig, signal: stageSignal, hiddenModules, onStage: (event) => this.updateStage(projectId, event.currentAction || "正在生成客户文案"), onCapabilityCall: (event) => {
            const details = { ...event, message: event.phase === "started" ? `${event.target} 调用开始` : event.failed ? `${event.target} 调用失败` : `${event.target} 调用完成` };
            next = event.phase === "started" ? this.beginCall(plan, next, event.capabilityId, details) : this.finishCall(plan, next, event.capabilityId, details);
          } }), { signal, onTargetExceeded: () => this.updateStage(projectId, "文案阶段已超过目标时间，正在处理当前批次") });
        } catch (error) {
          if (error.details?.length) this.store.saveEvidence(projectId, run.executionRunId, "copy-pipeline-failure", { code: error.code || "copy_failed", message: error.message, details: error.details, preservedCompletedUnits: true, failedAt: new Date().toISOString() });
          throw error;
        }
        const copyRef = this.store.saveTaskResult(projectId, run.executionRunId, "copy-pipeline", copy);
        const moduleCalls = copy.usage?.modules?.length || 0;
        if ((next.capabilityCallStats.find((item) => item.capabilityId === "copy_writer")?.actualCalls || 0) === copyCallsBefore) {
          for (let index = 0; index < moduleCalls; index += 1) next = this.recordCall(plan, next, "copy_writer", { taskId: copyTaskIds[0], stage: "copy", usage: copy.usage.modules[index]?.usage || null, message: "文案模块调用完成" });
          for (const target of copy.contentQuality.targetRuns || []) if (!target.reused) next = this.recordCall(plan, next, "copy_writer", { taskId: taskIdsFor(plan, COPY_REPAIR_TYPES)[0] || copyTaskIds[0], stage: "copy", durationMs: target.durationMs, usage: target.usage, message: `目标模块 ${target.target.key} 已由同一文案能力重新生成一次` });
        }
        if ((next.capabilityCallStats.find((item) => item.capabilityId === "brand_reviewer")?.actualCalls || 0) === brandCallsBefore && !copy.contentQuality.brandReviewReused) next = this.recordCall(plan, next, "brand_reviewer", { taskId: taskIdsFor(plan, COPY_REVIEW_TYPES)[0], stage: "brand_review", durationMs: copy.contentQuality.brandReviewDurationMs, usage: copy.usage?.brandReview, message: "唯一一次品牌审查完成" });
        if (copy.contentQuality.brandReviewCallCount !== 1) throw new Error("品牌审查调用次数违反每份成品一次的约束");
        if (!copy.contentQuality.passed) {
          next = this.transitionTypes(plan, next, COPY_GENERATION_TYPES, "succeeded", { message: "文案模块生成完成", resultRef: copyRef });
          next = this.transitionTypes(plan, next, COPY_REVIEW_TYPES, "failed", { message: "文案仍有未解决问题", resultRef: copyRef, error: { code: "copy_quality_failed", issues: copy.contentQuality.remainingIssues } });
          throw new Error("文案经过一次品牌审查和目标重新生成后仍未通过规则门禁");
        }
        next = this.transitionTypes(plan, next, COPY_GENERATION_TYPES, "succeeded", { message: "模块文案生成完成", resultRef: copyRef });
        next = this.transitionTypes(plan, next, COPY_REVIEW_TYPES, "succeeded", { message: "唯一一次品牌审查完成", resultRef: copyRef });
        next = this.transitionTypes(plan, next, COPY_REPAIR_TYPES, copy.contentQuality.targetRuns.length ? "succeeded" : "not_applicable", { message: copy.contentQuality.targetRuns.length ? "不合格目标已由同一文案能力重新生成一次" : "品牌审查未发现需要目标重生成的问题", resultRef: copyRef });
        workingData = copy.data;
      }

      const savedImages = this.store.getTaskResult(projectId, run.executionRunId, "image-pipeline");
      if (savedImages?.data) workingData = savedImages.data;
      if (taskIdsFor(plan, IMAGE_TYPES).length && needsWork(plan, next, [...IMAGE_TYPES, "image_gap_resolution"])) {
        this.updateStage(projectId, "正在搜索并审核真实图片");
        next = this.transitionTypes(plan, next, IMAGE_TYPES, "running", { message: "正在搜索、下载、审核并放置真实图片" });
        workingData = { ...workingData, contentVisualMainline: workingData.contentVisualMainline || null, imageBlueprint: materializeAgentImageBlueprint(workingData, plan.imagePlan, { planId: plan.planId }) };
        const searchCallsBefore = next.capabilityCallStats.find((item) => item.capabilityId === "image_search")?.actualCalls || 0;
        const visualCallsBefore = next.capabilityCallStats.find((item) => item.capabilityId === "visual_auditor")?.actualCalls || 0;
        const images = await runWithinStageBudget("images", (stageSignal) => this.adapters.resolveItineraryImages(workingData, { root: this.root, apiKey: this.visionModelConfig.apiKey, baseUrl: this.visionModelConfig.baseUrl, model: this.visionModelConfig.model, searchApiKey: this.searchModelConfig.apiKey, searchBaseUrl: this.searchModelConfig.baseUrl, searchModel: this.searchModelConfig.imageSearchModel || this.searchModelConfig.model, disableCache: true, signal: stageSignal, onProgress: (event) => this.updateStage(projectId, event.currentAction || "正在处理图片"), onCapabilityCall: (event) => applyCapabilityEvent(event, event.capabilityId === "image_search" ? taskIdsFor(plan, ["image_search_plan"])[0] : taskIdsFor(plan, ["visual_review"])[0]) }), { signal, onTargetExceeded: () => this.updateStage(projectId, "图片阶段已超过目标时间，正在处理当前图片位") });
        workingData = images.data;
        const imageRef = this.store.saveTaskResult(projectId, run.executionRunId, "image-pipeline", { summary: images.summary, ledgerFile: images.ledgerFile, data: workingData });
        if ((next.capabilityCallStats.find((item) => item.capabilityId === "image_search")?.actualCalls || 0) === searchCallsBefore) for (let index = 0; index < Number(images.summary?.stats?.searchAttempts || 0); index += 1) next = this.recordCall(plan, next, "image_search", { taskId: taskIdsFor(plan, ["image_search_plan"])[0], stage: "images", message: "真实图片搜索与下载完成" });
        const auditCalls = Number(images.summary?.stats?.initialAuditCalls || 0) + Number(images.summary?.stats?.terminalAuditCalls || 0);
        if ((next.capabilityCallStats.find((item) => item.capabilityId === "visual_auditor")?.actualCalls || 0) === visualCallsBefore) for (let index = 0; index < auditCalls; index += 1) next = this.recordCall(plan, next, "visual_auditor", { taskId: taskIdsFor(plan, ["visual_review"])[0], stage: "images", message: "视觉候选审核完成" });
        next = this.transitionTypes(plan, next, IMAGE_TYPES, "succeeded", { message: "图片搜索、视觉审核与放置完成", resultRef: imageRef });
        const imageGate = evaluateAgentImageCompletion(workingData);
        if (!imageGate.passed) {
          const gapTaskIds = taskIdsFor(plan, ["image_gap_resolution"]);
          const confirmations = imageGate.missingRequired.map((item) => ({ ...makeRuntimeConfirmation({ category: "图片", question: `必需图片位 ${item.slotId} 尚未自动通过，请看图确认候选或继续等待。`, reason: `当前状态：${item.status}。必需位不能留空进入成品。`, source: "图片搜索与视觉审核结果", affectedTaskIds: gapTaskIds, choices: imageConfirmationChoices(workingData, item.slotId) }), imageSlotId: item.slotId }));
          this.saveRuntimeConfirmations(projectId, confirmations);
          next = this.transitionTypes(plan, next, ["image_gap_resolution"], "waiting_confirmation", { message: "必需图片位等待处理", waitingReason: "必需图片位没有可自动采用图片", resultRef: imageRef });
          this.updateStage(projectId, "等待处理必需图片位", "awaiting_confirmation");
          return next;
        }
        next = this.transitionTypes(plan, next, ["image_gap_resolution"], "succeeded", { message: "所有必需图片位均已有可用图片", resultRef: imageRef });
      }

      this.updateStage(projectId, "正在生成实际 2000px 成品并检查");
      next = this.transitionTypes(plan, next, ["layout_render"], "running", { message: "正在渲染实际 2000px 长图" });
      const layoutVisualCallsBefore = next.capabilityCallStats.find((item) => item.capabilityId === "visual_auditor")?.actualCalls || 0;
      const layout = await runWithinStageBudget("render", (stageSignal) => this.adapters.reviewFinalLayout(workingData, { root: this.root, origin: this.origin, apiKey: this.visionModelConfig.apiKey, baseUrl: this.visionModelConfig.baseUrl, model: this.visionModelConfig.model, signal: stageSignal, onProgress: (event) => this.updateStage(projectId, event.currentAction || "正在检查实际长图"), onCapabilityCall: (event) => applyCapabilityEvent(event, taskIdsFor(plan, ["layout_render"])[0]) }), { signal, onTargetExceeded: () => this.updateStage(projectId, "渲染检查已超过目标时间，正在保存当前版面证据") });
      const layoutRef = this.store.saveEvidence(projectId, run.executionRunId, "final-layout-review", layout);
      if (layout.modelReviewed && (next.capabilityCallStats.find((item) => item.capabilityId === "visual_auditor")?.actualCalls || 0) === layoutVisualCallsBefore) next = this.recordCall(plan, next, "visual_auditor", { taskId: taskIdsFor(plan, ["layout_render"])[0], stage: "render", message: "实际 2000px 长图视觉检查完成" });
      if (layout.failedSlotIds?.length) {
        next = this.transitionTypes(plan, next, ["layout_render"], "failed", { message: "实际长图仍有图片放置问题", evidenceRefs: [layoutRef], error: { code: "layout_image_failed", failedSlotIds: layout.failedSlotIds } });
        throw new Error(`实际 2000px 长图有 ${layout.failedSlotIds.length} 个图片位未通过`);
      }
      next = this.transitionTypes(plan, next, ["layout_render"], "succeeded", { message: "实际 2000px 长图渲染与视觉检查完成", evidenceRefs: [layoutRef] });

      next = this.transitionTypes(plan, next, ["final_qa"], "running", { message: "正在执行最终数据、图片与版式门禁" });
      const finalQa = this.adapters.reviewFinalOutputData(workingData, layout.layoutQa || null);
      const imageGate = evaluateAgentImageCompletion(workingData);
      const finalPassed = finalQa.passed && imageGate.passed && layout.width === 2000 && layout.outputQa?.passed !== false;
      const qaRef = this.store.saveEvidence(projectId, run.executionRunId, "final-qa", { finalQa, imageGate, layout: { runId: layout.runId, width: layout.width, height: layout.height, outputFile: layout.outputFile, qaFile: layout.qaFile, outputQa: layout.outputQa } });
      if (!finalPassed) {
        next = this.transitionTypes(plan, next, ["final_qa"], "failed", { message: "最终完成门禁未通过", evidenceRefs: [qaRef], error: { code: "final_qa_failed", issues: finalQa.issues, imageGate } });
        throw new Error("最终数据、图片或2000px版式检查未通过");
      }
      next = this.transitionTypes(plan, next, ["final_qa"], "succeeded", { message: "最终数据、图片与版式检查通过", evidenceRefs: [qaRef] });
      next = this.transitionTypes(plan, next, ["completion_gate"], "succeeded", { message: "全部阶段完成，允许进入编辑器", evidenceRefs: [qaRef] });
      next = this.transitionTypes(plan, next, ["control"], "not_applicable", { message: "本次运行正常完成，无需取消处理" });
      const finalResultRef = this.store.saveFinalResult(projectId, run.executionRunId, { data: workingData, outputFile: layout.outputFile, qaFile: layout.qaFile, width: layout.width, height: layout.height, finalQa, imageGate, completedAt: new Date().toISOString() });
      next = this.transitionTypes(plan, next, ["persistence"], "succeeded", { message: "成品、项目与全链路证据已保存", resultRef: finalResultRef });
      this.store.updateProject(projectId, { status: "ready_for_editor", currentStage: "全部检查通过，可进入编辑器", resultRef: finalResultRef, progress: next.progress, lastError: null });
      return next;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) {
        next = cancelExecutionRun(plan, next);
        this.store.updateExecutionRun(projectId, next);
        this.store.updateProject(projectId, { status: "cancelled", currentStage: "已取消", lastError: null });
        return next;
      }
      for (const task of next.taskRuns.filter((item) => item.status === "running")) next = this.transition(plan, next, task.taskId, "failed", { message: "当前任务执行失败", error: { code: error.code || "execution_failed", message: error.message } });
      this.store.updateProject(projectId, { status: "execution_failed", currentStage: "生成中断", lastError: error.message });
      throw error;
    }
  }
}
