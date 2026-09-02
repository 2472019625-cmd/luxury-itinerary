import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentPlanStore } from "../server/agent-plan-store.mjs";
import { AgentExecutionEngine } from "../server/agent-execution-engine.mjs";
import { createExecutionRun } from "../server/agent-execution-scheduler.mjs";
import { AGENT_RULE_PROFILE_VERSION } from "../config/agent-rule-profile.mjs";
import { AGENT_CAPABILITY_VERSION } from "../config/agent-capabilities.mjs";

const sourceData = { destination: "肯尼亚", title: "肯尼亚1天0晚深度游", subtitle: "进入草原", dayCount: 1, days: [{ id: "d1", date: "2026-10-01", theme: "草原初见", description: "进入保护区", spots: [{ id: "s1", name: "草原游猎", description: "进入开阔草原", images: [] }] }], hotels: [], diningExperiences: [], transportSummary: [], included: [], excluded: [], cancellation: [] };
const task = (taskId, taskType, capabilityIds) => ({ taskId, taskType, title: taskType, capabilityIds, dependsOn: [], parallelGroup: "P1" });
const tasks = [
  task("setup", "project_setup", ["project_store"]), task("plan", "journey_strategy", ["trip_planner"]),
  task("web", "web_verification", ["web_fact_search", "fact_validator"]), task("copy", "copy_global", ["copy_writer"]),
  task("review", "copy_review", ["fact_validator", "brand_reviewer"]), task("repair", "targeted_copy_repair", ["copy_writer", "fact_validator"]),
  task("search", "image_search_plan", ["image_search"]), task("visual", "visual_review", ["visual_auditor"]), task("place", "image_placement", ["project_store"]),
  task("gap", "image_gap_resolution", ["project_store", "human_confirmation"]), task("render", "layout_render", ["layout_renderer"]),
  task("qa", "final_qa", ["final_qa"]), task("gate", "completion_gate", ["final_qa", "project_store", "human_confirmation"]),
  task("control", "control", ["task_cancel", "project_store"]), task("persist", "persistence", ["project_store"]),
];

function fixture(adapters = {}) {
  const store = new AgentPlanStore(mkdtempSync(path.join(tmpdir(), "agent-engine-")));
  const plan = { planId: "plan-1", projectId: "project-1", inputFingerprint: "fp", status: "plan_only", executionEnabled: false, ruleProfileVersion: AGENT_RULE_PROFILE_VERSION, capabilityConfigVersion: AGENT_CAPABILITY_VERSION, factBasis: { destination: "肯尼亚" }, webVerification: [{ subject: "Example", field: "policy" }], imagePlan: { visualStory: "草原初见", slots: [{ role: "cover", required: true, searchIntent: "Kenya savanna" }, { role: "day:1", required: true, searchIntent: "Kenya safari" }] }, tasks, capabilityCallStats: [{ capabilityId: "trip_planner", actualCalls: 1 }] };
  let project = store.createProject({ projectId: "project-1", flowKind: "agent_v1", executionEnabled: false, inputFingerprint: "fp", activePlanId: null, planIds: [], executionRunIds: [], confirmationIds: [] });
  store.saveSourceData(project.projectId, { facts: sourceData, report: {} });
  project = store.activatePlan(project.projectId, plan);
  const run = createExecutionRun(project, plan);
  store.saveExecutionRun(project.projectId, run);
  const defaults = {
    runWebFactSearch: async () => ({ durationMs: 10, usage: null, adoptedFacts: [], conflicts: [], unverified: [], internalSuggestions: [] }),
    runAgentCopyPipeline: async () => ({ data: { ...sourceData, copyQuality: { passed: true } }, contentQuality: { passed: true, brandReviewCallCount: 1, brandReviewDurationMs: 10, targetRuns: [], remainingIssues: [] }, usage: { modules: [], brandReview: null }, model: "test" }),
    resolveItineraryImages: async (data) => ({ data: { ...data, heroImage: "/image-assets/cover.webp", days: [{ ...data.days[0], spots: [{ ...data.days[0].spots[0], images: [{ src: "/image-assets/day.webp" }] }] }], imageReview: { slots: data.imageBlueprint.meta.requiredSlotIds.map((slotId) => ({ slotId, status: "auto_selected" })) } }, summary: { stats: { searchAttempts: 2, initialAuditCalls: 1, terminalAuditCalls: 1 } }, ledgerFile: "ledger.json" }),
    reviewFinalLayout: async () => ({ runId: "layout-1", outputFile: "final.png", qaFile: "qa.json", layoutQa: { width: 2000, overflows: [], brokenImages: [], largeGaps: [], footerPresent: true }, width: 2000, height: 5000, failedSlotIds: [], modelReviewed: false, outputQa: { passed: true } }),
    reviewFinalOutputData: () => ({ passed: true, issues: [] }),
  };
  const engine = new AgentExecutionEngine({ store, root: mkdtempSync(path.join(tmpdir(), "agent-app-")), origin: "http://127.0.0.1:4174", textModelConfig: {}, searchModelConfig: {}, visionModelConfig: {}, adapters: { ...defaults, ...adapters } });
  return { store, plan, project, run, engine };
}

test("完整执行只有全部门禁通过才到100%并进入编辑器", async () => {
  const { store, project, run, engine } = fixture();
  const complete = await engine.execute(project.projectId, run);
  assert.equal(complete.status, "complete");
  assert.equal(complete.progress.percent, 100);
  assert.ok(complete.taskRuns.every((item) => ["succeeded", "not_applicable"].includes(item.status)));
  assert.equal(store.getProject(project.projectId).status, "ready_for_editor");
  assert.ok(store.getFinalResult(project.projectId, run.executionRunId)?.data);
  assert.equal(complete.capabilityCallStats.find((item) => item.capabilityId === "brand_reviewer").actualCalls, 1);
});

test("联网来源冲突停在确认状态且不会继续生成文案", async () => {
  let copyCalled = false;
  const { store, project, run, engine } = fixture({
    runWebFactSearch: async () => ({ durationMs: 10, usage: null, adoptedFacts: [], conflicts: [{ subject: "Example", field: "policy", statement: "冲突", sourceName: "官方", sourceUrl: "https://example.com" }], unverified: [], internalSuggestions: [] }),
    runAgentCopyPipeline: async () => { copyCalled = true; throw new Error("不应调用"); },
  });
  const waiting = await engine.execute(project.projectId, run);
  assert.equal(waiting.status, "waiting_confirmation");
  assert.equal(copyCalled, false);
  assert.equal(store.getProject(project.projectId).status, "awaiting_confirmation");
  assert.equal(store.getConfirmations(project.projectId).filter((item) => item.status === "pending").length, 1);
});

test("取消会中止当前能力并保留已形成的运行事件", async () => {
  const controller = new AbortController();
  const { store, project, run, engine } = fixture({
    runWebFactSearch: async ({ signal }) => new Promise((_resolve, reject) => {
      const cancel = () => reject(new DOMException("已取消", "AbortError"));
      if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    }),
  });
  const pending = engine.execute(project.projectId, run, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.events.some((item) => item.type === "run_cancelled"));
  assert.equal(store.getProject(project.projectId).status, "cancelled");
});
