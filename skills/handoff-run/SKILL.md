---
name: handoff-run
description: |
  Strict frontend for every /handoff:<provider>-<role> command. Prepare a versioned request file and
  invoke the one machine driver for Codex, Grok, Kiro, Claude, OpenCode, or Cursor. Use when the user
  asks to hand off or delegate a bounded build or review. Never invoke a provider directly.
allowed-tools: [Bash, Read, Write, Grep, Glob]
argument-hint: "<provider> <build|review> — <bounded request>"
---

# handoff-run

Every slash command is a frontend to the same strict file ABI. There is no second execution path.

<EXTREMELY-IMPORTANT>
- Fail closed. `not_run`, `rejected`, `failed`, `blocked`, `timed_out`, and `cancelled` are never green.
- Do not invoke a provider CLI directly and do not use removed `--verb` or `--prompt-file` driver flags.
- Never add trust-all, approval bypass, sandbox bypass, skip-repository-check, resume, or shared-session flags.
- Put request bytes in a private file. Never interpolate them into shell or provider argv.
- Build/phase success requires a Git-observable change. Review/verify block if the worktree changes.
- One bounded request per run.
</EXTREMELY-IMPORTANT>

Inputs are a provider, role, absolute Git worktree, and user request. Supported roles are:

- Codex, Grok, Claude, OpenCode, Cursor: `build|phase|review|verify`
- Kiro: `review|verify`

## 1. Scope the request

Create a self-contained instruction document with a one-sentence goal, exact in-scope paths,
machine-checkable acceptance criteria, and guardrails. Reviews explicitly forbid changes and request
concrete findings. Do not weaken or reinterpret the user's constraints.

## 2. Prepare the versioned request

Create a private temporary directory with `mktemp -d`. Use the Write tool to save the instruction
document as `instructions.txt` inside it; do not use `echo`, a here-document, or shell interpolation.
Use physical absolute paths for cwd and every file.

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/prepare-request.mjs" \
  --provider <provider> --role <role> --cwd "$(pwd -P)" \
  --instructions <absolute-temp-dir>/instructions.txt \
  --request <absolute-temp-dir>/request.json
```

The request helper validates the same schema as the driver. For Codex it also binds the exact request,
role, cwd, and applicable AGENTS.md chain into a coordinator approval. The request path must not exist.

## 3. Invoke the one driver

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" run \
  --provider <provider> --role <role> --cwd "$(pwd -P)" \
  --request <absolute-temp-dir>/request.json \
  --result <absolute-temp-dir>/result.json
```

The driver emits exactly one JSON object on stdout and writes the byte-identical object to the new
result path. Diagnostics are fields in that bounded, redacted result; provider diagnostics never
become extra stdout objects. Check both process exit and result status.

## 4. Report ground truth

- Build/phase: report status, provider policy, baseline/head, and `git.changedFiles`. A successful
  provider response with no Git-observable change is blocked.
- Review/verify: present `output.findings` and relevant evidence. Any worktree mutation is blocked.
- Preflight or execution failure: report the exact bounded diagnostic and say the handoff did not
  complete. Do not substitute a local opinion.

Delete only the exact temporary directory created for this run after the result has been consumed.

## Fixed provider policies

- Codex: ephemeral, user config and native rules disabled, coordinator-approved AGENTS.md injected,
  approval policy never, native `workspace-write` for build/phase and `read-only` for review/verify.
- Grok: exact `workspace` or `read-only` named sandbox, cwd pinned, bounded turns, and web search,
  subagents, and memory disabled.
- Claude: bare and safe modes, no persistence, strict empty MCP config, bounded turns, JSON Schema
  output, explicit tools, and fail-closed native Bash sandboxing for write roles.
- OpenCode: temporary HOME/config roots, project configuration disabled, external plugins and skills
  disabled, an exact resolved named-agent permission preflight, raw-event normalization, and no Bash,
  web, subagents, or external-directory access. This is tool-permission confinement, not an OS sandbox.
- Cursor: the whole headless agent runs inside Cursor's preflighted native command sandbox from an
  isolated temporary workspace. Build/phase receive the target as `--allow-paths` and use `--force`;
  review/verify receive it as `--readonly-paths` and omit `--force`. Git mutation blocking remains
  defense in depth.
- Kiro: review/verify only, with `fs_read` and never `execute_bash`. This is a tool allowlist, not native
  filesystem isolation.

All policies retain the same-UID limitation: the provider sandbox is not a boundary against the
coordinator or another process running as the same OS user.
