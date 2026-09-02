import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve("workspace/agent-v1/projects");
const evidenceRoot = path.resolve("../audit/evidence/2026-09-02-可视化自主影子规划器MVP");
mkdirSync(evidenceRoot, { recursive: true });
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); };
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const projects = readdirSync(projectRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => {
  const file = path.join(projectRoot, item.name, "project.json");
  return existsSync(file) ? readJson(file) : null;
}).filter((project) => project?.activePlanId).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 3);
if (projects.length !== 3) throw new Error(`需要3个有效真实项目，当前为${projects.length}个`);

const comparisons = [];
for (const [index, project] of projects.entries()) {
  const directory = path.join(projectRoot, project.projectId);
  const plan = readJson(path.join(directory, "plans", `${project.activePlanId}.json`));
  const previous = plan.previousPlanId ? readJson(path.join(directory, "plans", `${plan.previousPlanId}.json`)) : null;
  const attemptFiles = readdirSync(path.join(directory, "attempts")).filter((name) => name.endsWith(".json"));
  const attempts = attemptFiles.map((name) => readJson(path.join(directory, "attempts", name))).filter((attempt) => !previous || new Date(attempt.createdAt) > new Date(previous.validatedAt)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const label = `${String(index + 1).padStart(2, "0")}-${project.projectId.slice(0, 8)}`;
  const output = path.join(evidenceRoot, label);
  writeJson(path.join(output, "01-source-and-facts.json"), { projectId: project.projectId, flowKind: project.flowKind, executionEnabled: project.executionEnabled, source: project.source, inputFingerprint: project.inputFingerprint, factBasis: project.factBasis, versions: project.versions });
  writeJson(path.join(output, "02-model-attempts.json"), attempts);
  writeJson(path.join(output, "03-final-plan.json"), plan);
  writeJson(path.join(output, "04-validation.json"), { planId: plan.planId, previousPlanId: plan.previousPlanId, activePlanId: project.activePlanId, validation: plan.validation, checkpointCoverage: plan.checkpointCoverage, capabilityCallStats: plan.capabilityCallStats, artifactHashes: { sourceAndFacts: hash({ source: project.source, inputFingerprint: project.inputFingerprint, factBasis: project.factBasis }), modelAttempts: hash(attempts), finalPlan: hash(plan) } });
  const parallelGroups = Object.fromEntries(Object.entries(plan.tasks.reduce((groups, task) => { (groups[task.parallelGroup] ||= []).push(task.title); return groups; }, {})));
  comparisons.push({
    projectId: project.projectId,
    sourceName: project.source.name,
    inputFingerprint: project.inputFingerprint,
    planId: plan.planId,
    previousPlanId: plan.previousPlanId,
    taskCount: plan.tasks.length,
    dependencyEdgeCount: plan.tasks.reduce((sum, task) => sum + task.dependsOn.length, 0),
    parallelGroups,
    shownModules: plan.modules.filter((item) => item.decision === "show").map((item) => item.label),
    hiddenModules: plan.modules.filter((item) => item.decision === "hide").map((item) => item.label),
    dayCopyTasks: plan.tasks.filter((item) => item.taskType === "copy_day_group").map((item) => ({ title: item.title, targetPath: item.targetPath, dependsOn: item.dependsOn })),
    hotelCopyTasks: plan.tasks.filter((item) => item.taskType === "copy_hotel_transport").map((item) => item.title),
    webVerification: plan.webVerification,
    imageRoles: plan.imagePlan.slots.map((slot) => ({ role: slot.role, required: slot.required, visualDuty: slot.visualDuty, removable: slot.removable })),
    confirmations: plan.confirmations,
    correctionUsed: plan.validation.correctionUsed,
    actualCalls: plan.capabilityCallStats.filter((item) => item.actualCalls > 0),
    nonPlanningActualCalls: plan.capabilityCallStats.filter((item) => !["source_parser", "trip_planner"].includes(item.capabilityId)).reduce((sum, item) => sum + item.actualCalls, 0),
  });
}
writeJson(path.join(evidenceRoot, "05-three-plan-differences.json"), comparisons);
writeJson(path.join(evidenceRoot, "06-zero-call-summary.json"), { executionEnabled: false, actualInvocationAllowlist: ["source_parser", "trip_planner"], projects: comparisons.map(({ projectId, planId, actualCalls, nonPlanningActualCalls }) => ({ projectId, planId, actualCalls, nonPlanningActualCalls })), passed: comparisons.every((item) => item.nonPlanningActualCalls === 0) });
console.log(JSON.stringify({ evidenceRoot, projects: comparisons.map((item) => ({ projectId: item.projectId, planId: item.planId, taskCount: item.taskCount, dayCopyTasks: item.dayCopyTasks.length, hotelCopyTasks: item.hotelCopyTasks.length, confirmations: item.confirmations.length, webVerification: item.webVerification.length, imageRoles: item.imageRoles.length, nonPlanningActualCalls: item.nonPlanningActualCalls })) }, null, 2));
