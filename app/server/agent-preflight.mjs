import { randomUUID } from "node:crypto";

const asText = (value) => String(value || "").trim();

export function analyzeAgentPreflight(factBasis) {
  const confirmations = [];
  const warnings = Array.isArray(factBasis?.sourceCoverage?.warnings) ? factBasis.sourceCoverage.warnings : [];
  if (warnings.some((warning) => /费用包含.*阻止生成/.test(asText(warning)))) {
    confirmations.push({
      confirmationId: randomUUID(),
      category: "费用",
      status: "pending",
      question: "原资料没有形成可核对的费用包含清单，本次是否先隐藏费用模块并继续规划？",
      source: `${factBasis.sourceCoverage.workbookName || "主Excel"} · 费用包含字段`,
      reason: "费用边界不清会让客户误解产品包含范围，不能由智能体猜测。",
      affectedPaths: ["modules.expenses", "customerCopy.closing"],
      affectedTaskTypes: ["module_strategy", "copy_closing", "completion_gate"],
      choices: [
        { choiceId: "hide_unverified_fee_module", label: "隐藏费用模块后继续", recommended: true, reason: "不补写不存在的费用事实，同时允许其余已知内容继续规划。" },
        { choiceId: "wait_for_fee_source", label: "等待补充费用资料", recommended: false, reason: "保持项目等待，补齐原始资料后再继续。" },
      ],
    });
  }
  const pendingHotels = (factBasis?.days || []).filter((day) => /待确认|最终确认/.test(asText(day.hotel)));
  if (pendingHotels.length) {
    confirmations.push({
      confirmationId: randomUUID(), category: "履约", status: "pending",
      question: `${pendingHotels.map((day) => `DAY ${day.day}`).join("、")} 的住宿仍待确认，是否保持待定并阻止相关酒店任务？`,
      source: `${factBasis.sourceCoverage.workbookName || "主Excel"} · 每日住宿`,
      reason: "住宿名称会影响酒店文案、图片和履约承诺。",
      affectedPaths: pendingHotels.map((day) => `facts.days.${day.day}.hotel`),
      affectedTaskTypes: ["copy_hotel_transport", "image_slot_plan", "completion_gate"],
      choices: [
        { choiceId: "keep_pending_block_tasks", label: "保持待定并阻止相关任务", recommended: true, reason: "不猜酒店，其他无关任务仍可规划。" },
        { choiceId: "wait_for_hotel_source", label: "等待补充酒店资料", recommended: false, reason: "项目保持等待，取得确认后继续。" },
      ],
    });
  }
  return confirmations;
}

export function resolvePreflightConfirmations(confirmations, decisions, decidedAt = new Date().toISOString()) {
  const byId = new Map((decisions || []).map((item) => [item.confirmationId, item]));
  return confirmations.map((confirmation) => {
    const decision = byId.get(confirmation.confirmationId);
    if (!decision) return confirmation;
    const choice = confirmation.choices.find((item) => item.choiceId === decision.choiceId);
    if (!choice) throw new Error(`确认项 ${confirmation.confirmationId} 的选项无效`);
    const canContinue = !choice.choiceId.startsWith("wait_for_");
    return { ...confirmation, status: canContinue ? "resolved" : "pending", selectedChoiceId: choice.choiceId, selectedLabel: choice.label, note: asText(decision.note), decidedAt: canContinue ? decidedAt : null };
  });
}

