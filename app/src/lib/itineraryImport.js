import * as XLSX from "xlsx";
import { addDays, normalizeItineraryFacts, splitRouteNodes } from "./itineraryRules.js";
import { transportUsageLabel } from './transportPresentation.js';

const INTERNAL_PATTERNS = [
  /成本|利润|毛利|供应商|底价|采购价|内部|结算价|操作费/i,
  /按\s*\d+\s*人.*?(?:车|房).*?测算/i,
  /基本房型报价|报价测算逻辑|补差价明细/i,
];

const DESTINATIONS = [
  "肯尼亚", "坦桑尼亚", "南非", "博茨瓦纳", "纳米比亚", "摩洛哥", "埃及",
  "土耳其", "希腊", "意大利", "法国", "瑞士", "冰岛", "挪威", "芬兰",
  "日本", "新西兰", "澳大利亚", "马尔代夫", "塞舌尔", "毛里求斯",
];

const HOTEL_PATTERN = /(?:hotel|resort|lodge|camp|villa|singita|melia|m[eé]lia|serena|nimali|angama|ritz|marriott|saruni|营地|酒店|度假村|山庄)/i;

function text(value) {
  return String(value ?? "").replace(/\r/g, "").replace(/[\t\u00a0]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function unique(items) {
  return [...new Set(items.filter(Boolean).map(text).filter(Boolean))];
}

function chineseNumber(value) {
  const source = text(value);
  if (/^\d+$/.test(source)) return Number(source);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (source === "十") return 10;
  if (source.startsWith("十")) return 10 + (digits[source[1]] || 0);
  if (source.endsWith("十")) return (digits[source[0]] || 0) * 10;
  if (source.includes("十")) return (digits[source[0]] || 0) * 10 + (digits[source[2]] || 0);
  return digits[source] || null;
}

function dayNumber(value, allowBareNumber = false) {
  const source = text(value);
  const match = source.match(/(?:^|\s)(?:day|d)\s*0?(\d{1,2})(?:\s|$)/i)
    || source.match(/第\s*([一二两三四五六七八九十\d]{1,3})\s*天/)
    || source.match(/^([一二两三四五六七八九十]{1,3})[、.．]?$/);
  if (match) return chineseNumber(match[1]);
  if (allowBareNumber && /^\d{1,2}$/.test(source)) return Number(source);
  return null;
}

function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 30000 && value < 80000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const source = text(value);
  const full = source.match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  const short = source.match(/(\d{1,2})[月./-](\d{1,2})/);
  if (short) return `${new Date().getFullYear()}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
  return null;
}

function destinationFrom(source) {
  return DESTINATIONS.find((item) => source.includes(item)) || "";
}

function titleFrom(lines, destination, count) {
  const candidate = lines.slice(0, 50).find((line) => destination && line.includes(destination) && /\d+\s*(?:日|天)/.test(line))
    || lines.slice(0, 50).find((line) => /\d+\s*(?:日|天).*(?:奢|游|行程|Safari)/i.test(line));
  if (candidate) return candidate.replace(/[（(][^）)]*(?:起|报价)[^）)]*[）)]/g, "").replace(/[:：].*$/, "").trim();
  return destination && count ? `${destination}${count}天${Math.max(0, count - 1)}晚顶奢深度定制游` : "新的深度定制游";
}

function headerMap(row) {
  const map = {};
  row.forEach((value, index) => {
    const label = text(value);
    if (/^(?:天数|日程|day)$/i.test(label)) map.day = index;
    if (/日期|出发日/.test(label)) map.date = index;
    if (/城市|地点|目的地|路线|区间|简要行程/.test(label)) map.route = index;
    if (/^(?:详细|内容)$|行程内容|行程安排|详细行程|游览内容|当日行程/.test(label)) map.description = index;
    if (/^(?:用餐|餐食)$/.test(label)) map.meals = index;
    if (/早餐/.test(label)) map.breakfast = index;
    if (/午餐/.test(label)) map.lunch = index;
    if (/晚餐/.test(label)) map.dinner = index;
    if (/酒店|住宿/.test(label)) map.hotel = index;
    if (/交通|用车|车辆/.test(label)) map.vehicle = index;
  });
  return map;
}

function mapScore(map) {
  return ["day", "date", "route", "description", "meals", "breakfast", "lunch", "dinner", "hotel", "vehicle"].filter((key) => map[key] !== undefined).length;
}

function dayFromRow(row, map, index) {
  const get = (key) => map[key] === undefined ? "" : text(row[map[key]]);
  const route = get("route");
  const description = get("description") || row.map(text).filter(Boolean).slice(1).join("；");
  const combinedMeals = get("meals");
  const breakfast = get("breakfast") || (/早餐/.test(combinedMeals) ? combinedMeals.match(/[^，,；;\s]*早餐[^，,；;\s]*/)?.[0] || "早餐" : "");
  const lunch = get("lunch") || (/午餐|午餐盒/.test(combinedMeals) ? combinedMeals.match(/[^，,；;\s]*午餐(?:盒)?[^，,；;\s]*/)?.[0] || "午餐" : "");
  const dinner = get("dinner") || (/晚餐/.test(combinedMeals) ? combinedMeals.match(/[^，,；;\s]*晚餐[^，,；;\s]*/)?.[0] || "晚餐" : "");
  const hotel = get("hotel");
  const nodes = splitRouteNodes(route);
  return {
    date: excelDate(map.date === undefined ? "" : row[map.date]),
    theme: nodes.length ? nodes.join(" · ") : `第${index + 1}天私享行程`,
    routeNodes: nodes.length ? nodes : [route || `第${index + 1}天`],
    city: route || nodes.join(" → ") || `第${index + 1}天`,
    mealPlan: { breakfast: breakfast || "以最终确认安排为准", lunch: lunch || "以最终确认安排为准", dinner: dinner || "以最终确认安排为准" },
    hotel: hotel || "以最终确认安排为准",
    vehicle: get("vehicle"),
    description: description || "当日行程将由定制师结合最终确认信息完善。",
    dayNotices: [],
    spots: [],
  };
}

function extractDays(sheets) {
  const days = [];
  for (const { rows } of sheets) {
    let activeMap = null;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];
      const candidateMap = headerMap(row);
      const looksLikeHeader = (candidateMap.day !== undefined || candidateMap.date !== undefined)
        && (candidateMap.description !== undefined || candidateMap.route !== undefined);
      if (looksLikeHeader && mapScore(candidateMap) >= 3) {
        activeMap = candidateMap;
        continue;
      }
      if (!activeMap) continue;
      const markerCell = activeMap.day === undefined ? row.find((cell) => dayNumber(cell)) : row[activeMap.day];
      const number = dayNumber(markerCell, activeMap.day !== undefined);
      if (!number || number > 31) continue;
      const day = dayFromRow(row, activeMap, days.length);
      day.sourceDay = number;
      days.push(day);
    }
  }
  if (days.length) return days.sort((a, b) => a.sourceDay - b.sourceDay).map(({ sourceDay, ...day }) => day);

  for (const { rows } of sheets) {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] || [];
      const markerIndex = row.findIndex((cell) => dayNumber(cell));
      if (markerIndex < 0) continue;
      const number = dayNumber(row[markerIndex]);
      const content = row.map(text).filter(Boolean);
      days.push({
        sourceDay: number,
        date: content.map(excelDate).find(Boolean) || null,
        theme: content.find((item) => /→|—|至/.test(item)) || `第${number}天私享行程`,
        routeNodes: splitRouteNodes(content.find((item) => /→|—|至|✈|-/.test(item)) || ""),
        city: content.find((item) => /→|—|至/.test(item)) || `第${number}天`,
        mealPlan: { breakfast: "以最终确认安排为准", lunch: "以最终确认安排为准", dinner: "以最终确认安排为准" },
        hotel: content.find((item) => HOTEL_PATTERN.test(item)) || "以最终确认安排为准",
        description: content.slice(markerIndex + 1).join("；") || "当日行程将由定制师结合最终确认信息完善。",
        dayNotices: [],
        spots: [],
      });
    }
  }
  return days.sort((a, b) => a.sourceDay - b.sourceDay).map(({ sourceDay, ...day }) => day);
}

function sourceHighlights(lines) {
  const start = lines.findIndex((line) => /海报下方亮点|产品亮点/.test(line));
  const nearby = start >= 0 ? lines.slice(start + 1, start + 10) : [];
  const inline = start >= 0 ? lines[start].replace(/^.*?(?:海报下方亮点|产品亮点)\s*[：:]?\s*/, "").trim() : "";
  return unique([inline, ...nearby.flatMap((line) => line.split(/\n|；/)).filter((line) => /[｜|：:]/.test(line))]).slice(0, 6);
}

function cleanListItem(value) {
  return text(value).replace(/^\s*\d{1,2}\s*[、.．)）-]?\s*/, "").trim();
}

function extractExpenseSections(sheets) {
  const result = { included: [], excluded: [], cancellation: [] };
  const sectionPattern = /^(?:报价|费用)?\s*(包含|不包含|不含|退改(?:政策)?|取消(?:政策)?)\s*[：:]?$/;
  for (const sheet of sheets) {
    let active = null;
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex] || [];
      const values = row.map(text);
      const headingIndex = values.findIndex((value) => sectionPattern.test(value));
      let itemStart = 0;
      if (headingIndex >= 0) {
        const label = values[headingIndex].match(sectionPattern)?.[1] || "";
        active = /不包含|不含/.test(label) ? "excluded" : /退改|取消/.test(label) ? "cancellation" : "included";
        itemStart = headingIndex + 1;
      }
      if (!active) continue;
      const candidates = values.slice(itemStart).map((value, offset) => ({ value, columnIndex: itemStart + offset })).filter(({ value }) => value);
      for (const { value, columnIndex } of candidates) {
        if (headingIndex < 0 && !/^\s*\d{1,2}\s*[、.．)）-]?\s*\S+/.test(value)) continue;
        const item = cleanListItem(value);
        if (!item || sectionPattern.test(item)) continue;
        result[active].push({
          text: item,
          sheet: sheet.name,
          address: XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex }),
        });
      }
    }
  }
  return result;
}

function buildTransportSummary(days) {
  const grouped = new Map();
  days.forEach((day, dayIndex) => {
    const vehicle = text(day.vehicle);
    if (!vehicle) return;
    const segments = vehicle.split(/[+＋、，,；;\/]/).map(text).filter(Boolean);
    for (const segment of segments.length ? segments : [vehicle]) {
      const key = segment.toLowerCase().replace(/\s+/g, "");
      const current = grouped.get(key) || {
        id: `imported-transport-${grouped.size + 1}`,
        category: /飞机|航班/.test(segment) ? "草原飞机" : /越野|4x4/i.test(segment) ? "四驱开顶式越野车" : /商务/.test(segment) ? "商务用车" : segment,
        serviceLevel: segment,
        seatCount: Number(segment.match(/(\d+)\s*座/)?.[1]) || null,
        model: "",
        modelGuaranteed: false,
        usageSegments: [],
        sourceEvidence: [],
        editorialCopy: "交通体验将依据原始逐日用车事实转换为客户版表达。",
        images: [],
      };
      current.usageSegments.push(`DAY ${dayIndex + 1} ${day.routeNodes?.join(" → ") || day.city || ""}`.trim());
      current.sourceEvidence.push(`DAY ${dayIndex + 1} 用车：${vehicle}`);
      grouped.set(key, current);
    }
  });
  return [...grouped.values()].map((item) => ({ ...item, usageLabel: transportUsageLabel(item), usageSegments: unique(item.usageSegments), sourceEvidence: unique(item.sourceEvidence) }));
}

function hotelNames(days, lines) {
  const fromDays = unique(days.map((day) => day.hotel).filter((line) => line && HOTEL_PATTERN.test(line) && !/最终确认|待确认|早餐|午餐|晚餐|用餐/.test(line)));
  if (fromDays.length) return fromDays.slice(0, 8);
  const fromLines = lines.filter((line) => HOTEL_PATTERN.test(line) && line.length >= 4 && line.length <= 90);
  return unique(fromLines
    .flatMap((line) => text(line).split(/[、；;\/]/))
    .map((line) => line.replace(/^(?:入住|酒店|住宿)[：:]?/, "").trim())
    .filter((line) => HOTEL_PATTERN.test(line) && !/餐食|报价|房型|早餐|午餐|晚餐/.test(line)))
    .slice(0, 8);
}

function priceFrom(source) {
  const exact = source.match(/([\d,]{4,})\s*元\s*\/?\s*人\s*起/i);
  if (exact) return Number(exact[1].replace(/,/g, ""));
  const short = source.match(/(\d+(?:\.\d+)?)\s*[wW万]\s*起/);
  return short ? Math.round(Number(short[1]) * 10000) : null;
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true, dense: true });
  const sheets = workbook.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false, blankrows: false });
    const merges = (workbook.Sheets[name]['!merges'] || []).map((range) => XLSX.utils.encode_range(range));
    return { name, rows, merges };
  });
  const lines = unique(sheets.flatMap(({ rows }) => rows.flatMap((row) => row.map(text))).filter(Boolean));
  return { sheets, lines };
}

function buildCellCoverage(sheets, explicitTargets = new Map()) {
  const coverage = [];
  for (const sheet of sheets) {
    let activeMap = null;
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex] || [];
      const candidateMap = headerMap(row);
      if ((candidateMap.day !== undefined || candidateMap.date !== undefined) && (candidateMap.description !== undefined || candidateMap.route !== undefined) && mapScore(candidateMap) >= 3) activeMap = candidateMap;
      const reverseMap = activeMap ? Object.fromEntries(Object.entries(activeMap).map(([key, column]) => [column, key])) : {};
      row.forEach((raw, columnIndex) => {
        const value = text(raw);
        if (!value) return;
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        const explicitTarget = explicitTargets.get(`${sheet.name}!${address}`);
        const internal = INTERNAL_PATTERNS.some((pattern) => pattern.test(value));
        const mapped = reverseMap[columnIndex];
        let disposition = explicitTarget ? 'customer_field' : internal ? 'internal_retained' : mapped ? 'customer_field' : 'unrecognized';
        let target = explicitTarget || (internal ? 'audit.importCoverage' : mapped ? `days[].${mapped}` : '');
        if (/海报下方亮点|产品亮点/.test(value)) { disposition = 'customer_field'; target = 'sourcePosterHighlights'; }
        else if (/元\s*\/?\s*人\s*起|[wW万]\s*起/.test(value) && !internal) { disposition = 'customer_field'; target = 'totalPrice'; }
        else if (rowIndex < 3 && destinationFrom(value)) { disposition = 'customer_field'; target = 'destination/title'; }
        coverage.push({ sheet: sheet.name, address, raw: value, disposition, target, reason: disposition === 'unrecognized' ? '未匹配当前确定性字段，需在确认页人工核对' : '' });
      });
    }
    sheet.merges.forEach((range) => coverage.push({ sheet: sheet.name, address: range, raw: '', disposition: 'merged_range', target: '', reason: '合并单元格范围已登记，内容由左上角单元格记录' }));
  }
  return coverage;
}

export async function importItineraryWorkbook(file, baseData) {
  if (!/\.(xlsx|xls)$/i.test(file.name)) throw new Error("第一版目前仅支持 Excel 报价单（.xlsx / .xls）");
  const { sheets, lines } = parseWorkbook(await file.arrayBuffer());
  const expenses = extractExpenseSections(sheets);
  const explicitTargets = new Map();
  Object.entries(expenses).forEach(([section, items]) => items.forEach((item, index) => explicitTargets.set(`${item.sheet}!${item.address}`, `${section}.${index}`)));
  const cellCoverage = buildCellCoverage(sheets, explicitTargets);
  const joined = lines.join("\n");
  const days = extractDays(sheets);
  const inferredCount = days.length || Number(joined.match(/(\d{1,2})\s*(?:日|天)(?:\d{1,2}\s*晚)?/)?.[1]) || 0;
  const destination = destinationFrom(joined) || "";
  const startDate = days.map((day) => day.date).find(Boolean) || null;
  days.forEach((day, index) => { if (!day.date && startDate) day.date = addDays(startDate, index); });
  const hotels = hotelNames(days, lines).map((name, index) => ({
    id: `imported-hotel-${index + 1}`,
    officialName: name,
    shortName: name,
    region: destination,
    nights: Math.max(1, days.filter((day) => day.hotel.includes(name) || name.includes(day.hotel)).length),
    editorialCopy: "住宿价值与对应体验将在内容生成阶段依据原始行程完整重写。",
    proofPoints: [],
    sourceEvidence: unique(days.filter((day) => day.hotel.includes(name) || name.includes(day.hotel)).flatMap((day, dayIndex) => [`DAY ${dayIndex + 1} 住宿：${day.hotel}`, day.description])).slice(0, 6),
    images: [],
  }));
  const highlights = sourceHighlights(lines);
  const internalMatches = unique(lines.filter((line) => INTERNAL_PATTERNS.some((pattern) => pattern.test(line))));
  const totalPrice = priceFrom(joined);
  const transportSummary = buildTransportSummary(days);
  const sourceImportCoverage = {
    workbookName: file.name,
    included: expenses.included,
    excluded: expenses.excluded,
    cancellation: expenses.cancellation,
    dailyTransport: days.map((day, dayIndex) => ({ dayIndex, text: text(day.vehicle), sourceEvidence: day.vehicle ? [`DAY ${dayIndex + 1} 用车：${text(day.vehicle)}`] : [] })).filter((item) => item.text),
  };
  const nextData = normalizeItineraryFacts({
    designer: baseData?.designer,
    payment: baseData?.payment,
    showBookingSection: baseData?.showBookingSection !== false,
    showSecuritySection: baseData?.showSecuritySection !== false,
    showPaymentSection: baseData?.showPaymentSection !== false,
    hotelReplacementPolicy: baseData?.hotelReplacementPolicy,
    transportDisclaimer: baseData?.transportDisclaimer,
    title: titleFrom(lines, destination, inferredCount),
    subtitle: `一家一团的私家定制，让${destination || "这段旅程"}的节奏、住宿与在地体验更贴合每一位同行者。`,
    destination,
    dayCount: inferredCount,
    startDate,
    endDate: startDate ? addDays(startDate, inferredCount - 1) : null,
    adults: null,
    children: 0,
    travelers: null,
    heroImage: "",
    heroFocus: "50% 50%",
    sourcePosterHighlights: highlights,
    highlights: highlights.slice(0, 6),
    hotels,
    diningSectionTitle: "特色餐饮",
    diningExperiences: [],
    transportSummary,
    days,
    included: expenses.included.map((item) => item.text),
    excluded: expenses.excluded.map((item) => item.text),
    cancellation: expenses.cancellation.map((item) => item.text),
    sourceImportCoverage,
    totalPrice,
    priceUnit: "元 / 人起",
  });
  return {
    data: nextData,
    report: {
      workbookName: file.name,
      sheetNames: sheets.map((sheet) => sheet.name),
      dayCount: days.length,
      hotelCount: hotels.length,
      highlightCount: highlights.length,
      includedCount: expenses.included.length,
      excludedCount: expenses.excluded.length,
      transportCount: transportSummary.length,
      internalFilteredCount: internalMatches.length,
      cellCoverage,
      coverageSummary: {
        total: cellCoverage.length,
        customerField: cellCoverage.filter((item) => item.disposition === 'customer_field').length,
        internalRetained: cellCoverage.filter((item) => item.disposition === 'internal_retained').length,
        unrecognized: cellCoverage.filter((item) => item.disposition === 'unrecognized').length,
        mergedRanges: cellCoverage.filter((item) => item.disposition === 'merged_range').length,
      },
      unrecognizedFields: cellCoverage.filter((item) => item.disposition === 'unrecognized'),
      warnings: unique([
        !days.length && "没有识别到标准逐日行程表，请核对表头或手工补充，系统不会使用演示数据填充。",
        !startDate && "原文件未识别到明确出发日期。",
        !hotels.length && "没有识别到住宿名称。",
        expenses.included.length === 0 && "原文件未识别到费用包含条目；如源文件实际存在，该状态会阻止生成。",
        sourceImportCoverage.dailyTransport.length > 0 && transportSummary.length === 0 && "原文件存在每日交通，但未形成交通汇总，生成已被阻止。",
        "图片将在内容生成阶段按图文对应与全图不重复规则补充。",
      ]).filter(Boolean),
    },
  };
}
