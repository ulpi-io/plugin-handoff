// cursor.mjs — adapter for the Cursor Agent CLI (verified against `cursor-agent --help`, 2025.10.28).
//   headless invoke : cursor-agent -p --output-format text   (prompt read as literal bytes from stdin;
//                     NO positional prompt — injection-safe. cursor exposes no --prompt-file / --file, so
//                     stdin is the only safe channel; if cursor ignored stdin the run just fails closed.)
//   trust lever     : cursor has NO per-run read-only lever — `-p` already grants write+bash, and the
//                     only per-run control is `-f/--force` (force-allow) vs the config allowlist. So:
//                       review  → -p (no --force): BEST-EFFORT read-only. It relies on cursor's allowlist
//                                 approval mode (un-allowed writes get no approval in headless) plus the
//                                 read-only brief — this is WEAKER than the other providers' hard levers.
//                       build   → -p --force  (force-allow writes/shell; verified by the real git diff).
//                       autonomous → -p --force --approve-mcps (also auto-approve MCP servers).
//   model : --model   resume : --continue (most recent) / --resume <chatId>
//   NOTE: no structured-output flag — review findings come back as text; the brief asks for a JSON block.
import { spawnSync } from 'node:child_process';
import { locateExecutable } from '../which.mjs';

export const id = 'cursor';
export const displayName = 'Cursor';
export const installHint = 'Install the Cursor CLI (`curl https://cursor.com/install -fsS | bash`) and run `cursor-agent login`.';

export function locate() {
  return locateExecutable('cursor-agent', ['~/.local/bin', '~/.cursor/bin', '/opt/homebrew/bin', '/usr/local/bin']);
}

export function authOk(bin) {
  // NOTE: never probe with `status`/`whoami` — those START an interactive login flow. Use --version;
  // a logged-out cursor fails the real run with a nonzero exit (surfaced honestly, never a fake clean).
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, hint: 'cursor-agent is installed but not responding; run `cursor-agent login`.' };
  return { ok: true, note: 'auth is verified by cursor at run time; a logged-out CLI exits nonzero (never a fake clean).' };
}

export function supportsResume() { return true; }

export function invocation({ verb, model, mode, resume }) {
  const args = ['-p', '--output-format', 'text'];
  // build force-allows writes/shell; autonomous does too (bypass unlocked regardless of verb).
  if (verb === 'build' || mode === 'autonomous') args.push('--force');
  if (mode === 'autonomous') args.push('--approve-mcps'); // extra bypass — autonomous ONLY
  if (model) args.push('--model', model);
  if (resume) { if (typeof resume === 'string') args.push('--resume', resume); else args.push('--continue'); }
  const trustNote = mode === 'autonomous' ? '--force --approve-mcps'
    : verb === 'build' ? '--force'
    : '-p (allowlist — best-effort read-only)';
  return { bin: locate(), args, stdin: 'file', trustNote }; // brief piped to stdin, never on argv
}

export function capture({ code, stdout, stderr }) {
  return { ran: true, ok: code === 0, text: (stdout || '').trim(), stderr: (stderr || '').trim() };
}
