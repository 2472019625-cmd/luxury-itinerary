import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSourceContentPlacement, generateModularCopy, splitDayBatches } from "../server/modular-copy-generator.mjs";
import { copyUnitRuleCards, fullRuleCardsFor } from "../server/agent-rule-cards.mjs";
import { applyAgentDeterministicHardCorrections, createAgentCopyModelRequester, groupRepairTargets, isHardBrandIssue, normalizeCustomerCopyPath, partitionAgentBrandIssues, planAgentHardRepairs } from "../server/agent-copy-engine.mjs";

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
    if (payload.unitType === "global") return { json: { title: "肯尼亚1天0晚深度游", subtitle: "从草原初见展开旅程", highlights: ["草原初见：进入保护区"] }, model: "test" };
    if (payload.unitType === "hospitality") return { json: { hotels: [], diningExperiences: [], transportSummary: [], evidenceMap: {} }, model: "test" };
    if (payload.unitType === "days") return { json: { days: [{ index: 0, theme: "草原初见", description: "进入保护区，建立对草原的第一印象。", spots: [], dayNotices: [] }], evidenceMap: {} }, model: "test" };
    return { json: { notes: [], expenseCopy: { included: [], excluded: [], cancellation: [] }, evidenceMap: {} }, model: "test" };
  };
  const result = await generateModularCopy({ sourceFacts, requestModel, projectRoot: mkdtempSync(path.join(tmpdir(), "agent-copy-")), jobId: "run-1", reuseCompleted: false, ruleCardsFor: copyUnitRuleCards });
  assert.equal(result.errors.length, 0);
  assert.equal(seen.length, 3);
  assert.equal(seen.some((item) => item.taskKind === "mainline"), false);
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

test("标准10日DAY一次成批，超过稳定上限才在发送前拆组", () => {
  const days = Array.from({ length: 11 }, (_, index) => ({ index, description: `DAY ${index + 1}` }));
  assert.equal(splitDayBatches(days.slice(0, 10)).length, 1);
  const first = splitDayBatches(days);
  const second = splitDayBatches(structuredClone(days));
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((item) => item.days.map((day) => day.index)), second.map((item) => item.days.map((day) => day.index)));
  assert.ok(first.every((item) => item.splitReason));
});

test("原始内容先确定性归位再决定保留或生成", () => {
  const placement = buildSourceContentPlacement({ title: "标题", days: [{ index: 0, routeNodes: ["A", "B"], estimatedTravelTime: "2小时", hotel: "H", description: "当天正文", spots: [] }], hotels: [{ officialName: "H" }], transportSummary: [{ category: "专车" }], included: ["住宿"], excluded: [], cancellation: [] }, { modules: [{ moduleId: "days", contentAction: "preserve" }, { moduleId: "transport", contentAction: "optimize" }, { moduleId: "hotels", contentAction: "preserve" }, { moduleId: "expenses", contentAction: "preserve" }] });
  assert.ok(placement.entries.some((item) => item.sourceRef === "days.0.estimatedTravelTime" && item.targetModule === "transport"));
  assert.ok(placement.entries.some((item) => item.sourceRef === "days.0.description" && item.targetModule === "days" && item.action === "preserve"));
});

test("直接保留模块不调用模型且轻量规划不再二次生成整程主线", async () => {
  let calls = 0;
  const sourceFacts = { title: "坦桑尼亚1天0晚深度游", subtitle: "原文", currentHighlights: ["原文亮点"], destination: "坦桑尼亚", dayCount: 1, days: [{ index: 0, theme: "抵达", description: "原文正文", spots: [] }], hotels: [], diningExperiences: [], transportSummary: [], included: [], excluded: [], cancellation: [], notes: [] };
  const businessPlan = { summary: { contentTheme: "轻量主线" }, modules: ["global", "days", "notes", "expenses"].map((moduleId) => ({ moduleId, decision: "show", contentAction: "preserve" })) };
  const result = await generateModularCopy({ sourceFacts, businessPlan, requestModel: async () => { calls += 1; throw new Error("不应调用"); }, projectRoot: mkdtempSync(path.join(tmpdir(), "agent-preserve-")), jobId: "run-preserve", reuseCompleted: false, ruleCardsFor: copyUnitRuleCards });
  assert.equal(calls, 0);
  assert.equal(result.mainline.generatedBy, "trip_planner");
  assert.equal(result.draft.days[0].description, "原文正文");
});

test("品牌目标路径会先归一且同模块问题合并为一次重生成批次", () => {
  assert.equal(normalizeCustomerCopyPath("firstDraft.subtitle"), "subtitle");
  assert.equal(normalizeCustomerCopyPath("customerCopy.days.2.description"), "days.2.description");
  const batches = groupRepairTargets([
    { key: "day:0", kind: "day" }, { key: "day:1", kind: "day" }, { key: "hotel:0", kind: "hotel" }, { key: "field:subtitle", kind: "field" },
  ]);
  assert.equal(batches.length, 3);
  assert.equal(batches.find((item) => item.key === "days").targets.length, 2);
});

test("DAY直接保留可以和其余DAY单批生成同时成立", async () => {
  const sourceFacts = { title: "肯尼亚10天9晚深度游", subtitle: "原文", currentHighlights: ["原文亮点"], destination: "肯尼亚", dayCount: 10, days: Array.from({ length: 10 }, (_, index) => ({ index, theme: `原主题${index + 1}`, description: `原文DAY ${index + 1}`, spots: [] })), hotels: [], diningExperiences: [], transportSummary: [], included: [], excluded: [], cancellation: [], notes: [] };
  const businessPlan = {
    summary: { contentTheme: "轻量主线" },
    modules: ["global", "hotels", "dining", "transport", "notes", "expenses"].map((moduleId) => ({ moduleId, decision: "show", contentAction: "preserve" })).concat({ moduleId: "days", decision: "show", contentAction: "optimize" }),
    dayRoles: Array.from({ length: 10 }, (_, index) => ({ index, role: `DAY ${index + 1}`, contentAction: [0, 9].includes(index) ? "preserve" : "optimize" })),
  };
  const calls = [];
  const result = await generateModularCopy({ sourceFacts, businessPlan, requestModel: async (_prompt, payload) => {
    calls.push(payload.facts.days.map((day) => day.index));
    return { json: { days: payload.facts.days.map((day) => ({ index: day.index, theme: `新主题${day.index + 1}`, description: `新文案DAY ${day.index + 1}`, spots: [], dayNotices: [] })), evidenceMap: {} }, model: "test" };
  }, projectRoot: mkdtempSync(path.join(tmpdir(), "agent-day-preserve-")), jobId: "run-day-preserve", reuseCompleted: false, ruleCardsFor: copyUnitRuleCards });
  assert.deepEqual(calls, [[1, 2, 3, 4, 5, 6, 7, 8]]);
  assert.equal(result.draft.days[0].description, "原文DAY 1");
  assert.equal(result.draft.days[9].description, "原文DAY 10");
  assert.equal(result.draft.days[4].description, "新文案DAY 5");
  assert.equal(result.unitSummary.preservedDayCount, 2);
});

test("软建议不会触发重生成，直接保留内容只有硬问题才能解锁", () => {
  const issues = [
    { code: "day_overlong", issueLevel: "hard", ruleIds: ["COPY-010"], path: "days.0.description", targetModule: "days", sourceBasis: "字数统计", suggestedAction: "targeted_rewrite", modificationScope: "days.0.description", message: "略超建议字数" },
    { code: "unsupported_promise", severity: "safety", action: "block", ruleIds: ["COPY-015"], path: "days.0.description", targetModule: "days", sourceBasis: "原始资料没有保证", suggestedAction: "targeted_rewrite", modificationScope: "days.0.description", message: "无依据保证一定看到动物" },
  ];
  assert.equal(isHardBrandIssue(issues[0]), false);
  assert.equal(isHardBrandIssue(issues[1]), true);
  const partition = partitionAgentBrandIssues(issues, [{ path: "days.0", reason: "用户明确满意", confirmedByUser: true }]);
  assert.equal(partition.optimizationSuggestions.length, 0);
  assert.equal(partition.hardIssues.length, 1);
  assert.equal(partition.hardIssues[0].lockOverride, true);
  const repairs = planAgentHardRepairs(partition.hardIssues);
  assert.equal(repairs.blockers.length, 0);
  assert.equal(repairs.targets.length, 1);
});

test("总智能体批准调整表达强度后，程序只对命中路径做最小安全修正", () => {
  const sourceData = {
    hotels: [{ officialName: "Nimali Tarangire", shortName: "Nimali Tarangire", proofPoints: ["塔兰吉雷国家公园行程"], sourceEvidence: ["入住 Nimali Tarangire"] }],
    days: [], transportSummary: [], diningExperiences: [], included: [], excluded: [], cancellation: [], notes: [],
  };
  const data = { ...sourceData, hotels: [{ ...sourceData.hotels[0], editorialCopy: "入住 Nimali Tarangire 营地。", proofPoints: ["塔兰吉雷国家公园行程", "营地星空"] }] };
  const issues = [
    { code: "factual_sentence_without_evidence", issueLevel: "hard", path: "hotels.0.editorialCopy" },
    { code: "factual_sentence_without_evidence", issueLevel: "hard", path: "hotels.0.proofPoints" },
  ];
  const corrected = applyAgentDeterministicHardCorrections(data, sourceData, issues);
  assert.equal(corrected.data.hotels[0].editorialCopy.includes("营地"), false);
  assert.deepEqual(corrected.data.hotels[0].proofPoints, ["塔兰吉雷国家公园行程"]);
  assert.equal(corrected.corrections.length, 2);
});
