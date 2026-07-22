# Provider adapter reference (handoff v0.4.0)

Every provider is reached through `scripts/handoff.mjs` and the same machine executor. “Supported”
still requires that the installed CLI's authentication-free preflight passes for the requested mode.

## Delegation choice

Plain `run` records delegation `none` and gives the worker no supervisor capability. Root `advice`
and explicit `run-with-advice` record `advice-only` and expose one authenticated private mailbox.
That capability accepts nested read-only advice only; it never accepts build, phase, review, verify,
`run`, or `run-with-advice`. Consultation is optional and is never started automatically.

## Selection, grants, and confinement

| Target | Model | Effort | Turns | Bash | Web | Private MCP | Write boundary | Read-only boundary |
|---|---|---|---|---|---|---|---|---|
| Codex | yes | yes | native default | on/off | no | stdio; constrained HTTP auth | native `workspace-write` | native `read-only` |
| Grok | yes | yes | 1–100 | on/off | yes | no proved isolated surface | native `workspace` | native `read-only` |
| Claude | yes | yes | 1–100 | on/off | yes | yes | file tools plus fail-closed Bash sandbox | no write tools; Bash deny-write sandbox; final Git check |
| OpenCode | yes | variant | native default | on/off | yes | yes | permission-only Edit/Bash | permission-only tools plus final Git check |
| Cursor | yes | no exact control | native default | on; `false` rejects | no | isolated temporary HOME | native target `--allow-paths` when behavior probe passes | native target `--readonly-paths` |
| Kiro | yes | yes | native default | on/off | no | no proved isolated surface | build/phase not advertised | permission-only `fs_read`/optional Bash plus final Git check |

Provider-default selections are recorded rather than guessed. Explicit unsupported effort, turn,
web, MCP, or Bash controls reject; Handoff never silently substitutes another model or permission.

## Adapter notes

### Codex

Codex runs `exec` with ephemeral/user-config/rules isolation, strict configuration, coordinator-bound
AGENTS rules, approvals disabled, and an explicit native sandbox. `model_reasoning_effort` is a
strict config value. `bash=false` disables `shell_tool`. MCP servers become strict invocation config;
environment values remain in child env rather than argv. Codex web search is not enabled by Handoff.

### Grok

Grok uses its exact `workspace` or `read-only` named sandbox, pinned cwd, explicit tools and denies,
configurable web search, and 1–100 turns. Plan mode, subagents, and memory are disabled. Handoff
normalizes both direct provider objects and the current `structuredOutput`/`text` envelope. Private,
invocation-isolated MCP configuration has not been proved, so MCP rejects.

### Claude

Claude uses bare/safe modes, no session persistence or browser, native JSON Schema, explicit tools,
and strict private MCP configuration. Read-only roles can receive Bash, but Bash runs with
fail-if-unavailable sandbox settings and cwd writes denied. Built-in file tools remain governed by
Claude permissions, so Handoff does not claim whole-agent native filesystem isolation. WebSearch and
WebFetch are included only when requested.

### OpenCode

OpenCode runs with temporary config roots, project config/extensions disabled, and a deny-by-default
named-agent permission object. Bash, web tools, editing, and approved MCP are independently resolved.
The permission object is not an OS sandbox; results say `final-state-detection-only` where relevant.
Raw JSON events are normalized into one provider object.

### Cursor

Cursor runs the headless agent inside `sandbox run` from a temporary HOME/XDG tree. The target is
passed through `--allow-paths` for writes or `--readonly-paths` for read-only work, and each requested
mode is behavior-probed before launch. Some installed Cursor versions virtualize or discard target
writes; those versions correctly return `not_run` for write modes. Only the approved temporary
`~/.cursor/mcp.json` exists and `--approve-mcps` therefore approves that bounded set. Cursor has no
exact effort, web, or Bash-disable control.

### Kiro

Kiro uses its native active-session-first, `KIRO_API_KEY`-second authentication precedence. Handoff
passes model and effort, uses stdin-only one-shot input, never uses trust-all, and selects canonical
`fs_read` and optional `execute_bash` tools for its advertised review/verify modes. These are
permissions, not native filesystem isolation. Current private custom-agent MCP isolation is not
advertised. ANSI/tool-progress frames are normalized before strict provider-output validation.

## Nested-source authority

Targets receive `HANDOFF_SUPERVISOR_CONTEXT` only for root advice or `run-with-advice`; plain workers
receive no context. The context contains a private mailbox path, an `advice-only` operation list,
and a bounded capability token, never a DAG path. Nested advice goes back to the supervisor and the
worker never invokes a provider CLI recursively. Root re-entry and direct machine execution are
blocked by a private active-root lease even if a worker strips the supervisor environment.

## Shared enforcement

All adapters share request/result validation, exact request and intent hashes, private-path checks,
bounded output, timeout/cancellation mapping, redaction, deterministic Git fingerprints,
build-without-change blocking, and read-only mutation blocking. Root Handoffs are serialized per OS
user. Provider sandboxing, mailbox permissions, and the lease are not a boundary against a malicious
same-UID process that copies, deletes, or reparents Handoff state.
