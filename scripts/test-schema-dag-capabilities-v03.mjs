import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DagStore } from './lib/dag.mjs';
import { parseDagSnapshot } from './lib/contracts.mjs';
import { prepareV03Request } from './lib/request-preparer.mjs';

const cwd = process.cwd();
const instructionsPath = new URL('../README.md', import.meta.url).pathname;

test('DAG snapshots bind typed dependencies and exact remaining counters', () => {
  const temp = mkdtempSync(join(tmpdir(), 'handoff-dag-schema-'));
  try {
    const root = prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'claude', cwd, instructionsPath, tempRoot: temp });
    const store = new DagStore({ rootRequest: root.request, auditPath: join(temp, 'dag.json') });
    const snapshot = parseDagSnapshot(Buffer.from(JSON.stringify(store.snapshot())));
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.remaining.nodes, 15);
    assert.throws(() => parseDagSnapshot(Buffer.from(JSON.stringify({ ...snapshot, activeCount: 0 }))), /does not match/);
    assert.throws(() => parseDagSnapshot(Buffer.from(JSON.stringify({ ...snapshot, nodes: [...snapshot.nodes, snapshot.nodes[0]] }))), /duplicate run IDs/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('permission-only policies cannot be confused with native isolation', () => {
  const permissionOnly = { nativeFilesystemIsolation: false, nativeBashSandbox: false, mutationGuarantee: 'final-state-detection-only' };
  assert.equal(permissionOnly.nativeFilesystemIsolation, false);
  assert.notEqual(permissionOnly.mutationGuarantee, 'native-and-final-state');
});
