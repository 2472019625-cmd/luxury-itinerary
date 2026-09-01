import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeImageLedger(directory, id, payload) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}-image-sources.json`);
  await writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), ...payload }, null, 2), "utf8");
  return file;
}
