import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  COORDINATOR_APPROVAL_SCHEMA_VERSION_V03,
  ContractError,
  canonicalJson,
  sha256,
} from './contracts.mjs';
import { repositoryRoot } from './git.mjs';
import { safeCwd } from './paths.mjs';

const MAX_RULES = 128;
const MAX_RULE_BYTES = 256_000;
const MAX_TOTAL_RULE_BYTES = 1_000_000;
// Preserve an optional BOM in the decoded content so the approval content hashes back to the exact
// bytes the coordinator inspected.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const RULE_FILENAMES = Object.freeze(['AGENTS.override.md', 'AGENTS.md']);
const APPROVAL_SUBJECT_SCHEMA_VERSION_V03 = 'handoff.coordinator-subject.v0.3';

function repoPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

function directoryChain(root, cwd) {
  const rel = relative(root, cwd);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new ContractError('--cwd is outside its Git repository root');
  }
  const directories = [root];
  if (!rel) return directories;
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    directories.push(current);
  }
  return directories;
}

function readRule(absolute, path, source = 'repository') {
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ContractError(`cannot inspect applicable AGENTS.md rule '${path}': ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ContractError(`applicable AGENTS.md rule '${path}' must be a regular non-symlink file`);
  }
  let bytes;
  try { bytes = readFileSync(absolute); }
  catch (error) { throw new ContractError(`cannot read applicable AGENTS.md rule '${path}': ${error.message}`); }
  if (bytes.length > MAX_RULE_BYTES) throw new ContractError(`applicable AGENTS.md rule '${path}' exceeds ${MAX_RULE_BYTES} bytes`);
  let content;
  try { content = utf8.decode(bytes); }
  catch { throw new ContractError(`applicable AGENTS.md rule '${path}' is not valid UTF-8`); }
  // Codex skips empty guidance and continues to the next filename at this directory level.
  if (!content.trim()) return null;
  return { source, path, sha256: sha256(bytes), content };
}

export function discoverCodexGlobalAgentsRules() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  if (!isAbsolute(codexHome)) throw new ContractError('CODEX_HOME must be absolute for coordinator rule binding');
  for (const filename of RULE_FILENAMES) {
    const absolute = join(codexHome, filename);
    const rule = readRule(absolute, absolute, 'external');
    if (rule) return [rule];
  }
  return [];
}

export function discoverAgentsRules(cwd) {
  const canonicalCwd = safeCwd(cwd);
  const root = repositoryRoot(canonicalCwd);
  const rules = [];
  let totalBytes = 0;
  for (const directory of directoryChain(root, canonicalCwd)) {
    for (const filename of RULE_FILENAMES) {
      const absolute = join(directory, filename);
      const rule = readRule(absolute, repoPath(root, absolute));
      if (!rule) continue;
      totalBytes += Buffer.byteLength(rule.content);
      if (totalBytes > MAX_TOTAL_RULE_BYTES) throw new ContractError(`applicable AGENTS.md rules exceed ${MAX_TOTAL_RULE_BYTES} total bytes`);
      rules.push(rule);
      break;
    }
  }
  if (rules.length > MAX_RULES) throw new ContractError(`applicable AGENTS.md rule count exceeds ${MAX_RULES}`);
  return rules;
}

export function discoverCoordinatorAgentsRules(cwd) {
  return [...discoverCodexGlobalAgentsRules(), ...discoverAgentsRules(cwd)]
    .sort((left, right) => Buffer.compare(Buffer.from(`${left.source}\0${left.path}`), Buffer.from(`${right.source}\0${right.path}`)));
}

function approvalSubject(request, approval, role, cwd) {
  const requestFields = structuredClone(request);
  delete requestFields.coordinatorApproval;
  return {
    schemaVersion: APPROVAL_SUBJECT_SCHEMA_VERSION_V03,
    approvalId: approval.approvalId,
    issuer: approval.issuer,
    provider: approval.provider,
    role,
    cwd,
    scope: approval.scope,
    requestHash: approval.requestHash,
    request: requestFields,
    rules: approval.rules.map(({ source, path, sha256: digest }) => ({ source, path, sha256: digest })),
  };
}

export function codexApprovalSubjectHash({ request, approval, role = approval.role, cwd = approval.cwd }) {
  return sha256(Buffer.from(canonicalJson(approvalSubject(request, approval, role, safeCwd(cwd)))));
}

export function bindCodexCoordinatorApproval({ request, role, cwd, requestHash }) {
  const approval = request.coordinatorApproval;
  if (!approval) throw new ContractError('Codex pipeline runs require request.coordinatorApproval');
  if (approval.provider !== 'codex') throw new ContractError("request.coordinatorApproval.provider must be 'codex'");
  if (approval.role !== role) throw new ContractError('request.coordinatorApproval.role does not match --role');
  if (safeCwd(approval.cwd) !== cwd) throw new ContractError('request.coordinatorApproval.cwd does not match --cwd');
  if (approval.schemaVersion !== COORDINATOR_APPROVAL_SCHEMA_VERSION_V03) throw new ContractError('request requires a v0.3 coordinator approval');
  const unsigned = structuredClone(request);
  delete unsigned.coordinatorApproval;
  const expectedUnsignedHash = sha256(Buffer.from(`${JSON.stringify(unsigned)}\n`));
  if (approval.requestHash !== expectedUnsignedHash) throw new ContractError('request.coordinatorApproval.requestHash does not bind the unsigned request bytes');
  const subjectHash = codexApprovalSubjectHash({ request, approval, role, cwd });
  if (approval.subjectHash !== subjectHash) {
    throw new ContractError('request.coordinatorApproval.subjectHash does not bind this request, role, cwd, and rule set');
  }

  const discovered = discoverCoordinatorAgentsRules(cwd);
  const suppliedRules = approval.rules;
  if (suppliedRules.length !== discovered.length) {
    throw new ContractError('request.coordinatorApproval.rules does not contain every applicable coordinator and repository AGENTS.md file');
  }
  for (let index = 0; index < discovered.length; index += 1) {
    const expected = discovered[index];
    const supplied = suppliedRules[index];
    if (supplied.path !== expected.path || supplied.sha256 !== expected.sha256 || supplied.content !== expected.content) {
      throw new ContractError(`request.coordinatorApproval.rules does not match applicable AGENTS.md rule '${expected.path}'`);
    }
  }

  const rulesDigest = sha256(Buffer.from(JSON.stringify(approval.rules.map(({ source, path, sha256: digest }) => ({ source, path, sha256: digest })))));
  return {
    schemaVersion: approval.schemaVersion,
    approvalId: approval.approvalId,
    issuer: approval.issuer,
    provider: approval.provider,
    role,
    cwd,
    scope: approval.scope,
    requestHash,
    subjectHash,
    rulesDigest,
    rules: approval.rules,
  };
}

export function createCodexCoordinatorApprovalV03({ request, role, cwd, issuer = 'handoff-frontend' }) {
  const unsignedRequestHash = sha256(Buffer.from(`${JSON.stringify(request)}\n`));
  const approval = {
    schemaVersion: COORDINATOR_APPROVAL_SCHEMA_VERSION_V03,
    approvalId: `handoff-v03-${randomUUID()}`,
    issuer,
    provider: 'codex',
    role,
    cwd: safeCwd(cwd),
    scope: 'all-applicable-agents-rules',
    requestHash: unsignedRequestHash,
    subjectHash: '',
    rules: discoverCoordinatorAgentsRules(cwd),
  };
  approval.subjectHash = codexApprovalSubjectHash({ request, approval, role, cwd });
  return approval;
}
