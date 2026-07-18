---
description: Hand off a REVIEW to Kiro (--trust-tools fs_read,execute_bash, no writes). Returns findings; changes nothing.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill to hand off a **review** to **Kiro**.

- provider: `kiro`
- verb: `review`
- request: $ARGUMENTS

Scope it into a brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider kiro --verb review --prompt-file <file> --cwd "$(pwd)"`
and present the findings. Kiro chat has no structured-output flag, so ask (in the brief) for the findings
as a JSON block. It runs with no write access — it must not modify anything.
