"""Run on cloud only after confirming no generation/export is active."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if '--idle-confirmed' not in sys.argv:
    raise SystemExit('Confirm no generation/export is running, then pass --idle-confirmed')

source = Path(__file__).resolve().parent
target = Path('/opt/sheyou-demo').resolve()
manifest = json.loads((source / 'profile-modal-update-manifest.json').read_text())
digest = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()

def checked(base, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or not name.startswith('app/dist/client/'):
        raise SystemExit('Unexpected package path: ' + name)
    file = (base / relative).resolve()
    if not file.is_relative_to(base):
        raise SystemExit('Path leaves deployment: ' + name)
    return file

for name, expected in manifest['expected'].items():
    file = checked(target, name)
    if not file.is_file() or digest(file) != expected:
        raise SystemExit('Deployment differs; NOTHING changed: ' + name)

for item in manifest['payload']:
    source_file = checked(source, item['path'])
    if digest(source_file) != item['sha256']:
        raise SystemExit('Package hash mismatch: ' + item['path'])

backup = Path(tempfile.mkdtemp(prefix='profile-modal-update-backup-', dir='/opt/sheyou-demo-upload'))
for item in manifest['payload']:
    old = checked(target, item['path'])
    if old.exists():
        saved = backup / item['path']
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(old, saved)

print('Rollback backup:', backup, flush=True)
subprocess.run(['systemctl', 'stop', 'sheyou-demo'], check=True)
try:
    for item in sorted(manifest['payload'], key=lambda row: row['path'].endswith('/index.html')):
        dest = checked(target, item['path'])
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(checked(source, item['path']), dest)
        dest.chmod(0o644)
    subprocess.run(['systemctl', 'start', 'sheyou-demo'], check=True)
    time.sleep(2)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'sheyou-demo'], check=True)
    subprocess.run(['curl', '-fsS', '--max-time', '15', '-o', '/dev/null', 'http://127.0.0.1:4175/agent'], check=True)
except BaseException:
    for old in backup.rglob('*'):
        if old.is_file():
            shutil.copy2(old, target / old.relative_to(backup))
    subprocess.run(['systemctl', 'restart', 'sheyou-demo'], check=True)
    raise

print('Profile modal update installed. Log in again and verify the profile dialog.')
print('Rollback: stop sheyou-demo; restore backup/app into /opt/sheyou-demo/app; start sheyou-demo.')
