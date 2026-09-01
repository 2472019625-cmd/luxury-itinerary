import { createHash } from "node:crypto";

export function generationFingerprint(data, context) {
  return createHash("sha256").update(JSON.stringify({ data, context })).digest("hex");
}

export function activeGenerationByFingerprint(jobs, fingerprint) {
  return [...jobs.values()].find((item) => item.kind === "generation" && item.generationFingerprint === fingerprint && !["complete", "failed"].includes(item.status));
}
