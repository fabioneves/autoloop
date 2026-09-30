---
name: setup
description: Initialize, configure, devendor, or diagnose Autoloop in a repository. Autoloop is a global plugin; a repository carries only .autoloop/config.json and its own docs. Doctor is read-only.
---

# autoloop:setup — init / devendor / config / doctor

Your first output, before a tool call or question, is exactly:

```text
┌─┐ ┬ ┬ ┌┬┐ ┌─┐ ┬   ┌─┐ ┌─┐ ┌─┐
├─┤ │ │  │  │ │ │   │ │ │ │ ├─┘
┴ ┴ └─┘  ┴  └─┘ ┴─┘ └─┘ └─┘ ┴
∞ setup · v0.64.0 · starting
```

If a tool call already happened, print the banner with the next output. Print it once.

**Every phase begins with one call, which prints its ribbon; repeat that line verbatim.** All five
phases, every run:

```bash
node <plugin-tools>/step.mjs --setup <resolve|audit|interview|write|verify> [--badge ❌|⚠️]
```

The badge is ⏳ unless the phase begins blocked (❌) or needing a human (⚠️). Do not re-print a
phase's ribbon when it completes — ✅ belongs only on the closing rail. Doctor replaces the ribbon
with its own single line: `∞ doctor ─ <audited ref>`.

## What a repository carries

Autoloop is a global plugin: every tool, brief and hook runs from the plugin, and a plugin update
reaches every repository at its next session start with no setup step. A repository commits only its
own data:

| Path | What |
|---|---|
| `.autoloop/config.json` | ProjectConfig, overrides only; plugin defaults fill the rest |
| `.autoloop/STATE.md` | Loop policy prose: mission, invariants, protected ground. Injected every session |
| `.autoloop/checklist.md` | Optional review checklist; the plugin's own is used when absent |
| `docs/agentic/ARCH.md`, `docs/agentic/LESSONS.md` | Repository knowledge, visible to `rg`/`fd` |

Nothing else: no `tools/agentic/`, no autoloop entries in `.claude/settings.json`, no `LOOP.md`.

## Modes

- **Init** — no `.autoloop/config.json` and no `docs/agentic/STATE.md`: a fresh repository.
- **Devendor** — `docs/agentic/STATE.md` carries a config block and there is no
  `.autoloop/config.json`: a vendored install from before the global plugin. Converted once, in its
  own PR. (A repository's own files may stay in `tools/agentic/` afterwards.)
- **Config** — `.autoloop/config.json` exists: change a setting.
- **Doctor** — the invocation contains `doctor`: read-only, writes and asks nothing.

```text
/autoloop:setup
/autoloop:setup doctor
```

## Prime

1. `<plugin-tools>` is `<this skill's real dir>/../../tools` — the plugin root's
   `tools/`, a sibling of `skills/`. In a devendored repository the SessionStart preflight
   prints it (`INFO  plugin tools: …`). Write it as a literal absolute path, never a shell variable:
   the guard refuses a command it cannot resolve statically, `$CLAUDE_PLUGIN_ROOT` included.
2. Print the banner.
3. Version currency, one pipeline — `<cache>` is the versions directory two levels above the plugin
   root; compose nothing:

   ```bash
   ls <cache> | node <plugin-tools>/release-verify.mjs --sort-versions | tail -3
   ```

   Never add `xargs -n1 basename`: the guard refuses `xargs`, and `--sort-versions` takes basenames
   itself. A newer installed version than the loaded banner means this session is stale: stop and
   ask for a fresh session (doctor reports it as FAIL).
4. On a clean tree, fetch, switch to the configured base (`baseBranch`; the remote default until a
   config is readable) and pull fast-forward. A dirty tree or an in-flight loop unit is human work:
   stop with the remedy, never stash, discard or relocate it.
5. **A parked run in this session is closed, not worked around.** The guard refuses every interview
   question while this session's run marker is live. Invoking Setup is the operator taking the
   session back: before the interview (never in doctor), run
   `node <plugin-tools>/prime.mjs --close-run`. It closes only this session's own markers and
   changes no unit. Never close a run to get past a dirty tree or a running dispatch.

## Project configuration

`.autoloop/config.json` states only what differs from the plugin defaults. The minimum:

```json
{ "version": "0.28.0", "baseBranch": "main", "gate": { "command": "npm test" } }
```

Defaults: `gate.quickCommand`/`setupCommand` null, `merge.policy` `manual`, `tracker.provider`
`none`, `review.checklistPath` `.autoloop/checklist.md` (the plugin's checklist when that file is
absent). Optional keys:

- `protectedPaths` — the repository's own human-authorization globs, added to the built-in families
  (`*` and `**` only; `spec` names a file, `spec/**` the directory);
- `merge.loopLogin` — the loop's GitHub login; required by a non-manual policy;
- `merge.reversiblePaths` — the Path B class under `ratified` (default `["docs/**"]`).

Unknown keys are refused. Validate only through the contract, which names every error:

```bash
node <plugin-tools>/config-contract.mjs --root <repo> --resolve
```

`--resolve` also reports whether each configured gate executable is on PATH (it executes nothing).
An older schema is migrated in memory by every reader, so a release never forces a write; setup
writes the current schema whenever it writes the file.

## Interview (init and config)

Use structured questions when the host provides them. Init walks every item; config collapses to
one summary table — every current value beside its default — and one accept-all confirmation,
expanding only real decisions: **the gate** and **the merge policy**, which are asked in every mode.

1. Mission and non-negotiable invariants (into `.autoloop/STATE.md`).
2. Configured base branch.
3. Gate, optional quick gate, optional setup command. Show the configured commands verbatim beside
   what `--resolve` reports: a gate that cannot resolve is a finding for the human, never a gap
   for Setup to fill. There is no required-CheckRun list to ask for: delivery reads the live
   triggered-checks floor (every check run and status on the exact head green).
4. Tracker: none or Jira (epic key and cloud ID).
5. Review checklist: the plugin's default, or the repository's own at `.autoloop/checklist.md`.
6. `protectedPaths`.
7. Merge policy. Default `manual`; show the current value every time and offer to change it.
   `ratified` or `auto` accepts in one sentence that no invocation transport can prove a human
   requested a run, and writes `merge.unverifiedInvocationAcknowledged: true` beside it. Non-manual
   is solo-only: offer solo-operator mode only after that acknowledgement, and only where the loop
   runs under the one maintainer's own login — it waives identity separation, App attestation and
   the approving review (GitHub forbids self-approval) while exact-head CAS merge, CI on the exact
   head, ownership binding, protected paths and the kill switch keep full strength. Accepting
   writes `merge.soloOperatorAcknowledged: true` and `merge.loopLogin` (from `gh api user`).
   Under `ratified` only: **ask for `merge.reversiblePaths`** (offer `["docs/**"]`; `**` crosses
   segments, `*` does not, case-insensitive, every current and previous path must match), and
   **disclose, never ask**, the fixed Path A labels `risk:pure-deletion` and
   `risk:mechanical-refactor` — both must exist as labels. Neither is a control under `auto`; never
   present it as one.

Never infer that green CI means the run may finish itself: merge, tag and release publication stay
independent maintainer actions outside the run.

## Init

On a branch from the base:

```bash
node <plugin-tools>/setup.mjs --init --root <repo> --base <branch> --gate '<command>'
```

It writes the overrides-only `config.json`, `.autoloop/STATE.md` from the template, and seeds
`ARCH.md`/`LESSONS.md` only where absent. Then fill `.autoloop/STATE.md`'s placeholders from the
interview, add any other answers to `config.json` by a direct edit, validate with
`config-contract.mjs --root`, create the labels, run the doctor, and deliver one PR.

## Devendor

A vendored install carries a copy of the tool (`tools/agentic/`, hook entries in
`.claude/settings.json`, `docs/agentic/STATE.md` with a config block, `LOOP.md`). It is converted
once, in one PR, **from a fresh session that has not run a loop**: the vendored guard still runs
this session's hooks and refuses the devendor commit while a run marker exists.

1. **Confirm with the human first**, naming what the PR deletes: the plugin's files under
   `tools/agentic/` (the repository's own files there stay), `docs/agentic/LOOP.md`,
   `docs/agentic/STATE.md` (its prose moves), and the autoloop hook entries — and that devendor
   runs the base's vendored escalate/merge modules to read their policy. Also offer to move
   `docs/agentic/checklist.md` to `.autoloop/checklist.md` (`--move-checklist`).
2. **Work in a linked worktree, never this checkout** — deleting the vendored guard here makes it
   refuse every command. `setup.mjs` refuses anything but a linked worktree it is not running in.

   ```bash
   git worktree add -b autoloop/devendor <scratch>/devendor origin/<base>
   node <plugin-tools>/setup.mjs --devendor --root <scratch>/devendor [--move-checklist]
   ```

   Refusals, each with its remedy: `NOT_A_WORKTREE`/`LIVE_CHECKOUT` — use the worktree above;
   `VENDORED_POLICY_NOT_BASE` — recreate it from `origin/<base>`; `GATE_USES_VENDORED_TOOL` —
   point the gate at a repository script first; `SYMLINKED_PATH`, `SETTINGS_UNREADABLE`,
   `CHECKLIST_NOT_MOVABLE` — the human fixes the named path; `ALREADY_DEVENDORED` — run the
   doctor; `VENDORED_POLICY_UNREADABLE`, `DEVENDOR_ROUNDTRIP` — stop and report verbatim.

   It writes `.autoloop/config.json` (overrides only) from the legacy config, the vendored
   escalate paths and the filled merge executor, read as JavaScript; moves the STATE prose to
   `.autoloop/STATE.md` with the current template's preamble and Config section; removes the
   plugin's files and strips only autoloop's hook handlers. ARCH and LESSONS stay.
3. Show the typed report and `git -C <scratch>/devendor diff --stat`, then run the doctor against
   the worktree (`verify.mjs --project-root <scratch>/devendor`). In the report: `kept` names
   the repository's own files left in `tools/agentic/`; `staleProse` and `staleReferences` name
   lines in STATE, CLAUDE.md, AGENTS.md, ARCH, LESSONS and the checklist that still name the
   vendored layout (or a moved checklist's path) — ask whether to edit each in this PR.
4. Open loop branches predate the config: after the merge each needs the base merged in (their
   tools refuse till then), and with `fingerprintChanged: true` a review re-run. List them.
5. Commit in the worktree (`git -C … commit -F <file>`), push, open the PR with `--body-file`.
   Never merge it yourself.
6. After the human merges, in this order: `git worktree remove <scratch>/devendor`; have every other
   session on this checkout exit; pull the base **as the last command** (it deletes the vendored
   guard this session still runs, which then refuses everything); restart the session. Then the
   human removes any autoloop entries from their untracked `.claude/settings.local.json` (the doctor
   names them).

## Config

Edit `.autoloop/config.json` directly (overrides only), validate with
`config-contract.mjs --root <repo> --resolve`, show the diff, and deliver it as a PR. `.autoloop/**`
is a human-authorization path, so a loop run never changes it.

## Doctor

Read-only. Report `PASS`, `FAIL` or `NOTE`, naming the audited ref:

```bash
node <plugin-tools>/verify.mjs --project-root <repo>
node <plugin-tools>/config-contract.mjs --root <repo> --resolve
```

The first checks ProjectConfig, the effective review checklist, that every repository script a gate
command names exists, no retired CI policy, and **no vendored layout left** — a plugin file under
`tools/agentic/` or a hook running one (a repository's own files there are fine); it names each
leftover and how to remove it. Also report the session's plugin version against
the newest installed (Prime step 3), the lifecycle labels, and open duplicate setup PRs. Doctor
never dispatches an engine, merges, or reads server-side protection.

## Labels

Create the lifecycle and step labels idempotently, including `loop-waiting`, `loop-obsolete`,
`loop-decided`, `loop-repair` and `loop-halt` (the whole-run kill switch a human puts on any open
issue). `unit.mjs` also creates each one on first use. Do not create non-manual policy labels.

## Commands the guard accepts

- Write `<plugin-tools>` as the literal path; never a shell variable.
- Call a contract through its CLI or a scratchpad script file — never `node -e`, never an awk
  program (`wc -c`, `grep -c`, `sed -n` measure and read).
- Compose PR, issue and comment bodies in a file (`--body-file`); commit with `-F <path>` or
  `git commit -F -` from a quoted heredoc. `$(…)` substitution is refused whole.
- Never write `$?` in any form: the tool result already carries the exit status.
- Read a battery by its sections, not its exit status.

End with:

```text
✅ ∞ ══ setup complete ─ <mode> · <changed>/<total> artifacts · verify <state> ══
```

Doctor ends with:

```text
∞ ══ setup doctor complete ─ <findings> finding(s) ══
```

## Hard rules

- Never commit anything of the tool to a repository.
- Never persist host, engine or session state in ProjectConfig.
- Never run the repository gate, test suite or CI to prove a setup change; config validation and
  `verify.mjs --project-root` are the evidence. Setup never modifies repository source.
- Never end a session with setup work uncommitted: deliver the branch and PR, or revert.
- Enable a non-manual policy only through the explicit interview answer that writes
  `merge.unverifiedInvocationAcknowledged: true` beside it. Setup never merges.
- Never mutate branch or release protection, GitHub Apps or credentials without explicit
  authorization.
