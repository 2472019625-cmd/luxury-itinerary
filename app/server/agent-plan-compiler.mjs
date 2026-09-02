import { AGENT_CAPABILITY_BY_ID } from "../config/agent-capabilities.mjs";
import { CHECKPOINT_IDS } from "../config/agent-rule-profile.mjs";
import { AGENT_TASK_ROUTES } from "../config/agent-task-routing.mjs";

const ACTIONS = new Set(["preserve", "optimize", "generate", "hide"]);
const ACTION_ALIASES = new Map([
  ["直接保留", "preserve"], ["保留", "preserve"], ["reuse", "preserve"],
  ["需要优化", "optimize"], ["优化", "optimize"],
  ["需要生成", "generate"], ["生成", "generate"],
  ["自动隐藏", "hide"], ["隐藏", "hide"], ["hidden", "hide"],
]);
const MODULE_ALIASES = Object.freeze({
  global: ["global", "cover", "highlights", "overview", "summary"],
  hotels: ["hotels", "hotel", "hospitality", "accommodation"],
  dining: ["dining", "diningExperiences", "restaurant"],
  transport: ["transport", "transportSummary", "traffic"],
  days: ["days", "daily", "itinerary"],
  notes: ["notes", "notice", "preparation"],
  expenses: ["expenses", "expense", "fees", "pricing"],
});

function normalizeAction(value, fallback = "generate") {
  const raw = String(value || "").trim();
  const normalized = ACTION_ALIASES.get(raw) || raw.toLowerCase();
  return ACTIONS.has(normalized) ? normalized : fallback;
}

function findModule(modules, name) {
  const aliases = new Set(MODULE_ALIASES[name] || [name]);
  return modules.find((item) => aliases.has(String(item?.moduleId || item?.id || ""))) || null;
}

export function normalizeBusinessModules(rawModules = [], factBasis = {}) {
  const modules = Array.isArray(rawModules) ? rawModules : [];
  const definitions = [
    ["global", "封面、亮点与行程总览", true],
    ["hotels", "臻选下榻", (factBasis.hotels || []).length > 0],
    ["dining", "特色餐饮", (factBasis.diningExperiences || []).length > 0],
    ["transport", "全程交通", (factBasis.transport || []).length > 0],
    ["days", "每日行程", (factBasis.days || []).length > 0],
    ["notes", "旅行准备与注意事项", true],
    ["expenses", "费用与退改", true],
  ];
  return definitions.map(([moduleId, label, hasContent]) => {
    const source = findModule(modules, moduleId) || {};
    let contentAction = normalizeAction(source.contentAction || source.action || source.processing, hasContent ? "generate" : "hide");
    let decision = String(source.decision || "").toLowerCase() === "hide" || contentAction === "hide" || !hasContent ? "hide" : "show";
    if (["global", "days", "notes"].includes(moduleId)) decision = "show";
    if (moduleId === "hotels" && hasContent) decision = "show";
    if (moduleId === "transport" && hasContent) decision = "show";
    if (decision === "show" && contentAction === "hide") contentAction = "generate";
    if (decision === "hide") contentAction = "hide";
    return { moduleId, label: String(source.label || label), decision, contentAction, reason: String(source.reason || (hasContent ? "按当前事实进入对应客户模块" : "当前资料没有可展示内容")) };
  });
}

export function filterImagePlanForModules(imagePlan = {}, modules = []) {
  const hidden = new Set(modules.filter((item) => item.decision === "hide").map((item) => item.moduleId));
  const belongsTo = (slot, names) => {
    const identity = [slot?.moduleId, slot?.module, slot?.role, slot?.slotId].filter(Boolean).join(":").toLowerCase();
    return names.some((name) => new RegExp(`(?:^|[:_\\-])${name}(?:$|[:_\\-])`).test(identity));
  };
  return {
    ...imagePlan,
    slots: (Array.isArray(imagePlan?.slots) ? imagePlan.slots : []).filter((slot) => !(hidden.has("dining") && belongsTo(slot, ["dining", "restaurant"])) && !(hidden.has("transport") && belongsTo(slot, ["transport", "traffic"]))),
  };
}

function task(taskId, taskType, overrides = {}) {
  const route = AGENT_TASK_ROUTES[taskType];
  if (!route) throw new Error(`未发布的程序任务类型：${taskType}`);
  const capabilityIds = [...route.capabilityIds];
  return {
    taskId, taskType,
    title: overrides.title || taskType,
    objective: overrides.objective || `按已确认事实完成${overrides.title || taskType}`,
    targetPath: overrides.targetPath || route.allowedTargets[0],
    requiredContext: overrides.requiredContext || ["当前事实快照", "轻量业务规划"],
    expectedResult: overrides.expectedResult || `${overrides.title || taskType}形成可保存结果`,
    capabilityIds,
    requiredRuleIds: [...route.requiredRuleIds],
    checkpointIds: [...new Set([...(route.checkpoints || []), ...(overrides.checkpointIds || [])])],
    dependsOn: [...(overrides.dependsOn || [])],
    parallelGroup: overrides.parallelGroup || `program-${taskId}`,
    invocationMode: "plan_only", status: "planned",
    failurePolicy: overrides.failurePolicy || "保存已完成检查点，只重试失败单元一次；仍失败则中断并说明原因",
    reasoningLevel: overrides.reasoningLevel || "program",
    budgetKey: AGENT_CAPABILITY_BY_ID.get(capabilityIds[0])?.budgetKey,
    retryLimit: overrides.retryLimit ?? Math.min(1, ...capabilityIds.map((id) => AGENT_CAPABILITY_BY_ID.get(id)?.retryLimit ?? 0)),
    rationale: overrides.rationale || "由程序根据已验证业务规划和固定规则编译",
  };
}

const actionFor = (modules, moduleId) => modules.find((item) => item.moduleId === moduleId)?.contentAction || "generate";

export function compileAgentExecutionPlan(raw = {}, context = {}) {
  const modules = normalizeBusinessModules(raw.modules, context.factBasis);
  const tasks = [];
  const add = (value) => { tasks.push(value); return value.taskId; };
  const setup = add(task("sys-project", "project_setup", { title: "建立独立项目记录", targetPath: "project" }));
  const source = add(task("sys-source", "source_intake", { title: "保存原始资料与覆盖台账", targetPath: "factsDraft", dependsOn: [setup] }));
  const fact = add(task("sys-facts", "fact_review", { title: "检查事实、费用与内部信息", targetPath: "checks", dependsOn: [source], checkpointIds: (raw.webVerification || []).length ? [] : ["T08"] }));
  const confirmation = add(task("sys-confirm", "confirmation", { title: "集中处理关键确认", targetPath: "confirmations", dependsOn: [fact] }));
  const journey = add(task("sys-journey-plan", "journey_strategy", { title: "应用整程内容与视觉规划", targetPath: "plan.summary", dependsOn: [confirmation] }));
  const modulePlan = add(task("sys-module-plan", "module_strategy", { title: "应用模块取舍与内容归位", targetPath: "plan.modules", dependsOn: [journey] }));
  if (Array.isArray(raw.webVerification) && raw.webVerification.length) add(task("sys-web-verification", "web_verification", { title: "核验需要外部依据的事实", targetPath: "verificationEvidence", dependsOn: [modulePlan], parallelGroup: "work-verification" }));

  const copyTaskIds = [];
  if (actionFor(modules, "global") !== "preserve") copyTaskIds.push(add(task("copy-global", "copy_global", { title: "批量生成行程总览与全局文案", targetPath: "customerCopy.global", dependsOn: [modulePlan], parallelGroup: "work-copy-a" })));
  if (modules.find((item) => item.moduleId === "hotels")?.decision === "show" && actionFor(modules, "hotels") !== "preserve") copyTaskIds.push(add(task("copy-hotels", "copy_hotel_transport", { title: "一次生成全部酒店文案", targetPath: "customerCopy.hotels", dependsOn: [modulePlan], parallelGroup: "work-copy-a" })));
  if (modules.find((item) => item.moduleId === "dining")?.decision === "show" && actionFor(modules, "dining") !== "preserve") copyTaskIds.push(add(task("copy-dining", "copy_hotel_transport", { title: "一次生成全部特色餐饮文案", targetPath: "customerCopy.dining", dependsOn: [modulePlan], parallelGroup: "work-copy-b" })));
  if (modules.find((item) => item.moduleId === "transport")?.decision === "show" && actionFor(modules, "transport") !== "preserve") copyTaskIds.push(add(task("copy-transport", "copy_hotel_transport", { title: "一次生成全部交通文案", targetPath: "customerCopy.transport", dependsOn: [modulePlan], parallelGroup: "work-copy-b" })));
  if (actionFor(modules, "days") !== "preserve") copyTaskIds.push(add(task("copy-days", "copy_day_group", { title: "批量生成全部目标DAY", targetPath: "customerCopy.days", dependsOn: [modulePlan], parallelGroup: "work-copy-a" })));
  if (["notes", "expenses"].some((id) => !["preserve", "hide"].includes(actionFor(modules, id)))) copyTaskIds.push(add(task("copy-closing", "copy_closing", { title: "批量生成注意事项与费用表达", targetPath: "customerCopy.closing", dependsOn: [modulePlan], parallelGroup: "work-copy-b" })));
  if (!copyTaskIds.length) copyTaskIds.push(add(task("copy-preserved", "copy_global", { title: "确认直接保留文案已正确归位", targetPath: "customerCopy.global", dependsOn: [modulePlan], rationale: "全部目标文案直接保留，任务不调用模型，只负责归位检查" })));

  const review = add(task("copy-brand-review", "copy_review", { title: "执行唯一一次品牌审查", targetPath: "copyReview", dependsOn: copyTaskIds, parallelGroup: "work-brand" }));
  const repair = add(task("copy-repair-batches", "targeted_copy_repair", { title: "按模块合并重生成不合格目标", targetPath: "customerCopy.target", dependsOn: [review], parallelGroup: "work-repair" }));
  const imageSearch = add(task("image-search", "image_search_plan", { title: "按图片位搜索真实候选", targetPath: "imageCandidates", dependsOn: [modulePlan], parallelGroup: "work-images" }));
  const visual = add(task("image-audit", "visual_review", { title: "连续审核已下载图片", targetPath: "visualReview", dependsOn: [imageSearch] }));
  const placement = add(task("image-placement", "image_placement", { title: "把合格图片放入对应位置", targetPath: "currentProject", dependsOn: [visual, repair] }));
  const gap = add(task("image-gaps", "image_gap_resolution", { title: "处理必需图片缺口和可选位收缩", targetPath: "currentProject", dependsOn: [placement] }));
  const render = add(task("render-2000", "layout_render", { title: "渲染实际2000px长图", targetPath: "renderArtifacts", dependsOn: [gap] }));
  const qa = add(task("final-qa", "final_qa", { title: "检查最终数据、图片和版面", targetPath: "finalQa", dependsOn: [render] }));
  const gate = add(task("completion-gate", "completion_gate", { title: "执行100%完成门禁", targetPath: "finalQa", dependsOn: [qa] }));
  const control = add(task("run-control", "control", { title: "保留取消与中断控制", targetPath: "currentProject", dependsOn: [setup] }));
  add(task("save-evidence", "persistence", { title: "保存成品和全链路证据", targetPath: "currentProject", dependsOn: [gate, control] }));

  const covered = new Set(tasks.flatMap((item) => item.checkpointIds));
  for (const checkpointId of CHECKPOINT_IDS) if (!covered.has(checkpointId)) tasks.find((item) => item.taskId === "save-evidence").checkpointIds.push(checkpointId);
  const copyPlan = { compiledBy: "program", concurrency: 2, groups: [
    { groupId: "global", moduleId: "global", action: actionFor(modules, "global") },
    { groupId: "hotels", moduleId: "hotels", action: actionFor(modules, "hotels") },
    { groupId: "dining", moduleId: "dining", action: actionFor(modules, "dining") },
    { groupId: "transport", moduleId: "transport", action: actionFor(modules, "transport") },
    { groupId: "days", moduleId: "days", action: actionFor(modules, "days"), dayIndexes: (context.factBasis.days || []).map((_day, index) => index), splitPolicy: "7至10日优先一次返回，超预算时按连续DAY稳定拆组" },
    { groupId: "closing", moduleId: "notes_expenses", action: [actionFor(modules, "notes"), actionFor(modules, "expenses")].includes("generate") ? "generate" : "optimize" },
  ] };
  return { modules, tasks, copyPlan };
}
