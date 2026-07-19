# handoff v0.3.0

`handoff` exposes one execution path: the versioned, fail-closed machine ABI. Every slash command
prepares a strict request and invokes that same driver. There is no direct provider helper and no
weaker fallback.

The wire schemas remain `handoff.*.v0.2`; the driver, bundle, and both plugin manifests are version
`0.3.0` because this release removes the second execution surface and adds strict Claude, OpenCode,
and Cursor adapters.

## Slash commands

Each command is on its own line for direct copy/paste:

```text
/handoff:codex-build <request>
/handoff:codex-review <request>
/handoff:grok-build <request>
/handoff:grok-review <request>
/handoff:claude-build <request>
/handoff:claude-review <request>
/handoff:opencode-build <request>
/handoff:opencode-review <request>
/handoff:cursor-build <request>
/handoff:cursor-review <request>
/handoff:kiro-review <request>
```

Codex, Grok, Claude, OpenCode, and Cursor support `build`, `phase`, `review`, and `verify` through the
machine ABI. Kiro supports only `review` and `verify`; there is deliberately no Kiro build command.
An unsupported role is rejected before request parsing or provider launch.

## Absolute-path invocation

The plugin does not install or promise a `handoff` executable on `PATH`. Invoke the checked-in Node
entry points by absolute path.

First put the literal task in a new private instructions file, then create the request:

```bash
node /absolute/path/to/handoff/scripts/prepare-request.mjs \
  --provider claude \
  --role review \
  --cwd /absolute/path/to/git-worktree \
  --instructions /absolute/private/temp/instructions.txt \
  --request /absolute/private/temp/request.json
```

Run the request and reserve a new result path:

```bash
node /absolute/path/to/handoff/scripts/handoff.mjs run \
  --provider claude \
  --role review \
  --cwd /absolute/path/to/git-worktree \
  --request /absolute/private/temp/request.json \
  --result /absolute/private/temp/result.json
```

Discover the current adapter matrix and installed-CLI preflight state with:

```bash
node /absolute/path/to/handoff/scripts/handoff.mjs capabilities --json
```

The driver writes exactly one compact JSON object to stdout. On a run with a valid result path, the
result file contains the byte-identical object. Bounded, credential-redacted diagnostics are written
to stderr and retained in the normalized result; they never become extra stdout records. Unknown or duplicate flags, relative
or unsafe paths, symlinks, malformed requests, unsupported roles, and existing result files fail
closed.

## Request and result contracts

[`contracts/v0.2/request.schema.json`](contracts/v0.2/request.schema.json) is the request authority.
Unknown fields are rejected. A minimal non-Codex request is:

```json
{
  "schemaVersion": "handoff.request.v0.2",
  "instructions": "Review the bounded change and return concrete findings.",
  "timeoutMs": 600000
}
```

`timeoutMs` is optional and must be between 100 and 3,600,000 milliseconds. `model` and `effort` are
optional non-option strings. The result's request hash is SHA-256 over the exact request-file bytes.

Codex additionally requires a `handoff.coordinator-approval.v0.2` object. The request preparer builds
it automatically and binds the exact request, role, canonical cwd, and every applicable instruction
file it can discover:

- the global `AGENTS.override.md` or `AGENTS.md` under `$CODEX_HOME`, falling back to `~/.codex`;
- one applicable `AGENTS.override.md` or `AGENTS.md` at each directory from the Git root to cwd.

The driver independently reconstructs and verifies the repository chain, verifies every content
digest, recomputes the approval subject hash, disables Codex's native project-document loading, and
injects the approved rule set into the prompt. Global-rule completeness and coordinator identity are
coordinator assertions because the driver has no signed external authority; the normalized policy
states that limitation instead of claiming driver verification.

Providers must ultimately produce exactly one object matching
[`contracts/v0.2/provider-output.schema.json`](contracts/v0.2/provider-output.schema.json). Native
envelopes and event streams are normalized before that validation. Missing, malformed, noisy,
oversized, prose-only, version-drifted, unknown-field, or unsafe-path output fails closed. The final
object follows [`contracts/v0.2/result.schema.json`](contracts/v0.2/result.schema.json) and includes:

- schema, driver, and bundle versions plus the deterministic bundle digest;
- provider id/version, role, and the policy actually selected;
- exact request hash, status, provider/driver exit information, and signal state;
- structured evidence/findings and observed usage or an explicit not-reported value;
- deterministic before/after Git fingerprints and changed paths;
- wall timing and bounded, redacted diagnostics.

Driver exits are `0` success, `2` provider failure/block, `3` unavailable or failed capability
preflight, `5` rejected input, `7` invalid output, `8` timeout, `9` cancellation, and `10` policy
block. A successful `build` or `phase` with no Git-observable change is blocked. A `review` or
`verify` that changes the supplied worktree is blocked, even when the provider reports success.

## Provider policies

`pipeline.safe: true` means this repository implements the role and will launch it only after the
installed binary proves the required local capability checks. It does not mean that merely finding a
binary is enough: `pipeline.preflight.ok` is the runtime authority.

| Provider | Roles | Write roles | Read roles | Strict defaults and boundary |
|---|---|---|---|---|
| Codex | all four | native `workspace-write` | native `read-only` | ephemeral execution; user config and exec-policy rules ignored; approvals and sandbox network disabled; exact coordinator-bound AGENTS rules injected; no Git-check skip or sandbox bypass |
| Grok | all four | named `workspace` profile | named `read-only` profile | cwd pinned; 12 turns; native JSON Schema; web search, subagents, and memory disabled; both named profiles locally initialized during preflight |
| Claude | all four | Bash, Edit, and Write exposed; Bash children use the native sandbox | only Read, Glob, and Grep exposed | `--bare`, `--safe-mode`, no persistence, no browser, strict empty MCP set, `dontAsk`, 12 turns, native JSON Schema; sandbox startup and unsandboxed Bash escape fail closed |
| OpenCode | all four | Read, Glob, Grep, and Edit only | Read, Glob, and Grep only | temporary HOME/config/cache/state; project config, plugins, skills, MCP, Bash, web tools, subagents, LSP, questions, and external-directory access denied; exact resolved agent permissions preflighted; raw JSON events normalized |
| Cursor | all four | target worktree passed through native `--allow-paths`; `--force` | target worktree passed through native `--readonly-paths`; no `--force` | isolated temporary sandbox workspace and HOME/XDG roots; preflight behavior-proves both target-path modes; one JSON result envelope; Git mutation blocking remains defense in depth |
| Kiro | review, verify | unsupported | `fs_read` only | permission allowlist only; no `execute_bash`, no trust-all mode, and no native filesystem-isolation claim |

### What those guarantees mean

[The Codex CLI reference](https://developers.openai.com/codex/cli/reference/) documents `exec` as
the scripted/CI surface, and the
[configuration reference](https://developers.openai.com/codex/config-reference/) defines the
`read-only`/`workspace-write` sandbox modes, `approval_policy`, and workspace network control.
Codex preflight requires its ephemeral/config-isolation, sandbox, cwd, output-schema, and
last-message flags and proves the strict config keys used to disable native project documents, rules,
approvals, and network. The driver never passes `--skip-git-repo-check`, `danger-full-access`, or a
dangerous approval/sandbox bypass.

[Claude Code documents](https://code.claude.com/docs/en/cli-usage) bare mode, safe mode, explicit tool
selection, no-session persistence, and JSON Schema output. Its
[sandbox documentation](https://code.claude.com/docs/en/sandboxing) is specific: the OS sandbox
constrains Bash and child processes, while built-in file tools remain governed by Claude's permission
system. Handoff therefore does not call Claude's file tools a native OS sandbox. The adapter sets
`sandbox.enabled`, `failIfUnavailable`, and `allowUnsandboxedCommands: false`. Admin-managed Claude
settings still have higher precedence and are reported as honored; deployments that do not trust
their managed policy must isolate the entire run externally. Bare mode also requires API-key or
third-party-provider authentication rather than Claude's OAuth/keychain session.

[OpenCode documents](https://opencode.ai/docs/permissions/) granular allow/ask/deny permissions and
[`opencode run --format json`](https://opencode.ai/docs/cli/) as raw JSON events. Handoff applies one
exact deny-by-default named-agent policy, disables project configuration and external extensions,
and preflights the resolved permission object before every run. This is provider tool-permission
confinement, not OS filesystem isolation. Authentication and session data remain in OpenCode's data
directory; temporary configuration roots are removed after the run.

[Cursor documents](https://docs.cursor.com/en/cli/headless) that `--force` applies headless changes
while omission proposes them, and
[its JSON format](https://docs.cursor.com/en/cli/reference/output-format) as one result envelope.
The installed `sandbox run` surface additionally exposes `--allow-paths` and `--readonly-paths`.
Handoff starts that sandbox from a temporary workspace, passes the target worktree through the exact
role-specific path mode, and behavior-probes read/write results before launch. Review/verify therefore
have a native read-only target boundary as well as the before/after Git block. Global Cursor config is
isolated through temporary HOME/XDG roots; provider-native project rules may still be read. Network is
enabled inside the outer sandbox so the nested provider can reach its API.

[xAI's Grok sandbox table](https://docs.x.ai/build/enterprise#sandbox) defines `workspace` as
read-everywhere with writes to cwd, `/tmp`, and `~/.grok/`, and `read-only` as read-everywhere with
writes only to Grok state and temporary directories. These are repository write boundaries, not
host-wide immutability or cwd-only reads. xAI documents Landlock on Linux and Seatbelt on macOS;
child-network blocking for `read-only` is platform-dependent, so Handoff reports the narrower
guarantee instead of universal network isolation.

Kiro's [custom-agent tool configuration](https://kiro.dev/docs/cli/custom-agents/configuration-reference/)
controls permission, not a kernel filesystem boundary. Kiro is therefore limited
to review/verify with `fs_read`. An external receipt is not accepted as a role upgrade, and the driver
never falls back to trust-all tools.

### Same-UID threat model

A native provider sandbox constrains the delegated provider process according to that provider's
actual policy. The Handoff protocol is not a boundary against the coordinator or another process
running as the same OS user. Such a process can inspect or interfere with files outside the native
sandbox's protection. Use a container, VM, or OS-level sandbox around the complete caller/provider
pair when that actor is outside the trust boundary.

## Git evidence

The driver first verifies that cwd belongs to a Git worktree, then reads HEAD. Fingerprints cover
HEAD, index records, staged and unstaged content, tracked and untracked files, deletions, renames,
executable modes, and symlink targets. Git paths are consumed as NUL-delimited bytes, so spaces and
newlines are not line-parsed or lost. Fingerprints are deterministic for the same repository state.

Handoff does not create disposable worktrees. The coordinator must supply one when it needs rollback,
concurrent-run isolation, or a stronger boundary than post-run mutation detection.

## Deterministic bundle and hermetic tests

[`bundle-digest.json`](bundle-digest.json) covers both manifests, every contract, the driver, request
preparer, shared security modules, and all six provider adapters in stable path order. Every machine
command fails closed when the checked-in digest drifts.

```bash
node scripts/bundle-digest.mjs --check
node --test scripts/test-pipeline-e2e.mjs
```

The E2E suite creates temporary Git repositories and six fake provider executables. It crosses real
subprocess/request/result boundaries and exercises all advertised roles, timeouts, cancellation,
schema drift, untracked-only changes, reviewer mutation, symlink/path traversal, noisy/prose-only and
oversized output, policy preflight failures, and exit mapping. It needs no network, live provider,
authentication, or global provider configuration.

MIT · ulpi.io
