import { createHash, randomUUID } from "node:crypto";

export const REVIEW_DECISION_VERSION = "agent-review-decision-v1";
export const REVIEW_ACTIONS = Object.freeze([
  "dismiss_false_positive",
  "preserve_supported",
  "adjust_scope_or_strength",
  "invoke_capability",
  "targeted_retry",
  "request_user_confirmation",
  "accept_with_user_decision",
  "cancel_task",
]);

const ACTION_SET = new Set(REVIEW_ACTIONS);
const JUDGMENT_SET = new Set(["not_established", "established", "needs_verification", "needs_user_decision"]);
const DEFAULT_STAGE_RULES = Object.freeze({ planning: ["FLOW-001"], facts: ["DATA-001"], verification: ["DATA-016"], copy: ["DATA-001", "COPY-014"], images: ["IMG-012", "IMG-019"], layout: ["VIS-003", "IMG-020"], final: ["FLOW-002", "VIS-016"] });
const immutableTarget = /(?:^|\.)(?:date|startDate|endDate|travelers|adults|price|cost|profit|hotel|nights|meals|route)(?:\.|$)/i;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

const asArray = (value) => Array.isArray(value) ? value : [];
const clean = (value) => String(value || "").trim();

export function reviewPacketFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function buildReviewPacket({ stage, findings = [], sourceFacts = {}, userConfirmedFacts = [], officialEvidence = [], availableCapabilities = [], context = {}, remainingAttempts = 1 } = {}) {
  const normalized = findings.filter(Boolean).map((item, index) => {
    const targetId = clean(item.targetId || item.path || item.slotId || item.subject || `${stage}-target-${index + 1}`);
    const ruleIds = [...new Set(asArray(item.ruleIds).concat(item.ruleId || []).filter(Boolean))];
    return {
      findingId: clean(item.findingId) || `${stage}-${index + 1}-${reviewPacketFingerprint({ targetId, message: item.message || item.reason || item.statement }).slice(0, 10)}`,
      stage,
      targetId,
      path: clean(item.path || item.modificationScope || item.slotId || targetId),
      issueLevel: item.issueLevel === "optimization" ? "optimization" : "hard",
      severityClaimed: item.severityClaimed || item.severity || item.issueLevel || "hard",
      technicalFailure: Boolean(item.technicalFailure),
      code: clean(item.code || item.hardRejectCode || item.field || "review_finding"),
      message: clean(item.message || item.reason || item.statement || "审核发现需要判断"),
      finding: clean(item.finding || item.message || item.reason || item.statement || "审核发现需要判断"),
      currentValue: item.currentValue ?? null,
      ruleIds: ruleIds.length ? ruleIds : [...(DEFAULT_STAGE_RULES[stage] || ["FLOW-007"])],
      sourceBasis: item.sourceBasis || item.originalBasis || null,
      sourceFacts: item.sourceFacts || null,
      userConfirmedFactRefs: asArray(item.userConfirmedFactRefs),
      officialEvidenceRefs: asArray(item.officialEvidenceRefs),
      reviewEvidence: item.reviewEvidence || item.evidence || null,
      previousActions: asArray(item.previousActions),
      allowedCapabilities: [...new Set(asArray(item.allowedCapabilities).filter(Boolean))],
      allowedActions: asArray(item.allowedActions).length ? [...new Set(item.allowedActions)] : REVIEW_ACTIONS,
      forbiddenChanges: asArray(item.forbiddenChanges).length ? item.forbiddenChanges : ["原始资料和用户确认事实", "审核未命中的其他目标"],
      remainingAttempts: Math.max(0, Number(item.remainingAttempts ?? remainingAttempts) || 0),
      required: item.required !== false,
      reviewUncertainty: item.reviewUncertainty || null,
    };
  });
  const evidenceCatalog = [
    ...(sourceFacts && typeof sourceFacts === "object" && Object.keys(sourceFacts).length ? [{ evidenceId: "sourceFacts", kind: "source_facts", value: sourceFacts }] : []),
    ...asArray(userConfirmedFacts).map((item, index) => ({ evidenceId: `user:${item.confirmationId || index + 1}`, kind: "user_confirmation", value: item })),
    ...asArray(officialEvidence).map((item, index) => ({ evidenceId: `official:${item.sourceUrl || item.id || index + 1}`, kind: "official_evidence", value: item })),
    ...normalized.filter((item) => item.sourceBasis).map((item) => ({ evidenceId: `source:${item.findingId}`, kind: "finding_source_basis", value: item.sourceBasis })),
  ];
  const lockedPaths = [...new Set(asArray(userConfirmedFacts).flatMap((item) => [...asArray(item.affectedPaths), item.path, item.targetPath].filter(Boolean)).map(clean))];
  const packet = {
    packetId: randomUUID(),
    version: REVIEW_DECISION_VERSION,
    stage: clean(stage),
    createdAt: new Date().toISOString(),
    findings: normalized,
    sourceFacts,
    userConfirmedFacts: asArray(userConfirmedFacts),
    officialEvidence: asArray(officialEvidence),
    evidenceCatalog,
    lockedPaths,
    availableCapabilities: [...new Set(asArray(availableCapabilities).filter(Boolean))],
    allowedActions: REVIEW_ACTIONS,
    forbiddenChanges: ["不得改变原始资料和用户确认事实", "不得把优化建议升级为硬问题", "不得修改审核未指向的目标", "不得让必需图片位留空后通过完成门禁"],
    context,
  };
  return { ...packet, fingerprint: reviewPacketFingerprint({ ...packet, packetId: undefined, createdAt: undefined }) };
}

function targetCovered(path, target) {
  return path === target || path.startsWith(`${target}.`) || path.startsWith(`${target}[`);
}

export function validateReviewDecisionBatch(packet, raw = {}) {
  const errors = [];
  const decisions = asArray(raw.decisions);
  const findingById = new Map(packet.findings.map((item) => [item.findingId, item]));
  const evidenceIds = new Set(asArray(packet.evidenceCatalog).map((item) => item.evidenceId));
  const seen = new Set();
  for (const [index, decision] of decisions.entries()) {
    const path = `decisions.${index}`;
    const finding = findingById.get(decision?.findingId);
    if (!finding) { errors.push({ code: "unknown_finding", path, message: "决定引用了本批次不存在的问题" }); continue; }
    if (seen.has(finding.findingId)) errors.push({ code: "duplicate_decision", path, message: "同一个问题只能决定一次" });
    seen.add(finding.findingId);
    if (!ACTION_SET.has(decision.action)) errors.push({ code: "action_not_allowed", path: `${path}.action`, message: "决定动作不在白名单" });
    if (!finding.allowedActions.includes(decision.action)) errors.push({ code: "action_not_allowed_for_target", path: `${path}.action`, message: "决定动作不属于该目标的允许范围" });
    if (!JUDGMENT_SET.has(decision.finalJudgment)) errors.push({ code: "judgment_required", path: `${path}.finalJudgment`, message: "决定缺少合法的最终判断" });
    if (clean(decision.targetId) !== finding.targetId) errors.push({ code: "target_scope_changed", path: `${path}.targetId`, message: "决定改变了审核指向的目标" });
    if (clean(decision.allowedTarget) !== finding.path) errors.push({ code: "allowed_target_changed", path: `${path}.allowedTarget`, message: "决定的允许修改目标必须与审核路径一致" });
    if (["adjust_scope_or_strength", "invoke_capability", "targeted_retry"].includes(decision.action) && asArray(packet.lockedPaths).some((lockedPath) => targetCovered(finding.path, lockedPath) || targetCovered(lockedPath, finding.path))) errors.push({ code: "user_lock_violation", path: `${path}.action`, message: "用户已锁定的事实不能由智能体或专业能力覆盖" });
    const decisionRuleIds = asArray(decision.ruleIds);
    if (!decisionRuleIds.length || decisionRuleIds.some((ruleId) => !finding.ruleIds.includes(ruleId))) errors.push({ code: "rule_reference_invalid", path: `${path}.ruleIds`, message: "决定必须引用该问题实际适用的规则" });
    if (!asArray(decision.forbiddenChanges).length) errors.push({ code: "forbidden_changes_required", path: `${path}.forbiddenChanges`, message: "决定必须明确禁止修改的内容" });
    const recheckTargets = asArray(decision.recheckTargets);
    if (["adjust_scope_or_strength", "invoke_capability", "targeted_retry"].includes(decision.action) && !recheckTargets.length) errors.push({ code: "recheck_target_required", path: `${path}.recheckTargets`, message: "执行目标操作后必须明确局部复查范围" });
    for (const recheckTarget of recheckTargets) if (!targetCovered(clean(recheckTarget), finding.path)) errors.push({ code: "recheck_out_of_scope", path: `${path}.recheckTargets`, message: "复查目标超出审核路径" });
    if (typeof decision.consumesBusinessRetry !== "boolean") errors.push({ code: "retry_accounting_required", path: `${path}.consumesBusinessRetry`, message: "决定必须明确是否消耗业务重试" });
    if (["targeted_retry", "invoke_capability"].includes(decision.action) && decision.consumesBusinessRetry !== true) errors.push({ code: "retry_accounting_invalid", path: `${path}.consumesBusinessRetry`, message: "目标重试或能力调用必须计入业务重试" });
    if (["dismiss_false_positive", "preserve_supported"].includes(decision.action) && finding.issueLevel === "hard" && !asArray(decision.evidenceRefs).length) errors.push({ code: "evidence_required", path: `${path}.evidenceRefs`, message: "保留或驳回硬问题必须引用原始资料、用户确认或正式证据" });
    for (const evidenceRef of asArray(decision.evidenceRefs)) if (!evidenceIds.has(evidenceRef)) errors.push({ code: "evidence_not_found", path: `${path}.evidenceRefs`, message: `决定引用了不存在的证据：${evidenceRef}` });
    if (packet.stage === "images" && finding.required && ["dismiss_false_positive", "preserve_supported", "adjust_scope_or_strength", "accept_with_user_decision"].includes(decision.action)) errors.push({ code: "required_image_cannot_be_bypassed", path: `${path}.action`, message: "必需图片位缺失不能被忽略、降级或直接接受" });
    if (["targeted_retry", "invoke_capability"].includes(decision.action) && finding.remainingAttempts < 1) errors.push({ code: "retry_exhausted", path, message: "该目标已没有可用重试次数" });
    if (decision.action === "invoke_capability") {
      if (!finding.allowedCapabilities.includes(decision.capabilityId) || !packet.availableCapabilities.includes(decision.capabilityId)) errors.push({ code: "capability_not_allowed", path: `${path}.capabilityId`, message: "调用能力不属于该问题的允许范围" });
    }
    if (decision.action === "accept_with_user_decision" && !clean(decision.userDecisionRef)) errors.push({ code: "user_decision_required", path: `${path}.userDecisionRef`, message: "没有真实用户决定，不能代替用户接受风险" });
    for (const change of asArray(decision.proposedChanges)) {
      const changePath = clean(change?.path);
      if (!targetCovered(changePath, finding.path)) errors.push({ code: "change_out_of_scope", path: `${path}.proposedChanges`, message: "拟修改路径超出审核目标" });
      if (immutableTarget.test(changePath) && !asArray(decision.evidenceRefs).length) errors.push({ code: "immutable_fact_change", path: `${path}.proposedChanges`, message: "关键事实不能在没有正式依据时修改" });
    }
  }
  for (const finding of packet.findings) if (!seen.has(finding.findingId)) errors.push({ code: "missing_decision", path: finding.findingId, message: "本批次存在未处理的问题" });
  if (/chainOfThought|internalReasoning|hiddenReasoning|思维链/i.test(JSON.stringify(raw))) errors.push({ code: "hidden_reasoning_forbidden", path: "$", message: "决定记录不得包含隐藏推理或思维链" });
  return { valid: errors.length === 0, errors, decisions };
}

export function decisionsForAction(result, actions) {
  const allowed = new Set(Array.isArray(actions) ? actions : [actions]);
  return asArray(result?.decision?.decisions).filter((item) => allowed.has(item.action));
}
