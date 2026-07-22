import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HandoffSupervisor } from './lib/supervisor.mjs';
import { prepareV03Request } from './lib/request-preparer.mjs';

const cwd = process.cwd();
const instructionsPath = new URL('../README.md', import.meta.url).pathname;

function successfulResult(request) {
  return {
    schemaVersion: 'handoff.result.v0.3', driverVersion: '0.4.0', bundleVersion: '0.4.0', bundleDigest: `sha256:${'0'.repeat(64)}`,
    operation: request.operation, caller: request.caller, target: { harness: request.target.harness, version: 'fake' }, mode: request.mode,
    requestHash: `sha256:${'1'.repeat(64)}`, intentHash: request.intentHash, selection: request.selection, grants: request.grants, delegation: request.delegation, lineage: request.lineage,
    status: 'succeeded', exit: { driver: 0, provider: 0, signal: null, timedOut: false, cancelled: false },
    output: { response: 'nested answer', evidence: [], findings: [] }, git: {},
    timing: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0 },
    usage: { source: 'not-reported', inputTokens: null, outputTokens: null, totalTokens: null }, policy: {}, dag: null,
    diagnostics: { message: null, providerStderr: '', providerStdout: '', truncated: false, redactionCount: 0 },
  };
}

test('supervisor derives caller and lineage, executes one authority, and rejects token replay', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'handoff-supervisor-test-'));
  let supervisor;
  try {
    const root = prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'claude', cwd, instructionsPath, tempRoot: temp });
    let executions = 0;
    supervisor = new HandoffSupervisor({ rootPrepared: root, cleanup: false, executeMachineRun: async (options) => {
      executions += 1;
      const request = JSON.parse(readFileSync(options.request, 'utf8'));
      const result = successfulResult(request);
      writeFileSync(options.result, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
      return { result, exitCode: 0 };
    } });
    const context = JSON.parse(supervisor.contextForRoot());
    const message = {
      schemaVersion: 'handoff.supervisor-request.v0.3', token: context.token, nonce: 'one', operation: 'advice', targetHarness: 'grok', mode: null,
      cwd, instructions: 'Give a bounded answer.', selection: {}, grants: { bash: false, webSearch: false }, mcp: null, dependencies: [],
    };
    const reply = await supervisor.handleFrame(Buffer.from(JSON.stringify(message)));
    assert.equal(reply.ok, true);
    assert.equal(executions, 1);
    const nested = supervisor.runtime.store.snapshot().nodes.find((node) => node.runId !== root.request.lineage.runId);
    assert.equal(nested.callerHarness, 'claude');
    assert.equal(nested.parentRunId, root.request.lineage.runId);
    await assert.rejects(() => supervisor.handleFrame(Buffer.from(JSON.stringify(message))), /replayed/);
    await assert.rejects(() => supervisor.handleFrame(Buffer.from(JSON.stringify({ ...message, token: 'forged', nonce: 'two' }))), /invalid/);
    await assert.rejects(() => supervisor.handleFrame(Buffer.from(JSON.stringify({ ...message, nonce: 'handoff', operation: 'handoff', mode: 'build' }))), /nested advice only/);
  } finally {
    if (supervisor) await supervisor.close('cancelled');
    rmSync(temp, { recursive: true, force: true });
    if (supervisor) rmSync(supervisor.runtime.directory, { recursive: true, force: true });
  }
});
