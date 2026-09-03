import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDeepSeekJson } from "../server/deepseek-client.mjs";
import { buildAgentFactBasis, fingerprintFacts, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { runSimplePipeline } from "../server/simple-pipeline-executor.mjs";
import { createWorkbookFile, plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";

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

test("Planner 技术重试耗尽后落盘 failed/final-result，且下游保持未启动", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "planner-terminal-failure-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const storeRoot = path.join(tempRoot, "projects");
  const downstreamCalls = { copy: 0, image: 0, renderer: 0 };
  let failure;
  try {
    await runSimplePipeline({
      sourceFile: createWorkbookFile(),
      storeRoot,
      adapters: {
        planAgent: async ({ onModelAttempt }) => {
          await onModelAttempt({ attempt: 1, rawContent: '{"summary":"broken-1', parseResult: { status: "invalid_json", repaired: false, operations: [], parseError: "unterminated string", repairError: "没有可确定执行的纯语法修复" } });
          await onModelAttempt({ attempt: 2, rawContent: '{"summary":"broken-2', parseResult: { status: "invalid_json", repaired: false, operations: [], parseError: "unterminated string", repairError: "没有可确定执行的纯语法修复" } });
          const error = new Error("DeepSeek 接口连续 2 次未返回完整合法JSON");
          error.code = "planner_json_invalid";
          error.attemptUsages = [{ attempt: 1 }, { attempt: 2 }];
          throw error;
        },
        runCopy: async () => { downstreamCalls.copy += 1; },
        runImage: async () => { downstreamCalls.image += 1; },
        render: async () => { downstreamCalls.renderer += 1; },
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(failure.projectId);
  assert.ok(failure.finalResultRef?.endsWith("final-result.json"));
  assert.deepEqual(downstreamCalls, { copy: 0, image: 0, renderer: 0 });
  const projectDir = path.join(storeRoot, failure.projectId);
  const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
  const finalResult = JSON.parse(await readFile(path.join(projectDir, failure.finalResultRef), "utf8"));
  assert.equal(project.status, "failed");
  assert.equal(project.currentStage, "Planner failure");
  assert.equal(project.errorCode, "planner_json_invalid");
  assert.equal(finalResult.pipelineStatus, "failed");
  assert.equal(finalResult.unresolvedItems[0].error.code, "planner_system_failure");
  assert.deepEqual(finalResult.stageStatus, { parser: "success", planner: "failed", copy: "not_started", image: "not_started", programWriteback: "not_started", renderer: "not_started" });
  assert.equal(finalResult.callCounts.plannerModelCalls, 2);
  assert.equal(finalResult.callCounts.copyModelCalls, 0);
  assert.equal(finalResult.callCounts.imageSearchCalls, 0);
  assert.equal(finalResult.callCounts.rendererCalls, 0);
  assert.equal(await readFile(path.join(projectDir, "planner-attempts", "planner-attempt-1-raw.txt"), "utf8"), '{"summary":"broken-1');
  assert.equal(await readFile(path.join(projectDir, "planner-attempts", "planner-attempt-2-raw.txt"), "utf8"), '{"summary":"broken-2');
  const parseRecord = JSON.parse(await readFile(path.join(projectDir, "planner-attempts", "planner-attempt-2-parse.json"), "utf8"));
  assert.equal(parseRecord.parseResult.status, "invalid_json");
});
