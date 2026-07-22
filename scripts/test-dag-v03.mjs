import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DagStore, scavengeSupervisorRuntimes } from './lib/dag.mjs';
import { parseDagSnapshot } from './lib/contracts.mjs';
import { prepareV03Request } from './lib/request-preparer.mjs';

const cwd = process.cwd();
const instructionsPath = new URL('../README.md', import.meta.url).pathname;

test('DAG registration is atomic, dependency-aware, and rejects ancestor intent repetition', () => {
  const temp = mkdtempSync(join(tmpdir(), 'handoff-dag-test-'));
  try {
    const root = prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'claude', cwd, instructionsPath, tempRoot: temp });
    const auditPath = join(temp, 'dag.json');
    const store = new DagStore({ rootRequest: root.request, auditPath });
    const child = prepareV03Request({
      verb: 'advice', operation: 'advice', callerHarness: 'claude', targetHarness: 'grok', cwd, instructionsPath, tempRoot: temp,
      provenance: 'supervisor-derived', parentGrants: root.request.grants, parentDelegation: root.request.delegation,
      lineage: { rootRunId: root.request.lineage.runId, runId: 'child', parentRunId: root.request.lineage.runId, depth: 1, dependencies: [] },
      limits: root.request.budgets.limits, budgets: root.request.budgets,
    });
    store.register(child.request, child.requestHash);
    const before = readFileSync(auditPath);
    const repeat = prepareV03Request({
      verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'grok', cwd, instructionsPath, tempRoot: temp,
      provenance: 'supervisor-derived', parentGrants: child.request.grants, parentDelegation: child.request.delegation,
      lineage: { rootRunId: root.request.lineage.runId, runId: 'repeat', parentRunId: 'child', depth: 2, dependencies: [] },
      limits: root.request.budgets.limits, budgets: root.request.budgets,
    });
    assert.throws(() => store.register(repeat.request, repeat.requestHash), /repeated intent/);
    assert.deepEqual(readFileSync(auditPath), before);
    store.terminalize('child', { state: 'succeeded', resultBytes: Buffer.from('result') });
    assert.equal(parseDagSnapshot(readFileSync(auditPath)).nodes.find((node) => node.runId === 'child').state, 'succeeded');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('orphan scavenging removes only private dead-PID runtimes older than 24 hours', () => {
  const base = mkdtempSync(join(tmpdir(), 'handoff-scavenge-test-'));
  try {
    const uid = process.getuid();
    const stale = join(base, `handoff-v03-${uid}-999999-stale`);
    const ambiguous = join(base, `handoff-v03-${uid}-999998-open`);
    mkdirSync(stale, { mode: 0o700 });
    mkdirSync(ambiguous, { mode: 0o755 });
    chmodSync(ambiguous, 0o755);
    const old = new Date(Date.now() - 90_000_000);
    utimesSync(stale, old, old);
    utimesSync(ambiguous, old, old);
    assert.deepEqual(scavengeSupervisorRuntimes({ base }), [stale]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
