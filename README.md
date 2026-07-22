# Handoff

Handoff lets a Claude Code or Codex agent give a bounded task to another AI harness. It can also
ask another model for a read-only second opinion.

Supported targets are Codex, Grok, Kiro, Claude, OpenCode, and Cursor. Handoff uses each target's
installed CLI and existing login or API-key configuration.

The important choice is whether the worker should be allowed to ask for advice while it works.

## Install Handoff

Handoff is published through the [Ulpi plugin marketplace](https://github.com/ulpi-io/marketplace).

### Claude Code

```text
/plugin marketplace add ulpi-io/marketplace
/plugin install handoff@ulpi
```

### Codex

```bash
codex plugin marketplace add ulpi-io/marketplace
codex plugin add handoff@ulpi
```

Restart the host after installing or updating the plugin so it discovers the current skills and
commands.

Each plugin is installed from its own repository. Handoff updates are published here, not in the
marketplace repository.

## Choose how to delegate

Handoff provides three deliberately separate workflows:

| What you need | Use | What the target may do |
|---|---|---|
| A second opinion | `get-advice` | Answer read-only; it may request more read-only advice |
| A worker that finishes independently | `handoff-<target>` | Complete the assigned task; it cannot call Handoff |
| A worker that may consult another model | `handoff-<target>-with-advice` | Complete the task and request nested read-only advice |

The `with-advice` form does **not** let a worker delegate more work. Its only nested capability is
read-only advice. Plain handoff gives the worker no nested Handoff capability at all.

## Skills

Claude Code and Codex receive the same 15 Handoff skills. The only difference is invocation syntax:
Claude Code uses `/handoff:<skill>`, while Codex uses `$handoff:<skill>`.

| Purpose | Claude Code | Codex |
|---|---|---|
| Ask any supported model for advice | `/handoff:get-advice` | `$handoff:get-advice` |
| Choose the target at runtime | `/handoff:handoff-run` | `$handoff:handoff-run` |
| Choose the target at runtime and allow advice | `/handoff:handoff-run-with-advice` | `$handoff:handoff-run-with-advice` |
| Hand off to Codex | `/handoff:handoff-codex` | `$handoff:handoff-codex` |
| Hand off to Codex with advice | `/handoff:handoff-codex-with-advice` | `$handoff:handoff-codex-with-advice` |
| Hand off to Grok | `/handoff:handoff-grok` | `$handoff:handoff-grok` |
| Hand off to Grok with advice | `/handoff:handoff-grok-with-advice` | `$handoff:handoff-grok-with-advice` |
| Hand off to Kiro | `/handoff:handoff-kiro` | `$handoff:handoff-kiro` |
| Hand off to Kiro with advice | `/handoff:handoff-kiro-with-advice` | `$handoff:handoff-kiro-with-advice` |
| Hand off to Claude | `/handoff:handoff-claude` | `$handoff:handoff-claude` |
| Hand off to Claude with advice | `/handoff:handoff-claude-with-advice` | `$handoff:handoff-claude-with-advice` |
| Hand off to OpenCode | `/handoff:handoff-opencode` | `$handoff:handoff-opencode` |
| Hand off to OpenCode with advice | `/handoff:handoff-opencode-with-advice` | `$handoff:handoff-opencode-with-advice` |
| Hand off to Cursor | `/handoff:handoff-cursor` | `$handoff:handoff-cursor` |
| Hand off to Cursor with advice | `/handoff:handoff-cursor-with-advice` | `$handoff:handoff-cursor-with-advice` |

For example:

```text
# Claude Code
/handoff:get-advice Ask Claude to challenge the caching design in this repository.

# Codex
$handoff:get-advice Ask Claude to challenge the caching design in this repository.

$handoff:handoff-grok Implement the bounded task described in issue 42 and run its focused tests.

$handoff:handoff-codex-with-advice Build the import flow. The worker may ask another model for
read-only advice if it gets stuck.
```

## Who can ask whom for advice?

The caller and the adviser are independent choices. They may use the same harness or different
harnesses. Asking the same harness still starts a separate, bounded model process; it does not ask
the current conversation to answer itself.

| Flow | What the user invokes |
|---|---|
| Claude Code asks Claude | `/handoff:get-advice Ask Claude to review this design.` |
| Codex asks Codex | `$handoff:get-advice Ask Codex to review this design.` |
| Claude Code asks Codex | `/handoff:get-advice Ask Codex to review this design.` |
| Codex asks Claude | `$handoff:get-advice Ask Claude to review this design.` |

A delegated worker, such as Grok, can ask for advice only when it was launched with the
`with-advice` family. For example:

```text
# From Claude Code
/handoff:grok-build-with-advice Implement the parser and ask Claude for advice if needed.

# From Codex
$handoff:handoff-grok-with-advice Implement the parser and ask Claude for advice if needed.
```

If Grok decides to consult Claude, Handoff has already given it an advice-only supervisor context
and the exact absolute driver path. Grok invokes the nested equivalent of:

```bash
node /absolute/path/to/handoff/scripts/handoff.mjs advice \
  --harness claude \
  --cwd /absolute/path/to/worktree \
  --instructions /absolute/private/advice.txt \
  --result /absolute/private/advice-result.json
```

The nested command deliberately has no `--caller-harness`: the supervisor knows Grok is the caller.
It also has no root budget flags. Grok can ask Claude for read-only advice, but it cannot ask Claude
to invoke a nested build, phase, review, verify, or another handoff operation.

## Claude Code build and review shortcuts

Claude Code plugins can ship custom slash commands in addition to shared skills. Handoff uses that
host feature to provide shorter build and review commands. Codex plugins do not have a matching
custom-command directory, so Codex users invoke the shared skills above instead.

| Target | Plain commands | Commands that allow advice |
|---|---|---|
| Codex | `/handoff:codex-build`, `/handoff:codex-review` | `/handoff:codex-build-with-advice`, `/handoff:codex-review-with-advice` |
| Grok | `/handoff:grok-build`, `/handoff:grok-review` | `/handoff:grok-build-with-advice`, `/handoff:grok-review-with-advice` |
| Kiro | `/handoff:kiro-review` | `/handoff:kiro-review-with-advice` |
| Claude | `/handoff:claude-build`, `/handoff:claude-review` | `/handoff:claude-build-with-advice`, `/handoff:claude-review-with-advice` |
| OpenCode | `/handoff:opencode-build`, `/handoff:opencode-review` | `/handoff:opencode-build-with-advice`, `/handoff:opencode-review-with-advice` |
| Cursor | `/handoff:cursor-build`, `/handoff:cursor-review` | `/handoff:cursor-build-with-advice`, `/handoff:cursor-review-with-advice` |

For example:

```text
/handoff:codex-review Review the authentication changes for security regressions.

/handoff:grok-build-with-advice Implement the timeline writer fix and run the focused test suite.
```

## What a worker can be asked to do

Handoff supports four task modes:

| Mode | Meaning | File changes |
|---|---|---|
| `build` | Implement a bounded change | Required |
| `phase` | Complete one bounded implementation phase | Required |
| `review` | Review code or a plan | Forbidden |
| `verify` | Check a claim or completed change | Forbidden |

Build and phase only succeed when Handoff observes a Git change. Review, verify, and advice are
blocked if the supplied worktree changes. Kiro currently supports review and verify only.

## Choose the model, effort, and turn limit

Every workflow accepts provider-specific selection controls:

- `--model` selects an exact model.
- `--effort` selects a reasoning level supported by that provider.
- `--max-turns` sets an exact turn limit for Grok and Claude.

Defaults are intentionally conservative:

| Request | Default effort | Default turns |
|---|---|---|
| Advice from Codex, Claude, or Kiro | `max` | Claude: 32; others: provider default |
| Advice from Grok | Provider default | 32 |
| Advice from OpenCode or Cursor | Provider default | Provider default |
| Any handoff | Provider default | Grok and Claude: 12; others: provider default |

Handoff never pretends an unsupported control worked. An invalid model, effort, turn limit, or
permission is rejected before the target launches. Cursor, for example, has no exact effort control.

## Control the worker's tools

The supervising agent can explicitly control the tools exposed to the target:

- Bash access is enabled by default and can be disabled with `--bash false` when the provider
  supports that restriction.
- Web search is disabled by default. Enable it with `--web-search true` when the provider supports
  an exact web-search control.
- No MCP servers are passed by default. Use `--mcp-config` to provide a specific, private set.

Nested advice can keep or reduce the parent's permissions. It can never gain Bash, web, or MCP
access that the parent did not have.

Provider controls differ because their CLIs provide different isolation features. See the
[provider capability matrix](references/providers.md) for the exact boundaries of each target.

## Give a worker access to MCP servers

MCP access is optional and limited to the servers you explicitly provide for that run. Handoff does
not expose every MCP configured in the supervising agent's environment.

Pass `--mcp-config` an absolute path to a JSON file like this:

```json
{
  "schemaVersion": "handoff.mcp.v0.3",
  "servers": [
    {
      "name": "local-docs",
      "transport": "stdio",
      "command": "/usr/bin/env",
      "args": ["node", "/absolute/path/server.mjs"],
      "env": {
        "TOKEN": { "fromEnv": "DOCS_MCP_TOKEN" }
      }
    },
    {
      "name": "remote-search",
      "transport": "http",
      "url": "https://mcp.example.com/rpc",
      "headers": {
        "Authorization": { "fromEnv": "SEARCH_MCP_AUTH" }
      }
    }
  ]
}
```

The file names the environment variables that hold secrets; it does not contain the secret values.
Handoff keeps those values out of prompts, result files, and command arguments. If a provider cannot
receive a private MCP configuration safely, the request is rejected instead of falling back to its
ambient MCP configuration.

## How Handoff keeps delegation bounded

All targets run through the same fail-closed driver:

- The complete task is written to a private instruction file rather than placed in process
  arguments.
- Handoff records the caller, target, task mode, chosen model, permissions, and delegation mode.
- Read-only work is checked for unexpected Git mutations.
- Build work must produce a Git-observable change.
- Unsupported settings and invalid provider output fail visibly.
- A private root lease prevents a worker from stripping its environment and starting a new root
  handoff.
- Advice-enabled runs use a temporary supervisor that owns lineage, budgets, and advice-only
  capabilities. It is removed when the root run ends.

The same-user limitation is explicit: these controls do not defend against a malicious coordinator
or another process running as the same operating-system user that deliberately tampers with Handoff
state. Use a container or virtual machine when that process is outside your trust boundary.

## Results and failures

Handoff writes the normalized result to the requested JSON file and prints the same JSON to stdout.
The main answer is in `output.response`; supporting evidence and findings are separate fields.

A run is successful only when the process exits with code `0` **and** the result status is
`succeeded`. An empty or failed result must never be reported as "no findings."

Common exit codes are:

| Exit | Meaning |
|---:|---|
| `0` | Succeeded |
| `2` | Provider failed or blocked |
| `3` | Provider unavailable |
| `5` | Request rejected |
| `7` | Provider returned invalid output |
| `8` | Timed out |
| `9` | Cancelled |
| `10` | Policy blocked the request |

The result also includes Git fingerprints, timing, usage, diagnostics, resolved model and permission
receipts, and the delegation DAG when advice was available.

## Advanced: call the bundled driver directly

Handoff does not install a global `handoff` command. Skills and Claude commands call the bundled
Node entrypoint:

```text
node ${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs ...
```

Instructions and results must use private absolute paths.

### Ask for advice

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" advice \
  --caller-harness codex \
  --harness claude \
  --cwd "$(pwd -P)" \
  --instructions /absolute/private/instructions.txt \
  --model fable \
  --effort max \
  --max-turns 32 \
  --bash true \
  --web-search true \
  --result /absolute/private/advice-result.json
```

Advice is always read-only. It cannot gain write authority even when the selected target also
supports build work.

### Run a plain handoff

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" run \
  --caller-harness codex \
  --harness grok \
  --mode build \
  --cwd "$(pwd -P)" \
  --instructions /absolute/private/instructions.txt \
  --model grok-code-fast \
  --effort high \
  --max-turns 24 \
  --result /absolute/private/handoff-result.json
```

### Run a handoff that allows advice

```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/scripts/handoff.mjs" run-with-advice \
  --caller-harness codex \
  --harness grok \
  --mode build \
  --cwd "$(pwd -P)" \
  --instructions /absolute/private/instructions.txt \
  --result /absolute/private/handoff-result.json
```

The worker may then use the same entrypoint with the `advice` operation. It cannot start another
`run` or `run-with-advice` operation.

## Advanced: budgets and lineage

Advice-enabled roots use these default limits:

| Limit | Default |
|---|---:|
| Nesting depth | 3 |
| Total DAG nodes | 16 |
| Advice nodes | 12 |
| Handoff nodes | 4 |
| Concurrent nodes | 4 |
| Root timeout | 30 minutes |
| Per-node timeout | 10 minutes |

The corresponding flags are `--max-depth`, `--max-nodes`, `--max-advice-nodes`,
`--max-handoff-nodes`, `--max-concurrency`, `--root-timeout-ms`, and `--timeout-ms`. Nested calls
cannot change root budgets.

Nested dependencies may be declared as `requires:<run-id>`, `advises:<run-id>`, or
`verifies:<run-id>`. The supervisor derives the caller, root, parent, depth, and delegation receipt;
workers cannot author or widen those fields. Root Handoffs are serialized per operating-system user.

## Inspect capabilities

Ask the installed driver for its exact current provider support:

```bash
node scripts/handoff.mjs capabilities --json
```

This reports available providers, selection controls, tool grants, isolation guarantees, task
modes, defaults, and the sealed bundle version.

## Validate a checkout

```bash
node scripts/bundle-digest.mjs --check
node --test scripts/test-release-v04.mjs
```

The capability tests inspect local CLI help, configuration, and sandbox behavior. They do not make
model calls, authenticated web requests, or ambient configuration changes.

MIT · ulpi.io
