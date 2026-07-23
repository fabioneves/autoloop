---
name: setup
description: Scaffold or reconfigure autoloop in the current repo from Claude Code, Codex CLI, or opencode. Use for a fresh install, changing supported hosts/engine/model/gate/merge/tracker settings, wiring host-native hooks and the native read-only reviewer, installing the optional agent-skills dependency, or running the read-only "doctor" health check.
---

# autoloop:setup — scaffold / reconfigure / doctor

**Your FIRST output — before any tool call and before the first interactive question — is the run
banner**, exactly this static fenced mark (once; never repeat it later):

```
┌─┐ ┬ ┬ ┌┬┐ ┌─┐ ┬   ┌─┐ ┌─┐ ┌─┐
├─┤ │ │  │  │ │ │   │ │ │ │ ├─┘
┴ ┴ └─┘  ┴  └─┘ ┴─┘ └─┘ └─┘ ┴
∞ setup · v0.39.4 · starting
```

Missed it? If any tool call already happened this run without the banner, print it with your very
next text output — late beats never.

Idempotent configurator for the autoloop in the **current repo**. Three modes:

- **Fresh install** — `docs/agentic/STATE.md` absent: full wizard, scaffold everything.
- **Reconfigure** — STATE exists: show the current config block, ask what to change, rewrite only
  the config block (and vendor/remove optional pieces accordingly). Never overwrite a
  maintainer-edited STATE body, checklist, or vendored tool without showing a diff and asking.
  Security/schema migrations are the exception to "ask only what changed": when
  `runtime.supportedHosts` is missing, when Codex is declared and
  `.codex/agents/autoloop-reviewer.toml` is missing, or when opencode is declared and
  `.opencode/agent/autoloop-reviewer.md` or `.opencode/plugins/autoloop.js` is missing, explain
  the migration and offer it before normal changes. A pre-0.24 config block (schema `0.23.0`,
  no `engine.opencode`) migrates by adding `engine.opencode` with null pins and bumping
  `version` — plus the full prose reconciliation below, never version-only. **A migration is NEVER version-only.** Diff every template-derived section of
  the repo's STATE against the current `STATE.template.md` (repo fills — mission, invariants,
  config values, escalate additions, tracker ids, lessons — preserved verbatim) and include the
  full prose reconciliation in the migration PR. A version bump whose prose still contradicts
  the skills leaves the standing authority enforcing retired rules — four consecutive
  migrations did exactly this (pre-0.16 label prose survived to 0.21.1) before the drift check
  below existed. A legacy `engine.profile: "codex"` does not reveal whether the repo was Claude
  bridge-only, Codex-only, or dual-host, so ask; never infer intent from the active host or optional
  hook files. Also detect the deprecated generated LOOP sequence that starts the supervised run
  with a queue-wide `/goal`; show the exact template diff and offer the safe replacement, without
  overwriting locally edited prose.
  **`auto-merge.mjs` is TWO zones and must be diffed as two zones** — the `── end repo config`
  delimiter splits them. The REPO CONFIG zone is repo-owned: never overwritten by
  reconciliation. The engine zone (header + everything below the delimiter) is template-owned:
  diff it against the template's engine zone SEPARATELY — engine drift is REAL drift, and it
  hides if the file is diffed whole, because the config zone always differs legitimately (a
  reconciliation missed the 0.22.0 security floor exactly this way). Adopting a new engine =
  rebuild the file as template header+engine around the repo's config zone, run `--self-test`
  (fixtures derive from the config), and deliver **via a PR — the human's merge re-ratifies the
  engine**.
  **Adjusting the merge policy content** is a reconfigure case: on request (e.g. "widen the
  auto-merge allowlist", "add a protected path", "update the CI check names"), edit the REPO
  CONFIG block of the vendored `tools/agentic/auto-merge.mjs`, run `--self-test` (fixtures derive
  from the config), and deliver the change **via a PR — always**: every policy-content change is a
  re-ratification, enacted only by the human's merge. Only the config block is adjustable; the
  engine and the generic structural protected families (tools/**, .claude/**, .codex/**,
  .agents/**, .github/**, docs/agentic/**, manifests, secret paths) are not offered as knobs —
  they keep the loop from
  auto-merging changes to its own guardrails.
- **Doctor** — argument `doctor`: read-only checks, report PASS/FAIL/NOTE, write nothing.
  **Audit the base ref, not the checkout.** All scaffold checks (drift, template diffs, tool
  presence, STATE/checklist/LOOP content) read `origin/<cfg.baseBranch>` after a fetch
  (`git show origin/<base>:<path>`), and the report header names the audited ref. A checkout
  sitting on a unit branch behind base is a NOTE ("checkout on <branch>; disk files are that
  branch's historical snapshot — pitcrew rebases it"), NEVER drift evidence: a unit branch
  legitimately carries the scaffold as of its fork point. **Never allege tampering or masking
  from file content alone** — a "hand-edited" claim requires `git log -- <file>` showing a
  non-migration commit; a version mismatch explained by branch history is history, and a false
  sabotage narrative in a doctor report is worse than a missed finding.
- **Defaults** — argument `defaults`: view or edit the user's global wizard defaults (below)
  without touching any repo.

## Global wizard defaults (user-level, cross-project)

`${XDG_CONFIG_HOME:-~/.config}/autoloop/defaults.json` holds the user's cross-project answers so
the wizard stops re-asking preferences that rarely change per repo:

```json
{
  "runtime": { "supportedHosts": ["claude", "codex"] },
  "engine": { "profile": "codex", "claude": { "implementerModel": null, "reviewerModel": null } },
  "merge": { "policy": "ratified" },
  "tracker": "none",
  "caps": { "runWallClockHours": 4, "gateRetriesPerUnit": 2, "reviseRoundsPerPr": 3 },
  "hooks": true
}
```

Rules — this file is **wizard input, never runtime authority**:

- The loop NEVER reads it. Setup resolves defaults + answers into the repo's STATE config block,
  and the repo STATE remains the sole runtime source of truth — two machines with different
  defaults must run an already-scaffolded repo identically.
- Every key is optional; a missing file means no defaults. Unknown keys are ignored with a NOTE.
- **Pre-fill, don't skip:** a global default pre-selects the wizard answer, labelled
  "(your default)" — the user still sees and confirms each question in fresh installs. Purely
  project-bound facts (gate command, base branch, escalate paths, invariants, Jira epic/cloudId,
  checklist content) are never stored globally; never store secrets in it.
- After a completed fresh install, offer ONCE to save the non-project answers back as defaults
  (create/update the file; show the diff). Never write it silently.
- Doctor reports the file's presence + parse state as a NOTE (`defaults: none` is healthy).

Templates live at `../../templates/` relative to this `SKILL.md`. Resolve the installed skill's
real path first; Claude Code may expose `${CLAUDE_PLUGIN_ROOT}` and Codex plugin hooks expose
`${PLUGIN_ROOT}`, but ordinary setup shell calls must not depend on either variable. Vendored
files belong to the host repo after setup — plugin updates never silently change them; re-run
setup to see and apply template diffs.

## Runtime host adapter

Determine the active host from the session and available agent tools, never from repo files or
compatibility environment variables.

- **Claude Code:** invoke skills as `/autoloop:<name>` and ask wizard questions with
  `AskUserQuestion`. `engine.profile: "claude"` uses fresh Claude Agent-tool subagents;
  `engine.profile: "codex"` dispatches via direct `codex exec` (explicit `--sandbox` per
  dispatch; no plugin dependency).
- **Codex CLI:** invoke skills as `$autoloop:<name>` and use the surfaced structured-input tool,
  or ask one concise plain-text question when it is unavailable. Only `engine.profile: "codex"`
  is satisfiable; it uses fresh native Codex subagents and explicitly named
  `autoloop_reviewer` reviewer agents. A configured `claude` profile is a doctor failure, not
  permission to substitute Codex workers silently. Require Codex CLI `0.144.5+` as this repo's
  conservative tested floor; version alone is insufficient when the active spawn schema does not
  expose explicit `agent_type` selection.
  The native parent must take its permission defaults from config rather than a live
  `--sandbox`/`--ask-for-approval`/`--yolo`/`/permissions` override, because Codex reapplies live
  parent overrides after the reviewer's read-only custom-agent defaults.
- **opencode:** skills surface through the native `skill` tool under their frontmatter names
  (`setup`, `shape`, `dev`, `pitcrew`, …) once installed machine-level under
  `~/.config/opencode/skills/` — normally via the open agent-skills CLI
  (`npx skills add fabioneves/autoloop -g`; updates via `npx skills update -g`), or as
  maintainer symlinks to a working clone (verified on 1.18.3: the frontmatter `name`, not the
  folder name, is the identifier — there is no `autoloop:` namespace on this host). If the
  install is missing, offer the `npx skills` command (symlinks only for maintainers); doctor
  reports its absence as a NOTE. Ask wizard questions with the structured
  question tool when the runtime surfaces one, else one concise plain-text question at a time.
  Only `engine.profile: "opencode"` is satisfiable natively — fresh task-tool subagents for
  implementation and the typed `autoloop-reviewer` agent (host-enforced `permission: deny`
  strips its write/bash/task/network tools) for reviews; a configured `claude` or `codex`
  profile is a doctor failure on this host. Require opencode `1.18.3+` as the conservative
  tested floor. On Claude with `engine.profile: "opencode"`, confirm the `opencode` CLI is on
  PATH and authenticated; the exec contract governs: fresh non-interactive
  `opencode run --auto --format json` per dispatch with `AUTOLOOP_ENGINE_CHILD=1` in the child
  environment, reviewer dispatches add `--agent autoloop-reviewer`, and `--continue`,
  `--session`, `--fork`, and `--share` are forbidden.

## 1. Gather facts (all modes)

- **Version currency FIRST** — the banner's version is only what this session *loaded*; prove it
  is what's *installed*. Resolve this `SKILL.md`'s real path, then branch on the install shape:
  - **Versioned plugin cache** (the path contains a `<semver>/skills/` ancestor — Claude Code /
    Codex plugin installs): list the sibling version directories two levels up and compare the
    highest semver against the banner version:
    ```bash
    ls "$(dirname <resolved SKILL.md path>)/../../.." | sort -V | tail -3
    ```
  - **Live tree** (no semver ancestor — opencode installs: `npx skills` copies under
    `~/.config/opencode/skills/`, or maintainer symlinks into a working clone): there ARE no
    sibling version directories, and listing parent directories yields unrelated files — never
    read such a listing as version evidence. The staleness check is disk-vs-loaded instead:
    re-read the banner version line from the resolved `SKILL.md` on disk and compare it to the
    banner this session printed. When the resolved path sits in a git clone,
    `git -C <clone root> log -1 --format=%h` and a dirty-tree note add context to the report
    but never gate.
  A higher cache version — or a disk banner differing from the loaded one — means **this
  session is stale**: its skill text AND its `templates/` are outdated. Fresh install /
  reconfigure: **stop here**; never scaffold or migrate
  from stale templates — tell the user the installed version and to restart the session. Doctor:
  report `FAIL  session loaded v<banner> but v<installed> is on disk — restart the session`.
  Match: report `PASS  autoloop v<banner> (session = installed)`.
- **Audit the base ref — ALL modes, not just doctor.** The checkout may be parked on a unit
  branch whose scaffold is a historical snapshot (this produced a near-duplicate migration PR
  against an already-merged migration). Before sizing ANY drift: `git fetch origin`, then read
  every audited file from `origin/<cfg.baseBranch>` (`git show origin/<base>:<path>`, or
  materialize them to a scratch dir for the audit block). The parked checkout's files are a
  NOTE, never drift evidence. A migration branch is created FROM `origin/<base>`
  (`git switch -c chore/autoloop-<ver>-migration origin/<base>`) — with a clean tree only, and
  if the checkout sits on an open unit PR's branch, warn that a unit session may own it before
  switching. **Duplicate-migration check:** if an open PR with head `chore/autoloop-*` already
  exists, present THAT PR (merge or close it) instead of deriving a new one — never open a
  second migration PR for the same reconciliation.
- **One-call audit (run this SECOND, right after version currency).** Every deterministic fact
  below comes from ONE Bash invocation — never re-derive them through serial calls; follow up
  individually only on sections that report a problem. `T` is the resolved templates dir:
  ```bash
  T=<resolved templates dir>
  echo "=== toolchain ==="; gh auth status 2>&1 | head -3; node --version; codex --version 2>/dev/null || echo codex:absent; opencode --version 2>/dev/null || echo opencode:absent; ddev --version 2>/dev/null || echo ddev:absent
  echo "=== config ==="; [ -f tools/agentic/config-contract.mjs ] && node tools/agentic/config-contract.mjs docs/agentic/STATE.md 2>&1 || echo "config-contract: MISSING"
  echo "=== tool diffs ==="; for f in session-preflight.sh command-guard.mjs config-contract.mjs writeback-check.mjs label-swap-reminder.mjs loop-scope.mjs run-scope.mjs escalate-paths.mjs scan.mjs stats.mjs publish-verdict.mjs; do
    [ -f "tools/agentic/$f" ] || { echo "MISSING   $f"; continue; }
    diff -q "$T/tools/$f" "tools/agentic/$f" >/dev/null 2>&1 && echo "SAME      $f" || echo "DIFFERS   $f"; done
  d=$(rg -n "end repo config" tools/agentic/auto-merge.mjs | cut -d: -f1); dt=$(rg -n "end repo config" "$T/tools/auto-merge.reference.mjs" | cut -d: -f1)
  diff <(tail -n +$((d+1)) tools/agentic/auto-merge.mjs) <(tail -n +$((dt+1)) "$T/tools/auto-merge.reference.mjs") >/dev/null && echo "SAME      auto-merge ENGINE zone" || echo "DIFFERS   auto-merge ENGINE zone"
  echo "=== drift markers ==="; for m in "loop-in-progress" "codex:codex-rescue"; do rg -q "$m" docs/agentic/STATE.md && echo "RETIRED-PRESENT $m"; done
  for m in "loop-started" "fix delta" "dispatched ONCE" "CI green on the head" "awaiting-merge age" "codex exec" "opencode run" "run scope"; do rg -q "$m" docs/agentic/STATE.md || echo "MISSING-MARKER $m"; done
  rg -q "self-explanatory" docs/agentic/checklist.md || echo "MISSING-MARKER checklist self-explanatory"
  rg -q "one-call run scan" docs/agentic/LOOP.md || echo "MISSING-MARKER LOOP scan row"
  echo "=== self-tests ==="; for f in config-contract command-guard writeback-check label-swap-reminder loop-scope run-scope subagent-transcript escalate-paths scan stats publish-verdict; do printf "%s: " "$f"; node "tools/agentic/$f.mjs" --self-test 2>&1 | tail -1; done
  printf "auto-merge: "; node tools/agentic/auto-merge.mjs --self-test 2>&1 | tail -1
  echo "=== hooks ==="; rg -c "command-guard|writeback-check|label-swap-reminder" .claude/settings.json 2>/dev/null || echo "claude hooks: absent"; [ -f .codex/hooks.json ] && node -e "JSON.parse(require('fs').readFileSync('.codex/hooks.json','utf8'));console.log('codex hooks: valid')" || echo "codex hooks: absent"
  [ -f .opencode/plugins/autoloop.js ] && { diff -q "$T/opencode-plugin.template.js" .opencode/plugins/autoloop.js >/dev/null 2>&1 && echo "opencode plugin: SAME" || echo "opencode plugin: DIFFERS"; } || echo "opencode plugin: absent"
  [ -f .opencode/agent/autoloop-reviewer.md ] && { diff -q "$T/opencode-reviewer-agent.template.md" .opencode/agent/autoloop-reviewer.md >/dev/null 2>&1 && echo "opencode reviewer: SAME" || echo "opencode reviewer: DIFFERS"; } || echo "opencode reviewer: absent"
  node -e "const c=JSON.parse(require('fs').readFileSync('opencode.json','utf8'));console.log('opencode instructions: '+((c.instructions||[]).includes('docs/agentic/STATE.md')?'wired':'missing'))" 2>/dev/null || echo "opencode.json: absent"
  echo "=== sizes ==="; for f in docs/agentic/STATE.md docs/agentic/ARCH.md; do [ -f "$f" ] && wc -c "$f" || echo "absent    $f"; done; [ -f docs/agentic/STATE.md ] && printf "%-9s STATE Lessons section\n" "$(awk '/^## Lessons/,0' docs/agentic/STATE.md | wc -c)"
  ```
  (Doctor mode runs this same block against `origin/<base>` content per the audit-the-base-ref
  rule — `git show` the files to a temp dir first.)
- **Toolchain interpretation**: a missing `gh`/`node` stops setup with the concrete fix (gh:
  https://cli.github.com then `gh auth login`; node: the platform's package manager) — never
  proceed and let a later `gh` call fail cryptically.
- **Size interpretation**: measure the Lessons section, not the whole file — the STATE
  template's standing prose is ~24 KB by design, so a total-file threshold trips on every repo
  forever and invites no-op "compactions" (observed: a 400-byte saving sold as one).
  `awk '/^## Lessons/,0' docs/agentic/STATE.md | wc -c` over **3000 bytes** → NOTE "compaction
  recommended — STATE is hook-injected into every session; bloat is a per-session context tax"
  (the reconfigure compaction offer above). ARCH.md over **8000 bytes** → NOTE "re-curate the map".
  ARCH.md absent → NOTE "arch map: not scaffolded (optional, recommended)". All NOTEs, never
  FAILs — size is discipline, not correctness. Size NOTEs are also self-healing: when a
  threshold trips, `autoloop:dev` files a `loop-maintenance` issue itself (see its Maintenance
  units section), so a declined or dropped compaction offer here is never load-bearing.
- Repo + default branch: `gh repo view --json nameWithOwner,defaultBranchRef` (this doubles as
  the repo-ACCESS check — auth alone doesn't prove access on private/SSO repos).
- Existing install: does `docs/agentic/STATE.md` exist? Parse its ```json autoloop-config``` block.
  Validate it with the vendored `tools/agentic/config-contract.mjs` when present, otherwise the
  plugin template. Missing `runtime.supportedHosts` is a legacy migration failure, not a value to
  infer; fresh/reconfigure asks, while doctor reports FAIL with "re-run setup".
- Runtime host + dispatch capability: on native Codex, run `codex --version` and require
  `0.144.5+`, confirm subagents are available, and confirm the runtime can explicitly select the
  project-scoped `autoloop_reviewer` custom-agent type with
  `agent_type = "autoloop_reviewer"` and zero inherited parent turns. A task name is not type
  selection; a spawn schema without `fork_turns` fails, while one exposing `fork_turns` but not
  `agent_type` (the known 0.144.5–0.144.6 upstream gap) records the prompt-level isolation
  posture instead of failing (see `autoloop:dev` Prime). Confirm that no live parent
  sandbox/approval override is active; if one is present, a fresh session without it is required.
  On Claude with
  `engine.profile: "codex"`, confirm the `codex` CLI is on PATH (`codex --version` ≥ 0.144.5)
  and authenticated. The exec contract governs: non-interactive `codex exec` only, explicit
  `--sandbox` per dispatch, never interactive `codex`, never `~/.codex/*` file edits, never
  `--dangerously-*` flags. On native opencode, run `opencode --version` and require `1.18.3+`,
  confirm the task tool can spawn subagents, and confirm `.opencode/agent/autoloop-reviewer.md`
  parses with its permission denies intact — effective isolation is still verified from the
  spawned child (its toolset must lack edit/bash/task/webfetch/websearch). On Claude with
  `engine.profile: "opencode"`, confirm the `opencode` CLI is on PATH (≥ 1.18.3) and
  authenticated; the opencode exec contract from the host adapter governs.
- Optional `agent-skills`: on Claude it is a manifest dependency. On Codex, inspect
  `codex plugin marketplace list` and, once registered,
  `codex plugin list --marketplace agent-skills --available --json`. **Doctor mode stops after
  this inspection:** report the state and exact suggested commands, but never request approval or
  install anything. In fresh/reconfigure mode, obtain the normal external-install approval, then
  run only the missing operations:
  `codex plugin marketplace add addyosmani/agent-skills` to register the marketplace, followed by
  `codex plugin add agent-skills@agent-skills` to install the plugin. Re-runs skip both when the
  plugin is already installed. Tell the user a fresh Codex session is required before newly
  installed skills appear; use inline fallbacks for the current setup run. If installation is
  declined or fails, continue with inline fallbacks and report a NOTE in doctor. Never overwrite
  a differently sourced marketplace named `agent-skills` or install a duplicate copy already
  present through another marketplace; surface the conflict and let the user choose which copy to
  keep. On opencode there is no plugin-marketplace distribution: skills load from skill
  directories, so suggest `npx skills add addyosmani/agent-skills -g` (the same CLI that
  installs autoloop's skills) or continue with inline fallbacks — a NOTE, never blocking.
- Gate candidates: inspect `package.json` scripts (`verify`, `test`, `build`), `docker-compose.yml`
  services, `Makefile` targets — propose the best guess, never invent one.

After these facts are known, print one plain status line:
`setup · v<version> · <fresh install | reconfigure | doctor> · <owner/repo>`.

## 2. The wizard (fresh install; reconfigure asks only what the user wants changed)

Read the global wizard defaults first (section above) and pre-select every matching answer,
labelled "(your default)". Ask with the active host's interaction adapter, one round of related
questions at a time:

1. **Supported hosts + engine profile** — ask which hosts this repo must run from, then persist
   the answer as the required canonical `runtime.supportedHosts` array. The five valid sets:
   `["claude"]`, `["codex"]`, `["opencode"]`, `["claude", "codex"]`, `["claude", "opencode"]`.
   **Never offer `codex` + `opencode` together (with or without Claude)** — non-Claude hosts are
   native-only and each forces its own engine profile, so two of them contradict; only the
   Claude host can orchestrate another host as an engine. This is deployment intent, not the
   active setup host. On Claude-only, offer `codex` (direct `codex exec` — requires the `codex`
   CLI installed + authenticated), `opencode` (direct `opencode run` — requires the `opencode`
   CLI installed + authenticated), or `claude` (fresh Claude subagents). Any host set containing
   `codex` must use the `codex` profile, and any containing `opencode` the `opencode` profile,
   with every role pin for that engine set to `null`; a native host cannot use another host's
   profile. For dual-host, if the engine CLI (`codex`/`opencode`) is missing or unauthenticated,
   say exactly what's missing (install + login), scaffold the profile anyway (the CLI is a
   run-time dependency, not a setup-time one), and note Claude-hosted runs stay blocked until it
   resolves. Offer the `claude` fallback **only** for `["claude"]` — otherwise it silently
   removes the other host's support.
   On reconfigure, preserve this field unless the user explicitly changes host support; a legacy
   config without it always requires the migration question. If the confirmed host set makes
   existing pins invalid, show the exact pins that will be cleared as part of the config diff;
   never clear them before the user confirms that host-set migration.
2. **Models & effort** — on Claude's direct-exec route, pinning is optional and rides each
   dispatch as `codex exec -m <model> -c model_reasoning_effort=<effort>` (defaults: all four
   null — Codex's session defaults apply). **Name the current Codex defaults in the option
   text** only from sanctioned output (`codex exec --help` documents the flags; the defaults
   themselves live in the user's Codex config) — if unknown, write "Codex default" rather than
   guessing, and never read `~/.codex/*` to find out.
   Offer per-role pinning: `implementerModel`/`reviewerModel` (model ids) and
   `implementerEffort`/`reviewerEffort` (effort levels as the plugin accepts them, e.g. `medium`,
   `high`, `xhigh` — passed through verbatim). claude profile: default **inherit the session
   model** (both null); offer optional pinning (e.g. implementer `sonnet`, reviewer `opus`) for
   cross-model review diversity; effort is not configurable there (subagents inherit the
   session's). Native Codex subagents inherit the active session configuration. Whenever
   `runtime.supportedHosts` contains `codex`, require all four Codex role pins to be `null`, even
   if Claude's bridge could honor one. Revalidate this rule on every model or host-set change;
   never claim an unpassed model/effort override was honored.
   On Claude's opencode-exec route, pinning is likewise optional and rides each dispatch as
   `opencode run -m <provider/model>` (`engine.opencode.implementerModel`/`reviewerModel`;
   defaults null — opencode's own configured default applies). There are no opencode effort
   pins (`--variant` is deferred until a repo needs it). Whenever `runtime.supportedHosts`
   contains `opencode`, both opencode pins must be `null` — native opencode inherits the
   session configuration. Whatever the pin, the unit record discloses the actual model from
   the dispatch's event stream.
   The orchestrator always runs the session model — not configurable here.
3. **Gate** — the objective gate command. Prefer an **existing** single command (package script,
   make target, compose service) verbatim. When no single command covers the tree (e.g. a
   multi-package repo needing lint + static analysis + unit tests per package), the wizard may
   propose **generating** a wrapper script (`tools/agentic/gate.sh`) — but a filename the user
   has never seen explains nothing: the option label must say it is a **new script setup will
   write**, the description must state in one line what it runs, and the option preview must show
   the script's **full contents**, not a summary. Never present a not-yet-existing file as if the
   user should recognize it. Recommend a sandboxed one-shot runner (no live credentials, no
   network, no live data) and warn when the chosen command lacks that isolation. Also offer an
   optional **`gate.quickCommand`** (default null): a faster scoped variant (lint + static
   analysis + the touched package's tests) for inner-loop iteration — state plainly that the
   full `gate.command` remains the only "done" and always runs last before a PR goes ready.
   Optional
   `setupCommand` for first-run deps.
   **The gate has a floor: at least everything the repo's CI requires for merge.** The gate is
   the loop's definition of "done" — a gate weaker than CI doesn't ship broken code (CI still
   blocks the merge) but it produces false "done"s: PRs go ready, CI fails, and the pitcrew burns
   lifetime revise rounds discovering what the gate should have caught locally. So the
   recommended option is always the strongest full-verification command; subset options (e.g.
   lint-only) may be offered only with an explicit warning naming what CI requires that the
   subset skips. The user may still choose a subset — their call — but never un-warned.
4. **Base branch** — default: the repo's default branch.
5. **Merge policy** — three options, all but `manual` enacted by ratification:
   - `ratified` (**default/recommended when the repo has CI**): the loop auto-merges only the
     narrow reversible class — docs-only Path B plus human-risk-labelled Path A; everything else
     goes ready for the human.
   - `auto` (all-green): **every** loop PR auto-merges when all evidence is green (gate + review
     verdicts on the SHA, all required CI checks, clean state, no unresolved threads) — except
     the guardrail floor, which never auto-merges in any mode: protected paths (structural +
     escalate-list) and hard-block labels (`human:authorize`, …). Be explicit in the option
     description that CI quality becomes the de-facto reviewer of last resort, and REFUSE this
     mode when the repo has no CI unless the user accepts, in so many words, that merges would
     rest on the loop's self-issued verdicts alone.
   - `manual` (L2-strict; recommended when the repo has no CI): a human merges everything.

   Explain ratification in one line: the tool is generic — setup fills its config block
   (including `AUTOMERGE_MODE`: `classified` for ratified, `all-green` for auto) — and it carries
   NO authority until the human **merges the scaffold PR that vendors it**; that merge is the
   ratification, so the chosen policy may ship in the same PR. **When `ratified` or `auto` is
   chosen the scaffold MUST go via a PR** (a direct commit would skip the ratifying merge).
6. **Tracker** — `none` (digest to a GitHub comment) or `jira` (ask epic key + cloudId).
7. **Hooks** — independently offer the same repo-vendored policy for each host declared in
   `runtime.supportedHosts`:
   Claude's `.claude/settings.json`, Codex's `.codex/hooks.json`, and opencode's
   `.opencode/plugins/autoloop.js` (a thin plugin wiring the same vendored guards to opencode's
   hook surface; opencode declared also merges the `instructions` entry into `opencode.json`,
   which replaces the SessionStart STATE-cat other hosts use). Recommend the active host;
   recommend every declared host for a team repo. Existing hooks for an undeclared host are
   stale-config NOTE, not evidence that the host is supported. Codex project hooks require a
   trusted repo and a one-time `/hooks` review after creation or hash changes. If
   `.codex/config.toml` already contains inline `[hooks]`/`[[hooks.*]]`, merge equivalent
   handlers there instead of creating `.codex/hooks.json`; Codex merges both representations and
   warns, so leave exactly one representation in each config layer. If both already exist, show
   the overlap and ask before consolidating either maintainer-owned file. opencode loads plugins
   at startup — a fresh opencode session is required after vendoring or changing the plugin.
8. **Claude team plugin availability** — on Claude only, add `extraKnownMarketplaces` (the `autoloop` marketplace) and
   `enabledPlugins` (`autoloop@autoloop`, `agent-skills@autoloop` — agent-skills is mirrored in
   the autoloop marketplace) to the repo's `.claude/settings.json`, so teammates opening the repo
   are prompted to install and get the plugins auto-enabled? (Recommended for Claude team repos;
   skippable. Merge into existing settings, never clobber; validate the JSON parses.)

### Asking for invariants (the question must explain itself)

An invariant is a rule whose violation is a **defect by definition** — data-safety boundaries
("read-only against X"), idempotency and error contracts, never-throw guarantees, payload rules.
The loop treats the selected list specially: it is **quoted verbatim into every implementer and
plan-review prompt**, and the review checklist's Project Invariants section grades **every diff**
against it. That's why it must stay short (3–6 items) — a long list dilutes into noise nobody
checks.

When asking, the question text itself must say what selection means, in plain words — e.g.:
*"These rules get repeated to every implementer/reviewer thread and checked on every review.
Everything in applicable `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` guidance still applies
either way — leaving one unticked never permits violating it; ticking decides only what gets
drilled on every unit."* Never phrase it as "select what the loop must never violate" (which
implies the rest may be). Mine candidates from every applicable guidance file and the
repo's contract docs, give each a plain-language label plus a one-line why, pre-recommend the
clearly correctness/safety-critical ones, and let the user add their own. Style and process rules
(naming, formatting, commit style) are not invariants — leave them out.

## 3. Scaffold (fresh install; reconfigure touches only what changed)

Substitute placeholders (`{{PROJECT_NAME}}`, `{{REPO_GUIDANCE}}`, `{{SPEC_DOCS}}`, `{{INVARIANTS}}`,
`{{CONFIG_JSON}}`, `{{ESCALATE_PATHS}}`, `{{JIRA_EPIC}}`, `{{JIRA_CLOUD_ID}}`,
`{{GATE_COMMAND}}`, `{{CHECKLIST_PATH}}`) while writing. The generated JSON sets `version` to
the schema version pinned as `CONFIG_VERSION` in the vendored `tools/agentic/config-contract.mjs`
(the single source of truth — read it from there, never hand-write the literal) and includes the
validated `runtime.supportedHosts` array; preserve unrelated config
keys during migration.

| Target (host repo) | From template | Notes |
|---|---|---|
| `docs/agentic/STATE.md` | `STATE.template.md` | Fill the config block. For `{{REPO_GUIDANCE}}`, list applicable `AGENTS.override.md`, `AGENTS.md`, and/or `CLAUDE.md` files in precedence order; surface conflicts instead of choosing silently. For `{{SPEC_DOCS}}` list authoritative docs; for `{{INVARIANTS}}` follow "Asking for invariants" — never invent them. If no guidance file exists, recommend the active host's `/init` and agree which file is canonical before scaffolding a pointer for the other host. |
| `docs/agentic/LOOP.md` | `LOOP.template.md` | The human runbook. |
| `docs/agentic/checklist.md` (or the configured `review.checklistPath`) | `checklist.template.md` | Section 4 is `EDIT ME` — transcribe the STATE invariants. |
| `.github/ISSUE_TEMPLATE/loop-unit.md` | `issue-template.md` | Structured issue form so hand-written units arrive PR-sized (skippable; `autoloop:shape` emits the same structure). |
| `docs/agentic/ARCH.md` | `ARCH.template.md` | **Optional (recommended)** — wizard asks; see "Architecture map" below. |
| `tools/agentic/session-preflight.sh` | `tools/session-preflight.sh` | `chmod +x`. |
| `tools/agentic/config-contract.mjs` | `tools/config-contract.mjs` | Required config + supported-host validator. Run `--self-test`, then run it against the generated STATE with the active `--host`. |
| `tools/agentic/command-guard.mjs` | `tools/command-guard.mjs` | Run `--self-test` after vendoring. |
| `tools/agentic/writeback-check.mjs` | `tools/writeback-check.mjs` | Run `--self-test`. |
| `tools/agentic/label-swap-reminder.mjs` | `tools/label-swap-reminder.mjs` | PostToolUse hook: injects the step-line + task-rename rider checklist whenever a Bash command swaps a `loop:` label (mechanical anchor — prose alone drops riders under load). Run `--self-test`. |
| `tools/agentic/loop-scope.mjs` | `tools/loop-scope.mjs` | Run `--self-test`. |
| `tools/agentic/run-scope.mjs` | `tools/run-scope.mjs` | Run-scope contract: classifies the CURRENT invocation (queue draining default; bounded only on explicit "take ONE issue"/"only #N"/`maxUnits: N`) and validates end-of-run stop reasons — the regression suite for the single-unit-misinference incident. Run `--self-test`. |
| `tools/agentic/subagent-transcript.mjs` | `tools/subagent-transcript.mjs` | Subagent transcript capture into `.git/autoloop/subagent-transcripts/` (never committable). Codex: `SubagentStop` hook copies the payload + `transcript_path` file. opencode: the vendored plugin pipes each idle child's own messages (attributable — payload carries agent + parentID, messages carry model identity). Only meaningful when `runtime.supportedHosts` contains `codex` or `opencode`. Run `--self-test`. |
| `tools/agentic/scan.mjs` | `tools/scan.mjs` | One-call run scan (Prime/pitcrew derivation) + `--pr` revise facts. Run `--self-test`. |
| `tools/agentic/stats.mjs` | `tools/stats.mjs` | Cross-unit step-timing telemetry from label timelines (per-step medians, skipped-swap/stranded-label flags) — read-only, for the human and for pipeline tuning. Run `--self-test`. |
| `tools/agentic/escalate-paths.mjs` | `tools/escalate-paths.mjs` | Add the project's escalate paths (mirror STATE's list); run `--self-test`. |
| `tools/agentic/gate.sh` | *(generated by the wizard)* | Only when the wizard chose a generated gate wrapper: exactly the script previewed in the wizard, opening with a header comment saying it is the autoloop objective gate, what it runs, and that exit 0 is the only "done". `chmod +x`; `bash -n`; the config block's `gate.command` points at it. |
| `tools/agentic/publish-verdict.mjs` | `tools/publish-verdict.mjs` | Only when merge policy = `ratified` or `auto`. |
| `tools/agentic/auto-merge.mjs` | `tools/auto-merge.reference.mjs` | Only when `ratified` or `auto`: copy, then **fill the REPO CONFIG block** — `REPOSITORY`/`BASE_BRANCH` from repo facts; `REQUIRED_CI_CHECKS` from the repo's detected CI workflow job names, confirmed with the user (empty = no CI: warn loudly, recommend `manual`); `REVERSIBLE_PATHS` default `['docs/**']`, widened only by explicit user choice; `EXTRA_PROTECTED_PATHS` mirroring STATE's escalate-list. Fixtures derive from the config — `--self-test` must pass on the filled file. Ships in the scaffold PR with the chosen merge policy; the human's merge of that PR IS the ratification. |
| `.codex/agents/autoloop-reviewer.toml` | `codex-reviewer-agent.template.toml` | Required whenever `runtime.supportedHosts` contains `codex`. This named reviewer pins `default_permissions = ":read-only"` (Codex 0.145.0 profile model; the legacy `sandbox_mode` is a no-op in a `trust_level = "trusted"` project), `approval_policy = "never"`, and requests web/app tools disabled; effective isolation is verified after spawn. Omit model/provider/effort overrides so native roles inherit the session. Show a diff before replacing an edited copy. |
| `.opencode/agent/autoloop-reviewer.md` | `opencode-reviewer-agent.template.md` | Required whenever `runtime.supportedHosts` contains `opencode`. Host-enforced typed isolation: `permission: deny` strips edit/bash/task/webfetch/websearch from the spawned toolset entirely (verified on 1.18.3). Contract text mirrors the Codex TOML — keep them in sync. Show a diff before replacing an edited copy. |
| `.opencode/plugins/autoloop.js` | `opencode-plugin.template.js` | Required whenever `runtime.supportedHosts` contains `opencode` and hooks were accepted. Wires the vendored guards: command-guard (fail closed), label-swap-reminder, session-preflight injection, child transcript capture, writeback nudge-once. A fresh opencode session is required after vendoring. |
| `opencode.json` (merge) | `opencode-config.template.json` | Only when `runtime.supportedHosts` contains `opencode`: merge the `instructions` entry and the `permission` block into the repo's `opencode.json` (create it if absent; `$schema` only when creating). Merge per-key and never clobber a user-set value — a repo that already tightened or loosened a permission keeps its choice. The `instructions` entry auto-primes STATE.md; the `permission` allows (read/glob/grep/list/edit/bash/task/skill/todowrite/external_directory) are what let the loop run UNATTENDED — opencode's defaults prompt per tool, and a permission prompt mid-run is a stalled loop. The safety posture does not rest on prompts: the vendored plugin's command guard blocks the NEVER rules fail-closed, and the reviewer agent's denies OVERRIDE these project allows (verified on 1.18.4: with `bash: allow` project-wide, the spawned reviewer toolset still lacks edit/bash/task/webfetch/websearch). `webfetch`/`websearch` stay `ask` — the loop never needs them. opencode validates this file STRICTLY — an unrecognized top-level key (including a `"//"` comment key) makes every launch fail, so merge only schema-known keys and validate the result parses. |

Creating or changing `.codex/agents/autoloop-reviewer.toml` requires a fresh Codex session before
runtime selection can be verified. Static validation may pass in the setup session, but native
`autoloop:dev` dispatches the reviewer as a fresh `codex exec --sandbox read-only` process
(OS-enforced), so its read-only barrier does not depend on in-session selection at all; the
in-session `agent_type` spawn is only a degraded fallback when `codex exec` is unavailable (see
`autoloop:dev` Prime), and a fresh session is needed only to verify that fallback's runtime
selection.
**Distinguish two causes when a FRESH session still lacks the selector** (do not prescribe
another restart): VERIFIED on Codex CLI 0.144.5–0.144.6 (2026-07-19, live spawn-schema probes),
the model-facing spawn tool exposes only `task_name`/`message`/`fork_turns` — **no `agent_type`,
even with `multi_agent_v2` enabled** — an UPSTREAM VERSION GAP. Report it as a **NOTE, not a
FAIL**: "typed reviewer selection unavailable on this Codex version — native reviews run in
prompt-level isolation mode (untyped zero-context spawns + mandatory post-review integrity
verification; see autoloop:dev), disclosed per unit in run records. Typed isolation resumes
automatically when a Codex release exposes `agent_type`." A missing `fork_turns` field, by
contrast, IS a FAIL (zero-context spawning is non-negotiable). Also verified: exec sessions
load agent definitions from the USER scope (`~/.codex/agents/`), not the project's
`.codex/agents/` — the project file remains the reviewed source of truth that setup scaffolds;
syncing a copy to `~/.codex/agents/` is a user-level act and did NOT surface `agent_type` on
these versions. **Codex 0.145.0 update (verified 2026-07-22): the spawn tool now exposes
`agent_type`, but an in-session typed spawn still CANNOT enforce reviewer isolation — Multi-Agent V2
subagents inherit the workspace-write orchestrator and reapply its overrides, so a custom-agent
`default_permissions = ":read-only"` is an overridable default, not a lock (openai/codex#33314).
Native codex therefore dispatches the reviewer as a fresh `codex exec --sandbox read-only` process
with web search, apps, and `approvals_reviewer` auto-review pinned off (OS-enforced; see the `codex`
profile spec in autoloop:dev), not an in-session subagent; the `.codex/agents/autoloop-reviewer.toml`
`default_permissions = ":read-only"` supplies identity and is belt-and-suspenders. The in-session
typed spawn remains only a DEGRADED, integrity-checked fallback when `codex exec` is unavailable.**
Re-verify against release notes when the installed Codex exceeds 0.145.0.

Creating or changing `.opencode/agent/autoloop-reviewer.md` or `.opencode/plugins/autoloop.js`
likewise requires a fresh opencode session — agents and plugins load at startup. Static
validation in the setup session never substitutes for the effective-child check: doctor on
native opencode asks a spawned `autoloop-reviewer` to list its tools and fails unless the
denied tools are absent.

**Architecture map (optional, recommended).** When accepted — a fresh-install wizard question,
or offered ONCE on reconfigure when `docs/agentic/ARCH.md` is absent — explore the repo and
fill `ARCH.template.md` → `docs/agentic/ARCH.md`: a curated ~60–100-line map (components, key
paths/conventions, CI workflows WITH their path filters and an explicit list of paths with NO
coverage, environment/hostnames, integration points). It is **DATA the loop maintains** (dev
step 6 updates it when a unit changes structure), never instructions; budget ~8 KB. Write it
merge-friendly for parallel unit branches: no freshness/`Last verified:` line (the file's last
commit date is its freshness), no counts prose must keep in sync, no width-aligned tables,
one-line entries sorted where order carries no meaning (dev step 6 holds the full rules). Add a
one-line pointer to the **canonical** guidance file (per the repo's canonical-file choice):
`Architecture map: docs/agentic/ARCH.md — loop-maintained; read before planning.` The pointer
is written ONCE by setup and rides the scaffold/migration PR — the loop never edits guidance
files. Declining is a NOTE, not a problem. Reconfigure also offers **compaction** when the size
audit NOTEs it: distill STATE's Lessons (the rule, not the story — merge duplicates, drop
superseded entries) and re-curate ARCH.md; show the diff; never touch the config block,
invariants, or escalate-list.

Hooks (for each accepted host): **merge** `templates/settings-hooks.template.json` into
`.claude/settings.json`. For Codex, merge `templates/codex-hooks.template.json` into
`.codex/hooks.json` unless `.codex/config.toml` already contains inline hooks; in that case,
translate and merge the equivalent handlers into its existing TOML representation. Preserve
existing keys and matcher groups, never clobber, recognize prior Autoloop handler signatures as
the same handlers, and deduplicate them. Never leave both Codex representations in one config
layer. Validate the resulting JSON or TOML, then tell Codex users to review new or changed project
hooks with `/hooks`. For opencode, **copy** `templates/opencode-plugin.template.js` to
`.opencode/plugins/autoloop.js` (whole-file vendored artifact — diff before replacing an edited
copy) and merge the config fragment into `opencode.json`; remind the user that plugins load at
session start.

Labels are created idempotently WITH an explicit color so they stay reproducible instead of drifting
to whatever `gh` last assigned: `gh label create <name> --color <hex> --force`. Canonical scheme:

- `loop-ready` `0969DA` (blue) — the trusted, eligible queue
- `loop-started` `2DA44E` (green) — a unit is in flight
- step labels — a light→dark purple ramp; the loop wears exactly one at a time, swapping at each
  step boundary (their timeline events are the unit's per-step duration record):
  `loop:01-premise` `E6D9FF` · `loop:02-plan` `D4BBFF` · `loop:03-plan-review` `C29DFF` ·
  `loop:04-claim` `B080FF` · `loop:05-implement` `9E63FF` · `loop:06-simplify` `8C46F5` ·
  `loop:07-diff-review` `7A2FE0` · `loop:08-code-review` `6821B5` · `loop:09-gate` `561B8C`
- `loop:revising` `C264D9` (orchid) — the in-place rework state (retire pre-0.24 names
  `loop:06-diff-review`/`loop:07-gate`/`loop:08-simplify`/`loop:09-code-review` with user confirmation)
- `loop-delivered` `13A8A8` (teal) — reviewed, gate-green, awaiting the human merge
- `loop-blocked` `D73A4A` (red)
- `human:decide` `FBCA04` (yellow) — a design fork awaiting the human
- `human:authorize`, `needs-dependency`, `needs-secret` `D4C5F9` (gray-lavender)
- only when `ratified` or `auto`: `risk:pure-deletion`, `risk:mechanical-refactor`, `automerge:halt`

A leftover `loop-in-progress` label (pre-0.16) is superseded — offer to delete it, only with the
user's explicit yes.

**Committing the scaffold:** never commit to a protected base directly — branch
(`chore/autoloop-setup`), commit, open a PR for the human to review and merge. On an unprotected
fresh repo, ask whether to commit directly or via PR — **except when merge policy is `ratified`
or `auto`, which always requires the PR route** (the human's merge of that PR is the
ratification).

**Branch protection is the user's choice** — never probe it, never report on it as a check, and
never edit it. At the end of a fresh install, offer at most a one-line suggestion that protecting
the base branch pairs well with the loop; drop the subject if declined.

## 4. Doctor (read-only; also run automatically at the end of setup)

- `PASS/FAIL` toolchain: `gh` installed → authenticated (`gh auth status`) → THIS repo resolves
  (`gh repo view --json nameWithOwner`; auth ≠ access) — three distinct verdicts, so the fix is
  named precisely. `node` installed (the vendored hooks are Node scripts). On native Codex,
  `codex --version` is at least `0.144.5`.
- `PASS/FAIL` STATE exists and `node tools/agentic/config-contract.mjs` passes: config JSON parses,
  `version` is known, `runtime.supportedHosts` is non-empty/unique/known, and its engine/profile
  and null-pin matrix is valid. A missing host set is FAIL with "re-run setup"; never infer it.
- `PASS/FAIL` **scaffold prose drift** — a version that validates while prose enforces retired
  rules is exactly the incomplete-migration failure this check exists to catch; the fix is the
  full reconciliation migration above, delivered via PR. Grep per file (lists track the
  template — update them when template rules change):
  - STATE: FAIL on the retired markers `loop-in-progress` or `codex:codex-rescue`, or missing
    `loop-started`, `fix delta`, `dispatched ONCE`, `CI green on the head`, `awaiting-merge age`,
    `codex exec`, `opencode run` (the 0.24 template's engine section names every dispatch
    surface regardless of the declared hosts), or `run scope` (the 0.36 invocation-scoped
    run-scope contract) — a missing marker is a pre-current STATE needing the reconciliation
    migration.
  - checklist: FAIL on the retired line `has explanatory comments`, or missing
    `self-explanatory`.
  - LOOP: FAIL on missing `one-call run scan` or missing `take ONE issue`.
  - auto-merge engine zone: FAIL on missing `triggered CheckRun` (the 0.22.0 unconditional
    CI floor) — grep the vendored file, not the config; the engine zone is template-owned.
- `PASS/FAIL` the active host is declared in `runtime.supportedHosts`, then its dispatch capability
  is satisfiable (native Codex named subagents; Claude Agent tool; or Claude's Codex bridge).
  For every other declared host, validate static config/artifacts and report
  `NOTE runtime capability unverified here — run doctor on <host>`; never report an unseen
  runtime as passing.
- When Codex is declared, `PASS/FAIL` `.codex/agents/autoloop-reviewer.toml` exists, parses, and
  carries the load-bearing core: `name = "autoloop_reviewer"`, `sandbox_mode = "read-only"`,
  `approval_policy = "never"`, and `model` / `model_provider` / `model_reasoning_effort` absent.
  The extra hardening fields (`web_search`, `features.apps` / `features.tool_suggest` /
  `features.remote_plugin`, the four `apps._default` switches) are checked as **advisory
  `NOTE` only** — report expected-vs-found drift, never FAIL on shape. The plugin cannot verify
  the installed Codex build's agent schema from here; the *effective* spawned surface check in
  dev's native preflight is the enforcement, and a TOML corrected to the shape the real Codex
  accepts must not deadlock against doctor's expectations.
  On native Codex also `PASS/FAIL` no live parent permission override is active, the exposed spawn
  schema includes `agent_type`, the runtime can pass `agent_type = "autoloop_reviewer"` with zero
  inherited parent turns, and the spawned child effectively remains read-only with approvals,
  web search, and app/connector tools disabled. A task name or static TOML does not satisfy this
  check. Every inherited MCP tool visible to the reviewer must be absent or verifiably read-only,
  with unknown/write-capable tools a FAIL. On Claude, report runtime selection/tool-surface
  verification as NOTE pending a fresh native Codex session.
- When opencode is declared, `PASS/FAIL` `.opencode/agent/autoloop-reviewer.md` exists, its
  frontmatter parses, and it carries the load-bearing core: `permission` denies for `edit`,
  `bash`, `task`, `webfetch`, `websearch`, with no model/provider override (drift NOTE
  otherwise). `PASS/FAIL` `.opencode/plugins/autoloop.js` present when hooks were accepted, and
  `opencode.json` carries the `docs/agentic/STATE.md` instructions entry with NO unrecognized
  top-level keys — opencode validates the config strictly, and a stray key (e.g. a `"//"`
  comment, vendored by pre-0.36.3 templates) fails every launch in that repo; offer the
  one-line removal. `NOTE` when the `permission` block is absent or leaves a loop-required tool
  on `ask` (pre-0.37 scaffold) — unattended runs will stall on permission prompts until the
  template block is merged. On native opencode,
  also `PASS/FAIL` the effective reviewer child: a spawned `autoloop-reviewer` toolset must lack
  the denied tools (ask it to list its tools — glob/grep/read/skill/todowrite is the healthy
  shape) and `opencode --version` is at least `1.18.3`. `NOTE` when the machine-level skill
  install (`~/.config/opencode/skills/<name>`, via `npx skills add fabioneves/autoloop -g` or
  maintainer symlinks) is missing — invocation falls back to reading the cloned skills by
  path. On other hosts, report opencode runtime capability as
  `NOTE unverified here — run doctor on opencode`.
- `NOTE` agent-skills installed and enabled. On Claude suggest
  `/plugin install agent-skills@autoloop` when absent. On Codex, use
  `codex plugin list --marketplace agent-skills --available --json` to distinguish an absent
  marketplace, an available-but-uninstalled plugin, and an installed-but-disabled plugin; suggest
  `codex plugin marketplace add addyosmani/agent-skills` and/or
  `codex plugin add agent-skills@agent-skills` as appropriate, or `/plugins` to re-enable an
  installed plugin. Absence never blocks.
- `PASS/FAIL` gate command exists/executable (do NOT run the full gate; check the command resolves —
  script exists in package.json / compose service defined / binary on PATH).
- `NOTE` global wizard defaults: `defaults: none`, or the file's path + parses/doesn't (a parse
  failure is still only a NOTE — defaults never gate a run).
- `PASS/FAIL` labels exist.
- `PASS/FAIL` vendored tools present + every `--self-test` green, including
  `config-contract.mjs`.
- Per declared host, `PASS/FAIL` opted-in active-host hooks wired and `NOTE` for a deliberately
  skipped/unsupported hook layer. Hooks for an undeclared host are stale-config NOTE. On Codex,
  distinguish configured from effective because the repo and hook hash must be trusted.
- `NOTE` a generated `docs/agentic/LOOP.md` still contains the deprecated supervised sequence that
  starts the queue-wide `/goal` before "take ONE issue and stop"; recommend the reviewed template
  migration. Do not rewrite locally edited prose in doctor mode.
- `NOTE` merge policy `ratified`/`auto` but `tools/agentic/auto-merge.mjs` missing (or vice versa:
  a tool present while policy is `manual`). `FAIL` when the vendored tool still carries the
  unfilled `your-org`/`your-repo` config placeholders — an unconfigured policy must never run.
- `NOTE` config drift: vendored tools differ from the current plugin templates (offer a diff).
- `NOTE` gate weaker than CI: a CI-required check with no counterpart in `gate.command` (name the
  missing check — failures there surface only after the PR goes ready).

Print the report as a compact PASS/FAIL/NOTE list. In doctor mode, stop there.

## Hard rules

- Idempotent: re-running never duplicates hooks, labels, or files.
- Show a diff and ask before overwriting anything a maintainer may have edited.
- Never invent project invariants, spec docs, or a gate command — propose detected candidates, ask,
  or leave an explicit `EDIT ME` marker.
- Never infer `runtime.supportedHosts` from the active session, engine profile, or hook files; host
  intent is an explicit persisted user choice.
- Never claim native reviewer isolation from prose alone: the named project agent and verified
  `agent_type`, zero-parent-context, effective read-only dispatch are required. A missing
  `agent_type` field or live parent permission override is incompatible with that guarantee.
- Never edit branch protection; never commit directly to a protected base branch.
- The vendored copy is the authority in the host repo — plugin template updates apply only through
  an explicit re-run of setup, reviewed like any other change.
