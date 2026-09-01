import assert from "node:assert/strict";
import test from "node:test";
import { applyTargetedRevisions, compactForModel, compareDeterministicFacts, mergeRefinement, validateDailyRefinement } from "../server/itinerary-refinement.mjs";

function sourceData() {
  return {
    title: "肯尼亚2天1晚深度定制游", destination: "肯尼亚", startDate: "2026-09-01", endDate: "2026-09-02",
    included: ["两晚住宿"], excluded: ["热气球费用"], cancellation: ["以合同为准"],
    customerPreferences: ["慢节奏"], specialRequests: "无麸质餐食", pendingConfirmations: ["航班时刻待确认"],
    hotels: [{ id: "h1", officialName: "Test Camp", nights: 1, roomType: "景观房", mealPlan: "全餐", confirmationStatus: "confirmed", referenceOnly: false, replacementPolicy: "同级替换" }],
    transportSummary: [{ id: "t1", category: "游猎车", serviceLevel: "专属用车", seatCount: 7, model: "Land Cruiser", modelGuaranteed: false }],
    days: [
      { date: "2026-09-01", theme: "抵达", routeNodes: ["内罗毕", "酒店"], city: "内罗毕 → 酒店", description: "抵达内罗毕后入住酒店。", mealPlan: { dinner: "酒店晚餐" }, hotel: "Test Camp", vehicle: "专车", estimatedTravelTime: "车程约30分钟", activityLevel: "轻松", restStops: [], overnightType: "hotel", spots: [{ id: "arrival", name: "酒店休整", description: "抵达内罗毕后入住酒店", status: "included", statusLabel: "已包含", feeBoundary: "included", sourceEvidence: ["抵达内罗毕后入住酒店"] }] },
      { date: "2026-09-02", theme: "草原体验", routeNodes: ["酒店", "马赛马拉"], city: "酒店 → 马赛马拉", description: "前往马赛马拉；自费可选热气球。", mealPlan: { breakfast: "酒店早餐" }, hotel: "无住宿", vehicle: "四驱车", estimatedTravelTime: "车程约5小时", activityLevel: "适中", restStops: ["途中休息站"], overnightType: "none", spots: [{ id: "balloon", name: "热气球", description: "自费可选热气球", status: "optional_paid", statusLabel: "自费可选", feeBoundary: "excluded", sourceEvidence: ["自费可选热气球"] }] },
    ],
  };
}

test("compact model input contains customer boundaries and fulfillment facts without internal costs", () => {
  const compact = compactForModel({ ...sourceData(), internalCost: 1000, profit: 500 });
  assert.deepEqual(compact.included, ["两晚住宿"]);
  assert.deepEqual(compact.excluded, ["热气球费用"]);
  assert.deepEqual(compact.cancellation, ["以合同为准"]);
  assert.equal(compact.hotels[0].roomType, "景观房");
  assert.equal(compact.transportSummary[0].modelGuaranteed, false);
  assert.equal(compact.days[1].spots[0].feeBoundary, "excluded");
  assert.deepEqual(compact.customerPreferences, ["慢节奏"]);
  assert.equal(compact.specialRequests, "无麸质餐食");
  assert.deepEqual(compact.importPendingConfirmations, ["航班时刻待确认"]);
  assert.equal("internalCost" in compact, false);
  assert.equal("profit" in compact, false);
});

test("verified official hotel facts reach the copy model and remain deterministic evidence", () => {
  const data = sourceData();
  data.hotels[0].verifiedFacts = [{ statement:'酒店设有室外泳池。', sourceUrl:'https://official.example/facilities', verifiedAt:'2026-09-01', sourceType:'official' }];
  const compact = compactForModel(data);
  assert.equal(compact.hotels[0].verifiedFacts[0].statement, '酒店设有室外泳池。');
  const changed = structuredClone(data);
  changed.hotels[0].verifiedFacts[0].statement = '酒店设有私人动物园。';
  assert.equal(compareDeterministicFacts(data, changed).preserved, false);
});

test("merges every allowed field by the same DAY index and keeps deterministic facts", () => {
  const data = sourceData();
  const refinement = { days: [
    { index: 0, theme: "从容抵达", routeNodes: ["错误路线"], estimatedTravelTime: "9小时", activityLevel: "较高", restStops: ["新休息点"], overnightType: "inflight", description: "专车接机后从容入住。", spots: [{ id: "arrival", name: "抵达与休整", description: "抵达内罗毕后入住酒店" }], dayNotices: [{ type: "tip", text: "留意时差" }, { type: "tip", text: "第二条应被丢弃" }] },
    { index: 1, theme: "马赛马拉初见", description: "驱车进入保护区，可自费选择热气球。", spots: [{ id: "balloon", name: "草原热气球", description: "自费可选热气球" }] },
  ] };
  const result = mergeRefinement(data, refinement);
  assert.equal(result.dailyRefinement.accepted, true);
  assert.equal(result.data.days[0].theme, "从容抵达");
  assert.equal(result.data.days[0].description, "专车接机后从容入住。");
  assert.deepEqual(result.data.days[0].routeNodes, ["内罗毕", "酒店", "Test Camp"]);
  assert.equal(result.data.days[0].estimatedTravelTime, "车程约30分钟");
  assert.equal(result.data.days[0].overnightType, "hotel");
  assert.deepEqual(result.data.days[0].restStops, []);
  assert.equal(result.data.days[0].dayNotices.length, 1);
  assert.equal(result.data.days[1].spots[0].status, "optional_paid");
  assert.equal(result.data.days[1].spots[0].feeBoundary, "excluded");
  assert.ok(result.data.excluded.some((item) => item.includes("热气球")));
});

test("rejects the entire daily refinement for duplicate, missing or extra indexes", () => {
  const data = sourceData();
  for (const days of [[{ index: 0 }, { index: 0 }], [{ index: 0 }], [{ index: 0 }, { index: 2 }]]) {
    assert.equal(validateDailyRefinement(data.days, days).valid, false);
    const result = mergeRefinement(data, { days });
    assert.equal(result.dailyRefinement.accepted, false);
    assert.equal(result.data.days[1].theme, "草原体验");
  }
});

test("does not let the copy model create new deterministic experiences", () => {
  const data = sourceData();
  data.days[0] = { date: "2026-09-01", city: "", theme: "抵达", description: "抵达内罗毕后在观景台休息。", routeNodes: [], estimatedTravelTime: "", activityLevel: "", restStops: [], overnightType: "" };
  const result = mergeRefinement(data, { days: [
    { index: 0, routeNodes: ["内罗毕", "观景台"], estimatedTravelTime: "车程约30分钟", activityLevel: "轻松", restStops: ["观景台"], overnightType: "none", spots: [{ name: "观景台休息", description: "抵达内罗毕后在观景台休息", sourceEvidence: ["抵达内罗毕后在观景台休息"] }] },
    { index: 1 },
  ] });
  assert.equal(result.dailyRefinement.accepted, false);
  assert.deepEqual(result.data.days[0].spots, []);
});

test("rejects all model days when a newly split spot has no same-day source evidence", () => {
  const data = sourceData();
  const result = mergeRefinement(data, { days: [
    { index: 0, theme: "被拒绝的标题", spots: [{ name: "跨天热气球", description: "自费可选热气球", sourceEvidence: ["自费可选热气球"] }] },
    { index: 1, theme: "也不能保存" },
  ] });
  assert.equal(result.dailyRefinement.accepted, false);
  assert.equal(result.data.days[0].theme, "抵达");
  assert.equal(result.data.days[1].theme, "草原体验");
});

test("preserves deterministic spot evidence and rejects removed source experiences", () => {
  const data = sourceData();
  const preserved = mergeRefinement(data, { days: [
    { index: 0, spots: [{ ...data.days[0].spots[0], description: "客户语言改写", sourceEvidence: ["模型试图替换依据"] }] },
    { index: 1, spots: data.days[1].spots },
  ] });
  assert.equal(preserved.dailyRefinement.accepted, true);
  assert.deepEqual(preserved.data.days[0].spots[0].sourceEvidence, ["抵达内罗毕后入住酒店"]);
  const removed = mergeRefinement(data, { days: [{ index: 0, spots: [] }, { index: 1, spots: data.days[1].spots }] });
  assert.equal(removed.dailyRefinement.accepted, false);
  assert.match(removed.dailyRefinement.errors[0], /体验ID集合/);
});

test("brand revision can change only customer copy while deterministic facts and fee arrays stay unchanged", () => {
  const data = sourceData();
  const result = mergeRefinement(data, {
    title: '肯尼亚2天1晚Safari定制游',
    transportSummary: [{ id:'t1', category:'被模型篡改', model:'被模型篡改', seatCount:99, editorialCopy:'专属游猎车让长途移动更舒适，也为途中停靠保留从容衔接。' }],
    days: data.days.map((day, index) => ({ index, theme:`主题${index + 1}`, description:index === 0 ? '抵达后乘专车进入城市，在从容衔接中为第二天的草原旅程铺垫。' : '清晨深入草原守候晨光，随后从容返回，为旅程完成收束。', spots:day.spots.map((spot) => ({...spot,status:'included',feeBoundary:'included'})) })),
    expenseCopy: {
      included:[{index:0,text:'住宿安排：覆盖行程所列两晚住宿'}],
      excluded:[{index:0,text:'热气球体验：当前报价未包含，可提前增订'}],
      cancellation:[{index:0,text:'退改安排：以双方正式合同约定为准'}],
    },
  });
  assert.equal(result.data.transportSummary[0].category, '游猎车');
  assert.equal(result.data.transportSummary[0].model, 'Land Cruiser');
  assert.equal(result.data.transportSummary[0].seatCount, 7);
  assert.deepEqual(result.data.included, data.included);
  assert.deepEqual(result.data.excluded, data.excluded);
  assert.equal(result.data.days[1].spots[0].status, 'optional_paid');
  assert.equal(result.data.days[1].spots[0].feeBoundary, 'excluded');
  assert.match(result.data.excludedCustomer[0], /当前报价未包含/);
});

test("invalid expense copy safely preserves every deterministic fee for targeted rewrite", () => {
  const data = sourceData();
  const result = mergeRefinement(data, {
    days: data.days.map((day, index) => ({ index, spots: day.spots })),
    expenseCopy: { included: [], excluded: [{ index: 9, text: '越界内容' }] },
  });
  assert.deepEqual(result.data.includedCustomer, data.included);
  assert.deepEqual(result.data.excludedCustomer, data.excluded);
  assert.ok(result.mergeWarnings.some((item) => item.path === 'includedCustomer.0'));
  assert.ok(result.mergeWarnings.some((item) => item.path === 'excludedCustomer.0'));
});

test("brand editor applies only issue-targeted field or DAY patches", () => {
  const data = sourceData();
  const result = applyTargetedRevisions(data, {
    reviewIssues:[{ruleId:'COPY-006',path:'days.0.theme',message:'动作主题'}],
    patches:[{path:'days.0.theme',value:'从城市抵达旷野',evidence:['抵达内罗毕后入住酒店']}],
  });
  assert.equal(result.data.days[0].theme, '从城市抵达旷野');
  assert.equal(result.data.days[1].theme, data.days[1].theme);
  assert.equal(result.data.title, data.title);
  assert.deepEqual(result.changedPaths, ['days.0.theme']);
  assert.throws(() => applyTargetedRevisions(data, { reviewIssues:[{path:'days.0.theme'}], patches:[{path:'subtitle',value:'整份误重写'}] }), /未命中模块/);
  assert.throws(() => applyTargetedRevisions(data, { reviewIssues:[{path:'days.0.routeNodes'}], patches:[{path:'days.0.routeNodes',value:['错误路线']}] }), /非文案字段/);
  const noteData = { ...data, notes: [{ title: '行前准备', items: ['旧提示'] }] };
  const noteResult = applyTargetedRevisions(noteData, { reviewIssues:[{path:'notes.0'}], patches:[{path:'notes.0.items',value:['请在出发前核对证件。']}] });
  assert.deepEqual(noteResult.data.notes[0].items, ['请在出发前核对证件。']);
});

test("fact preservation compares original deterministic source with final output", () => {
  const source = sourceData();
  const changedCopy = structuredClone(source);
  changedCopy.days[0].description = '客户表达已重写';
  assert.equal(compareDeterministicFacts(source, changedCopy).preserved, true);
  changedCopy.days[0].vehicle = '被改写的交通';
  assert.equal(compareDeterministicFacts(source, changedCopy).preserved, false);
});

test('rejects string-array notes from new generation and targeted patches', () => {
  const source = sourceData();
  const merged = mergeRefinement(source, { notes: ['签证请核对','建议携带外套'] });
  assert.ok(merged.mergeWarnings.some((item) => item.code === 'notes_invalid_structure' && item.severity === 'structure'));
  assert.throws(() => applyTargetedRevisions({ ...source, notes:[{title:'证件',items:['请核对']}] }, { reviewIssues:[{path:'notes'}], patches:[{path:'notes',value:['错误字符串']}] }), /结构非法/);
});

test("merge keeps an absent deterministic restStops field absent", () => {
  const source = sourceData();
  delete source.days[0].restStops;
  const result = mergeRefinement(source, { days: [
    { index: 0, theme: "从容抵达", restStops: [], spots: source.days[0].spots },
    { index: 1, spots: source.days[1].spots },
  ] });
  assert.equal(result.dailyRefinement.accepted, true);
  assert.equal("restStops" in result.data.days[0], true);
  assert.equal(result.data.days[0].restStops, undefined);
  assert.equal(compareDeterministicFacts(source, result.data).preserved, true);
});
