---
name: get-advice
description: Ask any supported Codex, Grok, Kiro, Claude, OpenCode, or Cursor model for a bounded read-only expert opinion through Handoff's supervised machine ABI. Use for second opinions, architecture decisions, debugging hypotheses, focused research, code-review advice, or cross-model consultation where the current worker must not delegate edits.
---

# Get advice

Use the bundled Node entrypoint. Never invoke a provider CLI directly and never assume a global
`handoff` executable exists.

Advice is always read-only. A root advice request receives an `advice-only` capability so the adviser
may consult another model, but every nested operation remains read-only advice. A provider response
is advice to the current worker, not authorization to edit, commit, push, message anyone, or expand
scope.

## Prepare the request

Write the complete question to a private `instructions.txt` file. Include the decision needed,
relevant paths, constraints, and the expected answer shape. Keep instruction bytes and MCP secrets
off argv.

For a root request, assert the harness that is making the call:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" advice \
  --caller-harness <codex|grok|kiro|claude|opencode|cursor> \
  --harness <codex|grok|kiro|claude|opencode|cursor> \
  --cwd "$(pwd -P)" \
  --instructions <absolute-private-path>/instructions.txt \
  --result <absolute-private-path>/result.json
```

`--caller-harness` is asserted lineage metadata, not authentication. The supervisor derives nested
caller identity from the parent node instead of trusting a worker-supplied value.

When `HANDOFF_SUPERVISOR_CONTEXT` is present, use the nested form and omit caller and root budgets:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" advice \
  --harness <target-harness> \
  --cwd "$(pwd -P)" \
  --instructions <absolute-private-path>/instructions.txt \
  --result <absolute-private-path>/result.json
```

Use repeatable `--dependency requires:<run-id>`, `--dependency advises:<run-id>`, or
`--dependency verifies:<run-id>` only for nested work scheduled against already-terminal nodes.
Nested `run` and `run-with-advice` are forbidden; an adviser can consult but cannot delegate work.

## Selection and grants

Optional exact flags are:

- `--model <provider-model>`
- `--effort <provider-supported-effort>`
- `--max-turns <1-100>` for Grok and Claude
- `--bash true|false` (default `true`)
- `--web-search true|false` (default `false`; only providers with an exact control accept `true`)
- `--mcp-config <absolute-path>` to a `handoff.mcp.v0.3` descriptor

Omitted model uses `provider-default`. Advice defaults effort to `max` for Codex, Claude, and Kiro,
and to `provider-default` for Grok, OpenCode, and Cursor. Grok and Claude advice defaults to 32 turns;
other providers use their native default. Unsupported explicit model controls, effort values, web,
or MCP isolation reject before provider launch; never silently fall back.

Root-only budget flags default to `--max-depth 3`, `--max-nodes 16`,
`--max-advice-nodes 12`, `--max-handoff-nodes 4`, `--max-concurrency 4`,
`--root-timeout-ms 1800000`, and per-node `--timeout-ms 600000`.

## Consume the result

The driver writes one compact JSON object to stdout and byte-identical bytes to the new result path.
Use `output.response` as the expert answer; inspect `output.evidence`, `output.findings`, selection and
grant receipts, lineage, policy, and diagnostics as needed.

Only exit `0` with status `succeeded` is green. `not_run`, `rejected`, `blocked`, `failed`,
`timed_out`, and `cancelled` mean no usable advice was completed. Report that state honestly and do
not reinterpret an empty response as “no findings.”
