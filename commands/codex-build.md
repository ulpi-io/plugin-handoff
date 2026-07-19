---
description: Strictly hand off a build to Codex through the machine ABI.
argument-hint: "<what to build>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
disable-model-invocation: true
---
Use the **handoff-run** skill with provider `codex`, role `build`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow; preparing the request
must bind every applicable repository AGENTS.md rule. Report normalized Git evidence.
