#!/usr/bin/env node
// Strict slash-command frontend: turn literal instruction-file bytes into the versioned request
// consumed by handoff.mjs. For Codex, invoking this helper is the coordinator's explicit approval
// to bind every applicable repository AGENTS.md rule into the request.
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';

import { codexApprovalSubjectHash, discoverCoordinatorAgentsRules } from './lib/agents-policy.mjs';
import {
  COORDINATOR_APPROVAL_SCHEMA_VERSION,
  PIPELINE_PROVIDER_ROLES,
  REQUEST_SCHEMA_VERSION,
  decodeUtf8,
  parseMachineRequest,
  sha256,
} from './lib/contracts.mjs';
import {
  closeReservedResult,
  reserveResultPath,
  safeCwd,
  safeRequestPath,
  writeReservedResult,
} from './lib/paths.mjs';

function parseArgs(argv) {
  const result = {};
  const allowed = new Set(['--provider', '--role', '--cwd', '--instructions', '--request', '--timeout-ms', '--model', '--effort']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    const key = flag.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(result, key)) throw new Error(`duplicate argument: ${flag}`);
    result[key] = value;
  }
  const missing = ['provider', 'role', 'cwd', 'instructions', 'request'].filter((key) => !result[key]);
  if (missing.length) throw new Error(`missing argument(s): ${missing.map((key) => `--${key}`).join(', ')}`);
  return result;
}

function prepare(options) {
  const roles = PIPELINE_PROVIDER_ROLES[options.provider];
  if (!roles) throw new Error(`--provider must be ${Object.keys(PIPELINE_PROVIDER_ROLES).join('|')}`);
  if (!roles.includes(options.role)) {
    throw new Error(`--provider ${options.provider} does not support role ${options.role}; allowed roles: ${roles.join('|')}`);
  }
  const cwd = safeCwd(options.cwd);
  const instructionsPath = safeRequestPath(options.instructions);
  const reservation = reserveResultPath(options.request);
  try {
    const request = {
      schemaVersion: REQUEST_SCHEMA_VERSION,
      instructions: decodeUtf8(readFileSync(instructionsPath), 'instructions file'),
    };
    if (options.timeout_ms !== undefined) request.timeoutMs = Number(options.timeout_ms);
    if (options.model !== undefined) request.model = options.model;
    if (options.effort !== undefined) request.effort = options.effort;
    if (options.provider === 'codex') {
      const approval = {
        schemaVersion: COORDINATOR_APPROVAL_SCHEMA_VERSION,
        approvalId: `handoff-command-${randomUUID()}`,
        issuer: 'handoff-slash-command',
        provider: 'codex',
        role: options.role,
        cwd,
        scope: 'all-applicable-agents-rules',
        rules: discoverCoordinatorAgentsRules(cwd),
      };
      approval.subjectHash = codexApprovalSubjectHash({ request, approval });
      request.coordinatorApproval = approval;
    }
    const serialized = `${JSON.stringify(request)}\n`;
    parseMachineRequest(Buffer.from(serialized));
    writeReservedResult(reservation, serialized);
    return {
      schemaVersion: 'handoff.prepared-request.v0.3',
      status: 'prepared',
      provider: options.provider,
      role: options.role,
      request: reservation.path,
      requestHash: sha256(Buffer.from(serialized)),
      coordinatorApproval: options.provider === 'codex' ? 'repository-rules-bound' : 'not-required',
    };
  } catch (error) {
    closeReservedResult(reservation);
    try { rmSync(reservation.path, { force: true }); } catch { /* exact reserved path only */ }
    throw error;
  }
}

try {
  process.stdout.write(`${JSON.stringify(prepare(parseArgs(process.argv.slice(2))))}\n`);
} catch (error) {
  process.stderr.write(`handoff request rejected: ${error.message}\n`);
  process.exitCode = 5;
}
