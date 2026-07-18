---
description: Hand off a REVIEW to Cursor (headless `cursor-agent -p`, no --force). Returns findings. NOTE: best-effort read-only — cursor has no hard read-only lever.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill to hand off a **review** to **Cursor** (headless `cursor-agent -p`).

- provider: `cursor`
- verb: `review`
- request: $ARGUMENTS

Scope it into a brief written to a file, then run
`node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" --provider cursor --verb review --prompt-file <file> --cwd "$(pwd)"`
and present the findings the driver returns.

⚠️ **Best-effort read-only.** Unlike the other providers, Cursor's headless CLI has no per-run read-only
lever — review runs `-p` without `--force`, relying on Cursor's allowlist approval mode plus a read-only
brief. It is NOT a hard sandbox guarantee. If you need guaranteed read-only, prefer another provider.
