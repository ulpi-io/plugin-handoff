---
description: Hand off a BUILD task to Codex (codex exec, workspace-write). Scopes it, runs one-shot, verifies by real git diff.
argument-hint: "<what to build>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
disable-model-invocation: true
---
Use the **handoff-run** skill to hand off a **build** task to **Codex**.

- provider: `codex`
- verb: `build`
- request: $ARGUMENTS

Scope the request into an injection-safe brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider codex --verb build --prompt-file <file> --cwd "$(pwd)"`
and report the real `git diff --stat <baseline>` the driver prints (no diff = not done). Do NOT pass
`--mode autonomous` unless I explicitly ask this turn.
