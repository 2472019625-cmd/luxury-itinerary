import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentFactBasis, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";
import { prepareExplicitImageSearchSlot } from "../server/manual-image-search-target.mjs";

test('fact-backed animal alternatives choose one shared automatic/manual target without changing actions', async () => {
  const original = { role: 'day:1', sourceRefs: ['days.0'], exactIdentityRequired: false, locationRole: 'scope_only', location: '肯尼亚',
    primaryVisualSubject: '狮群或花豹在草原游猎车旁活动', queryCore: { subject: '狮群或花豹', subjectEn: 'lion pride or leopard', action: '草原游猎车旁活动', actionEn: 'near safari vehicle on savannah', identity: '', identityEn: '' },
    fidelityQuery: '狮群或花豹 游猎车旁', alternateQueries: ['lion pride or leopard near safari vehicle'] };
  const { slot, plan, data } = await generateWithVisual(original, { dayDescription: '草原游猎，追踪狮群、花豹。' });
  assert.equal(slot.needsUserAction, false);
  assert.equal(slot.queryCore.subject, '狮群');
  assert.equal(slot.queryCore.action, original.queryCore.action);
  const simple = materializeSimpleSkillPlan({ data, agentPlan: plan });
  const target = simple.imageSlots.find(s => s.moduleType === 'day');
  const manual = prepareExplicitImageSearchSlot({ ...target, ...original, plannerSlotStatus: 'unresolved', needsUserAction: true,
    plannerValidationIssues: [{code:'ambiguous_visual_subject'}] }, {plan:simple});
  assert.equal(manual.needsUserAction, false);
  assert.equal(manual.queryCore.subject, '狮群');
  for (const [change, context] of [[{}, {dayDescription:'草原游猎'}], [{userLocked:true}, {dayDescription:'追踪狮群、花豹'}],
    [{queryCore:{...original.queryCore,action:'奔跑或捕猎'}}, {dayDescription:'追踪狮群、花豹'}]]) {
    const result = await generateWithVisual({...original,...change},context);
    assert.equal(result.slot.needsUserAction,true);
  }
});

test("representative detail clauses and ordinary business car poses recover in automatic and manual paths", async () => {
  const hotel = hotelVisual({ primaryVisualSubject: "JW Marriott Hotel Nairobi 代表性空间，Westlands 城市酒店大堂或客房城市景观",
    queryCore: { subject: "酒店代表性空间", subjectEn: "representative hotel space", identity: "JW Marriott Hotel Nairobi", identityEn: "JW Marriott Hotel Nairobi", action: "", actionEn: "" } });
  const car = { role: "transport:1", sourceRefs: ["transport.0"], location: "肯尼亚", locationRole: "scope_only", exactIdentityRequired: false,
    primaryVisualSubject: "内罗毕城市道路上的商务用车，车辆停靠或行驶于市区",
    queryCore: { subject: "商务用车", subjectEn: "business vehicle", action: "在城市道路行驶", actionEn: "driving on city road", identity: "", identityEn: "" },
    fidelityQuery: "商务用车 行驶", alternateQueries: ["business vehicle driving on city road"] };
  for (const original of [hotel, car]) {
    const context = original === car ? { transportFacts: { category: "商务用车", usageSegments: ["DAY 1 接送"] } } : {};
    const { plan, data, slot } = await generateWithVisual(original, context);
    assert.equal(slot.needsUserAction, false);
    const simple = materializeSimpleSkillPlan({ agentPlan: plan, data });
    const target = simple.imageSlots.find(item => item.moduleType === (original === car ? "transport" : "hotel"));
    const manual = prepareExplicitImageSearchSlot({ ...target, ...original, plannerSlotStatus: "unresolved", needsUserAction: true,
      plannerValidationIssues: [{ code: "ambiguous_visual_subject" }] }, { plan: simple });
    assert.equal(manual.needsUserAction, false);
    assert.deepEqual(manual.queryCore, slot.queryCore);
  }
});

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

async function generateWithVisual(visual, { duplicate = false, secondVisual = null, factHotelName = visual.queryCore.identity || "测试酒店", factHotelDetails = {}, dayDescription = "抵达酒店", dayHotel = "", daySpots = [], transportFacts = null, routeNodes = [] } = {}) {
  const targetRole = visual.role || "hotel:1";
  const data = { destination: "肯尼亚", hotels: [{ id: "hotel-1", officialName: factHotelName, region: "内罗毕", ...factHotelDetails }, ...(secondVisual ? [{ id: "hotel-2", officialName: factHotelName, region: "内罗毕" }] : [])], transportSummary: targetRole === "transport:1" ? [transportFacts || { id: "vehicle-1", category: visual.queryCore.subject }] : [], days: [{ route: "城市", routeNodes, description: dayDescription, hotel: dayHotel, spots: daySpots }] };
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

test("同店普通代表空间允许枚举的现代/都市/城市修饰且不改变酒店身份", async () => {
  for (const [identity, visual, subject, subjectEn] of [
    ["Harbour Azure Hotel", "的现代都市酒店外观或大堂", "现代都市酒店外观或大堂", "modern urban hotel exterior or lobby"],
    ["Lodge Borealis", "的当代城市酒店外观或酒店大堂", "当代城市酒店外观或酒店大堂", "contemporary city hotel exterior or hotel lobby"],
    ["Casa Vale", " modern urban hotel exterior or lobby", "modern urban hotel exterior or lobby", "modern urban hotel exterior or lobby"],
  ]) {
    const original = hotelVisual({
      primaryVisualSubject: `${identity}${visual}`,
      locationRole: "scope_only",
      queryCore: { subject, action: "", identity, subjectEn, actionEn: "", identityEn: identity },
      fidelityQuery: `${identity} 酒店外观大堂`, alternateQueries: [`${identity} hotel exterior`, `${identity} hotel lobby`],
    });
    const { slot, plan, data } = await generateWithVisual(original);
    assert.equal(slot.plannerSlotStatus, "locally_repaired", identity);
    assert.equal(slot.plannerLocalRepairs[0].code, "hotel_representative_choice_resolved");
    assert.deepEqual(slot.plannerLocalRepairs[0].allowedCategories.sort(), ["exterior", "main_areas"]);
    assert.equal(slot.queryCore.subject, "酒店代表性空间");
    assert.equal(slot.queryCore.identity, identity);
    assert.equal(slot.exactIdentityRequired, true);
    assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel").needsUserAction, false);
  }
});

test("中性修饰不得吞掉指定房型、私人设施、承诺视野、动作或其他酒店", async () => {
  const identity = "Harbour Azure Hotel";
  const base = hotelVisual({
    primaryVisualSubject: `${identity}的现代都市酒店外观或大堂`,
    queryCore: { subject: "现代都市酒店外观或大堂", action: "", identity, subjectEn: "modern urban hotel exterior or lobby", actionEn: "", identityEn: identity },
    fidelityQuery: `${identity} 酒店外观`, alternateQueries: [`${identity} hotel lobby`],
  });
  for (const [label, patch, details] of [
    ["指定房型", { primaryVisualSubject: `${identity}的现代总统套房或大堂`, queryCore: { ...base.queryCore, subject: "现代总统套房或大堂" } }, {}],
    ["私人设施", { primaryVisualSubject: `${identity}的现代私人泳池或大堂`, queryCore: { ...base.queryCore, subject: "现代私人泳池或大堂" } }, {}],
    ["已订视野", { primaryVisualSubject: `${identity}的现代酒店客房城市景观或酒店外观`, queryCore: { ...base.queryCore, subject: "现代酒店客房或酒店外观", subjectEn: "modern hotel room or hotel exterior" } }, { roomType: "City View Room" }],
    ["其他酒店", { primaryVisualSubject: `${identity}的现代酒店外观或Other Hotel大堂` }, {}],
    ["动作", { queryCore: { ...base.queryCore, action: "住客在大堂办理入住" } }, {}],
    ["身份冲突", { queryCore: { ...base.queryCore, identity: "Other Hotel" } }, {}],
    ["未知修饰", { primaryVisualSubject: `${identity}的私人都市酒店外观或大堂`, queryCore: { ...base.queryCore, subject: "私人都市酒店外观或大堂" } }, {}],
  ]) {
    const { slot } = await generateWithVisual({ ...base, ...patch }, { factHotelName: identity, factHotelDetails: details });
    assert.equal(slot.plannerSlotStatus, "unresolved", label);
    assert.equal(slot.needsUserAction, true, label);
  }
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

test('交通Scope只取该交通项绑定DAY事实，飞机概览普通姿态归一后保持同一检索目标', async () => {
  const original = transportVisual('草原小飞机停靠在简易跑道或飞行中俯瞰大地', {
    location: '', queryCore: { subject: '轻型草原小飞机', action: '飞行', identity: '草原飞机', subjectEn: 'light bush plane', actionEn: 'flying', identityEn: 'bush plane' },
    fidelityQuery: '草原小飞机 飞行', alternateQueries: ['light aircraft savanna flight safari', '轻型飞机 草原 跑道'],
  });
  const transportFacts = { id: 'plane', category: '草原飞机', serviceLevel: '轻型草原飞机', usageSegments: ['DAY 1 甲地 → 乙地'], sourceEvidence: ['DAY 1 用车：轻型草原飞机'] };
  const { slot, plan, data } = await generateWithVisual(original, { transportFacts, routeNodes: ['甲地', '乙地'] });
  assert.equal(slot.plannerSlotStatus, 'locally_repaired');
  assert.equal(slot.location, '肯尼亚');
  assert.equal(slot.locationRole, 'scope_only');
  assert.equal(slot.queryCore.subject, '轻型草原小飞机');
  assert.equal(slot.queryCore.action, '');
  assert.ok(slot.plannerLocalRepairs.some((repair) => repair.code === 'transport_overview_pose_normalized'));
  assert.ok(slot.plannerLocalRepairs.some((repair) => repair.code === 'transport_scope_location_restored'));
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === 'transport').needsUserAction, false);
  const noEvidence = await generateWithVisual(original, { transportFacts: { id: 'plane', category: '草原飞机' }, routeNodes: ['甲地', '乙地'] });
  assert.equal(noEvidence.slot.plannerSlotStatus, 'unresolved');
  const experience = await generateWithVisual({ ...original, primaryVisualSubject: '轻型草原飞机航拍体验在简易跑道或飞行中' }, { transportFacts, routeNodes: ['甲地', '乙地'] });
  assert.equal(experience.slot.plannerSlotStatus, 'unresolved');
});

test('多交通事实的Scope不借用无关DAY地点，歧义路线退到已确认单一目的地', () => {
  const basis = buildAgentFactBasis({ destination: '测试国', days: [
    { routeNodes: ['甲区'] }, { routeNodes: ['乙区', '丙区'] }, { routeNodes: ['无关区'] },
  ], transportSummary: [
    { category: '商务车', usageSegments: ['DAY 1 甲区'] },
    { category: '草原飞机', usageSegments: ['DAY 2 乙区 → 丙区'] },
    { category: '船只', usageSegments: [] },
  ] });
  assert.deepEqual(basis.transport.map((item) => item.scopeLocation), ['甲区', '测试国', null]);
});

test('草原飞机起飞或停靠是交通概览姿态选择，类型与Scope来自绑定事实', async () => {
  const original = transportVisual('草原飞机在简易跑道起飞或停靠', {
    location: '', queryCore: { subject: '草原飞机在简易跑道', action: '起飞或停靠', identity: '', subjectEn: 'bush plane on a dirt airstrip', actionEn: 'taking off or parked', identityEn: '' },
    fidelityQuery: '草原飞机简易跑道', alternateQueries: ['bush plane safari airstrip', '轻型飞机草原起降'],
  });
  const { slot } = await generateWithVisual(original, {
    transportFacts: { category: '草原飞机', serviceLevel: '草原飞机', usageSegments: ['DAY 1 甲地 → 乙地'] }, routeNodes: ['甲地', '乙地'],
  });
  assert.equal(slot.plannerSlotStatus, 'locally_repaired');
  assert.equal(slot.queryCore.subject, '草原飞机');
  assert.equal(slot.queryCore.action, '');
  assert.equal(slot.location, '肯尼亚');
  assert.ok(slot.searchIntent.every((query) => !/起飞或停靠|taking off or parked/i.test(query)));
  const missingRole = await generateWithVisual({ ...original, locationRole: undefined }, {
    transportFacts: { category: '草原飞机', serviceLevel: '草原飞机', usageSegments: ['DAY 1 甲地 → 乙地'] }, routeNodes: ['甲地', '乙地'],
  });
  assert.equal(missingRole.slot.plannerSlotStatus, 'unresolved');
  assert.ok(missingRole.slot.plannerValidationIssues.some((issue) => issue.code === 'image_location_role_invalid'));
});

test('同一草原飞机的常见运动姿态排列可归一，明确动作与异类仍挂起', async () => {
  const facts = { category: '草原飞机', serviceLevel: '草原飞机', usageSegments: ['DAY 1 甲地 → 乙地'] };
  const options = { transportFacts: facts, routeNodes: ['甲地', '乙地'] };
  const make = (visual, action, actionEn = '') => transportVisual(visual, {
    location: '测试国', queryCore: { subject: '草原小飞机', action, identity: '', subjectEn: 'bush plane', actionEn, identityEn: '' },
    fidelityQuery: '草原飞机', alternateQueries: ['bush plane'],
  });
  for (const [visual, action, actionEn] of [
    ['草原小飞机在草原跑道起飞或降落', '在草原跑道起降', 'taking off or landing on bush airstrip'],
    ['草原小飞机降落或起飞', '降落或起飞', 'landing or taking off'],
    ['草原小飞机停靠或起飞', '停靠或起飞', 'parked or taking off'],
    ['草原小飞机飞行中或停靠', '飞行中或停靠', 'flying or parked'],
    ['bush plane taking off or landing', '起飞或降落', 'taking off or landing'],
  ]) {
    const { slot } = await generateWithVisual(make(visual, action, actionEn), options);
    assert.equal(slot.plannerSlotStatus, 'locally_repaired', visual);
    assert.equal(slot.queryCore.action, '', visual);
    assert.ok(slot.searchIntent.every((query) => !/或|\bor\b/i.test(query)), visual);
  }
  for (const [visual, action, dayDescription] of [
    ['草原小飞机起飞或降落', '起飞或降落', '明确安排草原飞机起飞观光体验'],
    ['草原小飞机航拍体验起飞或降落', '起飞或降落', '抵达营地'],
    ['草原小飞机起飞或直升机降落', '起飞或降落', '抵达营地'],
    ['草原小飞机在专属机场起飞或降落', '起飞或降落', '抵达营地'],
    ['草原小飞机起飞或未知场景', '起飞或降落', '抵达营地'],
  ]) {
    const { slot } = await generateWithVisual(make(visual, action), { ...options, dayDescription });
    assert.equal(slot.plannerSlotStatus, 'unresolved', visual);
  }
});

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

test("酒店主图无专属来源时将模型具体房型动作收敛为同店代表空间，DAY事实不变", async () => {
  const hotelName = "Harbour Azure Hotel";
  const original = hotelVisual({
    primaryVisualSubject: `${hotelName}玻璃穹顶房型开启屋顶的观星场景`,
    queryCore: { subject: "玻璃穹顶房型", action: "开启屋顶观星", identity: `${hotelName} 玻璃穹顶房型`, subjectEn: "glass dome room", actionEn: "retracting roof", identityEn: hotelName },
    location: hotelName, fidelityQuery: `${hotelName} 玻璃穹顶房型 观星`,
    alternateQueries: [`${hotelName} glass dome room retractable roof`],
  });
  const dayDescription = "晚间安排观星；资料介绍玻璃穹顶可以开启。";
  const { slot, plan, data, attempts } = await generateWithVisual(original, { factHotelName: hotelName, dayDescription, dayHotel: hotelName });
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.primaryVisualSubject, `${hotelName} 酒店代表性空间`);
  assert.equal(slot.queryCore.subject, "酒店代表性空间");
  assert.equal(slot.queryCore.action, "");
  assert.equal(slot.queryCore.identity, hotelName);
  assert.equal(slot.exactIdentityRequired, true);
  assert.deepEqual(slot.searchIntent, ["酒店外观", "酒店套房", "酒店泳池", "酒店公共空间"]);
  assert.ok(slot.plannerLocalRepairs.some((repair) => repair.code === "hotel_unbound_specific_visual_normalized"));
  assert.deepEqual(attempts[0].rawModelPlan.imagePlan.slots.find((item) => item.role === "hotel:1").queryCore, original.queryCore);
  assert.equal(plan.factBasis.days[0].experience, dayDescription);
  const imageSlot = materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel");
  assert.equal(imageSlot.needsUserAction, false);
  assert.equal(imageSlot.queryCore.identity, hotelName);
});

test("酒店来源明确的特定房型或体验及跨店身份冲突不得被代表空间覆盖", async () => {
  const hotelName = "Harbour Azure Hotel";
  const original = hotelVisual({
    primaryVisualSubject: `${hotelName}玻璃穹顶房型开启屋顶的观星场景`,
    queryCore: { subject: "玻璃穹顶房型", action: "开启屋顶观星", identity: `${hotelName} 玻璃穹顶房型`, subjectEn: "glass dome room", actionEn: "retracting roof", identityEn: hotelName },
    location: hotelName, fidelityQuery: `${hotelName} 玻璃穹顶房型 观星`,
    alternateQueries: [`${hotelName} glass dome room retractable roof`],
  });
  for (const [label, options] of [
    ["已订房型", { factHotelDetails: { roomType: "玻璃穹顶房型" } }],
    ["酒店专属体验", { factHotelDetails: { signatureExperience: "玻璃穹顶房型观星" } }],
    ["酒店选择理由", { factHotelDetails: { selectionReason: "屋顶开启后的观星体验" } }],
    ["酒店绑定DAY事实", { dayDescription: `${hotelName}的玻璃穹顶房型可以开启屋顶观星。` }],
    ["酒店绑定Spot事实", { daySpots: [{ name: `${hotelName}玻璃穹顶房型`, description: "屋顶可以开启观星。" }] }],
  ]) {
    const { slot } = await generateWithVisual(original, { factHotelName: hotelName, ...options });
    assert.equal(slot.plannerSlotStatus, "unresolved", label);
    assert.equal(slot.primaryVisualSubject, original.primaryVisualSubject, label);
    assert.deepEqual(slot.queryCore, original.queryCore, label);
    assert.ok(slot.plannerValidationIssues.some((issue) => issue.code === "hotel_specific_visual_source_unconfirmed"), label);
    assert.ok(!slot.plannerLocalRepairs.some((repair) => repair.code === "hotel_unbound_specific_visual_normalized"), label);
  }
  const other = await generateWithVisual({ ...original, primaryVisualSubject: `${hotelName}和Other Hotel的玻璃穹顶房型` }, { factHotelName: hotelName });
  assert.equal(other.slot.plannerSlotStatus, "unresolved");
  assert.equal(other.slot.primaryVisualSubject, `${hotelName}和Other Hotel的玻璃穹顶房型`);
});

test("另一DAY的酒店观景体验不证明本酒店摄影承诺，普通空间目标局部归一", async () => {
  for (const [hotelName, subject, action, visual, dayDescription] of [
    ["Angama Amboseli", "营地公共区域外观", "面向雪山方向", "营地公共区域外观面向雪山方向", "抵达Angama Amboseli；另一天安排专属乞力马扎罗观景台体验。"],
    ["Saruni Leopard Hill", "营地帐篷外观", "立于草原环境", "营地帐篷外观立于草原环境", "入住Saruni Leopard Hill营地，随后在Naboisho参加草原游猎。"],
  ]) {
    const original = hotelVisual({ primaryVisualSubject: `${hotelName}${visual}`,
      queryCore: { subject, action, identity: hotelName, subjectEn: "", actionEn: "", identityEn: hotelName },
      location: hotelName, locationRole: "visual_identity", fidelityQuery: `${hotelName} ${subject}`,
      alternateQueries: [`${hotelName} exterior`] });
    const { slot, plan, data } = await generateWithVisual(original, { factHotelName: hotelName, dayDescription, dayHotel: hotelName,
      factHotelDetails: { selectionReason: "出行衔接便利", signatureExperience: "已确认的私人晚餐" } });
    assert.equal(slot.plannerSlotStatus, "locally_repaired", hotelName);
    assert.equal(slot.queryCore.subject, "酒店代表性空间");
    assert.equal(slot.queryCore.identity, hotelName);
    assert.equal(slot.exactIdentityRequired, true);
    assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel").needsUserAction, false);
  }
});

test("酒店公共区域与外观同属代表空间，具体设施景观和互斥动物仍未决", async () => {
  const hotelName = "JW Marriott Hotel Nairobi";
  const ordinary = hotelVisual({ primaryVisualSubject: `${hotelName}酒店外观或大堂公共区域`,
    queryCore: { subject: "酒店公共区域", action: "", identity: hotelName, subjectEn: "hotel public area", actionEn: "", identityEn: hotelName },
    fidelityQuery: `${hotelName} hotel exterior`, alternateQueries: [`${hotelName} hotel lobby`] });
  const { slot } = await generateWithVisual(ordinary, { factHotelName: hotelName });
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.queryCore.subject, "酒店代表性空间");
  assert.deepEqual(slot.plannerLocalRepairs[0].allowedCategories.sort(), ["exterior", "main_areas"]);
  const promised = await generateWithVisual({ ...ordinary, primaryVisualSubject: `${hotelName}私人泳池或肯尼亚山景客房`,
    queryCore: { ...ordinary.queryCore, subject: "私人泳池或肯尼亚山景客房" } }, { factHotelName: hotelName });
  assert.equal(promised.slot.plannerSlotStatus, "unresolved");
  const day = await planDaySubject("草原上猎豹或狮群的追踪画面", ["猎豹追踪", "狮群追踪"], {
    dayDescription: "在马赛马拉草原追踪猎豹或狮群",
    queryCore: { subject: "猎豹或狮群", action: "草原上追踪", identity: "", subjectEn: "cheetah or lion pride", actionEn: "tracking", identityEn: "" },
  });
  assert.equal(day.slot.plannerSlotStatus, "unresolved");
  assert.ok(day.slot.plannerValidationIssues.some((issue) => issue.code === "ambiguous_visual_subject"));
});

test("酒店泳池与公共空间复合Core不能由另一DAY可选池畔晚餐归一放行", async () => {
  const hotelName = "Example Safari Camp";
  const dayDescription = "亦可体验瑜伽、水疗与泳池边晚餐。";
  const original = hotelVisual({ primaryVisualSubject: `${hotelName}泳池与公共空间外观并呈现山景`,
    location: hotelName, locationRole: "visual_identity", exactIdentityRequired: true,
    queryCore: { subject: "泳池与公共空间外观", action: "", identity: hotelName,
      subjectEn: "pool and public space exterior", actionEn: "", identityEn: hotelName },
    fidelityQuery: `${hotelName} pool mountain view`, alternateQueries: [`${hotelName} public space`] });
  const { slot, plan, data } = await generateWithVisual(original, { factHotelName: hotelName, dayDescription, dayHotel: hotelName });
  assert.equal(slot.plannerSlotStatus, "unresolved");
  assert.equal(slot.needsUserAction, true);
  assert.deepEqual(slot.queryCore, original.queryCore);
  assert.equal(slot.exactIdentityRequired, true);
  assert.ok(slot.plannerValidationIssues.some((issue) => issue.code === "hotel_specific_visual_source_unconfirmed"));
  assert.ok(!slot.plannerLocalRepairs.some((repair) => repair.code === "hotel_unbound_specific_visual_normalized"));
  assert.equal(plan.factBasis.days[0].experience, dayDescription);
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.moduleType === "hotel").needsUserAction, true);
});

test("普通单一酒店空间无需专属来源也不会降级为泛代表图", async () => {
  for (const [hotelName, subject, visual] of [
    ["Open Savanna Camp", "帐篷营地开放式休息区", "Open Savanna Camp营地的开放式公共休息区"],
    ["The Meridian Lodge", "奢华帐篷套房内部", "The Meridian Lodge的奢华帐篷套房内部"],
    ["Harbour Azure Hotel", "酒店建筑外观", "酒店建筑外观"],
  ]) {
    const original = hotelVisual({ primaryVisualSubject: visual, queryCore: { subject, action: "", identity: hotelName },
      location: hotelName, fidelityQuery: `${hotelName} ${subject}`, alternateQueries: [`${hotelName} hotel exterior`] });
    const { slot } = await generateWithVisual(original, { factHotelName: hotelName });
    assert.ok(["ready", "locally_repaired"].includes(slot.plannerSlotStatus), hotelName);
    assert.equal(slot.primaryVisualSubject, original.primaryVisualSubject);
    assert.deepEqual(slot.queryCore, original.queryCore);
    assert.ok(!slot.plannerValidationIssues.some((issue) => issue.code.startsWith("hotel_specific_visual_")));
  }
});

test("Planner事实基座把对象亮点转换为显示文本", () => {
  const facts = buildAgentFactBasis({ highlights: [{ title: "私家行程", description: "按专属节奏深入" }, "自然观察"], days: [] });
  assert.deepEqual(facts.coreExperiences, ["私家行程：按专属节奏深入", "自然观察"]);
});

async function planDaySubject(visual, queries, { dayDescription = "在草原观察羚羊与斑马", queryCore = null, location = "测试保护区" } = {}) {
  const data = { destination: location, days: [{ route: location, description: dayDescription, spots: [{ name: "草原观察", description: dayDescription, status: "included" }] }] };
  const factBasis = buildAgentFactBasis(data);
  let calls = 0;
  let systemPrompt = "";
  const result = await generateAgentPlan({
    project: { projectId: "single-subject-contract", inputFingerprint: "fixture", factBasis, planIds: [] },
    simpleSkillContract: true,
    requestJson: async (options) => {
      calls += 1;
      systemPrompt = options.messages[0].content;
      const response = await plannerRequestJson({ delayMs: 0 })(options);
      const day = response.json.imagePlan.slots.find((item) => item.role === "day:1");
      Object.assign(day, { primaryVisualSubject: visual, queryCore: queryCore || { subject: "羚羊", action: "行走", identity: "", subjectEn: "antelope", actionEn: "walking", identityEn: "" }, fidelityQuery: queries[0], alternateQueries: queries.slice(1), location, locationRole: "scope_only", exactIdentityRequired: false, sourceRefs: ["days.0.spots.0"] });
      response.json.dayRoles[0].primaryVisualSubject = "草原羚羊行走";
      return response;
    },
  });
  assert.equal(calls, 1, "业务规划仍只调用一次");
  return { ...result, data, systemPrompt, slot: result.plan.imagePlan.slots.find((item) => item.role === "day:1") };
}

test("DAY主图在单次规划中选定主体并使全部Query保持同一画面", async () => {
  const { slot, systemPrompt, plan, data } = await planDaySubject("草原羚羊行走", ["羚羊行走", "antelope walking"]);
  assert.match(systemPrompt, /唯一一个Core主体/);
  assert.match(systemPrompt, /alternateQueries只能改用同一目标/);
  assert.match(systemPrompt, /dayRoles的主视觉与对应day:N主图必须一致/);
  assert.match(systemPrompt, /设备、光源、特定设施或动物必须能由sourceRefs指向的原始事实支持/);
  assert.equal(slot.plannerSlotStatus, "ready");
  assert.equal(slot.needsUserAction, false);
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.slotId === "image:day:1:primary").needsUserAction, false);
});

test("DAY不同主体二选一与跨分支Query保留未解决并记录冲突", async () => {
  const { slot, plan, data } = await planDaySubject("草原上羚羊或斑马的游猎画面", ["羚羊行走", "antelope walking", "斑马奔跑"]);
  assert.equal(slot.plannerSlotStatus, "unresolved");
  assert.equal(slot.needsUserAction, true);
  assert.ok(slot.plannerValidationIssues.some((issue) => issue.code === "ambiguous_visual_subject"));
  assert.ok(slot.plannerValidationIssues.some((issue) => issue.code === "visual_query_branch_conflict" && /斑马奔跑/.test(issue.message)));
  assert.ok(!slot.plannerLocalRepairs.some((repair) => repair.code === "equivalent_visual_choice_resolved"));
  assert.equal(materializeSimpleSkillPlan({ data, agentPlan: plan }).imageSlots.find((item) => item.slotId === "image:day:1:primary").needsUserAction, true);
  const sameQueries = await planDaySubject("草原上羚羊或斑马的游猎画面", ["羚羊行走", "antelope walking"]);
  assert.equal(sameQueries.slot.plannerSlotStatus, "unresolved", "没有跨分支Query也不能由程序替Planner选羚羊");
  assert.ok(!sameQueries.slot.plannerValidationIssues.some((issue) => issue.code === "visual_query_branch_conflict"));
});

test("D3跨主体alternate清洗Scope后仍挂起该位，其他图片位与Copy继续", async () => {
  const { slot, plan, data, attempts } = await planDaySubject(
    "狮群或花豹",
    ["马赛马拉 草原狮群", "马赛马拉 草原行进", "马拉草原 花豹游猎"],
    { location: "马赛马拉", dayDescription: "在马赛马拉草原观察狮群或花豹", queryCore: { subject: "草原狮群", action: "草原行进", identity: "" } },
  );
  assert.equal(attempts.length, 1);
  assert.equal(plan.validation.plannerBusinessRuns, 1);
  assert.equal(slot.exactIdentityRequired, false);
  assert.equal(slot.plannerSlotStatus, "unresolved");
  assert.equal(slot.needsUserAction, true);
  assert.ok(slot.plannerValidationIssues.some((issue) => issue.code === "ambiguous_visual_subject"));
  assert.equal(slot.alternateQueries.some((query) => /花豹/.test(query)), true, "不能丢掉另一主体以伪造同一Core");
  assert.ok(!slot.plannerLocalRepairs.some((repair) => repair.code === "equivalent_visual_choice_resolved"));
  const runtime = materializeSimpleSkillPlan({ data, agentPlan: plan });
  assert.equal(runtime.imageSlots.find((item) => item.slotId === "image:day:1:primary").needsUserAction, true);
  assert.ok(runtime.imageSlots.some((item) => item.moduleType === "cover" && !item.needsUserAction));
  assert.ok(runtime.copyTasks.length > 0);
});

test("同一Core的Scope词可局部清洗，保留主体动作并允许搜索", async () => {
  const core = { subject: "草原狮群", action: "行进", identity: "" };
  const { slot } = await planDaySubject(
    "草原狮群行进",
    ["马赛马拉 草原狮群行进", "马赛马拉 狮群行进"],
    { location: "马赛马拉", dayDescription: "在马赛马拉草原观察行进的狮群", queryCore: core },
  );
  assert.equal(slot.plannerSlotStatus, "locally_repaired");
  assert.equal(slot.needsUserAction, false);
  assert.deepEqual(slot.queryCore, core);
  assert.ok([slot.fidelityQuery, ...slot.alternateQueries].every((query) => !query.includes("马赛马拉")));
  assert.ok([slot.fidelityQuery, ...slot.alternateQueries].length >= 2);
});


test("canonical hotel representative Core accepts neutral lodging presentation in both search entry points", async () => {
  const { prepareExplicitImageSearchSlot } = await import("../server/manual-image-search-target.mjs");
  for (const type of ["度假酒店", "营地酒店", "帐篷营地酒店", "酒店"]) {
    const identity = "Synthetic Savannah Lodge";
    const original = hotelVisual({ location: identity, locationRole: "scope_only",
      primaryVisualSubject: `${identity} ${type}的代表性空间或外观`,
      queryCore: { subject: "酒店代表性空间", subjectEn: "representative hotel space", action: "", actionEn: "", identity, identityEn: identity } });
    const { slot, plan, data } = await generateWithVisual(original);
    assert.equal(slot.needsUserAction, false, type);
    assert.equal(slot.queryCore.identity, identity);
    const simple = materializeSimpleSkillPlan({ data, agentPlan: plan });
    const target = simple.imageSlots.find(item => item.moduleType === "hotel");
    const legacy = { ...target, ...original, plannerSlotStatus: "unresolved", needsUserAction: true,
      plannerValidationIssues: [{ code: "ambiguous_visual_subject" }] };
    const before = structuredClone(legacy);
    const manual = prepareExplicitImageSearchSlot(legacy, { plan: simple });
    assert.equal(manual.needsUserAction, false, `manual ${type}`);
    assert.deepEqual(manual.queryCore, slot.queryCore);
    assert.deepEqual(legacy, before);
    const wrong = prepareExplicitImageSearchSlot(legacy, { plan: { ...simple, slotBindings: {} } });
    assert.equal(wrong.needsUserAction, true);
  }
});

test("airport transfer backgrounds keep the complete passenger action for automatic and manual queries", async () => {
  const { prepareExplicitImageSearchSlot } = await import("../server/manual-image-search-target.mjs");
  const original = { role: "transport:1", location: "坦桑尼亚", locationRole: "scope_only", exactIdentityRequired: false,
    primaryVisualSubject: "商务用车在乞力马扎罗机场或阿鲁沙接送乘客",
    queryCore: { subject: "商务用车", action: "接送乘客", identity: "", subjectEn: "business car", actionEn: "picking up passengers", identityEn: "" },
    fidelityQuery: "商务用车 机场接送", alternateQueries: ["business car airport transfer", "坦桑尼亚 商务接送"], sourceRefs: ["transport.0"] };
  const { slot } = await generateWithVisual(original);
  assert.equal(slot.needsUserAction, false);
  assert.deepEqual(slot.queryCore, original.queryCore);
  const manual = prepareExplicitImageSearchSlot({ ...original, plannerSlotStatus: "unresolved", needsUserAction: true,
    plannerValidationIssues: [{ code: "ambiguous_visual_subject" }, { code: "scope_only_location_in_query" }] });
  assert.equal(manual.needsUserAction, false);
  assert.deepEqual(manual.queryCore, slot.queryCore);
  assert.deepEqual(manual.searchIntent, slot.searchIntent);
});

test("ordinary bush airfield poses do not block a fact-bound flight overview", async () => {
  const original = { role: "transport:1", location: "坦桑尼亚", locationRole: "scope_only", exactIdentityRequired: false,
    primaryVisualSubject: "草原飞机在塞伦盖蒂草原机场起降或停靠",
    queryCore: { subject: "草原飞机", action: "起降", identity: "", subjectEn: "bush plane", actionEn: "taking off or landing", identityEn: "" },
    fidelityQuery: "草原飞机起降", alternateQueries: ["bush plane airstrip"], sourceRefs: ["transport.0"] };
  const context = { transportFacts: { category: "草原飞机", usageSegments: ["DAY 1 阿鲁沙 → 塞伦盖蒂"] }, dayDescription: "乘草原飞机前往营地" };
  const { slot } = await generateWithVisual(original, context);
  assert.equal(slot.needsUserAction, false);
  assert.equal(slot.queryCore.action, "");
  const promised = await generateWithVisual(original, { ...context, dayDescription: "体验草原飞机降落" });
  assert.equal(promised.slot.needsUserAction, true);
});
