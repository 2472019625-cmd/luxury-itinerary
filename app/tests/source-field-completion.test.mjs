import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import { materializeSimpleSkillPlan } from "../server/simple-plan-adapter.mjs";
import { applySimpleSkillResults } from "../server/simple-pipeline-writeback.mjs";
import { runCopyWriterSkill } from "../server/simple-copy-skill.mjs";

function workbookFile(rows, { merges = [], name = "字段补齐测试.xlsx" } = {}) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!merges"] = merges.map((range) => XLSX.utils.decode_range(range));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "行程");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
  return {
    name,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function itineraryRows(dayRows = []) {
  return [
    ["肯尼亚3日行程"],
    ["天数", "简要行程", "详细行程", "用餐", "酒店", "交通"],
    ...dayRows,
  ];
}

function agentPlanFor(data) {
  return {
    projectId: "source-field-test",
    selectedHighlights: [],
    modules: [
      { moduleId: "dining", decision: data.diningExperiences?.length ? "show" : "hide", contentAction: data.diningExperiences?.length ? "optimize" : "hide" },
      { moduleId: "hotels", decision: "hide", contentAction: "hide" },
      { moduleId: "transport", decision: "hide", contentAction: "hide" },
      { moduleId: "days", decision: "show", contentAction: "optimize" },
      { moduleId: "notes", decision: "show", contentAction: "optimize" },
      { moduleId: "expenses", decision: "show", contentAction: "preserve" },
    ],
    dayRoles: (data.days || []).map((_day, index) => ({ index, role: `DAY ${index + 1} 真实体验`, differenceFromAdjacent: "按当天事实区分", contentAction: "optimize" })),
    imagePlan: { visualStory: "仅用于字段契约测试", slots: [] },
  };
}

test("费用 Parser 支持合并标题、标题下一行、编号多行、包含/不含/取消和起售价", async () => {
  const rows = [
    ...itineraryRows([["D1", "内罗毕", "抵达休整", "酒店晚餐", "Test Hotel", "商务车"]]),
    ["起售价：83,880元/人起"],
    ["报价包含：\n1. 酒店住宿\n2. 行程所列交通"],
    ["费用不含", "1）国际机票\n2）个人消费"],
    ["退改政策"],
    ["1. 出发前取消按合同约定执行"],
  ];
  const result = await importItineraryWorkbook(workbookFile(rows, { merges: ["A4:F4", "A5:F5"] }), {});
  assert.equal(result.data.totalPrice, 83880);
  assert.deepEqual(result.data.included, ["酒店住宿", "行程所列交通"]);
  assert.deepEqual(result.data.excluded, ["国际机票", "个人消费"]);
  assert.deepEqual(result.data.cancellation, ["出发前取消按合同约定执行"]);
});

test("费用 Parser 支持标题与内容分列、中文英文冒号和无编号逐行条目", async () => {
  const rows = [
    ...itineraryRows([["D1", "内罗毕", "抵达休整", "酒店晚餐", "Test Hotel", "商务车"]]),
    ["费用包含：", "住宿"],
    ["", "用车"],
    ["报价不包含:", "国际机票"],
    ["", "个人消费"],
    ["取消政策：", "以双方签署合同为准"],
  ];
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.deepEqual(result.data.included, ["住宿", "用车"]);
  assert.deepEqual(result.data.excluded, ["国际机票", "个人消费"]);
  assert.deepEqual(result.data.cancellation, ["以双方签署合同为准"]);
});

test("多档价格保留逐档证据，不合并金额，明确海报起售价优先于标题近似价", async () => {
  const rows = [
    ["肯尼亚8日顶奢（8.4W起）"],
    ["海报价格写83,880元/人，8.01-10.15出发补差价15,000元/人"],
    ["人数", "行程", "价格（元）", "有效期", "成本", "利润"],
    ["2人", "8天7晚", 98880, "2026.08.01-2026.10.14", 88130, 10750],
    ["2人", "8天7晚", 83880, "2026.10.15-2026.10.30", 73640, 10240],
    ["天数", "简要行程", "详细行程", "用餐", "酒店", "交通"],
    ["D1", "内罗毕", "抵达休整", "酒店晚餐", "Test Hotel", "商务车"],
  ];
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.equal(result.data.totalPrice, 83880);
  assert.deepEqual(result.data.priceNotes, ["8.01-10.15出发补差价15,000元/人"]);
  assert.deepEqual(result.data.sourceImportCoverage.priceOffers.map((item) => item.amount), [98880, 83880]);
  assert.deepEqual(result.data.sourceImportCoverage.priceOffers.map((item) => item.period), ["2026.08.01-2026.10.14", "2026.10.15-2026.10.30"]);
  assert.match(result.report.warnings.join("\n"), /现有 totalPrice/);
});

test("内部成本列不会进入客户价格或费用字段", async () => {
  const rows = [
    ...itineraryRows([["D1", "内罗毕", "抵达休整", "酒店晚餐", "Test Hotel", "商务车"]]),
    ["人数", "价格（元）", "成本", "底价", "利润"],
    ["2人", 83880, 70000, 68000, 13880],
    ["报价包含", "1. 住宿"],
  ];
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  const customer = JSON.stringify({ totalPrice: result.data.totalPrice, priceNotes: result.data.priceNotes, included: result.data.included, excluded: result.data.excluded, cancellation: result.data.cancellation });
  assert.doesNotMatch(customer, /70000|68000|13880|成本|底价|利润/);
  assert.ok(result.report.cellCoverage.some((item) => item.raw === "70000" && item.disposition === "internal_retained"));
});

test("Cell Coverage 将费用与价格标为 customer_field，不再误归入 DAY", async () => {
  const rows = [
    ...itineraryRows([["D1", "内罗毕", "抵达休整", "酒店晚餐", "Test Hotel", "商务车"]]),
    ["海报价格写83,880元/人"],
    ["报价包含"],
    ["1. 酒店住宿"],
    ["报价不包含"],
    ["1. 国际机票"],
  ];
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  const affected = result.report.cellCoverage.filter((item) => /83,880|报价包含|酒店住宿|报价不包含|国际机票/.test(item.raw));
  assert.ok(affected.length >= 5);
  assert.ok(affected.every((item) => item.disposition === "customer_field"));
  assert.ok(affected.every((item) => !String(item.target).startsWith("days[]")));
});

test("特色餐饮识别 Bush Breakfast、Sundowner、星空晚宴并过滤酒店早餐和午餐盒", async () => {
  const rows = itineraryRows([
    ["D1", "马赛马拉", "特别体验：Bush Breakfast 丛林早餐；傍晚享用 Sundowner 落日酒会。", "酒店早餐\n午餐盒\n酒店晚餐", "Safari Camp", "游猎车"],
    ["D2", "马赛马拉", "晚间安排星空晚宴。", "酒店早餐\n午餐盒\n酒店晚餐", "Safari Camp", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.deepEqual(result.data.diningExperiences.map((item) => item.title), ["Bush Breakfast 丛林早餐", "Sundowner 落日酒会", "星空晚宴"]);
  assert.ok(result.data.diningExperiences.every((item) => !/酒店早餐|午餐盒/.test(item.title)));
});

test("同一 DAY 的 Dining 跨详细行程和用餐字段合并，附属于主体验的餐食不独立成卡", async () => {
  const rows = itineraryRows([
    ["D1", "Naboisho", "可自费参加热气球之旅（含香槟早餐）。特别体验：Sundowner 落日酒会。", "香槟早餐\nSundowner 落日酒会", "Safari Camp", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  const sundowner = result.data.diningExperiences.filter((item) => item.title === "Sundowner 落日酒会");
  assert.equal(result.data.diningExperiences.some((item) => item.title === "香槟早餐"), false);
  assert.equal(sundowner.length, 1);
  assert.deepEqual(sundowner[0].dayRefs, [1]);
  assert.ok(sundowner[0].sourceEvidence.length >= 2);
  assert.equal(result.report.diningCandidateCount, 2);
  assert.equal(result.report.diningSubordinateExcludedCount, 1);
  assert.match(result.report.diningSelection.excluded[0].subordinateEvidence.join("\n"), /热气球之旅/);
});

test("跨 DAY 的普通 Sundowner 默认只选择一个代表项并保留择优证据", async () => {
  const rows = itineraryRows([
    ["D1", "保护区A", "傍晚享用 Sundowner 落日酒会。", "酒店晚餐", "Camp A", "游猎车"],
    ["D2", "保护区B", "傍晚享用 Sundowner 落日酒会。", "酒店晚餐", "Camp B", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.equal(result.report.diningCandidateCount, 2);
  assert.equal(result.data.diningExperiences.length, 1);
  assert.equal(result.report.diningRepresentativeExcludedCount, 1);
  assert.equal(result.report.diningSelection.excluded[0].exclusionReason, "same_type_less_representative");
});

test("同类型星空晚宴只保留来源更具体的代表项", async () => {
  const rows = itineraryRows([
    ["D1", "保护区A", "特别体验：在天际甲板享用星空晚宴。", "酒店晚餐", "Camp A", "游猎车"],
    ["D2", "保护区B", "特别体验：星空晚餐。", "酒店晚餐", "Camp B", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.equal(result.data.diningExperiences.length, 1);
  assert.deepEqual(result.data.diningExperiences[0].dayRefs, [1]);
  assert.match(result.data.diningExperiences[0].sourceEvidence.join("\n"), /天际甲板/);
});

test("同类型 Dining 在来源分别突出且体验形式明确不同时允许并存", async () => {
  const rows = itineraryRows([
    ["D1", "湖区", "特别体验：乘船途中安排 Sundowner 落日酒会。", "酒店晚餐", "Camp A", "游猎车"],
    ["D2", "山地", "特别体验：徒步结束后安排 Sundowner 落日酒会。", "酒店晚餐", "Camp B", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.equal(result.data.diningExperiences.length, 2);
  assert.deepEqual(result.data.diningExperiences.map((item) => item.dayRefs), [[1], [2]]);
});

test("Dining 状态判断整项体验，局部升级酒水收费不把私人酒窖品酒降为 pending", async () => {
  const rows = itineraryRows([
    ["D1", "保护区", "特别体验：在私人酒窖品尝美酒（高档酒水额外收费）。", "酒店晚餐", "Safari Camp", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  const dining = result.data.diningExperiences[0];
  assert.equal(dining.status, "included");
  assert.equal(dining.feeBoundary, "included");
  assert.match(dining.sourceEvidence.join("\n"), /高档酒水额外收费/);
  const candidate = result.data.sourceImportCoverage.diningCandidates[0];
  assert.match(candidate.partialFeeEvidence.join("\n"), /高档酒水额外收费/);
});

test("普通酒店早餐、午餐盒和酒店晚餐不进入 Dining 候选", async () => {
  const rows = itineraryRows([
    ["D1", "保护区", "全天游猎。", "酒店早餐\n午餐盒\n酒店晚餐", "Safari Camp", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.equal(result.report.diningCandidateCount, 0);
  assert.deepEqual(result.data.diningExperiences, []);
});

test("命名餐厅只从餐饮语境提取，不把城市、酒店或商场英文名误识别成餐厅", async () => {
  const rows = itineraryRows([
    ["D1", "马赛马拉→内罗毕", "专人接机送往 Westlands 商圈 JW Marriott，前往 Karen 区与 Westgate 购物中心。晚餐品尝非洲“百兽宴”The Carnivore，体验世界排名前50的特色烤肉餐厅。", "特色晚餐非洲“百兽宴”The Carnivore", "JW Marriott", "商务车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.deepEqual(result.data.diningExperiences.map((item) => item.officialName), ["The Carnivore"]);
  assert.match(result.data.diningExperiences[0].sourceEvidence.join("\n"), /世界排名前50的特色烤肉餐厅/);
});

test("原始费用不含已有统括自费活动时，不重复追加派生自费体验", async () => {
  const rows = [
    ...itineraryRows([["D1", "马赛马拉", "可自费参加热气球 Safari。", "酒店早餐", "Safari Camp", "游猎车"]]),
    ["报价不包含"],
    ["1. 各种列明的自费活动项目"],
  ];
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.deepEqual(result.data.excluded, ["各种列明的自费活动项目"]);
});

test("Parser 直接提取明确的当天实用提醒，且每天最多一条", async () => {
  const rows = itineraryRows([
    ["D1", "保护区", "徒步游猎。当天建议穿适合行走的鞋。夜间活动建议准备轻薄外套。", "酒店早餐", "Safari Camp", "游猎车"],
  ]);
  const result = await importItineraryWorkbook(workbookFile(rows), {});
  assert.equal(result.data.days[0].dayNotices.length, 1);
  assert.match(result.data.days[0].dayNotices[0].text, /适合行走的鞋/);
  assert.equal(result.data.days[0].dayNotices[0].sourceKind, "source_explicit");
  assert.ok(result.data.days[0].dayNotices[0].sourceEvidence.length > 0);
});

test("Planner 只为有真实准备价值的 DAY 创建一个 notice target，无价值 DAY 保持为空", () => {
  const data = {
    title: "肯尼亚2日行程", subtitle: "", destination: "肯尼亚", sourcePosterHighlights: [], highlights: [], hotels: [], diningExperiences: [], transportSummary: [], notes: [],
    days: [
      { date: null, theme: "草原飞行", routeNodes: ["内罗毕", "马赛马拉"], city: "内罗毕→马赛马拉", description: "乘草原小飞机前往马赛马拉。", vehicle: "草原小飞机", estimatedTravelTime: "飞行约1小时", movementPaceDescriptor: "", activityLevel: "适中", hotel: "Safari Camp", mealPlan: {}, dayNotices: [], spots: [{ id: "s1", name: "草原飞行", description: "乘草原小飞机前往", status: "included", feeBoundary: "included", sourceEvidence: ["原始行程"] }] },
      { date: null, theme: "营地休整", routeNodes: ["营地"], city: "营地", description: "在营地自由休整。", vehicle: "", estimatedTravelTime: "", movementPaceDescriptor: "无长距离转场", activityLevel: "轻松", hotel: "Safari Camp", mealPlan: {}, dayNotices: [], spots: [{ id: "s2", name: "营地休整", description: "自由休整", status: "included", feeBoundary: "included", sourceEvidence: ["原始行程"] }] },
    ],
  };
  const plan = materializeSimpleSkillPlan({ data, agentPlan: agentPlanFor(data) });
  const noticeTasks = plan.copyTasks.filter((item) => item.moduleType === "day_notice");
  assert.equal(noticeTasks.length, 1);
  assert.equal(noticeTasks[0].targetPath, "days.0.dayNotices.0.text");
  assert.equal(plan.preparedData.days[0].dayNotices.length, 1);
  assert.deepEqual(plan.preparedData.days[1].dayNotices, []);
});

test("全程注意事项不会被复制成 DAY tip，没有当天依据时保持为空", () => {
  const data = {
    title: "肯尼亚1日行程", subtitle: "", destination: "肯尼亚", sourcePosterHighlights: [], highlights: [], hotels: [], diningExperiences: [], transportSummary: [],
    notes: [{ title: "行前准备", items: ["核对护照与签证"] }],
    days: [{ date: null, theme: "酒店休整", routeNodes: ["酒店"], city: "酒店", description: "酒店休整。", vehicle: "", estimatedTravelTime: "", movementPaceDescriptor: "无长距离转场", activityLevel: "轻松", hotel: "Test Hotel", mealPlan: {}, dayNotices: [], spots: [{ id: "s1", name: "酒店休整", description: "酒店休整", status: "included", feeBoundary: "included", sourceEvidence: ["原始行程"] }] }],
  };
  const plan = materializeSimpleSkillPlan({ data, agentPlan: agentPlanFor(data) });
  assert.equal(plan.copyTasks.some((item) => item.moduleType === "day_notice"), false);
  assert.deepEqual(plan.preparedData.days[0].dayNotices, []);
});

test("DAY notice 只读取当天来源事实，不受既有 DAY Copy 回顾其他天体验污染", () => {
  const data = {
    title: "肯尼亚1日行程", subtitle: "", destination: "肯尼亚", sourcePosterHighlights: [], highlights: [], hotels: [], diningExperiences: [], transportSummary: [], notes: [],
    days: [{
      date: null,
      theme: "返程",
      routeNodes: ["内罗毕", "机场"],
      description: "带着前几天私人保护区徒步的回忆从容返程。",
      sourceEvidence: { route: "内罗毕 - 送机离境", description: "酒店早餐后，根据国际航班时间专人送机。", vehicle: "商务用车" },
      vehicle: "商务用车",
      estimatedTravelTime: "",
      movementPaceDescriptor: "按国际航班时间安排",
      activityLevel: "轻松",
      hotel: null,
      mealPlan: {},
      dayNotices: [],
      spots: [{ id: "s1", name: "送机离境", description: "回顾此前徒步体验后返程", status: "included", feeBoundary: "included", sourceEvidence: ["酒店早餐后，根据国际航班时间专人送机。"] }],
    }],
  };
  const plan = materializeSimpleSkillPlan({ data, agentPlan: agentPlanFor(data) });
  assert.equal(plan.copyTasks.some((item) => item.moduleType === "day_notice"), false);
  assert.deepEqual(plan.preparedData.days[0].dayNotices, []);
});

test("Dining Copy 任务使用写作约束而非可照抄参考句，通用体验不额外联网", () => {
  const data = {
    title: "肯尼亚1日行程", subtitle: "", destination: "肯尼亚", sourcePosterHighlights: [], highlights: [], hotels: [], transportSummary: [], notes: [],
    diningExperiences: [{ id: "d1", title: "Sundowner 落日酒会", officialName: "Sundowner 落日酒会", location: "马赛马拉", status: "included", feeBoundary: "included", sourceEvidence: ["DAY 1 详细行程：傍晚享用 Sundowner 落日酒会"], editorialCopy: "", images: [] }],
    days: [{ date: null, theme: "草原日落", routeNodes: ["马赛马拉"], description: "傍晚享用落日酒会。", vehicle: "游猎车", estimatedTravelTime: "", movementPaceDescriptor: "区域内游猎", activityLevel: "适中", hotel: "Safari Camp", mealPlan: {}, dayNotices: [], spots: [{ id: "s1", name: "落日酒会", description: "傍晚享用落日酒会", status: "included", feeBoundary: "included", sourceEvidence: ["原始行程"] }] }],
  };
  const plan = materializeSimpleSkillPlan({ data, agentPlan: agentPlanFor(data) });
  const task = plan.copyTasks.find((item) => item.moduleType === "dining");
  assert.deepEqual(Object.keys(task.facts).sort(), ["copyGuidance", "id", "location", "officialName", "sourceEvidence", "title"]);
  assert.match(task.plannerGoal, /独立的特色餐饮总览卡/);
  assert.match(task.plannerGoal, /最有辨识度的餐饮锚点/);
  assert.match(task.plannerGoal, /不重复 DAY 编号/);
  assert.match(task.plannerGoal, /完整 title、officialName、地点名和状态标签/);
  assert.match(task.plannerGoal, /不强制写“与普通用餐不同”/);
  assert.match(task.plannerGoal, /不追加抽象客户价值总结/);
  assert.match(task.plannerGoal, /不得写具体 DAY、当天、随后、游猎归来、开启一天、结束一天/);
  assert.match(task.plannerGoal, /不为整趟旅程收尾/);
  assert.match(task.plannerGoal, /不得把它当成可直接照抄的产品化参考句/);
  assert.match(task.facts.copyGuidance, /不照抄固定模板/);
  assert.match(task.facts.copyGuidance, /只选择一个最有辨识度的餐饮锚点/);
  assert.doesNotMatch(task.facts.copyGuidance, /喝一杯 Sundowner|可直接采用或轻量改写|产品化参考句/);
  assert.equal(task.researchRequest, undefined);
  assert.match(task.plannerGoal, /不得借用本批其他 Dining target 的事实/);
  assert.doesNotMatch(task.plannerGoal, /抽象体验价值/);
  assert.equal(task.outputSchema.maxLength, 96);
});

test("明确酒店专属餐饮与命名餐厅获得一次轻量事实研究请求", () => {
  const hotel = { id: "h1", officialName: "Example Safari Camp", shortName: "Example Safari Camp", sourceEvidence: [] };
  const data = {
    title: "肯尼亚1日行程", subtitle: "", destination: "肯尼亚", sourcePosterHighlights: [], highlights: [], hotels: [hotel], transportSummary: [], notes: [],
    diningExperiences: [
      { id: "d1", title: "星空晚宴", officialName: "", location: "Example Safari Camp", sourceEvidence: ["DAY 1：酒店安排星空晚宴"], editorialCopy: "", images: [] },
      { id: "imported-dining-restaurant-the-carnivore-day-1", title: "非洲百兽宴 The Carnivore", officialName: "The Carnivore", location: "内罗毕", sourceEvidence: ["DAY 1：晚餐前往 The Carnivore"], editorialCopy: "", images: [] },
    ],
    days: [{ date: null, theme: "城市与晚宴", routeNodes: ["内罗毕"], description: "晚间用餐。", vehicle: "商务车", mealPlan: {}, dayNotices: [], spots: [] }],
  };
  const plan = materializeSimpleSkillPlan({ data, agentPlan: agentPlanFor(data) });
  const tasks = plan.copyTasks.filter((item) => item.moduleType === "dining");
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0].researchRequest, {
    researchType: "official_entity_facts",
    entityName: "Example Safari Camp",
    entityKind: "dining",
    focus: "星空晚宴",
    categories: ["餐饮形式", "体验特色"],
  });
  assert.deepEqual(tasks[1].researchRequest, {
    researchType: "official_entity_facts",
    entityName: "The Carnivore",
    entityKind: "dining",
    focus: "The Carnivore",
    categories: ["餐饮形式", "体验特色"],
  });
});

test("DAY notice 无来源政策数字会被拒绝，合法短提醒可写回且其他 DAY 事实不变", async () => {
  const data = {
    title: "肯尼亚1日行程", subtitle: "", destination: "肯尼亚", sourcePosterHighlights: [], highlights: [], hotels: [], diningExperiences: [], transportSummary: [], notes: [],
    days: [{ date: null, theme: "草原飞行", routeNodes: ["内罗毕", "马赛马拉"], city: "内罗毕→马赛马拉", description: "乘草原小飞机前往马赛马拉。", vehicle: "草原小飞机", estimatedTravelTime: "飞行约1小时", movementPaceDescriptor: "", activityLevel: "适中", hotel: "Safari Camp", mealPlan: { breakfast: "酒店早餐" }, dayNotices: [], spots: [{ id: "s1", name: "草原飞行", description: "乘草原小飞机前往", status: "included", feeBoundary: "included", sourceEvidence: ["原始行程"] }] }],
  };
  const plan = materializeSimpleSkillPlan({ data, agentPlan: agentPlanFor(data) });
  const noticeTask = plan.copyTasks.find((item) => item.moduleType === "day_notice");
  const rejected = await runCopyWriterSkill({
    tasks: [noticeTask],
    requestJson: async () => ({ json: { results: [{ targetId: noticeTask.targetId, targetPath: noticeTask.targetPath, value: "草原飞机仅限15公斤软包行李。" }] }, attemptUsages: [{}] }),
  });
  assert.equal(rejected.results[0].status, "failed");
  assert.equal(rejected.results[0].error.code, "unsupported_copy_commitment");

  const before = structuredClone(plan.preparedData.days[0]);
  const written = applySimpleSkillResults({
    preparedData: plan.preparedData,
    copyTasks: [noticeTask],
    copyExecution: { results: [{ targetId: noticeTask.targetId, targetPath: noticeTask.targetPath, status: "success", value: "这一段建议优先准备随身必需品，出票后定制师会再协助核对行李要求。" }] },
  });
  assert.equal(written.data.days[0].dayNotices[0].text, "这一段建议优先准备随身必需品，出票后定制师会再协助核对行李要求。");
  assert.deepEqual({ ...written.data.days[0], dayNotices: undefined }, { ...before, dayNotices: undefined });

  const malicious = { ...noticeTask, targetPath: "days.0.routeNodes" };
  const blocked = applySimpleSkillResults({
    preparedData: plan.preparedData,
    copyTasks: [malicious],
    copyExecution: { results: [{ targetId: malicious.targetId, targetPath: malicious.targetPath, status: "success", value: ["错误路线"] }] },
  });
  assert.equal(blocked.unresolvedItems[0].error.code, "unauthorized_target_path");
  assert.deepEqual(blocked.data.days[0].routeNodes, ["内罗毕", "马赛马拉"]);
});
