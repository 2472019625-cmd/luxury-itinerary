import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeName(value) {
  return String(value || "unit").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

export function createCopyUnitStore(projectRoot, jobId) {
  const jobsDirectory = path.join(projectRoot, "workspace", "jobs");
  const directory = path.join(jobsDirectory, safeName(jobId), "copy-units");
  mkdirSync(directory, { recursive: true });

  function reusableRecord(unit, input) {
    if (!existsSync(jobsDirectory)) return null;
    const expectedFingerprint = fingerprint(input);
    const expectedFile = `${safeName(unit.id)}.json`;
    for (const candidateJob of readdirSync(jobsDirectory).reverse()) {
      const candidateFile = path.join(jobsDirectory, candidateJob, "copy-units", expectedFile);
      if (!existsSync(candidateFile)) continue;
      try {
        const record = JSON.parse(readFileSync(candidateFile, "utf8"));
        if (record.status !== "complete" || !record.output) continue;
        if (record.ruleVersion !== unit.ruleVersion || record.inputFingerprint !== expectedFingerprint) continue;
        return { record, file: candidateFile };
      } catch {
        // 损坏或未完成的中间文件不能成为恢复依据。
      }
    }
    return null;
  }

  return {
    directory,
    loadReusable: reusableRecord,
    save(unit, input, result) {
      const record = {
        id: unit.id,
        type: unit.type,
        dayIndexes: unit.dayIndexes || [],
        ruleVersion: unit.ruleVersion,
        inputFingerprint: fingerprint(input),
        status: result.status,
        attempts: result.attempts || 1,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        model: result.model || null,
        usage: result.usage || null,
        attemptUsages: result.attemptUsages || [],
        recovery: result.recovery || null,
        recoveredFrom: result.recoveredFrom || null,
        parentUnitId: unit.parentUnitId || null,
        output: result.output ?? null,
        error: result.error ? String(result.error).slice(0, 500) : null,
      };
      const file = path.join(directory, `${safeName(unit.id)}.json`);
      writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
      return file;
    },
  };
}
