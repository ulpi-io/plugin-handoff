import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeNestedRequest, hasSupervisorContext } from './lib/nested-client.mjs';

test('nested client rejects worker-authored caller and root budgets before IPC', async () => {
  const base = { operation: 'advice', targetHarness: 'grok', cwd: process.cwd(), instructionsPath: new URL('../README.md', import.meta.url).pathname, result: join(tmpdir(), `handoff-never-${process.pid}.json`) };
  await assert.rejects(() => executeNestedRequest({ ...base, callerHarness: 'claude' }, { contextRaw: '{}' }), /must not supply/);
  await assert.rejects(() => executeNestedRequest({ ...base, limits: { maxNodes: 2 } }, { contextRaw: '{}' }), /root budget/);
});

test('nested client rejects malformed context and pre-existing result paths', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'handoff-nested-test-'));
  try {
    const result = join(temp, 'result.json');
    writeFileSync(result, 'occupied');
    const options = { operation: 'advice', targetHarness: 'grok', cwd: process.cwd(), instructionsPath: new URL('../README.md', import.meta.url).pathname, result };
    await assert.rejects(() => executeNestedRequest(options, { contextRaw: '{bad' }), /malformed/);
    const context = JSON.stringify({ schemaVersion: 'handoff.supervisor-context.v0.3', endpoint: join(temp, 'missing.sock'), token: 'token', callerHarness: 'claude', rootRunId: 'root', allowedOperations: ['advice'] });
    await assert.rejects(() => executeNestedRequest(options, { contextRaw: context }), /already exists/);
    assert.equal(hasSupervisorContext({ HANDOFF_SUPERVISOR_CONTEXT: context }), true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
