---
description: Strictly hand off a native read-only Cursor review through the machine ABI.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-run** skill with provider `cursor`, role `review`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow. Present normalized
findings; the target worktree is mounted read-only, `--force` is absent, and any observed mutation
is also blocked.
