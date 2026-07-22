import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

export const DRIVER_VERSION = '0.4.0';
export const BUNDLE_VERSION = '0.4.0';
export const CAPABILITIES_SCHEMA_VERSION_V03 = 'handoff.capabilities.v0.3';
export const REQUEST_SCHEMA_VERSION_V03 = 'handoff.request.v0.3';
export const PROVIDER_OUTPUT_SCHEMA_VERSION_V03 = 'handoff.provider-output.v0.3';
export const RESULT_SCHEMA_VERSION_V03 = 'handoff.result.v0.3';
export const DAG_SCHEMA_VERSION_V03 = 'handoff.dag.v0.3';
export const MCP_SCHEMA_VERSION_V03 = 'handoff.mcp.v0.3';
export const COORDINATOR_APPROVAL_SCHEMA_VERSION_V03 = 'handoff.coordinator-approval.v0.3';
export const ROLES = Object.freeze(['build', 'phase', 'review', 'verify']);
export const PIPELINE_PROVIDERS = Object.freeze(['codex', 'grok', 'kiro', 'claude', 'opencode', 'cursor']);
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_TURNS = 12;
export const MIN_MAX_TURNS = 1;
export const MAX_MAX_TURNS = 100;
export const MAX_REQUEST_BYTES = 2_000_000;
export const MAX_PROVIDER_OUTPUT_BYTES = 256_000;
export const MAX_CAPTURE_BYTES = 1_048_576;
export const MAX_DIAGNOSTIC_BYTES = 8_192;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

const here = dirname(fileURLToPath(import.meta.url));
export const PROVIDER_OUTPUT_SCHEMA_PATH_V03 = resolve(here, '../../contracts/v0.3/provider-output.schema.json');
export const PROVIDER_OUTPUT_SCHEMA_V03 = JSON.parse(readFileSync(PROVIDER_OUTPUT_SCHEMA_PATH_V03, 'utf8'));

export class ContractError extends Error {
  constructor(message, code = 'invalid_contract') {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function decodeUtf8(value, where, code = 'invalid_contract') {
  try { return strictUtf8.decode(Buffer.isBuffer(value) ? value : Buffer.from(value)); }
  catch { throw new ContractError(`${where} is not valid UTF-8`, code); }
}

export function plainObject(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ContractError(`${where} must be a JSON object`);
  }
  return value;
}

export function exactKeys(value, allowed, required, where) {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ContractError(`${where} contains unknown field(s): ${unknown.join(', ')}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new ContractError(`${where} is missing required field(s): ${missing.join(', ')}`);
}

export function boundedString(value, where, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new ContractError(`${where} must be a string`);
  if (!allowEmpty && !value.trim()) throw new ContractError(`${where} must not be empty`);
  if (Buffer.byteLength(value) > max) throw new ContractError(`${where} exceeds ${max} bytes`);
  if (value.includes('\0')) throw new ContractError(`${where} contains NUL`);
  return value;
}

export function safeCliValue(value, where, max) {
  boundedString(value, where, max);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new ContractError(`${where} contains control characters`);
  if (value !== value.trim()) throw new ContractError(`${where} must not have leading or trailing whitespace`);
  if (value.startsWith('-')) throw new ContractError(`${where} must not be option-like`);
  return value;
}

function safeRepoRelativePath(value, where) {
  boundedString(value, where, 4096);
  if (isAbsolute(value)) throw new ContractError(`${where} must be repository-relative`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new ContractError(`${where} contains control characters`);
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ContractError(`${where} contains an unsafe path segment`);
  }
  const root = resolve('/handoff-root');
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new ContractError(`${where} escapes the repository`);
  return value;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ContractError('canonical JSON contains a non-integer number');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new ContractError('canonical JSON contains an unsupported value');
}

function safeExternalAbsolutePath(value, where) {
  boundedString(value, where, 4096);
  if (!isAbsolute(value)) throw new ContractError(`${where} must be absolute`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new ContractError(`${where} contains control characters`);
  if (sep === '/' && value.includes('\\')) throw new ContractError(`${where} contains an ambiguous path separator`);
  const root = parse(value).root;
  const rest = value.slice(root.length);
  if (rest.split(sep).some((part) => part === '' || part === '.' || part === '..')) {
    throw new ContractError(`${where} contains an unsafe path segment`);
  }
  if (resolve(value) !== value) throw new ContractError(`${where} must be lexically normalized`);
  return value;
}

function isAgentsFilename(value) {
  const normalized = value.replaceAll('\\', '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name === 'AGENTS.md' || name === 'AGENTS.override.md';
}

function validateCoordinatorApproval(value) {
  plainObject(value, 'request.coordinatorApproval');
  const fields = ['schemaVersion', 'approvalId', 'issuer', 'provider', 'role', 'cwd', 'scope', 'subjectHash', 'requestHash', 'rules'];
  exactKeys(
    value,
    fields,
    fields,
    'request.coordinatorApproval',
  );
  if (value.schemaVersion !== COORDINATOR_APPROVAL_SCHEMA_VERSION_V03) {
    throw new ContractError(`request.coordinatorApproval.schemaVersion must be '${COORDINATOR_APPROVAL_SCHEMA_VERSION_V03}'`);
  }
  safeCliValue(value.approvalId, 'request.coordinatorApproval.approvalId', 256);
  safeCliValue(value.issuer, 'request.coordinatorApproval.issuer', 256);
  if (value.provider !== 'codex') throw new ContractError("request.coordinatorApproval.provider must be 'codex'");
  if (!ROLES.includes(value.role)) throw new ContractError(`request.coordinatorApproval.role must be ${ROLES.join('|')}`);
  boundedString(value.cwd, 'request.coordinatorApproval.cwd', 4096);
  if (value.scope !== 'all-applicable-agents-rules') {
    throw new ContractError("request.coordinatorApproval.scope must be 'all-applicable-agents-rules'");
  }
  if (typeof value.subjectHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.subjectHash)) {
    throw new ContractError('request.coordinatorApproval.subjectHash must be a SHA-256 digest');
  }
  digest(value.requestHash, 'request.coordinatorApproval.requestHash');
  if (!Array.isArray(value.rules) || value.rules.length > 128) {
    throw new ContractError('request.coordinatorApproval.rules must be an array with at most 128 entries');
  }
  let priorPath = null;
  for (const [index, rule] of value.rules.entries()) {
    plainObject(rule, `request.coordinatorApproval.rules[${index}]`);
    exactKeys(rule, ['source', 'path', 'sha256', 'content'], ['source', 'path', 'sha256', 'content'], `request.coordinatorApproval.rules[${index}]`);
    if (!['repository', 'external'].includes(rule.source)) {
      throw new ContractError(`request.coordinatorApproval.rules[${index}].source must be repository|external`);
    }
    if (rule.source === 'repository') safeRepoRelativePath(rule.path, `request.coordinatorApproval.rules[${index}].path`);
    else safeExternalAbsolutePath(rule.path, `request.coordinatorApproval.rules[${index}].path`);
    if (!isAgentsFilename(rule.path)) {
      throw new ContractError(`request.coordinatorApproval.rules[${index}].path must name AGENTS.md or AGENTS.override.md`);
    }
    const sortKey = `${rule.source}\0${rule.path}`;
    if (priorPath !== null && Buffer.compare(Buffer.from(priorPath), Buffer.from(sortKey)) >= 0) {
      throw new ContractError('request.coordinatorApproval.rules must be uniquely sorted by source and path');
    }
    priorPath = sortKey;
    if (typeof rule.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(rule.sha256)) {
      throw new ContractError(`request.coordinatorApproval.rules[${index}].sha256 must be a SHA-256 digest`);
    }
    boundedString(rule.content, `request.coordinatorApproval.rules[${index}].content`, 256_000, { allowEmpty: true });
    if (sha256(Buffer.from(rule.content)) !== rule.sha256) {
      throw new ContractError(`request.coordinatorApproval.rules[${index}] content digest mismatch`);
    }
  }
}

function parseBoundedJson(raw, where, maxBytes, code = 'invalid_contract') {
  if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
  if (raw.length === 0) throw new ContractError(`${where} is empty`, code);
  if (raw.length > maxBytes) throw new ContractError(`${where} exceeds ${maxBytes} bytes`, code);
  let value;
  const text = decodeUtf8(raw, where, code);
  try { value = JSON.parse(text); }
  catch { throw new ContractError(`${where} is not valid JSON`, code); }
  plainObject(value, where);
  return value;
}

function digest(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new ContractError(`${where} must be a SHA-256 digest`);
  return value;
}

function harness(value, where) {
  if (!PIPELINE_PROVIDERS.includes(value)) throw new ContractError(`${where} must be ${PIPELINE_PROVIDERS.join('|')}`);
}

function booleanField(value, where) {
  if (typeof value !== 'boolean') throw new ContractError(`${where} must be a boolean`);
}

export function validateDelegation(value, where = 'request.delegation', { allowNull = false } = {}) {
  if (allowNull && value === null) return value;
  plainObject(value, where);
  exactKeys(value, ['mode', 'provenance'], ['mode', 'provenance'], where);
  if (!['none', 'advice-only'].includes(value.mode)) throw new ContractError(`${where}.mode must be none|advice-only`);
  if (!['verb-derived', 'parent-attenuated'].includes(value.provenance)) throw new ContractError(`${where}.provenance must be verb-derived|parent-attenuated`);
  return value;
}

function validateSelection(value) {
  plainObject(value, 'request.selection');
  exactKeys(value, ['requested', 'resolved', 'provenance'], ['requested', 'resolved', 'provenance'], 'request.selection');
  for (const [kind, keys] of [['requested', ['model', 'effort', 'maxTurns']], ['resolved', ['model', 'effort', 'maxTurns']], ['provenance', ['model', 'effort', 'maxTurns']]]) {
    plainObject(value[kind], `request.selection.${kind}`);
    exactKeys(value[kind], keys, keys, `request.selection.${kind}`);
  }
  for (const key of ['model', 'effort']) {
    if (value.requested[key] !== null) safeCliValue(value.requested[key], `request.selection.requested.${key}`, key === 'model' ? 256 : 64);
    safeCliValue(value.resolved[key], `request.selection.resolved.${key}`, key === 'model' ? 256 : 64);
  }
  for (const [where, turns] of [['requested', value.requested.maxTurns], ['resolved', value.resolved.maxTurns]]) {
    if (turns !== null && (!Number.isInteger(turns) || turns < 1 || turns > 100)) throw new ContractError(`request.selection.${where}.maxTurns must be null or an integer from 1 through 100`);
  }
  if (!['explicit', 'provider-default'].includes(value.provenance.model)) throw new ContractError('request.selection.provenance.model is invalid');
  for (const key of ['effort', 'maxTurns']) if (!['explicit', 'operation-default', 'provider-default'].includes(value.provenance[key])) throw new ContractError(`request.selection.provenance.${key} is invalid`);
}

function validateGrants(value) {
  plainObject(value, 'request.grants');
  exactKeys(value, ['requested', 'resolved', 'provenance', 'mcp'], ['requested', 'resolved', 'provenance', 'mcp'], 'request.grants');
  plainObject(value.requested, 'request.grants.requested');
  exactKeys(value.requested, ['bash', 'webSearch', 'mcp'], ['bash', 'webSearch', 'mcp'], 'request.grants.requested');
  for (const key of ['bash', 'webSearch', 'mcp']) booleanField(value.requested[key], `request.grants.requested.${key}`);
  plainObject(value.resolved, 'request.grants.resolved');
  exactKeys(value.resolved, ['bash', 'webSearch', 'mcp', 'write'], ['bash', 'webSearch', 'mcp', 'write'], 'request.grants.resolved');
  for (const key of ['bash', 'webSearch', 'mcp', 'write']) booleanField(value.resolved[key], `request.grants.resolved.${key}`);
  plainObject(value.provenance, 'request.grants.provenance');
  exactKeys(value.provenance, ['bash', 'webSearch', 'mcp', 'write'], ['bash', 'webSearch', 'mcp', 'write'], 'request.grants.provenance');
  for (const key of ['bash', 'webSearch', 'mcp']) if (!['explicit', 'operation-default', 'parent-attenuated'].includes(value.provenance[key])) throw new ContractError(`request.grants.provenance.${key} is invalid`);
  if (!['mode-derived', 'parent-attenuated'].includes(value.provenance.write)) throw new ContractError('request.grants.provenance.write is invalid');
  plainObject(value.mcp, 'request.grants.mcp');
  exactKeys(value.mcp, ['digest', 'servers'], ['digest', 'servers'], 'request.grants.mcp');
  digest(value.mcp.digest, 'request.grants.mcp.digest', { nullable: true });
  if (!Array.isArray(value.mcp.servers) || value.mcp.servers.length > 32 || new Set(value.mcp.servers).size !== value.mcp.servers.length) throw new ContractError('request.grants.mcp.servers must be a unique array with at most 32 entries');
  for (const [index, server] of value.mcp.servers.entries()) safeCliValue(server, `request.grants.mcp.servers[${index}]`, 64);
  if (value.resolved.mcp !== Boolean(value.mcp.digest) || value.resolved.mcp !== (value.mcp.servers.length > 0)) throw new ContractError('request.grants MCP receipt is inconsistent');
}

function validateDependencies(value, where = 'request.lineage.dependencies') {
  if (!Array.isArray(value) || value.length > 64) throw new ContractError(`${where} must be an array with at most 64 entries`);
  const seen = new Set();
  for (const [index, dependency] of value.entries()) {
    plainObject(dependency, `${where}[${index}]`);
    exactKeys(dependency, ['runId', 'type'], ['runId', 'type'], `${where}[${index}]`);
    safeCliValue(dependency.runId, `${where}[${index}].runId`, 128);
    if (!['requires', 'advises', 'verifies'].includes(dependency.type)) throw new ContractError(`${where}[${index}].type is invalid`);
    const key = `${dependency.type}\0${dependency.runId}`;
    if (seen.has(key)) throw new ContractError(`${where} contains a duplicate dependency`);
    seen.add(key);
  }
}

function validateLimits(value, where) {
  plainObject(value, where);
  const keys = ['maxDepth', 'maxNodes', 'maxAdviceNodes', 'maxHandoffNodes', 'maxConcurrency', 'rootTimeoutMs', 'timeoutMs'];
  exactKeys(value, keys, keys, where);
  const bounds = { maxDepth: [0, 32], maxNodes: [1, 256], maxAdviceNodes: [0, 256], maxHandoffNodes: [0, 256], maxConcurrency: [1, 32], rootTimeoutMs: [100, 86_400_000], timeoutMs: [100, 3_600_000] };
  for (const [key, [min, max]] of Object.entries(bounds)) if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new ContractError(`${where}.${key} must be an integer from ${min} through ${max}`);
  if (value.maxAdviceNodes + value.maxHandoffNodes < value.maxNodes) throw new ContractError(`${where} operation budgets do not cover maxNodes`);
  if (value.timeoutMs > value.rootTimeoutMs) throw new ContractError(`${where}.timeoutMs exceeds rootTimeoutMs`);
}

function validateRemaining(value, limits, where) {
  plainObject(value, where);
  exactKeys(value, ['nodes', 'adviceNodes', 'handoffNodes'], ['nodes', 'adviceNodes', 'handoffNodes'], where);
  const pairs = [['nodes', 'maxNodes'], ['adviceNodes', 'maxAdviceNodes'], ['handoffNodes', 'maxHandoffNodes']];
  for (const [key, limitKey] of pairs) if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > limits[limitKey]) throw new ContractError(`${where}.${key} is outside its limit`);
}

function validateMachineRequestV03(value) {
  const keys = ['schemaVersion', 'operation', 'caller', 'target', 'mode', 'cwd', 'instructions', 'selection', 'grants', 'delegation', 'lineage', 'budgets', 'intentHash', 'coordinatorApproval'];
  exactKeys(value, keys, keys.filter((key) => key !== 'coordinatorApproval'), 'request');
  if (value.schemaVersion !== REQUEST_SCHEMA_VERSION_V03) throw new ContractError(`request.schemaVersion must be '${REQUEST_SCHEMA_VERSION_V03}'`);
  if (!['advice', 'handoff'].includes(value.operation)) throw new ContractError('request.operation must be advice|handoff');
  plainObject(value.caller, 'request.caller');
  exactKeys(value.caller, ['harness', 'provenance'], ['harness', 'provenance'], 'request.caller');
  harness(value.caller.harness, 'request.caller.harness');
  if (!['root-asserted', 'supervisor-derived'].includes(value.caller.provenance)) throw new ContractError('request.caller.provenance is invalid');
  plainObject(value.target, 'request.target');
  exactKeys(value.target, ['harness'], ['harness'], 'request.target');
  harness(value.target.harness, 'request.target.harness');
  if (value.operation === 'advice') {
    if (value.mode !== null) throw new ContractError('advice request.mode must be null');
    if (value.grants?.resolved?.write !== false) throw new ContractError('advice cannot receive write authority');
  } else {
    if (!ROLES.includes(value.mode)) throw new ContractError(`handoff request.mode must be ${ROLES.join('|')}`);
    if (!['codex', 'claude'].includes(value.caller.harness)) throw new ContractError('handoff caller must be codex|claude');
  }
  safeExternalAbsolutePath(value.cwd, 'request.cwd');
  boundedString(value.instructions, 'request.instructions', MAX_REQUEST_BYTES);
  validateSelection(value.selection);
  validateGrants(value.grants);
  validateDelegation(value.delegation);
  if ((value.mode === 'review' || value.mode === 'verify') && value.grants.resolved.write) throw new ContractError(`${value.mode} cannot receive write authority`);
  plainObject(value.lineage, 'request.lineage');
  exactKeys(value.lineage, ['rootRunId', 'runId', 'parentRunId', 'depth', 'dependencies'], ['rootRunId', 'runId', 'parentRunId', 'depth', 'dependencies'], 'request.lineage');
  safeCliValue(value.lineage.rootRunId, 'request.lineage.rootRunId', 128);
  safeCliValue(value.lineage.runId, 'request.lineage.runId', 128);
  if (value.lineage.parentRunId !== null) safeCliValue(value.lineage.parentRunId, 'request.lineage.parentRunId', 128);
  if (!Number.isInteger(value.lineage.depth) || value.lineage.depth < 0 || value.lineage.depth > 32) throw new ContractError('request.lineage.depth must be an integer from 0 through 32');
  validateDependencies(value.lineage.dependencies);
  if (value.caller.provenance === 'root-asserted' && (value.lineage.depth !== 0 || value.lineage.parentRunId !== null || value.lineage.rootRunId !== value.lineage.runId)) throw new ContractError('root caller lineage is inconsistent');
  if (value.caller.provenance === 'supervisor-derived' && (value.lineage.depth < 1 || value.lineage.parentRunId === null)) throw new ContractError('nested caller lineage is inconsistent');
  if (value.caller.provenance === 'root-asserted' && value.delegation.provenance !== 'verb-derived') throw new ContractError('root delegation must be verb-derived');
  if (value.caller.provenance === 'supervisor-derived' && (value.operation !== 'advice' || value.delegation.mode !== 'advice-only' || value.delegation.provenance !== 'parent-attenuated')) throw new ContractError('nested delegation must be parent-attenuated advice-only');
  if (value.operation === 'advice' && value.delegation.mode !== 'advice-only') throw new ContractError('advice must expose advice-only delegation');
  plainObject(value.budgets, 'request.budgets');
  exactKeys(value.budgets, ['limits', 'remaining'], ['limits', 'remaining'], 'request.budgets');
  validateLimits(value.budgets.limits, 'request.budgets.limits');
  validateRemaining(value.budgets.remaining, value.budgets.limits, 'request.budgets.remaining');
  if (value.lineage.depth > value.budgets.limits.maxDepth) throw new ContractError('request depth exceeds maxDepth');
  digest(value.intentHash, 'request.intentHash');
  if (value.coordinatorApproval !== undefined) validateCoordinatorApproval(value.coordinatorApproval);
  return value;
}

export function parseMachineRequest(raw) {
  const value = parseBoundedJson(raw, 'request file', MAX_REQUEST_BYTES);
  if (value.schemaVersion === REQUEST_SCHEMA_VERSION_V03) return validateMachineRequestV03(value);
  throw new ContractError(`request.schemaVersion must be '${REQUEST_SCHEMA_VERSION_V03}'`);
}

function validateUsage(value) {
  plainObject(value, 'provider output.usage');
  exactKeys(value, ['inputTokens', 'outputTokens', 'totalTokens'], [], 'provider output.usage');
  for (const key of Object.keys(value)) {
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      throw new ContractError(`provider output.usage.${key} must be a non-negative integer`);
    }
  }
}

export function parseProviderOutput(raw) {
  try {
    const probe = parseBoundedJson(raw, 'provider output', MAX_PROVIDER_OUTPUT_BYTES, 'invalid_provider_output');
    if (probe.schemaVersion === PROVIDER_OUTPUT_SCHEMA_VERSION_V03) return validateProviderOutputV03(probe);
    throw new ContractError(`provider output schema drift: expected '${PROVIDER_OUTPUT_SCHEMA_VERSION_V03}'`, 'invalid_provider_output');
  } catch (error) {
    if (error instanceof ContractError) {
      if (error.message === 'provider output is not valid JSON') {
        error.message = 'provider output must be exactly one JSON object with no prose or noise';
      }
      error.code = 'invalid_provider_output';
    }
    throw error;
  }
}

function validateEvidenceAndFindings(value) {
  if (!Array.isArray(value.evidence) || value.evidence.length > 1000) throw new ContractError('provider output.evidence must be a bounded array', 'invalid_provider_output');
  if (!Array.isArray(value.findings) || value.findings.length > 1000) throw new ContractError('provider output.findings must be a bounded array', 'invalid_provider_output');
  for (const [index, item] of value.evidence.entries()) {
    plainObject(item, `provider output.evidence[${index}]`);
    exactKeys(item, ['kind', 'path', 'summary'], ['kind', 'summary'], `provider output.evidence[${index}]`);
    boundedString(item.kind, `provider output.evidence[${index}].kind`, 64);
    boundedString(item.summary, `provider output.evidence[${index}].summary`, 8192);
    if (item.path !== undefined) safeRepoRelativePath(item.path, `provider output.evidence[${index}].path`);
  }
  for (const [index, item] of value.findings.entries()) {
    plainObject(item, `provider output.findings[${index}]`);
    exactKeys(item, ['file', 'line', 'severity', 'summary'], ['severity', 'summary'], `provider output.findings[${index}]`);
    if (item.file !== undefined) safeRepoRelativePath(item.file, `provider output.findings[${index}].file`);
    if (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1)) throw new ContractError(`provider output.findings[${index}].line must be a positive integer`, 'invalid_provider_output');
    if (!['blocker', 'high', 'medium', 'low', 'nit'].includes(item.severity)) throw new ContractError(`provider output.findings[${index}].severity is unsupported`, 'invalid_provider_output');
    boundedString(item.summary, `provider output.findings[${index}].summary`, 8192);
  }
}

function validateProviderOutputV03(value) {
  exactKeys(value, ['schemaVersion', 'status', 'response', 'evidence', 'findings', 'usage'], ['schemaVersion', 'status', 'response', 'evidence', 'findings', 'usage'], 'provider output');
  if (value.schemaVersion !== PROVIDER_OUTPUT_SCHEMA_VERSION_V03) throw new ContractError('provider output schema drift', 'invalid_provider_output');
  if (!['completed', 'blocked', 'failed'].includes(value.status)) throw new ContractError('provider output.status is unsupported', 'invalid_provider_output');
  boundedString(value.response, 'provider output.response', 65_536);
  validateEvidenceAndFindings(value);
  validateUsage(value.usage);
  return value;
}

function validateEnvReferences(value, where) {
  plainObject(value, where);
  if (Object.keys(value).length > 64) throw new ContractError(`${where} exceeds 64 entries`);
  for (const [key, reference] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key)) throw new ContractError(`${where} contains an invalid environment key`);
    plainObject(reference, `${where}.${key}`);
    exactKeys(reference, ['fromEnv'], ['fromEnv'], `${where}.${key}`);
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference.fromEnv)) throw new ContractError(`${where}.${key}.fromEnv is invalid`);
  }
}

function validateHeaderReferences(value, where) {
  plainObject(value, where);
  if (Object.keys(value).length > 64) throw new ContractError(`${where} exceeds 64 entries`);
  for (const [key, reference] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/u.test(key)) throw new ContractError(`${where} contains an invalid HTTP header name`);
    plainObject(reference, `${where}.${key}`);
    exactKeys(reference, ['fromEnv'], ['fromEnv'], `${where}.${key}`);
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference.fromEnv)) throw new ContractError(`${where}.${key}.fromEnv is invalid`);
  }
}

export function parseMcpDescriptor(raw) {
  const value = parseBoundedJson(raw, 'MCP descriptor', 256_000);
  exactKeys(value, ['schemaVersion', 'servers'], ['schemaVersion', 'servers'], 'MCP descriptor');
  if (value.schemaVersion !== MCP_SCHEMA_VERSION_V03) throw new ContractError(`MCP descriptor.schemaVersion must be '${MCP_SCHEMA_VERSION_V03}'`);
  if (!Array.isArray(value.servers) || value.servers.length > 32) throw new ContractError('MCP descriptor.servers must contain at most 32 entries');
  const names = new Set();
  for (const [index, server] of value.servers.entries()) {
    const where = `MCP descriptor.servers[${index}]`;
    plainObject(server, where);
    if (typeof server.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(server.name)) throw new ContractError(`${where}.name is invalid`);
    if (names.has(server.name)) throw new ContractError('MCP descriptor server names must be unique');
    names.add(server.name);
    if (server.transport === 'stdio') {
      exactKeys(server, ['name', 'transport', 'command', 'args', 'env'], ['name', 'transport', 'command', 'args', 'env'], where);
      safeExternalAbsolutePath(server.command, `${where}.command`);
      if (!Array.isArray(server.args) || server.args.length > 64) throw new ContractError(`${where}.args must contain at most 64 strings`);
      for (const [argIndex, arg] of server.args.entries()) boundedString(arg, `${where}.args[${argIndex}]`, 4096, { allowEmpty: true });
      validateEnvReferences(server.env, `${where}.env`);
    } else if (server.transport === 'http' || server.transport === 'sse') {
      exactKeys(server, ['name', 'transport', 'url', 'headers'], ['name', 'transport', 'url', 'headers'], where);
      boundedString(server.url, `${where}.url`, 4096);
      let url;
      try { url = new URL(server.url); } catch { throw new ContractError(`${where}.url is invalid`); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new ContractError(`${where}.url must be credential-free HTTPS without a fragment`);
      validateHeaderReferences(server.headers, `${where}.headers`);
    } else {
      throw new ContractError(`${where}.transport must be stdio|http|sse`);
    }
  }
  return value;
}

export function parseDagSnapshot(raw) {
  const value = parseBoundedJson(raw, 'DAG snapshot', MAX_REQUEST_BYTES);
  const keys = ['schemaVersion', 'rootRunId', 'revision', 'status', 'limits', 'remaining', 'activeCount', 'nodes'];
  exactKeys(value, keys, keys, 'DAG snapshot');
  if (value.schemaVersion !== DAG_SCHEMA_VERSION_V03) throw new ContractError(`DAG snapshot.schemaVersion must be '${DAG_SCHEMA_VERSION_V03}'`);
  safeCliValue(value.rootRunId, 'DAG snapshot.rootRunId', 128);
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new ContractError('DAG snapshot.revision must be a non-negative integer');
  if (!['running', 'succeeded', 'blocked', 'failed', 'timed_out', 'cancelled'].includes(value.status)) throw new ContractError('DAG snapshot.status is invalid');
  validateLimits(value.limits, 'DAG snapshot.limits');
  validateRemaining(value.remaining, value.limits, 'DAG snapshot.remaining');
  if (!Number.isInteger(value.activeCount) || value.activeCount < 0 || value.activeCount > value.limits.maxConcurrency) throw new ContractError('DAG snapshot.activeCount is invalid');
  if (!Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > value.limits.maxNodes) throw new ContractError('DAG snapshot.nodes has an invalid count');
  const ids = new Set();
  let active = 0;
  let advice = 0;
  let handoff = 0;
  for (const [index, node] of value.nodes.entries()) {
    const where = `DAG snapshot.nodes[${index}]`;
    plainObject(node, where);
    const nodeKeys = ['runId', 'parentRunId', 'depth', 'operation', 'callerHarness', 'targetHarness', 'mode', 'delegation', 'intentHash', 'dependencies', 'state', 'requestHash', 'resultHash', 'startedAt', 'finishedAt'];
    exactKeys(node, nodeKeys, nodeKeys, where);
    safeCliValue(node.runId, `${where}.runId`, 128);
    if (ids.has(node.runId)) throw new ContractError('DAG snapshot contains duplicate run IDs');
    ids.add(node.runId);
    if (node.parentRunId !== null) safeCliValue(node.parentRunId, `${where}.parentRunId`, 128);
    if (!Number.isInteger(node.depth) || node.depth < 0 || node.depth > value.limits.maxDepth) throw new ContractError(`${where}.depth is invalid`);
    if (!['advice', 'handoff'].includes(node.operation)) throw new ContractError(`${where}.operation is invalid`);
    node.operation === 'advice' ? advice += 1 : handoff += 1;
    harness(node.callerHarness, `${where}.callerHarness`);
    harness(node.targetHarness, `${where}.targetHarness`);
    if (node.operation === 'advice' ? node.mode !== null : !ROLES.includes(node.mode)) throw new ContractError(`${where}.mode is invalid`);
    validateDelegation(node.delegation, `${where}.delegation`);
    if (node.parentRunId === null && node.delegation.provenance !== 'verb-derived') throw new ContractError(`${where}.delegation must be verb-derived for a root node`);
    if (node.parentRunId !== null && (node.operation !== 'advice' || node.delegation.mode !== 'advice-only' || node.delegation.provenance !== 'parent-attenuated')) throw new ContractError(`${where}.delegation must be parent-attenuated advice-only for a nested node`);
    if (node.operation === 'advice' && node.delegation.mode !== 'advice-only') throw new ContractError(`${where}.delegation must be advice-only for advice`);
    digest(node.intentHash, `${where}.intentHash`);
    validateDependencies(node.dependencies, `${where}.dependencies`);
    if (!['pending', 'running', 'succeeded', 'blocked', 'failed', 'timed_out', 'cancelled', 'rejected', 'not_run'].includes(node.state)) throw new ContractError(`${where}.state is invalid`);
    if (node.state === 'running') active += 1;
    digest(node.requestHash, `${where}.requestHash`, { nullable: true });
    digest(node.resultHash, `${where}.resultHash`, { nullable: true });
    for (const key of ['startedAt', 'finishedAt']) if (node[key] !== null && (typeof node[key] !== 'string' || Number.isNaN(Date.parse(node[key])))) throw new ContractError(`${where}.${key} is invalid`);
  }
  for (const node of value.nodes) {
    if (node.parentRunId !== null && !ids.has(node.parentRunId)) throw new ContractError('DAG snapshot contains a missing parent');
    for (const dependency of node.dependencies) if (!ids.has(dependency.runId)) throw new ContractError('DAG snapshot contains a missing dependency');
  }
  if (active !== value.activeCount) throw new ContractError('DAG snapshot.activeCount does not match nodes');
  if (value.remaining.nodes !== value.limits.maxNodes - value.nodes.length || value.remaining.adviceNodes !== value.limits.maxAdviceNodes - advice || value.remaining.handoffNodes !== value.limits.maxHandoffNodes - handoff) throw new ContractError('DAG snapshot remaining counters are inconsistent');
  return value;
}

export function parseMachineResultV03(raw) {
  const value = parseBoundedJson(raw, 'result', MAX_REQUEST_BYTES);
  const keys = ['schemaVersion', 'driverVersion', 'bundleVersion', 'bundleDigest', 'operation', 'caller', 'target', 'mode', 'requestHash', 'intentHash', 'selection', 'grants', 'delegation', 'lineage', 'status', 'exit', 'output', 'git', 'timing', 'usage', 'policy', 'dag', 'diagnostics'];
  exactKeys(value, keys, keys, 'result');
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION_V03 || value.driverVersion !== DRIVER_VERSION || value.bundleVersion !== BUNDLE_VERSION) throw new ContractError('result version drift');
  digest(value.bundleDigest, 'result.bundleDigest');
  if (!['advice', 'handoff'].includes(value.operation)) throw new ContractError('result.operation is invalid');
  plainObject(value.caller, 'result.caller');
  exactKeys(value.caller, ['harness', 'provenance'], ['harness', 'provenance'], 'result.caller');
  harness(value.caller.harness, 'result.caller.harness');
  if (!['root-asserted', 'supervisor-derived'].includes(value.caller.provenance)) throw new ContractError('result.caller.provenance is invalid');
  plainObject(value.target, 'result.target');
  exactKeys(value.target, ['harness', 'version'], ['harness', 'version'], 'result.target');
  harness(value.target.harness, 'result.target.harness');
  if (value.target.version !== null) boundedString(value.target.version, 'result.target.version', 256);
  if (value.operation === 'advice' ? value.mode !== null : !ROLES.includes(value.mode)) throw new ContractError('result.mode is invalid');
  validateDelegation(value.delegation, 'result.delegation', { allowNull: true });
  if (value.delegation !== null) {
    if (value.caller.provenance === 'root-asserted' && value.delegation.provenance !== 'verb-derived') throw new ContractError('result root delegation must be verb-derived');
    if (value.caller.provenance === 'supervisor-derived' && (value.operation !== 'advice' || value.delegation.mode !== 'advice-only' || value.delegation.provenance !== 'parent-attenuated')) throw new ContractError('result nested delegation must be parent-attenuated advice-only');
    if (value.operation === 'advice' && value.delegation.mode !== 'advice-only') throw new ContractError('result advice delegation must be advice-only');
  }
  digest(value.requestHash, 'result.requestHash', { nullable: true });
  digest(value.intentHash, 'result.intentHash', { nullable: true });
  if (!['succeeded', 'blocked', 'failed', 'timed_out', 'cancelled', 'rejected', 'not_run'].includes(value.status)) throw new ContractError('result.status is invalid');
  plainObject(value.output, 'result.output');
  exactKeys(value.output, ['response', 'evidence', 'findings'], ['response', 'evidence', 'findings'], 'result.output');
  if (value.status === 'succeeded') boundedString(value.output.response, 'result.output.response', 65_536);
  else if (value.output.response !== null && typeof value.output.response !== 'string') throw new ContractError('result.output.response must be string|null');
  if (value.dag !== null) parseDagSnapshot(Buffer.from(JSON.stringify(value.dag)));
  return value;
}
