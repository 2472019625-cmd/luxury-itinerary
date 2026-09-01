export const MODEL_TASK_PROFILES = Object.freeze({
  mainline: Object.freeze({ reasoningEffort: "high", thinkingType: "enabled" }),
  brandReview: Object.freeze({ reasoningEffort: "high", thinkingType: "enabled" }),
  copyModule: Object.freeze({ reasoningEffort: "low", thinkingType: "enabled" }),
  imageBlueprint: Object.freeze({ reasoningEffort: "low", thinkingType: "enabled" }),
  targetedPatch: Object.freeze({ reasoningEffort: "low", thinkingType: "enabled" }),
  targetedPatchHigh: Object.freeze({ reasoningEffort: "high", thinkingType: "enabled" }),
  targetRecheck: Object.freeze({ reasoningEffort: "high", thinkingType: "enabled" }),
  mechanicalRepair: Object.freeze({ reasoningEffort: "low", thinkingType: "disabled" }),
});

export function modelTaskProfile(taskKind) {
  const profile = MODEL_TASK_PROFILES[taskKind];
  if (!profile) throw new Error(`未知模型任务类型：${taskKind}`);
  return { taskKind, ...profile };
}
