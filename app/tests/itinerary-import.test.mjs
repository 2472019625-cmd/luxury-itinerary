import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { importItineraryWorkbook } from "../src/lib/itineraryImport.js";

test("imports a standard itinerary workbook and isolates internal quote notes", async () => {
  const rows = [
    ["肯尼亚8日顶奢（8.4W起）"],
    ["海报下方亮点"],
    ["顶奢连住｜国际品牌+私保营地"],
    ["天数", "日期", "路线", "行程内容", "早餐", "午餐", "晚餐", "住宿", "交通"],
    ["D1", "2026-10-15", "内罗毕→安博塞利", "接机后乘草原飞机前往营地", "酒店早餐", "机上午餐", "营地晚餐", "Angama Amboseli", "商务车+草原飞机"],
    ["D2", "2026-10-16", "安博塞利", "全天私人游猎", "营地早餐", "丛林早餐", "星空晚宴", "Angama Amboseli", "4x4游猎车"],
    ["海报价83,880元/人起"],
    ["内部成本70,000元，按2人1车1间房测算"],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "行程");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const file = new File([buffer], "肯尼亚报价单.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const baseData = { destination: "", days: [], highlights: ["一家一团：私家定制"], priceUnit: "元 / 人起" };

  const result = await importItineraryWorkbook(file, baseData);

  assert.equal(result.data.destination, "肯尼亚");
  assert.equal(result.data.days.length, 2);
  assert.equal(result.data.days[1].mealPlan.lunch, "丛林早餐");
  assert.equal(result.data.totalPrice, 83880);
  assert.equal(result.data.diningSectionTitle, "特色餐饮");
  assert.equal(result.report.internalFilteredCount, 1);
  assert.ok(!JSON.stringify(result.data).includes("内部成本"));
  assert.ok(result.report.cellCoverage.length >= rows.flat().filter(Boolean).length);
  assert.ok(result.report.cellCoverage.some((item) => item.disposition === 'internal_retained' && /内部成本/.test(item.raw)));
  assert.equal(result.report.coverageSummary.total, result.report.cellCoverage.length);
  assert.ok(Array.isArray(result.report.unrecognizedFields));
});

test("recognizes compact Chinese headers without treating meals as hotels", async () => {
  const rows = [
    ["坦桑尼亚7日顶奢（10.4W起）：Singita连住"],
    ["海报下方亮点：顶奢Singita连住 春节住六付五特惠 私人保护区徒步/夜游"],
    ["日期", "简要行程", "详细", "用餐", "参考酒店", "用车"],
    ["DAY 1", "机场✈塞伦盖蒂西部", "VIP接机后飞往私人保护区", "酒店晚餐", "Singita Faru Faru Lodge", "草原飞机+游猎车"],
    ["DAY 2", "塞伦盖蒂西部", "全天游猎", "酒店早餐 午餐盒 酒店晚餐", "Singita Faru Faru Lodge", "游猎车"],
    ["DAY 3", "塞伦盖蒂西部", "全天游猎", "酒店早餐 午餐盒 酒店晚餐", "Singita Sabora Tented Camp", "游猎车"],
    ["DAY 4", "返回机场", "乘草原飞机离开", "酒店早餐 午餐盒", "飞机", "草原飞机"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const file = new File([buffer], "坦桑尼亚报价单.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const result = await importItineraryWorkbook(file, { days: [], highlights: [] });

  assert.equal(result.data.days.length, 4);
  assert.deepEqual(result.data.hotels.map((hotel) => hotel.officialName), ["Singita Faru Faru Lodge", "Singita Sabora Tented Camp"]);
  assert.equal(result.data.days[1].mealPlan.breakfast, "酒店早餐");
  assert.equal(result.data.days[1].mealPlan.lunch, "午餐盒");
  assert.equal(result.data.days[1].mealPlan.dinner, "酒店晚餐");
  assert.equal(result.report.highlightCount, 1);
  assert.ok(result.data.days.every((day) => day.spots.length >= 1));
  assert.equal(result.data.days[3].overnightType, "inflight");
  assert.ok(!result.report.warnings.includes("false"));
});

test("preserves nine source inclusions and daily transport with coverage evidence", async () => {
  const rows = [
    ["坦桑尼亚2日行程"],
    ["日期", "简要行程", "详细", "用餐", "参考酒店", "用车"],
    ["DAY 1", "阿鲁沙-塔兰吉雷", "前往塔兰吉雷", "酒店晚餐", "Test Lodge", "商务车"],
    ["DAY 2", "塔兰吉雷-机场", "游猎后返程", "酒店早餐", "飞机", "四驱车+草原飞机"],
    ["报价包含", "1 住宿"], ["", "2 餐食"], ["", "3 门票"], ["", "4 司导"], ["", "5 商务车"],
    ["", "6 四驱车"], ["", "7 草原飞机"], ["", "8 酒店税费"], ["", "9 服务支持"],
    ["报价不包含", "1 国际机票"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "行程");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const result = await importItineraryWorkbook(new File([buffer], "九项费用.xlsx"), { days: [] });
  assert.equal(result.data.included.length, 9);
  assert.equal(result.data.sourceImportCoverage.included.length, 9);
  assert.equal(result.data.sourceImportCoverage.dailyTransport.length, 2);
  assert.ok(result.data.transportSummary.length >= 3);
  assert.ok(result.report.cellCoverage.some((item) => item.target === 'included.8'));
});
