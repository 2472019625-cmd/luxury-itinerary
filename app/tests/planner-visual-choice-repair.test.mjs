import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentFactBasis, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";

function hotelVisual(overrides = {}) {
  return {
    role: "hotel:1",
    primaryVisualSubject: "JW万豪内罗毕酒店现代外观或城市天际线中的酒店建筑",
    location: "JW Marriott Hotel Nairobi",
    locationRole: "visual_identity",
    exactIdentityRequired: true,
    queryCore: { subject: "酒店建筑外观", action: "", identity: "JW Marriott Hotel Nairobi", subjectEn: "hotel building exterior", actionEn: "", identityEn: "JW Marriott Hotel Nairobi" },
    fidelityQuery: "JW Marriott Hotel Nairobi 建筑外观",
    alternateQueries: ["hotel building exterior of JW Marriott Hotel Nairobi", "内罗毕JW万豪酒店外观"],
    sourceRefs: ["hotels.0"],
    ...overrides,
  };
}

async function generateWithVisual(visual, { duplicate = false } = {}) {
  const data = { destination: "肯尼亚", hotels: [{ id: "hotel-1", officialName: visual.queryCore.identity || "测试酒店", region: "内罗毕" }], days: [{ route: "城市", description: "抵达酒店" }] };
  const factBasis = buildAgentFactBasis(data);
  let calls = 0;
  const result = await generateAgentPlan({
    project: { projectId: "visual-choice-contract", inputFingerprint: "fixture", factBasis, planIds: [] },
    simpleSkillContract: true,
    requestJson: async (options) => {
      calls += 1;
      const response = await plannerRequestJson({ delayMs: 0 })(options);
      const hotel = response.json.imagePlan.slots.find((slot) => slot.role === "hotel:1");
      Object.assign(hotel, structuredClone(visual));
      if (duplicate) Object.assign(response.json.imagePlan.slots.find((slot) => slot.role === "cover"), structuredClone(visual), { role: "cover" });
      return response;
    },
  });
  assert.equal(calls, 1, "局部语义问题不得触发第二次业务规划");
  assert.equal(result.plan.validation.plannerBusinessRuns, 1);
  return { ...result, data, slot: result.plan.imagePlan.slots.find((slot) => slot.role === "hotel:1") };
}

test("JW同一建筑外观的两个描述由既定Core和原查询局部收敛，并可传入Image", async () => {
  const original = hotelVisual();
  const { plan, attempts, data, slot } = await generateWithVisual(original);
  assert.equal(slot.primaryVisualSubject, "JW Marriott Hotel Nairobi 酒店建筑外观");
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.needsUserAction, false);
  assert.ok(!plan.validation.unresolvedSlotRoles.includes("hotel:1"));
  for (const field of ["queryCore", "fidelityQuery", "alternateQueries", "location", "locationRole", "exactIdentityRequired", "sourceRefs"]) assert.deepEqual(slot[field], original[field], field);
  assert.equal(slot.plannerLocalRepairs[0].originalPrimaryVisualSubject, original.primaryVisualSubject);
  assert.equal(slot.plannerLocalRepairs[0].supportingQuery, original.alternateQueries[0]);
  assert.equal(attempts[0].rawModelPlan.imagePlan.slots.find((item) => item.role === "hotel:1").primaryVisualSubject, original.primaryVisualSubject, "原始模型证据不覆盖");
  const imageSlot = materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel");
  assert.equal(imageSlot.plannerSlotStatus, "locally_repaired");
  assert.equal(imageSlot.needsUserAction, false);
  assert.equal(imageSlot.primaryVisualSubject, slot.primaryVisualSubject);
});

test("同核修复不依赖JW、酒店或国家词表", async () => {
  const visual = hotelVisual({
    primaryVisualSubject: "古堡现代外观或山坡上的古堡建筑",
    queryCore: { subject: "古堡建筑外观", action: "", identity: "Castle Velora", subjectEn: "castle building exterior", actionEn: "", identityEn: "Castle Velora" },
    location: "Castle Velora",
    fidelityQuery: "Castle Velora 古堡建筑外观",
    alternateQueries: ["Castle Velora castle building exterior"],
  });
  const { slot } = await generateWithVisual(visual);
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.primaryVisualSubject, "Castle Velora 古堡建筑外观");
});

test("不同主体、不同空间、不同动作和缺少共同查询证据仍待人工处理", async () => {
  const base = hotelVisual();
  const cases = [
    ["两个动物", { primaryVisualSubject: "狮子或豹子", queryCore: { subject: "狮子", action: "", identity: "" }, exactIdentityRequired: false, fidelityQuery: "狮子", alternateQueries: ["草原狮子"] }],
    ["两个空间", { primaryVisualSubject: "酒店建筑外观或酒店泳池" }],
    ["室内室外", { primaryVisualSubject: "酒店建筑内饰或酒店建筑外观" }],
    ["单个泛主体", { primaryVisualSubject: "酒店外观或酒店泳池", queryCore: { subject: "酒店", action: "", identity: base.queryCore.identity }, fidelityQuery: "JW Marriott Hotel Nairobi 酒店", alternateQueries: ["JW Marriott Hotel Nairobi hotel"] }],
    ["多词泛主体未决定空间", { primaryVisualSubject: "酒店建筑外观或酒店建筑内饰", queryCore: { subject: "酒店建筑", action: "", identity: base.queryCore.identity, subjectEn: "hotel building" }, fidelityQuery: "JW Marriott Hotel Nairobi 酒店建筑", alternateQueries: ["JW Marriott Hotel Nairobi hotel building"] }],
    ["两个动作", { primaryVisualSubject: "游客徒步或游客骑行", queryCore: { subject: "游客队伍", action: "徒步", identity: "", subjectEn: "visitor group", actionEn: "walking" }, exactIdentityRequired: false, fidelityQuery: "游客队伍徒步", alternateQueries: ["visitor group walking"] }],
    ["Core未决定动作", { primaryVisualSubject: "游客队伍徒步或游客队伍骑行", queryCore: { subject: "游客队伍", action: "", identity: "", subjectEn: "visitor group" }, exactIdentityRequired: false, fidelityQuery: "游客队伍", alternateQueries: ["visitor group"] }],
    ["Core也有二选一", { queryCore: { ...base.queryCore, subject: "酒店建筑外观或泳池" } }],
    ["查询指向其他空间", { alternateQueries: ["JW Marriott Hotel Nairobi swimming pool"] }],
    ["查询只含局部词", { alternateQueries: ["JW Marriott Hotel Nairobi 酒店外观"] }],
    ["查询未证明必要身份", { fidelityQuery: "酒店建筑外观", alternateQueries: ["hotel building exterior"] }],
  ];
  for (const [label, patch] of cases) {
    const { slot } = await generateWithVisual(hotelVisual(patch));
    assert.equal(slot.plannerSlotStatus, "unresolved", label);
    assert.equal(slot.needsUserAction, true, label);
    assert.ok(slot.plannerValidationIssues.some((issue) => issue.code === "ambiguous_visual_subject"), label);
    assert.equal(slot.primaryVisualSubject, patch.primaryVisualSubject || base.primaryVisualSubject, label);
  }
});

test("描述收敛不消除重复视觉职责和身份契约错误", async () => {
  const duplicate = await generateWithVisual(hotelVisual(), { duplicate: true });
  assert.equal(duplicate.slot.plannerSlotStatus, "unresolved");
  assert.ok(duplicate.slot.plannerValidationIssues.some((issue) => issue.code === "duplicate_visual_responsibility"));
  const invalid = await generateWithVisual(hotelVisual({ exactIdentityRequired: "true" }));
  assert.equal(invalid.slot.plannerSlotStatus, "unresolved");
  assert.ok(invalid.slot.plannerValidationIssues.some((issue) => issue.code === "image_exact_identity_invalid"));
  assert.equal(invalid.slot.primaryVisualSubject, hotelVisual().primaryVisualSubject);
});

test("原本单一的画面保持原文，不重写核心、查询或费用状态", async () => {
  const visual = hotelVisual({ primaryVisualSubject: "酒店建筑外观（自费可选，约500美金/人）" });
  const { slot } = await generateWithVisual(visual);
  assert.equal(slot.plannerSlotStatus, "ready");
  assert.equal(slot.primaryVisualSubject, visual.primaryVisualSubject);
  assert.deepEqual(slot.plannerLocalRepairs, []);
});

test("Planner事实基座把对象亮点转换为显示文本", () => {
  const facts = buildAgentFactBasis({ highlights: [{ title: "私家行程", description: "按专属节奏深入" }, "自然观察"], days: [] });
  assert.deepEqual(facts.coreExperiences, ["私家行程：按专属节奏深入", "自然观察"]);
});
