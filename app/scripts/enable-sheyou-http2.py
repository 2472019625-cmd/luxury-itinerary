"""Run on the cloud host after reviewing the diff. Only the sheyou site changes.
Backs up its configuration, checks nginx syntax, and rolls back on failure.
"""
import difflib
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

site = Path('/etc/nginx/sites-available/sheyou-demo')
if not site.is_file() or site.is_symlink():
    raise SystemExit('Expected a regular sheyou-demo site file; no changes made')
old = site.read_text()
if 'server_name sheyou-ai.cn;' not in old:
    raise SystemExit('Unexpected site; no changes made')
version = subprocess.run(['nginx', '-V'], capture_output=True, text=True, check=True).stderr
if '--with-http_v2_module' not in version:
    raise SystemExit('HTTP/2 module absent; no changes made')
if re.search(r'listen\s+443\s+ssl\s+http2\s*;', old) or re.search(r'http2\s+on\s*;', old):
    raise SystemExit('HTTP/2 already configured; verify negotiated h2 in the browser')
new, count = re.subn(r'listen\s+443\s+ssl\s*;', 'listen 443 ssl http2;', old)
if count != 1:
    raise SystemExit('Expected exactly one HTTPS listen directive; no changes made')
print(''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile=str(site), tofile='proposed')))
backup = Path(tempfile.mkdtemp(prefix='font-http2-backup-', dir='/opt/sheyou-demo-upload'))
shutil.copy2(site, backup / site.name)
try:
    site.write_text(new)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except BaseException:
    shutil.copy2(backup / site.name, site)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
print('Configured HTTP/2. Backup:', backup)
print('Protocol negotiation and external browser timing still need verification.')
