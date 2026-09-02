export const AGENT_CAPABILITY_VERSION = "agent-capabilities-v2";

const professionalIds = new Set(["trip_planner", "web_fact_search", "copy_writer", "brand_reviewer", "image_search", "visual_auditor"]);

const capability = (id, provider, modelRef, mutablePaths, taskTypes, options = {}) => Object.freeze({
  id,
  kind: professionalIds.has(id) ? "professional" : "program",
  provider,
  modelRef,
  allowedInputSchemas: ["agent.fact-snapshot.v2"],
  allowedOutputSchemas: [`agent.${id}.v2`],
  mutablePaths,
  forbiddenPaths: ["facts.*", "confirmedFacts.*", "runtime.port", "legacy.*", "userLocks.*"],
  reasoningPolicy: options.reasoningPolicy ?? "deterministic",
  budgetKey: `agent.${id}.v2`,
  timeoutMs: options.timeoutMs ?? 120_000,
  failureTypes: options.failureTypes ?? ["timeout", "provider_error", "invalid_output", "rule_violation"],
  retryLimit: options.retryLimit ?? 0,
  evidenceSchema: `agent.${id}.evidence.v2`,
  userStateMap: options.userStateMap ?? { running: "处理中", waiting_confirmation: "等待确认", failed: "需要处理", complete: "已完成" },
  taskTypes,
  actualInvocationAllowed: options.actualInvocationAllowed !== false,
});

export const AGENT_CAPABILITIES = Object.freeze([
  capability("source_parser", "program", "deterministic-source-parser", ["factsDraft", "sourceCoverage"], ["source_intake"]),
  capability("fact_validator", "program", "deterministic-fact-validator", ["checks", "confirmations", "verificationEvidence", "copyReview"], ["fact_review", "web_verification", "copy_review", "targeted_copy_repair"]),
  capability("human_confirmation", "human", "user-confirmation", ["confirmations"], ["confirmation", "image_gap_resolution", "completion_gate"]),
  capability("trip_planner", "deepseek", "TEXT_MODEL_NAME", ["plan.summary", "plan.modules", "imagePlan"], ["journey_strategy", "module_strategy"], { reasoningPolicy: "high", timeoutMs: 180_000, retryLimit: 1 }),
  capability("web_fact_search", "vveai", "gemini-3.7-flash-search", ["verificationEvidence", "internalSuggestions"], ["web_verification"], { reasoningPolicy: "search_grounded", timeoutMs: 90_000, retryLimit: 1 }),
  capability("copy_writer", "deepseek", "TEXT_MODEL_NAME", ["customerCopy.global", "customerCopy.hotels", "customerCopy.transport", "customerCopy.days", "customerCopy.closing", "customerCopy.target"], ["copy_global", "copy_hotel_transport", "copy_day_group", "copy_closing", "targeted_copy_repair"], { reasoningPolicy: "medium_high", timeoutMs: 180_000, retryLimit: 1 }),
  capability("brand_reviewer", "deepseek", "TEXT_MODEL_NAME", ["copyReview"], ["copy_review"], { reasoningPolicy: "high", timeoutMs: 120_000, retryLimit: 0 }),
  capability("image_search", "program", "existing-image-search", ["imageCandidates"], ["image_search_plan"], { timeoutMs: 300_000, retryLimit: 1 }),
  capability("visual_auditor", "vision", "IMAGE_VISION_MODEL", ["visualReview"], ["visual_review"], { timeoutMs: 300_000, retryLimit: 1 }),
  capability("layout_renderer", "program", "existing-layout-renderer", ["renderArtifacts"], ["layout_render"]),
  capability("final_qa", "program", "deterministic-final-qa", ["finalQa"], ["final_qa", "completion_gate"]),
  capability("project_store", "program", "filesystem-project-store", ["project", "currentProject", "confirmations"], ["project_setup", "source_intake", "confirmation", "image_placement", "image_gap_resolution", "completion_gate", "control", "persistence"]),
  capability("task_cancel", "program", "abort-controller", ["currentProject"], ["control"]),
]);

export const PROFESSIONAL_CAPABILITIES = Object.freeze(AGENT_CAPABILITIES.filter((item) => item.kind === "professional"));
export const PROGRAM_CAPABILITIES = Object.freeze(AGENT_CAPABILITIES.filter((item) => item.kind !== "professional"));
export const AGENT_CAPABILITY_BY_ID = new Map(AGENT_CAPABILITIES.map((item) => [item.id, item]));
export const AGENT_CAPABILITY_ALLOWLIST = Object.freeze(AGENT_CAPABILITIES.map((item) => item.id));
export const ACTUAL_INVOCATION_ALLOWLIST = Object.freeze(AGENT_CAPABILITIES.filter((item) => item.actualInvocationAllowed).map((item) => item.id));
