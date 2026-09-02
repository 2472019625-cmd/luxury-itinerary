import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");
const ruleFiles = [
  "01-产品流程与完成状态.md",
  "02-数据事实与字段映射.md",
  "03-品牌文案与模块内容.md",
  "04-图片搜索与使用规范.md",
  "05-模板版式与品牌资产.md",
  "06-技术运行与文件保存.md",
];

const documents = ruleFiles.map((file) => ({ file, content: readFileSync(path.join(projectRoot, "rules", file), "utf8") }));

function extractDetailedSection(content, ruleId) {
  const start = new RegExp(`^###\\s+${ruleId}[^\\n]*`, "m").exec(content);
  if (!start) return "";
  const tail = content.slice(start.index + start[0].length);
  const next = /^#{2,3}\s+/m.exec(tail);
  return `${start[0]}${next ? tail.slice(0, next.index) : tail}`.trim();
}

function extractTableRow(content, ruleId) {
  return content.split(/\r?\n/).find((line) => line.startsWith(`| ${ruleId} |`))?.trim() || "";
}

export function fullRuleCardsFor(ruleIds = []) {
  return [...new Set(ruleIds)].map((ruleId) => {
    const source = documents.find((document) => document.content.includes(`| ${ruleId} |`) || document.content.includes(`### ${ruleId}`));
    if (!source) throw new Error(`未找到正式规则卡：${ruleId}`);
    const tableRule = extractTableRow(source.content, ruleId);
    const details = extractDetailedSection(source.content, ruleId);
    if (!tableRule) throw new Error(`正式规则表缺少：${ruleId}`);
    return { ruleId, ruleProfileVersion: AGENT_RULE_PROFILE_VERSION, sourceFile: `rules/${source.file}`, tableRule, details };
  });
}

const COPY_UNIT_RULES = Object.freeze({
  mainline: ["DATA-001", "DATA-011", "DATA-012", "COPY-001", "COPY-002", "COPY-006", "COPY-010", "COPY-011", "COPY-015", "COPY-017"],
  global: ["DATA-001", "DATA-011", "DATA-012", "COPY-001", "COPY-002", "COPY-003", "COPY-004", "COPY-005", "COPY-011", "COPY-015", "COPY-017"],
  hospitality: ["DATA-001", "DATA-011", "DATA-012", "COPY-001", "COPY-007", "COPY-008", "COPY-009", "COPY-011", "COPY-015", "COPY-017"],
  hotels: ["DATA-001", "DATA-012", "COPY-001", "COPY-007", "COPY-015", "COPY-017"],
  dining: ["DATA-001", "DATA-009", "DATA-012", "COPY-001", "COPY-008", "COPY-015", "COPY-017"],
  transport: ["DATA-001", "DATA-008", "DATA-012", "COPY-001", "COPY-009", "COPY-015", "COPY-017"],
  days: ["DATA-001", "DATA-011", "DATA-012", "COPY-001", "COPY-006", "COPY-010", "COPY-011", "COPY-012", "COPY-015", "COPY-017"],
  closing: ["DATA-001", "DATA-011", "DATA-012", "COPY-001", "COPY-013", "COPY-014", "COPY-015", "COPY-016", "COPY-017"],
  brand_review: ["DATA-001", "DATA-011", "DATA-012", ...Array.from({ length: 17 }, (_, index) => `COPY-${String(index + 1).padStart(3, "0")}`)],
});

export function copyUnitRuleCards(unitType) {
  return fullRuleCardsFor(COPY_UNIT_RULES[unitType] || COPY_UNIT_RULES.mainline);
}
