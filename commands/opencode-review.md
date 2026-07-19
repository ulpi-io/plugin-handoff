---
description: Strictly hand off a permission-read-only review to OpenCode through the machine ABI.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill with provider `opencode`, role `review`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow. Present normalized
findings; edit, Bash, web, skills, subagents, and external-directory access are denied.
