#!/usr/bin/env node
// handoff.mjs — the ONE provider-agnostic driver. It owns everything reusable; each provider is a
// ~50-line adapter in lib/providers/. Dispatch on --provider/--verb; the adapter only fills the
// CLI-specific middle (binary, args, trust flag, capture).
//
// Contract (identical for codex | grok | kiro, build | review):
//   1. locate the binary        → missing ⇒ gateNotRun (report + install hint, exit 3). Never auto-install.
//   2. auth probe               → not ok  ⇒ gateNotRun (report, exit 4).
//   3. read the brief from --prompt-file (literal bytes; NEVER argv/shell/heredoc).
//   4. build ⇒ record baseline HEAD (verify by real diff, not self-report).
//   5. invoke: trust scoped to the verb (read-only review / least-write build); bypass ONLY on
//      an explicit `--mode autonomous`. Prompt delivered via stdin or --prompt-file, never argv.
//   6. capture + report GROUND TRUTH: build ⇒ `git diff --stat <baseline>`; review ⇒ findings.
//      A CLI that could not run is reported nonRun — never a fabricated clean or block.
//
// Usage:
//   node handoff.mjs --provider <codex|grok|kiro|claude|opencode|cursor> --verb <build|review> --prompt-file <PATH>
//        [--cwd DIR] [--model M] [--effort E] [--resume [ID]] [--structured] [--mode autonomous] [--json]
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import * as codex from './lib/providers/codex.mjs';
import * as grok from './lib/providers/grok.mjs';
import * as kiro from './lib/providers/kiro.mjs';
import * as claude from './lib/providers/claude.mjs';
import * as opencode from './lib/providers/opencode.mjs';
import * as cursor from './lib/providers/cursor.mjs';
import { readPromptFile, HandoffError } from './lib/prompt.mjs';
import { isRepo, headSha, diffStat } from './lib/git.mjs';
import { REVIEW_SCHEMA, renderFindings } from './lib/render.mjs';

const PROVIDERS = { codex, grok, kiro, claude, opencode, cursor };
const VERBS = new Set(['build', 'review']);

const EXIT = { OK: 0, RAN_NONZERO: 2, MISSING: 3, AUTH: 4, USAGE: 5, NO_DIFF: 6, BAD_HANDOFF: 7 };

function parseArgs(argv) {
  const o = { cwd: process.cwd(), mode: 'scoped', structured: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--provider') o.provider = next();
    else if (a === '--verb') o.verb = next();
    else if (a === '--prompt-file') o.promptFile = next();
    else if (a === '--cwd') o.cwd = next();
    else if (a === '--model') o.model = next();
    else if (a === '--effort') o.effort = next();
    else if (a === '--structured') o.structured = true;
    else if (a === '--json') o.json = true;
    else if (a === '--mode') o.mode = next();
    else if (a === '--resume') { const v = argv[i + 1]; o.resume = (v && !v.startsWith('--')) ? (i++, v) : true; }
    else throw new HandoffError(`unknown argument: ${a}`);
  }
  return o;
}

function fail(exit, msg, extra = {}) {
  return { done: true, exit, nonRun: exit === EXIT.MISSING || exit === EXIT.AUTH, message: msg, ...extra };
}

function run(opts) {
  const adapter = PROVIDERS[opts.provider];
  if (!adapter) return fail(EXIT.USAGE, `--provider must be one of codex|grok|kiro|claude|opencode|cursor (got '${opts.provider}')`);
  if (!VERBS.has(opts.verb)) return fail(EXIT.USAGE, `--verb must be build|review (got '${opts.verb}')`);
  if (opts.mode !== 'scoped' && opts.mode !== 'autonomous') return fail(EXIT.USAGE, `--mode must be scoped|autonomous (got '${opts.mode}')`);

  // (1) locate — fail closed on a missing binary; NEVER auto-install.
  const bin = adapter.locate();
  if (!bin) return fail(EXIT.MISSING, `${adapter.displayName} CLI not found on PATH. ${adapter.installHint}`);

  // (2) auth probe.
  const auth = adapter.authOk(bin);
  if (!auth.ok) return fail(EXIT.AUTH, `${adapter.displayName} is not usable: ${auth.hint}`);

  // (3) read the brief (literal bytes).
  const promptText = readPromptFile(opts.promptFile);

  // resume support check
  if (opts.resume && typeof adapter.supportsResume === 'function' && !adapter.supportsResume()) {
    return fail(EXIT.USAGE, `${adapter.displayName} resume is not supported by handoff v1 — use the CLI's native resume directly.`);
  }

  // (4) baseline for build.
  const baseline = opts.verb === 'build' ? headSha(opts.cwd) : null;
  if (opts.verb === 'build' && !isRepo(opts.cwd)) {
    return fail(EXIT.BAD_HANDOFF, `--cwd '${opts.cwd}' is not a git repo — a build handoff needs one to verify the diff.`);
  }

  // structured review: hand each provider the SAME canonical schema in its native form.
  let schemaFile, schemaJson;
  const wantStructured = opts.verb === 'review' && opts.structured;
  if (wantStructured) {
    schemaJson = JSON.stringify(REVIEW_SCHEMA);
    schemaFile = join(tmpdir(), `handoff-schema-${randomUUID()}.json`);
    writeFileSync(schemaFile, schemaJson);
  }
  const lastMsgFile = opts.provider === 'codex' ? join(tmpdir(), `handoff-codex-${randomUUID()}.txt`) : null;

  // (5) invoke — trust scoped to the verb by the adapter; prompt never on argv.
  const inv = adapter.invocation({
    verb: opts.verb, cwd: opts.cwd, promptFile: opts.promptFile, model: opts.model,
    effort: opts.effort, mode: opts.mode, resume: opts.resume, schemaFile, schemaJson, lastMsgFile,
  });
  const spawnOpts = { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (inv.stdin === 'file') spawnOpts.input = promptText; // pipe brief bytes to stdin
  const proc = spawnSync(inv.bin, inv.args, spawnOpts);

  if (proc.error) {
    cleanup([schemaFile, lastMsgFile]);
    return fail(EXIT.MISSING, `failed to spawn ${adapter.displayName}: ${proc.error.message}`);
  }

  const finalMessage = lastMsgFile && existsSync(lastMsgFile) ? readFileSync(lastMsgFile, 'utf8') : '';
  const cap = adapter.capture({
    code: proc.status ?? 1, stdout: proc.stdout, stderr: proc.stderr,
    finalMessage, structured: wantStructured,
  });
  cleanup([schemaFile, lastMsgFile]);

  // (6) report ground truth.
  const result = {
    done: true, provider: opts.provider, verb: opts.verb, mode: opts.mode,
    trust: inv.trustNote, ran: cap.ran, agentExit: proc.status ?? 1,
    ok: cap.ok, text: cap.text, stderr: cap.stderr, nonRun: false,
  };

  if (opts.verb === 'build') {
    const diff = diffStat(opts.cwd, baseline);
    result.baseline = baseline;
    result.changedFiles = diff.files;
    result.diffStat = diff.stat;
    // honesty gate: a "build" that ran clean but changed NOTHING is not a success — surface it.
    if (cap.ok && !diff.changed) { result.ok = false; result.exit = EXIT.NO_DIFF; result.warning = 'build handoff produced NO diff — treat as non-completion, not a clean pass.'; }
    else result.exit = cap.ok ? EXIT.OK : EXIT.RAN_NONZERO;
  } else {
    if (wantStructured && cap.findings) result.findings = cap.findings;
    result.exit = cap.ok ? EXIT.OK : EXIT.RAN_NONZERO;
  }
  return result;
}

function cleanup(paths) {
  for (const p of paths) { if (p) { try { rmSync(p, { force: true }); } catch { /* ignore */ } } }
}

function renderHuman(r) {
  const L = [];
  if (r.nonRun || r.exit === EXIT.MISSING || r.exit === EXIT.AUTH) {
    L.push(`✗ gateNotRun — ${r.message}`);
    L.push('  (reported as NOT run — never a fabricated clean or block.)');
    return L.join('\n');
  }
  if (r.exit === EXIT.USAGE || r.exit === EXIT.BAD_HANDOFF) { L.push(`✗ ${r.message}`); return L.join('\n'); }
  L.push(`▸ handoff:${r.provider}-${r.verb}  (${r.trust}, mode=${r.mode})  agent exit=${r.agentExit}`);
  if (r.verb === 'build') {
    L.push(`  baseline: ${r.baseline}`);
    if (r.warning) L.push(`  ⚠ ${r.warning}`);
    else L.push(`  changed ${r.changedFiles.length} file(s):`);
    if (r.diffStat) L.push(r.diffStat.split('\n').map((x) => `    ${x}`).join('\n'));
    L.push(`  verify: git -C ${'<cwd>'} diff ${r.baseline}`);
  } else {
    const f = r.findings ? renderFindings(r.findings) : null;
    L.push(f ? '  findings:' : '  reviewer output:');
    L.push(f || (r.text ? r.text.split('\n').map((x) => `    ${x}`).join('\n') : '    (no output)'));
  }
  if (!r.ok) L.push(`  ✗ NOT a clean pass (exit ${r.exit}). Do not treat as green.`);
  return L.join('\n');
}

export { parseArgs, run, EXIT }; // for tests

// ---- main (only when invoked directly, NOT when imported by the test suite) ----
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(EXIT.USAGE); }

  let result;
  try { result = run(opts); }
  catch (e) {
    if (e instanceof HandoffError) { console.error(`✗ ${e.message}`); process.exit(EXIT.BAD_HANDOFF); }
    throw e;
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderHuman(result));
  process.exit(result.exit ?? EXIT.OK);
}
