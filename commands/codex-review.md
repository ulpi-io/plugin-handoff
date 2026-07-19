---
description: Strictly hand off a read-only review to Codex through the machine ABI.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill with provider `codex`, role `review`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow; preparing the request
must bind every applicable repository AGENTS.md rule. Present normalized findings.
