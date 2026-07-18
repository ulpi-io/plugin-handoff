---
name: handoff-run
description: |
  Shared workflow behind every /handoff:<provider>-<verb> command. Hands off a BUILD or REVIEW task to
  a one-shot headless agent (Codex, Grok, Kiro, Claude, opencode, or Cursor) through the deterministic driver
  scripts/handoff.mjs. Invoke it when a /handoff:* command fires, or when the user asks to "hand off",
  "delegate to codex/grok/kiro/claude/opencode/cursor", "have grok review", "let kiro build", etc. It scopes the request into
  an injection-safe brief, runs the target CLI with trust scoped to the verb, and reports GROUND TRUTH
  (the real git diff for a build; findings for a review) — never a self-reported clean.
allowed-tools: [Bash, Read, Write, Grep, Glob]
argument-hint: "<provider> <verb> — <what to build or review>"
---

# handoff-run

Delegate one bounded unit of work to an external one-shot agent and report what it ACTUALLY did.

<EXTREMELY-IMPORTANT>
- **Fail closed.** If the driver reports `gateNotRun` (CLI missing / not authed / could not run), that is
  NOT a pass and NOT a block — report it as "did not run" and stop. Never invent a result.
- **Verify ground truth, never the agent's word.** A build is judged by `git diff --stat <baseline>`
  (the driver prints it); a review by its findings. A build that produced NO diff is a non-completion,
  not success — say so.
- **Trust is scoped to the verb.** Review runs read-only; build runs least-write. NEVER pass
  `--mode autonomous` (which unlocks danger-full-access / bypass / trust-all-tools) unless the user
  explicitly asked for an unsandboxed autonomous run this turn.
- **The brief is data, not code.** Always write it to a file with the Write tool and pass
  `--prompt-file`. Never inline the request into the shell command or an argv element.
- Bounded: one handoff = one build or one review of one scoped unit. Do not loop unattended.
</EXTREMELY-IMPORTANT>

You are given a **provider** (`codex|grok|kiro|claude|opencode|cursor`), a **verb** (`build|review`), and the user's **request**.

## Phase 1 — Scope the request into a brief

Turn the request into a tight, self-contained brief. Include:
- **Goal** — one sentence.
- **In scope** — the exact files/dirs/paths (list them; use Grep/Glob/Read to ground this in the repo).
- **Acceptance criteria** — for `build`, the machine-checkable done-conditions; for `review`, what to
  scrutinize (correctness, security, tests, perf).
- **Guardrails** — for `build`: only touch in-scope files, keep changes minimal, run the tests; for
  `review`: read-only, do not modify anything, return findings.
- For `review`, instruct the agent to return findings; when structured output is wanted, ask for a JSON
  object `{ "findings": [ { "file", "line", "severity": "blocker|high|medium|low|nit", "summary" } ] }`.

Success criterion: the brief is complete enough that the external agent needs no follow-up questions.

## Phase 2 — Write the brief to a file (injection-safe)

Use the **Write** tool to save the brief to a temp file, e.g. `.ulpi/handoffs/<provider>-<verb>.md`
(create the dir if needed). Do not echo the brief through the shell.

Success criterion: the file exists and holds the full brief.

## Phase 3 — Run the driver

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" \
  --provider <provider> --verb <verb> \
  --prompt-file <the file from Phase 2> \
  --cwd "$(pwd)" \
  # review: add --structured   ·   optional: --model <M> --effort <E>
```

The driver locates the CLI, probes auth, records the baseline (build), invokes the agent with the prompt
on stdin/`--prompt-file` and trust scoped to the verb, then prints the honest report. Do NOT add
`--mode autonomous` unless the user asked for it.

Success criterion: the driver ran and printed either a report or an honest `gateNotRun`.

## Phase 4 — Verify and report

- **gateNotRun / nonzero exit** → tell the user it did not complete, with the driver's reason. Never green.
- **build** → read the printed `git diff --stat <baseline>`; if it changed nothing, report non-completion.
  Optionally show `git diff <baseline>` for the actual changes. The changes are UNCOMMITTED — leave
  committing to the user / the normal flow.
- **review** → present the findings as-is; do not act on them here (that would be a separate build handoff).

## Guardrails

- Never escalate trust to get a task to pass. Never auto-install a missing CLI (the driver refuses; relay
  the install hint).
- Never report a handoff as done on the agent's say-so — only on the diff/findings the driver surfaced.
- One scoped unit per handoff; if the request is large, scope it down or split it, don't hand off the world.

## Output Contract

Report: which provider/verb ran, the trust level used, whether it actually ran, and the ground-truth
result (diff summary for build / findings for review) — or an explicit "did not run" with the reason.
