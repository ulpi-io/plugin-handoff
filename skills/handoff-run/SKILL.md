---
name: handoff-run
description: Delegate one bounded build, phase, review, or verification from Codex or Claude without giving the worker any ability to call Handoff again. Use when the worker must finish independently and must not ask another model for advice.
---

# Run a plain handoff

Use only the bundled `scripts/handoff.mjs` entrypoint. This skill deliberately selects the plain
`run` verb. The worker receives no supervisor context, no nested-advice token, and no alternate
delegation path.

Write the exact goal, scope, acceptance criteria, validation commands, and guardrails to a private
instructions file. Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" run \
  --caller-harness <codex|claude> \
  --harness <codex|grok|kiro|claude|opencode|cursor> \
  --mode <build|phase|review|verify> \
  --cwd "$(pwd -P)" \
  --instructions <absolute-private-path>/instructions.txt \
  --result <absolute-private-path>/result.json
```

Optional selection and authority flags are `--model`, `--effort`, `--max-turns`, `--bash`,
`--web-search`, and `--mcp-config`. Root budget flags are `--max-depth`, `--max-nodes`,
`--max-advice-nodes`, `--max-handoff-nodes`, `--max-concurrency`, `--root-timeout-ms`, and
`--timeout-ms`. Model, effort, and turn controls are validated against the selected provider.

Never substitute `run-with-advice`, invoke a provider CLI directly, or add bypass, trust-all,
resume, or ambient MCP flags. There is no nested form of plain handoff.

Only exit `0` plus result status `succeeded` is green. Build and phase require a Git-observable
change; review and verify are read-only and block on mutation.
