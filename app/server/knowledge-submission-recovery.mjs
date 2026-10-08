import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
export const knowledgeIdempotencyLifetimeMs = 24 * 60 * 60_000;
export const knowledgeSubmitRecoveryLimit = 2;
export const submissionFingerprint = ({ queryText, request }) => createHash('sha256')
  .update(JSON.stringify({ queryText, request })).digest('hex');
const invalid = () => Object.assign(new Error('知识库私有恢复记录不可用'), { code: 'knowledge_recovery_state_failed' });

// Unlike the public lane marker, this file contains query text. Never use the
// shared OS temp directory. The caller selects an access-controlled runtime.
async function ensurePrivateDirectory(directory) {
  let created = false;
  try { await lstat(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(directory, { recursive: true, mode: 0o700 }); created = true; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  if (process.platform === 'win32') {
    const literal = `'${directory.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop';$d=${literal};$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;`
      + (created ? `& icacls.exe $d /grant:r ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /inheritance:r | Out-Null;if($LASTEXITCODE -ne 0){throw 'ACL initialization failed'};` : '')
      + `$acl=([System.IO.DirectoryInfo]$d).GetAccessControl();$allowed=@($sid,'S-1-5-18','S-1-5-32-544');foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Directory is not private'}};`;
    try { await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }); }
    catch { throw invalid(); }
  } else if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw invalid();
}

export function knowledgeSubmissionRecovery(directory, endpoint, laneIndex) {
  if (!directory) return null;
  const file = path.join(directory, `${createHash('sha256').update(endpoint).digest('hex')}.lane-${laneIndex}.json`);
  let ready;
  const prepare = () => ready ||= ensurePrivateDirectory(directory).catch(error => { ready = null; throw error; });
  let tail = Promise.resolve();
  const serial = worker => { const pending = tail.then(worker); tail = pending.catch(() => {}); return pending; };
  const load = async () => {
    await prepare();
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077)) throw invalid();
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.version !== 1 || record.owner !== 'luxury-itinerary-knowledge-recovery' || record.laneIndex !== laneIndex
        || typeof record.idempotencyKey !== 'string' || !Number.isFinite(record.submittedAt)
        || typeof record.cancelled !== 'boolean' || !Number.isInteger(record.recoveryAttempts) || record.recoveryAttempts < 0
        || !record.queryText || !record.request || record.requestHash !== submissionFingerprint(record)) throw invalid();
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw invalid(); }
  };
  const save = async record => {
    await prepare();
    const temporary = `${file}.${randomUUID()}.next`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, owner: 'luxury-itinerary-knowledge-recovery',
        consumers: ['automatic-images', 'manual-images'], retireWhen: 'Matching request rejection or remote terminal state verified', laneIndex, ...record }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch (error) { await unlink(temporary).catch(() => {}); throw invalid(); }
  };
  return {
    file,
    load: () => serial(load),
    save: record => serial(() => save(record)),
    cancel: key => serial(async () => { const record = await load(); if (record?.idempotencyKey === key) await save({ ...record, cancelled: true }); }),
    clear: key => serial(async () => {
      const record = await load();
      if (!record) return;
      if (record.idempotencyKey !== key) throw invalid();
      await unlink(file);
    }),
  };
}

export function canReplayKnowledgeSubmission(record, marker, now = Date.now()) {
  return Boolean(record && !record.cancelled && record.idempotencyKey === marker?.idempotencyKey
    && record.requestHash === marker?.requestHash && record.submittedAt === marker?.submittedAt
    && record.submittedAt <= now && now - record.submittedAt < knowledgeIdempotencyLifetimeMs - 60_000
    && record.recoveryAttempts < knowledgeSubmitRecoveryLimit);
}
