import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
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
  createProject(project) {
    if (existsSync(this.projectFile(project.projectId))) throw new Error("项目已存在");
    atomicJson(this.projectFile(project.projectId), project);
    return project;
  }
  getProject(projectId) {
    const file = this.projectFile(projectId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  saveAttempt(projectId, attempt) { atomicJson(this.attemptFile(projectId, attempt.attemptId), attempt); }
  saveSourceData(projectId, sourceData) {
    if (!this.getProject(projectId)) throw new Error("项目不存在");
    if (existsSync(this.sourceDataFile(projectId))) throw new Error("原始资料快照不可覆盖");
    atomicJson(this.sourceDataFile(projectId), sourceData);
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
    atomicJson(this.planFile(projectId, plan.planId), plan);
    const next = { ...project, activePlanId: plan.planId, planIds: [...(project.planIds || []), plan.planId], status: "ready_for_execution", currentStage: "执行准备完成", updatedAt: new Date().toISOString() };
    atomicJson(this.projectFile(projectId), next);
    return next;
  }
  updateProject(projectId, patch) {
    const current = this.getProject(projectId);
    if (!current) throw new Error("项目不存在");
    const next = { ...current, ...patch, projectId: current.projectId, flowKind: "agent_v1", updatedAt: new Date().toISOString() };
    atomicJson(this.projectFile(projectId), next);
    return next;
  }
  getPlan(projectId, planId) {
    const file = this.planFile(projectId, planId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  saveConfirmations(projectId, confirmations) {
    for (const confirmation of confirmations) atomicJson(this.confirmationFile(projectId, confirmation.confirmationId), confirmation);
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
    atomicJson(this.executionRunFile(projectId, run.executionRunId), run);
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
    atomicJson(this.executionRunFile(projectId, run.executionRunId), run);
    this.updateProject(projectId, { executionEnabled: run.executionEnabled, status: run.status, progress: run.progress, activeExecutionRunId: run.executionRunId });
    return run;
  }
  saveTaskResult(projectId, executionRunId, taskId, result) {
    atomicJson(this.taskResultFile(projectId, executionRunId, taskId), result);
    return path.relative(this.projectDir(projectId), this.taskResultFile(projectId, executionRunId, taskId)).replaceAll("\\", "/");
  }
  getTaskResult(projectId, executionRunId, taskId) {
    const file = this.taskResultFile(projectId, executionRunId, taskId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  saveEvidence(projectId, executionRunId, evidenceId, evidence) {
    atomicJson(this.evidenceFile(projectId, executionRunId, evidenceId), evidence);
    return path.relative(this.projectDir(projectId), this.evidenceFile(projectId, executionRunId, evidenceId)).replaceAll("\\", "/");
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
