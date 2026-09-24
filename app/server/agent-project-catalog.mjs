import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PROJECT_TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function validId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("项目编号无效");
  return id;
}

function parseRow(row) {
  if (!row) return null;
  return { ...JSON.parse(row.payload), id: row.id, ownerId: row.owner_id, revision: row.revision,
    trashedAt: row.deleted_at, purgeAt: row.purge_at, deletionState: row.deletion_state };
}

export class AgentProjectCatalog {
  constructor(file) {
    if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.database = new DatabaseSync(file);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.database.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, payload TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, deleted_at INTEGER, purge_at INTEGER,
      deletion_state TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner_updated ON projects(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS projects_purge ON projects(purge_at) WHERE purge_at IS NOT NULL;`);
  }

  close() { this.database.close(); }
  list(ownerId) {
    return this.database.prepare("SELECT * FROM projects WHERE owner_id=? AND deletion_state!='purging' ORDER BY updated_at DESC").all(String(ownerId)).map(parseRow);
  }
  get(ownerId, id) {
    return parseRow(this.database.prepare("SELECT * FROM projects WHERE owner_id=? AND id=?").get(String(ownerId), validId(id)));
  }
  getById(id) {
    return parseRow(this.database.prepare("SELECT * FROM projects WHERE id=?").get(validId(id)));
  }
  create(ownerId, project, now = Date.now()) {
    const id = validId(project?.id);
    const owner = String(ownerId || "");
    if (!owner) throw new Error("项目缺少创建者");
    if (!project?.files?.length && !String(project?.customerName || "").trim() && !project?.agentProjectId) throw new Error("请先上传资料或填写有效信息");
    const payload = { ...project, id, ownerId: owner, updatedAt: now };
    this.database.prepare("INSERT INTO projects(id,owner_id,payload,revision,updated_at) VALUES(?,?,?,?,?)")
      .run(id, owner, JSON.stringify(payload), 1, now);
    return this.get(owner, id);
  }
  update(ownerId, id, project, expectedRevision, now = Date.now()) {
    const current = this.get(ownerId, id);
    if (!current || current.deletionState !== "active" || current.trashedAt) return null;
    if (Number(expectedRevision) !== current.revision) {
      const error = new Error("项目已在另一页面更新，请刷新后再编辑"); error.code = "revision_conflict"; throw error;
    }
    const payload = { ...project, id: current.id, ownerId: current.ownerId, updatedAt: now };
    const changed = this.database.prepare("UPDATE projects SET payload=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND deletion_state='active'")
      .run(JSON.stringify(payload), now, current.id, current.ownerId, current.revision);
    if (!changed.changes) { const error = new Error("项目已在另一页面更新，请刷新后再编辑"); error.code = "revision_conflict"; throw error; }
    return this.get(ownerId, id);
  }
  trash(ownerId, id, now = Date.now()) {
    const current = this.get(ownerId, id);
    if (!current || current.deletionState !== "active") return null;
    if (current.trashedAt) return current;
    const purgeAt = now + PROJECT_TRASH_DAYS * DAY_MS;
    this.database.prepare("UPDATE projects SET deleted_at=?,purge_at=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND deletion_state='active'")
      .run(now, purgeAt, now, id, ownerId);
    return this.get(ownerId, id);
  }
  restore(ownerId, id, now = Date.now()) {
    const current = this.get(ownerId, id);
    if (!current || current.deletionState !== "active" || !current.trashedAt || current.purgeAt <= now) return null;
    this.database.prepare("UPDATE projects SET deleted_at=NULL,purge_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND deletion_state='active'")
      .run(now, id, ownerId);
    return this.get(ownerId, id);
  }
  due(now = Date.now()) {
    return this.database.prepare("SELECT * FROM projects WHERE purge_at IS NOT NULL AND purge_at<=? ORDER BY purge_at").all(now).map(parseRow);
  }
  async purge(ownerId, id, removeAssociatedData) {
    const current = this.get(ownerId, id);
    if (!current || !current.trashedAt || current.deletionState !== "active") return false;
    this.database.prepare("UPDATE projects SET deletion_state='purging' WHERE id=? AND owner_id=?").run(id, ownerId);
    try {
      await removeAssociatedData(current);
      this.database.prepare("DELETE FROM projects WHERE id=? AND owner_id=?").run(id, ownerId);
      return true;
    } catch (error) {
      this.database.prepare("UPDATE projects SET deletion_state='active' WHERE id=? AND owner_id=?").run(id, ownerId);
      throw error;
    }
  }
}
