export const AGENT_CAPABILITY_VERSION = "agent-capabilities-v1";

const capability = (id, mutablePaths, taskTypes, options = {}) => Object.freeze({
  id,
  allowedInputSchemas: options.inputs || ["agent.fact-snapshot.v1"],
  allowedOutputSchemas: options.outputs || [`agent.${id}.v1`],
  mutablePaths,
  forbiddenPaths: ["facts.*", "confirmedFacts.*", "runtime.port", "legacy.*"],
  reasoningPolicy: options.reasoning || "program",
  budgetKey: options.budgetKey || `agent.${id}.v1`,
  failureTypes: options.failureTypes || ["schema_invalid", "quality_failed"],
  retryLimit: options.retryLimit ?? 1,
  evidenceSchema: `agent.${id}.evidence.v1`,
  userStateMap: options.userStateMap || ["planning", "waiting", "failed"],
  taskTypes,
  actualInvocationAllowed: id === "source_parser" || id === "trip_planner",
});

export const AGENT_CAPABILITIES = Object.freeze([
  capability("source_parser", ["factsDraft.*", "sourceCoverage.*"], ["source_intake", "fact_review"]),
  capability("fact_validator", ["checks.*", "confirmations.*"], ["fact_review", "web_verification", "copy_review", "targeted_copy_repair"]),
  capability("human_confirmation", ["confirmations.*"], ["confirmation", "image_gap_resolution", "completion_gate"]),
  capability("trip_planner", ["plan.*"], ["journey_strategy", "module_strategy"] , { reasoning: "high", retryLimit: 1 }),
  capability("web_fact_search", ["verificationEvidence.*"], ["web_verification"], { reasoning: "medium" }),
  capability("copy_writer", ["customerCopy.*"], ["copy_global", "copy_hotel_transport", "copy_day_group", "copy_closing"], { reasoning: "low|medium|high" }),
  capability("brand_reviewer", ["copyReview.*"], ["copy_review", "targeted_copy_repair"], { reasoning: "high" }),
  capability("target_patcher", ["customerCopy.target"], ["targeted_copy_repair"], { reasoning: "low|high" }),
  capability("image_blueprint", ["imageBlueprint.*"], ["image_strategy", "image_slot_plan"], { reasoning: "medium|high" }),
  capability("image_search", ["imageCandidates.targetSlot"], ["image_search_plan"], { reasoning: "low" }),
  capability("visual_auditor", ["visualReview.targetSlot"], ["visual_review", "image_placement"], { reasoning: "medium" }),
  capability("layout_renderer", ["renderArtifacts.*"], ["layout_render"], { reasoning: "program" }),
  capability("final_qa", ["finalQa.*"], ["final_qa", "completion_gate"], { reasoning: "program|independent" }),
  capability("project_store", ["currentProject.*"], ["project_setup", "source_intake", "confirmation", "persistence", "image_placement", "image_gap_resolution", "completion_gate", "control"]),
  capability("task_cancel", ["currentProject.tasks.*.status"], ["control"]),
]);

export const AGENT_CAPABILITY_BY_ID = new Map(AGENT_CAPABILITIES.map((item) => [item.id, item]));
export const ACTUAL_INVOCATION_ALLOWLIST = Object.freeze(AGENT_CAPABILITIES.filter((item) => item.actualInvocationAllowed).map((item) => item.id));
