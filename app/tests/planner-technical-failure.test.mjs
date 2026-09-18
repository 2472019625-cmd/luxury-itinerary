import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDeepSeekJson } from "../server/deepseek-client.mjs";
import { buildAgentFactBasis, fingerprintFacts, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { runSimplePipeline } from "../server/simple-pipeline-executor.mjs";
import { copyRequestJson, createWorkbookFile, plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";

function sseResponse(content, finishReason = "stop") {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
      },
    },
    json: async () => ({}),
  };
}

test("Planner 纯语法修复后仍通过冻结业务 schema 校验", async () => {
  const factBasis = buildAgentFactBasis({
    destination: "坦桑尼亚",
    sourcePosterHighlights: ["Singita连住"],
    hotels: [{ id: "hotel-1", officialName: "Singita Faru Faru Lodge", region: "Grumeti" }],
    days: [{ route: "Grumeti", description: "抵达后进行游猎", spots: [] }],
  });
  const fixture = await plannerRequestJson({ delayMs: 0 })({ messages: [{ role: "user", content: JSON.stringify({ factBasis }) }] });
  const validRaw = JSON.stringify(fixture.json);
  const brokenRaw = validRaw.replace(',"modules":', ' "modules":');
  const project = { projectId: "planner-repair", inputFingerprint: fingerprintFacts(factBasis), factBasis, activePlanId: null, planIds: [] };
  const result = await generateAgentPlan({
    project,
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    simpleSkillContract: true,
    requestJson: (options) => requestDeepSeekJson({ ...options, fetchImpl: async () => sseResponse(brokenRaw), sleepImpl: async () => {} }),
  });
  assert.equal(result.plan.validation.passed, true);
  assert.equal(result.attempts[0].parseResult.status, "repaired_json");
  assert.ok(result.attempts[0].parseResult.operations.some((item) => item.type === "inserted_missing_comma"));
});

test("Planner 技术补救耗尽后失败开放，不进行第二次业务规划", async () => {
  const factBasis = buildAgentFactBasis({
    destination: "肯尼亚",
    sourcePosterHighlights: ["私家定制"],
    days: [{ route: "机场至市区", description: "抵达后入住" }],
  });
  let calls = 0;
  const result = await generateAgentPlan({
    project: { projectId: "planner-fail-open", inputFingerprint: fingerprintFacts(factBasis), factBasis, activePlanId: null, planIds: [] },
    simpleSkillContract: true,
    requestJson: async () => {
      calls += 1;
      throw Object.assign(new Error("模型没有返回完整JSON"), {
        code: "planner_json_invalid",
        attemptUsages: [
          { attempt: 1, outcome: "empty_content", thinkingType: "enabled" },
          { attempt: 2, outcome: "empty_content", thinkingType: "disabled" },
        ],
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].attemptUsages.length, 2);
  assert.equal(result.attempts[0].status, "failed_open");
  assert.equal(result.plan.validation.failOpen, true);
  assert.equal(result.plan.validation.correctionUsed, false);
  assert.equal(result.plan.validation.plannerBusinessRuns, 1);
  assert.equal(result.plan.validation.plannerModelCalls, 2);
  assert.equal(result.plan.validation.technicalRetryUsed, true);
  assert.equal(result.plan.capabilityCallStats.find((item) => item.capabilityId === "trip_planner")?.actualCalls, 2);
  assert.equal(result.plan.imagePlan.slots.length, 0);
});

test("Planner 恢复充足预算并只允许一次底层空答案补救", async () => {
  const factBasis = buildAgentFactBasis({
    destination: "肯尼亚",
    sourcePosterHighlights: ["私家定制"],
    days: [{ route: "保护区", description: "观察野生动物" }],
  });
  const fixture = plannerRequestJson({ delayMs: 0 });
  let businessInvocations = 0;
  const result = await generateAgentPlan({
    project: { projectId: "planner-technical-recovery", inputFingerprint: fingerprintFacts(factBasis), factBasis, activePlanId: null, planIds: [] },
    simpleSkillContract: true,
    requestJson: async (options) => {
      businessInvocations += 1;
      assert.equal(options.reasoningEffort, "high");
      assert.equal(options.maxTokens, 30000);
      assert.equal(options.emptyContentRetries, 1);
      const response = await fixture(options);
      return {
        ...response,
        attemptUsages: [
          { attempt: 1, outcome: "empty_content", thinkingType: "enabled" },
          { attempt: 2, outcome: "accepted", thinkingType: "disabled" },
        ],
      };
    },
  });
  assert.equal(businessInvocations, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.plan.validation.correctionUsed, false);
  assert.equal(result.plan.validation.plannerBusinessRuns, 1);
  assert.equal(result.plan.validation.plannerModelCalls, 2);
  assert.equal(result.plan.validation.technicalRetryUsed, true);
  assert.equal(result.plan.capabilityCallStats.find((item) => item.capabilityId === "trip_planner")?.actualCalls, 2);
});

test("真实 Pipeline 中 Planner 技术补救耗尽不触发业务重规划，Copy、Image 与 Step4 草稿继续", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "planner-pipeline-fail-open-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  let plannerCalls = 0;
  let knowledgeCalls = 0;
  let rendererCalls = 0;
  const result = await runSimplePipeline({
    sourceFile: createWorkbookFile(),
    root: path.resolve(import.meta.dirname, ".."),
    storeRoot: path.join(tempRoot, "projects"),
    plannerOptions: {
      requestJson: async () => {
        plannerCalls += 1;
        throw Object.assign(new Error("Planner 没有返回完整JSON"), {
          code: "planner_json_invalid",
          attemptUsages: [
            { attempt: 1, outcome: "empty_content", thinkingType: "enabled" },
            { attempt: 2, outcome: "empty_content", thinkingType: "disabled" },
          ],
        });
      },
    },
    copyOptions: { requestJson: copyRequestJson({ delayMs: 0 }) },
    imageOptions: {
      sourceMode: "knowledge_only",
      adapters: {
        searchKnowledgeImages: async () => { knowledgeCalls += 1; return { status: "completed", records: [], candidates: [] }; },
      },
    },
    adapters: {
      render: async ({ mode }) => {
        rendererCalls += 1;
        assert.equal(mode, "draft");
        return { status: "success", mode, outputPath: "planner-fail-open-draft.png", rendererCalls: 1 };
      },
    },
  });
  assert.equal(plannerCalls, 1);
  assert.equal(result.callCounts.plannerModelCalls, 2);
  assert.ok(result.callCounts.copyModelCalls > 0);
  assert.equal(knowledgeCalls, 0);
  assert.equal(rendererCalls, 1);
  assert.equal(result.render.mode, "draft");
  assert.notEqual(result.pipelineStatus, "failed");
  assert.ok(result.imageExecution.results.length > 0);
  assert.ok(result.imageExecution.results.every((item) => item.technicalStatus === "planner_slot_unresolved"));
  assert.ok(result.unresolvedItems.some((item) => item.kind === "image" && item.technicalStatus === "planner_slot_unresolved"));
});
