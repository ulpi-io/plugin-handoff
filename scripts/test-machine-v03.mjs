import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupV03, invokeV03, setupV03 } from './test-v03-e2e-helpers.mjs';

test('v0.3 advice crosses request, machine, provider, result, Git, and DAG boundaries', () => {
  const context = setupV03();
  try {
    const { proc, parsed } = invokeV03(context, { target: 'claude', extraArgs: ['--model', 'fable', '--effort', 'max', '--max-turns', '32', '--bash', 'true', '--web-search', 'true'] });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(parsed.schemaVersion, 'handoff.result.v0.3');
    assert.equal(parsed.status, 'succeeded');
    assert.match(parsed.output.response, /fake review completed/);
    assert.equal(parsed.selection.resolved.model, 'fable');
    assert.equal(parsed.selection.resolved.maxTurns, 32);
    assert.equal(parsed.grants.resolved.write, false);
    assert.deepEqual(parsed.delegation, { mode: 'advice-only', provenance: 'verb-derived' });
    assert.equal(parsed.git.changed, false);
    assert.equal(parsed.dag.nodes.length, 1);
  } finally { cleanupV03(context); }
});

test('v0.3 invalid output, read-only mutation, and write-without-change remain non-green', () => {
  for (const scenario of [
    { fakeMode: 'prose', resultName: 'prose.json', status: 7 },
    { fakeMode: 'review-mutation', resultName: 'mutation.json', status: 10 },
    { operation: 'run', caller: 'claude', target: 'grok', mode: 'build', fakeMode: 'no-change', resultName: 'no-change.json', status: 10 },
  ]) {
    const context = setupV03();
    try {
      const { proc, parsed } = invokeV03(context, scenario);
      assert.equal(proc.status, scenario.status, proc.stderr);
      assert.notEqual(parsed.status, 'succeeded');
    } finally { cleanupV03(context); }
  }
});
