#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { gitFingerprint } from './lib/git.mjs';
import { codexApprovalSubjectHash, discoverAgentsRules } from './lib/agents-policy.mjs';
import { sha256 } from './lib/contracts.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const DRIVER = resolve(scriptsDir, 'handoff.mjs');
const PREPARE = resolve(scriptsDir, 'prepare-request.mjs');
const FAKE = resolve(scriptsDir, 'fixtures/fake-provider.mjs');

function command(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${executable} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-e2e-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  command(repo, 'git', ['init', '-q']);
  command(repo, 'git', ['config', 'user.email', 'fake@example.test']);
  command(repo, 'git', ['config', 'user.name', 'Fake Provider']);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  command(repo, 'git', ['add', 'seed.txt']);
  command(repo, 'git', ['commit', '-qm', 'seed']);
  for (const name of ['claude', 'codex', 'cursor-agent', 'grok', 'kiro-cli', 'opencode']) {
    copyFileSync(FAKE, join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  return { root, repo, bin };
}

function request(overrides = {}) {
  return {
    schemaVersion: 'handoff.request.v0.2',
    instructions: 'Perform the bounded fake task.',
    timeoutMs: 5_000,
    ...overrides,
  };
}

function coordinatorApproval(ctx, role, overrides = {}, requestValue = request(), cwd = ctx.repo) {
  const approval = {
    schemaVersion: 'handoff.coordinator-approval.v0.2',
    approvalId: 'fake-coordinator-approval',
    issuer: 'fake-coordinator',
    provider: 'codex',
    role,
    cwd,
    scope: 'all-applicable-agents-rules',
    rules: discoverAgentsRules(cwd),
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'subjectHash')) {
    approval.subjectHash = codexApprovalSubjectHash({ request: requestValue, approval });
  }
  return approval;
}

function invoke(ctx, {
  provider = 'codex', role = 'review', mode = 'success', requestValue = request(),
  resultName = `${provider}-${role}.json`, extraArgs = [], extraEnv = {}, autoCoordinatorApproval = true,
  runCwd = ctx.repo,
} = {}) {
  const requestPath = join(ctx.root, `${provider}-${role}-request.json`);
  const resultPath = join(ctx.root, resultName);
  if (provider === 'codex' && autoCoordinatorApproval && requestValue && typeof requestValue === 'object'
    && !Array.isArray(requestValue) && !Object.hasOwn(requestValue, 'coordinatorApproval')) {
    requestValue = { ...requestValue, coordinatorApproval: coordinatorApproval(ctx, role, {}, requestValue, runCwd) };
  }
  writeFileSync(requestPath, JSON.stringify(requestValue));
  const args = [
    DRIVER, 'run', '--provider', provider, '--role', role, '--cwd', runCwd,
    '--request', requestPath, '--result', resultPath, ...extraArgs,
  ];
  const proc = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}`, HANDOFF_FAKE_MODE: mode, ...extraEnv },
    timeout: 10_000,
  });
  assert.equal(proc.signal, null, proc.stderr);
  assert.equal(proc.stdout.trim().split('\n').length, 1, 'machine stdout must be exactly one physical JSON line');
  const parsed = JSON.parse(proc.stdout);
  if (readFileSync(resultPath, 'utf8') !== proc.stdout) {
    assert.fail('stdout and --result must contain the identical JSON object');
  }
  return { proc, parsed, requestPath, resultPath };
}

function cleanup(ctx) {
  rmSync(ctx.root, { recursive: true, force: true });
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`timed out waiting for readiness file: ${path}`);
}

for (const role of ['build', 'phase', 'review', 'verify']) {
  test(`machine run: ${role} crosses real request/provider/result boundaries`, () => {
    const ctx = setup();
    try {
      const { proc, parsed } = invoke(ctx, { role });
      assert.equal(proc.status, 0);
      assert.equal(parsed.status, 'succeeded');
      assert.equal(parsed.role, role);
      assert.equal(parsed.provider.id, 'codex');
      assert.match(parsed.requestHash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(parsed.git.changed, role === 'build' || role === 'phase');
      assert.equal(parsed.usage.totalTokens, 18);
      assert.equal(parsed.policy.filesystem, role === 'build' || role === 'phase' ? 'workspace-write' : 'read-only');
      assert.equal(parsed.policy.projectRules, 'coordinator-approved-and-injected');
      assert.equal(parsed.policy.coordinatorApprovalRequired, true);
      assert.match(parsed.policy.coordinatorApprovalSubjectHash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(parsed.policy.nativeAgentsLoading, 'disabled-by-project_doc_max_bytes=0');
      assert.equal(parsed.policy.execPolicyRules, 'ignored');
    } finally { cleanup(ctx); }
  });
}

test('capabilities --json preflights every advertised provider through one strict API', () => {
  const ctx = setup();
  try {
    const proc = spawnSync(process.execPath, [DRIVER, 'capabilities', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}` },
    });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.stdout.trim().split('\n').length, 1);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.schemaVersion, 'handoff.capabilities.v0.2');
    assert.deepEqual(parsed.roles, ['build', 'phase', 'review', 'verify']);
    for (const provider of ['claude', 'codex', 'cursor', 'grok', 'kiro', 'opencode']) {
      const capability = parsed.providers.find((entry) => entry.id === provider);
      assert.equal(capability.pipeline.safe, true);
      assert.equal(capability.pipeline.preflight.ok, true);
      assert.equal(Object.hasOwn(capability, 'interactive'), false);
    }
    assert.deepEqual(parsed.providers.find((entry) => entry.id === 'codex').pipeline.roles, ['build', 'phase', 'review', 'verify']);
    assert.equal(parsed.providers.find((entry) => entry.id === 'codex').pipeline.policies.build.coordinatorApprovalRequired, true);
    assert.deepEqual(parsed.providers.find((entry) => entry.id === 'grok').pipeline.roles, ['build', 'phase', 'review', 'verify']);
    assert.deepEqual(parsed.providers.find((entry) => entry.id === 'kiro').pipeline.roles, ['review', 'verify']);
    assert.deepEqual(Object.keys(parsed.providers.find((entry) => entry.id === 'kiro').pipeline.policies), ['review', 'verify']);
    for (const provider of ['claude', 'cursor', 'opencode']) {
      assert.deepEqual(parsed.providers.find((entry) => entry.id === provider).pipeline.roles, ['build', 'phase', 'review', 'verify']);
    }
  } finally { cleanup(ctx); }
});

const STRICT_ROLE_MATRIX = {
  claude: ['build', 'phase', 'review', 'verify'],
  cursor: ['build', 'phase', 'review', 'verify'],
  grok: ['build', 'phase', 'review', 'verify'],
  kiro: ['review', 'verify'],
  opencode: ['build', 'phase', 'review', 'verify'],
};

for (const [provider, roles] of Object.entries(STRICT_ROLE_MATRIX)) {
  for (const role of roles) {
    test(`${provider} ${role} crosses the real strict subprocess boundary`, () => {
      const ctx = setup();
      try {
        const { proc, parsed } = invoke(ctx, { provider, role });
        assert.equal(proc.status, 0, parsed.diagnostics.message);
        assert.equal(parsed.status, 'succeeded');
        assert.equal(parsed.provider.id, provider);
        assert.equal(parsed.role, role);
        assert.equal(parsed.git.changed, role === 'build' || role === 'phase');
        if (provider === 'claude') {
          assert.equal(parsed.policy.userConfiguration, 'disabled by bare and safe modes');
          assert.equal(parsed.policy.nativeFilesystemIsolation, false);
          assert.equal(parsed.policy.nativeBashSandbox, role === 'build' || role === 'phase');
          assert.equal(parsed.usage.source, 'provider-envelope');
        }
        if (provider === 'grok') {
          assert.equal(parsed.policy.sandboxProfile, role === 'build' || role === 'phase' ? 'workspace' : 'read-only');
          assert.equal(parsed.policy.webSearch, false);
        }
        if (provider === 'kiro') {
          assert.deepEqual(parsed.policy.toolAllowlist, ['fs_read']);
          assert.equal(parsed.policy.nativeFilesystemIsolation, false);
        }
        if (provider === 'opencode') {
          assert.equal(parsed.policy.nativeFilesystemIsolation, false);
          assert.equal(parsed.policy.toolAllowlist.includes('bash'), false);
          assert.equal(parsed.usage.source, 'provider-envelope');
        }
        if (provider === 'cursor') {
          assert.equal(parsed.policy.nativeFilesystemIsolation, true);
          assert.equal(parsed.policy.applyMode, role === 'build' || role === 'phase' ? 'force' : 'force-omitted-native-read-only');
        }
      } finally { cleanup(ctx); }
    });
  }
}

test('strict adapters launch only their pinned control surfaces', () => {
  for (const [provider, role] of [
    ['claude', 'build'], ['claude', 'review'],
    ['cursor', 'build'], ['cursor', 'review'],
    ['grok', 'build'], ['grok', 'review'],
    ['kiro', 'review'], ['opencode', 'build'], ['opencode', 'review'],
  ]) {
    const ctx = setup();
    try {
      const capture = join(ctx.root, `${provider}-${role}-invocation.json`);
      const promptCapture = join(ctx.root, `${provider}-${role}-prompt.txt`);
      const { proc } = invoke(ctx, {
        provider, role,
        extraEnv: {
          HANDOFF_FAKE_INVOCATION_CAPTURE: capture,
          HANDOFF_FAKE_PROMPT_CAPTURE: promptCapture,
        },
      });
      assert.equal(proc.status, 0);
      const observed = JSON.parse(readFileSync(capture, 'utf8'));
      const prompt = readFileSync(promptCapture, 'utf8');
      assert.match(prompt, /<handoff-provider-output-json-schema>/u);
      assert.match(prompt, /"const":"handoff\.provider-output\.v0\.2"/u);
      const { args } = observed;
      if (provider === 'claude') {
        for (const flag of [
          '--bare', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
          '--no-session-persistence', '--no-chrome', '--json-schema',
        ]) assert.equal(args.includes(flag), true, `Claude omitted ${flag}`);
        assert.equal(valueAfter(args, '--permission-mode'), 'dontAsk');
        const settings = JSON.parse(valueAfter(args, '--settings'));
        assert.equal(settings.sandbox.enabled, true);
        assert.equal(settings.sandbox.failIfUnavailable, true);
        assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
        const tools = valueAfter(args, '--tools').split(',');
        assert.equal(tools.includes('Bash'), role === 'build');
        assert.equal(tools.includes('Edit'), role === 'build');
        assert.equal(tools.includes('Write'), role === 'build');
      }
      if (provider === 'cursor') {
        assert.deepEqual(args.slice(0, 4), ['sandbox', 'run', '--sandbox', '--network']);
        assert.equal(valueAfter(args, role === 'build' ? '--allow-paths' : '--readonly-paths'), realpathSync(ctx.repo));
        assert.equal(valueAfter(args, '-C'), realpathSync(ctx.repo));
        assert.equal(args.includes('--force'), role === 'build');
        assert.equal(valueAfter(args, '--output-format'), 'json');
      }
      if (provider === 'grok') {
        assert.equal(valueAfter(args, '--sandbox'), role === 'build' ? 'workspace' : 'read-only');
        assert.equal(valueAfter(args, '--permission-mode'), role === 'build' ? 'auto' : 'plan');
        for (const flag of ['--disable-web-search', '--no-subagents', '--no-memory', '--json-schema']) {
          assert.equal(args.includes(flag), true, `Grok omitted ${flag}`);
        }
      }
      if (provider === 'kiro') {
        assert.equal(args.includes('--trust-tools=fs_read'), true);
        assert.equal(args.some((arg) => arg.includes('trust-all')), false);
        assert.equal(args.some((arg) => arg.includes('execute_bash')), false);
      }
      if (provider === 'opencode') {
        assert.equal(args.includes('--pure'), true);
        assert.equal(valueAfter(args, '--dir'), realpathSync(ctx.repo));
        assert.equal(valueAfter(args, '--format'), 'json');
        assert.equal(args.includes('--auto'), false);
        const permission = JSON.parse(observed.env.OPENCODE_PERMISSION);
        assert.equal(permission['*'], 'deny');
        assert.equal(permission.bash, 'deny');
        assert.equal(permission.external_directory, 'deny');
        assert.equal(permission.edit, role === 'build' ? 'allow' : 'deny');
        const config = JSON.parse(observed.env.OPENCODE_CONFIG_CONTENT);
        assert.deepEqual(config.mcp, {});
        assert.deepEqual(config.plugin, []);
        assert.deepEqual(config.instructions, []);
      }
    } finally { cleanup(ctx); }
  }
});

test('removed provider/verb interface fails as one machine rejection object', () => {
  const ctx = setup();
  try {
    const promptPath = join(ctx.root, 'brief.md');
    writeFileSync(promptPath, '# bounded request\n');
    const proc = spawnSync(process.execPath, [
      DRIVER, '--provider', 'codex', '--verb', 'review', '--prompt-file', promptPath,
      '--cwd', ctx.repo,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}` } });
    assert.equal(proc.status, 5);
    assert.equal(proc.stdout.trim().split('\n').length, 1);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.status, 'rejected');
    assert.match(parsed.diagnostics.message, /machine command must be/u);
    assert.match(proc.stderr, /machine command must be/u);
  } finally { cleanup(ctx); }
});

test('strict review and build both reject a non-Git cwd before provider launch', () => {
  for (const role of ['review', 'build']) {
    const ctx = setup();
    try {
      const plainCwd = join(ctx.root, 'not-a-repository');
      mkdirSync(plainCwd);
      const marker = join(ctx.root, `${role}-provider-invoked`);
      const run = invoke(ctx, {
        provider: 'grok', role, runCwd: plainCwd,
        resultName: `non-git-${role}.json`,
        extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
      });
      assert.equal(run.proc.status, 5);
      assert.match(run.parsed.diagnostics.message, /not a Git worktree/u);
      assert.equal(existsSync(marker), false);
    } finally { cleanup(ctx); }
  }
});

test('prepare-request creates the strict file contract and binds Codex repository plus global rules', () => {
  const ctx = setup();
  try {
    const codexHome = join(ctx.root, 'codex-home');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'AGENTS.md'), 'Global coordinator rule.\n');
    writeFileSync(join(ctx.repo, 'AGENTS.md'), '\uFEFFRepository coordinator rule.\n');
    const instructions = join(ctx.root, 'instructions.txt');
    const requestPath = join(ctx.root, 'prepared-request.json');
    writeFileSync(instructions, 'Review the bounded fake change.\n');
    const proc = spawnSync(process.execPath, [
      PREPARE, '--provider', 'codex', '--role', 'review', '--cwd', ctx.repo,
      '--instructions', instructions, '--request', requestPath,
    ], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } });
    assert.equal(proc.status, 0, proc.stderr);
    const prepared = JSON.parse(proc.stdout);
    assert.equal(prepared.status, 'prepared');
    const value = JSON.parse(readFileSync(requestPath, 'utf8'));
    assert.deepEqual(value.coordinatorApproval.rules.map((rule) => rule.source), ['external', 'repository']);
    assert.match(value.coordinatorApproval.subjectHash, /^sha256:[0-9a-f]{64}$/u);
  } finally { cleanup(ctx); }
});

test('untracked-only build changes are evidence and count as completion', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'build', mode: 'untracked' });
    assert.equal(proc.status, 0);
    assert.equal(parsed.status, 'succeeded');
    assert.equal(parsed.git.after.changeCounts.untracked, 1);
    assert.deepEqual(parsed.git.changedFiles, ['untracked only.txt']);
  } finally { cleanup(ctx); }
});

test('Codex requires coordinator approval and injects every applicable AGENTS.md rule', () => {
  let ctx = setup();
  try {
    const marker = join(ctx.root, 'codex-provider-invoked');
    const { proc, parsed } = invoke(ctx, {
      role: 'review',
      autoCoordinatorApproval: false,
      extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(proc.status, 5);
    assert.equal(parsed.status, 'rejected');
    assert.match(parsed.diagnostics.message, /require request\.coordinatorApproval/u);
    assert.equal(existsSync(marker), false);
  } finally { cleanup(ctx); }

  ctx = setup();
  try {
    mkdirSync(join(ctx.repo, 'nested'));
    mkdirSync(join(ctx.repo, 'unrelated'));
    writeFileSync(join(ctx.repo, 'AGENTS.md'), 'Shadowed root rule must not apply.\n');
    writeFileSync(join(ctx.repo, 'AGENTS.override.md'), 'Root override binding rule.\n');
    writeFileSync(join(ctx.repo, 'nested/AGENTS.md'), 'Nested binding rule.\n');
    writeFileSync(join(ctx.repo, 'unrelated/AGENTS.md'), 'Unrelated rule must not apply.\n');
    const runCwd = join(ctx.repo, 'nested');
    const promptCapture = join(ctx.root, 'captured-codex-prompt.txt');
    const externalContent = 'Global coordinator rule.\n';
    const baseRequest = request();
    const requestValue = request({
      coordinatorApproval: coordinatorApproval(ctx, 'review', {
        rules: [
          { source: 'external', path: '/coordinator/global/AGENTS.md', sha256: sha256(Buffer.from(externalContent)), content: externalContent },
          ...discoverAgentsRules(runCwd),
        ],
      }, baseRequest, runCwd),
    });
    const { proc, parsed } = invoke(ctx, {
      role: 'review',
      requestValue,
      autoCoordinatorApproval: false,
      runCwd,
      extraEnv: { HANDOFF_FAKE_PROMPT_CAPTURE: promptCapture },
    });
    assert.equal(proc.status, 0);
    assert.deepEqual(parsed.policy.injectedAgentsRules, [
      'external:/coordinator/global/AGENTS.md',
      'repository:AGENTS.override.md',
      'repository:nested/AGENTS.md',
    ]);
    assert.equal(parsed.policy.agentsRulesCompleteness, 'repository rules driver-verified; external/global applicability coordinator-asserted');
    assert.match(parsed.policy.agentsRulesDigest, /^sha256:[0-9a-f]{64}$/u);
    const prompt = readFileSync(promptCapture, 'utf8');
    assert.match(prompt, /Root override binding rule/u);
    assert.match(prompt, /Nested binding rule/u);
    assert.match(prompt, /Global coordinator rule/u);
    assert.doesNotMatch(prompt, /Shadowed root rule must not apply/u);
    assert.doesNotMatch(prompt, /Unrelated rule must not apply/u);
    assert.match(prompt, /handoff-approved-agents-rules-json/u);
  } finally { cleanup(ctx); }
});

test('Codex rejects incomplete or stale coordinator AGENTS.md bindings before provider preflight', () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.repo, 'AGENTS.md'), 'Current rule.\n');
    const marker = join(ctx.root, 'codex-provider-invoked');
    const incomplete = request({ coordinatorApproval: coordinatorApproval(ctx, 'review', { rules: [] }) });
    let run = invoke(ctx, {
      role: 'review', requestValue: incomplete, autoCoordinatorApproval: false,
      resultName: 'incomplete-binding-result.json', extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(run.proc.status, 5);
    assert.match(run.parsed.diagnostics.message, /does not contain every applicable/u);
    assert.equal(existsSync(marker), false);

    const approvedRequest = request();
    const approved = coordinatorApproval(ctx, 'review', {}, approvedRequest);
    run = invoke(ctx, {
      role: 'review',
      requestValue: { ...approvedRequest, instructions: 'Tampered after approval.', coordinatorApproval: approved },
      autoCoordinatorApproval: false,
      resultName: 'tampered-subject-result.json',
      extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(run.proc.status, 5);
    assert.match(run.parsed.diagnostics.message, /subjectHash does not bind/u);
    assert.equal(existsSync(marker), false);

    const externalContent = 'Unsafe external path.\n';
    const unsafePathApproval = coordinatorApproval(ctx, 'review', {
      rules: [
        {
          source: 'external', path: '/coordinator/../global/AGENTS.md',
          sha256: sha256(Buffer.from(externalContent)), content: externalContent,
        },
        ...discoverAgentsRules(ctx.repo),
      ],
    });
    run = invoke(ctx, {
      role: 'review',
      requestValue: request({ coordinatorApproval: unsafePathApproval }),
      autoCoordinatorApproval: false,
      resultName: 'unsafe-external-rule-path-result.json',
      extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(run.proc.status, 5);
    assert.match(run.parsed.diagnostics.message, /unsafe path segment/u);
    assert.equal(existsSync(marker), false);

    const staleRules = discoverAgentsRules(ctx.repo).map((rule) => ({ ...rule, content: 'Stale rule.\n' }));
    run = invoke(ctx, {
      role: 'review',
      requestValue: request({ coordinatorApproval: coordinatorApproval(ctx, 'review', { rules: staleRules }) }),
      autoCoordinatorApproval: false,
      resultName: 'stale-binding-result.json',
      extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(run.proc.status, 5);
    assert.match(run.parsed.diagnostics.message, /content digest mismatch/u);
    assert.equal(existsSync(marker), false);

    run = invoke(ctx, {
      role: 'review',
      requestValue: request({ coordinatorApproval: coordinatorApproval(ctx, 'build') }),
      autoCoordinatorApproval: false,
      resultName: 'wrong-role-binding-result.json',
      extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(run.proc.status, 5);
    assert.match(run.parsed.diagnostics.message, /role does not match/u);
    assert.equal(existsSync(marker), false);
  } finally { cleanup(ctx); }
});

test('Kiro rejects build/phase before request or provider execution', () => {
  for (const role of ['build', 'phase']) {
    const ctx = setup();
    try {
      const requestPath = join(ctx.root, `kiro-${role}-request.json`);
      const resultPath = join(ctx.root, `kiro-${role}-result.json`);
      const marker = join(ctx.root, `kiro-${role}-provider-invoked`);
      writeFileSync(requestPath, JSON.stringify(request()));
      const proc = spawnSync(process.execPath, [
        DRIVER, 'run', '--provider', 'kiro', '--role', role, '--cwd', ctx.repo,
        '--request', requestPath, '--result', resultPath,
      ], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}`, HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
      });
      assert.equal(proc.status, 5);
      assert.match(JSON.parse(proc.stdout).diagnostics.message, /does not support pipeline role/u);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(resultPath), false);
    } finally { cleanup(ctx); }
  }
});

test('non-Codex providers reject coordinator approval objects before provider preflight', () => {
  for (const provider of ['claude', 'cursor', 'grok', 'kiro', 'opencode']) {
    const ctx = setup();
    try {
      const marker = join(ctx.root, `${provider}-approval-provider-invoked`);
      const baseRequest = request();
      const requestValue = {
        ...baseRequest,
        coordinatorApproval: coordinatorApproval(ctx, 'review', {}, baseRequest),
      };
      const run = invoke(ctx, {
        provider, role: 'review', requestValue,
        resultName: `${provider}-coordinator-approval-result.json`,
        extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
      });
      assert.equal(run.proc.status, 5);
      assert.match(run.parsed.diagnostics.message, /valid only for Codex/u);
      assert.equal(existsSync(marker), false);
    } finally { cleanup(ctx); }
  }
});

test('Kiro cannot be upgraded by an unverified confinement receipt', () => {
  const ctx = setup();
  try {
    const marker = join(ctx.root, 'kiro-provider-invoked');
    const run = invoke(ctx, {
      provider: 'kiro', role: 'review',
      requestValue: { ...request(), externalConfinement: { verifiedByDriver: false } },
      extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(run.proc.status, 5);
    assert.match(run.parsed.diagnostics.message, /unknown field.*externalConfinement/u);
    assert.equal(existsSync(marker), false);
  } finally { cleanup(ctx); }
});

test('reviewer mutation blocks even when provider claims completion', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'review', mode: 'review-mutation' });
    assert.equal(proc.status, 10);
    assert.equal(parsed.status, 'blocked');
    assert.equal(parsed.git.changed, true);
    assert.match(parsed.diagnostics.message, /mutated/u);
  } finally { cleanup(ctx); }
});

test('symlink worktree changes are fingerprinted without following the target', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'build', mode: 'symlink-change' });
    assert.equal(proc.status, 0);
    assert.equal(parsed.git.after.changeCounts.symlink, 1);
    assert.deepEqual(parsed.git.changedFiles, ['unsafe-link']);
  } finally { cleanup(ctx); }
});

for (const [mode, message] of [
  ['noisy', /exactly one JSON object/u],
  ['prose', /exactly one JSON object/u],
  ['oversized', /exceeds 256000 bytes/u],
  ['schema-drift', /schema drift/u],
  ['unknown-field', /unknown field/u],
  ['unsafe-evidence-path', /unsafe path segment/u],
  ['missing', /missing/u],
]) {
  test(`provider ${mode} output fails closed`, () => {
    const ctx = setup();
    try {
      const { proc, parsed } = invoke(ctx, { role: 'review', mode });
      assert.equal(proc.status, 7);
      assert.equal(parsed.status, 'failed');
      assert.match(parsed.diagnostics.message, message);
    } finally { cleanup(ctx); }
  });
}

test('invalid UTF-8 requests and provider objects fail closed', () => {
  let ctx = setup();
  try {
    const requestPath = join(ctx.root, 'invalid-utf8-request.json');
    const resultPath = join(ctx.root, 'invalid-utf8-request-result.json');
    const marker = join(ctx.root, 'invalid-utf8-provider-invoked');
    writeFileSync(requestPath, Buffer.concat([
      Buffer.from('{"schemaVersion":"handoff.request.v0.2","instructions":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]));
    const proc = spawnSync(process.execPath, [
      DRIVER, 'run', '--provider', 'grok', '--role', 'review', '--cwd', ctx.repo,
      '--request', requestPath, '--result', resultPath,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}`, HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
    });
    assert.equal(proc.status, 5);
    assert.match(JSON.parse(proc.stdout).diagnostics.message, /not valid UTF-8/u);
    assert.equal(existsSync(marker), false);
  } finally { cleanup(ctx); }

  ctx = setup();
  try {
    const run = invoke(ctx, { provider: 'codex', role: 'review', mode: 'invalid-utf8' });
    assert.equal(run.proc.status, 7);
    assert.equal(run.parsed.status, 'failed');
    assert.match(run.parsed.diagnostics.message, /not valid UTF-8/u);
  } finally { cleanup(ctx); }
});

test('provider exit code is preserved while driver maps failure to exit 2', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'review', mode: 'exit' });
    assert.equal(proc.status, 2);
    assert.equal(parsed.exit.provider, 23);
    assert.equal(parsed.exit.driver, 2);
    assert.equal(parsed.status, 'failed');
  } finally { cleanup(ctx); }
});

test('installed provider missing required flags fails capability preflight', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'review', mode: 'help-missing' });
    assert.equal(proc.status, 3);
    assert.equal(parsed.status, 'not_run');
    assert.match(parsed.diagnostics.message, /lacks required flag/u);
  } finally { cleanup(ctx); }
});

test('installed Codex missing required strict config support fails capability preflight', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'review', mode: 'config-missing' });
    assert.equal(proc.status, 3);
    assert.equal(parsed.status, 'not_run');
    assert.match(parsed.diagnostics.message, /cannot prove required strict config support/u);
  } finally { cleanup(ctx); }
});

test('installed Grok unable to initialize a named sandbox fails capability preflight', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { provider: 'grok', role: 'review', mode: 'sandbox-missing' });
    assert.equal(proc.status, 3);
    assert.equal(parsed.status, 'not_run');
    assert.match(parsed.diagnostics.message, /cannot prove 'workspace' sandbox plus structured-result enforcement/u);
  } finally { cleanup(ctx); }
});

test('Claude, OpenCode, and Cursor fail closed when their strict preflight proof is unavailable', () => {
  for (const [provider, mode, message] of [
    ['claude', 'help-missing', /lacks required flag/u],
    ['opencode', 'policy-missing', /cannot prove the exact review permission policy/u],
    ['cursor', 'sandbox-missing', /cannot prove read-only target-path sandbox enforcement/u],
  ]) {
    const ctx = setup();
    try {
      const run = invoke(ctx, { provider, role: 'review', mode });
      assert.equal(run.proc.status, 3);
      assert.equal(run.parsed.status, 'not_run');
      assert.match(run.parsed.diagnostics.message, message);
    } finally { cleanup(ctx); }
  }
});

test('Grok runtime sandbox loss blocks a provider success after preflight', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, {
      provider: 'grok', role: 'review', mode: 'runtime-sandbox-missing',
    });
    assert.equal(proc.status, 10);
    assert.equal(parsed.status, 'blocked');
    assert.match(parsed.diagnostics.message, /requested sandbox was not enforced/u);
  } finally { cleanup(ctx); }
});

test('Claude and Cursor runtime sandbox-loss reports block provider success', () => {
  for (const provider of ['claude', 'cursor']) {
    const ctx = setup();
    try {
      const run = invoke(ctx, { provider, role: 'review', mode: 'runtime-sandbox-missing' });
      assert.equal(run.proc.status, 10);
      assert.equal(run.parsed.status, 'blocked');
      assert.match(run.parsed.diagnostics.message, /sandbox was not enforced/u);
    } finally { cleanup(ctx); }
  }
});

test('Claude, OpenCode, and Cursor envelope normalization rejects noise and prose', () => {
  for (const provider of ['claude', 'opencode', 'cursor']) {
    for (const mode of ['noisy', 'prose']) {
      const ctx = setup();
      try {
        const run = invoke(ctx, { provider, role: 'review', mode });
        assert.equal(run.proc.status, 7, `${provider} ${mode}`);
        assert.equal(run.parsed.status, 'failed');
        assert.match(run.parsed.diagnostics.message, /JSON|missing structured_output|exactly one/u);
      } finally { cleanup(ctx); }
    }
  }
});

test('timeout kills the subprocess and produces a normalized timed_out result', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'review', mode: 'hang', requestValue: request({ timeoutMs: 100 }) });
    assert.equal(proc.status, 8);
    assert.equal(parsed.status, 'timed_out');
    assert.equal(parsed.exit.timedOut, true);
  } finally { cleanup(ctx); }
});

test('SIGTERM cancellation is normalized and still writes --result', async () => {
  const ctx = setup();
  try {
    const requestPath = join(ctx.root, 'cancel-request.json');
    const resultPath = join(ctx.root, 'cancel-result.json');
    const readyPath = join(ctx.root, 'provider-ready');
    const requestValue = request({ timeoutMs: 5_000 });
    requestValue.coordinatorApproval = coordinatorApproval(ctx, 'review', {}, requestValue);
    writeFileSync(requestPath, JSON.stringify(requestValue));
    const child = spawn(process.execPath, [
      DRIVER, 'run', '--provider', 'codex', '--role', 'review', '--cwd', ctx.repo,
      '--request', requestPath, '--result', resultPath,
    ], {
      env: {
        ...process.env,
        PATH: `${ctx.bin}:${process.env.PATH || ''}`,
        HANDOFF_FAKE_MODE: 'hang',
        HANDOFF_FAKE_READY_FILE: readyPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    // Do not race process bootstrap: the marker proves the real provider subprocess is running,
    // after both startup and in-flight cancellation handlers have been installed.
    await waitForFile(readyPath);
    child.kill('SIGTERM');
    const closed = await new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
    assert.equal(closed.signal, null, Buffer.concat(stderr).toString('utf8'));
    assert.equal(closed.code, 9);
    const text = Buffer.concat(stdout).toString('utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.status, 'cancelled');
    assert.equal(readFileSync(resultPath, 'utf8'), text);
  } finally { cleanup(ctx); }
});

test('request and result symlinks plus lexical traversal are rejected', () => {
  const ctx = setup();
  try {
    const realRequest = join(ctx.root, 'real-request.json');
    const linkedRequest = join(ctx.root, 'linked-request.json');
    const resultPath = join(ctx.root, 'symlink-request-result.json');
    writeFileSync(realRequest, JSON.stringify(request()));
    symlinkSync(realRequest, linkedRequest);
    let proc = spawnSync(process.execPath, [
      DRIVER, 'run', '--provider', 'codex', '--role', 'review', '--cwd', ctx.repo,
      '--request', linkedRequest, '--result', resultPath,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}` } });
    assert.equal(proc.status, 5);
    assert.match(JSON.parse(proc.stdout).diagnostics.message, /symbolic link/u);

    const linkedResult = join(ctx.root, 'linked-result.json');
    const resultTarget = join(ctx.root, 'result-target.json');
    writeFileSync(resultTarget, 'do not overwrite');
    symlinkSync(resultTarget, linkedResult);
    proc = spawnSync(process.execPath, [
      DRIVER, 'run', '--provider', 'codex', '--role', 'review', '--cwd', ctx.repo,
      '--request', realRequest, '--result', linkedResult,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}` } });
    assert.equal(proc.status, 5);
    assert.match(JSON.parse(proc.stdout).diagnostics.message, /symbolic link/u);
    assert.equal(readFileSync(resultTarget, 'utf8'), 'do not overwrite');

    const actualDir = join(ctx.root, 'actual-dir');
    const linkedDir = join(ctx.root, 'linked-dir');
    mkdirSync(actualDir);
    writeFileSync(join(actualDir, 'request.json'), JSON.stringify(request()));
    symlinkSync(actualDir, linkedDir);
    proc = spawnSync(process.execPath, [
      DRIVER, 'run', '--provider', 'codex', '--role', 'review', '--cwd', ctx.repo,
      '--request', join(linkedDir, 'request.json'), '--result', join(ctx.root, 'ancestor-result.json'),
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}` } });
    assert.equal(proc.status, 5);
    assert.match(JSON.parse(proc.stdout).diagnostics.message, /ancestor/u);

    const traversing = `${ctx.root}/x/../real-request.json`;
    proc = spawnSync(process.execPath, [
      DRIVER, 'run', '--provider', 'codex', '--role', 'review', '--cwd', ctx.repo,
      '--request', traversing, '--result', join(ctx.root, 'traversal-result.json'),
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH || ''}` } });
    assert.equal(proc.status, 5);
    assert.match(JSON.parse(proc.stdout).diagnostics.message, /unsafe path segment/u);
  } finally { cleanup(ctx); }
});

test('malformed and unknown request fields fail before provider execution', () => {
  for (const requestValue of [
    { schemaVersion: 'handoff.request.v9', instructions: 'x' },
    { ...request(), unknown: true },
    { schemaVersion: 'handoff.request.v0.2', instructions: '' },
  ]) {
    const ctx = setup();
    try {
      const { proc, parsed } = invoke(ctx, { requestValue });
      assert.equal(proc.status, 5);
      assert.equal(parsed.status, 'rejected');
    } finally { cleanup(ctx); }
  }
});

test('option-like or control-character model/effort values are rejected before any provider launch', () => {
  for (const requestValue of [
    request({ model: '--dangerously-bypass-approvals-and-sandbox' }),
    request({ model: '  --sandbox' }),
    request({ effort: 'high\n--permission-mode=bypassPermissions' }),
  ]) {
    const ctx = setup();
    try {
      const marker = join(ctx.root, 'provider-invoked');
      const { proc, parsed } = invoke(ctx, {
        requestValue,
        extraEnv: { HANDOFF_FAKE_ANY_INVOKE_MARKER: marker },
      });
      assert.equal(proc.status, 5);
      assert.equal(parsed.status, 'rejected');
      assert.equal(existsSync(marker), false, 'request rejection must precede provider version/help/run processes');
    } finally { cleanup(ctx); }
  }

  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { requestValue: request({ model: 'provider/model', effort: 'high' }) });
    assert.equal(proc.status, 0);
    assert.equal(parsed.status, 'succeeded');
  } finally { cleanup(ctx); }
});

test('diagnostics are bounded and redact common credential forms', () => {
  const ctx = setup();
  try {
    const { proc, parsed } = invoke(ctx, { role: 'review', mode: 'stderr-secret' });
    assert.equal(proc.status, 0);
    assert.doesNotMatch(parsed.diagnostics.providerStderr, /super-secret-value|abcdefghijklmnopqrstuvwxyz/u);
    assert.match(parsed.diagnostics.providerStderr, /REDACTED/u);
    assert.ok(parsed.diagnostics.redactionCount >= 2);
  } finally { cleanup(ctx); }
});

test('Git fingerprint is deterministic and complete for staged, unstaged, deleted, renamed, untracked, newline and symlink changes', () => {
  const ctx = setup();
  try {
    for (const [name, contents] of [['modified.txt', 'one\n'], ['deleted.txt', 'delete\n'], ['rename source.txt', 'rename\n']]) {
      writeFileSync(join(ctx.repo, name), contents);
    }
    command(ctx.repo, 'git', ['add', '.']);
    command(ctx.repo, 'git', ['commit', '-qm', 'fixtures']);
    writeFileSync(join(ctx.repo, 'modified.txt'), 'staged\n');
    command(ctx.repo, 'git', ['add', 'modified.txt']);
    writeFileSync(join(ctx.repo, 'modified.txt'), 'unstaged too\n');
    unlinkSync(join(ctx.repo, 'deleted.txt'));
    command(ctx.repo, 'git', ['mv', 'rename source.txt', 'renamed target\nline.txt']);
    writeFileSync(join(ctx.repo, 'untracked space\nand newline.txt'), 'untracked\n');
    symlinkSync('seed.txt', join(ctx.repo, 'link to seed'));
    command(ctx.repo, 'git', ['add', 'link to seed']);
    unlinkSync(join(ctx.repo, 'link to seed'));
    writeFileSync(join(ctx.repo, 'link to seed'), 'worktree replaced staged symlink\n');
    symlinkSync('seed.txt', join(ctx.repo, 'untracked link to seed'));
    const first = gitFingerprint(ctx.repo);
    const second = gitFingerprint(ctx.repo);
    assert.equal(first.digest, second.digest);
    mkdirSync(join(ctx.repo, 'nested-cwd'));
    assert.equal(gitFingerprint(join(ctx.repo, 'nested-cwd')).digest, first.digest);
    assert.ok(first.changeCounts.staged >= 2);
    assert.ok(first.changeCounts.unstaged >= 2);
    assert.ok(first.changeCounts.deleted >= 1);
    assert.ok(first.changeCounts.renamed >= 1);
    assert.ok(first.changeCounts.untracked >= 2);
    assert.ok(first.changeCounts.symlink >= 1);
    assert.ok(first.changes.some((entry) => entry.path === 'link to seed' && entry.staged && entry.symlink));
    assert.ok(first.changes.some((entry) => entry.path.includes('\n')));
    writeFileSync(join(ctx.repo, 'untracked space\nand newline.txt'), 'changed bytes\n');
    assert.notEqual(gitFingerprint(ctx.repo).digest, first.digest);
  } finally { cleanup(ctx); }
});
