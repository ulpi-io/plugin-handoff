import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMachineRequest } from './lib/contracts.mjs';
import { resolveBudgets, resolveDelegation, resolveSelection, validateOperation } from './lib/selection.mjs';

test('selection defaults and provenance are pinned per operation and harness', () => {
  assert.deepEqual(resolveSelection({ operation: 'advice', targetHarness: 'claude' }), {
    requested: { model: null, effort: null, maxTurns: null },
    resolved: { model: 'provider-default', effort: 'max', maxTurns: 32 },
    provenance: { model: 'provider-default', effort: 'operation-default', maxTurns: 'operation-default' },
  });
  assert.equal(resolveSelection({ operation: 'handoff', targetHarness: 'grok' }).resolved.maxTurns, 12);
  assert.equal(resolveSelection({ operation: 'advice', targetHarness: 'cursor' }).resolved.effort, 'provider-default');
  assert.throws(() => resolveSelection({ operation: 'advice', targetHarness: 'cursor', effort: 'high' }), /unsupported/);
  assert.throws(() => resolveSelection({ operation: 'advice', targetHarness: 'grok', maxTurns: 101 }), /1 through 100/);
});

test('caller and operation combinations fail closed', () => {
  assert.doesNotThrow(() => validateOperation({ operation: 'advice', callerHarness: 'kiro', targetHarness: 'codex', mode: null }));
  assert.throws(() => validateOperation({ operation: 'handoff', callerHarness: 'grok', targetHarness: 'codex', mode: 'build' }), /codex\|claude/);
  assert.throws(() => validateOperation({ operation: 'advice', callerHarness: 'codex', targetHarness: 'claude', mode: 'review' }), /does not accept/);
  assert.deepEqual(resolveBudgets(), { maxDepth: 3, maxNodes: 16, maxAdviceNodes: 12, maxHandoffNodes: 4, maxConcurrency: 4, rootTimeoutMs: 1800000, timeoutMs: 600000 });
});

test('delegation is derived from the root verb or attenuated parent only', () => {
  assert.deepEqual(resolveDelegation({ verb: 'run' }), { mode: 'none', provenance: 'verb-derived' });
  assert.deepEqual(resolveDelegation({ verb: 'run-with-advice' }), { mode: 'advice-only', provenance: 'verb-derived' });
  assert.deepEqual(resolveDelegation({ verb: 'advice' }), { mode: 'advice-only', provenance: 'verb-derived' });
  assert.deepEqual(resolveDelegation({ verb: 'advice', parent: { mode: 'advice-only' } }), { mode: 'advice-only', provenance: 'parent-attenuated' });
  assert.throws(() => resolveDelegation({ verb: 'run', parent: { mode: 'advice-only' } }), /advice only/);
  assert.throws(() => resolveDelegation({ verb: 'advice', parent: { mode: 'none' } }), /advice-only parent/);
  assert.throws(() => resolveDelegation({ verb: 'legacy-run' }), /root verb/);
});

test('legacy requests are rejected without a compatibility fallback', () => {
  const legacy = Buffer.from('{"schemaVersion":"handoff.request.v0.2","instructions":"review"}\n');
  assert.throws(() => parseMachineRequest(legacy), /v0.3/);
});
