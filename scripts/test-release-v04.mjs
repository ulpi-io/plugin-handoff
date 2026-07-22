import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeBundleDigest, readBundleDigest } from './lib/bundle.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '..');
const SUITES = Object.freeze([
  'test-agents-policy-v03.mjs',
  'test-capability-grants-v03.mjs',
  'test-contracts-selection-v03.mjs',
  'test-dag-v03.mjs',
  'test-frontend-v03.mjs',
  'test-handoff-surface-matrix-v03.mjs',
  'test-invocation-authority-v03.mjs',
  'test-machine-v03.mjs',
  'test-nested-client-v03.mjs',
  'test-plugin-manifests-v03.mjs',
  'test-provider-capabilities-installed-v03.mjs',
  'test-provider-claude-v03.mjs',
  'test-provider-codex-v03.mjs',
  'test-provider-cursor-v03.mjs',
  'test-provider-grok-v03.mjs',
  'test-provider-kiro-v03.mjs',
  'test-provider-opencode-v03.mjs',
  'test-request-preparer-v03.mjs',
  'test-schema-dag-capabilities-v03.mjs',
  'test-schema-provider-mcp-v03.mjs',
  'test-schema-request-result-v03.mjs',
  'test-supervisor-v03.mjs',
  'test-frontend-machine-v03-e2e.mjs',
  'test-advice-dag-e2e.mjs',
]);

test('v0.4 release gate verifies the seal and runs the complete deterministic suite list', () => {
  const discovered = readdirSync(scripts)
    .filter((name) => /^test-.*\.mjs$/u.test(name) && !['test-release-v04.mjs', 'test-v03-e2e-helpers.mjs'].includes(name))
    .sort();
  assert.deepEqual([...SUITES].sort(), discovered, 'release suite list is missing or naming an unexpected test');

  const manifestBefore = readFileSync(resolve(root, 'bundle-digest.json'));
  const digestBefore = computeBundleDigest();
  const manifest = readBundleDigest();
  assert.equal(manifest.bundleVersion, '0.4.0');
  assert.equal(manifest.digest, digestBefore);
  for (const removed of ['contracts/v0.2', 'scripts/prepare-request.mjs', 'scripts/test-pipeline-e2e.mjs']) assert.equal(existsSync(resolve(root, removed)), false, `${removed} must stay removed`);

  const check = spawnSync(process.execPath, [resolve(scripts, 'bundle-digest.mjs'), '--check'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);

  const childEnvironment = { ...process.env, HANDOFF_RELEASE_GATE: '1' };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...SUITES.map((name) => resolve(scripts, name))], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnvironment,
  });
  assert.equal(run.signal, null, `release suite terminated by ${run.signal}\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const count = /^ℹ tests (\d+)$/mu.exec(run.stdout);
  assert.ok(count && Number(count[1]) >= 50, `child test runner did not execute the complete suite list:\n${run.stdout}\n${run.stderr}`);

  assert.deepEqual(readFileSync(resolve(root, 'bundle-digest.json')), manifestBefore, 'release gate modified the bundle manifest');
  assert.equal(computeBundleDigest(), digestBefore, 'release gate modified a covered byte');
});
