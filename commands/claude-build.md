---
description: Strictly hand off a build to Claude Code through the machine ABI.
argument-hint: "<what to build>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
disable-model-invocation: true
---
Use the **handoff-run** skill with provider `claude`, role `build`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow. Report the normalized
result and Git evidence; no Git-observable change is not completion.
