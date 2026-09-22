import assert from "node:assert/strict";
import test from "node:test";
import { imageReviewForSlot, imageSearchPresentation } from "../src/lib/imageSearchPresentation.js";
import { buildSimpleManualImagePayload } from "../server/simple-manual-images.mjs";
import { selectCustomerRenderData } from "../server/customer-render-data.mjs";

const text = value => `${value.title}。${value.detail}`;
const diagnostic = (knowledge = {}, web = {}) => ({ knowledge, web });

test("目录未定位且零查询，不能冒充知识库无匹配", () => {
  for (const status of ["entity_directory_missing", "completed", "needs_clarification"]) {
    const result = imageSearchPresentation({ status: "not_found", searchDiagnostic: diagnostic({ status, attempts: 0, queryExecuted: false, directoryStatus: "not_found" }) });
    assert.match(text(result), /专属目录尚未定位，尚未执行图片查询/);
    assert.doesNotMatch(text(result), /知识库已查询|知识库.*没有图片/);
  }
});

test("执行查询但无匹配与未执行查询分开解释", () => {
  const result = imageSearchPresentation({ status: "not_found", searchDiagnostic: diagnostic({ queryExecuted: true, attempts: 2, status: "completed", scopeState: "no_match" }) });
  assert.match(result.detail, /知识库已查询，未找到符合当前画面的图片/);
  assert.doesNotMatch(result.detail, /尚未执行/);
});

test("父目录查询与联网接续、来源访问失败都保留用户解释", () => {
  const result = imageSearchPresentation({ status: "not_found", searchDiagnostic: diagnostic({ queryExecuted: true, status: "completed", directoryStatus: "not_found", parentProbeUsed: true }, { entered: true, pageFailures: 3, stopReason: "queries_exhausted" }) });
  assert.match(result.detail, /已在上一级目录核对目标身份/);
  assert.match(result.detail, /已转为联网搜索/);
  assert.match(result.detail, /部分来源页面未能访问/);
  assert.doesNotMatch(result.detail, /尚未执行图片查询/);
});

test("候选内容被拒绝与审核没有结论不混为一谈", () => {
  const rejected = imageSearchPresentation({ status: "auto_rejected", candidates: [{ status: "hard_rejected" }] });
  assert.equal(rejected.title, "候选图片未通过检查");
  const inconclusive = imageSearchPresentation({ status: "candidate_waiting", currentResult: { technicalStatus: "visual_judgment_inconclusive" } });
  assert.equal(inconclusive.title, "候选图片尚未完成检查");
  assert.match(inconclusive.detail, /不代表图片内容一定不符/);
});

test("正在搜索优先于历史失败，审核中不显示已失败", () => {
  const old = { status: "auto_rejected", searchDiagnostic: diagnostic({ queryExecuted: false, directoryStatus: "not_found" }, { entered: true, pageFailures: 5 }), candidates: [{ status: "hard_rejected" }] };
  for (const value of [imageSearchPresentation(old, { searching: true }), imageSearchPresentation({ ...old, status: "processing" }), imageSearchPresentation({ ...old, status: "processing", currentResult: { previousStatus: "not_found" } })]) {
    assert.equal(value.active, true);
    assert.equal(value.title, "正在搜索图片");
    assert.doesNotMatch(text(value), /未通过|未能访问|尚未定位/);
  }
  assert.equal(imageSearchPresentation({ ...old, status: "audit_pending" }).title, "正在检查候选图片");
});

test("最新重搜未成功时仍保留原图片，解释不能谎称本次搜索已成功", () => {
  const value = imageSearchPresentation({ status: "auto_selected", currentResult: { previousStatus: "not_found" }, searchDiagnostic: diagnostic({}, { entered: true, pageFailures: 1 }) });
  assert.equal(value.title, "部分来源页面无法访问");
});

test("内部错误和预算不进入用户说明，无证据时不猜原因", () => {
  const value = imageSearchPresentation({ technicalStatus: "HTTP 403 secret-id", searchDiagnostic: diagnostic({ status: "sensitive-name" }, { stopReason: "slot_resource_budget", remainingPages: 17, pendingPages: 29 }) });
  assert.equal(value.title, "这个位置尚未配图");
  assert.doesNotMatch(text(value), /HTTP|secret|slot_resource|17|29|页面未能访问|知识库已查询/);
});

test("从真实绑定找到诊断，不把相邻图片位的失败挪过来", () => {
  const review = { slotId: "pipeline-a", status: "not_found" };
  const data = { imageReview: { slots: [review] } };
  assert.equal(imageReviewForSlot(data, { slotId: "display-a", pipelineSlotId: "pipeline-a" }), review);
  assert.deepEqual(imageReviewForSlot(data, { slotId: "display-b" }), {});
  assert.equal(imageSearchPresentation(imageReviewForSlot(data, { slotId: "display-b", src: "/image-assets/chosen.jpg" })).title, "当前位置已有图片");
});

function payloadFor(imageResult, { unresolved = true } = {}) {
  const slotId = "image:cover:primary";
  const plan = { imageSlots: [{ slotId, moduleType: "cover", required: true }], slotBindings: { [slotId]: { module: "cover", fieldPath: "heroImage", required: true } } };
  const result = { data: { title: "新建验证行程", days: [], hotels: [] }, imageExecution: { results: [{ slotId, status: "not_found", candidates: [], ...imageResult }] }, unresolvedItems: unresolved ? [{ kind: "image", id: slotId, required: true }] : [] };
  const store = {
    getProject: () => ({ projectId: "fresh-project", activeExecutionRunId: "fresh-run", activePlanId: "fresh-plan", flowKind: "simple_skill_v1" }),
    getExecutionRun: () => ({ executionRunId: "fresh-run", flowKind: "simple_skill_v1" }),
    getPlan: () => plan,
    getFinalResult: () => result,
  };
  return buildSimpleManualImagePayload(store, "fresh-project");
}

test("旧结果通过 API 投影摘要，必要缺图提醒有实据且客户数据不含诊断", () => {
  const payload = payloadFor({ pipelineEvidence: { knowledgeSearch: { status: "entity_directory_missing", attempts: [], knowledgeQueryExecuted: false }, sourceFallback: { entered: true }, pageFailures: [{ url: "https://private.example/signed?token=secret", httpStatus: 403 }] } });
  const review = payload.imageReview.slots[0];
  assert.equal(review.searchDiagnostic.knowledge.queryExecuted, false);
  assert.equal(review.searchDiagnostic.web.pageFailures, 1);
  assert.match(payload.blockingItems[0].message, /尚未执行图片查询/);
  assert.match(payload.blockingItems[0].message, /部分来源页面未能访问/);
  assert.doesNotMatch(JSON.stringify(review.searchDiagnostic), /private|secret|403/);
  assert.equal(selectCustomerRenderData(payload.project.data).imageReview, undefined);
});

test("API 使用最新重搜摘要并保留真正执行中的状态", () => {
  const recent = diagnostic({ queryExecuted: true, attempts: 1, status: "not_found" }, { entered: true, pageFailures: 2 });
  const payload = payloadFor({ status: "success", searchDiagnostic: diagnostic({ queryExecuted: true, status: "completed" }), manualAction: { currentSearchFallbackResult: { previousStatus: "not_found", searchDiagnostic: recent } } });
  assert.deepEqual(payload.imageReview.slots[0].searchDiagnostic, recent);
  assert.match(payload.blockingItems[0].message, /部分来源页面未能访问/);
  const running = payloadFor({ status: "running", pipelineEvidence: { knowledgeSearch: { status: "entity_directory_missing" } } });
  assert.equal(running.imageReview.slots[0].status, "processing");
  assert.match(running.blockingItems[0].message, /正在搜索图片/);
  assert.doesNotMatch(running.blockingItems[0].message, /尚未定位/);
});

test("已经采用的非缺图位置也保留最新重搜诊断，不新增必需缺图", () => {
  const payload = payloadFor({ status: "success", manualAction: { currentSearchFallbackResult: { previousStatus: "not_found", searchDiagnostic: diagnostic({}, { entered: true, pageFailures: 1 }) } } }, { unresolved: false });
  assert.equal(payload.imageReview.slots.length, 1);
  assert.match(imageSearchPresentation(payload.imageReview.slots[0]).detail, /部分来源页面未能访问/);
  assert.equal(payload.blockingItems.length, 0);
  assert.equal(payload.unresolvedImageCount, 0);
});
