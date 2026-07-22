import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupV03, DRIVER, invokeV03, setupV03 } from './test-v03-e2e-helpers.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('sealed root handoff carries exact routing, selection, grants, budgets, and response', () => {
  const context = setupV03();
  try {
    const invocationCapture = join(context.root, 'plain-invocation.json');
    const promptCapture = join(context.root, 'plain-prompt.txt');
    const { proc, parsed } = invokeV03(context, {
      operation: 'run', caller: 'codex', target: 'grok', mode: 'build',
      extraEnv: { HANDOFF_FAKE_INVOCATION_CAPTURE: invocationCapture, HANDOFF_FAKE_PROMPT_CAPTURE: promptCapture },
      extraArgs: [
        '--model', 'grok-code-fast', '--effort', 'high', '--max-turns', '12',
        '--bash', 'true', '--web-search', 'false', '--max-depth', '2',
        '--max-nodes', '4', '--max-advice-nodes', '2', '--max-handoff-nodes', '2',
        '--max-concurrency', '2', '--root-timeout-ms', '120000', '--timeout-ms', '30000',
      ],
    });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(parsed.operation, 'handoff');
    assert.deepEqual(parsed.caller, { harness: 'codex', provenance: 'root-asserted' });
    assert.equal(parsed.target.harness, 'grok');
    assert.equal(parsed.mode, 'build');
    assert.equal(parsed.selection.resolved.model, 'grok-code-fast');
    assert.equal(parsed.selection.resolved.effort, 'high');
    assert.equal(parsed.selection.resolved.maxTurns, 12);
    assert.equal(parsed.grants.resolved.write, true);
    assert.equal(parsed.grants.resolved.webSearch, false);
    assert.deepEqual(parsed.delegation, { mode: 'none', provenance: 'verb-derived' });
    assert.equal(parsed.output.response, 'fake build completed');
    assert.equal(parsed.git.changed, true);
    assert.equal(parsed.dag.limits.maxNodes, 4);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(invocationCapture, 'utf8')).env, 'HANDOFF_SUPERVISOR_CONTEXT'), false);
    assert.match(readFileSync(promptCapture, 'utf8'), /No nested supervisor capability is available/u);
  } finally { cleanupV03(context); }
});

test('run-with-advice exposes only the advice affordance and receipt', () => {
  const context = setupV03();
  try {
    const invocationCapture = join(context.root, 'enabled-invocation.json');
    const promptCapture = join(context.root, 'enabled-prompt.txt');
    const { proc, parsed } = invokeV03(context, {
      operation: 'run-with-advice', caller: 'claude', target: 'grok', mode: 'review',
      resultName: 'enabled.json',
      extraEnv: { HANDOFF_FAKE_INVOCATION_CAPTURE: invocationCapture, HANDOFF_FAKE_PROMPT_CAPTURE: promptCapture },
    });
    assert.equal(proc.status, 0, proc.stderr);
    assert.deepEqual(parsed.delegation, { mode: 'advice-only', provenance: 'verb-derived' });
    const captured = JSON.parse(readFileSync(invocationCapture, 'utf8'));
    assert.equal(typeof captured.env.HANDOFF_SUPERVISOR_CONTEXT, 'string');
    const supervisor = JSON.parse(captured.env.HANDOFF_SUPERVISOR_CONTEXT);
    assert.deepEqual(supervisor.allowedOperations, ['advice']);
    const prompt = readFileSync(promptCapture, 'utf8');
    assert.match(prompt, /only delegated supervisor operation is nested read-only advice/u);
    assert.match(prompt, /Do not invoke run or run-with-advice/u);
  } finally { cleanupV03(context); }
});

test('wrong root routing and unsupported selection fail before a provider launch', () => {
  for (const scenario of [
    { caller: 'grok', operation: 'run', mode: 'review', target: 'claude', message: /codex\|claude/u },
    { caller: 'claude', target: 'cursor', extraArgs: ['--effort', 'max'], message: /unsupported for cursor/u },
    { caller: 'codex', target: 'codex', extraArgs: ['--web-search', 'true'], message: /webSearch is unsupported for codex/u },
  ]) {
    const context = setupV03();
    try {
      const marker = join(context.root, 'provider-invoked');
      const resultPath = join(context.root, 'rejected.json');
      const args = [DRIVER, scenario.operation ?? 'advice', '--caller-harness', scenario.caller, '--harness', scenario.target];
      if (scenario.mode) args.push('--mode', scenario.mode);
      args.push('--cwd', context.repo, '--instructions', context.instructions, '--result', resultPath, ...(scenario.extraArgs ?? []));
      const proc = spawnSync(process.execPath, args, {
        cwd: context.repo, encoding: 'utf8',
        env: { ...process.env, PATH: `${context.bin}:${process.env.PATH || ''}`, HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
      });
      assert.equal(proc.status, 5, proc.stderr);
      assert.match(proc.stderr, scenario.message);
      assert.equal(existsSync(marker), false);
      assert.equal(JSON.parse(proc.stdout).status, 'rejected');
    } finally { cleanupV03(context); }
  }
});

test('removed machine command and version-selection forms reject without a provider launch', () => {
  const context = setupV03();
  try {
    const marker = join(context.root, 'removed-provider-invoked');
    for (const args of [
      [DRIVER, 'run', '--provider', 'grok', '--role', 'review', '--cwd', context.repo, '--request', context.instructions, '--result', join(context.root, 'legacy.json')],
      [DRIVER, 'capabilities', '--json', '--version', 'v0.3'],
    ]) {
      const proc = spawnSync(process.execPath, args, {
        cwd: context.repo, encoding: 'utf8',
        env: { ...process.env, PATH: `${context.bin}:${process.env.PATH || ''}`, HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
      });
      assert.equal(proc.status, 5, proc.stderr);
      assert.equal(JSON.parse(proc.stdout).status, 'rejected');
      assert.equal(existsSync(marker), false);
    }
  } finally { cleanupV03(context); }
});

test('bundle drift, provider failure, malformed output, and occupied results are non-green', () => {
  const cases = [
    { fakeMode: 'exit', status: 2, resultName: 'provider-failed.json' },
    { fakeMode: 'unknown-field', status: 7, resultName: 'malformed.json' },
  ];
  for (const scenario of cases) {
    const context = setupV03();
    try {
      const { proc, parsed } = invokeV03(context, scenario);
      assert.equal(proc.status, scenario.status, proc.stderr);
      assert.notEqual(parsed.status, 'succeeded');
    } finally { cleanupV03(context); }
  }

  const occupied = setupV03();
  try {
    const resultPath = join(occupied.root, 'occupied.json');
    writeFileSync(resultPath, 'keep-me\n');
    const proc = spawnSync(process.execPath, [
      DRIVER, 'advice', '--caller-harness', 'grok', '--harness', 'claude', '--cwd', occupied.repo,
      '--instructions', occupied.instructions, '--result', resultPath,
    ], { cwd: occupied.repo, encoding: 'utf8', env: { ...process.env, PATH: `${occupied.bin}:${process.env.PATH || ''}` } });
    assert.equal(proc.status, 5, proc.stderr);
    assert.equal(proc.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(proc.stdout).status, 'rejected');
    assert.equal(readFileSync(resultPath, 'utf8'), 'keep-me\n');
  } finally { cleanupV03(occupied); }

  const drift = setupV03();
  try {
    const copy = join(drift.root, 'plugin-copy');
    mkdirSync(copy);
    for (const entry of ['.claude-plugin', '.codex-plugin', 'bundle-digest.json', 'commands', 'contracts', 'scripts', 'skills']) {
      cpSync(join(pluginRoot, entry), join(copy, entry), { recursive: true });
    }
    appendFileSync(join(copy, 'scripts/lib/selection.mjs'), '\n// deliberate E2E digest drift\n');
    const marker = join(drift.root, 'drift-provider-invoked');
    const resultPath = join(drift.root, 'drift.json');
    const proc = spawnSync(process.execPath, [
      realpathSync(join(copy, 'scripts/handoff.mjs')), 'advice', '--caller-harness', 'grok', '--harness', 'claude',
      '--cwd', drift.repo, '--instructions', drift.instructions, '--result', resultPath,
    ], {
      cwd: drift.repo, encoding: 'utf8',
      env: { ...process.env, PATH: `${drift.bin}:${process.env.PATH || ''}`, HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(proc.status, 2, proc.stderr);
    const parsed = JSON.parse(proc.stdout);
    assert.match(parsed.diagnostics.message, /bundle digest mismatch/u);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(resultPath), false);
  } finally { cleanupV03(drift); }
});
