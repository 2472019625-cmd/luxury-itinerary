import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAgentImageCompletion, materializeAgentImageBlueprint, prepareTargetedImageRetry } from "../server/agent-image-plan.mjs";

const data = {
  destination: "肯尼亚",
  title: "肯尼亚4天3晚深度游",
  subtitle: "从内罗毕深入草原",
  hotels: [{ id: "lodge-1", officialName: "Example Lodge", region: "Masai Mara" }],
  diningExperiences: [], transportSummary: [],
  days: [
    { id: "d1", theme: "草原初见", description: "进入保护区", spots: [{ id: "s1", name: "草原游猎", description: "寻找开阔地景" }, { id: "s2", name: "营地时光", description: "返回营地" }] },
    { id: "d2", theme: "深入草原", description: "继续探索不同区域", spots: [{ id: "s3", name: "河谷游猎", description: "沿河谷探索" }] },
  ],
};

const imagePlan = { visualStory: "从初见到深入", slots: [
  { role: "cover", required: true, visualDuty: "代表整程草原气质", searchIntent: "Kenya savanna landscape" },
  { role: "hotel:1", required: true, label: "Example Lodge", searchIntent: "Example Lodge official gallery" },
  { role: "day:1", required: true, label: "草原游猎", searchIntent: "Kenya safari landscape" },
  { role: "day:2", required: true, label: "河谷游猎", searchIntent: "Kenya river valley safari" },
] };

test("trip_planner图片计划确定性映射到真实布局图片位且不产生独立模型调用", () => {
  const blueprint = materializeAgentImageBlueprint(data, imagePlan, { planId: "plan-1" });
  assert.equal(blueprint.meta.generatedBy, "trip_planner");
  assert.equal(blueprint.meta.independentModelCalls, 0);
  assert.equal(blueprint.meta.requiredSlotIds.length, 4);
  assert.ok(blueprint.slots.every((slot) => slot.searchQueries.length > 0));
  assert.ok(blueprint.slots.filter((slot) => !slot.required).every((slot) => slot.useImage === false));
});

test("必需图片位只有自动通过或用户锁定才通过完成门禁", () => {
  const imageBlueprint = materializeAgentImageBlueprint(data, imagePlan);
  const required = imageBlueprint.meta.requiredSlotIds;
  const pending = evaluateAgentImageCompletion({ imageBlueprint, imageReview: { slots: required.map((slotId, index) => ({ slotId, status: index ? "auto_selected" : "manual_review" })) } });
  assert.equal(pending.passed, false);
  assert.equal(pending.pendingRequired.length, 1);
  const complete = evaluateAgentImageCompletion({ imageBlueprint, imageReview: { slots: required.map((slotId, index) => ({ slotId, status: index ? "auto_selected" : "user_locked" })) } });
  assert.equal(complete.passed, true);
});

test("定向重搜只改指定图片位并把画面要求带进新搜索词", () => {
  const source = { destination: "坦桑尼亚", imageBlueprint: { slots: [
    { slotId: "cover:hero", subject: "封面", location: "坦桑尼亚", visualGoal: "草原日出与动物", searchQueries: [{ query: "旧封面搜索" }] },
    { slotId: "day:1", subject: "海岛", location: "桑给巴尔", visualGoal: "海豚浮潜", searchQueries: [{ query: "旧海岛搜索" }] },
  ] } };
  const next = prepareTargetedImageRetry(source, ["day:1"]);
  assert.deepEqual(next.imageBlueprint.slots[0], source.imageBlueprint.slots[0]);
  assert.match(next.imageBlueprint.slots[1].searchQueries[0].query, /桑给巴尔.*海豚浮潜/);
  assert.equal(next.imageBlueprint.slots[1].retryReason, "previous_candidates_mismatched_or_unverified");
});

test("封面重搜不复用规划里未经证实的具体地名", () => {
  const source = { destination: "坦桑尼亚", imageBlueprint: { slots: [{ slotId: "cover:hero", subject: "封面", location: "坦桑尼亚", visualGoal: "可叠加埃托沙母狮", searchQueries: [{ query: "坦桑尼亚草原" }] }] } };
  const next = prepareTargetedImageRetry(source, ["cover:hero"]);
  assert.match(next.imageBlueprint.slots[0].searchQueries[0].query, /^坦桑尼亚 landscape wildlife/);
  assert.doesNotMatch(next.imageBlueprint.slots[0].searchQueries[0].query, /埃托沙/);
});
