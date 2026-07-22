// Strict Grok machine adapter: exact named sandbox, bounded turns, disabled web/subagents/memory,
// and native JSON Schema output.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ContractError,
  DEFAULT_MAX_TURNS,
  MAX_MAX_TURNS,
  MIN_MAX_TURNS,
  PROVIDER_OUTPUT_SCHEMA_VERSION_V03,
  decodeUtf8,
} from '../contracts.mjs';
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
      '--allow', '--cwd', '--deny', '--disable-web-search', '--json-schema', '--max-turns', '--no-memory',
      '--no-plan', '--no-subagents', '--permission-mode', '--prompt-file', '--sandbox', '--tools',
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

export function pipelinePolicy(role, maxTurns = DEFAULT_MAX_TURNS, webSearch = false, bash = role === 'build' || role === 'phase') {
  const writable = role === 'build' || role === 'phase';
  const toolAllowlist = [
    'Read', 'Grep',
    ...(writable ? ['Edit'] : []),
    ...(bash ? ['Bash'] : []),
    ...(webSearch ? ['WebSearch', 'WebFetch'] : []),
  ];
  const toolDenylist = [
    ...(!bash ? ['Bash(*)'] : []),
    ...(!writable ? ['Edit(*)'] : []),
    'MCPTool(*)',
    ...(webSearch ? [] : ['WebFetch(*)']),
  ];
  return {
    enforcement: 'native-named-sandbox',
    sandboxProfile: writable ? 'workspace' : 'read-only',
    filesystem: writable ? 'workspace-write' : 'read-only',
    nativeFilesystemIsolation: true,
    permissionMode: writable ? 'auto' : 'dontAsk',
    webSearch,
    webSearchConfigurable: true,
    subagents: false,
    memory: false,
    maxTurns,
    maxTurnsConfigurable: true,
    maxTurnsMinimum: MIN_MAX_TURNS,
    maxTurnsMaximum: MAX_MAX_TURNS,
    toolAllowlist,
    toolDenylist,
    network: webSearch
      ? 'provider web search and fetch enabled; child-network policy remains sandbox-profile-defined'
      : writable ? 'sandbox-profile-default' : 'blocked-for-children-on-supported-linux-only',
    readScope: 'provider-profile-defined-and-broader-than-cwd',
    writableLocations: writable ? ['cwd', 'provider-state', 'temporary-directories'] : ['provider-state', 'temporary-directories'],
  };
}

export function pipelineInvocation({ bin, role, cwd, promptFile, model, effort, schemaJson, maxTurns, webSearch, bash }) {
  const writable = role === 'build' || role === 'phase';
  const implicitGrantMode = bash === undefined;
  const policy = pipelinePolicy(role, maxTurns ?? DEFAULT_MAX_TURNS, webSearch ?? false, bash ?? writable);
  const args = [
    '--prompt-file', promptFile,
    '--cwd', cwd,
    '--sandbox', policy.sandboxProfile,
    '--permission-mode', policy.permissionMode,
    '--no-plan', '--no-subagents', '--no-memory',
    '--max-turns', String(policy.maxTurns),
    '--json-schema', schemaJson,
    '--verbatim',
  ];
  if (!policy.webSearch) args.push('--disable-web-search');
  if (!(implicitGrantMode && writable)) {
    args.push('--tools', policy.toolAllowlist.join(','));
    for (const rule of policy.toolDenylist) args.push('--deny', rule);
    if (policy.webSearch) args.push('--allow', 'WebFetch(*)');
  }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return { bin, args, stdin: 'none', resultSource: { type: 'stdout' }, policy };
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function observedUsage(envelope) {
  const source = envelope.usage;
  if (!plainObject(source)) return null;
  const uncachedInput = source.input_tokens ?? source.inputTokens;
  const cacheReadInput = source.cache_read_input_tokens ?? source.cacheReadInputTokens ?? 0;
  const outputTokens = source.output_tokens ?? source.outputTokens;
  const totalTokens = source.total_tokens ?? source.totalTokens;
  if (![uncachedInput, cacheReadInput, outputTokens, totalTokens].every((value) => Number.isInteger(value) && value >= 0)) {
    return null;
  }
  const inputTokens = uncachedInput + cacheReadInput;
  if (inputTokens + outputTokens !== totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

export function pipelineExtractResult(raw) {
  const text = decodeUtf8(raw, 'Grok output', 'invalid_provider_output');
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { throw new ContractError('Grok output must be exactly one JSON object', 'invalid_provider_output'); }

  // Preserve compatibility with Grok releases that emitted the schema object directly.
  if (plainObject(envelope) && envelope.schemaVersion === PROVIDER_OUTPUT_SCHEMA_VERSION_V03) {
    return { bytes: Buffer.from(text.trim()), usage: null, usageSource: null };
  }

  if (!plainObject(envelope)) {
    throw new ContractError('Grok returned a malformed JSON result envelope', 'invalid_provider_output');
  }
  const usage = observedUsage(envelope);
  // Grok 0.2.103 can report a structuredOutputError while retaining the complete model response
  // in text. Prefer the native projection when it exists, but independently validate the exact
  // text response downstream when that projection is absent. Prose, fences, and schema drift still
  // fail closed in parseProviderOutput.
  const candidate = plainObject(envelope.structuredOutput)
    ? JSON.stringify(envelope.structuredOutput)
    : typeof envelope.text === 'string' && envelope.text.trim()
      ? envelope.text
      : null;
  if (!candidate) {
    throw new ContractError('Grok result envelope has no candidate output', 'invalid_provider_output');
  }
  return {
    bytes: Buffer.from(candidate),
    usage,
    usageSource: usage ? 'provider-envelope' : null,
  };
}

export function pipelineRuntimeCheck({ stderr }) {
  const text = String(stderr || '');
  if (/sandbox.{0,160}(failed|unable|unavailable|unsupported|not (applied|enforced)|could not be applied|refusing to start|continu(e|ing) without)/iu.test(text)) {
    return { ok: false, reason: 'Grok reported that its requested sandbox was not enforced' };
  }
  return { ok: true, reason: null };
}
