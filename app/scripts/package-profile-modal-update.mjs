import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const destination = path.resolve(root, '../demo-access');
const currentOnlineBase = path.join(destination, 'sheyou-step4-update-TEqCbO');
const stage = mkdtempSync(path.join(destination, 'sheyou-profile-modal-update-'));
const hash = content => createHash('sha256').update(content).digest('hex');

const files = new Set(['app/dist/client/index.html']);
const expected = {
  'app/dist/client/index.html': hash(readFileSync(path.join(currentOnlineBase, 'app/dist/client/index.html'))),
};

for (const match of readFileSync(path.join(root, 'app/dist/client/index.html'), 'utf8').matchAll(/\/assets\/(index-[A-Za-z0-9_.-]+\.(?:js|css))/g)) {
  files.add('app/dist/client/assets/' + match[1]);
}

const payload = [];
for (const file of files) {
  const source = path.join(root, file);
  const target = path.join(stage, file);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  payload.push({ path: file, sha256: hash(readFileSync(target)) });
}

writeFileSync(path.join(stage, 'profile-modal-update-manifest.json'), JSON.stringify({ expected, payload }, null, 2));
copyFileSync(path.join(root, 'app/scripts/deploy-profile-modal-update.py'), path.join(stage, 'deploy-profile-modal-update.py'));

const archive = stage + '.tar.gz';
execFileSync('tar', ['-czf', archive, '-C', stage, '.']);
console.log(JSON.stringify({ archive, sha256: hash(readFileSync(archive)), bytes: readFileSync(archive).length, files: payload.map(item => item.path) }, null, 2));
