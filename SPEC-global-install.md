# Spec: global install (v0.57 line)

## Objective

Operator decision, 2026-09-29: autoloop is a **global tool**.

- **Nothing of the tool is committed to a project.** Today LFE carries 46 files and 1.9 MB of
  vendored tools, briefs and hook wiring. Every release has needed a setup/reconcile PR (#549,
  #553, #556 in one week), and two releases locked setup out mid-reconcile.
- **A plugin update reaches every project** at the next session start, with no setup step.
- **A project commits only its own data and knowledge:**
  - `.autoloop/config.json` holds settings and overrides; plugin defaults apply to everything not
    set.
  - `.autoloop/STATE.md` holds loop policy prose: mission, invariants, protected ground.
  - `.autoloop/checklist.md` exists only when overriding the plugin's default review checklist.
  - `docs/agentic/ARCH.md` and `docs/agentic/LESSONS.md` are repo knowledge. They stay visible,
    because `rg` and `fd` skip hidden directories.

**Tradeoffs the operator accepted:**

- A plugin update changes enforcement in every project at once. Today a guard change reaches a repo
  only through a reviewed reconcile PR.
- A repo carries no guard for anyone who doesn't have the plugin installed.

## Claude Code facts this rests on (docs, verified 2026-09-29)

- **Plugin hooks** live in `hooks/hooks.json` at the plugin root, in the same shape as the
  `settings.json` hooks. They support PreToolUse and PostToolUse with matchers, SessionStart (with
  the `compact` source), Stop and SubagentStop.
- **Placeholders.** `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_PLUGIN_DATA}` are
  expanded in the command and exported to the hook process.
- **Scope and merging.** Plugin hooks run in every session where the plugin is enabled. When a
  plugin hook and a settings hook match the same event, both run, and the most restrictive
  PreToolUse decision wins, so an old vendored guard and the plugin guard can coexist during
  migration. Exit 2 blocks.
- **Loading.** Hooks load at session start (or `/reload-plugins`); SessionStart stdout is injected
  into context.
- **Undocumented, to verify with a throwaway plugin in `plugin-hooks`:**
  - whether plugin hooks fire in headless `claude -p --safe-mode` children;
  - whether a project can disable a user-scope plugin.

## Capability map

| Module id | Responsibility | Depends on |
|---|---|---|
| config-file | `.autoloop/config.json` read through one resolver: plugin defaults ← project overrides; legacy sources read in memory | — |
| policy-as-data | escalate paths and auto-merge settings become config keys; the executor runs from the plugin | config-file |
| plugin-tools | every tool, brief and template resolves inside the plugin; the vendored-layout machinery retires | config-file |
| plugin-hooks | the plugin ships its hooks; project `.claude/settings.json` carries no autoloop entries | plugin-tools |
| setup-v2 | `init` / `config` / `doctor`, plus a one-time `devendor` per existing repo | all of the above |

Build order: config-file → policy-as-data → plugin-tools → plugin-hooks → setup-v2. Each module
ships as its own release. LFE keeps working at every step: the legacy sources are read until
`devendor` runs.

## Module specs

### config-file

- **Resolver.** `config-contract.mjs` gains `resolveProjectConfig(root)`, the ONE reader every tool
  uses. It searches in this order:
  1. `.autoloop/config.json`;
  2. else the legacy `docs/agentic/STATE.md` JSON block, migrated in memory
     (`currentProjectConfig`);
  3. else "not an autoloop repo" (`null`).
- **Defaults.** Plugin defaults (`DEFAULT_CONFIG`) are deep-merged under the project file. The
  project states only what differs. Validation runs on the merged result, and unknown keys are
  refused.
- **Schema.** It stays 0.28.0. Everything except `version`, `baseBranch` and `gate.command` has a
  default.
- **STATE prose.** It moves to `.autoloop/STATE.md`, with the legacy path as fallback. SessionStart
  injects whichever exists.
- **Checklist.** `review.checklistPath` defaults to `.autoloop/checklist.md` if present, else the
  plugin's default checklist.
- **Protection.** `.autoloop/**` joins the human-authorization families, because `config.json`
  outranks STATE and a writer changing it would reconfigure the gate.
- **Success:** every tool that reads config today (15, per `rg`) goes through the resolver; a
  legacy STATE block and a `config.json` both resolve; a repo with neither reads `null`. A pending
  migration is reported (`migratedFrom`, a CLI `NOTE`) but never forced.

### policy-as-data

- **Schema.** The keys are additive and optional, so the schema stays 0.28.0. A key with no
  default is simply absent, so a repository that never sets one resolves exactly the config it
  resolved before, and a review chain's config fingerprint holds.
- **New config keys:**
  - `protectedPaths` (no default) replaces the repo entries of `escalate-paths.mjs`
    `ESCALATE_PATHS` and `auto-merge` `EXTRA_PROTECTED_PATHS`; the structural families stay in the
    plugin. A config that cannot be resolved leaves them unknown, so `escalate-paths` exits 2;
  - `merge.reversiblePaths` (default `["docs/**"]`) and `merge.loopLogin`, both valid only under a
    non-manual policy. There is no `merge.trustedHumans`: non-solo is retired, so the one trusted
    human is the loop login;
  - the executor refuses (exit 1, before any GitHub read) when `config.json` is present but its
    policy is manual, `loopLogin` is unset, or the repository can't be read; it never falls back to
    the filled block;
  - `AUTOMERGE_MODE` stays derived from `merge.policy` (`auto` → `all-green`, `ratified` →
    `classified`), never stored;
  - `REPOSITORY` comes from `git remote` / `gh repo view`, never stored.
- **Retirements.** `escalate-paths.mjs` becomes a plugin library reading config. The auto-merge
  executor runs from the plugin with its settings from config, and no filled copy exists.
- **LFE today maps to:**
  `protectedPaths: ["spec/**", "compose.y*ml", "**/compose.y*ml"]`,
  `merge.loopLogin: "fabioneves"`.
- **Success:** the auto-merge self-test derives its fixtures from config; lane and escalate
  matching read `protectedPaths`; a repo's old files are ignored once `config.json` exists.

### plugin-tools

- **Resolution.** Tools resolve siblings, `briefs/` and templates relative to their own plugin
  location. No code path assumes `<repo>/tools/agentic`.
- **Retirements:**
  - scaffold `--reconcile` of tools;
  - `verify.mjs --install-root` and the release-proven install manifest;
  - `hook-relay.mjs`;
  - `loop-smoke`'s installed-copy phase;
  - the "setup reconcile required" drift check in prime (`reconcileNeeded`).
- **Plugin-side checks stay:** self-tests, the manifest used for release verification, and the
  guard corpus.
- **Skills** name `<plugin-tools>` only. The "Tools a unit branch runs" and "Behind base" sections
  go.
- **Success:** a repo with no `tools/agentic/` runs a full unit with only `.autoloop/config.json`;
  `rg 'tools/agentic'` hits only migration and devendor code, the legacy fallback, and history.

### plugin-hooks

- **`hooks/hooks.json`** registers:
  - PreToolUse `Bash|AskUserQuestion` → command-guard;
  - PreToolUse `Edit|Write|MultiEdit|NotebookEdit` → edit-guard;
  - PostToolUse `Bash` → label-swap-reminder;
  - SessionStart → preflight, STATE injection and `--card-run`;
  - Stop → writeback-check;
  - SubagentStop → subagent-transcript.
- **Every hook is a no-op outside an autoloop repo:** it checks `resolveProjectConfig` (or just the
  existence of `.autoloop/config.json` or the legacy STATE) and exits 0 in under 50 ms. The guard
  still enforces only while this session's loop run is live.
- **Before building:** verify with a throwaway plugin whether plugin hooks fire in
  `claude -p --safe-mode`. The edit-guard's writer coverage stays in dispatch's deny rules either
  way.
- **Success:** a repo with no `.claude/settings.json` autoloop entries is fully guarded during a
  run; a non-autoloop project sees no output and a negligible cost per call.

### setup-v2

- **`init`** (first time): interview, write `.autoloop/config.json` with overrides only, write
  `.autoloop/STATE.md`, seed `docs/agentic/ARCH.md`/`LESSONS.md` if absent, create the labels. One
  PR.
- **`config`**: change a setting in `config.json`, with no other writes.
- **`doctor`**: read-only; config validity, gate resolution, labels, plugin version.
- **`devendor`** (one-time, per existing repo, one PR):
  - convert the STATE JSON block and the repo-specific parts of `escalate-paths.mjs` and
    `auto-merge.mjs` into `.autoloop/config.json`;
  - move STATE prose to `.autoloop/STATE.md`;
  - delete `tools/agentic/`, `docs/agentic/LOOP.md`, and the autoloop entries in
    `.claude/settings.json`.

  `devendor` never touches ARCH, LESSONS or a repo-authored checklist.
- `devendor` writes exactly the config the legacy block resolved to, so the config fingerprint of a
  review chain in flight is unchanged.
- **Success:** LFE devendors in one PR with `verify`, the guard and a full unit green afterwards; a
  plugin release after that needs no setup at all.

## Boundaries

- Always: legacy sources keep working until a repo devendors; one module per release; each release
  keeps LFE runnable.
- Ask first: removing the legacy fallback (not before every known repo has devendored).
- Never: write a project's config during a normal run; commit anything of the tool to a project.

## Open questions

- Whether the guard's corpus and regression incidents that anchor vendored-layout behaviour retire
  or re-anchor; decided per incident in plugin-tools.
