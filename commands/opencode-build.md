---
description: Strictly hand off a permission-confined build to OpenCode through the machine ABI.
argument-hint: "<what to build>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
disable-model-invocation: true
---
Use the **handoff-run** skill with provider `opencode`, role `build`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use only the strict prepare-request + `handoff.mjs run` flow. The resolved named-agent
policy must be preflighted; Bash, web, skills, subagents, and external-directory access stay denied.
