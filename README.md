# handoff — Claude Code plugin to delegate build & review tasks to Codex, Grok, or Kiro

Hand off a **build** or **review** from Claude Code to another one-shot headless coding agent —
**Codex**, **Grok**, or **Kiro** — over a single uniform, fail-closed contract. One driver, three
~50-line adapters, six slash commands.

```
/handoff:codex-build   <what to build>      /handoff:codex-review   <what to review>
/handoff:grok-build    <what to build>      /handoff:grok-review    <what to review>
/handoff:kiro-build    <what to build>      /handoff:kiro-review    <what to review>
```

Why it unifies: all three CLIs are one-shot headless agents with a sandbox/trust flag —
`codex exec … -`, `grok --prompt-file`, `kiro-cli chat --no-interactive`. A provider is just an adapter
that fills the CLI-specific middle; the driver owns everything reusable.

## Guarantees (identical for every provider/verb)

- **Fail closed.** A CLI that is missing, not authed, or can't run is reported `gateNotRun` — never a
  fabricated clean or block. handoff never auto-installs anything.
- **Verify ground truth.** A `build` is judged by the real `git diff --stat <baseline>` (no diff = not
  done); a `review` by its findings. The delegated agent's self-report is never taken as proof.
- **Trust scoped to the verb.** `review` runs read-only; `build` runs least-write. The dangerous
  bypass lever (`danger-full-access` / `bypassPermissions` / `--trust-all-tools`) is unlocked **only**
  with an explicit `--mode autonomous`.
- **Injection-safe.** The brief is written to a file and delivered on stdin or `--prompt-file` — never
  interpolated into a shell string or an argv element.

## Install

This plugin ships in the `ulpi-autonomous-engineering` marketplace:

```
/plugin marketplace update ulpi-autonomous-engineering   # or: /plugin marketplace add <this repo>
/plugin install handoff@ulpi-autonomous-engineering
/reload-plugins                                          # or start a new session — required after install
```

Then invoke by the **plugin-namespaced** command, e.g. `/handoff:codex-review src/auth`, or just ask
("have grok review the diff", "let kiro build the parser") — the `handoff-run` skill routes it. The bare
`/codex-build` does **not** exist; it is `/handoff:codex-build`.

Requires the target CLI installed and authed (`codex`, `grok`, `kiro-cli`). An unavailable one is an
honest `gateNotRun`, not a failure of the others.

## Layout

```
.claude-plugin/plugin.json        name: handoff
commands/<provider>-<verb>.md     6 thin slash-command shims
skills/handoff-run/SKILL.md       the ONE shared workflow (scope → brief → run → verify)
scripts/handoff.mjs               the ONE driver (dispatch on --provider/--verb)
scripts/lib/providers/*.mjs       the ONLY provider-specific code (codex, grok, kiro)
scripts/lib/{git,prompt,which,render}.mjs   shared mechanics
scripts/test-handoff.mjs          contract tests (prompt-never-argv, verb-scoped trust, fail-closed)
references/providers.md           per-CLI flag cheat-sheet (pinned to real --help output)
```

Adding a provider = one adapter (`locate / authOk / invocation / capture`) + two command shims.

## Direct driver use

```bash
node scripts/handoff.mjs --provider codex --verb review --prompt-file brief.md --cwd . --structured
node scripts/handoff.mjs --provider grok  --verb build  --prompt-file brief.md --cwd .
```

Test: `node --test scripts/test-handoff.mjs`.

MIT · ulpi.io
