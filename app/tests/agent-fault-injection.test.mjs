import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateModularCopy } from "../server/modular-copy-generator.mjs";
import { copyUnitRuleCards } from "../server/agent-rule-cards.mjs";
import { runWithinStageBudget } from "../server/agent-execution-engine.mjs";
import { beginCapabilityCall, finishCapabilityCall } from "../server/agent-execution-scheduler.mjs";
import { createCopyUnitStore } from "../server/copy-unit-store.mjs";

const sourceFacts = { title: "坦桑尼亚2天1晚深度游", subtitle: "草原旅程", currentHighlights: ["草原节奏：两天体验各有重点"], destination: "坦桑尼亚", dayCount: 2, days: [{ index: 0, theme: "初见", description: "抵达草原", spots: [] }, { index: 1, theme: "深入", description: "继续游猎", spots: [] }], hotels: [], diningExperiences: [], transportSummary: [], included: [], excluded: [], cancellation: [], notes: [] };

function validOutput(payload) {
  if (payload.unitType === "global") return { title: sourceFacts.title, subtitle: sourceFacts.subtitle, highlights: sourceFacts.currentHighlights };
  if (payload.unitType === "days") return { days: payload.facts.days.map((day) => ({ index: day.index, theme: day.theme, description: day.description, spots: [], dayNotices: [] })), evidenceMap: {} };
  return { notes: [], expenseCopy: { included: [], excluded: [], cancellation: [] }, evidenceMap: {} };
}

test("合法JSON但字段结构错误时只做一次技术重试", async () => {
  let calls = 0;
  const result = await generateModularCopy({ sourceFacts, projectRoot: mkdtempSync(path.join(tmpdir(), "agent-invalid-")), jobId: "run-invalid", reuseCompleted: false, ruleCardsFor: copyUnitRuleCards, requestModel: async (_prompt, payload) => {
    calls += 1;
    if (payload.unitType === "global" && !payload.technicalCorrection) return { json: { wrong: true }, model: "test" };
    return { json: validOutput(payload), model: "test" };
  } });
  assert.equal(result.errors.length, 0);
  assert.equal(calls, 4);
});

test("中途失败后重新创建生成器只调用失败批次，已完成批次直接复用", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "agent-resume-"));
  let firstCalls = 0;
  const first = await generateModularCopy({ sourceFacts, projectRoot, jobId: "run-resume", reuseCompleted: true, ruleCardsFor: copyUnitRuleCards, requestModel: async (_prompt, payload) => {
    firstCalls += 1;
    if (payload.unitType === "days") throw new Error("模拟网络中断");
    return { json: validOutput(payload), model: "test" };
  } });
  assert.equal(first.errors.length, 1);
  let resumedCalls = 0;
  const resumed = await generateModularCopy({ sourceFacts, projectRoot, jobId: "run-resume", reuseCompleted: true, ruleCardsFor: copyUnitRuleCards, requestModel: async (_prompt, payload) => { resumedCalls += 1; return { json: validOutput(payload), model: "test" }; } });
  assert.equal(resumed.errors.length, 0);
  assert.ok(firstCalls >= 3);
  assert.equal(resumedCalls, 1);
});

test("断点写入失败会明确中断，修复存储后只重跑未落盘批次", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "agent-storage-resume-"));
  let injected = false;
  const failingStoreFactory = (root, jobId) => {
    const store = createCopyUnitStore(root, jobId);
    return { ...store, save(unit, input, result) {
      if (!injected && unit.id === "days-all" && result.status === "complete") {
        injected = true;
        const error = new Error("模拟磁盘写入失败");
        error.code = "storage_write_failed";
        throw error;
      }
      return store.save(unit, input, result);
    } };
  };
  await assert.rejects(() => generateModularCopy({ sourceFacts, projectRoot, jobId: "run-storage", reuseCompleted: true, ruleCardsFor: copyUnitRuleCards, storeFactory: failingStoreFactory, requestModel: async (_prompt, payload) => ({ json: validOutput(payload), model: "test" }) }), (error) => error.code === "storage_write_failed");
  let resumedCalls = 0;
  const resumed = await generateModularCopy({ sourceFacts, projectRoot, jobId: "run-storage", reuseCompleted: true, ruleCardsFor: copyUnitRuleCards, requestModel: async (_prompt, payload) => { resumedCalls += 1; return { json: validOutput(payload), model: "test" }; } });
  assert.equal(resumed.errors.length, 0);
  assert.equal(resumedCalls, 1);
});

test("单阶段超过停止线会中断并返回可解释错误", async () => {
  await assert.rejects(() => runWithinStageBudget("copy", (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })), { budgetOverride: { targetMs: 5, stopMs: 15 } }), (error) => error.code === "stage_timeout" && error.stage === "copy");
});

test("调用从开始记账，失败重试和耗时不会因最终失败丢失", () => {
  const plan = { tasks: [] };
  const run = { status: "running", taskRuns: [], progress: null, events: [], capabilityCallStats: [{ capabilityId: "copy_writer", actualCalls: 0, activeCalls: 0, completedCalls: 0, retries: 0, failures: 0, cancelled: 0, durationMs: 0 }] };
  const started = beginCapabilityCall(plan, run, "copy_writer", { callId: "call-1", stage: "copy", target: "days-all" });
  const failed = finishCapabilityCall(plan, started, "copy_writer", { callId: "call-1", stage: "copy", target: "days-all", failed: true, attemptCount: 2, durationMs: 1234, reason: "模拟网络失败" });
  const stats = failed.capabilityCallStats[0];
  assert.equal(stats.actualCalls, 2);
  assert.equal(stats.retries, 1);
  assert.equal(stats.failures, 1);
  assert.equal(stats.durationMs, 1234);
  assert.equal(stats.activeCalls, 0);
  assert.deepEqual(failed.events.map((item) => item.type), ["capability_call_started", "capability_call_finished"]);
});
