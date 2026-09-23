export const SIMPLE_PIPELINE_PROGRESS = Object.freeze({
  initial: 1,
  parserComplete: 8,
  plannerComplete: 18,
  copyWeight: 20,
  imageWeight: 44,
  workComplete: 82,
  writebackComplete: 94,
  rendererComplete: 99,
  complete: 100,
});

function fraction(progress = {}, complete = false) {
  const total = Math.max(0, Number(progress.total) || 0);
  const completed = Math.max(0, Number(progress.completed) || 0);
  if (!total) return complete ? 1 : 0;
  return Math.min(1, completed / total);
}

export function calculateSimplePipelineProgress({ stageStates = {}, copy = {}, image = {}, pipelineComplete = false } = {}) {
  if (pipelineComplete) return SIMPLE_PIPELINE_PROGRESS.complete;
  let target = SIMPLE_PIPELINE_PROGRESS.initial;
  if (["running", "complete", "failed"].includes(stageStates.parser)) target = Math.max(target, 1);
  if (stageStates.parser === "complete") target = SIMPLE_PIPELINE_PROGRESS.parserComplete;
  if (["running", "complete", "failed"].includes(stageStates.planner)) target = Math.max(target, SIMPLE_PIPELINE_PROGRESS.parserComplete);
  if (stageStates.planner === "complete") target = SIMPLE_PIPELINE_PROGRESS.plannerComplete;

  const workStarted = ["running", "complete"].includes(stageStates.copy_skill) || ["running", "complete"].includes(stageStates.image_skill);
  if (workStarted) {
    target = SIMPLE_PIPELINE_PROGRESS.plannerComplete
      + SIMPLE_PIPELINE_PROGRESS.copyWeight * fraction(copy, stageStates.copy_skill === "complete")
      + SIMPLE_PIPELINE_PROGRESS.imageWeight * fraction(image, stageStates.image_skill === "complete");
  }
  if (["running", "complete"].includes(stageStates.program_writeback)) target = Math.max(target, SIMPLE_PIPELINE_PROGRESS.workComplete);
  if (stageStates.program_writeback === "complete") target = Math.max(target, SIMPLE_PIPELINE_PROGRESS.writebackComplete);
  if (["running", "complete"].includes(stageStates.renderer)) target = Math.max(target, SIMPLE_PIPELINE_PROGRESS.writebackComplete);
  if (stageStates.renderer === "complete") target = Math.max(target, SIMPLE_PIPELINE_PROGRESS.rendererComplete);
  return Math.min(SIMPLE_PIPELINE_PROGRESS.rendererComplete, Math.round(target));
}
