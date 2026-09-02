import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewPacket, validateReviewDecisionBatch } from "../server/agent-review-decision.mjs";
import { decideAgentReviewFindings } from "../server/agent-trip-planner.mjs";

function packetFor(stage = "copy", overrides = {}) {
  return buildReviewPacket({ stage, findings: [{ findingId: "f1", targetId: "days.0.description", path: "days.0.description", issueLevel: "hard", code: "unsupported_fact", message: "缺少依据", sourceBasis: "原始行程", allowedCapabilities: ["copy_writer"], remainingAttempts: 1, ...overrides }], sourceFacts: { days: [{ description: "原始行程" }] }, availableCapabilities: ["copy_writer", "image_search"] });
}

function decisionFor(finding, action, overrides = {}) {
  return { findingId: finding.findingId, targetId: finding.targetId, action, finalJudgment: action === "request_user_confirmation" ? "needs_user_decision" : action === "preserve_supported" ? "not_established" : "established", reason: "测试决定", evidenceRefs: [], ruleIds: [finding.ruleIds[0]], allowedTarget: finding.path, forbiddenChanges: ["其他目标"], recheckTargets: ["targeted_retry", "invoke_capability", "adjust_scope_or_strength"].includes(action) ? [finding.path] : [], consumesBusinessRetry: ["targeted_retry", "invoke_capability"].includes(action), proposedChanges: [], ...overrides };
}

test("审核决定必须覆盖同一批次且不能扩大修改范围", () => {
  const packet = packetFor();
  const result = validateReviewDecisionBatch(packet, { decisions: [decisionFor(packet.findings[0], "targeted_retry", { proposedChanges: [{ path: "days.1.description", value: "越界" }] })] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "change_out_of_scope"));
});

test("硬问题没有证据不能被驳回，必需图片也不能被降级放行", () => {
  const copyPacket = packetFor();
  assert.equal(validateReviewDecisionBatch(copyPacket, { decisions: [decisionFor(copyPacket.findings[0], "preserve_supported")] }).valid, false);
  const imagePacket = packetFor("images", { targetId: "cover:hero", path: "cover:hero", code: "required_image_missing", required: true, allowedCapabilities: ["image_search"] });
  const imageResult = validateReviewDecisionBatch(imagePacket, { decisions: [decisionFor(imagePacket.findings[0], "preserve_supported", { evidenceRefs: ["source:f1"] })] });
  assert.equal(imageResult.valid, false);
  assert.ok(imageResult.errors.some((item) => item.code === "required_image_cannot_be_bypassed"));
});

test("同一批审核结果只调用总智能体一次，纯技术失败只额外重试一次", async () => {
  const packet = packetFor();
  let calls = 0;
  const requestJson = async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary network failure");
    return { json: { summary: "局部修复", decisions: [decisionFor(packet.findings[0], "targeted_retry")] }, model: "test", usage: null, attemptUsages: [{}] };
  };
  const result = await decideAgentReviewFindings({ packet, requestJson });
  assert.equal(calls, 2);
  assert.equal(result.callCount, 2);
  assert.equal(result.validation.valid, true);
});

test("没有审核问题时不调用总智能体", async () => {
  let calls = 0;
  const packet = buildReviewPacket({ stage: "copy", findings: [] });
  const result = await decideAgentReviewFindings({ packet, requestJson: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.callCount, 0);
});

test("用户锁定事实不能被目标重试或专业能力覆盖", () => {
  const packet = buildReviewPacket({ stage: "copy", findings: [{ findingId: "locked", targetId: "days.0.hotel", path: "days.0.hotel", issueLevel: "hard", message: "审核质疑酒店", allowedCapabilities: ["copy_writer"], remainingAttempts: 1 }], sourceFacts: { days: [{ hotel: "Singita" }] }, userConfirmedFacts: [{ confirmationId: "u1", affectedPaths: ["days.0.hotel"], selectedChoiceId: "confirm" }], availableCapabilities: ["copy_writer"] });
  const result = validateReviewDecisionBatch(packet, { decisions: [decisionFor(packet.findings[0], "invoke_capability", { capabilityId: "copy_writer" })] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "user_lock_violation"));
});

test("原始资料明确存在的常见实体可用真实来源驳回机械误判", () => {
  for (const term of ["餐厅", "泳池", "营地", "帐篷营地", "渡河"]) {
    const packet = buildReviewPacket({ stage: "copy", findings: [{ findingId: `term-${term}`, targetId: "days.0.description", path: "days.0.description", issueLevel: "hard", message: `审核称${term}无依据`, sourceBasis: `原始资料明确写有${term}` }], sourceFacts: { days: [{ description: `安排${term}相关体验` }] } });
    const result = validateReviewDecisionBatch(packet, { decisions: [decisionFor(packet.findings[0], "preserve_supported", { evidenceRefs: [`source:${packet.findings[0].findingId}`] })] });
    assert.equal(result.valid, true, term);
  }
});
