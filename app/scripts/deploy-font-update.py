"""Cloud install: python3 deploy-font-update.py --idle-confirmed
Requires the previously deployed auth build. Refuses unexpected versions.
Do not run while a generation/export job is active. Never reads credentials.
"""
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
target = Path('/opt/sheyou-demo')
manifest = json.loads((source / 'font-update-manifest.json').read_text())
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for relative, expected in manifest['expected'].items():
    if digest(target / relative) != expected:
        raise SystemExit('Existing deployment differs; no changes made: ' + relative)
for item in manifest['payload']:
    relative = Path(item['path'])
    if relative.is_absolute() or '..' in relative.parts or relative.parts[0] != 'app':
        raise SystemExit('Unsafe package path')
    if not str(relative).startswith(('app/dist/client/', 'app/server/')):
        raise SystemExit('Unexpected package scope')
    if digest(source / relative) != item['sha256']:
        raise SystemExit('Package hash mismatch: ' + str(relative))
backup = Path(tempfile.mkdtemp(prefix='font-update-backup-', dir='/opt/sheyou-demo-upload'))
for item in manifest['payload']:
    old = target / item['path']
    if old.exists():
        saved = backup / item['path']
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(old, saved)
print('Rollback backup:', backup, flush=True)
subprocess.run(['systemctl', 'stop', 'sheyou-demo'], check=True)
try:
    # Install entry HTML last, so clients never receive references before files.
    for item in sorted(manifest['payload'], key=lambda i: i['path'].endswith('/index.html')):
        dest = target / item['path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / item['path'], dest)
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
print('Installed. Sessions reset by restart. HTTP/2 and browser verification are separate steps.')
print('Manual rollback: stop service; copy backup/app contents back to /opt/sheyou-demo/app; start service.')
