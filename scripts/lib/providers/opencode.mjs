import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContractError, decodeUtf8 } from '../contracts.mjs';
import { flagPreflight } from '../provider-preflight.mjs';
import { locateExecutable } from '../which.mjs';

export const id = 'opencode';
export const displayName = 'OpenCode';
export const installHint = 'Install OpenCode and configure a provider (`opencode auth login`).';
export const pipelineRoles = Object.freeze(['build', 'phase', 'review', 'verify']);

const ORIGINAL_DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');

function writable(role) {
  return role === 'build' || role === 'phase';
}

function agentName(role) {
  return writable(role) ? 'handoff_strict_writer_v03' : 'handoff_strict_reader_v03';
}

function permissions(role) {
  const value = {
    '*': 'deny',
    bash: 'deny',
    edit: writable(role) ? 'allow' : 'deny',
    external_directory: 'deny',
    glob: 'allow',
    grep: 'allow',
    lsp: 'deny',
    question: 'deny',
    read: 'allow',
    skill: 'deny',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
  };
  return value;
}

function inlineConfig(role) {
  const name = agentName(role);
  return {
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    subagent_depth: 0,
    instructions: [],
    mcp: {},
    plugin: [],
    permission: permissions(role),
    agent: {
      [name]: {
        description: 'Handoff strict machine agent',
        mode: 'primary',
        permission: permissions(role),
      },
    },
  };
}

function isolatedEnvironment(role, root, { preserveAuth = true } = {}) {
  const home = join(root, 'home');
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  const state = join(root, 'state');
  const data = preserveAuth ? ORIGINAL_DATA_HOME : join(root, 'data');
  for (const path of [home, config, cache, state, data]) mkdirSync(path, { recursive: true });
  return {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: data,
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig(role)),
    OPENCODE_PERMISSION: JSON.stringify(permissions(role)),
    OPENCODE_PURE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_AUTO_SHARE: 'false',
    OPENCODE_ENABLE_EXA: 'false',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
}

export function locate() {
  return locateExecutable('opencode', ['~/.opencode/bin', '~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function proveResolvedPolicy(bin, role, cwd, version, preserveAuth) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-opencode-preflight-'));
  try {
    const env = isolatedEnvironment(role, root, { preserveAuth });
    const probe = spawnSync(bin, ['--pure', 'debug', 'config'], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
    });
    if (probe.error || probe.status !== 0) {
      return { ok: false, version, reason: `resolved-policy probe failed: ${probe.error?.message || `exit ${probe.status ?? 1}`}` };
    }
    let resolved;
    try { resolved = JSON.parse(probe.stdout); }
    catch { return { ok: false, version, reason: 'resolved-policy probe did not return one JSON configuration object' }; }
    const agent = resolved?.agent?.[agentName(role)];
    const extensionsDisabled = sameJson(resolved?.instructions ?? [], [])
      && sameJson(resolved?.mcp ?? {}, {})
      && sameJson(resolved?.plugin ?? [], []);
    if (!agent || agent.mode !== 'primary' || agent.tools !== undefined
      || !sameJson(resolved?.permission, permissions(role))
      || !sameJson(agent.permission, permissions(role))
      || resolved?.share !== 'disabled'
      || resolved?.snapshot !== false
      || !extensionsDisabled) {
      return { ok: false, version, reason: `installed CLI cannot prove the exact ${role} permission policy` };
    }
    return { ok: true, version, reason: null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function pipelinePreflight(bin, { cwd = process.cwd(), role = null, roles = null } = {}) {
  const globalFlags = flagPreflight(bin, {
    helpArgs: ['--help'],
    requiredFlags: ['--pure'],
  });
  if (!globalFlags.ok) return globalFlags;
  const runHelp = spawnSync(bin, ['run', '--help'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  const help = `${runHelp.stdout || ''}\n${runHelp.stderr || ''}`;
  const missing = ['--agent', '--dir', '--format'].filter((flag) => !help.includes(flag));
  if (runHelp.error || runHelp.status !== 0 || missing.length) {
    return {
      ok: false,
      version: globalFlags.version,
      reason: runHelp.error
        ? `capability probe failed: ${runHelp.error.message}`
        : missing.length ? `installed CLI lacks required flag(s): ${missing.join(', ')}` : `capability probe failed: exit ${runHelp.status}`,
    };
  }
  const checkedRoles = role ? [role] : [...new Set((roles || pipelineRoles).map((entry) => writable(entry) ? 'build' : 'review'))];
  for (const checkedRole of checkedRoles) {
    const proof = proveResolvedPolicy(bin, checkedRole, cwd, globalFlags.version, Boolean(role));
    if (!proof.ok) return proof;
  }
  return globalFlags;
}

export function pipelinePolicy(role) {
  const canWrite = writable(role);
  return {
    enforcement: 'preflighted-tool-permission-policy',
    filesystem: canWrite ? 'permission-scoped-workspace-edit' : 'read-only-tool-surface',
    approvals: 'none; every unlisted permission is denied',
    ephemeral: false,
    userConfiguration: 'isolated with temporary HOME and XDG config roots',
    managedConfiguration: 'effective global and named-agent permissions plus extension shutdown verified before execution',
    projectRules: 'project configuration disabled; prompt carries the request contract',
    nativeFilesystemIsolation: false,
    fileToolConfinement: canWrite ? 'OpenCode edit permission with external_directory denied' : 'edit and bash denied',
    toolAllowlist: canWrite ? ['edit', 'glob', 'grep', 'read'] : ['glob', 'grep', 'read'],
    webSearch: false,
    subagents: false,
    memory: false,
    network: 'provider API only; web tools and bash denied',
    structuredResult: 'driver-normalized from strict raw JSON events',
    providerState: 'authentication and session data remain in the provider data directory',
  };
}

export function pipelineInvocation({ bin, role, cwd, tempRoot, model, effort }) {
  const policy = pipelinePolicy(role);
  const args = ['--pure', 'run', '--agent', agentName(role), '--dir', cwd, '--format', 'json'];
  if (model) args.push('--model', model);
  if (effort) args.push('--variant', effort);
  return {
    bin,
    args,
    env: isolatedEnvironment(role, join(tempRoot, 'opencode')),
    stdin: 'prompt',
    resultSource: { type: 'stdout' },
    policy,
  };
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function pipelineExtractResult(raw) {
  const text = decodeUtf8(raw, 'OpenCode output', 'invalid_provider_output');
  const physical = text.split(/\r?\n/u);
  if (physical.at(-1) === '') physical.pop();
  if (!physical.length || physical.some((line) => !line.trim())) {
    throw new ContractError('OpenCode output must be a non-empty raw JSON event stream', 'invalid_provider_output');
  }
  const allowed = new Set(['error', 'reasoning', 'step_finish', 'step_start', 'text', 'tool_use']);
  let sessionID = null;
  let finalText = null;
  let usageComplete = true;
  let usageSteps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of physical) {
    let event;
    try { event = JSON.parse(line); }
    catch { throw new ContractError('OpenCode raw event stream contains non-JSON noise', 'invalid_provider_output'); }
    if (!plainObject(event) || !allowed.has(event.type) || typeof event.sessionID !== 'string' || !event.sessionID) {
      throw new ContractError('OpenCode raw event stream contains a malformed event', 'invalid_provider_output');
    }
    if (sessionID !== null && event.sessionID !== sessionID) {
      throw new ContractError('OpenCode raw event stream crossed session boundaries', 'invalid_provider_output');
    }
    sessionID = event.sessionID;
    if (event.type === 'error') throw new ContractError('OpenCode emitted an error event', 'invalid_provider_output');
    if (event.type === 'text') {
      if (!plainObject(event.part) || event.part.type !== 'text' || typeof event.part.text !== 'string') {
        throw new ContractError('OpenCode emitted a malformed text event', 'invalid_provider_output');
      }
      finalText = event.part.text;
    }
    if (event.type === 'step_finish') {
      usageSteps += 1;
      const tokens = event.part?.tokens;
      if (!plainObject(tokens)
        || !Number.isInteger(tokens.input) || tokens.input < 0
        || !Number.isInteger(tokens.output) || tokens.output < 0) {
        usageComplete = false;
      } else {
        inputTokens += tokens.input;
        outputTokens += tokens.output;
      }
    }
  }
  if (finalText === null) throw new ContractError('OpenCode raw event stream is missing a final text event', 'invalid_provider_output');
  const usage = usageSteps > 0 && usageComplete
    ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
    : null;
  return { bytes: Buffer.from(finalText.trim()), usage, usageSource: usage ? 'provider-envelope' : null };
}
