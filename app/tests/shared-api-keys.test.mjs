import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedApiKeyStore, testSharedApiService } from "../server/shared-api-keys.mjs";

test("共用接口 Key 加密保存、只返回配置状态，替换与移除可追踪", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shared-api-keys-"));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const file = path.join(dir, "keys.json");
  const store = new SharedApiKeyStore({ file });
  assert.equal(store.mode(), "legacy");
  assert.equal(store.status().filter((item) => item.configured).length, 0);
  store.set("text", "secret-text-key");
  assert.equal(store.get("text"), "secret-text-key");
  assert.doesNotMatch(await readFile(file, "utf8"), /secret-text-key/);
  assert.doesNotMatch(JSON.stringify(store.status()), /secret-text-key/);
  assert.equal(new SharedApiKeyStore({ file }).get("text"), "secret-text-key");
  store.set("text", "new-secret-key");
  assert.equal(store.get("text"), "new-secret-key");
  store.delete("text");
  assert.equal(store.get("text"), "");
  assert.throws(() => store.set("unknown", "x"), /未知接口/);
});

test("共用 Key 先配置后显式启用，模式持久化且可回退", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shared-api-mode-"));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const file = path.join(dir, "keys.json");
  const store = new SharedApiKeyStore({ file });
  assert.throws(() => store.activate(), /请先配置全部接口/);
  for (const id of ["text", "search", "vision", "you"]) store.set(id, `private-${id}`);
  assert.equal(store.mode(), "legacy");
  store.activate();
  assert.equal(new SharedApiKeyStore({ file }).mode(), "shared");
  assert.throws(() => store.delete("text"), /先回退旧配置/);
  store.useLegacy();
  assert.equal(new SharedApiKeyStore({ file }).mode(), "legacy");
  assert.equal(store.get("text"), "private-text");
});

test("连接测试不会返回 Key 或服务响应正文", async () => {
  let suppliedAuthorization = "";
  const result = await testSharedApiService("text", {
    apiKey:"private-key",
    modelConfig:{ baseUrl:"https://model.example/v1", model:"configured-model" },
    fetchImpl:async (_url, options) => { suppliedAuthorization = options.headers.Authorization; return { ok:false, status:401, body:"private-key" }; },
  });
  assert.equal(suppliedAuthorization, "Bearer private-key");
  assert.equal(result.connected, false);
  assert.doesNotMatch(JSON.stringify(result), /private-key/);
});
