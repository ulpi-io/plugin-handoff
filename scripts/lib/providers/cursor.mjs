import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ContractError, decodeUtf8 } from '../contracts.mjs';
import { flagPreflight } from '../provider-preflight.mjs';
import { locateExecutable } from '../which.mjs';

export const id = 'cursor';
export const displayName = 'Cursor';
export const installHint = 'Install Cursor CLI and authenticate (`cursor-agent login`).';
export const pipelineRoles = Object.freeze(['build', 'phase', 'review', 'verify']);

function writable(role) {
  return role === 'build' || role === 'phase';
}

export function locate() {
  return locateExecutable('cursor-agent', ['~/.local/bin', '~/.cursor/bin', '/opt/homebrew/bin', '/usr/local/bin']);
}

function proveSandbox(bin, cwd, version, canWrite) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-cursor-preflight-'));
  const target = join(cwd, `.handoff-cursor-target-probe-${randomUUID()}`);
  const script = [
    "const fs = require('node:fs');",
    "const targetDir = process.argv[1];",
    "const target = process.argv[2];",
    "let targetRead = false; let targetWrite = false;",
    "try { process.chdir(targetDir); fs.readdirSync('.'); targetRead = true; } catch {}",
    "try { fs.writeFileSync(target, 'probe'); targetWrite = true; } catch {}",
    "process.stdout.write(JSON.stringify({ targetRead, targetWrite }));",
  ].join(' ');
  try {
    const probe = spawnSync(bin, [
      'sandbox', 'run', '--sandbox', canWrite ? '--allow-paths' : '--readonly-paths', cwd,
      process.execPath, '-e', script, cwd, target,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HANDOFF_CURSOR_EXPECT_WRITE: canWrite ? '1' : '0',
        HANDOFF_CURSOR_SANDBOX_PROBE: '1',
        NO_COLOR: '1',
        TERM: 'dumb',
      },
    });
    let observed = null;
    try { observed = JSON.parse(probe.stdout); } catch { /* fail below */ }
    const targetExists = existsSync(target);
    if (probe.error || probe.status !== 0 || observed?.targetRead !== true
      || observed?.targetWrite !== canWrite || targetExists !== canWrite) {
      return {
        ok: false,
        version,
        reason: `installed CLI cannot prove ${canWrite ? 'writable' : 'read-only'} target-path sandbox enforcement${probe.error ? `: ${probe.error.message}` : ''}`,
      };
    }
    return { ok: true, version, reason: null };
  } finally {
    rmSync(target, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

export function pipelinePreflight(bin, { cwd = process.cwd(), role = null, roles = null } = {}) {
  const flags = flagPreflight(bin, {
    helpArgs: ['--help'],
    requiredFlags: ['--force', '--output-format', '--print'],
  });
  if (!flags.ok) return flags;
  if (cwd.includes(',')) {
    return { ok: false, version: flags.version, reason: 'Cursor sandbox path flags cannot safely encode a cwd containing a comma' };
  }
  const sandboxHelp = spawnSync(bin, ['sandbox', 'run', '--help'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  const help = `${sandboxHelp.stdout || ''}\n${sandboxHelp.stderr || ''}`;
  const missing = ['--allow-paths', '--network', '--readonly-paths', '--sandbox'].filter((flag) => !help.includes(flag));
  if (sandboxHelp.error || sandboxHelp.status !== 0 || missing.length) {
    return {
      ok: false,
      version: flags.version,
      reason: sandboxHelp.error
        ? `sandbox capability probe failed: ${sandboxHelp.error.message}`
        : missing.length ? `installed CLI lacks required sandbox flag(s): ${missing.join(', ')}` : `sandbox capability probe failed: exit ${sandboxHelp.status}`,
    };
  }
  const checkedRoles = role
    ? [role]
    : [...new Set((roles || pipelineRoles).map((entry) => writable(entry) ? 'build' : 'review'))];
  for (const checkedRole of checkedRoles) {
    const proof = proveSandbox(bin, cwd, flags.version, writable(checkedRole));
    if (!proof.ok) return proof;
  }
  return flags;
}

export function pipelinePolicy(role) {
  const canWrite = writable(role);
  return {
    enforcement: 'native-command-sandbox',
    filesystem: canWrite ? 'target-worktree-write' : 'target-worktree-read-only',
    approvals: canWrite ? 'force applies changes inside the sandbox' : 'force omitted',
    ephemeral: false,
    userConfiguration: 'isolated with temporary HOME and XDG roots',
    projectRules: 'provider-native rules may be read',
    nativeFilesystemIsolation: true,
    sandboxProfile: canWrite ? 'workspace_readwrite plus writable target path' : 'workspace_readwrite plus read-only target path',
    fileToolConfinement: canWrite ? 'target worktree is an explicit writable path' : 'target worktree is an explicit read-only path; mutation detection is defense in depth',
    network: 'enabled for the provider process and its sandboxed children',
    structuredResult: 'single Cursor JSON envelope containing one strict provider object',
    applyMode: canWrite ? 'force' : 'force-omitted-native-read-only',
    providerState: 'local HOME and XDG state are temporary; remote provider retention is provider-defined',
  };
}

export function pipelineInvocation({ bin, role, cwd, tempRoot, model }) {
  if (cwd.includes(',')) throw new Error('Cursor sandbox path flags cannot safely encode a cwd containing a comma');
  const policy = pipelinePolicy(role);
  const sandboxRoot = join(tempRoot, 'cursor-sandbox');
  const home = join(sandboxRoot, 'home');
  for (const path of [sandboxRoot, home, join(home, 'config'), join(home, 'cache'), join(home, 'state'), join(home, 'data')]) {
    mkdirSync(path, { recursive: true });
  }
  const nested = [bin, '-p', '--output-format', 'json'];
  if (writable(role)) nested.push('--force');
  if (model) nested.push('--model', model);
  const args = [
    'sandbox', 'run', '--sandbox', '--network',
    writable(role) ? '--allow-paths' : '--readonly-paths', cwd,
    '/usr/bin/env', '-C', cwd, ...nested,
  ];
  return {
    bin,
    args,
    cwd: sandboxRoot,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_DATA_HOME: join(home, 'data'),
    },
    stdin: 'prompt',
    resultSource: { type: 'stdout' },
    policy,
  };
}

export function pipelineExtractResult(raw) {
  let envelope;
  const text = decodeUtf8(raw, 'Cursor output', 'invalid_provider_output');
  try { envelope = JSON.parse(text); }
  catch { throw new ContractError('Cursor output must be exactly one JSON envelope', 'invalid_provider_output'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || envelope.type !== 'result' || envelope.subtype !== 'success' || envelope.is_error !== false
    || typeof envelope.result !== 'string') {
    throw new ContractError('Cursor returned a malformed or error result envelope', 'invalid_provider_output');
  }
  return { bytes: Buffer.from(envelope.result.trim()), usage: null, usageSource: null };
}

export function pipelineRuntimeCheck({ stdout, stderr }) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  if (/sandbox.{0,200}(failed|unable|unavailable|unsupported|continu(e|ing) without|could not be applied|disabled)/iu.test(text)) {
    return { ok: false, reason: 'Cursor reported that its requested command sandbox was not enforced' };
  }
  return { ok: true, reason: null };
}
