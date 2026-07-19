import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

export const DRIVER_VERSION = '0.3.0';
export const BUNDLE_VERSION = '0.3.0';
export const CAPABILITIES_SCHEMA_VERSION = 'handoff.capabilities.v0.2';
export const REQUEST_SCHEMA_VERSION = 'handoff.request.v0.2';
export const PROVIDER_OUTPUT_SCHEMA_VERSION = 'handoff.provider-output.v0.2';
export const RESULT_SCHEMA_VERSION = 'handoff.result.v0.2';
export const COORDINATOR_APPROVAL_SCHEMA_VERSION = 'handoff.coordinator-approval.v0.2';
export const ROLES = Object.freeze(['build', 'phase', 'review', 'verify']);
export const PIPELINE_PROVIDER_ROLES = Object.freeze({
  codex: Object.freeze(['build', 'phase', 'review', 'verify']),
  grok: Object.freeze(['build', 'phase', 'review', 'verify']),
  kiro: Object.freeze(['review', 'verify']),
  claude: Object.freeze(['build', 'phase', 'review', 'verify']),
  opencode: Object.freeze(['build', 'phase', 'review', 'verify']),
  cursor: Object.freeze(['build', 'phase', 'review', 'verify']),
});
export const PIPELINE_PROVIDERS = Object.freeze(Object.keys(PIPELINE_PROVIDER_ROLES));
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_REQUEST_BYTES = 2_000_000;
export const MAX_PROVIDER_OUTPUT_BYTES = 256_000;
export const MAX_CAPTURE_BYTES = 1_048_576;
export const MAX_DIAGNOSTIC_BYTES = 8_192;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

const here = dirname(fileURLToPath(import.meta.url));
export const PROVIDER_OUTPUT_SCHEMA_PATH = resolve(here, '../../contracts/v0.2/provider-output.schema.json');
export const PROVIDER_OUTPUT_SCHEMA = JSON.parse(readFileSync(PROVIDER_OUTPUT_SCHEMA_PATH, 'utf8'));

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

function plainObject(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ContractError(`${where} must be a JSON object`);
  }
  return value;
}

function exactKeys(value, allowed, required, where) {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ContractError(`${where} contains unknown field(s): ${unknown.join(', ')}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new ContractError(`${where} is missing required field(s): ${missing.join(', ')}`);
}

function boundedString(value, where, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new ContractError(`${where} must be a string`);
  if (!allowEmpty && !value.trim()) throw new ContractError(`${where} must not be empty`);
  if (Buffer.byteLength(value) > max) throw new ContractError(`${where} exceeds ${max} bytes`);
  if (value.includes('\0')) throw new ContractError(`${where} contains NUL`);
  return value;
}

function safeCliValue(value, where, max) {
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
  exactKeys(
    value,
    ['schemaVersion', 'approvalId', 'issuer', 'provider', 'role', 'cwd', 'scope', 'subjectHash', 'rules'],
    ['schemaVersion', 'approvalId', 'issuer', 'provider', 'role', 'cwd', 'scope', 'subjectHash', 'rules'],
    'request.coordinatorApproval',
  );
  if (value.schemaVersion !== COORDINATOR_APPROVAL_SCHEMA_VERSION) {
    throw new ContractError(`request.coordinatorApproval.schemaVersion must be '${COORDINATOR_APPROVAL_SCHEMA_VERSION}'`);
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

export function parseMachineRequest(raw) {
  if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
  if (raw.length === 0) throw new ContractError('request file is empty');
  if (raw.length > MAX_REQUEST_BYTES) throw new ContractError(`request file exceeds ${MAX_REQUEST_BYTES} bytes`);
  let value;
  const text = decodeUtf8(raw, 'request file');
  try { value = JSON.parse(text); }
  catch { throw new ContractError('request file is not valid JSON'); }
  plainObject(value, 'request');
  exactKeys(
    value,
    ['schemaVersion', 'instructions', 'timeoutMs', 'model', 'effort', 'coordinatorApproval'],
    ['schemaVersion', 'instructions'],
    'request',
  );
  if (value.schemaVersion !== REQUEST_SCHEMA_VERSION) {
    throw new ContractError(`request.schemaVersion must be '${REQUEST_SCHEMA_VERSION}'`);
  }
  boundedString(value.instructions, 'request.instructions', MAX_REQUEST_BYTES);
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 3_600_000)) {
    throw new ContractError('request.timeoutMs must be an integer from 100 through 3600000');
  }
  if (value.model !== undefined) safeCliValue(value.model, 'request.model', 256);
  if (value.effort !== undefined) safeCliValue(value.effort, 'request.effort', 64);
  if (value.coordinatorApproval !== undefined) validateCoordinatorApproval(value.coordinatorApproval);
  return value;
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

function parseProviderOutputUnchecked(raw) {
  if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw || '');
  if (raw.length === 0) throw new ContractError('provider output is missing', 'invalid_provider_output');
  if (raw.length > MAX_PROVIDER_OUTPUT_BYTES) {
    throw new ContractError(`provider output exceeds ${MAX_PROVIDER_OUTPUT_BYTES} bytes`, 'invalid_provider_output');
  }
  let value;
  const text = decodeUtf8(raw, 'provider output', 'invalid_provider_output');
  try { value = JSON.parse(text); }
  catch { throw new ContractError('provider output must be exactly one JSON object with no prose or noise', 'invalid_provider_output'); }
  plainObject(value, 'provider output');
  exactKeys(
    value,
    ['schemaVersion', 'status', 'summary', 'evidence', 'findings', 'usage'],
    ['schemaVersion', 'status', 'summary', 'evidence', 'findings', 'usage'],
    'provider output',
  );
  if (value.schemaVersion !== PROVIDER_OUTPUT_SCHEMA_VERSION) {
    throw new ContractError(`provider output schema drift: expected '${PROVIDER_OUTPUT_SCHEMA_VERSION}'`, 'invalid_provider_output');
  }
  if (!['completed', 'blocked', 'failed'].includes(value.status)) throw new ContractError('provider output.status is unsupported', 'invalid_provider_output');
  boundedString(value.summary, 'provider output.summary', 32_768);
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
  validateUsage(value.usage);
  return value;
}

export function parseProviderOutput(raw) {
  try {
    return parseProviderOutputUnchecked(raw);
  } catch (error) {
    if (error instanceof ContractError) error.code = 'invalid_provider_output';
    throw error;
  }
}
