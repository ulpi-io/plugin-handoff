import { randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync } from 'node:fs';

import { resolveGrants } from './capability-grants.mjs';
import { createCodexCoordinatorApprovalV03 } from './agents-policy.mjs';
import {
  REQUEST_SCHEMA_VERSION_V03,
  canonicalJson,
  decodeUtf8,
  parseMachineRequest,
  sha256,
} from './contracts.mjs';
import { safeCwd, safeRequestPath } from './paths.mjs';
import { resolveBudgets, resolveDelegation, resolveSelection, validateOperation } from './selection.mjs';

function readStable(path, label) {
  const canonical = safeRequestPath(path);
  const fd = openSync(canonical, 'r');
  try {
    const before = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`${label} changed while being read`);
    return { path: canonical, bytes };
  } finally {
    closeSync(fd);
  }
}

export function computeIntentHash({ operation, targetHarness, mode = null, cwd, instructions, selection, grants, delegation }) {
  const semantic = {
    schemaVersion: 'handoff.intent.v0.3',
    operation,
    targetHarness,
    mode: mode ?? null,
    cwd,
    instructions,
    selection: selection.resolved,
    grants: {
      resolved: grants.resolved,
      mcpDigest: grants.mcp.digest,
      mcpServers: grants.mcp.servers,
    },
    delegation,
  };
  return sha256(Buffer.from(canonicalJson(semantic)));
}

function rootLineage(runId = `run-${randomUUID()}`) {
  return { rootRunId: runId, runId, parentRunId: null, depth: 0, dependencies: [] };
}

function initialBudgets(limits, operation) {
  return {
    limits,
    remaining: {
      nodes: limits.maxNodes - 1,
      adviceNodes: limits.maxAdviceNodes - (operation === 'advice' ? 1 : 0),
      handoffNodes: limits.maxHandoffNodes - (operation === 'handoff' ? 1 : 0),
    },
  };
}

export function prepareV03Request(options) {
  if (Object.hasOwn(options, 'delegation')) throw new Error('delegation is derived and must not be supplied');
  const provenance = options.provenance ?? 'root-asserted';
  const delegation = resolveDelegation({ verb: options.verb, parent: options.parentDelegation ?? null });
  const expectedOperation = options.verb === 'advice' ? 'advice' : 'handoff';
  if (options.operation !== expectedOperation) throw new Error('verb and operation are inconsistent');
  validateOperation({
    operation: options.operation,
    callerHarness: options.callerHarness,
    targetHarness: options.targetHarness,
    mode: options.mode ?? null,
    provenance,
  });
  const cwd = safeCwd(options.cwd);
  const instructionFile = readStable(options.instructionsPath, 'instructions file');
  const instructions = decodeUtf8(instructionFile.bytes, 'instructions file');
  const selection = resolveSelection({
    operation: options.operation,
    targetHarness: options.targetHarness,
    model: options.model,
    effort: options.effort,
    maxTurns: options.maxTurns,
  });
  const { receipt: grants, internal } = resolveGrants({
    operation: options.operation,
    mode: options.mode ?? null,
    targetHarness: options.targetHarness,
    bash: options.bash,
    webSearch: options.webSearch,
    mcpConfig: options.mcpConfig,
    parent: options.parentGrants,
    tempRoot: options.tempRoot,
  });
  const limits = options.limits ? resolveBudgets(options.limits) : resolveBudgets();
  const lineage = options.lineage ? structuredClone(options.lineage) : rootLineage(options.runId);
  const budgets = options.budgets ? structuredClone(options.budgets) : initialBudgets(limits, options.operation);
  const intentHash = computeIntentHash({ operation: options.operation, targetHarness: options.targetHarness, mode: options.mode ?? null, cwd, instructions, selection, grants, delegation });
  const request = {
    schemaVersion: REQUEST_SCHEMA_VERSION_V03,
    operation: options.operation,
    caller: { harness: options.callerHarness, provenance },
    target: { harness: options.targetHarness },
    mode: options.mode ?? null,
    cwd,
    instructions,
    selection,
    grants,
    delegation,
    lineage,
    budgets,
    intentHash,
  };
  if (options.coordinatorApproval) request.coordinatorApproval = options.coordinatorApproval;
  else if (options.targetHarness === 'codex') {
    request.coordinatorApproval = createCodexCoordinatorApprovalV03({
      request,
      role: options.operation === 'advice' ? 'review' : options.mode,
      cwd,
    });
  }
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`);
  parseMachineRequest(bytes);
  return {
    request,
    bytes,
    requestHash: sha256(bytes),
    instructionHash: sha256(instructionFile.bytes),
    internal,
  };
}
