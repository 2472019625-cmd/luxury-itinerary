import * as XLSX from "xlsx";
import { addDays, normalizeItineraryFacts, normalizeSourcePosterHighlights, splitRouteNodes } from "./itineraryRules.js";
import { transportUsageLabel } from './transportPresentation.js';

const INTERNAL_PATTERNS = [
  /成本|利润|毛利|供应商|底价|采购价|内部|结算价|操作费/i,
  /按\s*\d+\s*人.*?(?:车|房).*?测算/i,
  /基本房型报价|报价测算逻辑|补差价明细/i,
];

const INTERNAL_COLUMN_HEADER = /^(?:成本|利润|毛利|底价|采购价|内部结算价|结算价|内部备注)$/i;
const EXPENSE_SECTION_BOUNDARY = /^(?:注明|说明|备注|报价参考|价格明细|行程安排|每日行程|酒店安排|交通安排)$/i;
const ORDINARY_MEAL = /^(?:酒店|营地|机上|当地|中式|西式)?(?:普通)?(?:早餐|午餐|晚餐|早午餐|午餐盒|简餐|自理|全餐|用餐)$/i;

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
  const vehicle = get("vehicle");
  const nodes = splitRouteNodes(route);
  return {
    date: excelDate(map.date === undefined ? "" : row[map.date]),
    theme: nodes.length ? nodes.join(" · ") : `第${index + 1}天私享行程`,
    routeNodes: nodes.length ? nodes : [route || `第${index + 1}天`],
    city: route || nodes.join(" → ") || `第${index + 1}天`,
    mealPlan: { breakfast: breakfast || "以最终确认安排为准", lunch: lunch || "以最终确认安排为准", dinner: dinner || "以最终确认安排为准" },
    hotel: hotel || "以最终确认安排为准",
    vehicle,
    description: description || "当日行程将由定制师结合最终确认信息完善。",
    sourceEvidence: { route, description, meals: combinedMeals || unique([breakfast, lunch, dinner]).join("\n"), hotel, vehicle },
    dayNotices: explicitDayNotices(description, index),
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
        sourceEvidence: {
          route: content.find((item) => /→|—|至|✈|\s+-\s+|(?<=[\u3400-\u9fff])-(?=[\u3400-\u9fff])/.test(item)) || "",
          description: content.slice(markerIndex + 1).join("；"),
          hotel: content.find((item) => HOTEL_PATTERN.test(item)) || "",
          vehicle: "",
        },
        dayNotices: explicitDayNotices(content.slice(markerIndex + 1).join("；"), Math.max(0, number - 1)),
        spots: [],
      });
    }
  }
  return days.sort((a, b) => a.sourceDay - b.sourceDay).map(({ sourceDay, ...day }) => day);
}

const HIGHLIGHT_HEADING = /^(?:海报下方亮点|海报亮点|产品亮点|行程亮点|特别体验)\s*[：:]?\s*/u;
const HIGHLIGHT_BOUNDARY = /^(?:日期|天数|简要行程|详细行程|行程内容|报价|费用|退改|取消|住宿|参考酒店|用车|交通|餐食|备注|说明)/u;

function extractSourceHighlights(sheets) {
  const rawEntries = [];
  const evidence = [];
  const coverageTargets = [];
  for (const sheet of sheets) {
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex] || [];
      if (row.some((value) => dayNumber(value))) continue;
      const values = row.map(text);
      const headingIndex = values.findIndex((value) => HIGHLIGHT_HEADING.test(value));
      if (headingIndex < 0) continue;
      const headingValue = values[headingIndex];
      const headingAddress = XLSX.utils.encode_cell({ r: rowIndex, c: headingIndex });
      coverageTargets.push({ sheet: sheet.name, address: headingAddress, target: "sourcePosterHighlights" });
      evidence.push({ sheet: sheet.name, address: headingAddress, raw: headingValue });
      const inline = headingValue.replace(HIGHLIGHT_HEADING, "").trim();
      if (inline) rawEntries.push(inline);
      if (inline || values.filter(Boolean).length > 1) {
        for (let columnIndex = headingIndex + 1; columnIndex < values.length; columnIndex += 1) {
          if (!values[columnIndex]) continue;
          const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
          rawEntries.push(values[columnIndex]);
          evidence.push({ sheet: sheet.name, address, raw: values[columnIndex] });
          coverageTargets.push({ sheet: sheet.name, address, target: "sourcePosterHighlights" });
        }
        continue;
      }
      for (let nextRow = rowIndex + 1; nextRow < sheet.rows.length; nextRow += 1) {
        const nextValues = (sheet.rows[nextRow] || []).map(text).filter(Boolean);
        if (!nextValues.length) continue;
        if (nextValues.some((value) => dayNumber(value) || HIGHLIGHT_BOUNDARY.test(value))) break;
        nextValues.forEach((value) => {
          const columnIndex = (sheet.rows[nextRow] || []).map(text).indexOf(value);
          const address = XLSX.utils.encode_cell({ r: nextRow, c: Math.max(0, columnIndex) });
          rawEntries.push(value);
          evidence.push({ sheet: sheet.name, address, raw: value });
          coverageTargets.push({ sheet: sheet.name, address, target: "sourcePosterHighlights" });
        });
      }
    }
  }
  const items = normalizeSourcePosterHighlights(rawEntries);
  return {
    rawEntries,
    items,
    evidence: items.map((item) => ({ text: item, sourceEvidence: evidence.filter((entry) => normalizeSourcePosterHighlights([entry.raw]).includes(item)) })),
    coverageTargets,
  };
}

function cleanListItem(value) {
  return text(value).replace(/^\s*(?:[•·▪◦*-]\s*)?(?:\d{1,2}\s*[、.．)）-]?\s*)?/, "").trim();
}

function expenseHeading(value) {
  const source = text(value).replace(/^[✅❌☑☒✔✘✓×]\s*/u, "").trim();
  if (!source) return null;
  if (/(?:报价|费用)?\s*包含\s*[\/／]\s*(?:报价|费用)?\s*(?:不包含|不含)/.test(source)) return { container: true, source };
  const match = source.match(/^(?:报价|费用)?\s*(不包含|不含|包含|退改(?:政策)?|取消(?:政策)?|included|excluded|cancellation)\s*(?:[：:]\s*([\s\S]*))?$/i);
  if (!match) return null;
  const label = match[1];
  return {
    section: /不包含|不含|excluded/i.test(label) ? "excluded" : /退改|取消|cancellation/i.test(label) ? "cancellation" : "included",
    inline: text(match[2]),
    source,
  };
}

function splitExpenseCell(value) {
  const source = text(value);
  if (!source) return [];
  return source
    .split(/\n+|(?=\s*(?:\d{1,2}\s*[、.．)）-]|[•·▪◦*-]\s+))/u)
    .map(text)
    .filter(Boolean);
}

function isNumberedListItem(value) {
  return /^\s*(?:\d{1,2}\s*[、.．)）-]|[•·▪◦*-]\s+)\s*\S+/u.test(text(value));
}

function extractExpenseSections(sheets) {
  const result = { included: [], excluded: [], cancellation: [], coverageTargets: [] };
  for (const sheet of sheets) {
    let active = null;
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex] || [];
      const values = row.map(text);
      const headingIndex = values.findIndex((value) => expenseHeading(value));
      const heading = headingIndex >= 0 ? expenseHeading(values[headingIndex]) : null;
      if (heading?.container) {
        result.coverageTargets.push({ sheet: sheet.name, address: XLSX.utils.encode_cell({ r: rowIndex, c: headingIndex }), target: "expenses" });
        continue;
      }
      if (heading?.section) {
        active = heading.section;
        result.coverageTargets.push({ sheet: sheet.name, address: XLSX.utils.encode_cell({ r: rowIndex, c: headingIndex }), target: active });
      } else if (values.some((value) => EXPENSE_SECTION_BOUNDARY.test(value))) {
        active = null;
      }
      if (!active) continue;
      const candidates = [];
      if (heading?.inline) candidates.push({ value: heading.inline, columnIndex: headingIndex, force: true });
      const itemStart = heading?.section ? headingIndex + 1 : 0;
      values.slice(itemStart).forEach((value, offset) => {
        if (value) candidates.push({ value, columnIndex: itemStart + offset, force: Boolean(heading?.section) });
      });
      const nonEmptyCount = values.filter(Boolean).length;
      for (const { value, columnIndex, force } of candidates) {
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        for (const part of splitExpenseCell(value)) {
          if (!force && !isNumberedListItem(part) && nonEmptyCount > 2) continue;
          const item = cleanListItem(part);
          if (!item || expenseHeading(item) || EXPENSE_SECTION_BOUNDARY.test(item) || INTERNAL_PATTERNS.some((pattern) => pattern.test(item)) || /^\d[\d,.]*$/.test(item)) continue;
          if (result[active].some((entry) => text(entry.text) === item)) continue;
          result[active].push({ text: item, sheet: sheet.name, address });
        }
      }
    }
  }
  return result;
}

function numericAmount(value) {
  const source = text(value).replace(/[,，\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(source)) return null;
  const amount = Number(source);
  return Number.isFinite(amount) && amount >= 1000 ? Math.round(amount) : null;
}

function priceFrom(source) {
  const poster = source.match(/(?:海报价格(?:写|为)?|起售价|最低售价)\s*[：:]?\s*([\d,]{4,}(?:\.\d+)?)\s*元\s*\/?\s*人(?:\s*起)?/i);
  if (poster) return Number(poster[1].replace(/,/g, ""));
  const exact = source.match(/([\d,]{4,}(?:\.\d+)?)\s*元\s*\/?\s*人\s*起/i);
  if (exact) return Number(exact[1].replace(/,/g, ""));
  const short = source.match(/(\d+(?:\.\d+)?)\s*[wW万]\s*起/);
  return short ? Math.round(Number(short[1]) * 10000) : null;
}

function extractPriceFacts(sheets, joined) {
  const result = { totalPrice: null, priceUnit: "元 / 人起", priceNotes: [], priceOffers: [], coverageTargets: [], warnings: [] };
  for (const sheet of sheets) {
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex] || [];
      const values = row.map(text);
      values.forEach((value, columnIndex) => {
        if (!value || INTERNAL_PATTERNS.some((pattern) => pattern.test(value))) return;
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        if (/(?:海报价格|起售价|[\d,]{4,}\s*元\s*\/?\s*人\s*起|\d+(?:\.\d+)?\s*[wW万]\s*起)/i.test(value)) {
          result.coverageTargets.push({ sheet: sheet.name, address, target: "totalPrice" });
          const note = value.match(/(\d{1,2}[.月\/-]\d{1,2}\s*(?:-|—|–|至|到)\s*\d{1,2}[.月\/-]\d{1,2}\s*出发[^。；\n]*(?:补差|加价)[^。；\n]*)/i)?.[1];
          if (note) result.priceNotes.push(text(note));
        }
      });

      const priceColumn = values.findIndex((value) => /^(?:价格|报价|售价)\s*(?:[（(]元[）)])?$/i.test(value));
      if (priceColumn < 0) continue;
      const periodColumn = values.findIndex((value) => /^(?:有效期|日期|出发日期|档期)$/i.test(value));
      const publicColumns = values.map((value, index) => ({ value, index })).filter(({ value }) => value && !INTERNAL_COLUMN_HEADER.test(value));
      publicColumns.forEach(({ index }) => result.coverageTargets.push({ sheet: sheet.name, address: XLSX.utils.encode_cell({ r: rowIndex, c: index }), target: "sourceImportCoverage.priceOffers" }));
      for (let dataRowIndex = rowIndex + 1; dataRowIndex < sheet.rows.length; dataRowIndex += 1) {
        const dataRow = sheet.rows[dataRowIndex] || [];
        const dataValues = dataRow.map(text);
        if (dataValues.some((value) => /^(?:注明|说明|报价包含|费用包含|报价不包含|费用不含|退改|取消)/.test(value.replace(/^[✅❌]\s*/u, "")))) break;
        const amount = numericAmount(dataValues[priceColumn]);
        if (!amount) continue;
        const offerIndex = result.priceOffers.length;
        const period = periodColumn >= 0 ? text(dataValues[periodColumn]) : "";
        const evidence = dataValues.filter(Boolean).filter((value, index) => !INTERNAL_COLUMN_HEADER.test(values[index]) && !INTERNAL_PATTERNS.some((pattern) => pattern.test(value)));
        result.priceOffers.push({ amount, period, sheet: sheet.name, address: XLSX.utils.encode_cell({ r: dataRowIndex, c: priceColumn }), sourceEvidence: evidence });
        dataValues.forEach((value, columnIndex) => {
          if (!value || INTERNAL_COLUMN_HEADER.test(values[columnIndex])) return;
          result.coverageTargets.push({ sheet: sheet.name, address: XLSX.utils.encode_cell({ r: dataRowIndex, c: columnIndex }), target: `sourceImportCoverage.priceOffers.${offerIndex}` });
        });
      }
    }
  }
  result.priceNotes = unique(result.priceNotes);
  const distinctOffers = unique(result.priceOffers.map((offer) => String(offer.amount))).map(Number);
  result.totalPrice = priceFrom(joined);
  if (distinctOffers.length) result.totalPrice = Math.min(...distinctOffers, ...(result.totalPrice ? [result.totalPrice] : []));
  if (distinctOffers.length > 1) result.warnings.push(`原文件存在 ${distinctOffers.length} 个不同档期价格；现有 totalPrice 仅展示起售价，逐档金额与有效期已保留在原始价格证据中，当前 schema 无法完整承载多档价格。`);
  return result;
}

function sentenceAround(source, index) {
  const start = Math.max(source.lastIndexOf("。", index - 1), source.lastIndexOf("；", index - 1), source.lastIndexOf("，", index - 1), source.lastIndexOf(",", index - 1), source.lastIndexOf("\n", index - 1)) + 1;
  const endings = [source.indexOf("。", index), source.indexOf("；", index), source.indexOf("，", index), source.indexOf(",", index), source.indexOf("\n", index)].filter((value) => value >= 0);
  const end = endings.length ? Math.min(...endings) : source.length;
  return text(source.slice(start, end));
}

function fullSentenceAround(source, index) {
  const start = Math.max(source.lastIndexOf("。", index - 1), source.lastIndexOf("；", index - 1), source.lastIndexOf("\n", index - 1)) + 1;
  const endings = [source.indexOf("。", index), source.indexOf("；", index), source.indexOf("\n", index)].filter((value) => value >= 0);
  const end = endings.length ? Math.min(...endings) : source.length;
  return text(source.slice(start, end));
}

function diningLocation(day = {}) {
  const raw = text(day.sourceEvidence?.route || day.city || "");
  const nodes = splitRouteNodes(raw).map((node) => node.replace(/(?:全天|半日)?(?:私人)?游猎$/i, "").trim()).filter(Boolean);
  return nodes.at(-1) || raw || "";
}

function diningStatus(evidence) {
  if (/可自费|自费参加|另行付费|费用不含|(?:本项|该体验|此体验|整项)[^。；]{0,10}(?:额外收费|另行收费)/i.test(evidence)) return "optional_paid";
  if (/需(?:要)?提前预约|须提前预约|预约制/i.test(evidence)) return "reservation_required";
  if (/待确认|以最终确认/i.test(evidence)) return "pending";
  return "included";
}

function statusPresentation(status) {
  return {
    statusLabel: status === "optional_paid" ? "自费可选" : status === "reservation_required" ? "需提前预约" : status === "pending" ? "待确认" : "已包含",
    feeBoundary: status === "optional_paid" ? "excluded" : status === "pending" ? "pending" : "included",
  };
}

function diningSubordination(source, matchIndex) {
  const before = source.slice(0, matchIndex);
  const openIndex = Math.max(before.lastIndexOf("（"), before.lastIndexOf("("));
  if (openIndex < 0) return null;
  const closing = source[openIndex] === "（" ? "）" : ")";
  const closeIndex = source.indexOf(closing, matchIndex);
  if (closeIndex < matchIndex) return null;
  const inside = text(source.slice(openIndex + 1, closeIndex));
  if (!/^(?:含|包含|包括|配有|附带)/.test(inside)) return null;
  const parentText = text(source.slice(Math.max(source.lastIndexOf("。", openIndex - 1), source.lastIndexOf("；", openIndex - 1), source.lastIndexOf("\n", openIndex - 1)) + 1, openIndex));
  if (!parentText) return null;
  return { parentExperience: parentText, evidence: text(source.slice(openIndex, closeIndex + 1)) };
}

function explicitlyIndependentDining(source, matchIndex) {
  const start = Math.max(source.lastIndexOf("。", matchIndex - 1), source.lastIndexOf("；", matchIndex - 1), source.lastIndexOf("\n", matchIndex - 1)) + 1;
  const endings = [source.indexOf("。", matchIndex), source.indexOf("；", matchIndex), source.indexOf("\n", matchIndex)].filter((value) => value >= 0);
  const end = endings.length ? Math.min(...endings) : source.length;
  const around = text(source.slice(start, end));
  return /(?:特别体验|特色餐饮|特色早餐|特色午餐|特色晚餐|独立安排|专门安排)/.test(around)
    && !diningSubordination(source, matchIndex);
}

function diningEmphasisScore(candidate) {
  const evidence = candidate.sourceEvidence.join(" ");
  const sentence = evidence.replace(/DAY\s*\d+\s*(?:详细行程|用餐)[：:]/gi, "");
  const sceneCount = (sentence.match(/天际甲板|甲板|观景台|野外|草原|丛林|海边|沙滩|篝火|酒窖|营地|餐厅/gi) || []).length;
  const actionCount = (sentence.match(/游猎结束后|返回营地|乘船|徒步结束后|现场烤制|品尝|享用|安排/gi) || []).length;
  return (candidate.explicitlyHighlighted ? 8 : 0)
    + Math.min(8, Math.floor(sentence.length / 12))
    + Math.min(6, sceneCount * 2)
    + Math.min(4, actionCount)
    + (candidate.status === "included" ? 2 : candidate.status === "reservation_required" ? 1 : 0)
    - (candidate.bundledWithOtherDining ? 14 : 0);
}

function diningDistinctionTags(candidate) {
  const source = candidate.sourceEvidence.join(" ");
  const definitions = [
    ["on_water", /乘船|船上|游船|水上/],
    ["after_walk", /徒步(?:结束|之后|后)/],
    ["after_game_drive", /游猎(?:结束|之后|后)/],
    ["deck_setting", /天际甲板|屋顶|观景台|露台/],
    ["fireside", /篝火|营火|boma/i],
    ["beach_setting", /海边|沙滩|海滩/],
    ["cellar_tasting", /私人酒窖|酒窖品酒|品鉴/],
    ["live_cooking", /现场(?:烤制|烹饪)|现烤/],
  ];
  return definitions.filter(([, pattern]) => pattern.test(source)).map(([tag]) => tag);
}

function meaningfullyDistinctDining(left, right) {
  if (!left.explicitlyHighlighted || !right.explicitlyHighlighted || left.bundledWithOtherDining || right.bundledWithOtherDining) return false;
  const leftTags = diningDistinctionTags(left);
  const rightTags = diningDistinctionTags(right);
  return leftTags.length > 0 && rightTags.length > 0 && leftTags.every((tag) => !rightTags.includes(tag)) && rightTags.every((tag) => !leftTags.includes(tag));
}

function selectDiningRepresentatives(candidates) {
  const selected = [];
  const excluded = [];
  const independent = candidates.filter((candidate) => {
    if (!candidate.isSubordinate) return true;
    excluded.push({ ...candidate, selectionDisposition: "excluded", exclusionReason: "attached_to_primary_experience" });
    return false;
  });
  const grouped = new Map();
  independent.forEach((candidate) => grouped.set(candidate.semanticType, [...(grouped.get(candidate.semanticType) || []), candidate]));
  for (const group of grouped.values()) {
    const ranked = [...group].sort((left, right) => diningEmphasisScore(right) - diningEmphasisScore(left) || left.sourceDay - right.sourceDay);
    const representatives = [];
    for (const candidate of ranked) {
      const sameTypeRepresentative = representatives.find((representative) => !meaningfullyDistinctDining(candidate, representative));
      if (sameTypeRepresentative) {
        excluded.push({
          ...candidate,
          selectionDisposition: "excluded",
          exclusionReason: "same_type_less_representative",
          selectedRepresentativeId: sameTypeRepresentative.id,
        });
      } else {
        representatives.push(candidate);
      }
    }
    selected.push(...representatives.map((candidate) => ({ ...candidate, selectionDisposition: "selected", selectionScore: diningEmphasisScore(candidate) })));
  }
  selected.sort((left, right) => left.sourceDay - right.sourceDay || left.discoveryOrder - right.discoveryOrder);
  excluded.sort((left, right) => left.sourceDay - right.sourceDay || left.discoveryOrder - right.discoveryOrder);
  return { selected, excluded };
}

function extractDiningExperiences(days) {
  const experiences = new Map();
  let discoveryOrder = 0;
  const add = ({ key, title, officialName = "", day, dayIndex, sourceLabel, source, matchIndex, evidenceText: suppliedEvidenceText = "" }) => {
    if (!title || ORDINARY_MEAL.test(title)) return;
    const evidenceText = suppliedEvidenceText || sentenceAround(source, matchIndex);
    const evidence = `DAY ${dayIndex + 1} ${sourceLabel}：${evidenceText || text(source)}`;
    const status = diningStatus(evidenceText || source);
    const priority = { included: 0, pending: 1, reservation_required: 2, optional_paid: 3 };
    const instanceKey = `${key}-day-${dayIndex + 1}`;
    const current = experiences.get(instanceKey);
    const geographicLocation = diningLocation(day);
    const useHotelLocation = text(day.hotel) && !/最终确认|待确认|飞机/.test(text(day.hotel)) && !/^restaurant-|champagne-breakfast/.test(key);
    const subordination = diningSubordination(source, matchIndex);
    const independentEmphasis = explicitlyIndependentDining(source, matchIndex);
    const otherDiningMatches = [
      /Bush\s*Breakfast|丛林早餐/i,
      /Sundowner|落日酒会/i,
      /星空(?:晚宴|晚餐)/i,
      /私人酒窖|酒窖品酒/i,
      /香槟早餐/i,
    ].filter((pattern) => pattern.test(evidenceText || "")).length;
    const next = current || {
      id: `imported-dining-${instanceKey}`,
      semanticType: key,
      title,
      officialName,
      location: useHotelLocation ? text(day.hotel) : geographicLocation,
      status,
      ...statusPresentation(status),
      dayRefs: [],
      sourceDay: dayIndex,
      discoveryOrder: discoveryOrder++,
      sourceEvidence: [],
      subordinateEvidence: [],
      independentEvidence: [],
      explicitlyHighlighted: false,
      bundledWithOtherDining: false,
      partialFeeEvidence: [],
      editorialCopy: "特色餐饮价值将在内容生成阶段依据原始事实完成客户表达。",
      images: [],
    };
    next.dayRefs = unique([...next.dayRefs.map(String), String(dayIndex + 1)]).map(Number).sort((a, b) => a - b);
    next.sourceEvidence = unique([...next.sourceEvidence, evidence]);
    if (subordination) next.subordinateEvidence = unique([...next.subordinateEvidence, `${subordination.parentExperience}${subordination.evidence}`]);
    if (independentEmphasis) next.independentEvidence = unique([...next.independentEvidence, evidence]);
    next.explicitlyHighlighted ||= independentEmphasis;
    next.bundledWithOtherDining ||= otherDiningMatches > 1;
    if (/(?:高档|高级|指定|升级)[^。；]{0,12}(?:额外收费|另行收费)/i.test(evidenceText || source)) {
      next.partialFeeEvidence = unique([...next.partialFeeEvidence, evidence]);
    }
    if (priority[status] > priority[next.status]) {
      next.status = status;
      Object.assign(next, statusPresentation(status));
    }
    experiences.set(instanceKey, next);
  };

  days.forEach((day, dayIndex) => {
    const sources = [
      { label: "详细行程", value: text(day.sourceEvidence?.description || day.description) },
      { label: "用餐", value: text(day.sourceEvidence?.meals || Object.values(day.mealPlan || {}).join("\n")) },
    ];
    for (const { label, value } of sources) {
      if (!value) continue;
      const definitions = [
        { key: "bush-breakfast", title: "Bush Breakfast 丛林早餐", officialName: "Bush Breakfast", pattern: /Bush\s*Breakfast(?:\s*丛林早餐)?|丛林早餐(?:\s*Bush\s*Breakfast)?/gi },
        { key: "sundowner", title: "Sundowner 落日酒会", officialName: "Sundowner", pattern: /Sundowner(?:\s*落日酒会)?|落日酒会(?:\s*Sundowner)?/gi },
        { key: "starlit-dinner", title: "星空晚宴", pattern: /星空(?:晚宴|晚餐)/g },
        { key: "private-wine-cellar", title: "私人酒窖品酒", pattern: /私人酒窖(?:品酒|品尝美酒)?|酒窖品酒/g },
        { key: "champagne-breakfast", title: "香槟早餐", pattern: /香槟早餐/g },
        { key: "special-dinner", title: "特别晚宴", pattern: /特别晚宴/g },
        { key: "outdoor-breakfast", title: "野外早餐", pattern: /野外早餐/g },
      ];
      for (const definition of definitions) {
        for (const match of value.matchAll(definition.pattern)) add({ ...definition, day, dayIndex, sourceLabel: label, source: value, matchIndex: match.index || 0 });
      }
      for (const match of value.matchAll(/(?:特色晚餐|晚餐(?:品尝|前往))\s*([^，。；\n]{0,24}?)(\b(?:The\s+)?[A-Z][A-Za-z'’&.-]+(?:\s+[A-Z][A-Za-z'’&.-]+){0,4}\b)/g)) {
        const officialName = text(match[2]);
        if (/^(?:Safari|Bush|Sundowner|Breakfast)$/i.test(officialName)) continue;
        const chineseName = text(match[1]);
        const title = text(`${chineseName} ${officialName}`);
        const matchIndex = (match.index || 0) + match[0].indexOf(officialName);
        add({ key: `restaurant-${officialName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title, officialName, day, dayIndex, sourceLabel: label, source: value, matchIndex, evidenceText: fullSentenceAround(value, matchIndex) });
      }
    }
  });
  const candidates = [...experiences.values()].map((candidate) => ({
    ...candidate,
    isSubordinate: candidate.subordinateEvidence.length > 0 && candidate.independentEvidence.length === 0,
  }));
  const selection = selectDiningRepresentatives(candidates);
  const customerExperiences = selection.selected.map((candidate) => {
    const { semanticType, discoveryOrder: _discoveryOrder, subordinateEvidence: _subordinateEvidence, independentEvidence: _independentEvidence, explicitlyHighlighted: _explicitlyHighlighted, bundledWithOtherDining: _bundledWithOtherDining, isSubordinate: _isSubordinate, partialFeeEvidence: _partialFeeEvidence, selectionDisposition: _selectionDisposition, selectionScore: _selectionScore, ...customer } = candidate;
    return customer;
  });
  return { candidates, selection, customerExperiences };
}

function explicitDayNotices(description, dayIndex) {
  const candidates = text(description)
    .split(/[。；;!?！？\n]+/)
    .map(text)
    .filter((item) => /(?:建议|可提前准备|提前准备|请提前|需提前|注意|携带|穿着|穿适合|准备.*(?:鞋|外套|衣物|装备|随身用品|雨具|防晒)|行李.*确认)/.test(item));
  if (!candidates.length) return [];
  const source = candidates[0];
  return [{ type: "tip", text: source, sourceKind: "source_explicit", sourceEvidence: [`DAY ${dayIndex + 1} 详细行程：${source}`] }];
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

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true, dense: true });
  const sheets = workbook.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false, blankrows: true });
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
    const internalColumns = new Set();
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex] || [];
      row.forEach((value, columnIndex) => { if (INTERNAL_COLUMN_HEADER.test(text(value))) internalColumns.add(columnIndex); });
      if (activeMap && row.some((value) => /(?:海报价格|起售价|报价参考|报价包含|费用包含|报价不包含|费用不含|退改|取消|注明)/.test(text(value).replace(/^[✅❌]\s*/u, "")))) activeMap = null;
      const candidateMap = headerMap(row);
      if ((candidateMap.day !== undefined || candidateMap.date !== undefined) && (candidateMap.description !== undefined || candidateMap.route !== undefined) && mapScore(candidateMap) >= 3) activeMap = candidateMap;
      const reverseMap = activeMap ? Object.fromEntries(Object.entries(activeMap).map(([key, column]) => [column, key])) : {};
      row.forEach((raw, columnIndex) => {
        const value = text(raw);
        if (!value) return;
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        const explicitTarget = explicitTargets.get(`${sheet.name}!${address}`);
        const internal = INTERNAL_PATTERNS.some((pattern) => pattern.test(value)) || (internalColumns.has(columnIndex) && !INTERNAL_COLUMN_HEADER.test(value));
        const mapped = reverseMap[columnIndex];
        let disposition = explicitTarget ? 'customer_field' : internal ? 'internal_retained' : mapped ? 'customer_field' : 'unrecognized';
        let target = explicitTarget || (internal ? 'audit.importCoverage' : mapped ? `days[].${mapped}` : '');
        if (HIGHLIGHT_HEADING.test(value)) { disposition = 'customer_field'; target = 'sourcePosterHighlights'; }
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
  const highlightExtraction = extractSourceHighlights(sheets);
  const explicitTargets = new Map();
  expenses.coverageTargets.forEach((item) => explicitTargets.set(`${item.sheet}!${item.address}`, item.target));
  highlightExtraction.coverageTargets.forEach((item) => explicitTargets.set(`${item.sheet}!${item.address}`, item.target));
  ["included", "excluded", "cancellation"].forEach((section) => expenses[section].forEach((item, index) => explicitTargets.set(`${item.sheet}!${item.address}`, `${section}.${index}`)));
  const joined = lines.join("\n");
  const priceFacts = extractPriceFacts(sheets, joined);
  priceFacts.coverageTargets.forEach((item) => explicitTargets.set(`${item.sheet}!${item.address}`, item.target));
  const cellCoverage = buildCellCoverage(sheets, explicitTargets);
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
    sourceEvidence: unique(days.flatMap((day, dayIndex) => day.hotel.includes(name) || name.includes(day.hotel) ? [`DAY ${dayIndex + 1} 住宿：${day.hotel}`, day.description] : [])).slice(0, 6),
    images: [],
  }));
  const highlights = highlightExtraction.items;
  const internalMatches = unique(lines.filter((line) => INTERNAL_PATTERNS.some((pattern) => pattern.test(line))));
  const diningExtraction = extractDiningExperiences(days);
  const diningExperiences = diningExtraction.customerExperiences;
  const totalPrice = priceFacts.totalPrice;
  const transportSummary = buildTransportSummary(days);
  const sourceImportCoverage = {
    workbookName: file.name,
    sourcePosterHighlights: highlightExtraction.evidence,
    included: expenses.included,
    excluded: expenses.excluded,
    cancellation: expenses.cancellation,
    priceOffers: priceFacts.priceOffers,
    dailyTransport: days.map((day, dayIndex) => ({ dayIndex, text: text(day.vehicle), sourceEvidence: day.vehicle ? [`DAY ${dayIndex + 1} 用车：${text(day.vehicle)}`] : [] })).filter((item) => item.text),
    diningCandidates: diningExtraction.candidates,
    diningSelection: {
      selected: diningExtraction.selection.selected.map((item) => ({ id: item.id, title: item.title, semanticType: item.semanticType, dayRefs: item.dayRefs, sourceEvidence: item.sourceEvidence, selectionScore: item.selectionScore })),
      excluded: diningExtraction.selection.excluded.map((item) => ({ id: item.id, title: item.title, semanticType: item.semanticType, dayRefs: item.dayRefs, sourceEvidence: item.sourceEvidence, exclusionReason: item.exclusionReason, selectedRepresentativeId: item.selectedRepresentativeId || null, subordinateEvidence: item.subordinateEvidence })),
    },
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
    adults: baseData?.adults ?? null,
    children: baseData?.children ?? null,
    travelers: null,
    heroImage: "",
    heroFocus: "50% 50%",
    sourcePosterHighlights: highlights,
    highlights: highlights.slice(0, 6),
    hotels,
    diningSectionTitle: "特色餐饮",
    diningExperiences,
    transportSummary,
    days,
    included: expenses.included.map((item) => item.text),
    excluded: expenses.excluded.map((item) => item.text),
    cancellation: expenses.cancellation.map((item) => item.text),
    sourceImportCoverage,
    totalPrice,
    priceUnit: priceFacts.priceUnit,
    priceNotes: priceFacts.priceNotes,
  });
  return {
    data: nextData,
    report: {
      workbookName: file.name,
      sheetNames: sheets.map((sheet) => sheet.name),
      dayCount: days.length,
      hotelCount: hotels.length,
      sourcePosterHighlightRawCount: highlightExtraction.rawEntries.length,
      highlightCount: highlights.length,
      includedCount: expenses.included.length,
      excludedCount: expenses.excluded.length,
      cancellationCount: expenses.cancellation.length,
      diningCandidateCount: diningExtraction.candidates.length,
      diningSubordinateExcludedCount: diningExtraction.selection.excluded.filter((item) => item.exclusionReason === "attached_to_primary_experience").length,
      diningRepresentativeExcludedCount: diningExtraction.selection.excluded.filter((item) => item.exclusionReason === "same_type_less_representative").length,
      diningCount: diningExperiences.length,
      diningSelection: sourceImportCoverage.diningSelection,
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
        ...priceFacts.warnings,
        sourceImportCoverage.dailyTransport.length > 0 && transportSummary.length === 0 && "原文件存在每日交通，但未形成交通汇总，生成已被阻止。",
        "图片将在内容生成阶段按图文对应与全图不重复规则补充。",
      ]).filter(Boolean),
    },
  };
}
