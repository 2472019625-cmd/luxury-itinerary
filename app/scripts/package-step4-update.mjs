// Incremental package against the font update already installed online. No fonts/data/secrets.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const destination = path.resolve(root, '../demo-access');
const base = path.join(destination, 'sheyou-font-update-jzDTnr');
const stage = mkdtempSync(path.join(destination, 'sheyou-step4-update-'));
const hash = content => createHash('sha256').update(content).digest('hex');
const files = new Set(['app/server/simple-manual-images.mjs', 'app/server/agent-planner-app.mjs', 'app/dist/client/index.html']);
const expected = {};
for (const name of ['app/server/agent-planner-app.mjs', 'app/dist/client/index.html']) expected[name] = hash(readFileSync(path.join(base, name)));
const deployedManifest = JSON.parse(readFileSync(path.join(destination, 'sheyou-release-z0FUlX/manifest.json')));
expected['app/server/simple-manual-images.mjs'] = deployedManifest.files.find(item => item.path === 'app/server/simple-manual-images.mjs').sha256;
const queue = ['app/dist/client/index.html'];
while (queue.length) {
  const file = queue.shift();
  for (const match of readFileSync(path.join(root, file), 'utf8').matchAll(/(?:\/assets\/|\.\/)([A-Za-z0-9_.-]+\.(?:js|css))/g)) {
    const next = 'app/dist/client/assets/' + match[1];
    if (files.has(next) || expected[next]) continue;
    let previous;
    try { previous = readFileSync(path.join(base, next)); } catch {}
    if (previous && hash(previous) === hash(readFileSync(path.join(root, next)))) expected[next] = hash(previous);
    else { files.add(next); queue.push(next); }
  }
}
const payload = [];
for (const file of files) {
  const target = path.join(stage, file);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, file), target);
  payload.push({ path: file, sha256: hash(readFileSync(target)) });
}
writeFileSync(path.join(stage, 'step4-update-manifest.json'), JSON.stringify({ expected, payload }, null, 2));
copyFileSync(path.join(root, 'app/scripts/deploy-step4-update.py'), path.join(stage, 'deploy-step4-update.py'));
const archive = stage + '.tar.gz';
execFileSync('tar', ['-czf', archive, '-C', stage, '.']);
console.log(JSON.stringify({ archive, sha256: hash(readFileSync(archive)), bytes: readFileSync(archive).length, files: payload.map(item => item.path) }, null, 2));
