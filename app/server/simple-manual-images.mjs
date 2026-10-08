import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { decodeSafeImage, MAX_IMAGE_BYTES } from './image-decode.mjs';
import { applySimpleSkillResults } from "./simple-pipeline-writeback.mjs";
import { runSimpleRenderer } from "./simple-renderer.mjs";
import { downloadCandidate, imageResolutionPolicyForSlot, withDayGalleryLayout } from "./image-download.mjs";
import { refreshKnowledgeMatchedFile } from "./knowledge-image-search.mjs";
import { prepareExplicitImageSearchSlot } from "./manual-image-search-target.mjs";
export { prepareExplicitImageSearchSlot } from "./manual-image-search-target.mjs";
import { candidateQualification, isHardRejectedCandidate } from "./image-candidate-eligibility.mjs";
import { canConfirmModelApprovedProgramRejection } from "../src/lib/imageReviewPolicy.js";
import { getSlotImage, setSlotImage } from "../src/lib/imageSlots.js";
import { dayVisualCards } from "../src/lib/dayVisualCards.js";
import { imageSearchPresentation } from "../src/lib/imageSearchPresentation.js";
import { buildImageSearchDiagnostic } from "./image-search-diagnostics.mjs";
import { imageTargetFingerprint, reconcileProvisionalImageSelections } from "./simple-image-allocation.mjs";
import { buildRendererUnresolvedItem, normalizeRenderIssues, rendererQaIssues } from "./simple-render-issues.mjs";
import { hotelStayDetails } from "../src/lib/hotelStayPresentation.js";
import { applyHotelNightChange, planHotelNightChange } from "../src/lib/hotelStayEditing.js";
import { applyModuleVisibility, EDITABLE_MODULE_VISIBILITY } from "../src/lib/moduleVisibility.js";
import { createOperationTrace } from './operation-trace.mjs';
import { manualCopyValue } from '../src/lib/manualImageState.js';
import { assertSimpleResultCurrent } from './simple-result-version.mjs';

function manualCopySchema(schema) {
  if (!schema) return { type: 'string', minLength: 1 };
  // Writer length/style targets do not grade human prose; layout still runs below.
  const { minLength, maxLength, pattern, ...shape } = schema;
  return { ...shape, ...(schema.type === 'string' ? { minLength: 1 } : {}),
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, manualCopySchema(value)])) } : {}),
    ...(schema.items ? { items: manualCopySchema(schema.items) } : {}),
    ...Object.fromEntries(['anyOf', 'oneOf'].filter(key => Array.isArray(schema[key])).map(key => [key, schema[key].map(manualCopySchema)])) };
}

function trimManualCopy(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimManualCopy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimManualCopy(item)]));
  return value;
}

function resolveManualCopy(result, resolutions) {
  const resolved = new Map(resolutions.map(item => [item.targetId, item]));
  const oldResults = result.copyExecution?.results || [];
  const results = oldResults.filter(item => !resolved.has(item.targetId));
  for (const item of resolutions) {
    const previous = oldResults.find(entry => entry.targetId === item.targetId);
    const failure = result.unresolvedItems?.find(entry => entry.kind === 'copy' && entry.id === item.targetId);
    results.push({ ...previous, ...item, status: 'success', resolution: 'manual_editor', error: null,
      manualResolution: { confirmedAt: new Date().toISOString(), previousStatus: previous?.status || failure?.status, previousError: previous?.error || failure?.error || null } });
  }
  return { ...result,
    copyExecution: { ...result.copyExecution, results, status: results.every(item => item.status === 'success') ? 'success' : 'partial_success' },
    unresolvedItems: (result.unresolvedItems || []).filter(item => item.kind !== 'copy' || !resolved.has(item.id)),
    writeback: { ...result.writeback, copy: [...(result.writeback?.copy || []).filter(item => !resolved.has(item.targetId)), ...resolutions.map(item => ({ targetId: item.targetId, targetPath: item.targetPath, status: 'written', resolution: 'manual_editor' }))] },
  };
}

export async function saveSimpleManualCopy({ store, root, projectId, targetId, value, manualConfirmed, render, deferRender = false } = {}) {
  const context = projectContext(store, projectId);
  const task = context.plan.copyTasks?.find(item => item.targetId === targetId);
  if (manualConfirmed !== true) throw Object.assign(new Error('请明确确认使用人工填写的文案'), { code: 'manual_copy_confirmation_required' });
  // The editor's debounce may already have saved this exact human edit.
  if (task && context.result.copyExecution?.results?.some(item => item.targetId === targetId && item.resolution === 'manual_editor' && item.status === 'success') &&
      JSON.stringify(trimManualCopy(value)) === JSON.stringify(trimManualCopy(manualCopyValue(context.result.data, { id: targetId, targetPath: task.targetPath, slotId: task.layoutHints?.slotId })))) return buildSimpleManualImagePayload(store, projectId);
  if (!task || !context.result.unresolvedItems?.some(item => item.kind === 'copy' && item.id === targetId)) throw Object.assign(new Error('这项文案待处理已变化，请刷新后重试'), { code: 'manual_copy_target_changed' });
  value = trimManualCopy(value);
  if (value == null || (typeof value === 'string' && !value)) throw Object.assign(new Error('人工文案未保存，请先填写非空文案'), { code: 'manual_copy_invalid' });
  const schema = task.outputSchema || (task.moduleType === 'visual_card' && !task.targetPath.endsWith('.description') ? { type: 'object', required: ['cardTitle', 'cardDescription'], additionalProperties: false, properties: { cardTitle: { type: 'string' }, cardDescription: { type: 'string' } } } : undefined);
  const resolution = { targetId, targetPath: task.targetPath, value };
  const applied = applySimpleSkillResults({ preparedData: context.result.data, copyTasks: [{ ...task, outputSchema: manualCopySchema(schema) }], copyExecution: { results: [{ ...resolution, status: 'success' }] } });
  if (applied.unresolvedItems.length) throw Object.assign(new Error(`人工文案未保存，请填写非空文案并保持对应字段格式。${applied.unresolvedItems[0].error?.message || ''}`), { code: 'manual_copy_invalid' });
  const slotId = task.layoutHints?.slotId;
  const binding = slotId && applied.data.simpleImageSlotBindings?.[slotId];
  if (binding?.module === 'day' && binding.useSpotCopy !== false) {
    const spots = applied.data.days?.[binding.dayIndex]?.spots || [];
    const spot = binding.spotId ? spots.find(item => item.id === binding.spotId) : spots[binding.spotIndex];
    if (!spot) throw Object.assign(new Error('对应体验已变化，请刷新后重试'), { code: 'manual_copy_target_changed' });
    spot.description = value.cardDescription;
    delete spot.experience;
  }
  const result = resolveManualCopy({ ...context.result, data: applied.data }, [resolution]);
  return persistResult({ ...context, result, store, root, imageExecution: result.imageExecution, render, deferRender,
    action: { type: 'editor_manual_copy_confirm', targetId, resolvedCopyTargetIds: [targetId] } });
}

const MIME_EXTENSIONS = Object.freeze({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" });
const manualRenders = new Map();

function projectedTargetSlot(context, slotId, removedSlotIds = []) {
  const bindings = context.result.data?.simpleImageSlotBindings || context.plan.slotBindings || {};
  const binding = bindings[slotId];
  const planned = context.plan.imageSlots?.find((item) => item.slotId === slotId);
  const target = planned
    ? { ...planned, visualContext: { ...(planned.visualContext || {}), dayIndex: binding?.dayIndex ?? planned.visualContext?.dayIndex } }
    : { slotId, moduleType: binding?.module, visualContext: { dayIndex: binding?.dayIndex }, displayLayout: binding?.displayLayout };
  if (target.moduleType !== "day") return target;
  const removed = new Set(removedSlotIds);
  const dayIndex = Number(binding?.dayIndex ?? target.visualContext?.dayIndex);
  const projectedDay = structuredClone(context.result.data?.days?.[dayIndex]);
  if (!projectedDay) return target;
  for (const [id, item] of Object.entries(bindings)) {
    if (item.module !== "day" || item.dayIndex !== dayIndex || (id !== slotId && !removed.has(id))) continue;
    const spotIndex = item.spotId
      ? projectedDay.spots?.findIndex((spot) => String(spot.id || "") === String(item.spotId))
      : Number(item.spotIndex);
    const spot = projectedDay.spots?.[spotIndex];
    if (!spot) continue;
    spot.images ||= [];
    spot.images[item.imageIndex] = id === slotId ? { src: "projected-target-image" } : null;
  }
  const visible = dayVisualCards(projectedDay, dayIndex, bindings).map((card) => ({
    slotId: card.slotId, moduleType: "day", visualContext: { dayIndex },
  }));
  return withDayGalleryLayout(target, visible);
}

const targetResolutionPolicy = (context, slotId, removedSlotIds = []) => imageResolutionPolicyForSlot(projectedTargetSlot(context, slotId, removedSlotIds));

function assertTargetResolution(width, height, policy) {
  if (width >= policy.minWidth && height >= policy.minHeight) return;
  throw Object.assign(new Error(`图片分辨率不足：实际 ${width}×${height}，当前位置至少需要 ${policy.minWidth}×${policy.minHeight}，请换用更清晰的原图`), {
    code: "image_resolution_insufficient", actualWidth: width, actualHeight: height,
    minWidth: policy.minWidth, minHeight: policy.minHeight,
  });
}
const SLOT_LABELS = Object.freeze({
  "image:cover:primary": "封面主图 · 坦桑尼亚草原飞机",
  "image:hotel:imported-hotel-2:primary": "酒店主图 · Singita Sabora Tented Camp",
  "image:day:2:primary": "DAY 2 主图 · 塞伦盖蒂西部游猎",
  "image:day:3:primary": "DAY 3 主图 · 徒步 / 夜间游猎",
  "image:day:6:primary": "DAY 6 主图 · 反偷猎 / ranger patrol",
});
const SLOT_STATUS_LABELS = Object.freeze({
  auto_selected: "已自动选图",
  human_selected: "已人工采用",
  uploaded: "已上传",
  provisional_pending_confirmation: "已预填·待确认",
  candidate_waiting: "有候选待选择",
  audit_pending: "候选审核中",
  auto_rejected: "候选审核未通过",
  review_timeout: "候选审核超时",
  processing: "正在处理",
  not_found: "未找到图片",
  user_removed: "已移除，当天以文字展示",
});

function userRemovedDayImage(data = {}, slotId = "", binding = {}) {
  return binding.module === "day" && data.imageLocks?.[slotId]?.source === "user_cleared" && !getSlotImage(data, binding)?.src;
}

function uniqueCandidates(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.candidateId || item?.localUrl || item?.imageUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectContext(store, projectId) {
  const project = store.getProject(projectId);
  const run = project?.activeExecutionRunId ? store.getExecutionRun(projectId, project.activeExecutionRunId) : null;
  const plan = project?.activePlanId ? store.getPlan(projectId, project.activePlanId) : null;
  const result = run ? store.getFinalResult(projectId, run.executionRunId) : null;
  if (!project || !run || !plan || !result) throw Object.assign(new Error("Simple Pipeline 项目缺少当前计划、执行记录或 final-result"), { code: "simple_project_incomplete" });
  if (project.flowKind !== "simple_skill_v1" || run.flowKind !== "simple_skill_v1") throw Object.assign(new Error("目标不是 Simple Pipeline 项目"), { code: "wrong_project_flow" });
  return { project, run, plan, result };
}

function manualSlotIds(result, plan = {}) {
  const saved = result.manualImageCompletion?.slotIds;
  const plannedIds = new Set((plan.imageSlots || []).map((slot) => slot.slotId));
  const liveBindings = result.data?.simpleImageSlotBindings || {};
  return [...new Set([
    ...(Array.isArray(saved) ? saved : []),
    ...(result.unresolvedItems || []).filter((item) => item.kind === "image").map((item) => item.id),
    ...(plan.imageSlots || []).filter((slot) => ["day", "transport"].includes(slot.moduleType)).map((slot) => slot.slotId),
    ...Object.entries(result.data?.simpleImageSlotBindings || {}).filter(([, binding]) => binding.manualEditorCard === true).map(([slotId]) => slotId),
  ].filter((slotId) => slotId && (plannedIds.has(slotId) || Object.hasOwn(liveBindings, slotId))))];
}

function unresolvedNotices(items = []) {
  const groups = new Map();
  for (const item of items) {
    let label = "其他生成问题";
    if (item.kind === "image") label = "图片待补充";
    else if (/^hotels\./.test(item.targetPath || "")) label = "酒店文案待处理";
    else if (/^transportSummary\./.test(item.targetPath || "")) label = "交通文案待处理";
    else if (/^days\./.test(item.targetPath || "") || (item.kind === "copy" && item.id?.startsWith("copy:visual:image:day:"))) label = "每日行程文案待处理";
    else if (item.kind === "copy") label = "其他文案待处理";
    const group = groups.get(label) || { label, count: 0, ids: [] };
    group.count += 1;
    group.ids.push(item.id);
    groups.set(label, group);
  }
  return [...groups.values()].map((group) => ({ ...group, message: `${group.label} ${group.count} 项` }));
}

function copyLocation(targetPath = "", data = {}, slotId = "", plan = {}) {
  if (slotId) {
    const binding = data.simpleImageSlotBindings?.[slotId] || plan.slotBindings?.[slotId] || {};
    const planned = (plan.imageSlots || []).find((slot) => slot.slotId === slotId) || {};
    const dayNumber = Number(slotId.match(/^image:day:(\d+):/)?.[1]);
    const dayIndex = Number.isInteger(binding.dayIndex) ? binding.dayIndex : dayNumber - 1;
    if (Number.isInteger(dayIndex) && dayIndex >= 0) {
      const spot = data.days?.[dayIndex]?.spots?.find((value) => value.id && value.id === binding.spotId) || data.days?.[dayIndex]?.spots?.[binding.spotIndex];
      const subject = binding.visualSubject || planned.primaryVisualSubject || planned.subject || spot?.name || binding.cardTitle || "体验卡片";
      return `DAY ${String(dayIndex + 1).padStart(2, "0")} · ${subject} · 体验卡片文案`;
    }
  }
  let match = targetPath.match(/^days\.(\d+)\.(theme|description|dayNotices\.0\.text)$/);
  if (match) return `DAY ${String(Number(match[1]) + 1).padStart(2, "0")} · ${{ theme: "每日主题", description: "今日行程", "dayNotices.0.text": "今日贴士" }[match[2]]}`;
  match = targetPath.match(/^days\.(\d+)\.spots\.(\d+)\.description$/);
  if (match) return `DAY ${String(Number(match[1]) + 1).padStart(2, "0")} · ${data.days?.[Number(match[1])]?.spots?.[Number(match[2])]?.name || `体验 ${Number(match[2]) + 1}`}`;
  match = targetPath.match(/^hotels\.(\d+)\.(editorialCopy|proofPoints|factRows)$/);
  if (match) return `${data.hotels?.[Number(match[1])]?.shortName || data.hotels?.[Number(match[1])]?.officialName || `酒店 ${Number(match[1]) + 1}`} · ${{ proofPoints: "酒店卖点", factRows: "酒店事实", editorialCopy: "酒店介绍" }[match[2]]}`;
  match = targetPath.match(/^diningExperiences\.(\d+)\.editorialCopy$/);
  if (match) return `${data.diningExperiences?.[Number(match[1])]?.name || `特色餐饮 ${Number(match[1]) + 1}`} · 体验介绍`;
  match = targetPath.match(/^transportSummary\.(\d+)\.(usageLabel|editorialCopy|features)$/);
  if (match) return `${data.transportSummary?.[Number(match[1])]?.category || `交通 ${Number(match[1]) + 1}`} · ${{ usageLabel: "使用场景", editorialCopy: "交通介绍", features: "交通特点" }[match[2]]}`;
  match = targetPath.match(/^highlights\.(\d+)$/);
  if (match) return `产品亮点 ${Number(match[1]) + 1}`;
  if (targetPath === "title") return "封面标题";
  if (targetPath === "subtitle") return "封面副标题";
  if (targetPath === "notes") return "行前提示";
  return "客户行程文案";
}

function imageLocation(item = {}, data = {}, plan = {}) {
  const binding = data.simpleImageSlotBindings?.[item.id] || plan.slotBindings?.[item.id] || {};
  const planned = (plan.imageSlots || []).find((slot) => slot.slotId === item.id) || {};
  if (binding.module === "cover" || item.id.includes(":cover:")) return "封面主图";
  if (binding.module === "hotel" || item.id.includes(":hotel:")) {
    const hotel = data.hotels?.[binding.itemIndex ?? Number(String(binding.fieldPath || "").match(/^hotels\.(\d+)/)?.[1])];
    return `${hotel?.shortName || hotel?.officialName || "酒店"} · 主图`;
  }
  if (binding.module === "day" || item.id.includes(":day:")) {
    const idDay = Number(item.id.match(/:day:(\d+):/)?.[1]);
    const dayIndex = Number.isInteger(binding.dayIndex) ? binding.dayIndex : Number.isFinite(idDay) ? idDay - 1 : 0;
    const spot = data.days?.[dayIndex]?.spots?.find((value) => value.id && value.id === binding.spotId) || data.days?.[dayIndex]?.spots?.[binding.spotIndex];
    const subject = spot?.name || planned.primaryVisualSubject || planned.subject || binding.cardTitle || "体验图片";
    return `DAY ${String(dayIndex + 1).padStart(2, "0")} · ${subject}`;
  }
  if (binding.module === "transport") return `${data.transportSummary?.[binding.itemIndex]?.category || "交通"} · 图片`;
  return planned.primaryVisualSubject || planned.subject || "行程图片";
}

export function effectiveUnresolvedItems(items = [], data = {}, plan = {}) {
  const plannedIds = new Set((plan.imageSlots || []).map((slot) => slot.slotId));
  const liveBindings = data.simpleImageSlotBindings || {};
  return items.filter((item) => {
    const notice = String(item.targetPath || "").match(/^days\.(\d+)\.dayNotices\.0\.text$/);
    if (notice && !data.days?.[Number(notice[1])]?.dayNotices?.[0]) return false;
    const legacyHotel = String(item.targetPath || "").match(/^hotels\.(\d+)\.(editorialCopy|proofPoints)$/);
    if (legacyHotel && Array.isArray(data.hotels?.[Number(legacyHotel[1])]?.factRows)) return false;
    const slotId = item.kind === "image" ? item.id : item.kind === "copy" && String(item.id || "").startsWith("copy:visual:") ? item.id.slice("copy:visual:".length) : "";
    if (slotId && !plannedIds.has(slotId) && !Object.hasOwn(liveBindings, slotId)) return false;
    if (slotId && userRemovedDayImage(data, slotId, liveBindings[slotId] || plan.slotBindings?.[slotId] || {})) return false;
    return true;
  }).map((item) => {
    if (item.kind !== "copy" || !String(item.id || "").startsWith("copy:visual:")) return item;
    const slotId = item.id.slice("copy:visual:".length);
    const binding = data.simpleImageSlotBindings?.[slotId] || plan.slotBindings?.[slotId];
    return binding && getSlotImage(data, binding)?.src ? { ...item, required: true } : item;
  });
}

function blockingItems(items = [], data = {}, plan = {}, renderResult = {}, reviews = []) {
  return items.filter((item) => item.required || item.kind === "copy").flatMap((item) => {
    if (item.kind === "copy") {
      const task = (plan.copyTasks || []).find((value) => value.targetId === item.id);
      const targetPath = item.targetPath || task?.targetPath || "";
      const slotId = task?.layoutHints?.slotId || (item.id.startsWith("copy:visual:") ? item.id.slice("copy:visual:".length) : "");
      const placementFailure = ["target_path_mismatch", "unauthorized_target_path"].includes(item.error?.code);
      return { kind: "copy", id: item.id, required: item.required === true, targetPath, slotId, label: copyLocation(targetPath, data, slotId, plan), message: placementFailure ? "文案返回的对应位置不一致，尚未保存到此处。请单独重新生成这一项，也可手动填写后确认完成。" : slotId ? "这张体验卡片的文案尚未生成完成，可单独重新生成，也可手动填写后确认完成。" : "这段文案尚未生成完成，可单独重新生成，也可手动填写后确认完成。", action: "retry_copy" };
    }
    if (item.kind === "image") {
      if (item.technicalStatus === "identity_evidence_pending_confirmation") return { kind: "image", id: item.id, slotId: item.id, label: imageLocation(item, data, plan), message: "图片已预填到草稿，具体实体身份尚未证实。请确认这张图，或为可选位置移除图片。", action: "handle_image" };
      const explanation = imageSearchPresentation(reviews.find(review => review.slotId === item.id));
      return { kind: "image", id: item.id, slotId: item.id, label: imageLocation(item, data, plan), message: `${explanation.title}。${explanation.detail}`, action: "handle_image" };
    }
    if (item.kind === "renderer") {
      const qaIssues = normalizeRenderIssues([...(item.qa?.issues || []), ...rendererQaIssues(renderResult)]).filter((issue) => issue.severity === "blocker");
      const unique = [...new Map(qaIssues.map((issue) => [`${issue.code}:${issue.targetPath || issue.path || issue.message}`, issue])).values()];
      if (unique.length) return unique.map((issue, index) => {
        const oldCropFalsePositive = issue.code === "text_overflow" && /crop-slot-viewport/.test(`${issue.selector || ""} ${issue.message || ""}`);
        return { kind: "renderer", id: `${item.id}:${index}`, label: "2000px 成品检查", targetPath: oldCropFalsePositive ? "" : issue.targetPath || issue.path || "", message: oldCropFalsePositive ? "此前将图片裁切误判为溢出；规则已修正，请重新检查版面。" : `未通过原因：${issue.message || issue.reason || "版面检查发现问题"}`, action: "retry_renderer" };
      });
      const details = [...new Set((item.error?.details || []).map((value) => typeof value === "string" ? value : value?.message).filter(Boolean))];
      const generationFailed = item.error?.code === "render_capture_failed" || (item.error?.code && /(?:renderer|render)_.*failed/.test(item.error.code) && !details.length);
      const oldCropFalsePositive = details.some((message) => /crop-slot-viewport/.test(message));
      return { kind: "renderer", id: item.id, label: generationFailed ? "2000px 长图生成" : "2000px 成品检查", message: oldCropFalsePositive ? "此前将图片裁切误判为溢出；规则已修正，请重新检查版面。" : details.length ? `未通过原因：${details.join("；")}` : item.error?.message || "版面检查未返回具体原因，请重新检查。", action: generationFailed ? "retry_render_generation" : "retry_renderer" };
    }
    return { kind: item.kind || "confirmation", id: item.id, targetPath: item.targetPath || "", label: "生成前确认信息", message: "这项客户信息需要先确认，不能由系统自动改写。", action: "review_facts" };
  });
}

function rendererItemIsOnlyClarityWarning(item = {}, renderResult = {}) {
  const recorded = normalizeRenderIssues([...(item.error?.details || []), ...(item.qa?.issues || []), ...rendererQaIssues(renderResult)]);
  return recorded.length > 0 && recorded.every((issue) => issue.severity !== "blocker");
}

function moduleName(slotId) {
  if (slotId.includes(":cover:")) return "封面";
  if (slotId.includes(":hotel:")) return "臻选下榻";
  if (slotId.includes(":transport:")) return "全程交通";
  const match = slotId.match(/:day:(\d+):/);
  return match ? `DAY ${match[1]}` : "每日行程";
}

function candidatePool(imageResult = {}) {
  return uniqueCandidates([
    ...(imageResult.selected ? [imageResult.selected] : []),
    ...(imageResult.provisionalSelected ? [imageResult.provisionalSelected] : []),
    ...(imageResult.manualAction?.rejectedCandidates || []),
    ...(imageResult.manualAction?.selectableCandidates || []),
    ...(imageResult.candidates || []),
  ]);
}

// Optional transport pictures are editor reminders, not completion blockers.
// Derive them from the current execution so saved projects need no migration.
function optionalTransportImageItems(result, plan) {
  const byId = new Map((result.imageExecution?.results || []).map(item => [item.slotId, item]));
  return (plan.imageSlots || []).flatMap(slot => {
    const binding = result.data?.simpleImageSlotBindings?.[slot.slotId] || plan.slotBindings?.[slot.slotId];
    const imageResult = byId.get(slot.slotId);
    if (slot.moduleType !== 'transport' || slot.required !== false || binding?.module !== 'transport'
      || !imageResult || ['success', 'queued', 'pending', 'running', 'processing'].includes(imageResult.status)
      || getSlotImage(result.data, binding)?.src || result.data?.imageLocks?.[slot.slotId]?.source === 'user_cleared'
      || (result.unresolvedItems || []).some(item => item.kind === 'image' && item.id === slot.slotId && item.required)) return [];
    return [{ kind: 'image', id: slot.slotId, slotId: slot.slotId, required: false, blocking: false,
      label: imageLocation({id: slot.slotId}, result.data, plan), action: 'handle_image',
      message: '交通图片尚未找到，可重新搜索、选择或上传，也可确认不使用此图片。此提醒不影响正式导出。' }];
  });
}

// Explicit search is a new assessment of the same asset. Do not let an old
// rejected/selectable alias shadow its latest audit; keep human decisions.
function refreshedSearchCandidates(previous, returned) {
  const byId = new Map(candidatePool(previous).map(candidate => [candidate.candidateId, candidate]));
  for (const candidate of candidatePool(returned)) {
    const prior = byId.get(candidate.candidateId);
    const reassessed = candidate.hardJudgment != null || candidate.modelDecision != null || candidate.reviewTimeout === true
      || ['needs_user_judgment', 'review_timeout'].includes(candidate.candidateStatus);
    if (prior && !reassessed) continue;
    const next = { ...candidate };
    if (prior) {
      for (const key of ['userDecision', 'userDecidedAt', 'humanDecision']) if (prior[key] != null) next[key] = prior[key];
      next.previousReview = { qualificationStatus: prior.qualificationStatus, rejection: prior.rejection,
        modelDecision: prior.modelDecision, actualSubject: prior.actualSubject, matchReason: prior.matchReason };
    }
    byId.set(candidate.candidateId, next);
  }
  const refresh = items => (items || []).map(candidate => byId.get(candidate.candidateId) || candidate);
  return { candidates: [...byId.values()], manualAction: { ...(previous.manualAction || {}),
    ...(previous.manualAction?.rejectedCandidates ? { rejectedCandidates: refresh(previous.manualAction.rejectedCandidates) } : {}),
    ...(previous.manualAction?.selectableCandidates ? { selectableCandidates: refresh(previous.manualAction.selectableCandidates) } : {}) } };
}

function selectableIds(result, imageResult) {
  const unresolved = (result.unresolvedItems || []).find((item) => item.id === imageResult.slotId);
  return new Set([
    ...(unresolved?.selectableCandidateIds || []),
    ...(imageResult.manualAction?.selectableCandidates || []).map((item) => item.candidateId),
    imageResult.provisionalSelected?.candidateId,
  ].filter(Boolean));
}

function localCandidatePreviewUrl(candidate) {
  // The editor preview route serves downloaded assets. Search results and
  // remote knowledge previews remain evidence until they are localized.
  return [candidate.localPreviewUrl, candidate.previewUrl, candidate.localUrl, candidate.publicUrl, candidate.imageUrl]
    .find((value) => typeof value === "string" && value.startsWith("/image-assets/")) || "";
}

function visibleCandidatePool(imageResult = {}) {
  // Provider hits stay in the run ledger. The editor only advertises images
  // that it can actually preview through the local asset route.
  return candidatePool(imageResult).filter((candidate) => Boolean(localCandidatePreviewUrl(candidate)));
}

function frontendCandidate(candidate, slotId, binding, canSelect, targetFingerprint = "") {
  const hard = candidate.hardJudgment || {};
  const qualificationStatus = candidateQualification(candidate);
  const hardRejected = qualificationStatus === "rejected";
  const reviewTimeout = candidate.reviewTimeout === true || candidate.autoReviewStatus === "review_timeout";
  return {
    ...candidate,
    slotId,
    pipelineSlotId: slotId,
    fieldPath: binding?.fieldPath || "",
    targetFingerprint,
    localPreviewUrl: localCandidatePreviewUrl(candidate),
    status: hardRejected ? "hard_rejected" : qualificationStatus === "eligible" ? "eligible_not_selected" : "manual_review",
    autoReviewStatus: hardRejected ? "auto_rejected" : reviewTimeout ? "review_timeout" : candidate.autoReviewStatus || (canSelect ? "not_auto_selected" : "manual_only"),
    autoRejected: hardRejected,
    qualificationStatus,
    reviewTimeout,
    candidateStatus: candidate.selected === true ? "selected" : candidate.candidateStatus || (hardRejected ? "review_rejected" : reviewTimeout ? "review_timeout" : "not_auto_reviewed"),
    notAutoSelected: candidate.selected !== true,
    manualOnly: candidate.selected !== true,
    adoptable: canSelect && !hardRejected,
    libraryEligible: canSelect && !hardRejected,
    manualSelectable: canSelect && !hardRejected,
    canPreview: true,
    canConfirm: !hardRejected || canConfirmModelApprovedProgramRejection(candidate),
    reason: hard.auditContract?.complete === false && !hardRejected
      ? '图片检查返回的信息不完整，补核后仍未完成，暂未自动采用。可查看图片后确认或重新搜索。'
      : candidate.rejectionReason || candidate.matchReason || candidate.reason || "暂无审核说明",
    terminalAudit: {
      relevance: hard.subjectMatch === true && hard.activityMatch !== false ? "主体相符" : "主体不符",
      luxury: "—",
      cleanliness: hard.watermarkFree === false ? "有水印" : "无明显水印",
      composition: hard.technicalUsable === false ? "技术不可用" : "技术可用",
      subjectMatch: hard.subjectMatch,
      placeMatch: hard.locationMatch,
    },
  };
}

function candidateCanBeSelected(result, imageResult, candidate) {
  if (!candidate?.candidateId || !(candidate.localUrl || candidate.publicUrl || candidate.localPreviewUrl || candidate.previewUrl || (candidate.sourceKind === "knowledge_library" && candidate.knowledgeMatchedFile && (candidate.knowledgeQueryIds?.length || candidate.knowledgeQueryId)))) return false;
  if (isHardRejectedCandidate(candidate)) return false;
  if (selectableIds(result, imageResult).has(candidate.candidateId)) return true;
  if (candidate.candidateId === imageResult.selected?.candidateId) return true;
  return candidateQualification(candidate) === "eligible";
}

function slotReviewStatus(imageResult = {}, candidates = []) {
  if (["processing", "running", "queued", "pending"].includes(imageResult.status)) return "processing";
  if (imageResult.status === "success") return imageResult.selected?.userProvided ? "uploaded" : imageResult.selected?.userSelected ? "human_selected" : "auto_selected";
  if (imageResult.provisionalSelected) return "provisional_pending_confirmation";
  const hardRejected = candidates.filter((candidate) => candidate.autoRejected || candidate.status === "hard_rejected");
  const auditPending = candidates.some((candidate) => ["processing", "audit_pending", "pending"].includes(candidate.autoReviewStatus));
  const reviewTimeout = candidates.some((candidate) => candidate.reviewTimeout || candidate.autoReviewStatus === "review_timeout") || /review.*timeout|audit.*timeout/i.test(`${imageResult.status || ""} ${imageResult.technicalStatus || ""}`);
  if (auditPending) return "audit_pending";
  if (candidates.length && hardRejected.length === candidates.length) return "auto_rejected";
  if (reviewTimeout) return "review_timeout";
  if (candidates.some((candidate) => candidate.canConfirm)) return "candidate_waiting";
  if (candidates.length) return "auto_rejected";
  if (imageResult.status === "processing") return "processing";
  return "not_found";
}

function assertPlannedImageSlot(context, slotId) {
  const slot = context.plan.imageSlots.find((item) => item.slotId === slotId);
  if (!slot) throw Object.assign(new Error("该图片位不在当前计划中"), { code: "slot_not_in_plan" });
  return slot;
}

function editableImageBinding(context, slotId) {
  const planned = context.plan.imageSlots.find((item) => item.slotId === slotId);
  const binding = context.result.data?.simpleImageSlotBindings?.[slotId] || context.plan.slotBindings?.[slotId];
  if (planned) return { planned, binding, manualEditorCard: false };
  if (binding?.module === "day" && binding.manualEditorCard === true) return { planned: null, binding, manualEditorCard: true };
  throw Object.assign(new Error("该图片位不属于当前可编辑卡片"), { code: "slot_not_editable" });
}

export function buildSimpleManualImagePayload(store, projectId, { compact = false } = {}) {
  const { project, run, plan, result } = projectContext(store, projectId);
  const context = { project, run, plan, result };
  const resultById = new Map((result.imageExecution?.results || []).map((item) => [item.slotId, item]));
  // Successful positions can also be searched again from the picker. Include
  // their latest search explanation without changing required/missing gates.
  const reviewSlotIds = [...new Set([...manualSlotIds(result, plan), ...resultById.keys()])];
  const slots = reviewSlotIds.map((slotId) => {
    const imageResult = resultById.get(slotId) || { slotId, status: "needs_user_action", candidates: [] };
    const selectables = selectableIds(result, imageResult);
    const binding = result.data?.simpleImageSlotBindings?.[slotId] || plan.slotBindings?.[slotId];
    const planned = plan.imageSlots.find((item) => item.slotId === slotId);
    const targetFingerprint = imageTargetFingerprint(planned);
    const candidates = visibleCandidatePool(imageResult).map((candidate) => frontendCandidate(candidate, slotId, binding, candidateCanBeSelected(result, imageResult, candidate), targetFingerprint));
    const currentSearch = imageResult.manualAction?.currentSearchFallbackResult || imageResult;
    const searchDiagnostic = currentSearch.searchDiagnostic || buildImageSearchDiagnostic(currentSearch);
    let currentDiagnostic = currentSearch.technicalStatus === "planner_slot_unresolved" && !searchDiagnostic.planning
      ? { ...searchDiagnostic, planning: buildImageSearchDiagnostic({ ...currentSearch, plannerValidationIssues: currentSearch.plannerValidationIssues || imageResult.plannerValidationIssues || planned?.plannerValidationIssues }).planning }
      : searchDiagnostic;
    if (currentSearch.technicalStatus === "planner_slot_unresolved" && planned
      && ["non_core_background_choice", "non_core_supporting_choice", "transport_overview_pose"].includes(prepareExplicitImageSearchSlot(planned, { plan }).manualSearchOverride?.reason)) {
      currentDiagnostic = { ...currentDiagnostic, planning: { ...currentDiagnostic.planning, reason: "scene_preference" } };
    }
    const removedDayImage = userRemovedDayImage(result.data, slotId, binding || {})
      || planned?.moduleType === 'transport' && planned.required === false
        && result.data?.imageLocks?.[slotId]?.source === 'user_cleared' && !getSlotImage(result.data, binding)?.src;
    return {
      slotId,
      module: moduleName(slotId),
      label: binding?.cardTitle || planned?.primaryVisualSubject || planned?.subject || SLOT_LABELS[slotId] || slotId,
      primaryVisualSubject: planned?.primaryVisualSubject || planned?.subject || planned?.activity || "",
      resolutionPolicy: { ...targetResolutionPolicy(context, slotId), allowManualLowResolution: true },
      resolutionPolicyByMovedSourceSlotId: Object.fromEntries((result.imageExecution?.results || [])
        .filter((item) => item.slotId !== slotId && (item.selected?.localUrl || item.provisionalSelected?.localUrl))
        .map((item) => [item.slotId, { ...targetResolutionPolicy(context, slotId, [item.slotId]), allowManualLowResolution: true }])),
      targetFingerprint,
      status: removedDayImage ? "user_removed" : slotReviewStatus(imageResult, candidates),
      provisionalSelected: imageResult.provisionalSelected || null,
      required: removedDayImage ? false : planned ? planned.required !== false : binding?.required === true,
      originalVisualTarget: imageResult.manualAction?.originalVisualTarget || (planned ? { location: planned.location, hotel: planned.hotel, activity: planned.activity, subject: planned.subject, visualGoal: planned.visualGoal } : null),
      currentResult: { previousStatus: currentSearch.previousStatus, status: currentSearch.status, technicalStatus: currentSearch.technicalStatus, matchReason: currentSearch.matchReason },
      searchDiagnostic: currentDiagnostic,
      candidateCount: candidates.length,
      confirmableCandidateCount: candidates.filter((candidate) => candidate.canConfirm).length,
      selectableCandidateIds: [...selectables],
      userRequiredActions: imageResult.manualAction?.userRequiredActions || (binding?.manualEditorCard ? ["upload_real_image"] : ["upload_real_image", "explicit_single_slot_search"]),
      candidates,
    };
  });
  const imageCandidates = uniqueCandidates((result.imageExecution?.results || []).flatMap((imageResult) => {
    const binding = result.data?.simpleImageSlotBindings?.[imageResult.slotId] || plan.slotBindings?.[imageResult.slotId];
    const targetFingerprint = imageTargetFingerprint(plan.imageSlots.find((slot) => slot.slotId === imageResult.slotId));
    return visibleCandidatePool(imageResult).map((candidate) => frontendCandidate(candidate, imageResult.slotId, binding, candidateCanBeSelected(result, imageResult, candidate), targetFingerprint));
  }));
  const unresolvedItems = effectiveUnresolvedItems(result.unresolvedItems || [], result.data || {}, plan).filter((item) => item.kind !== "renderer" || !rendererItemIsOnlyClarityWarning(item, result.render || {}));
  const unresolvedRequired = unresolvedItems.filter((item) => item.required);
  const canEnterFinal = unresolvedRequired.length === 0 && Boolean(result.outputPath);
  const outputUrl = canEnterFinal ? `/api/simple/projects/${projectId}/output` : null;
  const notices = unresolvedNotices(unresolvedItems);
  const blockers = blockingItems(unresolvedItems, result.data || {}, plan, result.render || {}, slots);
  const optionalImageItems = optionalTransportImageItems(result, plan);
  const draftRendered = result.renderStatus === "success" && result.render?.mode === "draft";
  const reviewBySlotId = new Map(slots.map((slot) => [slot.slotId, slot]));
  const editorBindings = Object.fromEntries(Object.entries(result.data?.simpleImageSlotBindings || plan.slotBindings || {}).map(([slotId, binding]) => {
    const review = reviewBySlotId.get(slotId);
    const withTarget = { ...binding, targetFingerprint: review?.targetFingerprint || "" };
    if (!review || binding.module !== "day") return [slotId, withTarget];
    return [slotId, {
      ...withTarget,
      required: review.status === "user_removed" ? false : binding.required,
      editorImageStatus: SLOT_STATUS_LABELS[review.status] || "等待处理",
      editorImageRequired: review.required,
      editorPrimaryVisualSubject: review.primaryVisualSubject,
    }];
  }));
  const payload = {
    project: {
      id: project.projectId,
      projectId: project.projectId,
      title: result.data?.title || project.source?.name || "Simple Pipeline 行程",
      workflowStage: result.pipelineStatus,
      status: project.status,
      currentStage: project.currentStage,
      progress: project.progress,
      versions: outputUrl ? [{ id: `simple-${run.executionRunId}`, name: `${result.data?.title || "行程"} · 正式版本`, createdAt: Date.parse(result.completedAt || result.updatedAt || project.updatedAt || new Date().toISOString()), downloadUrl: outputUrl }] : [],
      visibility: result.visibility || {},
      data: { ...result.data, imageCandidates, imageReview: { slots }, simpleImageSlotBindings: editorBindings, generationIssues: unresolvedItems, requiredImageGate: { unresolvedSlotIds: unresolvedRequired.filter((item) => item.kind === "image").map((item) => item.id), passed: unresolvedRequired.filter((item) => item.kind === "image").length === 0 } },
    },
    executionRunId: run.executionRunId,
    manualRevision: result.manualImageCompletion?.revision || null,
    manualVersion: result.manualImageCompletion?.version || 0,
    renderPending: result.renderStatus === "pending_manual_render",
    renderFailed: ['failed', 'blocked'].includes(result.renderStatus),
    pipelineStatus: result.pipelineStatus,
    outputPath: result.outputPath || null,
    outputUrl,
    unresolvedRequiredCount: unresolvedRequired.length,
    unresolvedRequiredSlotIds: unresolvedRequired.map((item) => item.id),
    unresolvedCopyCount: unresolvedItems.filter((item) => item.kind === "copy").length,
    unresolvedImageCount: unresolvedItems.filter((item) => item.kind === "image").length,
    unresolvedNotices: notices,
    blockingItems: blockers,
    optionalImageItems,
    draftRendered,
    canEnterEditor: true,
    canEnterFinal,
    imageReview: { slots },
    metrics: {
      plannerModelCalls: 0,
      copyModelCalls: 0,
      automaticImageFollowupRounds: 0,
    },
  };
  if (compact) {
    // Identical review objects occur at both top level and project.data.
    // Opt-in clients restore the shared reference before merging editor state.
    delete payload.project.data.imageReview;
    payload.compactImageResponse = true;
  }
  return payload;
}

export function simpleImageSelectionState(store, projectId, slotId, requestId) {
  const { run, result } = projectContext(store, projectId);
  const selected = result.imageExecution?.results?.find(item => item.slotId === slotId)?.selected;
  const saved = Boolean(requestId && selected?.humanDecision?.requestId === requestId);
  return { requestId, executionRunId: run.executionRunId, saved,
    candidateId: saved ? selected.candidateId : null,
    manualRevision: result.manualImageCompletion?.revision || null,
    manualVersion: result.manualImageCompletion?.version || 0,
    renderPending: result.renderStatus === 'pending_manual_render',
    renderFailed: ['failed', 'blocked'].includes(result.renderStatus) };
}

function selectedCandidate(imageResult, candidateId) {
  return candidatePool(imageResult).find((item) => item.candidateId === candidateId) || null;
}

async function persistResult({ store, root, project, run, plan, result, imageExecution, action, render = runSimpleRenderer, deferRender = false, trace, compactResponse = false }) {
  trace ||= createOperationTrace('manual_image', { projectId: project.projectId, executionRunId: run.executionRunId, slotId: action.slotId, requestId: action.requestId });
  const affected = new Set([...(action.slotIds || []), action.slotId, ...(action.humanDecision?.movedFrom || [])].filter(Boolean));
  const beforeReconcile = new Map((imageExecution.results || []).map((item) => [item.slotId, item]));
  imageExecution = await trace.measure('reconcile', () => reconcileProvisionalImageSelections({ slots: plan.imageSlots, execution: imageExecution, root, preparedData: result.data, slotBindings: result.data?.simpleImageSlotBindings || plan.slotBindings }));
  for (const item of imageExecution.results || []) {
    if (beforeReconcile.get(item.slotId)?.provisionalSelected && !item.provisionalSelected) affected.add(item.slotId);
  }
  assertSimpleResultCurrent({ store, project, run, result, operation: action.type });
  const taskResultIds = new Set(affected);
  const explicitSearch = action.type === "explicit_single_slot_search" || action.type === "explicit_multi_slot_search";
  if (action.type === "explicit_single_slot_search" && result.imageExecution?.results?.find(item => item.slotId === action.slotId)?.selected) affected.delete(action.slotId);
  for (const item of imageExecution.results || []) if (taskResultIds.has(item.slotId)) store.saveTaskResult(project.projectId, run.executionRunId, `image-${item.slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, item);
  const writeback = applySimpleSkillResults({
    preparedData: result.data || plan.preparedData,
    copyTasks: [],
    copyExecution: result.copyExecution,
    imageSlots: plan.imageSlots.filter(slot => affected.has(slot.slotId)).map(slot => ({ ...slot, userLocked: false })),
    slotBindings: action.type === "clear_image" ? { ...plan.slotBindings, ...result.data?.simpleImageSlotBindings } : plan.slotBindings,
    imageExecution,
  });
  writeback.copyWriteback = result.writeback?.copy || [];
  writeback.unresolvedItems.push(...(result.unresolvedItems || []).filter(item => item.kind !== "renderer" && !(item.kind === "image" && affected.has(item.id))));
  writeback.unresolvedItems = effectiveUnresolvedItems(writeback.unresolvedItems, writeback.data, plan);
  writeback.data.simpleImageSlotBindings ||= plan.slotBindings;
  for (const slotId of affected) {
    if (action.type === "editor_day_update") continue;
    const selected = imageExecution.results.find(item => item.slotId === slotId)?.selected;
    const binding = plan.slotBindings[slotId];
    if (selected && binding) {
      const image = getSlotImage(writeback.data, binding);
      if (image) setSlotImage(writeback.data, binding, { ...image, userProvided: Boolean(selected.userProvided), userSelected: Boolean(selected.userSelected) });
    }
    if (!explicitSearch) writeback.data.imageLocks = { ...writeback.data.imageLocks, [slotId]: { source: slotId !== action.slotId ? "user_moved_out" : action.type === "clear_image" ? "user_cleared" : action.type === "upload_real_image" ? "user_upload" : "user_selection", candidateId: selected?.candidateId || null, lockedAt: Date.now() } };
  }
  writeback.requiredUnresolved = writeback.unresolvedItems.filter(item => item.required);
  const revision = randomUUID();
  const pending = { ...result, data: writeback.data, imageExecution, unresolvedItems: writeback.unresolvedItems, outputPath: null, pipelineStatus: "partial", renderStatus: "pending_manual_render", manualImageCompletion: { ...result.manualImageCompletion, revision, version: Number(result.manualImageCompletion?.version || 0) + 1, slotIds: manualSlotIds({ ...result, data: writeback.data, unresolvedItems: writeback.unresolvedItems }, plan), lastAction: action } };
  // Save the binding before export verification; stale output must not be downloadable.
  const persistStarted = Date.now();
  trace.emit('persist_start');
  store.saveFinalResult(project.projectId, run.executionRunId, pending);
  store.updateProject(project.projectId, { status: "partial", progress: 90, currentStage: "图片已保存，正在检查成品", outputPath: null });
  trace.emit('persist_end', { durationMs: Date.now() - persistStarted });
  trace.emit('selection_persisted', { version: pending.manualImageCompletion.version });
  const key = path.resolve(root, project.projectId);
  const queuedAt = Date.now();
  const finish = async () => {
  trace.emit('render_queue_end', { durationMs: Date.now() - queuedAt });
  if (store.getFinalResult(project.projectId, run.executionRunId)?.manualImageCompletion?.revision !== revision) { trace.emit('render_superseded'); return; }
  const safeRender = async (input) => {
    try { return await render({ ...input, requestId: trace.requestId, revision,
      canRender: () => store.getProject(project.projectId)?.activeExecutionRunId === run.executionRunId
        && store.getFinalResult(project.projectId, run.executionRunId)?.manualImageCompletion?.revision === revision,
      onQueueState: state => {
        if (state.state !== 'queued' && state.state !== 'running') return;
        const active = store.getProject(project.projectId);
        if (active?.activeExecutionRunId !== run.executionRunId || store.getFinalResult(project.projectId, run.executionRunId)?.manualImageCompletion?.revision !== revision) return;
        store.updateProject(project.projectId, { currentStage: state.state === 'queued' ? '图片已保存，等待检查成品' : '图片已保存，正在检查成品' });
      } }); }
    catch (error) { return { status: "failed", timing: error.renderTiming, error: { code: error.code || "manual_render_failed", message: error.message, diagnostic: error.diagnostic } }; }
  };
  const renderMode = writeback.requiredUnresolved.length ? "draft" : "final";
  const customerData = applyModuleVisibility(writeback.data, result.visibility || {});
  let renderResult = await safeRender({ data: customerData, projectId: project.projectId, root, mode: renderMode });
  if (renderResult.status === 'superseded') return;
  if (renderMode === "final" && renderResult.status !== "success") {
    const finalAttempt = renderResult;
    writeback.unresolvedItems.push(buildRendererUnresolvedItem(finalAttempt));
    renderResult = await safeRender({ data: customerData, projectId: project.projectId, root, mode: "draft" });
    if (renderResult.status === 'superseded') return;
    renderResult = { ...renderResult, mode: "draft", rendererCalls: Number(finalAttempt.rendererCalls || 0) + Number(renderResult.rendererCalls || 0), finalAttempt };
  }
  renderResult.mode ||= renderMode;
  if (renderResult.status !== "success" && !writeback.unresolvedItems.some((item) => item.kind === "renderer")) {
    writeback.unresolvedItems.push(buildRendererUnresolvedItem(renderResult, "2000px Renderer 未通过"));
  }
  const unresolvedRequired = writeback.unresolvedItems.filter((item) => item.required);
  const complete = renderResult.status === "success" && unresolvedRequired.length === 0;
  const pipelineStatus = complete ? "complete" : "partial";
  const now = new Date().toISOString();
  const nextResult = {
    ...pending,
    pipelineStatus,
    imageExecution,
    writeback: { copy: writeback.copyWriteback, images: writeback.imageWriteback },
    unresolvedItems: writeback.unresolvedItems,
    renderStatus: renderResult.status,
    outputPath: renderResult.outputPath || null,
    data: writeback.data,
    render: renderResult,
    manualImageCompletion: {
      ...pending.manualImageCompletion,
      revision,
      slotIds: manualSlotIds(pending, plan),
      lastAction: action,
      updatedAt: now,
      plannerModelCalls: 0,
      copyModelCalls: 0,
      automaticImageFollowupRounds: 0,
      rendererCalls: Number(result.manualImageCompletion?.rendererCalls || 0) + Number(renderResult.rendererCalls || 0),
    },
  };
  if (store.getFinalResult(project.projectId, run.executionRunId)?.manualImageCompletion?.revision !== revision) return;
  store.saveFinalResult(project.projectId, run.executionRunId, nextResult);
  store.saveEvidence(project.projectId, run.executionRunId, `manual-image-${Date.now()}`, { ...action, pipelineStatus, unresolvedRequired: unresolvedRequired.map((item) => item.id), rendererStatus: renderResult.status, savedAt: now });
  const nextRun = { ...run, status: pipelineStatus, progress: complete ? 100 : 90, executionEnabled: false, currentStage: complete ? "完成" : "可编辑草稿", updatedAt: now };
  store.updateExecutionRun(project.projectId, nextRun);
  store.updateProject(project.projectId, { status: pipelineStatus, currentStage: nextRun.currentStage, progress: nextRun.progress, outputPath: renderResult.outputPath || null });
  trace.emit('render_complete', { status: renderResult.status, mode: renderMode });
  };
  const job = (manualRenders.get(key) || Promise.resolve()).catch(() => {}).then(finish);
  manualRenders.set(key, job);
  job.catch(error => console.error("Manual image verification failed:", error.message)).finally(() => { if (manualRenders.get(key) === job) manualRenders.delete(key); });
  if (!deferRender) await job;
  return trace.measure('payload_build', () => buildSimpleManualImagePayload(store, project.projectId, { compact: compactResponse }));
}

function csvValues(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function localizeKnowledgeCandidate({
  candidate, root, projectId, knowledgeImageConfig = {}, downloadImage = downloadCandidate,
  refreshMatchedFile = refreshKnowledgeMatchedFile, resolutionPolicy = {}, trace,
} = {}) {
  if (candidate.localUrl?.startsWith("/image-assets/")) return { candidate, attempts: 0, success: 0, saved: 0, durationMs: 0 };
  if (candidate.sourceKind !== "knowledge_library" || !candidate.knowledgeMatchedFile) {
    throw Object.assign(new Error("该候选没有可延迟下载的知识库原件"), { code: "candidate_original_missing" });
  }
  const startedAt = Date.now();
  const baseUrl = String(knowledgeImageConfig.knowledgeBaseUrl || process.env.IMAGE_KNOWLEDGE_BASE_URL || "").replace(/\/$/, "");
  const trustedOrigins = knowledgeImageConfig.trustedKnowledgeOrigins || csvValues(process.env.IMAGE_KNOWLEDGE_DOWNLOAD_ORIGINS);
  const requestTimeoutMs = Number(knowledgeImageConfig.knowledgeRequestTimeoutMs || process.env.IMAGE_KNOWLEDGE_REQUEST_TIMEOUT_MS || 30_000);
  const queryIds = candidate.knowledgeQueryIds?.length ? candidate.knowledgeQueryIds : [candidate.knowledgeQueryId].filter(Boolean);
  let matchedFile = candidate.knowledgeMatchedFile;
  const refresh = () => trace ? trace.measure('original_url_refresh', () => refreshMatchedFile({ baseUrl, queryIds, candidate, requestTimeoutMs })) : refreshMatchedFile({ baseUrl, queryIds, candidate, requestTimeoutMs });
  let attempts = 0;
  const directory = path.join(root, "output", "image-assets", `simple-manual-${projectId}`);
  const publicPrefix = `/image-assets/simple-manual-${projectId}`;
  const download = async () => {
    attempts += 1;
    const downloaded = await downloadImage({ ...candidate, imageUrl: matchedFile.url, title: matchedFile.filename || candidate.sourceTitle || candidate.title }, { directory, publicPrefix, trustedKnowledgeOrigins: trustedOrigins, ...resolutionPolicy });
    return {
      ...candidate,
      filePath: downloaded.filePath,
      publicUrl: downloaded.publicUrl,
      localUrl: downloaded.publicUrl,
      sha256: downloaded.sha256,
      width: downloaded.width,
      height: downloaded.height,
      bytes: downloaded.bytes,
      contentType: downloaded.contentType,
      originalMime: downloaded.sourceContentType || candidate.originalMime || matchedFile.mimeType || null,
      storedMime: downloaded.contentType,
      sourceFormat: downloaded.sourceFormat || null,
      sourceBytes: downloaded.sourceBytes || null,
      conversion: downloaded.conversion || null,
      originalDownloaded: true,
      originalDownloadStatus: "success",
      knowledgeMatchedFile: { ...matchedFile, url: null },
    };
  };
  try {
    if (!matchedFile.url) matchedFile = await refresh();
    try {
      const localized = await download();
      return { candidate: localized, attempts, success: 1, saved: 1, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (!baseUrl || !queryIds.length || !/\b(?:401|403|404)\b|expired|失效|签名/i.test(error?.message || "")) throw error;
      matchedFile = await refresh();
      const localized = await download();
      return { candidate: localized, attempts, success: 1, saved: 1, durationMs: Date.now() - startedAt };
    }
  } catch (error) {
    error.code ||= "preview_found_original_download_failed";
    error.originalDownloadAttempts = attempts;
    error.originalDownloadDurationMs = Date.now() - startedAt;
    throw error;
  }
}

async function localizeRemoteCandidate({ candidate, root, projectId, downloadImage = downloadCandidate, resolutionPolicy = {} } = {}) {
  if (candidate.localUrl?.startsWith("/image-assets/")) return { candidate, attempts: 0, success: 0, saved: 0, durationMs: 0 };
  const existingAsset = [candidate.publicUrl]
    .find((value) => String(value || "").startsWith("/image-assets/"));
  if (existingAsset) return { candidate: { ...candidate, localUrl: existingAsset }, attempts: 0, success: 0, saved: 0, durationMs: 0 };
  const imageUrl = [candidate.imageUrl, candidate.publicUrl, candidate.previewUrl, candidate.localPreviewUrl]
    .find((value) => /^https?:\/\//i.test(String(value || "")));
  if (!imageUrl) throw Object.assign(new Error("该候选没有可下载的原图地址"), { code: "candidate_original_missing" });
  const startedAt = Date.now();
  const directory = path.join(root, "output", "image-assets", `simple-manual-${projectId}`);
  const publicPrefix = `/image-assets/simple-manual-${projectId}`;
  try {
    const downloaded = await downloadImage({ ...candidate, imageUrl }, { directory, publicPrefix, ...resolutionPolicy });
    return {
      candidate: {
        ...candidate,
        filePath: downloaded.filePath,
        publicUrl: downloaded.publicUrl,
        localUrl: downloaded.publicUrl,
        sha256: downloaded.sha256,
        width: downloaded.width,
        height: downloaded.height,
        bytes: downloaded.bytes,
        contentType: downloaded.contentType,
        originalMime: downloaded.sourceContentType || candidate.originalMime || null,
        storedMime: downloaded.contentType,
        sourceFormat: downloaded.sourceFormat || null,
        sourceBytes: downloaded.sourceBytes || null,
        conversion: downloaded.conversion || null,
        originalDownloaded: true,
        originalDownloadStatus: "success",
      },
      attempts: 1,
      success: 1,
      saved: 1,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    error.code ||= "preview_found_original_download_failed";
    error.originalDownloadAttempts = 1;
    error.originalDownloadDurationMs = Date.now() - startedAt;
    throw error;
  }
}

function originalDownloadFailureCode(error) {
  const message = `${error?.code || ""} ${error?.message || ""}`;
  if (/unsupported|不支持的图片格式|invalid format/i.test(message)) return "unsupported_format";
  if (/too[_ -]?large|文件过大|资源上限|invalid size/i.test(message)) return "file_too_large";
  if (/resolution|分辨率不足|low[_ -]?resolution/i.test(message)) return "resolution_failed";
  return "preview_found_original_download_failed";
}

function patchCandidateInImageResult(imageResult, candidateId, patch) {
  const update = (candidate) => candidate?.candidateId === candidateId ? { ...candidate, ...patch } : candidate;
  return {
    ...imageResult,
    selected: imageResult.selected,
    candidates: (imageResult.candidates || []).map(update),
    manualAction: imageResult.manualAction ? {
      ...imageResult.manualAction,
      selectableCandidates: (imageResult.manualAction.selectableCandidates || []).map(update),
      rejectedCandidates: (imageResult.manualAction.rejectedCandidates || []).map(update),
    } : imageResult.manualAction,
  };
}

export async function chooseSimpleImageCandidate(input = {}) {
  const trace = input.trace || createOperationTrace('image_select', input);
  try { return await chooseImageCandidate({ ...input, trace }); }
  catch (error) { trace.emit('select_failed', { code: error?.code || 'manual_image_decision_failed' }); throw error; }
}

async function chooseImageCandidate({ store, root, projectId, slotId, candidateId, manualConfirmed = false, render, deferRender = false, knowledgeImageConfig, downloadImage, refreshMatchedFile, trace, compactResponse = false } = {}) {
  let context = projectContext(store, projectId);
  assertPlannedImageSlot(context, slotId);
  let imageResults = context.result.imageExecution?.results || [];
  let current = imageResults.find((item) => item.slotId === slotId);
  if (!current) throw Object.assign(new Error("该图片位没有已保存结果"), { code: "slot_result_missing" });
  const source = imageResults.find((item) => selectedCandidate(item, candidateId));
  let candidate = source && selectedCandidate(source, candidateId);
  if (!candidate) throw Object.assign(new Error("当前项目中找不到该候选"), { code: "candidate_not_found" });
  const programCheckOverride = isHardRejectedCandidate(candidate) && canConfirmModelApprovedProgramRejection(candidate);
  if (isHardRejectedCandidate(candidate) && !programCheckOverride) throw Object.assign(new Error("该候选命中硬拒绝条件，不能采用"), { code: "candidate_hard_rejected" });
  if (programCheckOverride && !manualConfirmed) throw Object.assign(new Error("模型认可与采用检查不一致，请查看图片及原因后明确确认采用"), { code: "manual_confirmation_required" });
  if (current.provisionalSelected?.candidateId === candidateId && !manualConfirmed) throw Object.assign(new Error("预填图片须明确确认具体实体身份"), { code: "manual_confirmation_required" });
  const overridesAutomaticJudgment = source.slotId !== slotId || !candidateCanBeSelected(context.result, current, candidate);
  if (overridesAutomaticJudgment && !manualConfirmed) throw Object.assign(new Error("未确认图片风险，不能采用"), { code: "manual_confirmation_required" });
  const resolutionPolicy = manualConfirmed ? { minWidth: 1, minHeight: 1 } : targetResolutionPolicy(context, slotId, source.slotId !== slotId && (source.selected?.candidateId === candidateId || source.provisionalSelected?.candidateId === candidateId) ? [source.slotId] : []);
  let delayedOriginal = { attempts: 0, success: 0, saved: 0, durationMs: 0 };
  if (!candidate.localUrl?.startsWith("/image-assets/")) {
    try {
      delayedOriginal = await trace.measure('original_download', async () => candidate.sourceKind === "knowledge_library"
        ? await localizeKnowledgeCandidate({ candidate, root, projectId, knowledgeImageConfig, downloadImage, refreshMatchedFile, resolutionPolicy, trace })
        : await localizeRemoteCandidate({ candidate, root, projectId, downloadImage, resolutionPolicy }));
      candidate = delayedOriginal.candidate;
    } catch (error) {
      const failureCode = originalDownloadFailureCode(error);
      const failedPatch = {
        originalDownloaded: false,
        originalDownloadStatus: "failed",
        originalDownloadFailureCode: failureCode,
        originalDownloadFailureReason: error?.message || String(error),
        autoReviewStatus: "original_download_failed",
      };
      const nextResults = imageResults.map((item) => patchCandidateInImageResult(item, candidateId, failedPatch));
      const previousMetrics = context.result.imageExecution?.metrics || {};
      const imageExecution = { ...context.result.imageExecution, results: nextResults, metrics: {
        ...previousMetrics,
        matchedFileDownloadAttempts: Number(previousMetrics.matchedFileDownloadAttempts || 0) + Number(error?.originalDownloadAttempts || 0),
        originalDownloadTimeMs: Number(previousMetrics.originalDownloadTimeMs || 0) + Number(error?.originalDownloadDurationMs || 0),
      } };
      const sourceResult = nextResults.find((item) => item.slotId === source.slotId);
      assertSimpleResultCurrent({ store, ...context, operation: 'candidate_download_failure' });
      if (sourceResult) store.saveTaskResult(projectId, context.run.executionRunId, `image-${source.slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, sourceResult);
      store.saveFinalResult(projectId, context.run.executionRunId, { ...context.result, imageExecution, updatedAt: new Date().toISOString() });
      error.code = failureCode;
      throw error;
    }
  }
  try {
    const decodeStarted = Date.now();
    trace.emit('decode_start');
    if (!candidate.localUrl?.startsWith('/image-assets/')) throw new Error('missing local asset');
    const assets = await realpath(path.join(root, 'output', 'image-assets'));
    const file = await realpath(path.resolve(assets, decodeURIComponent(candidate.localUrl.slice('/image-assets/'.length))));
    const relative = path.relative(assets, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside assets');
    const info = await stat(file);
    if (!info.isFile() || !info.size || info.size > MAX_IMAGE_BYTES) throw Object.assign(new Error('图片文件为空或超过14MB'), { code: 'image_size_invalid' });
    const metadata = await decodeSafeImage(file);
    if (!manualConfirmed) assertTargetResolution(metadata.width || 0, metadata.height || 0, targetResolutionPolicy(context, slotId, imageResults.filter((item) => item.slotId !== slotId && (item.selected?.localUrl === candidate.localUrl || item.provisionalSelected?.localUrl === candidate.localUrl)).map((item) => item.slotId)));
    candidate = { ...candidate, width: metadata.width, height: metadata.height };
    trace.emit('decode_end', { durationMs: Date.now() - decodeStarted, width: metadata.width, height: metadata.height });
  } catch (error) {
    trace.emit('decode_failed', { code: error?.code || 'candidate_file_unusable' });
    if (['image_resolution_insufficient', 'image_pixel_limit_exceeded', 'image_format_unsupported', 'image_size_invalid'].includes(error?.code)) throw error;
    if (error?.code === 'ENOENT') throw Object.assign(new Error('图片原件已不存在，请重新搜索或上传'), { code: 'candidate_file_missing' });
    throw Object.assign(new Error('图片文件缺失、损坏或无法安全解码，请重新上传'), { code: 'candidate_file_unusable' });
  }
  context = projectContext(store, projectId);
  imageResults = context.result.imageExecution?.results || [];
  current = imageResults.find(item => item.slotId === slotId);
  const movedFrom = imageResults.filter((item) => item.slotId !== slotId && (item.selected?.localUrl === candidate.localUrl || item.provisionalSelected?.localUrl === candidate.localUrl)).map((item) => item.slotId);
  const humanDecision = { requestId: trace.requestId, action: movedFrom.length ? 'move' : 'adopt', decidedAt: new Date().toISOString(), targetSlotId: slotId, sourceSlotId: source.slotId, movedFrom, riskConfirmed: manualConfirmed, overridesAutomaticJudgment, ...(programCheckOverride ? { programCheckOverride: true } : {}), originalRejection: candidate.rejection || null, originalRisk: candidate.rejectionReason || candidate.matchReason || candidate.reason || '' };
  const { provisionalSelected: _discardedProvisional, ...currentWithoutProvisional } = current;
  const nextCurrent = {
    ...currentWithoutProvisional,
    status: "success",
    matchLevel: "user_selected_candidate",
    selected: { ...candidate, localUrl: candidate.localUrl, userSelected: true, humanDecision, selectedAt: new Date().toISOString() },
    actualSubject: candidate.actualSubject || current.actualSubject,
    matchReason: "用户从已保存候选中明确采用",
    technicalStatus: "user_selected_existing_candidate",
    manualAction: { ...(current.manualAction || {}), resolvedBy: "choose_existing_candidate", selectedCandidateId: candidateId, resolvedAt: new Date().toISOString() },
  };
  const nextResults = imageResults.map((item) => item.slotId === slotId ? nextCurrent : movedFrom.includes(item.slotId) ? { ...item, status: 'needs_user_action', selected: null, provisionalSelected: null, candidates: candidatePool(item), matchReason: '图片已由用户移动至其他位置', manualAction: { ...item.manualAction, movedTo: slotId, humanDecision } } : item);
  const previousMetrics = context.result.imageExecution?.metrics || {};
  const imageExecution = { ...context.result.imageExecution, results: nextResults, metrics: {
    ...previousMetrics,
    automaticFollowupRounds: 0,
    matchedFileDownloadAttempts: Number(previousMetrics.matchedFileDownloadAttempts || 0) + delayedOriginal.attempts,
    matchedFileDownloadSuccess: Number(previousMetrics.matchedFileDownloadSuccess || 0) + delayedOriginal.success,
    originalDownloadSavedCount: Number(previousMetrics.originalDownloadSavedCount || 0) + delayedOriginal.saved,
    originalDownloadTimeMs: Number(previousMetrics.originalDownloadTimeMs || 0) + delayedOriginal.durationMs,
  } };
  for (const item of nextResults.filter((item) => movedFrom.includes(item.slotId))) store.saveTaskResult(projectId, context.run.executionRunId, `image-${item.slotId.replace(/[^a-zA-Z0-9_-]/g, '-')}`, item);
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, store, root, imageExecution, render, deferRender, trace, compactResponse, action: { type: "choose_existing_candidate", slotId, candidateId, requestId: trace.requestId, humanDecision } });
}

export async function rejectSimpleImageCandidate({ store, root, projectId, slotId, candidateId, render } = {}) {
  const context = projectContext(store, projectId);
  const imageResults = context.result.imageExecution?.results || [];
  const current = imageResults.find((item) => item.slotId === slotId);
  const allowed = current ? selectableIds(context.result, current) : new Set();
  if (!allowed.has(candidateId)) throw Object.assign(new Error("该候选不可执行人工拒绝"), { code: "candidate_not_selectable" });
  const manualAction = current.manualAction || {};
  const selectableCandidates = (manualAction.selectableCandidates || []).filter((item) => item.candidateId !== candidateId);
  const rejected = selectedCandidate(current, candidateId);
  const rejectedProvisional = current.provisionalSelected?.candidateId === candidateId;
  const nextCurrent = { ...current, ...(rejectedProvisional ? { provisionalSelected: null, status: "needs_user_action", selected: null } : {}), manualAction: { ...manualAction, selectableCandidates, rejectedCandidates: uniqueCandidates([...(manualAction.rejectedCandidates || []), rejected ? { ...rejected, userDecision: "rejected", userDecidedAt: new Date().toISOString() } : null].filter(Boolean)) } };
  const imageExecution = { ...context.result.imageExecution, results: imageResults.map((item) => item.slotId === slotId ? nextCurrent : item), metrics: { ...(context.result.imageExecution?.metrics || {}), automaticFollowupRounds: 0 } };
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, store, root, imageExecution, render, action: { type: "reject_existing_candidate", slotId, candidateId } });
}

export async function saveSimpleDayEditor({ store, root, projectId, dayIndex, day, bindings = {}, included, excluded, pendingConfirmations, render, deferRender = false } = {}) {
  const context = projectContext(store, projectId);
  const index = Number(dayIndex);
  if (!Number.isInteger(index) || index < 0 || !context.result.data?.days?.[index]) throw Object.assign(new Error("目标日期不存在"), { code: "day_not_found" });
  if (!Array.isArray(day?.spots) || day.spots.length > 30) throw Object.assign(new Error("体验卡片数据无效"), { code: "day_spots_invalid" });

  const currentData = context.result.data;
  const currentDay = currentData.days[index];
  const currentSpots = new Map((currentDay.spots || []).map((spot) => [String(spot.id || ""), spot]));
  const seen = new Set();
  const spots = day.spots.map((spot) => {
    const id = String(spot?.id || "").trim();
    if (!id || seen.has(id)) throw Object.assign(new Error("体验卡片缺少稳定 ID 或存在重复 ID"), { code: "spot_id_invalid" });
    seen.add(id);
    const previous = currentSpots.get(id);
    if (!previous && spot.userProvided !== true) throw Object.assign(new Error("新增体验卡片必须标记为人工创建"), { code: "manual_spot_invalid" });
    const text = (value, max) => String(value || "").slice(0, max);
    return {
      ...(previous || {}),
      ...spot,
      id,
      name: text(spot.name, 120) || "新体验卡片",
      description: text(spot.description || spot.experience, 2000),
      reminder: text(spot.reminder, 800),
      images: Array.isArray(previous?.images) ? previous.images : [],
      sourceEvidence: previous?.sourceEvidence || spot.sourceEvidence || [],
      userProvided: previous?.userProvided === true || spot.userProvided === true,
    };
  });

  const allCurrentBindings = currentData.simpleImageSlotBindings || context.plan.slotBindings || {};
  const currentDayBindings = Object.fromEntries(Object.entries(allCurrentBindings).filter(([, binding]) => binding.module === "day" && binding.dayIndex === index));
  for (const [slotId, binding] of Object.entries(currentDayBindings)) {
    if (binding.manualEditorCard !== true && !bindings[slotId]) throw Object.assign(new Error("Planner 图片位不能从编辑器中删除"), { code: "planned_slot_missing" });
  }

  const nextDayBindings = {};
  for (const [slotId, incoming] of Object.entries(bindings || {})) {
    const previous = currentDayBindings[slotId];
    const isManual = previous?.manualEditorCard === true || incoming?.manualEditorCard === true;
    if (!previous && (!isManual || !slotId.startsWith(`manual:day:${index + 1}:`))) throw Object.assign(new Error("只能新增人工体验卡片图片位"), { code: "manual_slot_invalid" });
    if (incoming?.module !== "day" || Number(incoming.dayIndex) !== index) throw Object.assign(new Error("图片位与当前日期不一致"), { code: "slot_day_mismatch" });
    const useSpotCopy = incoming.useSpotCopy !== false;
    const stableSpotId = String(incoming.spotId || previous?.spotId || "");
    const stableSpotIndex = stableSpotId ? spots.findIndex((spot) => spot.id === stableSpotId) : -1;
    const spotIndex = useSpotCopy && stableSpotIndex >= 0 ? stableSpotIndex : Number(incoming.spotIndex ?? previous?.spotIndex);
    if (spotIndex < 0 || !spots[spotIndex]) throw Object.assign(new Error("图片位找不到对应体验卡片"), { code: "slot_spot_missing" });
    const imageIndex = isManual ? 0 : Number.isInteger(Number(previous?.imageIndex)) ? Number(previous.imageIndex) : Number(incoming.imageIndex || 0);
    nextDayBindings[slotId] = {
      ...(previous || {}),
      ...incoming,
      module: "day",
      dayIndex: index,
      itemIndex: index,
      spotId: useSpotCopy ? spots[spotIndex].id : undefined,
      spotIndex,
      imageIndex,
      fieldPath: `days.${index}.spots.${spotIndex}.images.${imageIndex}`,
      useSpotCopy,
      required: isManual ? false : previous?.required !== false,
      manualEditorCard: isManual,
      editorImageRequired: isManual ? false : incoming.editorImageRequired,
    };
  }

  const nextData = structuredClone(currentData);
  nextData.days[index] = { ...currentDay, ...day, spots };
  const stayChanged = ["hotel", "hotelShortName", "hotelOfficialName", "overnightType"]
    .some((key) => String(currentDay[key] ?? "") !== String(nextData.days[index][key] ?? ""));
  if (stayChanged) throw Object.assign(new Error("请在酒店模块调整入住安排"), { code: "hotel_stay_hotel_module_only" });
  nextData.simpleImageSlotBindings = {
    ...Object.fromEntries(Object.entries(allCurrentBindings).filter(([, binding]) => !(binding.module === "day" && binding.dayIndex === index))),
    ...nextDayBindings,
  };
  const manuallyResolvedCopy = [];
  for (const item of context.result.unresolvedItems || []) {
    if (item.kind !== "copy") continue;
    const task = context.plan.copyTasks?.find(task => task.targetId === item.id);
    if (!task) continue;
    if (!item.id?.startsWith("copy:visual:")) {
      if (!new RegExp(`^days\\.${index}\\.(?:theme|description|spots\\.\\d+\\.description)$`).test(task.targetPath)) continue;
      const target = { ...item, targetPath: task.targetPath };
      const value = manualCopyValue(nextData, target);
      if (typeof value !== 'string' || !value.trim() || value === manualCopyValue(currentData, target)) continue;
      const applied = applySimpleSkillResults({ preparedData: nextData, copyTasks: [{ ...task, outputSchema: manualCopySchema(task.outputSchema) }], copyExecution: { results: [{ targetId: task.targetId, targetPath: task.targetPath, value, status: 'success' }] } });
      if (!applied.unresolvedItems.length) manuallyResolvedCopy.push({ targetId: task.targetId, targetPath: task.targetPath, value });
      continue;
    }
    const slotId = item.id.slice("copy:visual:".length);
    const previousBinding = currentDayBindings[slotId];
    const binding = nextDayBindings[slotId];
    if (!previousBinding || !binding) continue;
    const previousSpot = currentDay.spots?.find((spot) => spot.id && spot.id === previousBinding.spotId) || currentDay.spots?.[previousBinding.spotIndex];
    const nextSpot = spots.find((spot) => spot.id && spot.id === binding.spotId) || spots[binding.spotIndex];
    const useSpotCopy = binding.useSpotCopy !== false;
    const previousTitle = previousBinding.cardTitle || (useSpotCopy ? previousSpot?.name : '');
    const previousDescription = useSpotCopy ? previousSpot?.experience || previousSpot?.description : previousBinding.cardDescription;
    const title = String(binding.cardTitle || (useSpotCopy ? nextSpot?.name : '') || '').trim();
    const description = String(useSpotCopy ? nextSpot?.description || nextSpot?.experience || "" : binding.cardDescription || "").trim();
    const changed = title !== String(previousTitle || "").trim() || description !== String(previousDescription || "").trim();
    if (!changed || !title || !description) continue;
    binding.cardTitle = title;
    binding.cardDescription = description;
    manuallyResolvedCopy.push({ targetId: item.id, targetPath: task.targetPath, value: { cardTitle: title, cardDescription: description } });
  }
  if (Array.isArray(included)) nextData.included = included;
  if (Array.isArray(excluded)) nextData.excluded = excluded;
  if (Array.isArray(pendingConfirmations)) nextData.pendingConfirmations = pendingConfirmations;

  const liveManualSlotIds = new Set(Object.entries(nextData.simpleImageSlotBindings).filter(([, binding]) => binding.manualEditorCard === true).map(([slotId]) => slotId));
  const currentResults = context.result.imageExecution?.results || [];
  const imageResults = currentResults.filter((item) => !allCurrentBindings[item.slotId]?.manualEditorCard || liveManualSlotIds.has(item.slotId));
  for (const slotId of liveManualSlotIds) {
    if (!imageResults.some((item) => item.slotId === slotId)) imageResults.push({ slotId, status: "needs_user_action", selected: null, candidates: [], technicalStatus: "manual_card_waiting_upload", manualAction: { userRequiredActions: ["upload_real_image"] } });
  }
  const imageExecution = { ...context.result.imageExecution, results: imageResults };
  const result = manuallyResolvedCopy.length ? resolveManualCopy({ ...context.result, data: nextData }, manuallyResolvedCopy) : { ...context.result, data: nextData };
  return persistResult({ ...context, result, store, root, imageExecution, render, deferRender, action: { type: "editor_day_update", slotId: `editor:day:${index + 1}`, dayIndex: index, resolvedCopyTargetIds: manuallyResolvedCopy.map((item) => item.targetId) } });
}

const HOTEL_FACT_LABELS = Object.freeze({ location: "位置", rooms: "客房", design: "设计", facilities: "设施" });

export async function saveSimpleHotelStay({ store, root, projectId, hotelIndex, hotelId, desiredNights, expectedSignature, render, deferRender = true } = {}) {
  const context = projectContext(store, projectId);
  const hotel = context.result.data?.hotels?.[Number(hotelIndex)];
  if (!hotel || String(hotel.id) !== String(hotelId)) throw Object.assign(new Error("酒店已变化，请重新选择"), { code: "hotel_changed" });
  const plan = planHotelNightChange(context.result.data, hotelIndex, desiredNights);
  if (!plan.ok) throw Object.assign(new Error(plan.reason), { code: "hotel_stay_invalid" });
  if (plan.signature !== expectedSignature) throw Object.assign(new Error("住宿安排已变化，请重新预览"), { code: "hotel_stay_changed" });
  const nextData = applyHotelNightChange(context.result.data, plan);
  nextData.copyQuality = { ...(nextData.copyQuality || {}), passed: false, status: "needs_copy_revision", needsReview: true, blocked: false, checkedAt: null, manualEditPendingRecheck: true };
  nextData.humanReview = { ...(nextData.humanReview || {}), exportWithCopyWarningsConfirmed: false };
  const payload = await persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution: context.result.imageExecution, render, deferRender, action: { type: "editor_hotel_stay_update", hotelId, hotelIndex: plan.hotelIndex, desiredNights: plan.desiredNights, changedDayIndexes: plan.changedDayIndexes } });
  return { manualVersion: payload.manualVersion, manualRevision: payload.manualRevision, renderPending: payload.renderPending, changedDayIndexes: plan.changedDayIndexes };
}

export async function saveSimpleHotelRegion({ store, root, projectId, hotelIndex, hotelId, region, render, deferRender = true } = {}) {
  const context = projectContext(store, projectId);
  const index = Number(hotelIndex);
  const hotel = context.result.data?.hotels?.[index];
  if (!hotel || String(hotel.id) !== String(hotelId)) throw Object.assign(new Error("酒店已变化，请重新选择"), { code: "hotel_changed" });
  const nextData = structuredClone(context.result.data);
  nextData.hotels[index].region = String(region || "").trim().slice(0, 200);
  const payload = await persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution: context.result.imageExecution, render, deferRender, action: { type: "editor_hotel_region_update", hotelId, hotelIndex: index } });
  return { region: nextData.hotels[index].region, manualVersion: payload.manualVersion, manualRevision: payload.manualRevision, renderPending: payload.renderPending };
}

export async function saveSimpleHotelFactRow({ store, root, projectId, hotelIndex, hotelId, key, text, mode = "manual", expectedText, source, render, deferRender = true } = {}) {
  const context = projectContext(store, projectId);
  const index = Number(hotelIndex);
  const hotel = context.result.data?.hotels?.[index];
  if (!hotel || String(hotel.id) !== String(hotelId)) throw Object.assign(new Error("酒店已变化，请重新选择"), { code: "hotel_changed" });
  if (!HOTEL_FACT_LABELS[key]) throw Object.assign(new Error("酒店信息字段无效"), { code: "hotel_fact_key_invalid" });
  const current = (hotel.factRows || []).find((row) => row?.key === key);
  const currentText = String(current?.text || "");
  if (mode === "fill" && currentText.trim()) return { applied: false, row: current || null };
  if (mode === "replace" && currentText !== String(expectedText ?? "")) throw Object.assign(new Error("这项文字已被修改，请重新查找后再替换"), { code: "hotel_fact_changed" });
  if (!["manual", "fill", "replace", "confirm_blank"].includes(mode)) throw Object.assign(new Error("保存方式无效"), { code: "hotel_fact_mode_invalid" });
  const value = String(text || "").trim().slice(0, 2000);
  if (mode === "confirm_blank" && (value || currentText.trim())) throw Object.assign(new Error("仅可确认尚无内容的字段留空"), { code: "hotel_fact_not_blank" });
  if (mode !== "manual" && mode !== "confirm_blank" && (!value || !source?.sourceUrl)) throw Object.assign(new Error("没有可核验的候选文字"), { code: "hotel_fact_evidence_missing" });
  const row = { key, label: HOTEL_FACT_LABELS[key], text: value, status: mode === "confirm_blank" ? "confirmed_empty" : value ? "success" : "not_found", ...(["manual", "confirm_blank"].includes(mode) ? { confirmedByUser: true } : { sourceUrl: source.sourceUrl, sourceClass: source.sourceClass || "search_highlight", sourceExcerpt: source.sourceExcerpt || "", checkedAt: source.checkedAt || new Date().toISOString(), ...(mode === "replace" ? { confirmedByUser: true } : {}) }) };
  const nextData = structuredClone(context.result.data);
  const nextHotel = nextData.hotels[index];
  nextHotel.factRows = [...(nextHotel.factRows || []).filter((item) => item?.key !== key), row];
  const payload = await persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution: context.result.imageExecution, render, deferRender, action: { type: "editor_hotel_fact_update", hotelId, hotelIndex: index, key, mode } });
  return { applied: true, row, manualVersion: payload.manualVersion, manualRevision: payload.manualRevision, renderPending: payload.renderPending };
}

export async function saveSimpleImageCrop({ store, root, projectId, slotId, expectedSrc, crop, render, deferRender = true, hotelOnly = false } = {}) {
  const context = projectContext(store, projectId);
  const editable = editableImageBinding(context, slotId);
  if (!['cover', 'hotel', 'dining', 'transport', 'day'].includes(editable.binding?.module) || (hotelOnly && editable.binding.module !== 'hotel')) throw Object.assign(new Error("这个位置不支持图片裁切"), { code: hotelOnly ? "hotel_crop_slot_invalid" : "image_crop_slot_invalid" });
  const current = getSlotImage(context.result.data, editable.binding);
  if (!current?.src || current.src !== expectedSrc) throw Object.assign(new Error("图片已变化，请重新打开裁切"), { code: hotelOnly ? "hotel_crop_image_changed" : "image_crop_image_changed" });
  if (crop !== null && (!crop || [crop.x, crop.y, crop.width, crop.height].some((value) => !Number.isFinite(value)) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1.0001 || crop.y + crop.height > 1.0001)) {
    throw Object.assign(new Error("裁切范围无效"), { code: hotelOnly ? "hotel_crop_invalid" : "image_crop_invalid" });
  }
  const nextData = structuredClone(context.result.data);
  setSlotImage(nextData, editable.binding, { ...current, crop });
  const payload = await persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution: context.result.imageExecution, render, deferRender, action: { type: "editor_image_crop_update", imageSlotId: slotId } });
  return { crop, manualVersion: payload.manualVersion, manualRevision: payload.manualRevision, renderPending: payload.renderPending };
}

export async function saveSimpleHotelImageCrop(options = {}) {
  return saveSimpleImageCrop({ ...options, hotelOnly: true });
}

export async function saveSimpleModuleVisibility({ store, root, projectId, module, visible, render, deferRender = true } = {}) {
  if (!EDITABLE_MODULE_VISIBILITY.has(module) || typeof visible !== 'boolean') throw Object.assign(new Error('模块显示状态无效'), { code: 'module_visibility_invalid' });
  const context = projectContext(store, projectId);
  const visibility = { ...(context.result.visibility || {}), [module]: visible };
  const payload = await persistResult({ ...context, result: { ...context.result, visibility }, store, root, imageExecution: context.result.imageExecution, render, deferRender, action: { type: 'editor_module_visibility_update', module, visible } });
  return { visibility, manualVersion: payload.manualVersion, manualRevision: payload.manualRevision, renderPending: payload.renderPending };
}

export async function clearSimpleImage({ store, root, projectId, slotId, expectedSrc, confirmMissingOptional = false, render, deferRender = false } = {}) {
  const context = projectContext(store, projectId);
  const editable = editableImageBinding(context, slotId);
  const currentImage = getSlotImage(context.result.data, editable.binding);
  const omitMissing = confirmMissingOptional === true && !expectedSrc && !currentImage?.src
    && optionalTransportImageItems(context.result, context.plan).some(item => item.id === slotId);
  if (!omitMissing && (!expectedSrc || currentImage?.src !== expectedSrc)) {
    throw Object.assign(new Error("图片已变化，请刷新后再删除"), { code: "image_clear_image_changed" });
  }
  const nextData = structuredClone(context.result.data);
  setSlotImage(nextData, editable.binding, null);
  nextData.imageLocks = { ...nextData.imageLocks, [slotId]: { source: "user_cleared", lockedAt: Date.now() } };
  const results = context.result.imageExecution?.results || [];
  const previous = results.find((item) => item.slotId === slotId) || { slotId, candidates: [] };
  const clearedAt = new Date().toISOString();
  const nextCurrent = {
    ...previous,
    status: "needs_user_action",
    selected: null,
    candidates: candidatePool(previous),
    technicalStatus: "user_cleared_image",
    manualAction: { ...(previous.manualAction || {}), resolvedBy: null, selectedCandidateId: null, clearedAt },
  };
  const imageExecution = {
    ...context.result.imageExecution,
    results: results.some((item) => item.slotId === slotId)
      ? results.map((item) => item.slotId === slotId ? nextCurrent : item)
      : [...results, nextCurrent],
  };
  return persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution, render, deferRender, action: { type: "clear_image", slotId, previousSrc: expectedSrc, clearedAt } });
}

export async function uploadSimpleImage({ store, root, projectId, slotId, dataUrl, fileName, render, deferRender = false } = {}) {
  let context = projectContext(store, projectId);
  editableImageBinding(context, slotId);
  const match = String(dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw Object.assign(new Error("仅支持 JPEG、PNG 或 WebP 图片"), { code: "upload_format_invalid" });
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("图片文件为空或超过 14MB"), { code: "upload_size_invalid" });
  let metadata;
  try { metadata = await decodeSafeImage(buffer); }
  catch (error) {
    if (['image_pixel_limit_exceeded', 'image_format_unsupported'].includes(error?.code)) throw error;
    throw Object.assign(new Error('图片损坏或无法安全解码，请使用完整原图重新上传'), { code: 'upload_decode_failed' });
  }
  const contentType = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : metadata.format === "webp" ? "image/webp" : "";
  if (!MIME_EXTENSIONS[contentType]) throw Object.assign(new Error("图片无法解码或格式不受支持"), { code: "upload_decode_failed" });
  const ratio = metadata.width / metadata.height;
  if (ratio < 0.65 || ratio > 3.2) throw Object.assign(new Error("图片比例不适合行程主图"), { code: "upload_ratio_invalid" });
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const assetDirName = `simple-manual-${projectId}`;
  const assetDir = path.join(root, "output", "image-assets", assetDirName);
  const assetName = `${sha256.slice(0, 20)}${MIME_EXTENSIONS[contentType]}`;
  await mkdir(assetDir, { recursive: true });
  await writeFile(path.join(assetDir, assetName), buffer, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  context = projectContext(store, projectId);
  const editable = editableImageBinding(context, slotId);
  const candidate = {
    candidateId: `user-${sha256.slice(0, 20)}`,
    localUrl: `/image-assets/${assetDirName}/${assetName}`,
    sourceTitle: fileName || "用户上传图片",
    actualSubject: `用户上传：${fileName || "已授权真实图片"}`,
    width: metadata.width,
    height: metadata.height,
    sha256,
    userProvided: true,
    uploadedAt: new Date().toISOString(),
  };
  const imageResults = context.result.imageExecution?.results || [];
  const current = imageResults.find((item) => item.slotId === slotId) || (editable.manualEditorCard ? { slotId, status: "needs_user_action", selected: null, candidates: [], manualAction: { userRequiredActions: ["upload_real_image"] } } : null);
  if (!current) throw Object.assign(new Error("该图片位没有已保存结果"), { code: "slot_result_missing" });
  const nextCurrent = {
    ...current,
    provisionalSelected: null,
    status: "success",
    matchLevel: "user_uploaded",
    selected: candidate,
    actualSubject: candidate.actualSubject,
    matchReason: "用户主动上传并确认用于当前图片位",
    technicalStatus: "user_uploaded_valid_image",
    manualAction: { ...(current.manualAction || {}), resolvedBy: "upload_real_image", selectedCandidateId: candidate.candidateId, resolvedAt: new Date().toISOString() },
  };
  const nextData = structuredClone(context.result.data);
  setSlotImage(nextData, editable.binding, { src: candidate.localUrl, focus: "50% 50%", userProvided: true, sourceTitle: candidate.sourceTitle, sha256 });
  if (nextData.simpleImageSlotBindings?.[slotId]) nextData.simpleImageSlotBindings[slotId].editorImageStatus = "已上传";
  const imageExecution = { ...context.result.imageExecution, results: imageResults.some((item) => item.slotId === slotId) ? imageResults.map((item) => item.slotId === slotId ? nextCurrent : item) : [...imageResults, nextCurrent], metrics: { ...(context.result.imageExecution?.metrics || {}), automaticFollowupRounds: 0 } };
  store.saveTaskResult(projectId, context.run.executionRunId, `image-${slotId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, nextCurrent);
  return persistResult({ ...context, result: { ...context.result, data: nextData }, store, root, imageExecution, render, deferRender, action: { type: "upload_real_image", slotId, candidateId: candidate.candidateId, fileName: fileName || null } });
}

export async function researchSimpleImageSlot({ store, root, projectId, slotId, runImage, imageOptions = {}, render, deferRender = false } = {}) {
  let context = projectContext(store, projectId);
  const slot = assertPlannedImageSlot(context, slotId);
  if (typeof runImage !== "function") throw new Error("单槽图片搜索能力未配置");
  let previousResults = context.result.imageExecution?.results || [];
  const existingImages = previousResults.filter((item) => item.selected || item.provisionalSelected).map((item) => { const image = item.selected || item.provisionalSelected; return { ...image, src: image.localUrl, slotId: item.slotId }; });
  const target = prepareExplicitImageSearchSlot({ ...slot, ...projectedTargetSlot(context, slotId) }, { plan: context.plan });
  const searched = await runImage({ ...imageOptions, root, slots: [target], existingImages, preparedData: context.plan.preparedData });
  context = projectContext(store, projectId);
  previousResults = context.result.imageExecution?.results || [];
  if (searched.status === "failed" || searched.results?.some(item => item.slotId === slotId && item.status === "failed")) throw new Error("搜索失败，请重试");
  const returned = searched.results?.find((item) => item.slotId === slotId) || { slotId, status: "not_found", selected: null, candidates: [], technicalStatus: "missing_skill_result", warnings: ["单槽搜索未返回结果"] };
  const previous = previousResults.find((item) => item.slotId === slotId) || {};
  const priorCandidates = candidatePool(previous);
  const refreshed = refreshedSearchCandidates(previous, returned);
  const mergedCandidates = refreshed.candidates;
  const preserveExistingSelection = previous.status === "success" && previous.selected;
  const nextCurrent = returned.status === "success" && !preserveExistingSelection ? {
    ...previous,
    ...returned,
    provisionalSelected: null,
    requestKind: "user_requested_single_slot_search",
    candidates: mergedCandidates,
    manualAction: { ...refreshed.manualAction, currentSearchFallbackResult: null, preservedExistingSelection: false, lastExplicitSearchAt: new Date().toISOString() },
  } : preserveExistingSelection ? {
    ...previous,
    candidates: mergedCandidates,
    requestKind: "user_requested_single_slot_search",
    manualAction: {
      ...refreshed.manualAction,
      currentSearchFallbackResult: { previousStatus: returned.status, technicalStatus: returned.technicalStatus, matchReason: returned.matchReason, queriesUsed: returned.queriesUsed, sourceEvidence: returned.sourceEvidence, pipelineEvidence: returned.pipelineEvidence, searchDiagnostic: returned.searchDiagnostic || buildImageSearchDiagnostic(returned) },
      selectableCandidates: uniqueCandidates([...(refreshed.manualAction.selectableCandidates || []), ...(returned.status === "success" && returned.selected ? [returned.selected] : [])]),
      lastExplicitSearchAt: new Date().toISOString(),
      preservedExistingSelection: true,
    },
  } : {
    ...previous,
    ...returned,
    status: "needs_user_action",
    requestKind: "user_requested_single_slot_search",
    candidates: mergedCandidates,
    manualAction: {
      ...refreshed.manualAction,
      currentSearchFallbackResult: { previousStatus: returned.status, technicalStatus: returned.technicalStatus, matchReason: returned.matchReason, queriesUsed: returned.queriesUsed, sourceEvidence: returned.sourceEvidence, pipelineEvidence: returned.pipelineEvidence, searchDiagnostic: returned.searchDiagnostic || buildImageSearchDiagnostic(returned) },
      rejectedCandidates: uniqueCandidates([...(refreshed.manualAction.rejectedCandidates || []), ...mergedCandidates]),
      lastExplicitSearchAt: new Date().toISOString(),
    },
  };
  const imageExecution = {
    ...context.result.imageExecution,
    results: previousResults.map((item) => item.slotId === slotId ? nextCurrent : item),
    metrics: {
      ...(context.result.imageExecution?.metrics || {}),
      explicitUserSingleSlotSearches: Number(context.result.imageExecution?.metrics?.explicitUserSingleSlotSearches || 0) + 1,
      automaticFollowupRounds: 0,
    },
  };
  const payload = await persistResult({ ...context, store, root, imageExecution, render, deferRender, action: { type: "explicit_single_slot_search", slotId, requestId: randomUUID() } });
  payload.newCandidateCount = mergedCandidates.filter(item => (item.localUrl || item.publicUrl) && !priorCandidates.some(old => old.candidateId === item.candidateId || (old.localUrl || old.publicUrl) === (item.localUrl || item.publicUrl))).length;
  return payload;
}

export async function researchSimpleImageSlots({ store, root, projectId, slotIds, runImage, imageOptions = {}, render, deferRender = false } = {}) {
  let context = projectContext(store, projectId);
  if (typeof runImage !== "function") throw new Error("批量图片搜索能力未配置");
  const unresolvedIds = new Set((context.result.unresolvedItems || []).filter((item) => item.kind === "image" && item.required !== false).map((item) => item.id));
  const requestedIds = [...new Set((slotIds?.length ? slotIds : [...unresolvedIds]).map(String))].filter((slotId) => unresolvedIds.has(slotId));
  const previousById = new Map((context.result.imageExecution?.results || []).map((item) => [item.slotId, item]));
  const retryIds = requestedIds.filter((slotId) => !(previousById.get(slotId)?.status === "success" && previousById.get(slotId)?.selected));
  if (!retryIds.length) throw Object.assign(new Error("当前没有需要重新搜索的缺图位置"), { code: "image_slots_not_unresolved" });
  const slots = retryIds.map((slotId) => prepareExplicitImageSearchSlot({ ...assertPlannedImageSlot(context, slotId), ...projectedTargetSlot(context, slotId) }, { plan: context.plan }));
  const existingImages = (context.result.imageExecution?.results || []).filter((item) => item.selected || item.provisionalSelected).map((item) => { const image = item.selected || item.provisionalSelected; return { ...image, src: image.localUrl, slotId: item.slotId }; });
  const searched = await runImage({ ...imageOptions, root, slots, existingImages, preparedData: context.plan.preparedData });

  context = projectContext(store, projectId);
  const previousResults = context.result.imageExecution?.results || [];
  const returnedById = new Map((searched.results || []).map((item) => [item.slotId, item]));
  const nextById = new Map(previousResults.map((item) => [item.slotId, item]));
  const now = new Date().toISOString();
  for (const slotId of retryIds) {
    const previous = nextById.get(slotId) || {};
    const returned = returnedById.get(slotId) || { slotId, status: "not_found", selected: null, candidates: [], technicalStatus: "missing_skill_result", warnings: ["批量搜索未返回结果"] };
    const refreshed = refreshedSearchCandidates(previous, returned);
    const mergedCandidates = refreshed.candidates;
    const preserveExistingSelection = previous.status === "success" && previous.selected;
    const nextCurrent = returned.status === "success" && returned.selected && !preserveExistingSelection ? {
      ...previous,
      ...returned,
      provisionalSelected: null,
      requestKind: "user_requested_multi_slot_search",
      candidates: mergedCandidates,
      manualAction: { ...refreshed.manualAction, currentSearchFallbackResult: null, preservedExistingSelection: false, lastExplicitSearchAt: now },
    } : preserveExistingSelection ? {
      ...previous,
      candidates: mergedCandidates,
      requestKind: "user_requested_multi_slot_search",
      manualAction: { ...refreshed.manualAction, lastExplicitSearchAt: now, preservedExistingSelection: true },
    } : {
      ...previous,
      ...returned,
      status: "needs_user_action",
      selected: null,
      requestKind: "user_requested_multi_slot_search",
      candidates: mergedCandidates,
      manualAction: {
        ...refreshed.manualAction,
        currentSearchFallbackResult: { previousStatus: returned.status, technicalStatus: returned.technicalStatus, matchReason: returned.matchReason, queriesUsed: returned.queriesUsed, sourceEvidence: returned.sourceEvidence, pipelineEvidence: returned.pipelineEvidence, searchDiagnostic: returned.searchDiagnostic || buildImageSearchDiagnostic(returned) },
        rejectedCandidates: uniqueCandidates([...(refreshed.manualAction.rejectedCandidates || []), ...mergedCandidates]),
        lastExplicitSearchAt: now,
      },
    };
    nextById.set(slotId, nextCurrent);
  }
  const nextResults = [...previousResults.map((item) => nextById.get(item.slotId) || item), ...retryIds.filter((slotId) => !previousResults.some((item) => item.slotId === slotId)).map((slotId) => nextById.get(slotId))];
  const imageExecution = {
    ...context.result.imageExecution,
    status: searched.status === "success" && retryIds.every((slotId) => nextById.get(slotId)?.status === "success") ? "success" : "needs_user_action",
    results: nextResults,
    metrics: {
      ...(context.result.imageExecution?.metrics || {}),
      explicitUserMultiSlotSearches: Number(context.result.imageExecution?.metrics?.explicitUserMultiSlotSearches || 0) + 1,
      automaticFollowupRounds: 0,
    },
  };
  const payload = await persistResult({ ...context, store, root, imageExecution, render, deferRender, action: { type: "explicit_multi_slot_search", slotIds: retryIds, requestId: randomUUID() } });
  const successfulSlotIds = retryIds.filter((slotId) => nextById.get(slotId)?.status === "success" && nextById.get(slotId)?.selected);
  payload.repair = { kind: "image_batch", status: successfulSlotIds.length === retryIds.length ? "success" : successfulSlotIds.length ? "partial_success" : "failed", slotIds: retryIds, successfulSlotIds, failedSlotIds: retryIds.filter((slotId) => !successfulSlotIds.includes(slotId)) };
  return payload;
}
