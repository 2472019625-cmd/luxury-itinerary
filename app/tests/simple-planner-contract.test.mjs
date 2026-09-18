import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentFactBasis, fillPlannerImageDeterministicFields, validateSimpleHighlightSelection, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { materializeSimpleSkillPlan, normalizeNonDayPlannerImageRoles } from "../server/simple-plan-adapter.mjs";
import { plannerRequestJson } from './helpers/simple-pipeline-fixture.mjs';

test('Planner请求统一视觉覆盖规则和一基DAY编号，保留丰富日辅助槽', async () => {
  const factBasis = buildAgentFactBasis({ destination: '肯尼亚', days: [{ description: '大象雪山，Observation Hill，步行Safari，夜间游猎' }, { description: '简单送机' }] });
  const result = await generateAgentPlan({ project: { projectId: 'visual-contract', inputFingerprint: 'test', factBasis }, simpleSkillContract: true, requestJson: async options => {
    const system = options.messages.filter(m => m.role === 'system');
    assert.equal(system.length, 1);
    assert.match(system[0].content, /多个明确、差异化、高价值体验时必须选择2—4个/);
    assert.match(system[0].content, /独家或稀缺体验/);
    assert.match(system[0].content, /普通全天、清晨、傍晚游猎只在没有更高价值真实视觉时作为兜底/);
    assert.match(system[0].content, /不绑定国家、项目或DAY/);
    assert.match(system[0].content, /fidelityQuery/);
    assert.match(system[0].content, /alternateQueries/);
    assert.match(system[0].content, /locationRole/);
    assert.match(system[0].content, /queryCore/);
    assert.match(system[0].content, /Planner是图片画面的唯一决定者/);
    assert.match(system[0].content, /每份行程只调用一次 Planner/);
    assert.match(system[0].content, /不要输出slotId、label、required或removable/);
    assert.doesNotMatch(system[0].content, /correction pass/);
    assert.match(system[0].content, /同义表达不得因文字差异被改写/);
    assert.match(system[0].content, /scope_only时地点和目录身份不得进入任何Query/);
    assert.match(system[0].content, /不得针对国家、动物、酒店、景点或当前案例建立专用词表/);
    assert.match(system[0].content, /DAY2: dayRoles.index=1; imagePlan主图role=day:2/);
    const response = await plannerRequestJson({ delayMs: 0 })(options);
    const supportingQueries = [["观景山", "山顶观景"], ["步行游猎", "丛林徒步"], ["夜间游猎", "夜间驱车游猎"]];
    response.json.imagePlan.slots.push(...['Observation Hill', '步行Safari', '夜间游猎'].map((subject, i) => ({
      slotId: `extra-${i}`,
      role: `day:1:supporting:${i+1}`,
      required: false,
      removable: true,
      primaryVisualSubject: subject,
      label: subject,
      visualDuty: '当天独立体验',
      differentiation: subject,
      location: '安博塞利',
      locationRole: i === 0 ? 'visual_identity' : 'scope_only',
      queryCore: { subject, action: '', identity: i === 0 ? 'Observation Hill' : '' },
      fidelityQuery: supportingQueries[i][0],
      alternateQueries: [supportingQueries[i][1]],
    })));
    return response;
  } });
  assert.equal(result.plan.imagePlan.slots.filter(s => /^day:1(?:$|:)/.test(s.role)).length, 4);
  assert.equal(result.plan.imagePlan.slots.filter(s => /^day:2(?:$|:)/.test(s.role)).length, 1);
});

test("Planner不写图片位确定性字段时程序按role补齐，视觉、Query和来源不变", () => {
  const slot = {
    role: "day:2:supporting:1",
    primaryVisualSubject: "向导带游客徒步观察斑马",
    visualDuty: "展示步行观察方式",
    differentiation: "区别于车上游猎",
    location: "示例保护区",
    locationRole: "scope_only",
    queryCore: { subject: "向导与游客", action: "徒步观察", identity: "" },
    fidelityQuery: "向导带队徒步",
    alternateQueries: ["徒步观察斑马", "guided walking safari"],
    sourceRefs: ["days.1.spots.2"],
  };
  const result = fillPlannerImageDeterministicFields({ imagePlan: { slots: [slot] } }, { days: [{}, {}] });
  assert.deepEqual(result.imagePlan.slots[0], {
    slotId: "planner:day:2:supporting:1",
    label: "DAY 2 辅助视觉 1",
    required: false,
    removable: true,
    ...slot,
  });
  assert.deepEqual(result.imagePlan.slots[0].queryCore, slot.queryCore);
  assert.deepEqual(result.imagePlan.slots[0].alternateQueries, slot.alternateQueries);
  assert.deepEqual(result.imagePlan.slots[0].sourceRefs, slot.sourceRefs);
});

test("非DAY图片位只按sourceRefs归一化为一基role并保留稳定slotId与来源", () => {
  const data = {
    destination: "肯尼亚",
    title: "测试行程",
    hotels: [
      { id: "angama", officialName: "Angama Amboseli", region: "安博塞利" },
      { id: "ritz", officialName: "The Ritz-Carlton, Masai Mara Safari Camp", region: "马赛马拉" },
    ],
    diningExperiences: [
      { id: "sundowner", title: "Sundowner", location: "安博塞利" },
      { id: "dinner", title: "星空晚宴", location: "马赛马拉" },
    ],
    transportSummary: [
      { id: "business-van", category: "商务用车" },
      { id: "safari-vehicle", category: "四驱越野车" },
    ],
    days: [],
    notes: [],
  };
  const makeSlot = (role, sourceRef, subject) => ({
    role,
    sourceRefs: [sourceRef],
    primaryVisualSubject: subject,
    visualDuty: `展示${subject}`,
    location: "肯尼亚",
    locationRole: "scope_only",
    queryCore: { subject },
    fidelityQuery: subject,
    alternateQueries: [`${subject} 细节`],
  });
  const agentPlan = { selectedHighlights: [], imagePlan: { slots: [
    makeSlot("hotel:0", "hotels[0]", "Angama帐篷外观"),
    makeSlot("hotel:1", "hotels[1]", "Ritz公共休息区"),
    makeSlot("dining:0", "diningExperiences[0]", "落日酒会举杯"),
    makeSlot("dining:1", "diningExperiences[1]", "星空晚宴餐桌"),
    makeSlot("transport:0", "transport[0]", "商务车接机"),
    makeSlot("transport:1", "transport[1]", "四驱越野车游猎"),
  ] }, modules: [], dayRoles: [] };
  const normalized = normalizeNonDayPlannerImageRoles(agentPlan, data);
  assert.deepEqual(normalized.imagePlan.slots.map((slot) => slot.role), ["hotel:1", "hotel:2", "dining:1", "dining:2", "transport:1", "transport:2"]);
  const runtime = materializeSimpleSkillPlan({ data, report: {}, agentPlan });
  const moduleSlots = runtime.imageSlots.filter((slot) => ["hotel", "dining", "transport"].includes(slot.moduleType));
  assert.deepEqual(moduleSlots.map((slot) => slot.slotId), [
    "image:hotel:angama:primary", "image:hotel:ritz:primary",
    "image:dining:sundowner:primary", "image:dining:dinner:primary",
    "image:transport:business-van:primary", "image:transport:safari-vehicle:primary",
  ]);
  assert.deepEqual(moduleSlots.map((slot) => slot.primaryVisualSubject), [
    "Angama帐篷外观", "Ritz公共休息区", "落日酒会举杯", "星空晚宴餐桌", "商务车接机", "四驱越野车游猎",
  ]);
  assert.deepEqual(moduleSlots.map((slot) => slot.sourceEvidence), [
    ["hotels[0]"], ["hotels[1]"], ["diningExperiences[0]"], ["diningExperiences[1]"], ["transport[0]"], ["transport[1]"],
  ]);
  assert.ok(moduleSlots.every((slot) => slot.fidelityQuery && slot.alternateQueries.length === 1));
});

test("Planner 校验失败只调用一次，并对可确定修复的 Query 做局部修复", async () => {
  const factBasis = buildAgentFactBasis({
    destination: "肯尼亚",
    days: [{ region: "安博塞利", description: "湿地象群观察" }, { region: "内罗毕", description: "乘车送机" }],
  });
  let calls = 0;
  const fixture = plannerRequestJson({ delayMs: 0 });
  const result = await generateAgentPlan({
    project: { projectId: "single-call-query-repair", inputFingerprint: "test", factBasis, planIds: [] },
    simpleSkillContract: true,
    requestJson: async (options) => {
      calls += 1;
      const response = await fixture(options);
      const target = response.json.imagePlan.slots.find((slot) => slot.role === "day:1");
      target.location = "安博塞利";
      target.locationRole = "scope_only";
      target.queryCore = { subject: "湿地象群", action: "观察", identity: "", subjectEn: "wetland elephants", actionEn: "", identityEn: "" };
      target.primaryVisualSubject = "安博塞利清晨从观景点观察湿地象群，以证明当天核心体验";
      target.fidelityQuery = "安博塞利清晨从观景点观察湿地象群，以证明当天核心体验";
      target.alternateQueries = [];
      return response;
    },
  });
  const repaired = result.plan.imagePlan.slots.find((slot) => slot.role === "day:1");
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.plan.validation.correctionUsed, false);
  assert.equal(result.plan.validation.plannerModelCalls, 1);
  assert.equal(repaired.plannerSlotStatus, "locally_repaired");
  assert.equal(repaired.needsUserAction, false);
  assert.ok([repaired.fidelityQuery, ...repaired.alternateQueries].length >= 2);
  assert.ok([repaired.fidelityQuery, ...repaired.alternateQueries].every((query) => !query.includes("安博塞利") && !query.includes("证明当天")));
});

test("无法可靠修复的重复画面只标记冲突 Slot，不重新调用 Planner", async () => {
  const factBasis = buildAgentFactBasis({
    destination: "肯尼亚",
    days: [{ region: "地区甲", description: "野生动物观察" }, { region: "地区乙", description: "另一日野生动物观察" }],
  });
  let calls = 0;
  const fixture = plannerRequestJson({ delayMs: 0 });
  const result = await generateAgentPlan({
    project: { projectId: "single-call-duplicate", inputFingerprint: "test", factBasis, planIds: [] },
    simpleSkillContract: true,
    requestJson: async (options) => {
      calls += 1;
      const response = await fixture(options);
      const first = response.json.imagePlan.slots.find((slot) => slot.role === "day:1");
      const second = response.json.imagePlan.slots.find((slot) => slot.role === "day:2");
      second.primaryVisualSubject = first.primaryVisualSubject;
      second.queryCore = { ...first.queryCore };
      second.fidelityQuery = first.fidelityQuery;
      second.alternateQueries = [...first.alternateQueries];
      return response;
    },
  });
  const first = result.plan.imagePlan.slots.find((slot) => slot.role === "day:1");
  const second = result.plan.imagePlan.slots.find((slot) => slot.role === "day:2");
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(first.plannerSlotStatus, "ready");
  assert.equal(second.plannerSlotStatus, "unresolved");
  assert.equal(second.needsUserAction, true);
  assert.ok(second.plannerValidationIssues.some((item) => item.code === "duplicate_visual_responsibility"));
});

test("Planner 事实基座拆分原海报亮点并注入已确认奢游产品价值", () => {
  const facts = buildAgentFactBasis({
    destination: "坦桑尼亚",
    sourcePosterHighlights: ["Singita连住\n私人保护区徒步/夜游\n庄园帐篷双奢\n全程一价全包"],
    days: [],
  });
  assert.deepEqual(facts.sourcePosterHighlights, ["Singita连住", "私人保护区徒步/夜游", "庄园帐篷双奢", "全程一价全包"]);
  assert.ok(facts.officialProductValues.some((item) => item.sourceText.includes("一家一团")));
  assert.ok(facts.officialProductValues.some((item) => item.sourceText.includes("1V1")));
  const valid = {
    selectedHighlights: [
      ...facts.sourcePosterHighlights.map((sourceText) => ({ sourceText, sourceType: "source_designated" })),
      { sourceText: facts.officialProductValues[0].sourceText, sourceType: "official_product" },
    ],
  };
  assert.deepEqual(validateSimpleHighlightSelection(valid, facts), []);
});

test("热气球 DAY 体验不能伪装为 official_product，且不能越过正式服务候选", () => {
  const facts = buildAgentFactBasis({ destination: "坦桑尼亚", sourcePosterHighlights: ["Singita连住"], days: [{ description: "自费热气球 Safari", spots: [] }] });
  const errors = validateSimpleHighlightSelection({ selectedHighlights: [{ sourceText: "自费升级热气球Safari", sourceType: "official_product" }] }, facts);
  assert.ok(errors.some((item) => item.code === "official_product_untraceable"));
  assert.ok(errors.some((item) => item.code === "official_product_priority_missing"));
});

test("原海报指定亮点不能被低优先级候选越过，单DAY体验不能直接抬升", () => {
  const facts = buildAgentFactBasis({ destination: "坦桑尼亚", sourcePosterHighlights: ["Singita连住\n私人保护区徒步/夜游"], days: [] });
  const errors = validateSimpleHighlightSelection({ selectedHighlights: [
    { sourceText: "Singita连住", sourceType: "source_designated" },
    ...facts.officialProductValues.map((item) => ({ sourceText: item.sourceText, sourceType: "official_product" })),
    { sourceText: "自费热气球", sourceType: "planner_derived", sourceRefs: ["days.3.spots.1"] },
  ] }, facts);
  assert.ok(errors.some((item) => item.code === "source_highlight_priority_missing"));
  assert.ok(errors.some((item) => item.code === "ordinary_day_highlight_promoted"));
});
