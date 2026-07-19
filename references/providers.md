# Provider adapter reference (handoff v0.3.0)

Every provider below is reached only through `scripts/handoff.mjs run`. Capabilities advertise the
roles implemented by the strict adapter; a run still requires the installed binary's preflight to
pass. There is no alternate invocation path.

## Invocation matrix

| Boundary | Codex | Grok | Claude | OpenCode | Cursor | Kiro |
|---|---|---|---|---|---|---|
| Binary | `codex` | `grok` | `claude` | `opencode` | `cursor-agent` | `kiro-cli` |
| Roles | all four | all four | all four | all four | all four | review, verify |
| Prompt transport | stdin | private temporary file | stdin | stdin | stdin | stdin |
| Write role | `workspace-write` | `workspace` | write tools plus native Bash sandbox | permission-scoped Edit, no Bash | target passed with native `--allow-paths`, `--force` | rejected |
| Read role | `read-only` | `read-only` | Read/Glob/Grep only | Read/Glob/Grep only | target passed with native `--readonly-paths`, no `--force` | `fs_read` only |
| Provider result | native schema + last-message file | native JSON Schema | native schema in JSON envelope | normalized raw JSON events | strict object inside one JSON envelope | strict prompt object |
| Cwd pin | CLI flag plus child cwd | CLI flag plus child cwd | child cwd | `--dir` plus child cwd | child cwd and outer sandbox workspace | child cwd |
| Persistence | ephemeral | no memory flag; provider state writable | no session persistence | session/auth data retained | provider-native state may persist | provider-native state may persist |

“All four” means `build`, `phase`, `review`, and `verify`.

## Preflight authority

- Codex: required exec flags plus strict recognition of the exact approval, project-document,
  root-marker, and network configuration keys.
- Grok: both exact named sandbox profiles initialize and reach the local structured-result parser.
- Claude: every required control flag plus bare-mode structured-result parsing. Runtime sandbox
  failure also blocks the run.
- OpenCode: global/run flags plus byte-equivalent resolved permissions for the selected named agent.
- Cursor: main and sandbox flags plus behavior probes proving the target repository is readable but
  not writable through `--readonly-paths`, and writable through `--allow-paths`.
- Kiro: non-interactive chat and exact tool-trust flag support.

Missing binaries, flag drift, failed probes, and unsupported roles are `not_run`; no provider process
is launched for the task.

## Policy details

### Codex

[Codex's CLI reference](https://developers.openai.com/codex/cli/reference/) identifies `exec` as its
scripted/CI surface. Handoff uses `exec --ephemeral --ignore-user-config --ignore-rules --strict-config`, disables approvals
and sandbox network, pins cwd, and selects `workspace-write` or `read-only`. Native AGENTS loading is
disabled only after strict config-key preflight. The coordinator-approved global and repository
AGENTS chain is then injected in the prompt and recorded in the result. Repository completeness is
driver-verified; global completeness and coordinator identity are explicit coordinator assertions.

The adapter never uses a Git-repository-check skip, `danger-full-access`, or a dangerous
approval/sandbox bypass.

### Grok

Grok uses the built-in `workspace` and `read-only` profiles with cwd pinned, a 12-turn bound, native
JSON Schema, and web search, subagents, and memory disabled. Per xAI's
[sandbox table](https://docs.x.ai/build/enterprise#sandbox), both profiles can read beyond cwd.
`workspace` can write cwd, temporary directories, and Grok state; `read-only` retains only temporary
and Grok-state writes. Child-network enforcement differs by platform and is reported narrowly.

### Claude

Claude uses bare and safe modes, strict empty MCP configuration, disabled skills/browser/session
persistence, `dontAsk`, an explicit tool list, 12 turns, and native JSON Schema output. Write roles
expose Bash/Edit/Write/Read/Glob/Grep. Read roles expose only Read/Glob/Grep.

Claude's [native sandbox](https://code.claude.com/docs/en/sandboxing) applies to Bash and its children;
the built-in file tools remain permission-controlled. The adapter enables the sandbox, requires
startup success, and disables the unsandboxed-command escape hatch. Admin-managed settings remain in
force and outrank command-line settings, so the result reports them as honored rather than ignored.
Bare mode uses API-key or supported third-party-provider authentication, not the normal OAuth/keychain
session.

### OpenCode

OpenCode runs with a temporary HOME and XDG config/cache/state, `--pure`, project configuration
disabled, and an exact named-agent policy. Every unspecified permission is denied. Bash, web fetch,
web search, subagents, skills, LSP, questions, MCP, and external-directory access are denied. Write
roles add only Edit; read roles deny it. The driver parses each raw event, enforces one session and a
terminal text result, and aggregates observed usage across every complete step-finish event.

This is a preflighted OpenCode permission boundary, not OS filesystem isolation. The provider data
directory remains available for authentication and session state.

### Cursor

The entire nested headless agent runs under the installed CLI's `sandbox run` command from an isolated
temporary workspace and HOME/XDG tree. Write roles pass the target with `--allow-paths` and use
`--force`; read roles pass it with `--readonly-paths` and omit `--force`. Preflight proves both path
boundaries by behavior, not merely flag names. Deterministic post-run mutation blocking remains a
second enforcement layer.

The adapter accepts only Cursor's documented single success envelope and validates its result string
against the provider schema. Network is enabled for the nested agent so it can reach the model API.

### Kiro

Kiro is review/verify-only. Its invocation trusts exactly `fs_read`; `execute_bash` is absent. Per
Kiro's [tool configuration reference](https://kiro.dev/docs/cli/custom-agents/configuration-reference/), this is
a tool-permission allowlist, not native filesystem isolation. Build/phase are rejected and no receipt
or fallback can upgrade them.

## Shared enforcement

All adapters use the same strict request/result schemas, output limit, timeout/cancellation mapping,
redaction, Git fingerprints, build-change requirement, and review-mutation block. Provider-native
sandboxing is not a boundary against the coordinator or another same-UID process. External
container/VM/OS confinement is required when either is outside the trust boundary.
