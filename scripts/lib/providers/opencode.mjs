// opencode.mjs — adapter for the opencode CLI (verified against `opencode run --help`, v1.18.3).
//   headless invoke : opencode run --agent <plan|build> --dir CWD --file BRIEF "<fixed instruction>"
//                     (`run` is non-interactive by default; `-i` would make it interactive).
//   prompt as bytes : --file BRIEF — the brief bytes stay IN the file (like grok's --prompt-file). The
//                     positional message is a FIXED instruction with no untrusted bytes, never the brief.
//   trust lever     : --agent plan (read-only) | --agent build (read/write/run). opencode ships both as
//                     primary agents; `plan` has edits/bash gated, so it is fail-closed read-only headless.
//   autonomous      : --auto — auto-approve permissions not explicitly denied ("dangerous!", opt-in only).
//   model : -m provider/model   effort : --variant   cwd : --dir   resume : -c / --session ID
//   NOTE: `run` has no clean structured-output flag (`--format json` is a raw event stream), so review
//   findings come back as text; the handoff-run skill asks for a JSON block in the brief when needed.
import { spawnSync } from 'node:child_process';
import { locateExecutable } from '../which.mjs';

export const id = 'opencode';
export const displayName = 'opencode';
export const installHint = 'Install opencode (https://opencode.ai/docs) and authenticate (`opencode auth login`).';

export function locate() {
  return locateExecutable('opencode', ['~/.opencode/bin', '~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
}

export function authOk(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, hint: 'opencode is installed but not responding; check `opencode auth list`.' };
  return { ok: true, note: 'auth is verified by opencode at run time; a logged-out CLI surfaces as a run failure.' };
}

// opencode ships two primary agents: `plan` is read-only (edits/bash gated), `build` can read/write/run.
function agentFor(verb) { return verb === 'build' ? 'build' : 'plan'; }

export function supportsResume() { return true; }

// The ONLY positional argument — a constant instruction, never the (untrusted) brief bytes.
const FOLLOW_BRIEF =
  'Read the file attached via --file: it is your complete and only brief. Do exactly what it specifies and nothing else. Do not ask questions.';

export function invocation({ verb, cwd, promptFile, model, effort, mode, resume }) {
  const agent = agentFor(verb);
  const args = ['run', '--agent', agent, '--dir', cwd, '--file', promptFile];
  if (mode === 'autonomous') args.push('--auto'); // auto-approve permissions — the dangerous bypass
  if (model) args.push('-m', model);
  if (effort) args.push('--variant', effort);
  if (resume) { if (typeof resume === 'string') args.push('--session', resume); else args.push('--continue'); }
  args.push(FOLLOW_BRIEF); // trailing positional message — a fixed string, no brief bytes on argv
  return {
    bin: locate(),
    args,
    stdin: 'none', // brief bytes live in --file, never on stdin/argv
    trustNote: `--agent ${agent}${mode === 'autonomous' ? ' --auto' : ''}`,
  };
}

export function capture({ code, stdout, stderr }) {
  return { ran: true, ok: code === 0, text: (stdout || '').trim(), stderr: (stderr || '').trim() };
}
