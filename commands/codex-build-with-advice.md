---
description: Hand off a build to Codex and let that worker request nested read-only advice.
argument-hint: "<what to build>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
disable-model-invocation: true
---
Use the **handoff-codex-with-advice** skill with role `build`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use the exact root `handoff.mjs run-with-advice --caller-harness claude --harness codex --mode build` flow.
The worker may request nested read-only advice only; it cannot launch another handoff. Report the
normalized root result, including any non-green nested-advice state that affected completion.
