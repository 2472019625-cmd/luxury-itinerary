// Isolated replay of frozen visual-card inputs, using one current Writer call.
import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { runCopyWriterSkill } from "../server/simple-copy-skill.mjs";
import { requestDeepSeekJson } from "../server/deepseek-client.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const i = arg.indexOf("="); return [arg.slice(2, i), arg.slice(i + 1)]; }));
const output = await realpath(args["output-dir"]);
const relative = path.relative(path.resolve(import.meta.dirname, "../.."), output);
assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "Require registered external private evidence directory");
const evidence = JSON.parse((await readFile(args["request-evidence"], "utf8")).replace(/^\uFEFF/, ""));
const payload = JSON.parse(evidence.messages.at(-1).content);
const ids = args["target-ids"].split(",");
const tasks = payload.tasks.filter((task) => ids.includes(task.targetId));
assert.equal(new Set(ids).size, ids.length);
assert.equal(tasks.length, ids.length);
assert.ok(tasks.every((task) => task.moduleType === "visual_card" && !task.researchRequest));
for (const file of [".env.local", ".env.image-search.local"]) {
  const contents = await readFile(path.join(args["config-dir"], file), "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2), { flag: "wx" });
await save("frozen-input.json", { itineraryContext: payload.itineraryContext, tasks });
let physicalRequests = 0;
let eventCount = 0;
const started = Date.now();
try {
  const result = await runCopyWriterSkill({ tasks, itineraryContext: payload.itineraryContext,
    apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: process.env.TEXT_MODEL_BASE_URL, model: process.env.TEXT_MODEL_NAME,
    signal: AbortSignal.timeout(120_000),
    requestJson: (options) => requestDeepSeekJson({ ...options, emptyContentRetries: 0, allowSyntaxRepair: false, timeoutMs: 120_000,
      fetchImpl: async (...input) => {
        if (physicalRequests >= 1) throw new Error("Single physical request limit");
        physicalRequests += 1;
        return fetch(...input);
      },
    }),
    onWriterEvidence: (event) => save(`writer-${++eventCount}-${event.phase}.json`, event),
  });
  await save("result.json", result);
  const summary = { status: result.results.every((item) => item.status === "success") ? "REQUIRES_SEMANTIC_REVIEW" : "FAIL",
    physicalRequests, durationMs: Date.now() - started, results: result.results.map(({ targetId, status, error }) => ({ targetId, status, error })) };
  await save("summary.json", summary);
  console.log(JSON.stringify(summary));
  if (summary.status === "FAIL") process.exitCode = 1;
} catch (error) {
  const summary = { status: "FAIL", physicalRequests, durationMs: Date.now() - started, code: error.code || error.name };
  await save("summary.json", summary);
  console.log(JSON.stringify(summary));
  process.exitCode = 1;
}
