import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "public", "fonts", "web");
const cssFile = path.join(root, "src", "web-fonts.css");
const manifestFile = path.join(outputDir, "manifest.json");
const instructions = "Run `python -m pip install -r requirements-web-fonts.txt` and `npm run build:web-fonts` first.";

try {
  assert.ok(existsSync(cssFile), `Missing generated file: src/web-fonts.css. ${instructions}`);
  assert.ok(existsSync(manifestFile), `Missing generated file: public/fonts/web/manifest.json. ${instructions}`);

  const css = readFileSync(cssFile, "utf8");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  assert.ok(Array.isArray(manifest) && manifest.length === 17, "Web font manifest must contain the 17 configured font faces.");

  const expected = new Set();
  for (const face of manifest) {
    assert.ok(face.family && face.weight && Array.isArray(face.shards) && face.shards.length, "Invalid web font manifest entry.");
    for (const shard of face.shards) {
      assert.match(shard.file, /^[A-Za-z0-9-]+(?:-\d+)?\.[a-f0-9]{16}\.woff2$/);
      assert.ok(!expected.has(shard.file), `Duplicate web font shard: ${shard.file}`);
      expected.add(shard.file);
      const file = path.join(outputDir, shard.file);
      assert.ok(existsSync(file), `Missing generated web font: ${shard.file}. ${instructions}`);
      assert.equal(statSync(file).size, shard.bytes, `Generated web font size differs from manifest: ${shard.file}`);
      assert.ok(css.includes(`/fonts/web/${shard.file}`), `Generated CSS does not reference: ${shard.file}`);
    }
  }

  const cssFiles = new Set([...css.matchAll(/\/fonts\/web\/([^"')]+\.woff2)/g)].map(match => match[1]));
  assert.deepEqual(cssFiles, expected, "Generated CSS and font manifest reference different shards.");
  assert.equal((css.match(/font-display:\s*swap/g) || []).length, manifest.length === 17 ? expected.size : 0, "Every generated font face must use font-display: swap.");

  for (const license of ["FangYaSong-License.txt", "Poppins-OFL.txt", "SourceHanSansCN-LICENSE.txt", "SourceHanSerifCN-LICENSE.txt"]) {
    assert.ok(existsSync(path.join(outputDir, license)), `Missing generated font license: ${license}. ${instructions}`);
  }

  console.log(`Web fonts ready: ${manifest.length} faces, ${expected.size} shards.`);
} catch (error) {
  console.error(`Web font check failed: ${error.message}`);
  process.exitCode = 1;
}
