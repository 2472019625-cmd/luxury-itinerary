import { isDeepStrictEqual } from "node:util";
import { Worker } from "node:worker_threads";
import { materializeAgentPlanForSlotRepair } from "./agent-trip-planner.mjs";
import { requestDeepSeekJson } from "./deepseek-client.mjs";

const VISUAL_FIELDS = new Set([
  "primaryVisualSubject", "visualDuty", "differentiation", "location", "locationRole",
  "queryCore", "fidelityQuery", "alternateQueries", "sourceRefs", "exactIdentityRequired",
]);
const REQUIRED_FIELDS = ["primaryVisualSubject", "location", "locationRole", "queryCore", "fidelityQuery", "alternateQueries", "sourceRefs", "exactIdentityRequired"];
const MAX_DURATION_MS = 60_000;
const copy = (value) => structuredClone(value);
const same = (a, b) => isDeepStrictEqual(a, b);
const roleOf = (slot) => String(slot?.role || "");
const unresolved = (plan) => new Set(plan.validation?.unresolvedSlotRoles || []);
const slotsByRole = (plan) => new Map((plan.imagePlan?.slots || []).map((slot) => [roleOf(slot), slot]));
const failure = (code, detail = {}) => ({ accepted: false, code, ...detail });

function referenceValue(factBasis, ref) {
  if (!/^(?:days|hotels|transport|diningExperiences)\.\d+(?:\.[A-Za-z][A-Za-z0-9]*(?:\.\d+)?)?$/.test(ref)) return undefined;
  return ref.split(".").reduce((value, part) => value?.[part], factBasis);
}

function allowedReferenceRoots(role, originalRefs = []) {
  const day = /^day:(\d+)(?::supporting:\d+)?$/.exec(role);
  if (day) return [`days.${Number(day[1]) - 1}`];
  const hotel = /^hotel:(\d+)$/.exec(role);
  if (hotel) return [`hotels.${Number(hotel[1]) - 1}`];
  const transport = /^transport:(\d+)$/.exec(role);
  if (transport) return [`transport.${Number(transport[1]) - 1}`];
  const dining = /^dining:(\d+)$/.exec(role);
  if (dining) return [`diningExperiences.${Number(dining[1]) - 1}`, ...originalRefs.filter((ref) => /^days\.\d+/.test(ref))];
  return [];
}

function validReferences(refs, role, factBasis, originalRefs) {
  if (!Array.isArray(refs) || !refs.length) return false;
  const roots = allowedReferenceRoots(role, originalRefs);
  return roots.length > 0 && refs.every((ref) => typeof ref === "string" && roots.some((root) => ref === root || ref.startsWith(`${root}.`))
    && referenceValue(factBasis, ref) !== undefined);
}

function visualKey(slot) {
  return [slot?.queryCore?.identity, slot?.queryCore?.subject, slot?.queryCore?.action]
    .map((value) => String(value || "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean).join("|");
}

function safeIssues(slot) {
  return (slot?.plannerValidationIssues || []).map(({ code, conflictingRole }) => ({ code, ...(conflictingRole ? { conflictingRole } : {}) }));
}

export function prepareFrozenSlotRepair({ rawPlan, project, expectedRoles } = {}) {
  if (!rawPlan || !project?.factBasis || !Array.isArray(rawPlan.imagePlan?.slots)) throw new Error("slot_repair_input_invalid");
  const baseline = materializeAgentPlanForSlotRepair(rawPlan, project).plan;
  const targets = [...unresolved(baseline)];
  if (!targets.length || !targets.every((role) => slotsByRole(baseline).has(role))) throw new Error("slot_repair_targets_invalid");
  if (expectedRoles && !same([...targets].sort(), [...expectedRoles].sort())) throw new Error("slot_repair_frozen_roles_mismatch");
  const rawRoles = rawPlan.imagePlan.slots.map(roleOf);
  if (new Set(rawRoles).size !== rawRoles.length) throw new Error("slot_repair_duplicate_role_input");
  const baselineSlots = slotsByRole(baseline);
  const targetSet = new Set(targets);
  const readOnlyRoles = [...baselineSlots.keys()].filter((role) => !targetSet.has(role));
  const sourceFactsByRole = {};
  for (const role of targets) {
    const rawSlot = rawPlan.imagePlan.slots.find((slot) => slot.role === role);
    const roots = allowedReferenceRoots(role, rawSlot?.sourceRefs);
    if (!roots.length || !validReferences(rawSlot?.sourceRefs, role, project.factBasis, rawSlot?.sourceRefs)) throw new Error("slot_repair_source_refs_invalid");
    sourceFactsByRole[role] = roots.map((ref) => ({ ref, value: referenceValue(project.factBasis, ref) }));
  }
  const requestInput = {
    contract: "Repair only the listed unresolved image roles. Return one JSON object with patches. Each patch is {role, action:'replace', slot:{primaryVisualSubject,visualDuty,differentiation,location,locationRole,queryCore,fidelityQuery,alternateQueries,sourceRefs,exactIdentityRequired}, reason} or {role,action:'omit',reason}. Omit only when required=false and removable=true, with a fact-based reason why no independent useful picture is supported; optional dining/transport omissions must still respect the existing module choice, and DAY supporting remains optional. Do not invent facts, select a branch without source support, repeat any read-only visual responsibility, or change trip facts. Hotel representative images must keep the specific booked hotel identity, while a generic representative space may not promise an unsupported room type or facility. Preserve optional/self-paid/pending experience status and fee boundaries exactly; sourceRef path existence alone is not semantic evidence. Keep one Core subject/action/identity and all queries for the same photograph. Every listed role must receive exactly one patch.",
    unresolved: targets.map((role) => {
      const slot = baselineSlots.get(role);
      const rawSlot = rawPlan.imagePlan.slots.find((candidate) => candidate.role === role);
      return { role, required: slot.required, removable: slot.removable, current: Object.fromEntries(Object.entries(rawSlot).filter(([key]) => VISUAL_FIELDS.has(key))), issues: safeIssues(slot) };
    }),
    sourceFactsByRole,
    readOnlyVisualDuties: readOnlyRoles.map((role) => {
      const slot = baselineSlots.get(role);
      return { role, primaryVisualSubject: slot.primaryVisualSubject, visualDuty: slot.visualDuty, queryCore: slot.queryCore, key: visualKey(slot) };
    }),
  };
  return { rawPlan: copy(rawPlan), project: copy(project), baseline, targets, readOnlyRoles, requestInput };
}

function validatePatch(patch, prepared) {
  if (!patch || typeof patch !== "object" || !prepared.targets.includes(patch.role)) return "unknown_role";
  if (!same(Object.keys(patch).sort(), (patch.action === "replace" ? ["role", "action", "slot", "reason"] : ["role", "action", "reason"]).sort())) return "patch_shape_invalid";
  if (typeof patch.reason !== "string" || !patch.reason.trim()) return "reason_missing";
  const source = prepared.rawPlan.imagePlan.slots.find((slot) => slot.role === patch.role);
  if (!source) return "unknown_role";
  if (patch.action === "omit") {
    const effective = slotsByRole(prepared.baseline).get(patch.role);
    return effective?.required === false && effective?.removable === true
      && /^(?:dining:\d+|transport:\d+|day:\d+:supporting:\d+)$/.test(patch.role)
      ? null : "required_or_nonremovable_omission";
  }
  if (patch.action !== "replace" || !patch.slot || typeof patch.slot !== "object" || Array.isArray(patch.slot)) return "patch_shape_invalid";
  if (Object.keys(patch.slot).some((key) => !VISUAL_FIELDS.has(key)) || REQUIRED_FIELDS.some((key) => !(key in patch.slot))) return "readonly_or_missing_field";
  if (/^hotel:\d+$/.test(patch.role)
    && (patch.slot.exactIdentityRequired !== true || patch.slot.queryCore?.identity !== source.queryCore?.identity)) return "hotel_identity_changed";
  if (!validReferences(patch.slot.sourceRefs, patch.role, prepared.project.factBasis, source.sourceRefs)) return "source_ref_out_of_scope_or_missing";
  return null;
}

function mergeOne(rawPlan, patch) {
  const next = copy(rawPlan);
  const index = next.imagePlan.slots.findIndex((slot) => slot.role === patch.role);
  if (patch.action === "omit") {
    next.imagePlan.slots.splice(index, 1);
    if (/^(?:dining|transport):\d+$/.test(patch.role)) {
      next.imagePlan.omittedOptionalRoles = [...(next.imagePlan.omittedOptionalRoles || []), patch.role];
    }
  }
  else {
    next.imagePlan.slots[index] = { ...next.imagePlan.slots[index], ...patch.slot };
    const main = /^day:(\d+)$/.exec(patch.role);
    if (main) {
      const dayRole = next.dayRoles?.find((role) => Number(role.index) === Number(main[1]) - 1);
      if (!dayRole) throw new Error("slot_repair_day_role_missing");
      dayRole.primaryVisualSubject = patch.slot.primaryVisualSubject;
    }
  }
  return next;
}

function unchangedGoodRoles(before, after, goodRoles) {
  const beforeSlots = slotsByRole(before);
  const afterSlots = slotsByRole(after);
  return goodRoles.every((role) => same(beforeSlots.get(role), afterSlots.get(role)));
}

export function applySlotRepairProposal(prepared, proposal) {
  const diagnostics = { validationPasses: 0, validationDurationMs: 0 };
  const reject = (code, detail = {}) => failure(code, { ...detail, diagnostics });
  if (!proposal || !same(Object.keys(proposal).sort(), ["patches"]) || !Array.isArray(proposal.patches)) return reject("proposal_shape_invalid");
  const received = proposal.patches.map((patch) => patch?.role);
  if (!same([...received].sort(), [...prepared.targets].sort())) return reject("target_roles_mismatch");
  const rejected = [];
  const validPatches = [];
  for (const patch of proposal.patches) {
    const issue = validatePatch(patch, prepared);
    if (issue) { rejected.push({ role: patch?.role || null, code: issue }); continue; }
    validPatches.push(patch);
  }
  if (!validPatches.length) return { accepted: false, code: "threshold_not_met", rawPlan: copy(prepared.rawPlan), plan: prepared.baseline,
    acceptedRoles: [], rejected, omitted: [], remainingRoles: prepared.targets,
    requiredCount: prepared.targets.filter((role) => prepared.baseline.imagePlan.slots.find((slot) => slot.role === role)?.required !== false).length,
    optionalCount: prepared.targets.filter((role) => prepared.baseline.imagePlan.slots.find((slot) => slot.role === role)?.required === false).length, diagnostics };
  const build = (patches) => {
    const raw = patches.reduce((current, patch) => mergeOne(current, patch), copy(prepared.rawPlan));
    const started = performance.now();
    diagnostics.validationPasses += 1;
    try { return { raw, plan: materializeAgentPlanForSlotRepair(raw, prepared.project).plan }; }
    finally { diagnostics.validationDurationMs += performance.now() - started; }
  };
  const batchIssue = (plan, patches) => {
    if (!unchangedGoodRoles(prepared.baseline, plan, prepared.readOnlyRoles)) return "good_role_changed";
    if (!same(plan.factBasis, prepared.project.factBasis)) return "facts_changed";
    if (plan.dayRoles.length !== prepared.baseline.dayRoles.length) return "day_role_fact_changed";
    const permittedMainRoles = new Set(patches.filter((patch) => patch.action === "replace" && /^day:\d+$/.test(patch.role)).map((patch) => patch.role));
    if (!plan.dayRoles.every((role, index) => {
      const prior = prepared.baseline.dayRoles[index];
      const current = { ...role };
      const original = { ...prior };
      if (permittedMainRoles.has(`day:${index + 1}`)) {
        delete current.primaryVisualSubject;
        delete original.primaryVisualSubject;
      }
      return same(current, original);
    })) return "day_role_fact_changed";
    if ([...slotsByRole(plan).keys()].some((role) => !slotsByRole(prepared.baseline).has(role))) return "unknown_role";
    if ([...unresolved(plan)].some((role) => !unresolved(prepared.baseline).has(role))) return "new_unresolved_role";
    return null;
  };
  let current;
  try { current = build(validPatches); } catch { return reject("validation_error", { rejected }); }
  const firstIssue = batchIssue(current.plan, validPatches);
  if (firstIssue) return reject(firstIssue, { rejected: [...rejected, ...validPatches.map((patch) => ({ role: patch.role, code: firstIssue }))] });
  const failedPatches = validPatches.filter((patch) => patch.action === "omit"
    ? slotsByRole(current.plan).has(patch.role) || unresolved(current.plan).has(patch.role)
    : unresolved(current.plan).has(patch.role));
  const acceptedPatches = validPatches.filter((patch) => !failedPatches.includes(patch));
  if (failedPatches.length) {
    rejected.push(...failedPatches.map((patch) => ({ role: patch.role, code: "target_still_unresolved" })));
    if (!acceptedPatches.length) current = { raw: copy(prepared.rawPlan), plan: prepared.baseline };
    else try { current = build(acceptedPatches); } catch { return reject("validation_error", { rejected }); }
    const secondIssue = batchIssue(current.plan, acceptedPatches);
    if (secondIssue || acceptedPatches.some((patch) => patch.action !== "omit" && unresolved(current.plan).has(patch.role))) {
      return reject(secondIssue || "batch_conflict", { rejected });
    }
  }
  const accepted = acceptedPatches.map((patch) => patch.role);
  const omitted = acceptedPatches.filter((patch) => patch.action === "omit").map((patch) => ({ role: patch.role, reason: patch.reason }));
  const remaining = [...unresolved(current.plan)];
  const required = prepared.targets.filter((role) => prepared.baseline.imagePlan.slots.find((slot) => slot.role === role)?.required !== false);
  const optional = prepared.targets.filter((role) => !required.includes(role));
  const thresholdPassed = required.every((role) => accepted.includes(role))
    && optional.filter((role) => accepted.includes(role)).length >= Math.ceil(optional.length / 2)
    && ![...unresolved(current.plan)].some((role) => !unresolved(prepared.baseline).has(role));
  return { accepted: thresholdPassed, code: thresholdPassed ? "threshold_passed" : "threshold_not_met", rawPlan: current.raw, plan: current.plan, acceptedRoles: accepted, rejected, omitted, remainingRoles: remaining, requiredCount: required.length, optionalCount: optional.length, diagnostics };
}

export function validateSlotRepairInWorker(prepared, proposal, signal, onProgress) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./agent-slot-repair-worker.mjs", import.meta.url), { workerData: { prepared, proposal } });
    let settled = false;
    let terminating = false;
    let result;
    let workerError;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (reason) => {
      if (settled || terminating) return;
      terminating = true;
      void worker.terminate().then((exitCode) => {
        const error = Object.assign(new Error(reason.message || "Aborted"), {
          name: reason.name || "AbortError", code: typeof reason.code === "string" ? reason.code : null,
          workerTerminationConfirmed: true, workerTerminationExitCode: exitCode,
        });
        finish(error);
      }).catch((error) => finish(Object.assign(error, { code: "validation_worker_termination_failed" })));
    };
    const onAbort = () => terminate(signal.reason || new DOMException("Aborted", "AbortError"));
    worker.on("message", (message) => {
      if (signal?.aborted || terminating || settled) return;
      if (message?.event === "validation_started") {
        try { onProgress?.({ phase: "validation_started" }); }
        catch (error) { terminate(error); }
      } else if (message?.ok) result = message.result;
      else workerError = Object.assign(new Error("validation_worker_error"), { code: message?.code || "validation_worker_error" });
    });
    worker.once("error", (error) => { workerError = Object.assign(error, { code: "validation_worker_error" }); });
    worker.once("exit", (code) => {
      if (terminating || settled) return;
      if (signal?.aborted) { onAbort(); return; }
      if (workerError) finish(workerError);
      else if (code === 0 && result) finish(null, { ...result, workerExitConfirmed: true, workerExitCode: code });
      else finish(Object.assign(new Error("validation_worker_exit"), { code: "validation_worker_exit", exitCode: code }));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function requestFrozenSlotRepair({ prepared, apiKey, baseUrl, model, signal, requestJson = requestDeepSeekJson, fetchImpl = fetch, onModelAttempt, onPhase, deadlineMs = MAX_DURATION_MS } = {}) {
  if (signal?.aborted) throw signal.reason || new DOMException("Cancelled", "AbortError");
  const effectiveDeadlineMs = Math.min(MAX_DURATION_MS, Math.max(1, deadlineMs));
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let physicalRequests = 0;
  let rawContent = "";
  let stage = "model_request";
  let removeAbortListener = () => {};
  const phases = [];
  // Phase observers are synchronous and contain metadata only. A failed
  // evidence sink must stop the POC instead of producing an unverifiable pass.
  const recordPhase = (phase, details = {}) => {
    const event = { phase, stage, physicalRequests, durationMs: Date.now() - started, ...details };
    phases.push(event);
    try { onPhase?.(event); }
    catch { throw Object.assign(new Error("repair_evidence_failed"), { code: "repair_evidence_failed" }); }
  };
  const diagnostics = () => ({ stage, physicalRequests, durationMs: Date.now() - started, phases });
  const forwardCancel = () => controller.abort(signal.reason || new DOMException("Cancelled", "AbortError"));
  signal?.addEventListener("abort", forwardCancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new DOMException("Slot repair deadline", "TimeoutError")); }, effectiveDeadlineMs);
  try {
    recordPhase("request_started");
    const messages = [
      { role: "system", content: "你只修补一次完整行程Planner中的未决图片位。严格按输入契约返回JSON对象，只含patches。不要修改任何非目标role或事实。每个画面单一Core，所有Query与Core一致，来源必须支持，不能复制已通过画面。仅required=false且removable=true的位可基于事实说明理由省略。" },
      { role: "user", content: JSON.stringify(prepared.requestInput) },
    ];
    const modelPromise = requestJson({ apiKey, baseUrl, model, messages, reasoningEffort: "medium", thinkingType: "disabled", maxTokens: 9000,
      timeoutMs: effectiveDeadlineMs, emptyContentRetries: 0, allowSyntaxRepair: false, signal: controller.signal,
      fetchImpl: async (...args) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (physicalRequests >= 1) throw new Error("slot_repair_request_limit");
        physicalRequests += 1;
        recordPhase("physical_request_started");
        const response = await fetchImpl(...args);
        if (!controller.signal.aborted) { stage = "response_read"; recordPhase("response_headers_received"); }
        return response;
      },
      onModelAttempt: async (event) => {
        if (timedOut || signal?.aborted) return;
        rawContent = String(event.rawContent || "");
        stage = "response_read";
        recordPhase("response_received", { receivedContentChars: rawContent.length, parseStatus: event.parseResult?.status || null });
        try { await onModelAttempt?.({ rawContent, attempt: event.attempt, receivedContentChars: rawContent.length, parseStatus: event.parseResult?.status || null, errorCode: event.error?.code || null, physicalRequests, durationMs: Date.now() - started, phase: "response_received" }); }
        catch { throw Object.assign(new Error("repair_evidence_failed"), { code: "repair_evidence_failed" }); }
      },
    });
    const response = await Promise.race([
      modelPromise,
      new Promise((_, reject) => {
        const onAbort = () => reject(controller.signal.reason || new DOMException("Aborted", "AbortError"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) onAbort();
      }),
    ]);
    removeAbortListener();
    if (timedOut || Date.now() - started > effectiveDeadlineMs) return { status: "timeout", ...diagnostics(), rawContent };
    if (signal?.aborted) throw signal.reason || new DOMException("Cancelled", "AbortError");
    stage = "local_validation";
    recordPhase("validation_queued");
    const result = await validateSlotRepairInWorker(prepared, response.json, controller.signal, ({ phase }) => recordPhase(phase));
    recordPhase("validation_finished", { ...result.diagnostics, workerExitConfirmed: result.workerExitConfirmed, workerExitCode: result.workerExitCode });
    if (timedOut || Date.now() - started > effectiveDeadlineMs) return { status: "timeout", ...diagnostics(), rawContent };
    if (signal?.aborted) throw signal.reason || new DOMException("Cancelled", "AbortError");
    return { status: result.accepted ? "accepted" : "validation_failed", ...diagnostics(), rawContent, result };
  } catch (error) {
    if (signal?.aborted) {
      const cancellation = error?.workerTerminationConfirmed ? error : signal.reason || error;
      Object.assign(cancellation, { repairDiagnostics: diagnostics() });
      throw cancellation;
    }
    const status = error?.code === "repair_evidence_failed" ? "evidence_failed"
      : timedOut || error?.code === "model_timeout" ? "timeout"
      : error?.code === "planner_json_invalid" ? "parse_failed"
        : /^validation_worker_/.test(error?.code || "") ? "validation_failed" : "transport_failed";
    return { status, ...diagnostics(), rawContent,
      errorCode: timedOut ? "repair_timeout" : error?.code || error?.name || "request_failed",
      ...(error?.workerTerminationConfirmed ? { workerTerminationConfirmed: true, workerTerminationExitCode: error.workerTerminationExitCode } : {}) };
  } finally {
    clearTimeout(timeout);
    removeAbortListener();
    signal?.removeEventListener("abort", forwardCancel);
  }
}
