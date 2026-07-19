// Strict Kiro review adapter. Only fs_read is exposed; build/phase are not advertised.
import { locateExecutable } from '../which.mjs';
import { flagPreflight } from '../provider-preflight.mjs';

export const id = 'kiro';
export const displayName = 'Kiro';
export const installHint = 'Install the Kiro CLI (`kiro-cli`) and authenticate it.';

export function locate() {
  return locateExecutable('kiro-cli', ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
}

export const pipelineRoles = Object.freeze(['review', 'verify']);

export function pipelinePreflight(bin) {
  return flagPreflight(bin, {
    helpArgs: ['chat', '--help'],
    requiredFlags: ['--no-interactive', '--trust-tools', '--wrap'],
  });
}

export function pipelinePolicy(role) {
  if (!pipelineRoles.includes(role)) throw new Error(`Kiro pipeline role '${role}' is unsupported`);
  return {
    enforcement: 'tool-permission-allowlist',
    filesystem: 'permission-only',
    nativeFilesystemIsolation: false,
    toolAllowlist: ['fs_read'],
  };
}

export function pipelineInvocation({ bin, role, model, effort }) {
  const policy = pipelinePolicy(role);
  const args = ['chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return { bin, args, stdin: 'prompt', resultSource: { type: 'stdout' }, policy };
}
