import assert from "node:assert/strict";
import test from "node:test";
import { calculateSimplePipelineProgress } from "../server/simple-pipeline-progress.mjs";

const runningWork = { parser: "complete", planner: "complete", copy_skill: "running", image_skill: "running", program_writeback: "pending", renderer: "pending" };

test("Copy 与 Image 的真实完成数共同连续推动总进度", () => {
  assert.equal(calculateSimplePipelineProgress({ stageStates: runningWork, copy: { completed: 0, total: 88 }, image: { completed: 0, total: 28 } }), 18);
  assert.equal(calculateSimplePipelineProgress({ stageStates: runningWork, copy: { completed: 41, total: 88 }, image: { completed: 1, total: 28 } }), 29);
  assert.equal(calculateSimplePipelineProgress({ stageStates: runningWork, copy: { completed: 88, total: 88 }, image: { completed: 17, total: 28 } }), 65);
  assert.equal(calculateSimplePipelineProgress({ stageStates: runningWork, copy: { completed: 88, total: 88 }, image: { completed: 18, total: 28 } }), 66);
  assert.equal(calculateSimplePipelineProgress({ stageStates: { ...runningWork, copy_skill: "complete", image_skill: "complete" }, copy: { completed: 88, total: 88 }, image: { completed: 28, total: 28 } }), 82);
});

test("合并、渲染和完成门禁只占最后区间", () => {
  const workComplete = { ...runningWork, copy_skill: "complete", image_skill: "complete" };
  assert.equal(calculateSimplePipelineProgress({ stageStates: { ...workComplete, program_writeback: "running" } }), 82);
  assert.equal(calculateSimplePipelineProgress({ stageStates: { ...workComplete, program_writeback: "complete", renderer: "running" } }), 94);
  assert.equal(calculateSimplePipelineProgress({ stageStates: { ...workComplete, program_writeback: "complete", renderer: "complete" } }), 99);
  assert.equal(calculateSimplePipelineProgress({ stageStates: { ...workComplete, program_writeback: "complete", renderer: "complete" }, pipelineComplete: true }), 100);
});
