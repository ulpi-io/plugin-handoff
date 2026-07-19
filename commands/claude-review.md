---
description: Strictly hand off a read-only review to Claude Code through the machine ABI.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill with provider `claude`, role `review`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow. Present normalized
findings; any observed reviewer mutation is blocked.
