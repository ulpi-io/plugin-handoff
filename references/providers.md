# Provider adapter cheat-sheet

Every provider reduces to the same 6 primitives; only the middle differs. Verified against:
Codex `codex-cli 0.144.5`, Grok "Grok Build TUI", Kiro `kiro-cli chat`, Claude Code `claude -p`,
opencode `1.18.3`, Cursor `cursor-agent 2025.10.28`. **Re-confirm flags against `<cli> --help` when a
provider updates** — pin to reality, never to memory.

| Primitive | codex | grok | kiro | claude | opencode | cursor |
|---|---|---|---|---|---|---|
| Binary (PATH + fallback) | `codex` (`/opt/homebrew/bin`) | `grok` (`~/.grok/bin`) | `kiro-cli` (`~/.local/bin`) | `claude` (`~/.local/bin`) | `opencode` (`~/.opencode/bin`) | `cursor-agent` (`~/.local/bin`) |
| Headless invoke | `codex exec … -` | `grok --prompt-file P` | `kiro-cli chat --no-interactive` | `claude -p --output-format json` | `opencode run` | `cursor-agent -p --output-format text` |
| Prompt as literal bytes | **stdin** (the `-`) | **`--prompt-file P`** (bytes in file) | **stdin** | **stdin** (no positional) | **`--file P`** (bytes in file) | **stdin** (no positional) |
| Trust lever | `-s read-only \| workspace-write \| danger-full-access` | `--permission-mode plan \| auto \| bypassPermissions` | `--trust-tools=…` / `--trust-all-tools` | `--permission-mode manual \| auto \| bypassPermissions` | `--agent plan \| build` / `--auto` | `-f/--force` (NO read-only lever) / `--approve-mcps` |
| review (read-only) | `-s read-only` | `--permission-mode plan` | `--trust-tools=fs_read,execute_bash` | `--permission-mode manual` | `--agent plan` | `-p` (no `--force`) — **best-effort only** |
| build (least-write) | `-s workspace-write` | `--permission-mode auto` | `--trust-tools=fs_read,fs_write,execute_bash` | `--permission-mode auto` | `--agent build` | `-p --force` (force-allow) |
| autonomous (opt-in only) | `-s danger-full-access` | `--permission-mode bypassPermissions` | `--trust-all-tools` | `--permission-mode bypassPermissions` | `--agent build --auto` | `-p --force --approve-mcps` |
| model / effort | `-m` / (config) | `-m` / `--effort` | `--model` / `--effort` | `--model` / `--effort` | `-m provider/model` / `--variant` | `--model` / (none) |
| structured findings | `--output-schema FILE` | `--json-schema '<inline>'` | none — ask for JSON in the prompt | `--json-schema '<inline>'` → `structured_output` | none — ask for JSON in the prompt | none — ask for JSON in the prompt |
| final message capture | `-o/--output-last-message FILE` | `--output-format json` (stdout) | stdout (markdown) | `.result` in JSON envelope (stdout) | stdout (text) | stdout (text) |
| resume | native `codex exec resume` (not via handoff v1) | `-r/--resume [ID]` / `-c` | `-r` / `--resume-id ID` | `--continue` / `--resume ID` | `-c` / `--session ID` | `--continue` / `--resume ID` |
| working dir | `-C DIR` | `--cwd DIR` | (process cwd) | (process cwd) | `--dir DIR` | (process cwd) |
| NEVER default | `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` | `--trust-all-tools` | `--permission-mode bypassPermissions` | `--auto` | `--force` on a review |

Notes:
- Codex `exec` is already non-interactive — there is **no** `--full-auto` in 0.144.5; the sandbox policy
  alone gates writes.
- Grok `--sandbox` takes a named *profile* (env `GROK_SANDBOX`), so handoff uses `--permission-mode` as
  the portable trust lever instead of a profile name it can't assume exists.
- Kiro `chat` has no structured-output flag (`--format` is only for `--list-*`), so review findings come
  back as text; the brief asks for a JSON block when structure is needed.
- Claude `-p` reads the prompt from stdin (no positional argument). `plan` mode is **not**
  headless-suitable (it blocks waiting on interactive `ExitPlanMode`), so review uses `manual` — which
  denies edits and mutating bash in headless while allowing read-only inspection. `build` uses `auto`
  (edits + bash auto-approved via the safety classifier, dangerous patterns blocked) — a scoped lever,
  **not** the `bypassPermissions` bypass. Structured review returns the schema-conforming object under
  the envelope's `structured_output` field.
- opencode ships `plan` (read-only: edits/bash gated) and `build` primary agents, selected with
  `--agent`; `run` is non-interactive by default (`-i` opts into interactive). No clean structured-output
  flag (`--format json` is a raw event stream), so review findings come back as text and the brief asks
  for a JSON block. The brief is delivered via `--file` (a PATH); the only positional argument is a fixed
  "follow the attached brief" instruction — never the (untrusted) brief bytes.
- Cursor `-p` already "has access to all tools, including write and bash" and exposes **no per-run
  read-only lever** — permissions live only in `~/.cursor/cli-config.json` (or `<cwd>/.cursor/cli.json`).
  So `review` is **best-effort read-only**: it runs `-p` without `--force`, relying on Cursor's allowlist
  approval mode (un-allowed writes get no approval in headless) plus the read-only brief — weaker than
  the other five. `build` uses `-p --force` (force-allow), verified by the real git diff. The prompt goes
  on **stdin** (cursor has no `--prompt-file`); if cursor ignored stdin the run just fails closed — never
  an argv leak. Auth is probed with `--version` only; **never** `status`/`whoami` (they start a login
  flow). A logged-out cursor exits nonzero at run time (surfaced honestly, never a fake clean).

Adding a provider = one `scripts/lib/providers/<name>.mjs` implementing `locate / authOk / invocation /
capture`, plus two command shims. The driver (`scripts/handoff.mjs`) already owns everything else.
