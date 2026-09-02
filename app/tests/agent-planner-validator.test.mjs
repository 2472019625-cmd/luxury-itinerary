import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CAPABILITIES, AGENT_CAPABILITY_BY_ID, AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";
import { AGENT_RULE_PROFILE_VERSION, GLOBAL_HARD_RULE_IDS } from "../config/agent-rule-profile.mjs";
import { AGENT_TASK_ROUTES } from "../config/agent-task-routing.mjs";
import { validateAgentPlan } from "../server/agent-plan-validator.mjs";

const factBasis = {
  destination: "肯尼亚",
  dayCount: 3,
  startDate: "2026-10-01",
  endDate: "2026-10-03",
  travelerCount: 2,
  hotels: [{ id: "h1", name: "Example Safari Lodge", nights: 2 }],
  transport: ["越野车"],
  coreExperiences: ["草原游猎"],
  days: [1, 2, 3].map((day) => ({ day, date: `2026-10-0${day}`, route: `路线${day}`, hotel: "Example Safari Lodge", meals: null, experience: `体验${day}` })),
  sourceCoverage: { workbookName: "fresh.xlsx", sheetCount: 1, warnings: [], unrecognizedFields: [] },
};
const fingerprint = "f".repeat(64);

function makePlan() {
  const tasks = Object.entries(AGENT_TASK_ROUTES).map(([taskType, route], index) => ({
    taskId: `task-${taskType}-${index + 1}`,
    taskType,
    title: `动态任务 ${taskType}`,
    objective: `根据当前项目完成 ${taskType} 的未来规划`,
    targetPath: route.allowedTargets[0],
    requiredContext: ["当前事实快照"],
    expectedResult: `${taskType} 的受控结果`,
    capabilityIds: [...route.capabilityIds],
    requiredRuleIds: [...route.requiredRuleIds],
    checkpointIds: [...route.checkpoints],
    dependsOn: index ? [`task-${Object.keys(AGENT_TASK_ROUTES)[index - 1]}-${index}`] : [],
    parallelGroup: `P${Math.min(index, 8)}`,
    invocationMode: "plan_only",
    status: "planned",
    failurePolicy: "只处理目标单元，失败则中断或等待确认",
    reasoningLevel: "program",
    budgetKey: AGENT_CAPABILITY_BY_ID.get(route.capabilityIds[0]).budgetKey,
    retryLimit: 1,
    rationale: "由当前事实和安全路由触发",
  }));
  return {
    planId: "plan-1", projectId: "project-1", planVersion: 1, previousPlanId: null,
    flowKind: "agent_v1", executionEnabled: false, status: "plan_only", inputFingerprint: fingerprint,
    createdAt: new Date().toISOString(), validatedAt: null,
    ruleProfileVersion: AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion: AGENT_CAPABILITY_VERSION, promptVersion: "agent-trip-planner-v1",
    runtime: { port: 4174, namespace: "agent_v1" }, globalRuleIds: [...GLOBAL_HARD_RULE_IDS],
    summary: { contentTheme: "循序渐进的草原体验", visualTheme: "从辽阔到细节", planningRationale: "重复游猎日按体验差异拆分" },
    factBasis: structuredClone(factBasis), dayRoles: Array.from({ length: factBasis.dayCount }, (_, index) => ({ index, role: `DAY ${index + 1}`, differenceFromAdjacent: "真实路线不同", contentAction: "optimize", sourceRefs: [`days.${index}`] })), contentPlacement: [], modules: [], copyPlan: { compiledBy: "program", groups: [] }, webVerification: [],
    imagePlan: { visualStory: "每一天承担不同视觉职责", slots: [
      { slotId: "cover", role: "cover", required: true },
      { slotId: "hotel-1", role: "hotel:1", required: true },
      { slotId: "day-1", role: "day:1", required: true },
      { slotId: "day-2", role: "day:2", required: true },
      { slotId: "day-3", role: "day:3", required: true },
    ] },
    tasks, checkpointCoverage: [...new Set(tasks.flatMap((task) => task.checkpointIds))], confirmations: [], adjustments: [], validation: { passed: false, errors: [] },
    capabilityCallStats: AGENT_CAPABILITIES.map((item) => ({ capabilityId: item.id, actualCalls: item.id === "source_parser" || item.id === "trip_planner" ? 1 : 0, plannedTasks: tasks.filter((task) => task.capabilityIds.includes(item.id)).length })),
  };
}

const validate = (plan) => validateAgentPlan(plan, { inputFingerprint: fingerprint, factBasis });
test("事实驱动的动态计划通过确定性校验", () => assert.equal(validate(makePlan()).valid, true, JSON.stringify(validate(makePlan()).errors)));

test("删除必需规则会失败", () => {
  const plan = makePlan();
  plan.tasks[0].requiredRuleIds.pop();
  assert.ok(validate(plan).errors.some((item) => item.code === "rule_coverage_missing"));
});

test("改写确定性事实会失败", () => {
  const plan = makePlan(); plan.factBasis.dayCount = 4;
  assert.ok(validate(plan).errors.some((item) => item.code === "fact_conflict"));
});

test("真实搜图调用会失败", () => {
  const plan = makePlan(); plan.capabilityCallStats.find((item) => item.capabilityId === "image_search").actualCalls = 1;
  assert.ok(validate(plan).errors.some((item) => item.code === "capability_unauthorized"));
});

test("引用4173或打开执行开关会失败", () => {
  const portPlan = makePlan(); portPlan.runtime.port = 4173;
  assert.equal(validate(portPlan).valid, false);
  const executionPlan = makePlan(); executionPlan.executionEnabled = true;
  assert.equal(validate(executionPlan).valid, false);
});

test("依赖环、缺主图与固定T01列表会失败", () => {
  const circular = makePlan(); circular.tasks[0].dependsOn = [circular.tasks.at(-1).taskId];
  assert.ok(validate(circular).errors.some((item) => item.message.includes("形成环")));
  const missingImage = makePlan(); missingImage.imagePlan.slots = missingImage.imagePlan.slots.filter((item) => item.role !== "day:2");
  assert.equal(validate(missingImage).valid, false);
  const fixed = makePlan(); fixed.tasks = Array.from({ length: 20 }, (_, index) => ({ ...fixed.tasks[index % fixed.tasks.length], taskId: `T${String(index + 1).padStart(2, "0")}`, dependsOn: [] }));
  assert.ok(validate(fixed).errors.some((item) => item.message.includes("不能复制为固定展示任务")));
});

test("同一并行组的无依赖任务不能写入同一目标路径", () => {
  const plan = makePlan();
  const left = plan.tasks.find((task) => task.taskType === "copy_global");
  const right = plan.tasks.find((task) => task.taskType === "copy_hotel_transport");
  right.parallelGroup = left.parallelGroup;
  right.targetPath = left.targetPath;
  right.dependsOn = [];
  left.dependsOn = [];
  assert.ok(validate(plan).errors.some((item) => item.message.includes("并行任务写入路径冲突")));
});
