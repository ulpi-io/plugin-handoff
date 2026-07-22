---
name: handoff-run-with-advice
description: Delegate one bounded build, phase, review, or verification from Codex or Claude while allowing the worker to request nested read-only advice from supported models. Use only when the worker may benefit from consultation but must not delegate more work.
---

# Run a handoff whose worker may ask for advice

Use only the bundled `scripts/handoff.mjs` entrypoint and select `run-with-advice` explicitly:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" run-with-advice \
  --caller-harness <codex|claude> \
  --harness <codex|grok|kiro|claude|opencode|cursor> \
  --mode <build|phase|review|verify> \
  --cwd "$(pwd -P)" \
  --instructions <absolute-private-path>/instructions.txt \
  --result <absolute-private-path>/result.json
```

The worker receives an attenuated `advice-only` supervisor capability. It may ignore that
capability and complete independently. If consultation is useful, its only nested command is:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" advice \
  --harness <target-harness> \
  --cwd "$(pwd -P)" \
  --instructions <absolute-private-path>/advice.txt \
  --result <absolute-private-path>/advice-result.json
```

Nested advice omits `--caller-harness` and every root budget flag. The supervisor derives lineage,
attenuates Bash/web/MCP grants, and rejects nested `run`, `run-with-advice`, build, phase, review,
and verify attempts. Failed advice is non-green; the worker must report it honestly and continue
only when it can still satisfy the original task safely.

Root selection, grant, and budget flags are the same as `$handoff-run`. Never invoke a provider CLI
directly or add bypass, trust-all, resume, or ambient MCP flags. Only root exit `0` plus result status
`succeeded` is green.
