import { parentPort, workerData } from "node:worker_threads";
import { applySlotRepairProposal } from "./agent-slot-repair.mjs";

try {
  parentPort.postMessage({ event: "validation_started" });
  parentPort.postMessage({ ok: true, result: applySlotRepairProposal(workerData.prepared, workerData.proposal) });
} catch {
  parentPort.postMessage({ ok: false, code: "validation_worker_error" });
}
