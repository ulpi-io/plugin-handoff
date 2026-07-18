// claude.mjs — adapter for the Claude Code CLI in headless print mode (verified against `claude --help`
// and an empirical `claude -p` probe).
//   headless invoke : claude -p --output-format json   (prompt read as literal bytes from stdin; the
//                     entire stdin becomes the prompt — no positional prompt argument).
//   trust lever     : --permission-mode manual | auto | bypassPermissions
//                       review  → manual  (headless: denies edits + mutating bash; read-only bash ok)
//                       build   → auto    (headless: auto-approves edits + bash via the safety
//                                          classifier, blocks dangerous patterns — NOT a full bypass)
//                       autonomous → bypassPermissions (full bypass; opt-in only)
//   structured out  : --json-schema '<inline schema>' → the conforming object lands in the top-level
//                     `structured_output` field of the JSON envelope.
//   model : --model   effort : --effort   resume : --continue / --resume <SESSION_ID>
//   The JSON envelope carries `result` (final text) and `is_error` (turn error flag).
import { spawnSync } from 'node:child_process';
import { locateExecutable } from '../which.mjs';

export const id = 'claude';
export const displayName = 'Claude';
export const installHint = 'Install Claude Code (`npm i -g @anthropic-ai/claude-code`) and run `claude` once to log in (or set ANTHROPIC_API_KEY).';

export function locate() {
  return locateExecutable('claude', ['~/.local/bin', '~/.claude/local', '/opt/homebrew/bin', '/usr/local/bin']);
}

export function authOk(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, hint: 'claude is installed but not responding; run `claude` once to log in.' };
  return { ok: true, note: 'auth is verified by claude at run time; a logged-out CLI surfaces as a run failure (never a fake clean).' };
}

// review = strict read-only (manual denies writes in headless); build = edit + run, classifier-guarded.
function permissionFor(verb, mode) {
  if (mode === 'autonomous') return 'bypassPermissions';
  return verb === 'build' ? 'auto' : 'manual';
}

export function supportsResume() { return true; }

export function invocation({ verb, model, effort, mode, resume, schemaJson }) {
  const perm = permissionFor(verb, mode);
  // -p reads the prompt as literal bytes from stdin; NEVER a positional prompt (injection-safe).
  const args = ['-p', '--output-format', 'json', '--permission-mode', perm];
  if (verb === 'review' && schemaJson) args.push('--json-schema', schemaJson); // structured_output in envelope
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) { if (typeof resume === 'string') args.push('--resume', resume); else args.push('--continue'); }
  return { bin: locate(), args, stdin: 'file', trustNote: `--permission-mode ${perm}` };
}

export function capture({ code, stdout, stderr, structured }) {
  const raw = (stdout || '').trim();
  let text = raw, ok = code === 0, findings = null;
  try {
    const env = JSON.parse(raw); // `claude -p --output-format json` prints one envelope object
    if (env && typeof env === 'object') {
      if (typeof env.result === 'string') text = env.result.trim();
      if (env.is_error === true) ok = false;
      // structured review: the schema-conforming object is under `structured_output`.
      if (structured && env.structured_output && typeof env.structured_output === 'object') {
        findings = env.structured_output;
      }
    }
  } catch { /* not JSON (e.g. a spawn/auth error dumped to stderr) — keep raw stdout as text */ }
  return { ran: true, ok, text, findings, stderr: (stderr || '').trim() };
}
