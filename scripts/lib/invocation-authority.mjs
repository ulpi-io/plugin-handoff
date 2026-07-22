import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ContractError } from './contracts.mjs';

const AUTHORITY_SCHEMA = 'handoff.root-authority.v0.3';
const authorityDirectory = join(tmpdir(), `handoff-root-authority-${process.getuid?.() ?? 'user'}`);
const authorityPath = join(authorityDirectory, 'active.json');

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function ensurePrivateDirectory() {
  mkdirSync(authorityDirectory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(authorityDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new ContractError('Handoff root authority directory is not private');
  }
}

function readLease() {
  let stat;
  try { stat = lstatSync(authorityPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ContractError(`cannot inspect Handoff root authority: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
    throw new ContractError('Handoff root authority lease is unsafe');
  }
  let value;
  try { value = JSON.parse(readFileSync(authorityPath, 'utf8')); }
  catch { throw new ContractError('Handoff root authority lease is malformed'); }
  const keys = ['schemaVersion', 'pid', 'nonce', 'startedAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) throw new ContractError('Handoff root authority lease has unknown or missing fields');
  if (value.schemaVersion !== AUTHORITY_SCHEMA || !Number.isInteger(value.pid) || value.pid < 1 || typeof value.nonce !== 'string' || !value.nonce || typeof value.startedAt !== 'string') throw new ContractError('Handoff root authority lease is invalid');
  return value;
}

export function acquireRootInvocationAuthority() {
  ensurePrivateDirectory();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease = { schemaVersion: AUTHORITY_SCHEMA, pid: process.pid, nonce: randomBytes(32).toString('base64url'), startedAt: new Date().toISOString() };
    try {
      writeFileSync(authorityPath, `${JSON.stringify(lease)}\n`, { mode: 0o600, flag: 'wx' });
      let released = false;
      return {
        lease,
        release() {
          if (released) return;
          released = true;
          const observed = readLease();
          if (!observed || observed.pid !== lease.pid || observed.nonce !== lease.nonce) throw new ContractError('Handoff root authority changed before release');
          rmSync(authorityPath, { force: false });
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const active = readLease();
      if (active && processAlive(active.pid)) throw new ContractError(`another root Handoff is active in PID ${active.pid}`);
      rmSync(authorityPath, { force: false });
    }
  }
  throw new ContractError('could not acquire Handoff root authority');
}

export function assertFrontendInvocationAuthority({ nested, verb }) {
  if (nested && verb !== 'advice') throw new ContractError('an active Handoff worker may request nested advice only');
}

export function assertMachineInvocationAuthority() {
  const lease = readLease();
  if (!lease || lease.pid !== process.pid) throw new ContractError('the machine runner is reserved to the active root Handoff process');
}

export function authorityLeasePathForTests() { return authorityPath; }
