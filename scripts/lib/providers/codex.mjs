// Strict Codex machine adapter: ephemeral, configuration-isolated, explicit native sandbox, and
// coordinator-bound AGENTS.md injection.
import { spawnSync } from 'node:child_process';
import { locateExecutable } from '../which.mjs';
import { flagPreflight } from '../provider-preflight.mjs';

export const id = 'codex';
export const displayName = 'Codex';
export const installHint = 'Install the Codex CLI (e.g. `brew install codex`) and run `codex login`.';

export function locate() {
  return locateExecutable('codex', ['/opt/homebrew/bin', '/usr/local/bin', '~/.codex/bin']);
}

export const pipelineRoles = Object.freeze(['build', 'phase', 'review', 'verify']);

export function pipelinePreflight(bin) {
  const flags = flagPreflight(bin, {
    helpArgs: ['exec', '--help'],
    requiredFlags: [
      '--config', '--strict-config', '--sandbox', '--cd', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--output-schema', '--output-last-message',
    ],
  });
  if (!flags.ok) return flags;

  // `--help` proves flags, but not whether this installed release recognizes the config keys that
  // suppress native AGENTS loading and pin network/approval policy. Add one deliberately unknown
  // key under --strict-config: a safe preflight must reject exactly that sentinel after accepting
  // every preceding required key, before auth or network initialization.
  const sentinel = 'handoff_capability_probe_unknown=true';
  const probe = spawnSync(bin, [
    'exec', '--strict-config', '--ignore-user-config',
    ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['--config', value]),
    '--config', sentinel,
    '--ephemeral', '-',
  ], {
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  if (probe.error || probe.status === 0 || !output.includes('handoff_capability_probe_unknown')) {
    return {
      ok: false,
      version: flags.version,
      reason: `installed CLI cannot prove required strict config support${probe.error ? `: ${probe.error.message}` : ''}`,
    };
  }
  return flags;
}

const CODEX_CONFIG_OVERRIDES = Object.freeze([
  'approval_policy="never"',
  'project_doc_max_bytes=0',
  'project_doc_fallback_filenames=[]',
  'project_root_markers=[".git"]',
  'sandbox_workspace_write.network_access=false',
]);

export function pipelinePolicy(role, coordinatorApproval = null) {
  const sandbox = role === 'build' || role === 'phase' ? 'workspace-write' : 'read-only';
  const policy = {
    enforcement: 'native-filesystem-sandbox',
    filesystem: sandbox,
    approvals: 'never',
    ephemeral: true,
    userConfiguration: 'ignored',
    projectRules: coordinatorApproval ? 'coordinator-approved-and-injected' : 'coordinator-approval-required',
    nativeFilesystemIsolation: true,
    nativeAgentsLoading: 'disabled-by-project_doc_max_bytes=0',
    execPolicyRules: 'ignored',
    network: 'blocked',
    coordinatorApprovalRequired: true,
  };
  if (coordinatorApproval) {
    policy.coordinatorApprovalId = coordinatorApproval.approvalId;
    policy.coordinatorApprovalIssuer = coordinatorApproval.issuer;
    policy.coordinatorApprovalScope = coordinatorApproval.scope;
    policy.coordinatorApprovalSubjectHash = coordinatorApproval.subjectHash;
    policy.agentsRulesDigest = coordinatorApproval.rulesDigest;
    policy.injectedAgentsRules = coordinatorApproval.rules.map((rule) => `${rule.source}:${rule.path}`);
    policy.agentsRulesCompleteness = 'repository rules driver-verified; external/global applicability coordinator-asserted';
  }
  return policy;
}

export function pipelineInvocation({ bin, role, cwd, model, schemaFile, lastMsgFile, coordinatorApproval }) {
  if (!coordinatorApproval) throw new Error('Codex pipeline invocation requires coordinator approval binding');
  const policy = pipelinePolicy(role, coordinatorApproval);
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
    ...CODEX_CONFIG_OVERRIDES.flatMap((value) => ['--config', value]),
    '--sandbox', policy.filesystem, '--cd', cwd,
    '--output-schema', schemaFile, '--output-last-message', lastMsgFile,
  ];
  if (model) args.push('--model', model);
  args.push('-');
  return { bin, args, stdin: 'prompt', resultSource: { type: 'file', path: lastMsgFile }, policy };
}
