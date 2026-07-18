---
description: Hand off a REVIEW to opencode (headless `opencode run`, plan/read-only agent). Returns findings; changes nothing.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill to hand off a **review** to **opencode** (headless `opencode run`).

- provider: `opencode`
- verb: `review`
- request: $ARGUMENTS

Scope it into a brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider opencode --verb review --prompt-file <file> --cwd "$(pwd)" --structured`
and present the findings the driver returns. It runs opencode's read-only `--agent plan` — it must not
modify anything. (opencode has no structured-output flag, so the brief asks for a JSON findings block.)
