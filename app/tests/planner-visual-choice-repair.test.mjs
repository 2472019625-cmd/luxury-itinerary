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

async function generateWithVisual(visual, { duplicate = false, secondVisual = null, factHotelName = visual.queryCore.identity || "测试酒店", factHotelDetails = {} } = {}) {
  const targetRole = visual.role || "hotel:1";
  const data = { destination: "肯尼亚", hotels: [{ id: "hotel-1", officialName: factHotelName, region: "内罗毕", ...factHotelDetails }, ...(secondVisual ? [{ id: "hotel-2", officialName: factHotelName, region: "内罗毕" }] : [])], transportSummary: targetRole === "transport:1" ? [{ id: "vehicle-1", category: visual.queryCore.subject }] : [], days: [{ route: "城市", description: "抵达酒店" }] };
  const factBasis = buildAgentFactBasis(data);
  let calls = 0;
  const result = await generateAgentPlan({
    project: { projectId: "visual-choice-contract", inputFingerprint: "fixture", factBasis, planIds: [] },
    simpleSkillContract: true,
    requestJson: async (options) => {
      calls += 1;
      const response = await plannerRequestJson({ delayMs: 0 })(options);
      const hotel = response.json.imagePlan.slots.find((slot) => slot.role === targetRole);
      Object.assign(hotel, structuredClone(visual));
      if (secondVisual) Object.assign(response.json.imagePlan.slots.find((slot) => slot.role === "hotel:2"), structuredClone(secondVisual));
      if (duplicate) Object.assign(response.json.imagePlan.slots.find((slot) => slot.role === "cover"), structuredClone(visual), { role: "cover" });
      return response;
    },
  });
  assert.equal(calls, 1, "局部语义问题不得触发第二次业务规划");
  assert.equal(result.plan.validation.plannerBusinessRuns, 1);
  return { ...result, data, slot: result.plan.imagePlan.slots.find((slot) => slot.role === targetRole) };
}

test("酒店代表图归一既定空间选择，保持完整身份并向Image传递同一Core", async () => {
  for (const [identity, subject, subjectEn, visual] of [
    ["Harbour Azure Hotel", "酒店建筑或大堂", "hotel exterior or lobby", "外观或大堂现代空间"],
    ["山岚居", "大堂或酒店建筑", "lobby or hotel exterior", "大堂或外观"],
    ["Lodge Étoile", "泳池或套房或公共空间", "pool or suite or public space", "泳池或套房或公共空间"],
    ["Dune House", "酒店代表性空间", "representative hotel space", "套房或公共空间"],
  ]) {
    const original = hotelVisual({ location: identity, locationRole: "scope_only", primaryVisualSubject: `${identity} ${visual}`, queryCore: { subject, subjectEn, action: "", actionEn: "", identity, identityEn: identity }, fidelityQuery: `${identity} 酒店外观`, alternateQueries: [`${identity} hotel lobby`] });
    const { slot, plan, data, attempts } = await generateWithVisual(original);
    assert.equal(slot.plannerSlotStatus, "locally_repaired", identity);
    assert.equal(slot.queryCore.subject, "酒店代表性空间");
    assert.equal(slot.queryCore.identity, identity);
    assert.equal(slot.exactIdentityRequired, true);
    assert.deepEqual(slot.searchIntent, ["酒店外观", "酒店套房", "酒店泳池", "酒店公共空间"]);
    assert.equal(slot.plannerLocalRepairs[0].code, "hotel_representative_choice_resolved");
    assert.deepEqual(attempts[0].rawModelPlan.imagePlan.slots.find((item) => item.role === "hotel:1").queryCore, original.queryCore);
    const imageSlot = materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel");
    assert.equal(imageSlot.needsUserAction, false);
    assert.deepEqual(imageSlot.queryCore, slot.queryCore);
    assert.equal(imageSlot.exactIdentityRequired, true);
  }
});

test("城市酒店是普通酒店类型修饰，不让同店外观或大堂阻断自动搜索", async () => {
  const original = hotelVisual({
    primaryVisualSubject: "JW Marriott Hotel Nairobi 城市酒店外观或大堂",
    queryCore: { subject: "城市酒店外观或大堂", subjectEn: "city hotel exterior or lobby", action: "", actionEn: "", identity: "JW Marriott Hotel Nairobi", identityEn: "JW Marriott Hotel Nairobi" },
    fidelityQuery: "JW Marriott Hotel Nairobi 城市酒店外观",
    alternateQueries: ["JW Marriott Hotel Nairobi hotel lobby"],
  });
  const { slot, plan, data } = await generateWithVisual(original);
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.queryCore.subject, "酒店代表性空间");
  assert.equal(slot.queryCore.identity, original.queryCore.identity);
  assert.equal(slot.plannerLocalRepairs[0].code, "hotel_representative_choice_resolved");
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel").needsUserAction, false);
  const specific = await generateWithVisual({ ...original, primaryVisualSubject: "JW Marriott Hotel Nairobi 城市酒店总统套房或大堂", queryCore: { ...original.queryCore, subject: "城市酒店总统套房或大堂" } });
  assert.equal(specific.slot.plannerSlotStatus, "unresolved", "特定房型不属于普通代表空间归一");
});

test("同店普通客房视野或外观可归入代表空间，但已预订特定房型不能放宽", async () => {
  const original = hotelVisual({
    primaryVisualSubject: "JW Marriott Hotel Nairobi客房城市景观或酒店外观",
    queryCore: { subject: "JW Marriott Hotel Nairobi酒店客房", subjectEn: "JW Marriott Hotel Nairobi room", action: "", actionEn: "", identity: "JW Marriott Hotel Nairobi", identityEn: "JW Marriott Hotel Nairobi" },
    fidelityQuery: "内罗毕JW万豪酒店客房城市景观",
    alternateQueries: ["JW Marriott Hotel Nairobi exterior", "JW Marriott内罗毕酒店房间"],
  });
  const { slot, plan, data } = await generateWithVisual(original);
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.queryCore.subject, "酒店代表性空间");
  assert.equal(slot.queryCore.identity, "JW Marriott Hotel Nairobi");
  assert.deepEqual(slot.plannerLocalRepairs[0].allowedCategories.sort(), ["exterior", "suite"]);
  assert.deepEqual(slot.plannerLocalRepairs[0].softViewPreferences, ["城市景观"]);
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel").needsUserAction, false);
  const booked = await generateWithVisual(original, { factHotelDetails: { roomType: "City View Room" } });
  assert.equal(booked.slot.plannerSlotStatus, "unresolved", "明确预订的房型视野不得退化为普通酒店代表图");
  const named = await generateWithVisual({ ...original, primaryVisualSubject: "JW Marriott Hotel Nairobi总统套房或酒店外观", queryCore: { ...original.queryCore, subject: "JW Marriott Hotel Nairobi总统套房", subjectEn: "JW Marriott Hotel Nairobi presidential suite" } });
  assert.equal(named.slot.plannerSlotStatus, "unresolved", "专属或命名房型不属于普通类别池");
  const otherOrdinarySpaces = await generateWithVisual(hotelVisual({ primaryVisualSubject: "酒店建筑外观或酒店泳池" }));
  assert.equal(otherOrdinarySpaces.slot.plannerSlotStatus, "locally_repaired", "同店普通代表空间可按既有类别池择优");
});

test("酒店代表选择不放行具体设施、房型、动作、其他实体或跨模块目标", async () => {
  const identity = "Harbour Azure Hotel";
  const base = hotelVisual({ primaryVisualSubject: `${identity} 外观或大堂`, queryCore: { subject: "酒店外观或大堂", action: "", identity }, fidelityQuery: "酒店外观", alternateQueries: ["酒店大堂"] });
  for (const patch of [
    { queryCore: { ...base.queryCore, subject: "私人泳池或套房" }, primaryVisualSubject: `${identity} 私人泳池或套房` },
    { queryCore: { ...base.queryCore, subject: "总统套房或客房" }, primaryVisualSubject: `${identity} 总统套房或客房` },
    { queryCore: { ...base.queryCore, action: "游泳" } },
    { queryCore: { ...base.queryCore, identity: `${identity}或Other Hotel` } },
    { primaryVisualSubject: `${identity} 外观或Other Hotel大堂` },
    { queryCore: { ...base.queryCore, subjectEn: "spa or restaurant" } },
    { exactIdentityRequired: false },
    { role: "transport:1" },
  ]) {
    const { slot } = await generateWithVisual({ ...base, ...patch });
    assert.equal(slot.plannerSlotStatus, "unresolved", JSON.stringify(patch));
    assert.equal(slot.needsUserAction, true);
  }
  const conflicting = await generateWithVisual(base, { factHotelName: "Another Harbour Hotel" });
  assert.equal(conflicting.slot.plannerSlotStatus, "unresolved", "酒店代表图仍绑定原始酒店事实");
});

test("酒店代表空间归一后重复职责仍挂起，不能用不同类别措辞掩盖重复", async () => {
  const identity = "Harbour Azure Hotel";
  const visual = (role, subject) => hotelVisual({ role, primaryVisualSubject: `${identity} ${subject}`, queryCore: { subject, action: "", identity }, fidelityQuery: "酒店外观", alternateQueries: ["酒店大堂"], sourceRefs: [role === "hotel:1" ? "hotels.0" : "hotels.1"] });
  const { plan } = await generateWithVisual(visual("hotel:1", "外观或大堂"), { secondVisual: visual("hotel:2", "泳池或套房") });
  const second = plan.imagePlan.slots.find((slot) => slot.role === "hotel:2");
  assert.equal(second.plannerSlotStatus, "unresolved");
  assert.ok(second.plannerValidationIssues.some((issue) => issue.code === "duplicate_visual_responsibility"));
});

function transportVisual(visual, overrides = {}) {
  return { role: "transport:1", primaryVisualSubject: visual, location: "测试地区", locationRole: "scope_only", exactIdentityRequired: false,
    queryCore: { subject: "商务车", action: "停靠", identity: "", subjectEn: "business vehicle", actionEn: "parked", identityEn: "" },
    fidelityQuery: "商务车停靠", alternateQueries: ["business vehicle parked"], sourceRefs: ["transport.0"], ...overrides };
}

test("非核心环境选择不阻断明确主体动作，位置和语言顺序不改变结果", async () => {
  for (const visual of ["商务车在城市道路或机场停靠", "在机场或城市道路，商务车停靠", "商务车停靠，背景为城市道路或机场", "business vehicle parked at an airport or a city road"]) {
    const original = transportVisual(visual);
    const { slot, plan, data } = await generateWithVisual(original);
    assert.equal(slot.plannerSlotStatus, "locally_repaired", visual);
    assert.equal(slot.primaryVisualSubject, "商务车 停靠");
    assert.deepEqual(slot.queryCore, original.queryCore);
    assert.deepEqual(slot.alternateQueries, original.alternateQueries);
    assert.equal(slot.plannerLocalRepairs[0].code, "background_visual_choice_resolved");
    assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "transport").needsUserAction, false);
  }
  const original = transportVisual("商务用车在城市道路或机场接送行驶", {
    queryCore: { subject: "商务用车", action: "行驶", identity: "", subjectEn: "business car", actionEn: "driving", identityEn: "" },
    fidelityQuery: "商务用车接送行驶", alternateQueries: ["business car transfer", "城市商务车接送"],
  });
  const { slot } = await generateWithVisual(original);
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.primaryVisualSubject, "商务用车 行驶");
  assert.deepEqual(slot.queryCore, original.queryCore);
  assert.deepEqual(slot.alternateQueries, original.alternateQueries);
});

test("非核心归一不选择真实主体动作、不去掉必要身份、不接受矛盾查询", async () => {
  for (const [visual, overrides] of [
    ["商务车停靠或游客骑行", {}],
    ["商务车在城市道路停靠或机场行驶", {}],
    ["商务车在城市道路或机场停靠", { queryCore: { subject: "商务车或游猎车", action: "停靠", identity: "" } }],
    ["商务车在城市道路或机场停靠", { queryCore: { subject: "商务车", action: "停靠或行驶", identity: "" } }],
    ["商务车在城市道路或机场停靠", { alternateQueries: ["bicycle riding"] }],
    ["商务车在城市道路或机场停靠", { exactIdentityRequired: true, queryCore: { subject: "商务车", action: "停靠", identity: "指定机场建筑" } }],
    ["商务车停靠", { queryCore: { subject: "商务车或游猎车", action: "停靠", identity: "" } }],
  ]) {
    const { slot } = await generateWithVisual(transportVisual(visual, overrides));
    assert.equal(slot.plannerSlotStatus, "unresolved", visual);
  }
});

test("交通背景二选一若Core动作与原查询仍不一致，清洗地点后也不得自动搜索", async () => {
  const visual = transportVisual("商务用车在机场或城市道路接送", {
    location: "内罗毕",
    queryCore: { subject: "商务用车", action: "行驶", identity: "", subjectEn: "business car", actionEn: "driving", identityEn: "" },
    fidelityQuery: "肯尼亚机场商务接送车",
    alternateQueries: ["business car transfer in Nairobi", "内罗毕商务用车接送"],
  });
  const { slot } = await generateWithVisual(visual);
  assert.equal(slot.plannerSlotStatus, "unresolved");
  assert.ok(slot.plannerValidationIssues.some((issue) => issue.code === "ambiguous_visual_subject"));
  assert.ok(slot.plannerLocalRepairs.some((repair) => repair.code === "queries_locally_repaired"));
});

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
