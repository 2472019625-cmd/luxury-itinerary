import assert from "node:assert/strict";
import test from "node:test";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { applySimpleSkillResults } from "../server/simple-pipeline-writeback.mjs";
import { selectCustomerRenderData } from "../server/customer-render-data.mjs";

function fixture() {
  const days = [0, 1].map((index) => ({
    date: `2026-10-${15 + index}`,
    theme: "旧主题",
    city: "塞伦盖蒂西部",
    routeNodes: ["塞伦盖蒂西部"],
    description: `第${index + 1}日原始说明`,
    hotel: "Singita Faru Faru Lodge",
    vehicle: "敞篷游猎车",
    mealPlan: { breakfast: "酒店早餐", lunch: "营地午餐", dinner: "营地晚餐" },
    spots: [{ id: `spot-${index + 1}`, name: index ? "保护区徒步" : "敞篷越野游猎", description: "原始体验说明", status: index ? "optional_paid" : "included", statusLabel: index ? "自费可选" : "已包含", feeBoundary: index ? "excluded" : "included", optional: index === 1, sourceEvidence: [`DAY ${index + 1} 原始资料`], images: [] }],
  }));
  const data = {
    title: "坦桑尼亚2日",
    subtitle: "Parser 默认副标题",
    destination: "坦桑尼亚",
    travelers: 2,
    hotels: [{ id: "faru", officialName: "Singita Faru Faru Lodge", shortName: "Faru Faru", region: "塞伦盖蒂西部", nights: 2, roomType: "待确认", status: "pending", editorialCopy: "旧酒店文案", proofPoints: ["两晚连住", "方便衔接"], sourceEvidence: ["DAY 1 住宿", "DAY 2 住宿"], images: [] }],
    diningExperiences: [],
    transportSummary: [{ id: "vehicle", category: "四驱开顶式越野车", serviceLevel: "四驱敞篷越野车", seatCount: null, modelGuaranteed: false, usageLabel: "园区游猎用车", usageSegments: ["DAY 1 塞伦盖蒂西部", "DAY 2 塞伦盖蒂西部"], editorialCopy: "旧交通文案", features: [], images: [] }],
    notes: [{ title: "准备", items: ["原始提醒"] }],
    highlights: [],
    days,
  };
  const agentPlan = {
    planId: "plan-content-contract",
    summary: { contentTheme: "草原深度体验" },
    modules: [],
    selectedHighlights: [],
    dayRoles: days.map((_day, index) => ({ index, role: index ? "从车览转向步行观察" : "以越野游猎打开保护区", differenceFromAdjacent: index ? "体验方式由乘车转为徒步" : "作为旅程开场建立草原尺度", contentAction: "optimize", sourceRefs: [`days.${index}`] })),
    imagePlan: { slots: [] },
  };
  return { data, agentPlan };
}

test("Program 为 subtitle、DAY theme、spot description 与酒店 proofPoints 物化精确 Copy targets", () => {
  const { data, agentPlan } = fixture();
  data.notes = [];
  data.days[0].spots[0].description = "全天敞篷越野游猎，夜晚回到营地围坐篝火，泳池边休息";
  data.days[0].spots[0].sourceEvidence = [data.days[0].spots[0].description];
  const plan = materializeSimpleSkillPlan({ data, agentPlan, report: { cellCoverage: [{ raw: "行程中园区提供1台7座4x4可开顶式越野车" }] } });
  const byPath = new Map(plan.copyTasks.map((task) => [task.targetPath, task]));
  assert.ok(byPath.has("subtitle"));
  assert.ok(byPath.has("days.0.theme"));
  assert.ok(byPath.has("days.1.theme"));
  assert.ok(byPath.has("days.0.spots.0.description"));
  assert.ok(byPath.has("days.1.spots.0.description"));
  assert.ok(byPath.has("hotels.0.proofPoints"));
  assert.ok(byPath.has("hotels.0.factRows"));
  assert.ok(byPath.has("transportSummary.0.usageLabel"));
  assert.ok(byPath.has("transportSummary.0.features"));
  assert.ok(byPath.has("notes"));
  assert.equal(byPath.get("hotels.0.proofPoints").outputSchema.type, "array");
  assert.equal(byPath.get("hotels.0.proofPoints").outputSchema.minItems, 0);
  assert.equal(byPath.get("hotels.0.proofPoints").outputSchema.maxItems, 3);
  assert.equal(byPath.get("hotels.0.editorialCopy").researchRequest.researchType, "official_entity_facts");
  assert.deepEqual(byPath.get("hotels.0.editorialCopy").researchRequest.categories, ["位置", "客房", "设计", "设施"]);
  assert.deepEqual(byPath.get("hotels.0.editorialCopy").researchRequest, byPath.get("hotels.0.proofPoints").researchRequest);
  assert.deepEqual(byPath.get("hotels.0.editorialCopy").researchRequest, byPath.get("hotels.0.factRows").researchRequest);
  assert.equal(byPath.get("hotels.0.factRows").moduleType, "hotel_fact_rows");
  assert.equal(byPath.get("hotels.0.factRows").required, false);
  assert.equal(byPath.get("hotels.0.factRows").outputSchema.minItems, 4);
  assert.equal(byPath.get("hotels.0.factRows").outputSchema.maxItems, 4);
  assert.ok(byPath.get("hotels.0.editorialCopy").facts.lodgingIdentityEvidence.every((item) => /^DAY \d+ 住宿：/.test(item)));
  assert.ok(byPath.get("hotels.0.editorialCopy").facts.supplierHotelContext.every((item) => !/^DAY \d+ 住宿：/.test(item)));
  assert.match(byPath.get("days.0.spots.0.description").facts.description, /敞篷越野游猎/);
  assert.doesNotMatch(byPath.get("days.0.spots.0.description").facts.description, /营地|篝火|泳池/);
  assert.ok(byPath.get("days.0.spots.0.description").facts.sourceEvidence.every((item) => !/营地|篝火|泳池/.test(item)));
  assert.equal(byPath.get("days.0.spots.0.description").relevantContext.dayRole, undefined);
  assert.equal(byPath.get("days.0.spots.0.description").relevantContext.plannerSummary, undefined);
  assert.equal(byPath.get("days.0.spots.0.description").relevantContext.sourcePosterHighlights, undefined);
  assert.deepEqual(byPath.get("days.0.spots.0.description").relevantContext.spotOccurrence, { dayNumber: 1, ordinal: 1, total: 1 });
  assert.match(byPath.get("days.0.theme").plannerGoal, /1 个主记忆点/);
  assert.match(byPath.get("days.0.description").plannerGoal, /1 个主体验、最多 1 个辅助体验/);
  assert.match(byPath.get("days.0.description").plannerGoal, /estimatedTravelTime.*正文不得再次写数字车程/);
  assert.match(byPath.get("hotels.0.editorialCopy").plannerGoal, /2—4 句直接、易读/);
  assert.match(byPath.get("hotels.0.proofPoints").plannerGoal, /真实、具体、可快速理解/);
  assert.match(byPath.get("transportSummary.0.usageLabel").plannerGoal, /客户可见使用范围/);
  assert.match(byPath.get("transportSummary.0.editorialCopy").plannerGoal, /最重要的一个价值/);
  assert.match(byPath.get("transportSummary.0.features").plannerGoal, /2—3 个短配置价值点/);
  assert.match(byPath.get("notes").plannerGoal, /定制师已经提前替客户想到/);
  assert.equal(plan.preparedData.transportSummary[0].seatCount, 7);
  assert.deepEqual(plan.dayRoles, agentPlan.dayRoles);
});

test("Program 允许 Transport 已有表达字段按五层职责独立写回", () => {
  const { data, agentPlan } = fixture();
  const plan = materializeSimpleSkillPlan({ data, agentPlan });
  const paths = ["transportSummary.0.usageLabel", "transportSummary.0.editorialCopy", "transportSummary.0.features"];
  const tasks = plan.copyTasks.filter((task) => paths.includes(task.targetPath));
  const values = new Map([
    ["transportSummary.0.usageLabel", "塞伦盖蒂西部 · 保护区游猎"],
    ["transportSummary.0.editorialCopy", "开顶结构让观察和摄影更顺手，也便于按现场节奏灵活移动。"],
    ["transportSummary.0.features", ["开顶便于观察摄影", "覆盖两日园区游猎"]],
  ]);
  const result = applySimpleSkillResults({
    preparedData: plan.preparedData,
    copyTasks: tasks,
    copyExecution: { results: tasks.map((task) => ({ targetId: task.targetId, targetPath: task.targetPath, status: "success", value: values.get(task.targetPath) })) },
  });
  assert.equal(result.requiredUnresolved.length, 0);
  for (const path of paths) {
    const value = path.endsWith("features") ? result.data.transportSummary[0].features : path.endsWith("usageLabel") ? result.data.transportSummary[0].usageLabel : result.data.transportSummary[0].editorialCopy;
    assert.deepEqual(value, values.get(path));
  }
  assert.equal(result.data.transportSummary[0].category, "四驱开顶式越野车");
  assert.equal(result.data.transportSummary[0].seatCount, null);
});

test("Program Writeback 只写授权表达字段并保护订单与 spot 状态事实", () => {
  const { data, agentPlan } = fixture();
  const plan = materializeSimpleSkillPlan({ data, agentPlan });
  const paths = ["subtitle", "hotels.0.proofPoints", "days.0.theme", "days.0.description", "days.0.spots.0.description"];
  const tasks = plan.copyTasks.filter((task) => paths.includes(task.targetPath));
  const values = new Map([
    ["subtitle", "从敞篷游猎到保护区徒步，在草原深处展开两种观察尺度"],
    ["hotels.0.proofPoints", ["河岸环境中的开阔视野", "强调自然连接的居停空间"]],
    ["days.0.theme", "以越野游猎打开草原尺度"],
    ["days.0.description", "乘敞篷游猎车进入保护区，以移动视角建立对草原尺度的第一印象。"],
    ["days.0.spots.0.description", "乘敞篷游猎车移动观察，在更广的范围内寻找野生动物活动线索。"],
  ]);
  const result = applySimpleSkillResults({
    preparedData: plan.preparedData,
    copyTasks: tasks,
    copyExecution: { results: tasks.map((task) => ({ targetId: task.targetId, targetPath: task.targetPath, status: "success", value: values.get(task.targetPath) })) },
  });
  assert.equal(result.requiredUnresolved.length, 0);
  assert.equal(result.data.subtitle, values.get("subtitle"));
  assert.deepEqual(result.data.hotels[0].proofPoints, values.get("hotels.0.proofPoints"));
  assert.equal(result.data.days[0].theme, values.get("days.0.theme"));
  assert.equal(result.data.days[0].spots[0].description, values.get("days.0.spots.0.description"));
  assert.equal(result.data.hotels[0].roomType, "待确认");
  assert.equal(result.data.hotels[0].status, "pending");
  assert.equal(result.data.days[0].spots[0].status, "included");
  assert.equal(result.data.days[1].spots[0].optional, true);
  assert.deepEqual(result.data.days[0].spots[0].sourceEvidence, ["DAY 1 原始资料"]);
});

test("Program 写回结构化酒店事实，客户投影隐藏缺失行和内部来源字段", () => {
  const { data, agentPlan } = fixture();
  const plan = materializeSimpleSkillPlan({ data, agentPlan });
  const task = plan.copyTasks.find((item) => item.targetPath === "hotels.0.factRows");
  const rows = [
    { key: "location", label: "位置", text: "位于塞伦盖蒂西部。", status: "success", sourceUrl: "https://example.com/location", sourceClass: "official_entity", checkedAt: "2026-09-21T00:00:00.000Z" },
    { key: "rooms", label: "客房", text: "", status: "not_found" },
    { key: "design", label: "设计", text: "以自然材质连接室内与河岸景观。", status: "success", sourceUrl: "https://example.com/design", sourceClass: "architect_or_design_studio", checkedAt: "2026-09-21T00:00:00.000Z" },
    { key: "facilities", label: "设施", text: "", status: "source_unavailable" },
  ];
  const result = applySimpleSkillResults({
    preparedData: plan.preparedData,
    copyTasks: [task],
    copyExecution: { results: [{ targetId: task.targetId, targetPath: task.targetPath, status: "success", value: rows }] },
  });
  assert.equal(result.requiredUnresolved.length, 0);
  assert.deepEqual(result.data.hotels[0].factRows, rows);
  const customerRows = selectCustomerRenderData(result.data).hotels[0].factRows;
  assert.deepEqual(customerRows, [
    { key: "location", label: "位置", text: "位于塞伦盖蒂西部。" },
    { key: "design", label: "设计", text: "以自然材质连接室内与河岸景观。" },
  ]);
});

test("Program Writeback 拒绝扩写到房型等非授权字段", () => {
  const { data, agentPlan } = fixture();
  const plan = materializeSimpleSkillPlan({ data, agentPlan });
  const task = { ...plan.copyTasks.find((item) => item.targetPath === "hotels.0.editorialCopy"), targetPath: "hotels.0.roomType" };
  const result = applySimpleSkillResults({ preparedData: plan.preparedData, copyTasks: [task], copyExecution: { results: [{ targetId: task.targetId, targetPath: task.targetPath, status: "success", value: "河景套房" }] } });
  assert.equal(result.data.hotels[0].roomType, "待确认");
  assert.equal(result.unresolvedItems[0].error.code, "unauthorized_target_path");
});
