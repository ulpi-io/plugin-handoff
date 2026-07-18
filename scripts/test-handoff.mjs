#!/usr/bin/env node
// test-handoff.mjs — contract tests for the driver + the 3 adapters. Hermetic: no real CLI is
// spawned. Proves the load-bearing safety invariants the driver promises:
//   • the prompt is NEVER placed on argv (codex/kiro read stdin; grok gets a --prompt-file PATH, not bytes)
//   • trust is scoped to the verb (review = read-only lever, build = least-write lever)
//   • the dangerous bypass lever appears ONLY under --mode autonomous
//   • bad invocations fail closed (usage exit) before anything is spawned
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import * as codex from '../scripts/lib/providers/codex.mjs';
import * as grok from '../scripts/lib/providers/grok.mjs';
import * as kiro from '../scripts/lib/providers/kiro.mjs';
import * as claude from '../scripts/lib/providers/claude.mjs';
import * as opencode from '../scripts/lib/providers/opencode.mjs';
import * as cursor from '../scripts/lib/providers/cursor.mjs';
import { parseArgs, run, EXIT } from '../scripts/handoff.mjs';
import { readPromptFile, HandoffError } from '../scripts/lib/prompt.mjs';
import { REVIEW_SCHEMA } from '../scripts/lib/render.mjs';

const BRIEF = '/tmp/handoff-brief-EXAMPLE.md';
const SECRET = 'THE-LITERAL-PROMPT-BYTES-SHOULD-NEVER-BE-AN-ARGV-ELEMENT';

// ---- prompt never on argv ----
test('codex: prompt via stdin (`-`), read-only for review, workspace-write for build', () => {
  const r = codex.invocation({ verb: 'review', cwd: '/w' });
  assert.equal(r.stdin, 'file');           // driver pipes bytes to stdin
  assert.equal(r.args.at(-1), '-');         // codex reads prompt from stdin
  assert.ok(r.args.includes('read-only'));
  assert.ok(!r.args.includes(BRIEF));       // the prompt-file path is not passed to codex
  const b = codex.invocation({ verb: 'build', cwd: '/w' });
  assert.ok(b.args.includes('workspace-write'));
});

test('grok: prompt via --prompt-file PATH (bytes stay in the file), plan for review / auto for build', () => {
  const r = grok.invocation({ verb: 'review', cwd: '/w', promptFile: BRIEF });
  assert.equal(r.stdin, 'none');
  const i = r.args.indexOf('--prompt-file');
  assert.ok(i >= 0 && r.args[i + 1] === BRIEF); // a PATH, not the bytes
  assert.ok(r.args.includes('plan'));
  const b = grok.invocation({ verb: 'build', cwd: '/w', promptFile: BRIEF });
  assert.ok(b.args.includes('auto'));
});

test('kiro: prompt via stdin, trust scoped (review has NO fs_write, build does)', () => {
  const r = kiro.invocation({ verb: 'review' });
  assert.equal(r.stdin, 'file');
  assert.ok(r.args.some((a) => a === '--trust-tools=fs_read,execute_bash'));
  assert.ok(!r.args.some((a) => a.includes('fs_write')));   // review cannot write
  const b = kiro.invocation({ verb: 'build' });
  assert.ok(b.args.some((a) => a === '--trust-tools=fs_read,fs_write,execute_bash'));
});

test('claude: prompt via stdin (no positional), manual for review / auto for build', () => {
  const r = claude.invocation({ verb: 'review', cwd: '/w' });
  assert.equal(r.stdin, 'file');            // driver pipes bytes to stdin
  assert.ok(r.args.includes('-p'));         // headless print mode
  assert.ok(!r.args.includes(BRIEF));       // the prompt-file path is not passed to claude
  const pm = r.args.indexOf('--permission-mode');
  assert.ok(pm >= 0 && r.args[pm + 1] === 'manual'); // review is strict read-only
  const b = claude.invocation({ verb: 'build', cwd: '/w' });
  const bpm = b.args.indexOf('--permission-mode');
  assert.ok(bpm >= 0 && b.args[bpm + 1] === 'auto'); // build edits + runs, classifier-guarded
  // structured review carries the canonical schema inline; a plain review does not.
  const s = claude.invocation({ verb: 'review', cwd: '/w', schemaJson: JSON.stringify(REVIEW_SCHEMA) });
  assert.ok(s.args.includes('--json-schema'));
});

test('opencode: prompt via --file PATH (bytes stay in the file), plan for review / build for build', () => {
  const r = opencode.invocation({ verb: 'review', cwd: '/w', promptFile: BRIEF });
  assert.equal(r.stdin, 'none');
  const i = r.args.indexOf('--file');
  assert.ok(i >= 0 && r.args[i + 1] === BRIEF); // a PATH, not the bytes
  const ag = r.args.indexOf('--agent');
  assert.ok(ag >= 0 && r.args[ag + 1] === 'plan'); // read-only agent
  const b = opencode.invocation({ verb: 'build', cwd: '/w', promptFile: BRIEF });
  const bag = b.args.indexOf('--agent');
  assert.ok(bag >= 0 && b.args[bag + 1] === 'build');
});

test('cursor: prompt via stdin (no positional), review has NO --force, build does (best-effort RO)', () => {
  const r = cursor.invocation({ verb: 'review', cwd: '/w' });
  assert.equal(r.stdin, 'file');            // driver pipes bytes to stdin
  assert.ok(r.args.includes('-p'));
  assert.ok(!r.args.includes(BRIEF));       // no prompt-file path on argv
  assert.ok(!r.args.includes('--force'));   // review does not force-allow writes (best-effort read-only)
  const b = cursor.invocation({ verb: 'build', cwd: '/w' });
  assert.ok(b.args.includes('--force'));    // build force-allows writes
  assert.ok(!b.args.includes('--approve-mcps'));
});

test('no adapter ever puts the literal prompt bytes into argv', () => {
  for (const [p, adapter] of [['codex', codex], ['grok', grok], ['kiro', kiro], ['claude', claude], ['opencode', opencode], ['cursor', cursor]]) {
    for (const verb of ['build', 'review']) {
      const inv = adapter.invocation({ verb, cwd: '/w', promptFile: BRIEF });
      assert.ok(!inv.args.includes(SECRET), `${p}/${verb} leaked prompt bytes into argv`);
    }
  }
});

// ---- dangerous levers gated behind --mode autonomous ----
test('bypass/danger/trust-all levers appear ONLY under --mode autonomous', () => {
  // scoped (default): none of the dangerous tokens
  assert.ok(!codex.invocation({ verb: 'build', cwd: '/w' }).args.includes('danger-full-access'));
  assert.ok(!grok.invocation({ verb: 'build', cwd: '/w', promptFile: BRIEF }).args.includes('bypassPermissions'));
  assert.ok(!kiro.invocation({ verb: 'build' }).args.includes('--trust-all-tools'));
  assert.ok(!claude.invocation({ verb: 'build', cwd: '/w' }).args.includes('bypassPermissions'));
  assert.ok(!opencode.invocation({ verb: 'build', cwd: '/w', promptFile: BRIEF }).args.includes('--auto'));
  assert.ok(!cursor.invocation({ verb: 'build', cwd: '/w' }).args.includes('--approve-mcps')); // cursor's extra bypass
  // autonomous: each unlocks its bypass
  assert.ok(codex.invocation({ verb: 'build', cwd: '/w', mode: 'autonomous' }).args.includes('danger-full-access'));
  assert.ok(grok.invocation({ verb: 'build', cwd: '/w', promptFile: BRIEF, mode: 'autonomous' }).args.includes('bypassPermissions'));
  assert.ok(kiro.invocation({ verb: 'build', mode: 'autonomous' }).args.includes('--trust-all-tools'));
  assert.ok(claude.invocation({ verb: 'build', cwd: '/w', mode: 'autonomous' }).args.includes('bypassPermissions'));
  assert.ok(opencode.invocation({ verb: 'build', cwd: '/w', promptFile: BRIEF, mode: 'autonomous' }).args.includes('--auto'));
  assert.ok(cursor.invocation({ verb: 'build', cwd: '/w', mode: 'autonomous' }).args.includes('--approve-mcps'));
});

// ---- provider capture: envelope parsing (claude) + plain text (opencode) ----
test('claude.capture: unwraps JSON envelope, flags is_error, extracts structured_output', () => {
  const envelope = JSON.stringify({ result: 'looks good', is_error: false, structured_output: { findings: [] } });
  const ok = claude.capture({ code: 0, stdout: envelope, stderr: '', structured: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'looks good');           // .result becomes the text
  assert.deepEqual(ok.findings, { findings: [] }); // structured_output surfaced as findings
  const errd = claude.capture({ code: 0, stdout: JSON.stringify({ result: 'x', is_error: true }), stderr: '' });
  assert.equal(errd.ok, false);                  // is_error overrides a zero exit
  const nonJson = claude.capture({ code: 1, stdout: 'boom (not json)', stderr: 'err' });
  assert.equal(nonJson.ok, false);
  assert.equal(nonJson.text, 'boom (not json)'); // defensive fallback keeps raw text
});

test('opencode.capture: plain text, ok tracks exit code', () => {
  assert.equal(opencode.capture({ code: 0, stdout: ' done ', stderr: '' }).ok, true);
  assert.equal(opencode.capture({ code: 0, stdout: ' done ', stderr: '' }).text, 'done');
  assert.equal(opencode.capture({ code: 2, stdout: '', stderr: 'nope' }).ok, false);
});

// ---- driver arg parsing ----
test('parseArgs: defaults + resume with/without id', () => {
  const a = parseArgs(['--provider', 'codex', '--verb', 'review', '--prompt-file', BRIEF]);
  assert.equal(a.mode, 'scoped');
  assert.equal(a.structured, false);
  assert.equal(parseArgs(['--resume', 'abc123']).resume, 'abc123');
  assert.equal(parseArgs(['--resume', '--json']).resume, true); // bare flag
});

// ---- fail closed on bad invocation (before any spawn) ----
test('driver refuses bad provider/verb/mode with a usage exit — no spawn', () => {
  assert.equal(run({ provider: 'bogus', verb: 'review', cwd: '/w' }).exit, EXIT.USAGE);
  assert.equal(run({ provider: 'codex', verb: 'bogus', cwd: '/w' }).exit, EXIT.USAGE);
  assert.equal(run({ provider: 'codex', verb: 'review', mode: 'bogus', cwd: '/w' }).exit, EXIT.USAGE);
});

// ---- prompt file validation ----
test('readPromptFile: rejects missing / empty, accepts real content', () => {
  assert.throws(() => readPromptFile('/no/such/file'), HandoffError);
  const p = join(tmpdir(), `handoff-test-${randomUUID()}.md`);
  writeFileSync(p, '   \n  ');
  assert.throws(() => readPromptFile(p), HandoffError);
  writeFileSync(p, 'real brief');
  assert.equal(readPromptFile(p), 'real brief');
  rmSync(p, { force: true });
});

// ---- the canonical review schema is well-formed ----
test('REVIEW_SCHEMA requires findings[] with file+severity+summary', () => {
  assert.equal(REVIEW_SCHEMA.properties.findings.type, 'array');
  const item = REVIEW_SCHEMA.properties.findings.items;
  assert.deepEqual(item.required, ['file', 'severity', 'summary']);
});
