---
description: Hand off a REVIEW to Codex (read-only). Returns findings; changes nothing.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill to hand off a **review** to **Codex**.

- provider: `codex`
- verb: `review`
- request: $ARGUMENTS

Scope it into a brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider codex --verb review --prompt-file <file> --cwd "$(pwd)" --structured`
and present the findings the driver returns. It runs read-only — it must not modify anything.
