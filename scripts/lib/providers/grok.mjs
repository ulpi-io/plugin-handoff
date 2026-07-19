// Strict Grok machine adapter: exact named sandbox, bounded turns, disabled web/subagents/memory,
// and native JSON Schema output.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { locateExecutable } from '../which.mjs';
import { flagPreflight } from '../provider-preflight.mjs';

export const id = 'grok';
export const displayName = 'Grok';
export const installHint = 'Install the Grok CLI and authenticate (`grok models` should list models when logged in).';
const PREFLIGHT_PROMPT = fileURLToPath(import.meta.url);

export function locate() {
  return locateExecutable('grok', ['~/.grok/bin', '/opt/homebrew/bin', '/usr/local/bin']);
}

export const pipelineRoles = Object.freeze(['build', 'phase', 'review', 'verify']);

export function pipelinePreflight(bin) {
  const flags = flagPreflight(bin, {
    helpArgs: ['--help'],
    requiredFlags: [
      '--cwd', '--disable-web-search', '--json-schema', '--max-turns', '--no-memory',
      '--no-subagents', '--permission-mode', '--prompt-file', '--sandbox',
    ],
  });
  if (!flags.ok) return flags;

  for (const profile of ['workspace', 'read-only']) {
    // Invalid JSON forces a deterministic local parse failure after named-sandbox initialization,
    // without auth or network. Passing requires proof that this exact profile can initialize and
    // that the installed CLI reached its structured-result parser.
    const probe = spawnSync(bin, [
      '--sandbox', profile,
      '--prompt-file', PREFLIGHT_PROMPT,
      '--json-schema', 'handoff-invalid-json',
    ], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    const sandboxFailure = /sandbox.{0,160}(failed|unable|unavailable|unsupported|not (applied|enforced)|could not be applied|refusing to start)/iu.test(output);
    const structuredFailure = /json-schema.{0,160}invalid JSON/iu.test(output);
    if (probe.error || probe.status === 0 || sandboxFailure || !structuredFailure) {
      return {
        ok: false,
        version: flags.version,
        reason: `installed CLI cannot prove '${profile}' sandbox plus structured-result enforcement${probe.error ? `: ${probe.error.message}` : ''}`,
      };
    }
  }
  return flags;
}

export function pipelinePolicy(role) {
  const writable = role === 'build' || role === 'phase';
  return {
    enforcement: 'native-named-sandbox',
    sandboxProfile: writable ? 'workspace' : 'read-only',
    filesystem: writable ? 'workspace-write' : 'read-only',
    nativeFilesystemIsolation: true,
    permissionMode: writable ? 'auto' : 'plan',
    webSearch: false,
    subagents: false,
    memory: false,
    maxTurns: 12,
    network: writable ? 'sandbox-profile-default' : 'blocked-for-children-on-supported-linux-only',
    readScope: 'provider-profile-defined-and-broader-than-cwd',
    writableLocations: writable ? ['cwd', 'provider-state', 'temporary-directories'] : ['provider-state', 'temporary-directories'],
  };
}

export function pipelineInvocation({ bin, role, cwd, promptFile, model, effort, schemaJson }) {
  const policy = pipelinePolicy(role);
  const args = [
    '--prompt-file', promptFile,
    '--cwd', cwd,
    '--sandbox', policy.sandboxProfile,
    '--permission-mode', policy.permissionMode,
    '--disable-web-search', '--no-subagents', '--no-memory',
    '--max-turns', String(policy.maxTurns),
    '--json-schema', schemaJson,
    '--verbatim',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return { bin, args, stdin: 'none', resultSource: { type: 'stdout' }, policy };
}

export function pipelineRuntimeCheck({ stderr }) {
  const text = String(stderr || '');
  if (/sandbox.{0,160}(failed|unable|unavailable|unsupported|not (applied|enforced)|could not be applied|refusing to start|continu(e|ing) without)/iu.test(text)) {
    return { ok: false, reason: 'Grok reported that its requested sandbox was not enforced' };
  }
  return { ok: true, reason: null };
}
