---
name: handoff-cursor-with-advice
description: Delegate a bounded build, phase, review, verify task to Cursor while allowing that worker to request nested read-only advice. Use when Cursor should execute the task and may consult another model without delegating more work.
---

# Hand off to Cursor and let it ask for advice

Write the complete goal, scope, acceptance criteria, validation commands, and guardrails to a private
instructions file. Use only this exact root family:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" run-with-advice \
  --caller-harness <codex|claude> \
  --harness cursor \
  --mode <build|phase|review|verify> \
  --cwd "$(pwd -P)" \
  --instructions <absolute-private-path>/instructions.txt \
  --result <absolute-private-path>/result.json
```

Optional provider selection and authority flags are `--model`, `--effort`, `--max-turns`,
`--bash`, `--web-search`, and `--mcp-config`. Supply only controls reported by
`capabilities --json`; unsupported combinations fail before launch.

This form grants the Cursor worker one attenuated operation: nested read-only `advice`. The worker may use the nested advice command without `--caller-harness` or root budgets. It cannot invoke `run`, `run-with-advice`, or a provider CLI, and advice can never grant write authority.

Only exit `0` plus result status `succeeded` is green. Build and phase require a Git-observable
change; review and verify block on mutation.
