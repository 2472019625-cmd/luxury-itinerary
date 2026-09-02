import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateModularCopy } from "../server/modular-copy-generator.mjs";
import { copyUnitRuleCards, fullRuleCardsFor } from "../server/agent-rule-cards.mjs";
import { createAgentCopyModelRequester } from "../server/agent-copy-engine.mjs";

test("正式规则卡同时包含规则表原文、运行细则和版本", () => {
  const [card] = fullRuleCardsFor(["COPY-010"]);
  assert.equal(card.ruleId, "COPY-010");
  assert.match(card.tableRule, /每日固定阅读顺序/);
  assert.match(card.details, /### COPY-010/);
  assert.match(card.sourceFile, /03-品牌文案/);
  assert.ok(card.ruleProfileVersion);
});

test("每个模块调用都收到适用的完整正式规则卡", async () => {
  const seen = [];
  const sourceFacts = {
    destination: "肯尼亚", dayCount: 1, days: [{ index: 0, theme: "草原初见", description: "进入保护区", spots: [] }],
    hotels: [], diningExperiences: [], transportSummary: [], included: [], excluded: [], cancellation: [],
  };
  const requestModel = async (_promptFile, payload, options) => {
    seen.push({ taskKind: options.taskKind, cards: payload.applicableRuleCards || [] });
    if (options.taskKind === "mainline") return { json: { journeyPromise: "草原初见", narrativeArc: [], moduleGoals: {}, dayRoles: [], visualRoles: [], sourceEvidence: [] }, model: "test" };
    if (payload.unitType === "global") return { json: { title: "肯尼亚1天0晚深度游", subtitle: "从草原初见展开旅程", highlights: ["草原初见：进入保护区"] }, model: "test" };
    if (payload.unitType === "hospitality") return { json: { hotels: [], diningExperiences: [], transportSummary: [], evidenceMap: {} }, model: "test" };
    if (payload.unitType === "days") return { json: { days: [{ index: 0, theme: "草原初见", description: "进入保护区，建立对草原的第一印象。", spots: [], dayNotices: [] }], evidenceMap: {} }, model: "test" };
    return { json: { notes: [], expenseCopy: { included: [], excluded: [], cancellation: [] }, evidenceMap: {} }, model: "test" };
  };
  const result = await generateModularCopy({ sourceFacts, requestModel, projectRoot: mkdtempSync(path.join(tmpdir(), "agent-copy-")), jobId: "run-1", reuseCompleted: false, ruleCardsFor: copyUnitRuleCards });
  assert.equal(result.errors.length, 0);
  assert.equal(seen.length, 5);
  assert.ok(seen.every((item) => item.cards.length > 0));
  assert.ok(seen.flatMap((item) => item.cards).every((card) => card.tableRule && card.ruleProfileVersion));
});

test("同一copy_writer请求器复用既定文字模型并支持取消信号", async () => {
  const controller = new AbortController();
  let captured;
  const request = createAgentCopyModelRequester({ apiKey: "test", baseUrl: "https://text.example/v1", model: "deepseek-test", signal: controller.signal, requestJson: async (options) => { captured = options; return { json: {}, model: options.model }; } });
  await request("agent-copy-target-regenerate-v1.md", { targetContext: { target: { key: "day:0" } } }, { reasoningEffort: "medium" });
  assert.equal(captured.model, "deepseek-test");
  assert.equal(captured.reasoningEffort, "medium");
  assert.equal(captured.signal, controller.signal);
  assert.match(captured.messages[0].content, /同一位高级旅行产品编辑/);
});

test("智能体文案模块共享限流队列，避免长行程同时压满文字模型", async () => {
  let active = 0;
  let peak = 0;
  const request = createAgentCopyModelRequester({
    apiKey: "test",
    baseUrl: "https://text.example/v1",
    model: "deepseek-test",
    requestJson: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return { json: {}, model: "deepseek-test" };
    },
  });
  await Promise.all(Array.from({ length: 6 }, (_, index) => request("customer-itinerary-module-v1.md", { index }, { taskId: `agent-copy-${index}` })));
  assert.ok(peak <= 2);
});
