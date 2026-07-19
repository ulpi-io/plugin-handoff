---
description: Strictly hand off a permission-read-only review to Kiro through the machine ABI.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill with provider `kiro`, role `review`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow. Kiro receives `fs_read`
only (never `execute_bash`); present normalized findings and block any observed mutation.
