---
description: Hand off a REVIEW to Grok (--permission-mode plan, read-only). Returns findings; changes nothing.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill to hand off a **review** to **Grok**.

- provider: `grok`
- verb: `review`
- request: $ARGUMENTS

Scope it into a brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider grok --verb review --prompt-file <file> --cwd "$(pwd)" --structured`
and present the findings the driver returns. It runs read-only (plan mode) — it must not modify anything.
