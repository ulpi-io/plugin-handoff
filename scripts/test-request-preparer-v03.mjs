import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareV03Request } from './lib/request-preparer.mjs';

const cwd = process.cwd();
const instructionsPath = new URL('../README.md', import.meta.url).pathname;

test('intent hash is semantic and independent from recursive identity and budgets', () => {
  const temp = mkdtempSync(join(tmpdir(), 'handoff-prepare-test-'));
  try {
    const root = prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'claude', cwd, instructionsPath, tempRoot: temp });
    const common = {
      verb: 'advice', operation: 'advice', callerHarness: 'claude', targetHarness: 'grok', cwd, instructionsPath, tempRoot: temp,
      provenance: 'supervisor-derived', parentGrants: root.request.grants, parentDelegation: root.request.delegation, limits: root.request.budgets.limits,
    };
    const first = prepareV03Request({ ...common, lineage: { rootRunId: root.request.lineage.runId, runId: 'child-one', parentRunId: root.request.lineage.runId, depth: 1, dependencies: [] }, budgets: root.request.budgets });
    const second = prepareV03Request({ ...common, lineage: { rootRunId: root.request.lineage.runId, runId: 'child-two', parentRunId: root.request.lineage.runId, depth: 1, dependencies: [{ type: 'advises', runId: root.request.lineage.runId }] }, budgets: { limits: root.request.budgets.limits, remaining: { nodes: 1, adviceNodes: 1, handoffNodes: 1 } } });
    assert.equal(first.request.intentHash, second.request.intentHash);
    assert.notEqual(first.requestHash, second.requestHash);
    const changed = prepareV03Request({ ...common, model: 'grok-code-fast', lineage: { rootRunId: root.request.lineage.runId, runId: 'child-three', parentRunId: root.request.lineage.runId, depth: 1, dependencies: [] }, budgets: root.request.budgets });
    assert.notEqual(changed.request.intentHash, first.request.intentHash);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('preparation rejects caller provenance and unsafe paths before producing bytes', () => {
  assert.throws(() => prepareV03Request({ verb: 'run', operation: 'handoff', callerHarness: 'grok', targetHarness: 'claude', mode: 'build', cwd, instructionsPath, tempRoot: '/tmp' }), /codex\|claude/);
  assert.throws(() => prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'claude', targetHarness: 'grok', cwd: '.', instructionsPath, tempRoot: '/tmp' }), /absolute/);
});
