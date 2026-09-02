import { RULE_COVERAGE } from "./rule-coverage.mjs";

export const AGENT_RULE_PROFILE_VERSION = "agent-rules-v1";
export const AGENT_RULE_IDS = Object.freeze(RULE_COVERAGE.map((item) => item.id));
export const AGENT_RULE_ID_SET = new Set(AGENT_RULE_IDS);

export const GLOBAL_HARD_RULE_IDS = Object.freeze([
  "FLOW-002", "FLOW-004", "FLOW-005", "FLOW-007", "FLOW-009", "FLOW-010",
  "DATA-001", "DATA-003", "DATA-011", "DATA-012", "DATA-013", "DATA-014",
  "COPY-011", "IMG-001", "IMG-003", "IMG-008", "IMG-012", "IMG-018", "IMG-019", "IMG-020",
  "VIS-003", "VIS-016", "OPS-004", "OPS-005", "OPS-006", "OPS-010", "OPS-011", "OPS-012", "OPS-013",
]);

export const CHECKPOINT_IDS = Object.freeze(Array.from({ length: 20 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`));

export const RULE_GROUP_COUNTS = Object.freeze(AGENT_RULE_IDS.reduce((counts, id) => {
  const group = id.split("-")[0];
  counts[group] = (counts[group] || 0) + 1;
  return counts;
}, {}));
