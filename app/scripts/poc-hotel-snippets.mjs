// Bounded current hotel-search -> existing Writer probe. No project writeback.
import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { runCopyWriterSkill } from "../server/simple-copy-skill.mjs";
import { runCopyFactsResearch } from "../server/simple-copy-facts-research.mjs";
import { searchHotelHighlights } from "../server/you-hotel-search.mjs";
import { requestDeepSeekJson } from "../server/deepseek-client.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const i = arg.indexOf("="); return [arg.slice(2, i), arg.slice(i + 1)]; }));
const output = await realpath(args["output-dir"]);
const relative = path.relative(path.resolve(import.meta.dirname, "../.."), output);
assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "Require registered private evidence directory outside repository");
const plan = JSON.parse(await readFile(args["plan-file"], "utf8"));
const tasks = plan.copyTasks.filter((task) => task.moduleType === "hotel_fact_rows");
assert.ok(tasks.length && tasks.every((task) => task.researchRequest?.entityKind === "hotel"));
assert.ok((process.env.YDC_API_KEY || args["research-dir"]) && process.env.TEXT_MODEL_API_KEY, "Existing configuration missing; no requests sent");
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2), { flag: "wx" });
const searchCounts = new Map();
let writerRequests = 0;
let eventCount = 0;
const started = Date.now();
await save("input.json", { tasks, itineraryContext: plan.itineraryContext });
try {
  const result = await runCopyWriterSkill({ tasks, itineraryContext: plan.itineraryContext,
    apiKey: process.env.TEXT_MODEL_API_KEY, baseUrl: process.env.TEXT_MODEL_BASE_URL, model: process.env.TEXT_MODEL_NAME,
    signal: AbortSignal.timeout(180_000),
    researchFacts: (options) => runCopyFactsResearch({ ...options,
      // This probe measures the configured snippet path, not another legacy retry.
      requestResearch: async () => { throw Object.assign(new Error("Legacy fallback outside probe scope"), { code: "legacy_probe_not_run" }); },
      hotelSearch: async (input) => {
        const entity = input.researchRequest.entityName;
        const number = tasks.findIndex((task) => task.researchRequest.entityName === entity) + 1;
        if (args["research-dir"]) {
          const research = JSON.parse(await readFile(path.join(args["research-dir"], `hotel-${number}-search.json`), "utf8"));
          assert.equal(research.entityName, entity, "Saved research must match this exact hotel");
          await save(`hotel-${number}-search.json`, research);
          return research;
        }
        const research = await searchHotelHighlights({ ...input, fetchImpl: async (...parameters) => {
          assert.equal(searchCounts.get(entity) || 0, 0, "One physical search per hotel");
          searchCounts.set(entity, 1);
          const response = await fetch(...parameters);
          await save(`hotel-${number}-search-raw.json`, { status: response.status, payload: await response.clone().json() });
          return response;
        } });
        await save(`hotel-${number}-search.json`, research);
        return research;
      },
    }),
    requestJson: (options) => requestDeepSeekJson({ ...options, emptyContentRetries: 0, allowSyntaxRepair: false,
      fetchImpl: async (...parameters) => { assert.equal(writerRequests++, 0, "One Writer request"); return fetch(...parameters); },
    }),
    onWriterEvidence: (event) => save(`writer-${++eventCount}-${event.phase}.json`, event),
  });
  await save("result.json", result);
  const summary = { status: result.results.every((item) => item.status === "success") ? "REQUIRES_SEMANTIC_REVIEW" : "FAIL",
    searchRequests: [...searchCounts.values()].reduce((sum, count) => sum + count, 0), writerRequests, reusedResearch: Boolean(args["research-dir"]),
    durationMs: Date.now() - started,
    rows: result.results.map((item) => ({ targetId: item.targetId, status: item.status, nonEmpty: Array.isArray(item.value) ? item.value.filter((row) => row.text).length : 0 })) };
  await save("summary.json", summary);
  console.log(JSON.stringify(summary));
  if (summary.status === "FAIL") process.exitCode = 1;
} catch (error) {
  const summary = { status: "FAIL", code: error.code || error.name, searchRequests: searchCounts.size, writerRequests, durationMs: Date.now() - started };
  await save("summary.json", summary);
  console.log(JSON.stringify(summary));
  process.exitCode = 1;
}
