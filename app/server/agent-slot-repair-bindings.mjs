// Isolated POC input/transport adapter. It selects no visual and grants no
// semantic approval: the unchanged source-quotes and full Planner guards run next.
import { isDeepStrictEqual } from "node:util";

const fields = ["subject", "action", "identity"];
const replacementKeys = ["role", "action", "primaryVisualSubject", "visualDuty", "differentiation", "location", "locationRole", "core", "queries", "exactIdentityRequired", "reason"];
const hasKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const reject = () => { throw Object.assign(new Error("slot_repair_binding_invalid"), { code: "slot_repair_binding_invalid" }); };
const visualKey = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// Narrow exact-scene check: ignore only a leading scope label, never infer
// synonyms or collapse different named hotels into one generic image.
export function boundVisualSceneKey(slot) {
  let visual = visualKey(slot.primaryVisualSubject);
  const location = visualKey(slot.location);
  if (slot.locationRole === "scope_only" && location && visual.startsWith(location)) visual = visual.slice(location.length);
  if (visual.length < 8) return "";
  return `${visualKey(slot.queryCore?.identity)}|${visual}`;
}

function leaves(value, ref, output) {
  if (typeof value === "string" && value.trim()) output.set(ref, value);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (!["id", "currentCopy"].includes(key)) leaves(child, `${ref}.${key}`, output);
    }
  }
}

export function prepareBoundSlotRepair(prepared) {
  if (prepared.groundingMode !== "source-quotes-v1") reject();
  const next = structuredClone(prepared);
  const catalog = [];
  const sourceIdsByRole = {};
  for (const role of prepared.targets) {
    const textByRef = new Map();
    for (const source of prepared.requestInput.sourceFactsByRole[role]) leaves(source.value, source.ref, textByRef);
    sourceIdsByRole[role] = [];
    for (const [sourceRef, text] of textByRef) {
      const id = `s${catalog.length + 1}`;
      catalog.push({ id, role, sourceRef, text });
      sourceIdsByRole[role].push(id);
    }
  }
  next.bindingCatalog = catalog;
  next.bindingSourceRootsByRole = Object.fromEntries(prepared.targets.map((role) => [role, prepared.requestInput.sourceFactsByRole[role].map((source) => source.ref)]));
  next.requestFormat = "source-bindings-v2";
  next.requestInput = {
    contract: "只返回JSON对象{patches:[...]}。本次是source-bindings-v2，不返回slot、queryCore、sourceRefs或grounding。每个目标恰好一项。replace只含role/action/primaryVisualSubject/visualDuty/differentiation/location/locationRole/core/queries/exactIdentityRequired/reason；action写replace。core恰好含subject/action/identity，每项为{sourceId,text,english}或null；subject必填，静态画面action=null，非实体画面identity=null。text必须逐字截取本role原文字符串的连续子串，sourceId从本role的sourceIds选择；english是忠实翻译。不要重新排列原文字词或补入常识动作。主体和动作必须在原文中确实具有所述关系，不能用字面命中掩盖否定、可选或费用边界。程序从原始文本绑定完整证据，不能输出自写引文。primaryVisualSubject由你决定完整画面，必须忠于所选原文，不能增添必需道具、动物、设施或动作；queries为同一画面的2—4条单语短词。reason只在patch顶层。omit只含role/action/reason，仅required=false且removable=true时可以省略；须通读本role所有sourceIds，存在另一有独立价值的画面时优先替换，不能只证明旧画面重复就省略。酒店代表空间使用core.subject={sourceId:null,text:'酒店代表性空间',english:'representative hotel space'}，core.action和identity均null，exactIdentityRequired=true；程序保留原预订酒店身份。酒店以外不可使用此例外。不要照搬被拒绝提案。",
    unresolved: prepared.requestInput.unresolved.map((item) => ({
      role: item.role, required: item.required, removable: item.removable,
      sourceIds: sourceIdsByRole[item.role],
      issues: item.issues.map(({ code, conflictingRole }) => ({ code, ...(conflictingRole ? { conflictingRole } : {}) })),
      ...(item.forbiddenCore ? { forbiddenCore: item.forbiddenCore, conflictsWith: item.conflictsWith } : {}),
      ...(item.lockedFields ? { lockedHotelIdentity: item.lockedFields.identity } : {}),
    })),
    sources: catalog,
    readOnlyVisualDuties: prepared.requestInput.readOnlyVisualDuties,
    forbiddenVisualScenes: prepared.baseline.imagePlan.slots.filter((slot) => prepared.readOnlyRoles.includes(slot.role)).map((slot) => ({ role: slot.role, scene: slot.primaryVisualSubject,
      instruction: "此已通过画面不可重复；仅把Core中的主谓移到subject、加地点前缀或改写Core字段不构成新画面。" })),
  };
  return next;
}

export function compileBoundSlotProposal(prepared, proposal) {
  if (!hasKeys(proposal, ["patches"]) || !Array.isArray(proposal.patches)) reject();
  const catalog = new Map((prepared.bindingCatalog || []).map((source) => [source.id, source]));
  return { patches: proposal.patches.map((patch) => {
    if (!prepared.targets.includes(patch?.role)) reject();
    if (patch.action === "omit") {
      if (!hasKeys(patch, ["role", "action", "reason"])) reject();
      return structuredClone(patch);
    }
    if (patch.action !== "replace" || !hasKeys(patch, replacementKeys) || !hasKeys(patch.core, fields)
      || !Array.isArray(patch.queries) || patch.queries.length < 2 || patch.queries.length > 4
      || patch.queries.some((query) => typeof query !== "string" || !query.trim())
      || typeof patch.exactIdentityRequired !== "boolean") reject();
    const hotel = /^hotel:\d+$/.test(patch.role);
    const grounding = {};
    const queryCore = {};
    const refs = new Set();
    for (const field of fields) {
      const value = patch.core[field];
      if (value === null) {
        if (field === "subject") reject();
        queryCore[field] = "";
        queryCore[`${field}En`] = "";
        continue;
      }
      if (!hasKeys(value, ["sourceId", "text", "english"]) || typeof value.text !== "string" || !value.text.trim()
        || typeof value.english !== "string" || !value.english.trim()) reject();
      const representative = hotel && field === "subject" && value.sourceId === null
        && value.text === "酒店代表性空间" && value.english === "representative hotel space" && patch.core.action === null;
      if (!representative) {
        const source = catalog.get(value.sourceId);
        if (!source || source.role !== patch.role || !source.text.includes(value.text)) reject();
        grounding[field] = { sourceRef: source.sourceRef, quote: source.text };
        refs.add(source.sourceRef);
      }
      queryCore[field] = value.text;
      queryCore[`${field}En`] = value.english;
    }
    if (hotel) {
      if (patch.core.identity !== null || patch.exactIdentityRequired !== true) reject();
      const original = prepared.rawPlan.imagePlan.slots.find((slot) => slot.role === patch.role);
      delete queryCore.identity;
      delete queryCore.identityEn;
      original.sourceRefs.forEach((ref) => refs.add(ref));
    }
    const slot = {
      primaryVisualSubject: patch.primaryVisualSubject, visualDuty: patch.visualDuty,
      differentiation: patch.differentiation, location: patch.location, locationRole: patch.locationRole,
      queryCore, fidelityQuery: patch.queries[0], alternateQueries: patch.queries.slice(1),
      // Visual prose may refer to other facts in the same original scope.
      // Keep that unchanged scope as well as the exact Core leaf bindings.
      sourceRefs: [...new Set([...(prepared.bindingSourceRootsByRole[patch.role] || []), ...refs])],
      exactIdentityRequired: patch.exactIdentityRequired,
    };
    const sceneKey = boundVisualSceneKey(slot);
    if (sceneKey && prepared.baseline.imagePlan.slots.some((original) => prepared.readOnlyRoles.includes(original.role) && boundVisualSceneKey(original) === sceneKey)) {
      throw Object.assign(new Error("slot_repair_duplicate_scene"), { code: "slot_repair_duplicate_scene", role: patch.role });
    }
    return {
      role: patch.role, action: "replace", reason: patch.reason, grounding,
      slot,
    };
  }) };
}
