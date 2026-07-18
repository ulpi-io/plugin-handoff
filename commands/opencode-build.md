---
description: Hand off a BUILD task to opencode (headless `opencode run`, build agent). Scopes it, runs one-shot, verifies by real git diff.
argument-hint: "<what to build>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
disable-model-invocation: true
---
Use the **handoff-run** skill to hand off a **build** task to **opencode** (headless `opencode run`).

- provider: `opencode`
- verb: `build`
- request: $ARGUMENTS

Scope the request into an injection-safe brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider opencode --verb build --prompt-file <file> --cwd "$(pwd)"`
and report the real `git diff --stat <baseline>` the driver prints (no diff = not done). Trust is scoped
to opencode's `--agent build`. Do NOT pass `--mode autonomous` (opencode `--auto`) unless I explicitly
ask this turn.
