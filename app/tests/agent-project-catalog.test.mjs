import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentProjectCatalog, PROJECT_TRASH_DAYS } from "../server/agent-project-catalog.mjs";

const day = 24 * 60 * 60 * 1000;

test("项目目录按创建者隔离、版本冲突保护和30天回收站期限", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-project-catalog-"));
  const catalog = new AgentProjectCatalog(path.join(root, "catalog.sqlite"));
  t.after(async () => { catalog.close(); await rm(root, { recursive: true, force: true }); });
  assert.throws(() => catalog.create("owner-a", { id: "empty", title: "空项目" }), /上传资料或填写有效信息/);
  const initial = catalog.create("owner-a", { id: "project-a", title: "行程", files: [{ name: "original.xlsx" }] }, 1000);
  assert.equal(initial.revision, 1);
  assert.equal(catalog.get("owner-b", "project-a"), null);
  const updated = catalog.update("owner-a", "project-a", { ...initial, customName: "新名称" }, 1, 2000);
  assert.equal(updated.revision, 2);
  assert.equal(updated.customName, "新名称");
  assert.throws(() => catalog.update("owner-a", "project-a", initial, 1, 3000), /另一页面更新/);
  const trashed = catalog.trash("owner-a", "project-a", 4000);
  assert.equal(trashed.purgeAt, 4000 + PROJECT_TRASH_DAYS * day);
  assert.equal(catalog.due(trashed.purgeAt - 1).length, 0);
  assert.equal(catalog.due(trashed.purgeAt).length, 1);
  assert.equal(catalog.update("owner-a", "project-a", updated, trashed.revision), null);
  assert.equal(catalog.restore("owner-a", "project-a", trashed.purgeAt), null);
  const restored = catalog.restore("owner-a", "project-a", trashed.purgeAt - 1);
  assert.equal(restored.trashedAt, null);
  assert.equal(restored.purgeAt, null);
  assert.equal(catalog.due(trashed.purgeAt).length, 0);
});

test("永久清理失败时保留回收站记录供重试", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-project-purge-"));
  const catalog = new AgentProjectCatalog(path.join(root, "catalog.sqlite"));
  t.after(async () => { catalog.close(); await rm(root, { recursive: true, force: true }); });
  catalog.create("owner-a", { id: "project-a", customerName: "客户" }, 1000);
  catalog.trash("owner-a", "project-a", 2000);
  await assert.rejects(catalog.purge("owner-a", "project-a", async () => { throw new Error("存储失败"); }), /存储失败/);
  assert.equal(catalog.get("owner-a", "project-a").deletionState, "active");
  let removed = false;
  assert.equal(await catalog.purge("owner-a", "project-a", async () => { removed = true; }), true);
  assert.equal(removed, true);
  assert.equal(catalog.get("owner-a", "project-a"), null);
});

test("服务重启后项目和回收站到期时间仍由磁盘目录提供", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-project-restart-"));
  const file = path.join(root, "catalog.sqlite");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  let catalog = new AgentProjectCatalog(file);
  catalog.create("owner-a", { id: "project-a", files: [{ name: "original.xlsx" }] }, 1000);
  const expiry = catalog.trash("owner-a", "project-a", 2000).purgeAt;
  catalog.close();
  catalog = new AgentProjectCatalog(file);
  assert.equal(catalog.get("owner-a", "project-a").purgeAt, expiry);
  assert.equal(catalog.list("owner-a").length, 1);
  catalog.close();
});
