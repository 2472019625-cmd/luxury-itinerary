import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Simple Pipeline 调度图不导入或调用旧审核、重生成和业务重搜入口", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = [
    "server/simple-pipeline-executor.mjs",
    "server/simple-plan-adapter.mjs",
    "server/simple-pipeline-writeback.mjs",
    "server/simple-renderer.mjs",
  ];
  const source = (await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
  const forbiddenRuntimeSymbols = [
    "decideAgentReviewFindings",
    "buildReviewFindingPackage",
    "reviewFinalLayout",
    "runTargetedCopyRepairBatch",
    "runSlotResearch",
    "stageBudget",
  ];
  for (const symbol of forbiddenRuntimeSymbols) assert.equal(source.includes(symbol), false, `新调度图不应引用 ${symbol}`);
  assert.equal(/\.slice\(0,\s*48\)/.test(source), false, "图片位不得静默截断到48");
});
