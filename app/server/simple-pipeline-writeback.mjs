import { isDeepStrictEqual } from "node:util";
import { getSlotImage, setSlotImage } from "../src/lib/imageSlots.js";
import { validateCopyValue } from "./simple-copy-skill.mjs";

const COPY_PATH = /^(?:title|subtitle|notes|highlights\.\d+|hotels\.\d+\.(?:editorialCopy|proofPoints)|diningExperiences\.\d+\.editorialCopy|transportSummary\.\d+\.(?:usageLabel|editorialCopy|features)|days\.\d+\.(?:theme|description)|days\.\d+\.dayNotices\.0\.text|days\.\d+\.spots\.\d+\.description)$/;

function protectedFacts(data = {}) {
  return {
    destination: data.destination,
    travelers: data.travelers,
    adults: data.adults,
    children: data.children,
    startDate: data.startDate,
    endDate: data.endDate,
    dayCount: data.dayCount,
    totalPrice: data.totalPrice,
    priceUnit: data.priceUnit,
    included: data.included,
    excluded: data.excluded,
    cancellation: data.cancellation,
    pendingConfirmations: data.pendingConfirmations,
    hotels: (data.hotels || []).map(({ id, officialName, shortName, region, nights, roomType, status, mealPlan, replacementPolicy }) => ({ id, officialName, shortName, region, nights, roomType, status, mealPlan, replacementPolicy })),
    transportSummary: (data.transportSummary || []).map(({ id, category, serviceLevel, seatCount, model, modelGuaranteed, usageSegments }) => ({ id, category, serviceLevel, seatCount, model, modelGuaranteed, usageSegments })),
    days: (data.days || []).map((day) => ({ date: day.date, routeNodes: day.routeNodes, city: day.city, mealPlan: day.mealPlan, hotel: day.hotel, vehicle: day.vehicle, estimatedTravelTime: day.estimatedTravelTime, movementPaceDescriptor: day.movementPaceDescriptor, activityLevel: day.activityLevel, overnightType: day.overnightType, dayNotices: (day.dayNotices || []).map(({ type, sourceKind, basisType, sourceEvidence }) => ({ type, sourceKind, basisType, sourceEvidence })), spots: (day.spots || []).map(({ id, name, status, statusLabel, feeBoundary, optional, sourceEvidence }) => ({ id, name, status, statusLabel, feeBoundary, optional, sourceEvidence })) })),
  };
}

function pathParts(targetPath) {
  return targetPath.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function writeAtPath(root, targetPath, value) {
  const parts = pathParts(targetPath);
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (cursor == null || !Object.hasOwn(cursor, part)) throw new Error(`targetPath 不存在：${targetPath}`);
    cursor = cursor[part];
  }
  const leaf = parts.at(-1);
  if (cursor == null || (!Array.isArray(cursor) && !Object.hasOwn(cursor, leaf))) throw new Error(`targetPath 不存在：${targetPath}`);
  cursor[leaf] = value;
}

function unresolved(kind, id, status, required, details = {}) {
  return { kind, id, status, required, ...details };
}

export function applySimpleSkillResults({ preparedData, copyTasks = [], copyExecution = {}, imageSlots = [], slotBindings = {}, imageExecution = {} } = {}) {
  const data = structuredClone(preparedData || {});
  const beforeFacts = protectedFacts(data);
  const copyById = new Map((copyExecution.results || []).map((item) => [item.targetId, item]));
  const imageById = new Map((imageExecution.results || []).map((item) => [item.slotId, item]));
  const unresolvedItems = [];
  const copyWriteback = [];
  const imageWriteback = [];

  for (const task of copyTasks) {
    const result = copyById.get(task.targetId);
    if (!result || result.status !== "success") {
      const status = result?.status || "failed";
      unresolvedItems.push(unresolved("copy", task.targetId, status, task.required !== false, { targetPath: task.targetPath, error: result?.error || { code: "missing_skill_result", message: "Copy Skill 未返回该 targetId" } }));
      copyWriteback.push({ targetId: task.targetId, targetPath: task.targetPath, status });
      continue;
    }
    const visualSlotId = task.layoutHints?.placement === 'visual_card' ? task.layoutHints.slotId : null;
    const visualBinding = visualSlotId && data.simpleImageSlotBindings?.[visualSlotId];
    const visualRoot = visualSlotId && `simpleImageSlotBindings.${visualSlotId.replace(/:/g, '_')}`;
    const visualCardPath = visualBinding?.module === 'day' && task.moduleType === 'visual_card' && task.targetPath === visualRoot;
    const visualPathAllowed = visualCardPath || (visualBinding?.module === 'day' && visualBinding.useSpotCopy === false && task.targetPath === `${visualRoot}.description`);
    if (result.targetPath !== task.targetPath || !(COPY_PATH.test(task.targetPath) || visualPathAllowed)) {
      unresolvedItems.push(unresolved("copy", task.targetId, "failed", task.required !== false, { targetPath: task.targetPath, error: { code: "unauthorized_target_path", message: "Copy 返回路径不一致或不在授权文案字段中" } }));
      copyWriteback.push({ targetId: task.targetId, targetPath: task.targetPath, status: "failed" });
      continue;
    }
    const schemaErrors = validateCopyValue(result.value, task.outputSchema);
    if (schemaErrors.length) {
      unresolvedItems.push(unresolved("copy", task.targetId, "failed", task.required !== false, { targetPath: task.targetPath, error: { code: "invalid_output_schema", message: schemaErrors.join("；") } }));
      copyWriteback.push({ targetId: task.targetId, targetPath: task.targetPath, status: "failed" });
      continue;
    }
    try {
      if (visualCardPath) {
        if (typeof result.value?.cardTitle !== 'string' || typeof result.value?.cardDescription !== 'string' || Object.keys(result.value).some(key => !['cardTitle', 'cardDescription'].includes(key))) throw new Error('Visual Card仅允许写cardTitle/cardDescription');
        visualBinding.cardTitle = result.value.cardTitle;
        visualBinding.cardDescription = result.value.cardDescription;
      }
      else if (visualPathAllowed) visualBinding.description = result.value;
      else writeAtPath(data, task.targetPath, result.value);
      copyWriteback.push({ targetId: task.targetId, targetPath: task.targetPath, status: "written" });
    } catch (error) {
      unresolvedItems.push(unresolved("copy", task.targetId, "failed", task.required !== false, { targetPath: task.targetPath, error: { code: "writeback_failed", message: error.message } }));
      copyWriteback.push({ targetId: task.targetId, targetPath: task.targetPath, status: "failed" });
    }
  }

  for (const slot of imageSlots) {
    const result = imageById.get(slot.slotId);
    const binding = slotBindings[slot.slotId];
    if (!binding) {
      unresolvedItems.push(unresolved("image", slot.slotId, "failed", slot.required, { error: { code: "slot_binding_missing", message: "缺少 slotId 的确定性写回绑定" } }));
      imageWriteback.push({ slotId: slot.slotId, status: "failed" });
      continue;
    }
    if (slot.userLocked) {
      const lockedImage = getSlotImage(data, binding);
      if (lockedImage?.src) {
        imageWriteback.push({ slotId: slot.slotId, fieldPath: binding.fieldPath, status: "preserved_user_locked", src: lockedImage.src });
        continue;
      }
      unresolvedItems.push(unresolved("image", slot.slotId, "needs_user_action", slot.required, { technicalStatus: "user_locked_without_image", requiredAction: "needs_user_action" }));
      imageWriteback.push({ slotId: slot.slotId, fieldPath: binding.fieldPath, status: "needs_user_action" });
      continue;
    }
    if (result?.status === "success") {
      const src = result.selected?.localUrl || result.selected?.publicUrl;
      if (!src || !/^\/(?!\/)/.test(src)) {
        unresolvedItems.push(unresolved("image", slot.slotId, "failed", slot.required, { error: { code: "local_image_required", message: "成功图片缺少本地可用地址" } }));
        imageWriteback.push({ slotId: slot.slotId, status: "failed" });
        continue;
      }
      setSlotImage(data, binding, {
        src,
        label: result.selected.actualSubject || result.actualSubject || slot.subject || slot.activity || slot.visualGoal,
        candidateId: result.selected.candidateId,
        focus: result.selected.focus || "50% 50%",
        fit: result.selected.fit || "cover",
        sourcePage: result.selected.sourcePage || null,
        sourceTitle: result.selected.sourceTitle || null,
        officialSource: result.selected.officialSource === true,
      });
      imageWriteback.push({ slotId: slot.slotId, fieldPath: binding.fieldPath, status: "written", src, candidateId: result.selected.candidateId });
      continue;
    }
    setSlotImage(data, binding, null);
    const status = result?.status || "failed";
    if (slot.required) unresolvedItems.push(unresolved("image", slot.slotId, status, true, { technicalStatus: result?.technicalStatus || "missing_skill_result", requiredAction: status === "not_found" || status === "needs_user_action" ? "needs_user_action" : "fix_failed_slot" }));
    imageWriteback.push({ slotId: slot.slotId, fieldPath: binding.fieldPath, status: slot.required ? status : "removed_optional" });
  }

  if (!isDeepStrictEqual(beforeFacts, protectedFacts(data))) {
    const error = new Error("Skill 写回改变了受保护的行程事实");
    error.code = "protected_fact_changed";
    throw error;
  }
  return {
    data,
    unresolvedItems,
    requiredUnresolved: unresolvedItems.filter((item) => item.required),
    copyWriteback,
    imageWriteback,
  };
}
