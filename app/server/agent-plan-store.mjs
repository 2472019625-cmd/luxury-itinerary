import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  // Store calls are synchronous and therefore serialized by the Node event loop.
  // Windows does not reliably support rename-over-existing-file and can raise EPERM,
  // so a synchronous replacement is safer here than a temporary rename.
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, String(value ?? ""), "utf8");
}

export class AgentPlanStore {
  constructor(root) { this.root = path.resolve(root); }
  projectDir(projectId) { return path.join(this.root, projectId); }
  projectFile(projectId) { return path.join(this.projectDir(projectId), "project.json"); }
  planFile(projectId, planId) { return path.join(this.projectDir(projectId), "plans", `${planId}.json`); }
  attemptFile(projectId, attemptId) { return path.join(this.projectDir(projectId), "attempts", `${attemptId}.json`); }
  confirmationFile(projectId, confirmationId) { return path.join(this.projectDir(projectId), "confirmations", `${confirmationId}.json`); }
  executionRunFile(projectId, executionRunId) { return path.join(this.projectDir(projectId), "execution-runs", `${executionRunId}.json`); }
  sourceDataFile(projectId) { return path.join(this.projectDir(projectId), "inputs", "source-data.json"); }
  taskResultFile(projectId, executionRunId, taskId) { return path.join(this.projectDir(projectId), "execution-runs", executionRunId, "results", `${taskId}.json`); }
  evidenceFile(projectId, executionRunId, evidenceId) { return path.join(this.projectDir(projectId), "execution-runs", executionRunId, "evidence", `${evidenceId}.json`); }
  finalResultFile(projectId, executionRunId) { return path.join(this.projectDir(projectId), "execution-runs", executionRunId, "final-result.json"); }
  plannerAttemptDir(projectId) { return path.join(this.projectDir(projectId), "planner-attempts"); }
  plannerRawFile(projectId, index) { return path.join(this.plannerAttemptDir(projectId), `planner-attempt-${index}-raw.txt`); }
  plannerParseFile(projectId, index) { return path.join(this.plannerAttemptDir(projectId), `planner-attempt-${index}-parse.json`); }
  createProject(project) {
    if (existsSync(this.projectFile(project.projectId))) throw new Error("项目已存在");
    writeJson(this.projectFile(project.projectId), project);
    return project;
  }
  getProject(projectId) {
    const file = this.projectFile(projectId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  saveAttempt(projectId, attempt) { writeJson(this.attemptFile(projectId, attempt.attemptId), attempt); }
  savePlannerModelAttempt(projectId, attempt = {}) {
    if (!this.getProject(projectId)) throw new Error("项目不存在");
    let index = 1;
    while (existsSync(this.plannerRawFile(projectId, index)) || existsSync(this.plannerParseFile(projectId, index))) index += 1;
    const rawFile = this.plannerRawFile(projectId, index);
    const parseFile = this.plannerParseFile(projectId, index);
    writeText(rawFile, attempt.rawContent);
    writeJson(parseFile, {
      attempt: index,
      providerAttempt: Number(attempt.attempt) || null,
      savedAt: new Date().toISOString(),
      parseResult: attempt.parseResult || null,
      request: attempt.request || null,
      response: attempt.response || null,
      error: attempt.error || null,
    });
    return {
      attempt: index,
      rawRef: path.relative(this.projectDir(projectId), rawFile).replaceAll("\\", "/"),
      parseRef: path.relative(this.projectDir(projectId), parseFile).replaceAll("\\", "/"),
    };
  }
  saveSourceData(projectId, sourceData) {
    if (!this.getProject(projectId)) throw new Error("项目不存在");
    if (existsSync(this.sourceDataFile(projectId))) throw new Error("原始资料快照不可覆盖");
    writeJson(this.sourceDataFile(projectId), sourceData);
    return sourceData;
  }
  getSourceData(projectId) {
    const file = this.sourceDataFile(projectId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  activatePlan(projectId, plan) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    if (existsSync(this.planFile(projectId, plan.planId))) throw new Error("计划记录不可覆盖");
    writeJson(this.planFile(projectId, plan.planId), plan);
    const next = { ...project, activePlanId: plan.planId, planIds: [...(project.planIds || []), plan.planId], status: "ready_for_execution", currentStage: "执行准备完成", updatedAt: new Date().toISOString() };
    writeJson(this.projectFile(projectId), next);
    return next;
  }
  updateProject(projectId, patch) {
    const current = this.getProject(projectId);
    if (!current) throw new Error("项目不存在");
    const next = { ...current, ...patch, projectId: current.projectId, flowKind: current.flowKind || "agent_v1", updatedAt: new Date().toISOString() };
    writeJson(this.projectFile(projectId), next);
    return next;
  }
  getPlan(projectId, planId) {
    const file = this.planFile(projectId, planId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  saveConfirmations(projectId, confirmations) {
    for (const confirmation of confirmations) writeJson(this.confirmationFile(projectId, confirmation.confirmationId), confirmation);
    return this.updateProject(projectId, { confirmationIds: confirmations.map((item) => item.confirmationId) });
  }
  getConfirmations(projectId) {
    const project = this.getProject(projectId);
    return (project?.confirmationIds || []).map((id) => {
      const file = this.confirmationFile(projectId, id);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    }).filter(Boolean);
  }
  saveExecutionRun(projectId, run) {
    writeJson(this.executionRunFile(projectId, run.executionRunId), run);
    const project = this.getProject(projectId);
    const executionRunIds = project.executionRunIds?.includes(run.executionRunId) ? project.executionRunIds : [...(project.executionRunIds || []), run.executionRunId];
    this.updateProject(projectId, { executionRunIds, activeExecutionRunId: run.executionRunId });
    return run;
  }
  getExecutionRun(projectId, executionRunId) {
    const file = this.executionRunFile(projectId, executionRunId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  updateExecutionRun(projectId, run) {
    const current = this.getExecutionRun(projectId, run.executionRunId);
    if (!current) throw new Error("执行运行不存在");
    if (current.projectId !== run.projectId || current.planId !== run.planId || current.inputFingerprint !== run.inputFingerprint) throw new Error("执行运行身份字段不可改变");
    writeJson(this.executionRunFile(projectId, run.executionRunId), run);
    this.updateProject(projectId, { executionEnabled: run.executionEnabled, status: run.status, progress: run.progress, activeExecutionRunId: run.executionRunId });
    return run;
  }
  saveTaskResult(projectId, executionRunId, taskId, result) {
    writeJson(this.taskResultFile(projectId, executionRunId, taskId), result);
    return path.relative(this.projectDir(projectId), this.taskResultFile(projectId, executionRunId, taskId)).replaceAll("\\", "/");
  }
  getTaskResult(projectId, executionRunId, taskId) {
    const file = this.taskResultFile(projectId, executionRunId, taskId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  saveEvidence(projectId, executionRunId, evidenceId, evidence) {
    writeJson(this.evidenceFile(projectId, executionRunId, evidenceId), evidence);
    return path.relative(this.projectDir(projectId), this.evidenceFile(projectId, executionRunId, evidenceId)).replaceAll("\\", "/");
  }
  saveFinalResult(projectId, executionRunId, result) {
    writeJson(this.finalResultFile(projectId, executionRunId), result);
    return path.relative(this.projectDir(projectId), this.finalResultFile(projectId, executionRunId)).replaceAll("\\", "/");
  }
  getFinalResult(projectId, executionRunId) {
    const file = this.finalResultFile(projectId, executionRunId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  getActiveExecutionRun(projectId) {
    const project = this.getProject(projectId);
    return project?.activeExecutionRunId ? this.getExecutionRun(projectId, project.activeExecutionRunId) : null;
  }
  getActive(projectId) {
    const project = this.getProject(projectId);
    if (!project?.activePlanId) return project ? { project, plan: null } : null;
    return { project, plan: this.getPlan(projectId, project.activePlanId) };
  }
}
