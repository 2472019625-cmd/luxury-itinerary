import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentPlannerServer } from "../server/agent-planner-app.mjs";

test("独立服务硬拒绝4173且不暴露旧生成端点", async () => {
  assert.throws(() => createAgentPlannerServer({ port: 4173, workspaceRoot: mkdtempSync(path.join(tmpdir(), "agent-http-forbidden-")) }), /禁止使用/);
  const { server } = createAgentPlannerServer({ port: 0, workspaceRoot: mkdtempSync(path.join(tmpdir(), "agent-http-")), modelConfig: { apiKey: "test" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/api/agent/health`)).json();
    assert.equal(health.executionEnabled, false);
    assert.equal(health.flowKind, "agent_v1");
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(forbidden.status, 404);
    assert.match((await forbidden.json()).error, /未提供该能力/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
