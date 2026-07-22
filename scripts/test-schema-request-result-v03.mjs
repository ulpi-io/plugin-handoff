import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMachineRequest, parseMachineResultV03 } from './lib/contracts.mjs';
import { prepareV03Request } from './lib/request-preparer.mjs';

const cwd = process.cwd();
const instructionsPath = new URL('../README.md', import.meta.url).pathname;

function prepared(operation = 'advice') {
  return prepareV03Request({ verb: operation === 'advice' ? 'advice' : 'run', operation, callerHarness: 'claude', targetHarness: 'grok', mode: operation === 'handoff' ? 'review' : null, cwd, instructionsPath, tempRoot: '/tmp' });
}

test('root advice and handoff requests validate with explicit provenance', () => {
  for (const operation of ['advice', 'handoff']) {
    const value = prepared(operation);
    assert.equal(parseMachineRequest(value.bytes).operation, operation);
    assert.equal(value.request.caller.provenance, 'root-asserted');
  }
});

test('request validation rejects unknown fields, missing provenance, write advice, and missing handoff mode', () => {
  const base = prepared().request;
  assert.throws(() => parseMachineRequest(Buffer.from(JSON.stringify({ ...base, surprise: true }))), /unknown field/);
  assert.throws(() => parseMachineRequest(Buffer.from(JSON.stringify({ ...base, caller: { harness: 'claude' } }))), /missing required/);
  assert.throws(() => parseMachineRequest(Buffer.from(JSON.stringify({ ...base, grants: { ...base.grants, resolved: { ...base.grants.resolved, write: true } } }))), /advice cannot/);
  const handoff = prepared('handoff').request;
  assert.throws(() => parseMachineRequest(Buffer.from(JSON.stringify({ ...handoff, mode: null }))), /handoff request.mode/);
});

test('terminal v0.3 results define response semantics', () => {
  const request = prepared().request;
  const result = {
    schemaVersion: 'handoff.result.v0.3', driverVersion: '0.4.0', bundleVersion: '0.4.0', bundleDigest: `sha256:${'0'.repeat(64)}`,
    operation: 'advice', caller: request.caller, target: { harness: 'grok', version: 'fake' }, mode: null,
    requestHash: `sha256:${'1'.repeat(64)}`, intentHash: request.intentHash, selection: request.selection, grants: request.grants, delegation: request.delegation, lineage: request.lineage,
    status: 'succeeded', exit: { driver: 0, provider: 0, signal: null, timedOut: false, cancelled: false },
    output: { response: 'The answer.', evidence: [], findings: [] }, git: {},
    timing: { startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), durationMs: 1 },
    usage: { source: 'not-reported', inputTokens: null, outputTokens: null, totalTokens: null }, policy: {}, dag: null,
    diagnostics: { message: null, providerStderr: '', providerStdout: '', truncated: false, redactionCount: 0 },
  };
  assert.equal(parseMachineResultV03(Buffer.from(JSON.stringify(result))).output.response, 'The answer.');
  assert.throws(() => parseMachineResultV03(Buffer.from(JSON.stringify({ ...result, output: { ...result.output, response: '' } }))), /must not be empty/);
});
