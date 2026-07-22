---
description: Hand off a review to opencode with optional nested read-only advice.
argument-hint: "<what to review>"
allowed-tools: [Bash, Read, Write, Grep, Glob]
---
Use the **handoff-opencode-with-advice** skill with role `review`, cwd `$(pwd)`, and request
`$ARGUMENTS`. Use the exact root `handoff.mjs run-with-advice --caller-harness claude --harness opencode --mode review` flow.
The worker may request nested read-only advice only; it cannot launch another handoff. Report the
normalized root result, including any non-green nested-advice state that affected completion.
