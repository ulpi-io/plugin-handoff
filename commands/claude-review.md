---
description: Hand off a REVIEW to Claude Code (headless `claude -p`, manual/read-only). Returns findings; changes nothing.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill to hand off a **review** to **Claude** (headless `claude -p`).

- provider: `claude`
- verb: `review`
- request: $ARGUMENTS

Scope it into a brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider claude --verb review --prompt-file <file> --cwd "$(pwd)" --structured`
and present the findings the driver returns. It runs `--permission-mode manual` (read-only: edits and
mutating commands are denied) — it must not modify anything.
