import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TTL_MS = 24 * 60 * 60 * 1000;

export function cacheKey(...parts) {
  return createHash("sha256").update(parts.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n")).digest("hex");
}

export async function createImageResearchCache(root) {
  const directory = path.join(root, "output", "image-cache");
  const file = path.join(directory, "research-cache.json");
  await mkdir(directory, { recursive: true });
  let records = {};
  try { records = JSON.parse(await readFile(file, "utf8")); } catch { records = {}; }
  let writes = Promise.resolve();
  const persist = () => { writes = writes.then(() => writeFile(file, JSON.stringify(records), "utf8")); return writes; };
  return {
    get(namespace, key) {
      const item = records[`${namespace}:${key}`];
      if (!item || Date.now() - item.savedAt > TTL_MS) return null;
      return structuredClone(item.value);
    },
    async set(namespace, key, value) {
      records[`${namespace}:${key}`] = { savedAt: Date.now(), value };
      await persist();
      return value;
    },
  };
}
