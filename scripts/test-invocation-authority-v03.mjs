import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { acquireRootInvocationAuthority, assertMachineInvocationAuthority } from './lib/invocation-authority.mjs';
import { cleanupV03, DRIVER, setupV03 } from './test-v03-e2e-helpers.mjs';

test('active root lease blocks environment-stripped root re-entry and direct machine execution', () => {
  const context = setupV03();
  const authority = acquireRootInvocationAuthority();
  try {
    assert.doesNotThrow(() => assertMachineInvocationAuthority());
    const resultPath = join(context.root, 'reentry.json');
    const environment = { ...process.env, PATH: `${context.bin}:${process.env.PATH || ''}` };
    delete environment.HANDOFF_SUPERVISOR_CONTEXT;
    const reentry = spawnSync(process.execPath, [
      DRIVER, 'advice', '--caller-harness', 'claude', '--harness', 'grok', '--cwd', context.repo,
      '--instructions', context.instructions, '--result', resultPath,
    ], { cwd: context.repo, encoding: 'utf8', env: environment });
    assert.equal(reentry.status, 5, reentry.stderr);
    assert.match(reentry.stderr, /another root Handoff is active/u);
    assert.equal(existsSync(resultPath), false);

    const direct = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { executeMachineRun } from ${JSON.stringify(new URL('./lib/machine.mjs', import.meta.url).href)};
      try { await executeMachineRun({}); process.exitCode = 99; }
      catch (error) { process.stderr.write(error.message); }
    `], { cwd: context.repo, encoding: 'utf8', env: environment });
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stderr, /reserved to the active root Handoff process/u);
  } finally {
    authority.release();
    cleanupV03(context);
  }
});
