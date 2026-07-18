# handoff — Claude Code & Codex plugin to delegate build & review to Codex, Grok, Kiro, Claude, opencode, or Cursor

Hand off a **build** or **review** to another one-shot headless coding agent — **Codex**, **Grok**,
**Kiro**, **Claude**, **opencode**, or **Cursor** — over a single uniform, fail-closed contract. One
driver, six ~50-line adapters, twelve slash commands. Ships as **both** a Claude Code plugin and a
Codex plugin from this one repo.

```
/handoff:codex-build     <what to build>      /handoff:codex-review     <what to review>
/handoff:grok-build      <what to build>      /handoff:grok-review      <what to review>
/handoff:kiro-build      <what to build>      /handoff:kiro-review      <what to review>
/handoff:claude-build    <what to build>      /handoff:claude-review    <what to review>
/handoff:opencode-build  <what to build>      /handoff:opencode-review  <what to review>
/handoff:cursor-build    <what to build>      /handoff:cursor-review    <what to review> ⚠️ best-effort RO
```

Why it unifies: all six CLIs are one-shot headless agents with a sandbox/trust flag —
`codex exec … -`, `grok --prompt-file`, `kiro-cli chat --no-interactive`, `claude -p`,
`opencode run`, `cursor-agent -p`. A provider is just an adapter that fills the CLI-specific middle;
the driver owns everything reusable.

## Guarantees (identical for every provider/verb)

- **Fail closed.** A CLI that is missing, not authed, or can't run is reported `gateNotRun` — never a
  fabricated clean or block. handoff never auto-installs anything.
- **Verify ground truth.** A `build` is judged by the real `git diff --stat <baseline>` (no diff = not
  done); a `review` by its findings. The delegated agent's self-report is never taken as proof.
- **Trust scoped to the verb.** `review` runs read-only; `build` runs least-write. The dangerous
  bypass lever (`danger-full-access` / `bypassPermissions` / `--trust-all-tools` / `--auto` /
  `--approve-mcps`) is unlocked **only** with an explicit `--mode autonomous`.
- **Injection-safe.** The brief is written to a file and delivered on stdin or as a `--prompt-file` /
  `--file` PATH — never interpolated into a shell string or an argv element.

> **Cursor caveat.** Cursor's headless CLI (`cursor-agent -p`) exposes **no per-run read-only lever**,
> so `cursor-review` is **best-effort read-only** — it runs without `--force` and relies on Cursor's
> allowlist approval mode plus the read-only brief, not a hard sandbox flag. The other five providers
> enforce review read-only with a real lever. For a guaranteed read-only review, prefer another provider.

## Install

### Claude Code

This plugin ships in the `ulpi-autonomous-engineering` marketplace:

```
/plugin marketplace update ulpi-autonomous-engineering   # or: /plugin marketplace add <this repo>
/plugin install handoff@ulpi-autonomous-engineering
/reload-plugins                                          # or start a new session — required after install
```

Then invoke by the **plugin-namespaced** command, e.g. `/handoff:codex-review src/auth`, or just ask
("have grok review the diff", "let kiro build the parser") — the `handoff-run` skill routes it. The bare
`/codex-build` does **not** exist; it is `/handoff:codex-build`.

### Codex

The same repo is also a self-contained Codex plugin marketplace:

```
codex plugin marketplace add ulpi-io/handoff   # or a local path to this repo
codex plugin add handoff@ulpi
```

The `handoff-run` skill and the `/…-build` / `/…-review` commands become available; or just ask
naturally and the skill routes it. Both hosts read the same `commands/` and `skills/` and run the same
`scripts/handoff.mjs` driver — the shims resolve it via `${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}`.

Requires the target CLI installed and authed (`codex`, `grok`, `kiro-cli`, `claude`, `opencode`,
`cursor-agent`). An unavailable one is an honest `gateNotRun`, not a failure of the others.

## Layout

```
.claude-plugin/plugin.json        name: handoff (Claude Code manifest)
.codex-plugin/plugin.json         name: handoff (Codex manifest + interface block)
.agents/plugins/marketplace.json  Codex marketplace listing handoff at path "." (self-contained)
commands/<provider>-<verb>.md     12 thin slash-command shims (host-agnostic plugin-root)
skills/handoff-run/SKILL.md       the ONE shared workflow (scope → brief → run → verify)
scripts/handoff.mjs               the ONE driver (dispatch on --provider/--verb)
scripts/lib/providers/*.mjs       the ONLY provider-specific code (codex, grok, kiro, claude, opencode, cursor)
scripts/lib/{git,prompt,which,render}.mjs   shared mechanics
scripts/test-handoff.mjs          contract tests (prompt-never-argv, verb-scoped trust, fail-closed)
references/providers.md           per-CLI flag cheat-sheet (pinned to real --help output)
```

Adding a provider = one adapter (`locate / authOk / invocation / capture`) + two command shims.

## Direct driver use

```bash
node scripts/handoff.mjs --provider codex    --verb review --prompt-file brief.md --cwd . --structured
node scripts/handoff.mjs --provider claude   --verb review --prompt-file brief.md --cwd . --structured
node scripts/handoff.mjs --provider grok     --verb build  --prompt-file brief.md --cwd .
node scripts/handoff.mjs --provider opencode --verb build  --prompt-file brief.md --cwd .
node scripts/handoff.mjs --provider cursor   --verb build  --prompt-file brief.md --cwd .
```

Test: `node --test scripts/test-handoff.mjs`.

MIT · ulpi.io
