import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ContractError } from './contracts.mjs';
import { acquireRootInvocationAuthority, assertFrontendInvocationAuthority } from './invocation-authority.mjs';
import { executeMachineRun, machineCapabilitiesV03 } from './machine.mjs';
import { executeNestedRequest, hasSupervisorContext } from './nested-client.mjs';
import { createSupervisorRuntimeDirectory } from './paths.mjs';
import { prepareV03Request } from './request-preparer.mjs';
import { HandoffSupervisor } from './supervisor.mjs';
import { HARNESSES, MODES } from './selection.mjs';

const ROOT_BUDGET_FLAGS = Object.freeze({
  '--max-depth': 'maxDepth',
  '--max-nodes': 'maxNodes',
  '--max-advice-nodes': 'maxAdviceNodes',
  '--max-handoff-nodes': 'maxHandoffNodes',
  '--max-concurrency': 'maxConcurrency',
  '--root-timeout-ms': 'rootTimeoutMs',
  '--timeout-ms': 'timeoutMs',
});

const VALUE_FLAGS = new Set([
  '--caller-harness', '--harness', '--mode', '--cwd', '--instructions', '--result',
  '--model', '--effort', '--max-turns', '--bash', '--web-search', '--mcp-config', '--dependency',
  ...Object.keys(ROOT_BUDGET_FLAGS),
]);

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new ContractError(`${flag} requires a value`);
  return value;
}

function integer(value, flag) {
  if (!/^\d+$/u.test(value)) throw new ContractError(`${flag} requires a decimal integer`);
  return Number(value);
}

function boolean(value, flag) {
  if (!['true', 'false'].includes(value)) throw new ContractError(`${flag} must be true|false`);
  return value === 'true';
}

function dependency(value) {
  const match = /^(requires|advises|verifies):([^:\s]+)$/u.exec(value);
  if (!match) throw new ContractError('--dependency must be requires:<run-id>|advises:<run-id>|verifies:<run-id>');
  return { type: match[1], runId: match[2] };
}

export function parseFrontendCli(argv, { nested = hasSupervisorContext() } = {}) {
  if (argv[0] === 'capabilities') {
    if (argv.length !== 2 || argv[1] !== '--json') throw new ContractError('usage: capabilities --json');
    return { family: 'capabilities' };
  }
  const verb = argv[0];
  if (!['advice', 'run', 'run-with-advice'].includes(verb)) throw new ContractError("command must be 'capabilities', 'advice', 'run', or 'run-with-advice'");
  if (nested && verb !== 'advice') throw new ContractError('nested Handoff permits advice only');
  const values = {};
  const dependencies = [];
  const limits = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!VALUE_FLAGS.has(flag)) throw new ContractError(`unknown argument: ${flag}`);
    const value = valueAfter(argv, index, flag);
    if (flag === '--dependency') { dependencies.push(dependency(value)); continue; }
    const key = flag.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(values, key)) throw new ContractError(`duplicate argument: ${flag}`);
    if (Object.hasOwn(ROOT_BUDGET_FLAGS, flag)) limits[ROOT_BUDGET_FLAGS[flag]] = integer(value, flag);
    else if (flag === '--max-turns') values.max_turns = integer(value, flag);
    else if (flag === '--bash' || flag === '--web-search') values[key] = boolean(value, flag);
    else values[key] = value;
  }
  const missing = ['harness', 'cwd', 'instructions', 'result'].filter((key) => !values[key]);
  if (!nested && !values.caller_harness) missing.unshift('caller-harness');
  if (missing.length) throw new ContractError(`missing argument(s): ${missing.map((key) => `--${key}`).join(', ')}`);
  if (!HARNESSES.includes(values.harness)) throw new ContractError(`--harness must be ${HARNESSES.join('|')}`);
  if (values.caller_harness && !HARNESSES.includes(values.caller_harness)) throw new ContractError(`--caller-harness must be ${HARNESSES.join('|')}`);
  if (nested && values.caller_harness) throw new ContractError('nested requests must not supply --caller-harness');
  if (nested && Object.keys(limits).length) throw new ContractError('nested requests must not supply root budget flags');
  if (!nested && dependencies.length) throw new ContractError('root requests cannot depend on a pre-existing supervisor node');
  const operation = verb === 'advice' ? 'advice' : 'handoff';
  if (operation === 'advice' && values.mode !== undefined) throw new ContractError('advice does not accept --mode');
  if (operation === 'handoff' && !MODES.includes(values.mode)) throw new ContractError(`run requires --mode ${MODES.join('|')}`);
  if (!nested && operation === 'handoff' && !['codex', 'claude'].includes(values.caller_harness)) throw new ContractError('root run requires --caller-harness codex|claude');
  return {
    family: 'operation',
    nested,
    options: {
      operation,
      verb,
      callerHarness: values.caller_harness,
      targetHarness: values.harness,
      mode: values.mode ?? null,
      cwd: values.cwd,
      instructionsPath: values.instructions,
      result: values.result,
      model: values.model,
      effort: values.effort,
      maxTurns: values.max_turns,
      bash: values.bash,
      webSearch: values.web_search,
      mcpConfig: values.mcp_config,
      dependencies,
      limits,
    },
  };
}

function closureStatus(status) {
  return ['succeeded', 'blocked', 'failed', 'timed_out', 'cancelled'].includes(status) ? status : 'failed';
}

export async function executeFrontend(argv, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const nested = dependencies.nested ?? hasSupervisorContext(environment);
  const parsed = parseFrontendCli(argv, { nested });
  if (parsed.family === 'capabilities') {
    const capabilities = (dependencies.machineCapabilitiesV03 ?? machineCapabilitiesV03)();
    const bytes = Buffer.from(`${JSON.stringify(capabilities)}\n`);
    return { bytes, result: capabilities, exitCode: 0 };
  }
  (dependencies.assertInvocationAuthority ?? assertFrontendInvocationAuthority)({
    nested: parsed.nested,
    verb: parsed.options.verb,
  });
  if (parsed.nested) return (dependencies.executeNestedRequest ?? executeNestedRequest)(parsed.options, { contextRaw: environment.HANDOFF_SUPERVISOR_CONTEXT });

  const authority = (dependencies.acquireRootInvocationAuthority ?? acquireRootInvocationAuthority)();
  let temp = null;
  let supervisor;
  try {
    temp = createSupervisorRuntimeDirectory();
    const prepared = (dependencies.prepareV03Request ?? prepareV03Request)({ ...parsed.options, tempRoot: temp });
    const requestPath = join(temp, 'root-request.json');
    writeFileSync(requestPath, prepared.bytes, { mode: 0o600, flag: 'wx' });
    const Supervisor = dependencies.Supervisor ?? HandoffSupervisor;
    supervisor = new Supervisor({ rootPrepared: prepared, executeMachineRun: dependencies.executeMachineRun ?? executeMachineRun });
    let supervisorContext = null;
    if (prepared.request.delegation.mode === 'advice-only') {
      await supervisor.start();
      supervisorContext = supervisor.contextForRoot();
    }
    const machine = await (dependencies.executeMachineRun ?? executeMachineRun)({
      command: 'run',
      provider: prepared.request.target.harness,
      role: prepared.request.operation === 'advice' ? 'review' : prepared.request.mode,
      cwd: prepared.request.cwd,
      request: requestPath,
      result: parsed.options.result,
      runtime: {
        supervisorContext,
        mcp: prepared.internal,
        dagSnapshot: () => supervisor.runtime.store.snapshot(),
      },
    });
    const serialized = Buffer.from(`${JSON.stringify(machine.result)}\n`);
    let bytes = serialized;
    if (existsSync(parsed.options.result)) {
      const observed = readFileSync(parsed.options.result);
      // The machine result in memory is authoritative. A pre-existing, replaced, or externally
      // modified --result path must never become the frontend's stdout machine object.
      if (observed.equals(serialized)) bytes = observed;
    }
    if (supervisor.runtime.store.nodes.get(prepared.request.lineage.runId)?.state === 'running') {
      supervisor.runtime.store.terminalize(prepared.request.lineage.runId, { state: machine.result.status, resultBytes: bytes });
    }
    await supervisor.close(closureStatus(machine.result.status));
    supervisor = null;
    return { bytes, result: machine.result, exitCode: machine.exitCode };
  } finally {
    if (supervisor) { try { await supervisor.close('cancelled'); } catch { /* retain primary failure */ } }
    if (temp) { try { rmSync(temp, { recursive: true, force: true }); } catch { /* exact frontend temp only */ } }
    authority.release();
  }
}
