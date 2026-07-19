// Complete, byte-safe Git/worktree evidence for the strict machine API.
// Git output is consumed as NUL-delimited Buffers, so spaces and newlines in names are never split.
// Fingerprints cover HEAD, the index, tracked worktree bytes, untracked bytes, deletions and symlinks.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
} from 'node:fs';
import { sep } from 'node:path';

const MAX_GIT_OUTPUT = 128 * 1024 * 1024;

export class GitEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitEvidenceError';
  }
}

function gitBuffer(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: null,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return {
    code: result.status ?? 1,
    out: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    err: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    error: result.error,
  };
}

function checkedGit(cwd, args, label) {
  const result = gitBuffer(cwd, args);
  if (result.code !== 0 || result.error) {
    const detail = result.error?.message || result.err.toString('utf8').trim() || `exit ${result.code}`;
    throw new GitEvidenceError(`${label} failed: ${detail}`);
  }
  return result.out;
}

export function repositoryRoot(cwd) {
  const raw = checkedGit(cwd, ['rev-parse', '--show-toplevel'], 'git repository root');
  return raw.toString('utf8').replace(/[\r\n]+$/u, '');
}

function splitNul(buffer) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0) {
      parts.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts.filter((part) => part.length > 0);
}

function addField(hash, label, value) {
  const labelBytes = Buffer.from(label);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(labelBytes.length, 0);
  lengths.writeUInt32BE(bytes.length, 4);
  hash.update(lengths).update(labelBytes).update(bytes);
}

function fullPathBuffer(cwd, path) {
  return Buffer.concat([Buffer.from(cwd), Buffer.from(sep), path]);
}

function hashRegularFile(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, constants.O_RDONLY);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function inspectPath(cwd, path) {
  const full = fullPathBuffer(cwd, path);
  try {
    const stat = lstatSync(full);
    const mode = (stat.mode & 0o177777).toString(8);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(full, { encoding: 'buffer' });
      return { kind: 'symlink', mode, digest: createHash('sha256').update(target).digest('hex') };
    }
    if (stat.isFile()) return { kind: 'file', mode, digest: hashRegularFile(full) };
    if (stat.isDirectory()) return { kind: 'directory', mode, digest: '' };
    return { kind: 'other', mode, digest: `${stat.rdev}:${stat.size}` };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'deleted', mode: '', digest: '' };
    return { kind: 'unreadable', mode: '', digest: error?.code || 'error' };
  }
}

function pathText(path) {
  return path.toString('utf8');
}

function splitStatusHeader(record, fieldCount) {
  let spaces = 0;
  for (let index = 0; index < record.length; index++) {
    if (record[index] !== 32) continue;
    spaces += 1;
    if (spaces === fieldCount) {
      return {
        header: record.subarray(0, index).toString('ascii').split(' '),
        path: record.subarray(index + 1),
      };
    }
  }
  throw new GitEvidenceError('git status emitted a malformed porcelain-v2 record');
}

function parseStatus(cwd, raw) {
  const records = splitNul(raw);
  const changes = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const kind = String.fromCharCode(record[0]);
    if (kind === '?' || kind === '!') {
      const path = record.subarray(2);
      if (kind === '?') {
        const observed = inspectPath(cwd, path);
        changes.push({
          path: pathText(path), originalPath: null, tracked: false, untracked: true,
          staged: false, unstaged: true, deleted: false, renamed: false,
          symlink: observed.kind === 'symlink', indexStatus: '?', worktreeStatus: '?',
        });
      }
      continue;
    }

    const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 0;
    if (!fieldCount) throw new GitEvidenceError(`git status emitted unsupported record type '${kind}'`);
    const split = splitStatusHeader(record, fieldCount);
    const header = split.header;
    const path = split.path;
    const xy = header[1] || '..';
    const indexStatus = xy[0] || '.';
    const worktreeStatus = xy[1] || '.';
    let originalPath = null;
    if (kind === '2') {
      const original = records[++index];
      if (!original) throw new GitEvidenceError('git status omitted the original rename path');
      originalPath = pathText(original);
    }
    const observed = inspectPath(cwd, path);
    const statusModes = kind === 'u' ? header.slice(3, 7) : header.slice(3, 6);
    changes.push({
      path: pathText(path), originalPath, tracked: true, untracked: false,
      staged: indexStatus !== '.', unstaged: worktreeStatus !== '.',
      deleted: indexStatus === 'D' || worktreeStatus === 'D',
      renamed: kind === '2' || indexStatus === 'R' || worktreeStatus === 'R',
      // Preserve symlink evidence from HEAD/index/worktree modes even when the current worktree
      // object has already been replaced by a regular file (or deleted).
      symlink: statusModes.includes('120000') || observed.kind === 'symlink',
      indexStatus, worktreeStatus,
    });
  }
  return changes;
}

function summarizeChanges(changes) {
  return {
    tracked: changes.filter((entry) => entry.tracked).length,
    staged: changes.filter((entry) => entry.staged).length,
    unstaged: changes.filter((entry) => entry.unstaged && !entry.untracked).length,
    untracked: changes.filter((entry) => entry.untracked).length,
    deleted: changes.filter((entry) => entry.deleted).length,
    renamed: changes.filter((entry) => entry.renamed).length,
    symlink: changes.filter((entry) => entry.symlink).length,
  };
}

export function isRepo(cwd) {
  const result = gitBuffer(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.code === 0 && result.out.toString('utf8').trim() === 'true';
}

export function assertRepo(cwd) {
  if (!isRepo(cwd)) throw new GitEvidenceError(`--cwd '${cwd}' is not a Git worktree`);
}

export function gitFingerprint(cwd) {
  assertRepo(cwd);
  const root = repositoryRoot(cwd);
  const headResult = gitBuffer(root, ['rev-parse', '--verify', 'HEAD']);
  const head = headResult.code === 0 ? headResult.out.toString('utf8').trim() : null;
  const statusRaw = checkedGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--renames'], 'git status');
  const indexRaw = checkedGit(root, ['ls-files', '--stage', '-z'], 'git index listing');
  const paths = splitNul(checkedGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 'git worktree listing'))
    .sort(Buffer.compare);
  const changes = parseStatus(root, statusRaw);
  const hash = createHash('sha256');
  addField(hash, 'schema', 'handoff.git-fingerprint.v0.2');
  addField(hash, 'head', head || 'UNBORN');
  addField(hash, 'index', indexRaw);
  addField(hash, 'status', statusRaw);

  const fileState = new Map();
  for (const path of paths) {
    const observed = inspectPath(root, path);
    addField(hash, 'path', path);
    addField(hash, 'kind', observed.kind);
    addField(hash, 'mode', observed.mode);
    addField(hash, 'content', observed.digest);
    fileState.set(path.toString('base64'), `${observed.kind}:${observed.mode}:${observed.digest}`);
  }

  const fingerprint = {
    schemaVersion: 'handoff.git-fingerprint.v0.2',
    algorithm: 'sha256',
    digest: `sha256:${hash.digest('hex')}`,
    head,
    entryCount: paths.length,
    changeCounts: summarizeChanges(changes),
    changes,
  };
  Object.defineProperty(fingerprint, '_fileState', { value: fileState, enumerable: false });
  return fingerprint;
}

export function compareGitFingerprints(before, after) {
  const keys = new Set([...(before?._fileState?.keys() || []), ...(after?._fileState?.keys() || [])]);
  const files = [];
  for (const key of keys) {
    if (before._fileState.get(key) !== after._fileState.get(key)) {
      files.push(Buffer.from(key, 'base64').toString('utf8'));
    }
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const statusPaths = new Set([
    ...(before?.changes || []).flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)),
    ...(after?.changes || []).flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)),
  ]);
  if (before?.digest !== after?.digest) {
    for (const path of statusPaths) if (!files.includes(path)) files.push(path);
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return { changed: before?.digest !== after?.digest, files };
}
