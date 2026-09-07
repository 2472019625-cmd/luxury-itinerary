import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildAgentFactBasis } from "../server/agent-trip-planner.mjs";
import { applySimpleSkillResults } from "../server/simple-pipeline-writeback.mjs";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";
import {
  extractTravelTime,
  inferActivityLevel,
  normalizeItineraryFacts,
  splitRouteNodes,
} from "../src/lib/itineraryRules.js";

function workbookFile(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "行程单");
  return new File([XLSX.write(workbook, { type: "array", bookType: "xlsx" })], "每日结构化字段.xlsx");
}

test("带普通英文连字符的实体不拆分，中文路线连字符仍可分段", () => {
  assert.deepEqual(splitRouteNodes("The Ritz-Carlton, Masai Mara Safari Camp"), ["The Ritz-Carlton, Masai Mara Safari Camp"]);
  assert.deepEqual(splitRouteNodes("Jean-Michel Cousteau Resort → 市中心"), ["Jean-Michel Cousteau Resort", "市中心"]);
  assert.deepEqual(splitRouteNodes("阿鲁沙-塔兰吉雷国家公园"), ["阿鲁沙", "塔兰吉雷国家公园"]);
});

test("routeNodes 综合简要路线、详细体验和前后住宿，并保持 normalize 幂等", () => {
  const source = {
    days: [
      { city: "内罗毕 → 安博塞利", hotel: "Angama Amboseli", description: "抵达后驱车前往安博塞利并入住酒店。", vehicle: "商务用车", spots: [] },
      { city: "安博塞利全天游猎", hotel: "Angama Amboseli", description: "清晨进入公园核心区。午后登 Observation Hill 俯瞰湿地，夜间游猎追踪夜行动物。", vehicle: "四驱敞篷越野车", spots: [] },
      { city: "马赛马拉 ✈ 内罗毕", hotel: "JW Marriott Hotel Nairobi", description: "清晨乘草原小飞机返回内罗毕。前往长颈鹿中心，与长颈鹿互动。前往 Karen 区打卡取景地凯伦·布里克森博物馆。晚间回JW万豪酒店休整。", vehicle: "商务用车 + 草原飞机", spots: [] },
      { city: "内罗毕 - 送机离境", hotel: "飞机", description: "酒店早餐后，前往乔莫·肯雅塔国际机场，根据国际航班时间专人送机离境。", vehicle: "商务用车", spots: [] },
    ],
  };
  const once = normalizeItineraryFacts(source, { mapDates: false });
  const twice = normalizeItineraryFacts(once, { mapDates: false });
  assert.deepEqual(twice, once);
  assert.deepEqual(once.days[1].routeNodes, ["Angama Amboseli", "安博塞利核心区", "Observation Hill", "夜间游猎"]);
  assert.ok(once.days[2].routeNodes.includes("马赛马拉"));
  assert.ok(once.days[2].routeNodes.includes("内罗毕"));
  assert.ok(once.days[2].routeNodes.includes("长颈鹿中心"));
  assert.ok(once.days[2].routeNodes.some((node) => node.endsWith("凯伦·布里克森博物馆")));
  assert.equal(once.days[2].routeNodes.at(-1), "JW Marriott Hotel Nairobi");
  assert.deepEqual(once.days[3].routeNodes, ["JW Marriott Hotel Nairobi", "乔莫·肯雅塔国际机场", "送机离境"]);
  assert.ok(!once.days[1].routeNodes.includes("安博塞利全天游猎"));
});

test("estimatedTravelTime 支持单值、区间、至表达和上下文交通方式", () => {
  assert.equal(extractTravelTime("驱车前往保护区（约4.5-5小时）"), "车程约4.5–5小时");
  assert.equal(extractTravelTime("驱车前往保护区（约4.5至5小时）"), "车程约4.5–5小时");
  assert.equal(extractTravelTime("车程约4.5-5小时"), "车程约4.5–5小时");
  assert.equal(extractTravelTime("车程约1-1.5小时"), "车程约1–1.5小时");
  assert.equal(extractTravelTime("乘草原飞机飞往保护区（约1小时）"), "飞行约1小时");
  assert.equal(extractTravelTime("飞行约1小时"), "飞行约1小时");
  assert.equal(extractTravelTime("航程约1小时"), "航程约1小时");
  assert.equal(extractTravelTime("车程约2.5小时"), "车程约2.5小时");
  assert.equal(extractTravelTime("区域内游猎"), "");
});

test("待确认不会固化，缺少真实时间时使用独立 movementPaceDescriptor", () => {
  const data = normalizeItineraryFacts({ days: [
    { city: "城市至保护区", description: "驱车前往保护区（约4.5-5小时）", estimatedTravelTime: "待确认", vehicle: "商务用车", hotel: "Test Lodge" },
    { city: "保护区全天游猎", description: "全天在保护区内游猎", vehicle: "四驱游猎车", hotel: "Test Lodge" },
  ] }, { mapDates: false });
  assert.equal(data.days[0].estimatedTravelTime, "车程约4.5–5小时");
  assert.equal(data.days[0].movementPaceDescriptor, "");
  assert.equal(data.days[1].estimatedTravelTime, "");
  assert.equal(data.days[1].movementPaceDescriptor, "区域内游猎");
});

test("activityLevel 区分送机、普通游猎、全天多体验和复合高参与日", () => {
  assert.equal(inferActivityLevel({ description: "根据国际航班时间专人送机离境", spots: [] }), "轻松");
  assert.equal(inferActivityLevel({ description: "当天主要为跨区转场", estimatedTravelTime: "车程约4.5–5小时", spots: [] }), "适中");
  assert.equal(inferActivityLevel({ description: "上午进行一次保护区游猎", spots: [{ name: "保护区游猎" }] }), "适中");
  assert.equal(inferActivityLevel({ description: "全天游猎并参观村庄", spots: [{ name: "全天游猎" }, { name: "村庄参访" }] }), "充实");
  assert.equal(inferActivityLevel({ description: "清晨热气球，午后徒步游猎，夜间游猎", spots: [{ name: "热气球" }, { name: "徒步游猎" }, { name: "夜间游猎" }] }), "充实");
});

test("Excel 导入形成客户路线骨架、真实时长、节奏描述和活动强度", async () => {
  const rows = [
    ["肯尼亚8日行程"],
    ["日期", "简要行程", "详细", "用餐", "参考酒店", "用车"],
    ["DAY 1", "抵达内罗毕\n内罗毕 🚗 安博塞利", "抵达乔莫·肯雅塔国际机场后直接驱车前往安博塞利国家公园（约4.5-5小时）。", "晚餐", "Angama Amboseli", "商务用车"],
    ["DAY 2", "安博塞利全天游猎", "清晨进入公园核心区。午后登 Observation Hill。夜间游猎追踪夜行动物。", "全餐", "Angama Amboseli", "四驱游猎车"],
    ["DAY 3", "安博塞利 ✈ 马赛马拉", "乘草原小飞机飞往马赛马拉（约1小时），落地后游猎。", "全餐", "The Ritz-Carlton, Masai Mara Safari Camp", "草原飞机"],
    ["DAY 4", "马赛马拉全天游猎", "全天游猎并参观马赛村庄。", "全餐", "The Ritz-Carlton, Masai Mara Safari Camp", "四驱游猎车"],
    ["DAY 5", "马赛马拉全天游猎", "早餐后由营地转至私人保护区（车程约1-1.5小时），夜间游猎并徒步游猎。", "全餐", "Saruni Leopard Hill", "四驱游猎车"],
    ["DAY 6", "马赛马拉全天游猎", "清晨热气球，日间游猎及丛林徒步，夜间观星。", "全餐", "Saruni Leopard Hill", "四驱游猎车"],
    ["DAY 7", "马赛马拉 ✈ 内罗毕", "乘草原小飞机返回内罗毕（约1小时）。前往长颈鹿中心，参观凯伦·布里克森博物馆，晚间回酒店。", "全餐", "JW Marriott Hotel Nairobi", "商务用车 + 草原飞机"],
    ["DAY 8", "内罗毕 - 送机离境", "酒店早餐后，根据国际航班时间送机离境。", "早餐", "飞机", "商务用车"],
  ];
  const { data } = await importItineraryWorkbook(workbookFile(rows), { days: [] });
  assert.equal(data.days[0].estimatedTravelTime, "车程约4.5–5小时");
  assert.equal(data.days[2].estimatedTravelTime, "飞行约1小时");
  assert.equal(data.days[4].estimatedTravelTime, "车程约1–1.5小时");
  assert.equal(data.days[7].estimatedTravelTime, "");
  assert.equal(data.days[7].movementPaceDescriptor, "按国际航班时间安排");
  assert.deepEqual(data.days[7].routeNodes, ["JW Marriott Hotel Nairobi", "乔莫·肯雅塔国际机场", "送机离境"]);
  assert.ok(data.days[2].routeNodes.includes("The Ritz-Carlton, Masai Mara Safari Camp"));
  assert.ok(!data.days[2].routeNodes.includes("The Ritz"));
  assert.deepEqual(data.days.map((day) => day.activityLevel), ["适中", "充实", "适中", "充实", "充实", "充实", "充实", "轻松"]);
});

test("Planner 只读取确定性字段，Copy writeback 无权覆盖", () => {
  const data = normalizeItineraryFacts({ destination: "测试目的地", days: [{ city: "保护区", description: "普通游猎", vehicle: "游猎车", hotel: "Test Lodge" }] }, { mapDates: false });
  const factBasis = buildAgentFactBasis(data, {});
  assert.equal(factBasis.days[0].estimatedTravelTime, null);
  assert.equal(factBasis.days[0].movementPaceDescriptor, data.days[0].movementPaceDescriptor);
  assert.equal(factBasis.days[0].activityLevel, data.days[0].activityLevel);
  for (const targetPath of ["days.0.routeNodes", "days.0.estimatedTravelTime", "days.0.movementPaceDescriptor", "days.0.activityLevel"]) {
    const result = applySimpleSkillResults({
      preparedData: data,
      copyTasks: [{ targetId: `copy:${targetPath}`, targetPath, required: true, outputSchema: { type: "string" } }],
      copyExecution: { results: [{ targetId: `copy:${targetPath}`, targetPath, status: "success", value: "被覆盖" }] },
    });
    assert.equal(result.unresolvedItems[0].error.code, "unauthorized_target_path");
    assert.deepEqual(result.data.days[0].routeNodes, data.days[0].routeNodes);
    assert.equal(result.data.days[0].estimatedTravelTime, data.days[0].estimatedTravelTime);
    assert.equal(result.data.days[0].movementPaceDescriptor, data.days[0].movementPaceDescriptor);
    assert.equal(result.data.days[0].activityLevel, data.days[0].activityLevel);
  }
});
