import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { prepareSourceGroundedSlotRepair, requestFrozenSlotRepair } from "../server/agent-slot-repair.mjs";
import { prepareBoundSlotRepair, compileBoundSlotProposal } from "../server/agent-slot-repair-bindings.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function roleFromSimpleSlot(slot) {
  const day = /^image:day:(\d+)(?::supporting:(\d+)|:primary)$/.exec(slot.slotId || "");
  if (day) return day[2] ? `day:${day[1]}:supporting:${day[2]}` : `day:${day[1]}`;
  const refs = Array.isArray(slot.sourceEvidence) ? slot.sourceEvidence : [slot.sourceEvidence];
  const source = refs.find((ref) => /^(?:hotels|diningExperiences|transport)\.\d+$/.test(ref || "")) || "";
  const module = /^(hotels|diningExperiences|transport)\.(\d+)$/.exec(source);
  if (module) return `${{ hotels: "hotel", diningExperiences: "dining", transport: "transport" }[module[1]]}:${Number(module[2]) + 1}`;
  return null;
}

const runRoot = argument("--run-root");
const outputDir = argument("--output-dir");
const projectId = argument("--project-id");
const expectedRawSha256 = argument("--raw-sha256");
if (!runRoot || !outputDir || !/^[0-9a-f-]{36}$/i.test(projectId || "") || !/^[0-9a-f]{64}$/i.test(expectedRawSha256 || "")) {
  process.stderr.write("Usage: node scripts/poc-slot-repair.mjs --run-root <frozen-run> --output-dir <registered-private-poc-dir> --project-id <uuid> --raw-sha256 <sha256>\n");
  process.exit(64);
}
const inputRoot = path.resolve(runRoot);
const projectRoot = path.join(inputRoot, "projects", projectId);
const outputRoot = path.resolve(outputDir);
if (outputRoot === inputRoot || outputRoot.startsWith(`${inputRoot}${path.sep}`)) {
  process.stderr.write("Output must be separate from the frozen source run.\n");
  process.exit(64);
}
const save = async (name, data) => writeFile(path.join(outputRoot, name), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
const summary = { status: "not_started", projectId, physicalRequests: 0, durationMs: 0, acceptedRoles: [], rejected: [] };
const started = performance.now();
const cancellation = new AbortController();
const onInterrupt = () => cancellation.abort(new DOMException("User cancelled", "AbortError"));
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);
const recordPhase = (event) => {
  summary.stage = event.stage;
  summary.physicalRequests = event.physicalRequests;
  summary.durationMs = event.durationMs;
  appendFileSync(path.join(outputRoot, "phases.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
};
let rawSaved = false;
try {
  recordPhase({ phase: "preparation_started", stage: "preparation", physicalRequests: 0, durationMs: 0 });
  const project = JSON.parse(await readFile(path.join(projectRoot, "project.json"), "utf8"));
  if (project.projectId !== projectId || !/^[0-9a-f-]{36}$/i.test(project.activePlanId || "")) throw new Error("frozen_identity_mismatch");
  const [rawText, simplePlan] = await Promise.all([
    readFile(path.join(projectRoot, "planner-attempts", "planner-attempt-1-raw.txt"), "utf8"),
    readFile(path.join(projectRoot, "plans", `${project.activePlanId}.json`), "utf8").then(JSON.parse),
  ]);
  const rawSha256 = createHash("sha256").update(rawText).digest("hex");
  if (rawSha256 !== expectedRawSha256.toLowerCase() || simplePlan.planId !== project.activePlanId || simplePlan.projectId !== projectId) throw new Error("frozen_snapshot_mismatch");
  const rawPlan = JSON.parse(rawText);
  const expectedRoles = (simplePlan.imageSlots || []).filter((slot) => slot.plannerSlotStatus === "unresolved")
    .map(roleFromSimpleSlot);
  if (expectedRoles.some((role) => !role) || new Set(expectedRoles).size !== expectedRoles.length) throw new Error("frozen_roles_unmapped");
  const grounded = prepareSourceGroundedSlotRepair({ rawPlan, project, expectedRoles });
  const bound = argument("--contract") === "source-bindings-v2";
  const prepared = bound ? prepareBoundSlotRepair(grounded) : grounded;
  summary.requestFormat = prepared.requestFormat || prepared.groundingMode;
  summary.groundingMode = prepared.groundingMode;
  summary.preparationMs = performance.now() - started;
  recordPhase({ phase: "preparation_finished", stage: "preparation", physicalRequests: 0, durationMs: 0, preparationMs: summary.preparationMs, targetCount: prepared.targets.length });
  summary.planId = project.activePlanId;
  summary.rawSha256 = rawSha256;
  summary.remainingRoles = prepared.targets;
  await save("before-raw.json", rawPlan);
  await save("before-validated.json", prepared.baseline);
  await save("request-input.json", prepared.requestInput);
  if (!process.env.TEXT_MODEL_API_KEY || !process.env.TEXT_MODEL_BASE_URL || !process.env.TEXT_MODEL_NAME) throw new Error("model_config_missing");
  const response = await requestFrozenSlotRepair({ prepared, signal: cancellation.signal, onPhase: recordPhase, apiKey: process.env.TEXT_MODEL_API_KEY,
    baseUrl: process.env.TEXT_MODEL_BASE_URL, model: process.env.TEXT_MODEL_NAME,
    transformProposal: bound ? (proposal) => compileBoundSlotProposal(prepared, proposal) : undefined,
    onModelAttempt: async (event) => {
      if (event.rawContent) {
        await writeFile(path.join(outputRoot, "model-raw.txt"), event.rawContent, { flag: "wx" });
        rawSaved = true;
      }
      await save("model-attempt.json", { phase: event.phase, attempt: event.attempt,
        physicalRequests: event.physicalRequests, durationMs: event.durationMs,
        receivedContentChars: event.receivedContentChars, parseStatus: event.parseStatus, errorCode: event.errorCode });
    },
  });
  summary.status = response.status;
  summary.physicalRequests = response.physicalRequests;
  summary.durationMs = response.durationMs;
  if (response.rawContent && !rawSaved) await writeFile(path.join(outputRoot, "model-raw.txt"), response.rawContent, { flag: "wx" });
  if (response.result?.plan && response.result?.rawPlan) {
    await save("after-raw.json", response.result.rawPlan);
    await save("after-validated.json", response.result.plan);
    summary.acceptedRoles = response.result.acceptedRoles;
    summary.rejected = response.result.rejected;
    summary.remainingRoles = response.result.remainingRoles;
    summary.requiredCount = response.result.requiredCount;
    summary.optionalCount = response.result.optionalCount;
    summary.thresholdPassed = response.result.accepted;
    summary.omitted = response.result.omitted;
    summary.validationDiagnostics = response.result.diagnostics;
    summary.workerExitConfirmed = response.result.workerExitConfirmed;
    summary.workerExitCode = response.result.workerExitCode;
  } else if (response.result?.code) summary.validationCode = response.result.code;
  if (response.errorCode) summary.errorCode = response.errorCode;
  if (response.stage) summary.stage = response.stage;
  if (response.workerTerminationConfirmed) {
    summary.workerTerminationConfirmed = true;
    summary.workerTerminationExitCode = response.workerTerminationExitCode;
  }
  process.exitCode = { accepted: 0, timeout: 20, transport_failed: 21, parse_failed: 22, validation_failed: 23, evidence_failed: 25 }[response.status] ?? 24;
} catch (error) {
  summary.status = error?.name === "AbortError" ? "cancelled" : "input_failed";
  summary.errorCode = error?.code || error?.message?.match(/^[a-z0-9_]+$/)?.[0] || "unexpected_error";
  if (error?.repairDiagnostics) {
    summary.physicalRequests = error.repairDiagnostics.physicalRequests;
    summary.durationMs = error.repairDiagnostics.durationMs;
    summary.stage = error.repairDiagnostics.stage;
  }
  if (error?.workerTerminationConfirmed) {
    summary.workerTerminationConfirmed = true;
    summary.workerTerminationExitCode = error.workerTerminationExitCode;
  }
  process.exitCode = summary.status === "cancelled" ? 130 : 24;
} finally {
  summary.totalDurationMs = performance.now() - started;
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
  await save("summary.json", summary);
  process.stdout.write(`${JSON.stringify({ status: summary.status, physicalRequests: summary.physicalRequests, durationMs: summary.durationMs, outputDir: outputRoot })}\n`);
}
