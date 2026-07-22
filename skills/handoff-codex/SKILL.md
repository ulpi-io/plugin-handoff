---
name: handoff-codex
description: Delegate a bounded build, phase, review, verify task to Codex without giving that worker any nested Handoff capability. Use when Codex should execute independently and must not consult another model through Handoff.
---

# Hand off to Codex

Write the complete goal, scope, acceptance criteria, validation commands, and guardrails to a private
instructions file. Use only this exact root family:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" run \
  --caller-harness <codex|claude> \
  --harness codex \
  --mode <build|phase|review|verify> \
  --cwd "$(pwd -P)" \
  --instructions <absolute-private-path>/instructions.txt \
  --result <absolute-private-path>/result.json
```

Optional provider selection and authority flags are `--model`, `--effort`, `--max-turns`,
`--bash`, `--web-search`, and `--mcp-config`. Supply only controls reported by
`capabilities --json`; unsupported combinations fail before launch.

This is the plain form. The Codex worker receives no supervisor context and cannot invoke nested advice, `run`, `run-with-advice`, or a provider CLI. Do not silently upgrade this request to the with-advice family.

Only exit `0` plus result status `succeeded` is green. Build and phase require a Git-observable
change; review and verify block on mutation.
