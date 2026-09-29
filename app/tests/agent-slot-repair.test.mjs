import test from "node:test";
import assert from "node:assert/strict";
import { applySlotRepairProposal, prepareFrozenSlotRepair, prepareSourceGroundedSlotRepair, requestFrozenSlotRepair, validateSlotRepairInWorker } from "../server/agent-slot-repair.mjs";
import { buildAgentFactBasis } from "../server/agent-trip-planner.mjs";
import { plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";
import { SLOT_VISUAL_CONTRACT } from "../server/planner-visual-contract.mjs";
import { prepareBoundSlotRepair, compileBoundSlotProposal, boundVisualSceneKey } from "../server/agent-slot-repair-bindings.mjs";

const originalSlot = {
  role: "day:1", required: true, removable: false, primaryVisualSubject: "未定画面",
  sourceRefs: ["days.0.experience"], queryCore: { subject: "未定", action: "", identity: "" },
};
const prepared = {
  rawPlan: { imagePlan: { slots: [originalSlot] }, dayRoles: [{ index: 0, primaryVisualSubject: "未定画面" }] },
  project: { factBasis: { days: [{ experience: "当日有象群观赏" }] } },
  baseline: { imagePlan: { slots: [originalSlot] }, validation: { unresolvedSlotRoles: ["day:1"] } },
  targets: ["day:1"], readOnlyRoles: [], requestInput: { unresolved: [{ role: "day:1" }] },
};
const replacement = {
  primaryVisualSubject: "象群观赏", visualDuty: "当日核心画面", differentiation: "象群主体",
  location: "草原", locationRole: "scope_only", queryCore: { subject: "象群", action: "行走", identity: "" },
  fidelityQuery: "草原象群行走", alternateQueries: ["大象群行走"], sourceRefs: ["days.0.experience"], exactIdentityRequired: false,
};

test("binding rejection ends the same repair request before Worker dispatch without transport retry", async () => {
  let calls = 0;
  const phases = [];
  const result = await requestFrozenSlotRepair({ prepared,
    requestJson: async () => { calls += 1; return { json: { patches: [] } }; },
    transformProposal: () => { throw Object.assign(new Error("invalid binding"), { code: "slot_repair_binding_invalid" }); },
    onPhase: (event) => phases.push(event.phase),
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "validation_failed");
  assert.equal(result.errorCode, "slot_repair_binding_invalid");
  assert.equal(phases.includes("validation_queued"), false);
});

async function realValidationFixture(dayCount = 1) {
  const factBasis = buildAgentFactBasis({ destination: "测试草原", days: Array.from({ length: dayCount }, (_, index) => ({ region: "草原", description: index === 0 ? "草原飞机降落后观察象群" : "草原飞机起飞返程" })) });
  const fixture = plannerRequestJson({ delayMs: 0 });
  const rawPlan = (await fixture({ messages: [{ role: "user", content: JSON.stringify({ factBasis }) }] })).json;
  const cover = rawPlan.imagePlan.slots.find((slot) => slot.role === "cover");
  const originals = [];
  for (let index = 0; index < dayCount; index += 1) {
    const day = rawPlan.imagePlan.slots.find((slot) => slot.role === `day:${index + 1}`);
    day.sourceRefs = [`days.${index}.experience`];
    originals.push(Object.fromEntries(Object.entries(day).filter(([key]) => [
    "primaryVisualSubject", "visualDuty", "differentiation", "location", "locationRole", "queryCore", "fidelityQuery", "alternateQueries", "sourceRefs", "exactIdentityRequired",
    ].includes(key))));
    for (const key of ["primaryVisualSubject", "queryCore", "fidelityQuery", "alternateQueries"]) day[key] = structuredClone(cover[key]);
  }
  const project = { projectId: "slot-repair-test", inputFingerprint: "fixture", factBasis, planIds: [] };
  return { prepared: prepareFrozenSlotRepair({ rawPlan, project }), original: originals[0], originals };
}

test("slot repair rejects unknown roles, required omission, readonly fields and cross-day refs before materializing", () => {
  assert.equal(applySlotRepairProposal(prepared, { patches: [{ role: "day:2", action: "omit", reason: "无画面" }] }).code, "target_roles_mismatch");
  const omitted = applySlotRepairProposal(prepared, { patches: [{ role: "day:1", action: "omit", reason: "无画面" }] });
  assert.deepEqual(omitted.rejected, [{ role: "day:1", code: "required_or_nonremovable_omission" }]);
  const readonly = applySlotRepairProposal(prepared, { patches: [{ role: "day:1", action: "replace", reason: "来自事实", slot: { ...replacement, required: false } }] });
  assert.deepEqual(readonly.rejected, [{ role: "day:1", code: "readonly_or_missing_field" }]);
  const crossDay = applySlotRepairProposal(prepared, { patches: [{ role: "day:1", action: "replace", reason: "来自事实", slot: { ...replacement, sourceRefs: ["days.1.experience"] } }] });
  assert.deepEqual(crossDay.rejected, [{ role: "day:1", code: "source_ref_out_of_scope_or_missing" }]);
});

test("full Planner validation accepts a repaired target while preserving a previously good role", async () => {
  const { prepared, original } = await realValidationFixture();
  assert.ok(prepared.targets.includes("day:1"));
  const beforeCover = structuredClone(prepared.baseline.imagePlan.slots.find((slot) => slot.role === "cover"));
  const result = applySlotRepairProposal(prepared, { patches: [{ role: "day:1", action: "replace", reason: "当日事实明确草原飞机降落，与封面野生动物画面不同", slot: original }] });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.acceptedRoles, ["day:1"]);
  assert.deepEqual(result.plan.imagePlan.slots.find((slot) => slot.role === "cover"), beforeCover);
  assert.deepEqual(result.plan.factBasis, prepared.project.factBasis);
  assert.equal(result.plan.dayRoles[0].primaryVisualSubject, original.primaryVisualSubject);
});

test("source-grounded repair retains the full original validation and immutable roles", async () => {
  const { prepared: legacy, original } = await realValidationFixture();
  const strict = prepareSourceGroundedSlotRepair({ rawPlan: legacy.rawPlan, project: legacy.project });
  const quote = strict.project.factBasis.days[0].experience;
  const grounding = { subject: { sourceRef: "days.0.experience", quote }, action: { sourceRef: "days.0.experience", quote } };
  const result = applySlotRepairProposal(strict, { patches: [{ role: "day:1", action: "replace", reason: "原文已有飞机降落画面", slot: original, grounding }] });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.plan.factBasis, strict.project.factBasis);
  assert.deepEqual(result.plan.imagePlan.slots.find((slot) => slot.role === "cover"), strict.baseline.imagePlan.slots.find((slot) => slot.role === "cover"));
});

test("source-grounded repair rejects a real path with an invented Core before materialization", () => {
  const strict = structuredClone(prepared);
  strict.groundingMode = "source-quotes-v1";
  strict.project.factBasis.days[0] = { experience: "每日两次游猎。", spots: [{ description: "夜间游猎追踪花豹。" }] };
  const patch = { role: "day:1", action: "replace", reason: "来源路径存在", slot: { ...replacement, queryCore: { subject: "狮子", action: "", identity: "" } }, grounding: { subject: { sourceRef: "days.0.experience", quote: "每日两次游猎。" } } };
  const check = (proposal, code) => {
    const result = applySlotRepairProposal(strict, { patches: [proposal] });
    assert.equal(result.rejected[0].code, code);
    assert.equal(result.diagnostics.validationPasses, 0);
  };
  check(patch, "core_grounding_term_not_in_quote");
  const spotlight = structuredClone(patch);
  spotlight.slot.sourceRefs = ["days.0.spots.0"];
  spotlight.slot.queryCore = { subject: "花豹", action: "被探照灯照亮", identity: "" };
  spotlight.grounding = { subject: { sourceRef: "days.0.spots.0.description", quote: "夜间游猎追踪花豹。" }, action: { sourceRef: "days.0.spots.0.description", quote: "夜间游猎追踪花豹。" } };
  check(spotlight, "core_grounding_term_not_in_quote");
  const inventedQuote = structuredClone(patch);
  inventedQuote.grounding.subject.quote = "狮子在草原休憩";
  check(inventedQuote, "core_grounding_quote_not_in_source");
  const wrongRef = structuredClone(spotlight);
  wrongRef.slot.sourceRefs = ["days.0.experience"];
  check(wrongRef, "core_grounding_ref_out_of_scope");
});

test("full Planner validation still rejects a duplicate visual responsibility", async () => {
  const { prepared, original } = await realValidationFixture();
  const cover = prepared.baseline.imagePlan.slots.find((slot) => slot.role === "cover");
  const duplicate = { ...original, primaryVisualSubject: cover.primaryVisualSubject, queryCore: structuredClone(cover.queryCore),
    fidelityQuery: cover.fidelityQuery, alternateQueries: structuredClone(cover.alternateQueries) };
  const result = applySlotRepairProposal(prepared, { patches: [{ role: "day:1", action: "replace", reason: "重复画面", slot: duplicate }] });
  assert.equal(result.accepted, false);
  assert.equal(result.rejected[0].role, "day:1");
  assert.equal(result.rejected[0].code, "target_still_unresolved");
  assert.ok(result.rejected[0].issues.some((issue) => issue.code === "duplicate_visual_responsibility" && issue.conflictingRole === "cover"));
});

test("bound source selection builds evidence from full original leaves and retains all existing guards", async () => {
  const { prepared: old, original } = await realValidationFixture();
  const strict = prepareSourceGroundedSlotRepair({ rawPlan: old.rawPlan, project: old.project });
  const bound = prepareBoundSlotRepair(strict);
  const source = bound.bindingCatalog.find((item) => item.sourceRef === 'days.0.experience');
  const select = (field) => original.queryCore[field] ? { sourceId: source.id, text: original.queryCore[field], english: { subject: 'bush plane landing', action: 'landing' }[field] } : null;
  const proposal = { patches: [{ role: 'day:1', action: 'replace', reason: '当日明确飞机降落',
    primaryVisualSubject: original.primaryVisualSubject, visualDuty: original.visualDuty, differentiation: original.differentiation,
    location: original.location, locationRole: original.locationRole, exactIdentityRequired: original.exactIdentityRequired,
    core: { subject: select('subject'), action: select('action'), identity: select('identity') },
    queries: [original.fidelityQuery, ...original.alternateQueries],
  }] };
  assert.equal('previousRejectedTarget' in bound.requestInput.unresolved[0], false);
  assert.equal('sourceFactsByRole' in bound.requestInput, false);
  const compiled = compileBoundSlotProposal(bound, proposal);
  assert.equal(compiled.patches[0].grounding.subject.quote, strict.project.factBasis.days[0].experience);
  const accepted = applySlotRepairProposal(bound, compiled);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.plan.factBasis, strict.project.factBasis);
  assert.deepEqual(accepted.plan.imagePlan.slots.find((item) => item.role === 'cover'), strict.baseline.imagePlan.slots.find((item) => item.role === 'cover'));
  for (const mutate of [
    (p) => { p.patches[0].core.action.text = '被探照灯照亮'; },
    (p) => { p.patches[0].core.subject.sourceId = 'days.0'; },
    (p) => { p.patches[0].slot = { reason: '多余字段' }; },
    (p) => { p.patches[0].core.subject.quote = '自写引文'; },
    (p) => { p.patches[0].core.subject.text = ''; },
  ]) {
    const changed = structuredClone(proposal); mutate(changed);
    assert.throws(() => compileBoundSlotProposal(bound, changed), { code: 'slot_repair_binding_invalid' });
  }
  const requiredOmit = compileBoundSlotProposal(bound, { patches: [{ role: 'day:1', action: 'omit', reason: '必需位不能删除' }] });
  assert.equal(applySlotRepairProposal(bound, requiredOmit).rejected[0].code, 'required_or_nonremovable_omission');
  const collision = structuredClone(proposal);
  const cover = bound.baseline.imagePlan.slots.find((slot) => slot.role === 'cover');
  cover.primaryVisualSubject = '营地花园餐桌旁，客人品尝现摘食材';
  cover.queryCore = { subject: '花园餐桌与现摘食材', action: '客人品尝', identity: '' };
  collision.patches[0].location = '莱基皮亚';
  collision.patches[0].primaryVisualSubject = '莱基皮亚营地花园餐桌旁，客人品尝现摘食材';
  assert.throws(() => compileBoundSlotProposal(bound, collision), { code: 'slot_repair_duplicate_scene' });
});

test('exact scene comparison preserves different entity identities and actual actions', () => {
  const scene = { primaryVisualSubject: '保护区草原上，向导带领客人观察动物', location: '保护区', locationRole: 'scope_only', queryCore: { identity: '' } };
  const normalized = { ...scene, primaryVisualSubject: '草原上，向导带领客人观察动物' };
  assert.equal(boundVisualSceneKey(scene), boundVisualSceneKey(normalized));
  assert.notEqual(boundVisualSceneKey(scene), boundVisualSceneKey({ ...normalized, primaryVisualSubject: '草原上，向导带领客人学习辨认足迹' }));
  assert.notEqual(boundVisualSceneKey(scene), boundVisualSceneKey({ ...scene, queryCore: { identity: '另一处私人保护区' } }));
});

test("bound catalog retains negation and optional boundaries and rejects another role's source", () => {
  const base = structuredClone(prepared);
  base.groundingMode = 'source-quotes-v1';
  base.targets = ['day:1', 'day:2'];
  base.requestInput = { unresolved: base.targets.map((role) => ({ role, required: true, removable: false, issues: [] })),
    sourceFactsByRole: { 'day:1': [{ ref: 'days.0', value: { experience: '可自费乘坐飞机，不含包机升级。' } }], 'day:2': [{ ref: 'days.1', value: { experience: '夜间追踪花豹。' } }] }, readOnlyVisualDuties: [] };
  const bound = prepareBoundSlotRepair(base);
  assert.equal(bound.bindingCatalog[0].text, '可自费乘坐飞机，不含包机升级。');
  const patch = { role: 'day:1', action: 'replace', primaryVisualSubject: '花豹', visualDuty: '目标', differentiation: '不同画面',
    location: '', locationRole: 'scope_only', exactIdentityRequired: false, reason: '不得跨日',
    core: { subject: { sourceId: bound.bindingCatalog[1].id, text: '花豹', english: 'leopard' }, action: null, identity: null }, queries: ['花豹', 'leopard'] };
  assert.throws(() => compileBoundSlotProposal(bound, { patches: [patch] }), { code: 'slot_repair_binding_invalid' });
});

test("hotel repair preserves locked identity without asking the model to rewrite it; explicit changes still fail", async () => {
  const factBasis = buildAgentFactBasis({ destination: "测试城市", hotels: [{ officialName: "Example Hotel", region: "测试城市" }], days: [{ description: "酒店外观与城市公园漫步" }] });
  const rawPlan = (await plannerRequestJson({ delayMs: 0 })({ messages: [{ role: "user", content: JSON.stringify({ factBasis }) }] })).json;
  const hotel = rawPlan.imagePlan.slots.find((slot) => slot.role === "hotel:1");
  hotel.sourceRefs = ["hotels.0"];
  const writable = Object.fromEntries(Object.entries(hotel).filter(([key]) => ["primaryVisualSubject", "visualDuty", "differentiation", "location", "locationRole", "queryCore", "fidelityQuery", "alternateQueries", "sourceRefs", "exactIdentityRequired"].includes(key)));
  hotel.locationRole = "invalid";
  const preparedHotel = prepareFrozenSlotRepair({ rawPlan, project: { projectId: "hotel-locked", factBasis, inputFingerprint: "test" } });
  assert.deepEqual(preparedHotel.targets, ["hotel:1"]);
  delete writable.exactIdentityRequired;
  writable.queryCore = { ...writable.queryCore };
  delete writable.queryCore.identity;
  delete writable.queryCore.identityEn;
  const proposal = { patches: [{ role: "hotel:1", action: "replace", slot: writable, reason: "酒店外观类别与原酒店身份保持一致" }] };
  const good = applySlotRepairProposal(preparedHotel, proposal);
  assert.equal(good.accepted, true);
  const repaired = good.rawPlan.imagePlan.slots.find((slot) => slot.role === "hotel:1");
  assert.equal(repaired.queryCore.identity, hotel.queryCore.identity);
  assert.equal(repaired.queryCore.identityEn, hotel.queryCore.identityEn);
  assert.equal(repaired.exactIdentityRequired, true);
  assert.equal("identity" in proposal.patches[0].slot.queryCore, false, "input proposal remains unchanged");
  for (const change of [{ identity: "" }, { identity: "Other Hotel" }, { identityEn: "Other Hotel" }]) {
    const changed = structuredClone(proposal);
    Object.assign(changed.patches[0].slot.queryCore, change);
    const rejected = applySlotRepairProposal(preparedHotel, changed);
    assert.equal(rejected.rejected[0].code, "hotel_identity_changed");
    assert.equal(rejected.diagnostics.validationPasses, 0);
  }
});

test("slot repair allows at most one physical fetch and disables client retries", async () => {
  let configuration;
  const result = await requestFrozenSlotRepair({ prepared, apiKey: "test", baseUrl: "https://example.invalid", model: "fixture",
    fetchImpl: async () => ({ ok: true }),
    requestJson: async (options) => {
      configuration = options;
      await options.fetchImpl("https://example.invalid", {});
      await options.fetchImpl("https://example.invalid", {});
    },
  });
  assert.equal(result.status, "transport_failed");
  assert.equal(result.physicalRequests, 1);
  assert.equal(configuration.emptyContentRetries, 0);
  assert.equal(configuration.allowSyntaxRepair, false);
  assert.ok(configuration.messages[0].content.includes(SLOT_VISUAL_CONTRACT));
});

test("slot repair timeout aborts one pending request and ignores late response", async () => {
  let requestSignal;
  const result = await requestFrozenSlotRepair({ prepared, apiKey: "test", baseUrl: "https://example.invalid", model: "fixture", deadlineMs: 10,
    requestJson: async ({ signal }) => { requestSignal = signal; await new Promise((resolve) => setTimeout(resolve, 50)); return { json: { patches: [] } }; },
  });
  assert.equal(result.status, "timeout");
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.physicalRequests, 0);
  assert.equal(result.result, undefined);
});

test("parent cancellation propagates rather than becoming a repair failure", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("User cancelled", "AbortError"));
  await assert.rejects(requestFrozenSlotRepair({ prepared, signal: controller.signal }), { name: "AbortError" });
});

test("in-flight parent cancellation aborts the repair request and propagates", async () => {
  const controller = new AbortController();
  const running = requestFrozenSlotRepair({ prepared, apiKey: "test", baseUrl: "https://example.invalid", model: "fixture", signal: controller.signal,
    requestJson: async ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  setTimeout(() => controller.abort(new DOMException("User cancelled", "AbortError")), 5);
  await assert.rejects(running, { name: "AbortError" });
});

test("a batch repairs two targets with one full validation and leaves its input unchanged", async () => {
  const { prepared, originals } = await realValidationFixture(2);
  const before = structuredClone(prepared);
  const result = applySlotRepairProposal(prepared, { patches: originals.map((slot, index) => ({ role: `day:${index + 1}`, action: "replace", reason: "当日已有对应起降事实", slot })) });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.acceptedRoles, ["day:1", "day:2"]);
  assert.equal(result.diagnostics.validationPasses, 1);
  assert.deepEqual(prepared, before);
});

test("a separable failed patch is rolled back with only one additional full validation", async () => {
  const { prepared, originals } = await realValidationFixture(2);
  const badSlot = prepared.rawPlan.imagePlan.slots.find((slot) => slot.role === "day:2");
  const duplicate = { ...originals[1], ...Object.fromEntries(["primaryVisualSubject", "queryCore", "fidelityQuery", "alternateQueries"].map((key) => [key, badSlot[key]])) };
  const result = applySlotRepairProposal(prepared, { patches: [
    { role: "day:1", action: "replace", reason: "当日飞机降落", slot: originals[0] },
    { role: "day:2", action: "replace", reason: "仍重复封面", slot: duplicate },
  ] });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.acceptedRoles, ["day:1"]);
  assert.deepEqual(result.remainingRoles, ["day:2"]);
  assert.equal(result.diagnostics.validationPasses, 2);
  assert.deepEqual(result.rawPlan.imagePlan.slots.find((slot) => slot.role === "day:2"), badSlot);
});

test("worker success is returned only after the actual worker has exited", async () => {
  const { prepared, original } = await realValidationFixture();
  const progress = [];
  const result = await validateSlotRepairInWorker(prepared, { patches: [{ role: "day:1", action: "replace", reason: "已有降落事实", slot: original }] }, undefined, (event) => progress.push(event.phase));
  assert.equal(result.accepted, true);
  assert.equal(result.workerExitConfirmed, true);
  assert.equal(result.workerExitCode, 0);
  assert.deepEqual(progress, ["validation_started"]);
});

test("cancellation during real worker calculation waits for termination and preserves request count", async () => {
  const { prepared, original } = await realValidationFixture();
  const controller = new AbortController();
  let computationStarted = false;
  const pending = requestFrozenSlotRepair({ prepared, signal: controller.signal,
    requestJson: async (options) => {
      await options.fetchImpl("https://example.invalid");
      return { json: { patches: [{ role: "day:1", action: "replace", reason: "已有降落事实", slot: original }] } };
    },
    fetchImpl: async () => ({ ok: true }),
    onPhase: ({ phase }) => { if (phase === "validation_started") { computationStarted = true; setTimeout(() => controller.abort(new DOMException("User cancelled", "AbortError")), 10); } },
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(computationStarted, true);
    assert.equal(error.workerTerminationConfirmed, true);
    assert.equal(typeof error.workerTerminationExitCode, "number");
    assert.equal(error.repairDiagnostics.stage, "local_validation");
    assert.equal(error.repairDiagnostics.physicalRequests, 1);
    return true;
  });
});

test("deadline during real calculation reports local validation and confirmed termination", async () => {
  const { prepared, originals } = await realValidationFixture(2);
  const phases = [];
  const result = await requestFrozenSlotRepair({ prepared, deadlineMs: 350,
    requestJson: async () => ({ json: { patches: originals.map((slot, index) => ({ role: `day:${index + 1}`, action: "replace", reason: "已有起降事实", slot })) } }),
    onPhase: ({ phase }) => phases.push(phase),
  });
  assert.ok(phases.includes("validation_started"));
  assert.equal(result.status, "timeout");
  assert.equal(result.stage, "local_validation");
  assert.equal(result.workerTerminationConfirmed, true);
  assert.equal(typeof result.workerTerminationExitCode, "number");
  assert.equal(result.result, undefined);
});

test("response evidence is recorded before worker validation and cannot be silently lost", async () => {
  const { prepared, original } = await realValidationFixture();
  let saved = false;
  let validationObserved = false;
  const requestJson = async (options) => {
    await options.onModelAttempt({ rawContent: "synthetic proposal", attempt: 1, parseResult: { status: "valid" } });
    return { json: { patches: [{ role: "day:1", action: "replace", reason: "已有降落事实", slot: original }] } };
  };
  const success = await requestFrozenSlotRepair({ prepared, requestJson,
    onModelAttempt: async ({ rawContent }) => { assert.equal(rawContent, "synthetic proposal"); saved = true; },
    onPhase: ({ phase }) => { if (phase === "validation_started") { assert.equal(saved, true); validationObserved = true; } },
  });
  assert.equal(success.status, "accepted");
  assert.equal(validationObserved, true);
  const phases = [];
  const failure = await requestFrozenSlotRepair({ prepared, requestJson,
    onModelAttempt: async () => { throw new Error("synthetic disk failure"); },
    onPhase: ({ phase }) => phases.push(phase),
  });
  assert.equal(failure.status, "evidence_failed");
  assert.equal(failure.errorCode, "repair_evidence_failed");
  assert.equal(phases.includes("validation_queued"), false);
});

test("a response-body timeout aborts the physical request without starting validation", async () => {
  let requestSignal;
  let readStarted = false;
  const result = await requestFrozenSlotRepair({ prepared, apiKey: "test", baseUrl: "https://example.invalid", model: "fixture", deadlineMs: 30,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return { ok: true, body: new ReadableStream({ start(controller) {
        readStarted = true;
        options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
      } }) };
    },
  });
  assert.equal(readStarted, true);
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.physicalRequests, 1);
  assert.equal(result.stage, "response_read");
  assert.equal(result.status, "timeout");
  assert.equal(result.phases.some(({ phase }) => phase === "validation_started"), false);
});
