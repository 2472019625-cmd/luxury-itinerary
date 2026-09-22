// Editor-only explanations. Never interpolate raw service errors, source URLs,
// internal identifiers or resource budgets into user-facing text.
export function imageSearchPresentation(review = {}, { searching = false } = {}) {
  const current = review.currentResult || {};
  const status = current.previousStatus || review.status || current.status || "";
  const technicalStatus = current.technicalStatus || review.technicalStatus || "";
  if (searching || [status, review.status, current.status].some(value => ["processing", "running", "queued", "pending"].includes(value))) {
    return { title: "正在搜索图片", detail: "正在为这个位置查找并检查图片，完成后会更新结果。", active: true };
  }
  if (status === "audit_pending") {
    return { title: "正在检查候选图片", detail: "已找到候选，正在确认图片内容与当前位置是否相符。", active: true };
  }

  const diagnostic = review.searchDiagnostic || current.searchDiagnostic || {};
  const knowledge = diagnostic.knowledge || {};
  const web = diagnostic.web || {};
  const candidates = review.candidates || [];
  const details = [];
  const directoryMissing = ["not_found", "ambiguous"].includes(knowledge.directoryStatus);
  const queryExecuted = knowledge.queryExecuted === true || Number(knowledge.attempts) > 0;
  if (!queryExecuted && directoryMissing) {
    details.push("知识库专属目录尚未定位，尚未执行图片查询。");
  } else if (queryExecuted) {
    if (["failed", "timeout", "unavailable"].includes(knowledge.status) || knowledge.scopeState === "unavailable") details.push("知识库查询未能正常完成。");
    else if (["not_found", "no_match", "empty"].includes(knowledge.status) || ["no_match", "empty"].includes(knowledge.scopeState)) details.push("知识库已查询，未找到符合当前画面的图片。");
    else details.push("已查询知识库中的图片。");
    if (knowledge.parentProbeUsed) details.push("专属目录未定位，已在上一级目录核对目标身份。");
  }
  if (web.entered) details.push("已转为联网搜索。");
  if (Number(web.pageFailures) > 0) details.push("部分来源页面未能访问，无法取得其中图片。");

  const allRejected = candidates.length > 0 && candidates.every(candidate => candidate.autoRejected || candidate.status === "hard_rejected" || candidate.qualificationStatus === "rejected");
  const rejected = status === "auto_rejected" || allRejected || technicalStatus === "all_candidates_rejected";
  const unfinishedReview = status === "review_timeout" || ["visual_unavailable", "visual_failed", "inconclusive"].includes(web.stopReason) || /visual_judgment_(?:inconclusive|failed|unavailable)|review.*timeout|audit.*timeout/.test(technicalStatus);
  const waiting = status === "candidate_waiting" || status === "needs_user_action" && candidates.length > 0;
  const selected = ["success", "auto_selected", "human_selected", "uploaded"].includes(status);
  let title = "这个位置尚未配图";
  if (technicalStatus === "planner_slot_unresolved") {
    title = "图片主题尚待确认";
    details.push("这个位置的搜索主题尚未明确，尚未开始自动找图。");
  } else if (selected) title = "当前位置已有图片";
  else if (rejected) {
    title = "候选图片未通过检查";
    details.push("已找到的候选未通过内容或图片质量检查，未自动填入。");
  } else if (unfinishedReview) {
    title = "候选图片尚未完成检查";
    details.push("本次检查未能确认候选可以自动使用，这不代表图片内容一定不符。");
  } else if (waiting) {
    title = "已有候选图片可供确认";
    details.push("部分候选尚未自动采用，可查看图片与说明后确认。");
  } else if (Number(web.pageFailures) > 0) title = "部分来源页面无法访问";
  else if (!queryExecuted && directoryMissing) title = "知识库目录尚未定位";
  else if (queryExecuted || web.entered) title = "本次搜索尚未找到可用图片";

  if (!selected) details.push("可以重新搜索，或选择、上传合适的图片。");
  return { title, detail: details.join(""), active: false };
}

export function imageReviewForSlot(data = {}, slot = {}) {
  const slotId = slot.pipelineSlotId || slot.slotId;
  return (data.imageReview?.slots || []).find(review => review.slotId === slotId) || (slot.src ? { status: "success" } : {});
}
