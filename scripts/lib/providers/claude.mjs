import { spawnSync } from 'node:child_process';

import { ContractError, decodeUtf8 } from '../contracts.mjs';
import { flagPreflight } from '../provider-preflight.mjs';
import { locateExecutable } from '../which.mjs';

export const id = 'claude';
export const displayName = 'Claude';
export const installHint = 'Install Claude Code (`npm i -g @anthropic-ai/claude-code`) and provide non-interactive authentication.';
export const pipelineRoles = Object.freeze(['build', 'phase', 'review', 'verify']);

const MAX_TURNS = 12;
const EMPTY_MCP = JSON.stringify({ mcpServers: {} });
const BUILD_TOOLS = Object.freeze(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
const REVIEW_TOOLS = Object.freeze(['Glob', 'Grep', 'Read']);

function writable(role) {
  return role === 'build' || role === 'phase';
}

function toolsFor(role) {
  return writable(role) ? BUILD_TOOLS : REVIEW_TOOLS;
}

function settingsJson() {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] },
      network: { allowedDomains: [] },
    },
  });
}

export function locate() {
  return locateExecutable('claude', ['~/.local/bin', '~/.claude/local', '/opt/homebrew/bin', '/usr/local/bin']);
}

export function pipelinePreflight(bin) {
  const flags = flagPreflight(bin, {
    helpArgs: ['--help'],
    requiredFlags: [
      '--allowedTools', '--bare', '--disable-slash-commands', '--json-schema',
      '--mcp-config', '--no-chrome', '--no-session-persistence', '--output-format', '--permission-mode',
      '--safe-mode', '--settings', '--strict-mcp-config', '--tools',
    ],
  });
  if (!flags.ok) return flags;

  // Claude's official reference says --help is intentionally incomplete, so --max-turns is proved
  // here rather than by help text. Invalid schema parsing is a local, authentication-free proof that
  // this release accepted the complete strict invocation surface. Sandbox availability is then
  // fail-closed at run startup.
  const probe = spawnSync(bin, [
    '--bare', '--safe-mode', '--settings', settingsJson(), '--strict-mcp-config', '--mcp-config', EMPTY_MCP,
    '--disable-slash-commands', '--no-session-persistence', '--permission-mode', 'dontAsk',
    '--tools', 'Read', '--allowedTools', 'Read', '--max-turns', '1', '-p', '--output-format', 'json',
    '--json-schema', 'handoff-invalid-json',
  ], {
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  if (probe.error || probe.status === 0 || !/json-schema.{0,200}(invalid|JSON)/iu.test(output)) {
    return {
      ok: false,
      version: flags.version,
      reason: `installed CLI cannot prove bare-mode structured-result enforcement${probe.error ? `: ${probe.error.message}` : ''}`,
    };
  }
  return flags;
}

export function pipelinePolicy(role) {
  const canWrite = writable(role);
  return {
    enforcement: canWrite ? 'native-bash-sandbox-plus-file-tool-permissions' : 'read-only-tool-allowlist',
    filesystem: canWrite ? 'project-write-by-default; managed policy remains authoritative' : 'read-only-tool-surface',
    approvals: 'never (dontAsk)',
    ephemeral: true,
    userConfiguration: 'disabled by bare and safe modes',
    managedConfiguration: 'honored by Claude Code',
    projectRules: 'disabled by bare mode',
    // Claude documents the native sandbox as a Bash/child-process boundary. Built-in file tools
    // remain permission-controlled, so the provider run as a whole is not labeled OS-isolated.
    nativeFilesystemIsolation: false,
    nativeBashSandbox: canWrite,
    fileToolConfinement: canWrite ? 'permission-controlled file tools; managed policy may alter effective scope' : 'no edit, write, or bash tool exposed',
    toolAllowlist: [...toolsFor(role)],
    webSearch: false,
    subagents: false,
    memory: false,
    maxTurns: MAX_TURNS,
    network: canWrite ? 'Bash child network denied unless managed policy permits domains; provider API remains reachable' : 'no network-capable tool exposed',
    structuredResult: 'native JSON Schema in Claude JSON envelope',
  };
}

export function pipelineInvocation({ bin, role, model, effort, schemaJson }) {
  const policy = pipelinePolicy(role);
  const tools = policy.toolAllowlist.join(',');
  const args = [
    '--bare', '--safe-mode', '--settings', settingsJson(),
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP,
    '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    '--permission-mode', 'dontAsk', '--tools', tools, '--allowedTools', tools,
    '--max-turns', String(MAX_TURNS), '-p', '--output-format', 'json', '--json-schema', schemaJson,
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return { bin, args, stdin: 'prompt', resultSource: { type: 'stdout' }, policy };
}

function observedUsage(envelope) {
  const source = envelope?.usage;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const inputTokens = source.input_tokens ?? source.inputTokens;
  const outputTokens = source.output_tokens ?? source.outputTokens;
  if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) return null;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export function pipelineExtractResult(raw) {
  let envelope;
  const text = decodeUtf8(raw, 'Claude output', 'invalid_provider_output');
  try { envelope = JSON.parse(text); }
  catch { throw new ContractError('Claude output must be exactly one JSON envelope', 'invalid_provider_output'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.is_error === true) {
    throw new ContractError('Claude returned a malformed or error result envelope', 'invalid_provider_output');
  }
  if (!envelope.structured_output || typeof envelope.structured_output !== 'object' || Array.isArray(envelope.structured_output)) {
    throw new ContractError('Claude result envelope is missing structured_output', 'invalid_provider_output');
  }
  const usage = observedUsage(envelope);
  return {
    bytes: Buffer.from(JSON.stringify(envelope.structured_output)),
    usage,
    usageSource: usage ? 'provider-envelope' : null,
  };
}

export function pipelineRuntimeCheck({ stdout, stderr }) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  if (/sandbox.{0,200}(failed|unable|unavailable|unsupported|continu(e|ing) without|could not be applied)/iu.test(text)) {
    return { ok: false, reason: 'Claude reported that its required Bash sandbox was not enforced' };
  }
  return { ok: true, reason: null };
}
