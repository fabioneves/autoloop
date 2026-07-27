# Changelog

Notable changes to Autoloop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow semantic versioning.

## [0.46.1] - 2026-07-27

### Fixed

- **The documented free-plan 403 is authoritative absence of branch rules.** A private repository
  on a free plan returns HTTP 403 ("Upgrade to GitHub Pro or make this repository public") from
  the rules and classic-protection endpoints — the plan-limitation signal on exactly the
  configuration solo-operator mode exists for, where the spec already waives protection
  verification because the plan cannot have any. `delivery-contract` treated only 404 as absence,
  so every solo unit finished review- and gate-clean and then blocked forever at terminal
  finalize; a live unit did exactly that with four converged codex rounds and a green gate behind
  it. The two protection reads now opt in to treating that specific 403 — status and upgrade
  message both required — as absence; a permissions 403 without the message still aborts, and any
  other endpoint still aborts on any 403.
- **`git` as an argument is data, not an invocation.** The ambient-alias rule found `git` anywhere
  in a segment's words, so a quote-stripped section banner — `echo "=== git diffstat ==="` — read
  as an unknown subcommand and sank an innocent compound. `git`/`gh` now count only in executable
  position (start of segment, or behind assignments and transparent wrappers: `command`, `env`,
  `nohup`, `nice`, `timeout`). A real `git diffstat` still blocks, wrapped or not.
- **The setup phase ribbons return to the wording that provably announced.** Two rewrites tried to
  fix the green double-print and each broke announcement itself — one phase of five, then none.
  The 0.45.0 text demonstrably printed every phase on the current model and returns verbatim,
  with one added sentence (green only on the closing rail) and 🟩 removed from the per-phase
  badge legend.

## [0.46.0] - 2026-07-27

### Changed

- **Every background dispatch is watchable, natively.** `dispatch-stream.sh` (vendored) makes the
  background task its own watcher: it starts the dispatch, tails the live file to its own stdout —
  which the host streams into the task view natively — and exits with the dispatch's code. One
  task per dispatch, no separate tail shell, engine events visible for the whole run, the typed
  result collected from the output file. Only sub-minute dispatches may skip the wrapper. Proven
  end to end: a real dispatched review streamed its full event flow through the wrapper's stdout
  with the typed result intact.
- **Simplify and fix rounds are dispatches, not orchestrator edits.** The orchestrator's ~86k-token
  context was the one place in the loop still writing code by hand — the most expensive possible
  place to do it, paying full-context turns for every finding fixed. Both now run as background
  `implement` dispatches in the same shape as reviews: bounded prompt, `--output-file`, armed
  monitor, overlap or park while they run, `WRITER_MADE_NO_CHANGE` refusing a fixer that only
  claimed to act. Only a trivial edit (~five lines, two files) stays inline. The engine follows
  the writer — whoever wrote the unit writes its fixes — and the other model keeps reviewing: an
  engine never reviews its own code.
- **Long gates background like dispatches, and the offload rule is stated once.** A blocking turn
  watching a test suite is the same waste as one watching a dispatch: gates over a minute run in
  the background with a monitor on the log while the orchestrator overlaps or parks. The general
  principle now sits in the skill — dispatch or background what is bounded and bulky (writing,
  fixing, reviewing, long gates); keep in-session what is stateful and small (plans, claims,
  labels, collection, the five-axis judgment), because shipping the orchestrator's state out costs
  more than the turn it saves.
- **Four flow cuts, each argued from a live measurement.** SIMPLIFY keeps its timeline slot and
  loses its dispatch — simplicity is the writer's prompt requirement, residual complexity is a
  review finding, and the standalone pass re-read a whole unit to change nothing on its first
  live outing. Convergence closes **optimistically**: after a fix batch the next round is
  full-artifact and closing (full covers delta by definition), delta scope reserved for
  mid-storm; the typical unit drops from three codex rounds to two. Plan review is
  **lane-tiered**: serial for the full lane (a staged plan failing with nine findings is an
  implement not wasted), concurrent with claim-and-implement for small/docs lanes, aborting on a
  Critical — the wait moves, the gate does not. And the slim handoff check runs concurrently
  with the round-1 dispatch, since reviewers hold no Bash and never depended on it. A typical
  clean unit: ~75–90 minutes before, ~50–60 after, one dispatch and one codex round fewer.
- **The five-axis pass is replaced by a scope rule: convergence closes full-artifact.** Three
  designs in one night — in-session, then dispatched, then cut — because the evidence never
  supported "claude must look last", only "a full-artifact look at the final head catches what
  delta rounds miss": the one Major that survived three delta-scoped rounds fell to the first
  whole-artifact re-read. Scope was the active ingredient, not the engine, and the checklist
  rides in any reviewer's prompt. Under `with codex`, the closing round is codex, full-artifact,
  checklist-armed — cross-model over what actually ships, at zero Claude tokens, bounded by the
  existing round cap. Typical unit: r1 full, r2 delta, r3 full-close.
- **Under `with codex`, Claude's step-7 review becomes a slim handoff check.** Mid-pipeline
  it reviewed the pre-codex artifact, and every fix round landed after it unseen — so the final
  artifact got no Claude-shaped review at all, while the mid-pipeline pass cost a full checklist
  cycle that did not prevent codex finding two Majors an hour later. The one Major the
  orchestrator did catch tonight came from a full-artifact look at the delivery head, which is
  exactly the end position.

  Step 7 in codex mode is now a slim handoff check (build and tests green); after the codex rounds
  converge and before the gate, the orchestrator runs the full five-axis pass over the complete
  final diff. A Critical/Major found there is fixed and re-covered by exactly one codex delta
  round, then the five-axis re-checks that delta only; Minors become run-record notes, never
  re-entry. The final pass is a gate, not a second convergence loop.

  The pass itself is a DISPATCHED claude review, not orchestrator work: reading the final diff
  in-session would bloat every later turn's context, while a fresh reviewer reads the repository
  with its own tools and returns a compact verdict. The prompt carries the checklist, the frozen
  plan, and the codex rounds' finding ledger; the orchestrator keeps only disposition — fix,
  rebut, or note, judged from the verdict. Plain runs are unchanged, so every unit is still
  reviewed by both models — the layering just puts each where it earns most: codex adversarial in
  the middle, Claude's checklist over what actually ships.

## [0.45.3] - 2026-07-27

### Fixed

- **Every setup phase prints its ribbon again.** The 0.45.1 anti-doubling wording — "never a second
  copy of the same ribbon" — read, to a cautious session, as a reason to be sparing with ribbons
  altogether: a live run printed 1/5 RESOLVE and nothing after it. The rule now states the count
  outright: exactly five 🟦 ribbons per run, one as each phase begins; the forbidden thing is the
  re-print, and a phase that starts without its ribbon is as wrong as a doubled one.

### Changed

- **`with codex` survives the distance to the first review.** The engine choice was prose at the
  top of the session; by the first reviewer dispatch it is forty minutes and a hundred thousand
  tokens up-context, the tool default is the host engine, and a forgotten `--engine` silently
  reviewed on the writer's own model — with ribbons regressed, nothing would even have said so.
  The skill now records the choice once after prime (`autoloop/review-engine`, beside the dispatch
  log) and `dispatch.mjs` routes every reviewer dispatch from the recording; a plain run always
  overwrites with `claude` so a previous session's choice cannot leak forward. Reviewer roles
  only — the writer stays on the host in every mode — and an unrecognised recording falls back to
  the host engine. Proven with a real dispatch: no flag, recorded `codex`, verdict returned with
  `"engine": "codex"`.
- **`--engine` reaches the engine.** The flag parsed cleanly since 0.44.0 and was dropped at the
  CLI seam: `main()` built the dispatch options from role, prompt and tools only, and every
  self-test called `runDispatch()` directly, so the boundary had no coverage. A review requested
  with `--engine codex` silently ran claude — labeled `[CODEX]` by a banner that trusted the
  flag — until the live loop caught it and re-dispatched through the API as a workaround. The
  seam now passes every parsed option through, and the new self-test drives the actual CLI with a
  PATH containing only a codex shim, so dropping the engine again cannot pass: the claude fallback
  would fail to spawn. `--live-file` crosses the same seam and would have shipped dead without it.
- **Watch a running dispatch live.** Engine stdout streams to a file as it is emitted —
  auto-named under `autoloop/dispatch-live/` in the common Git directory, or exactly where
  `--live-file <path>` says. Name the path up front, arm a `tail -F <path>` background shell, and
  the host's background-task view becomes a live codex window; the path is also announced on
  stderr at spawn. A 13-minute review used to run as a sealed box.
- **A ribbon prints exactly once — waiting status is heartbeat news.** A live run re-printed both
  in-flight ribbons with an "in flight" suffix as its waiting update: the dev rule stated a floor
  (every step prints one) but no ceiling, and gave waiting no shape of its own. Now: one ribbon
  per step, at the moment it begins; `♡` heartbeat lines carry in-flight status; resuming from a
  parked wait prints `♡ resumed — <what fired>` and never re-announces a step.
- **Parking is not stopping, and the skill now knows the difference.** The liveness rule said
  "never end the turn mid-unit; hold the wait with bounded polls" — written for a host that
  allowed sleep-chains. This host blocks them and re-invokes the session when a Monitor fires, so
  a live run did the right thing (both dispatches backgrounded, monitors armed on the result
  files, commits pushed, parked heartbeat printed) while the skill's own text said otherwise and
  the screen read as stopped. The sanctioned shapes are now explicit: parked wait — background +
  monitor + pushed work + a final `♡ parked` line naming what resumes it — or one bounded
  until-loop when no monitor exists. The Stop hook's unpushed gap still guards real abandonment,
  which a parked wait satisfies by construction.
- **A resumed unit branch runs installed tools, not its fossils.** Resuming a unit checks out its
  branch — correctly — and the branch carries the `tools/agentic/` copies it forked with. A live
  resume sat 18 commits behind base with a dispatch predating `--engine`; the reviewer dispatch
  failed usage-typed, and the session recovered by invoking the plugin-cache copy. That recovery
  is now the rule: on vendored drift, run the installed plugin's copy of the tool; never commit
  tool refreshes into a unit branch to compensate.
- **The dev startup stops reading the driver's source to learn the request shape.**
  `lifecycle-driver.mjs --example-request` prints a request that passes the driver's own
  validator — it is the self-test fixture with its hash made consistent, so it cannot drift from
  what validation accepts. A profiled run spent its longest thinking stretch reading 1800 lines of
  driver source, then assembled the request wrong twice anyway (a string where `plan` wanted an
  object, then a scratchpad cwd). The skill now names the three-command recipe, and the checkout
  probe failure reports its cwd with the remedy instead of the bare "Git checkout probe failed".
- **Every dev step prints its ribbon, stated as a count.** Same regression class as setup's: after
  the model switch, ribbon output stopped entirely. The rule now says eleven ribbons for steps
  1–11 plus `00/11 RECONCILE` the moment an orphan surfaces, and that the anti-noise rule is about
  re-printing, never about skipping the announcement.
- **Setup trusts the preflight instead of re-deriving it.** A profiled reconcile said "preflight
  already tells me" and then re-ran every check: gh auth, node, codex, config contract, and the
  full install-root verify — the largest single payload of its AUDIT phase. When the SessionStart
  preflight block is present and free of FAIL lines, its facts stand; with a green preflight,
  reconfigure/reconcile AUDIT is two sections (`scaffold --audit` and document sizes), and
  `verify --install-root` runs once per setup, in VERIFY, against the state that ships. The full
  battery remains for fresh installs, migration, doctor, and a missing or FAILing preflight.
- Version currency pipes through `--sort-versions | tail -3`: only the newest versions answer the
  question, and a mature cache holds dozens — a live run printed 87 lines to learn one.

## [0.45.2] - 2026-07-27

### Fixed

- **Setup states where `templates/` actually is.** Prime step 1 said "this skill's sibling
  `templates/` directory", and a live session read "sibling" the natural way — sibling of the
  skill's own directory — and looked for `skills/setup/templates/`, which does not exist. The
  directory is a sibling of `skills/` at the plugin root. The step now gives the relationship
  mechanically (`<skill dir>/../../templates`) instead of a word two directories can both claim.

## [0.45.1] - 2026-07-27

### Fixed

- **A reworded autoloop hook replaces its predecessor instead of stacking beside it.** The hook
  merge deduped by exact command text, so any change to an autoloop-owned binding — adding
  `|| exit 2` in 0.45.0 — made the template entry look new, and the merge appended it. Both hosts
  then carried two `Bash` PreToolUse entries running the same guard, the stale one without the
  fail-closed suffix, and a live setup had to hand-remove the duplicate in its visible diff. Two
  entries running the same `tools/agentic/` tool on the same event are versions of one autoloop
  binding: the merge now replaces the superseded one in place. Maintainer hooks — anything not
  running the same vendored tool — are untouched, and an identical command still changes nothing.
- **PR and issue bodies are composed in files, stated in both skills.** The natural idiom —
  `gh pr create --body "$(cat …)"` — is command substitution and is refused whole, and a live
  reconcile delivery lost a call to exactly that. `gh` has the sanctioned flag built in: write the
  body to the scratchpad and pass `--body-file <path>`; commit messages use `git commit -F -` with
  a quoted heredoc. Verified against the guard: the inline form blocks, the body-file form passes.
- **Setup prints each phase ribbon once, not twice.** The badge instruction listed 🟩 as "complete"
  alongside 🟦 "in progress", which read as an invitation to re-print every phase's ribbon with a
  green badge when it finished — doubling every line of a five-phase run for no information, since
  the next phase's 🟦 already says the previous one completed. A ribbon is printed once, as the
  phase begins; 🟩 appears exactly once, on the closing rail; 🟥/🟨 replace a phase's 🟦 only when
  it blocks or needs a human.

## [0.45.0] - 2026-07-27

### Changed

- **A guard refusal reads as a policy decision, not a malfunction.** Blocking with stderr and
  `exit 2` alone makes the host render every refusal as `PreToolUse:Bash hook error` — identical to
  a crashed hook. A correct decision then looks like a broken tool, which invites working around it
  instead of reading it. The guard now also emits the structured
  `hookSpecificOutput.permissionDecision: "deny"` with its reason, and the error framing disappears
  while the reason survives verbatim.

  All three channels are load-bearing and were measured, not assumed. The JSON removes the error
  framing. `exit 2` keeps the refusal failing CLOSED on any host that does not parse that shape —
  Codex and opencode run this same guard, and JSON with `exit 0` would fail OPEN there, a security
  regression rather than a cosmetic change. stderr keeps the reason visible on exactly those hosts.
  Verified against a live host: the command is blocked, the reason is quoted verbatim, and no error
  prefix appears.

### Fixed

- **A crashed guard now refuses instead of letting the command through.** The hook wrapper handled
  the guard being *missing* — that branch exits 2 and fails closed — but not the guard *crashing*:
  node's exit 1 propagated and the host ran the command. A partly vendored, syntax-broken, or
  dependency-missing guard therefore permitted everything, silently. Found by accident when a test
  rig copied `command-guard.mjs` without its sibling imports and the guarded command simply ran.

  Both host wrappers now chain `|| exit 2`, so any non-zero exit refuses. The hook contract in
  `verify.mjs` requires it rather than merely tolerating it, so the fail-open shape cannot return
  unnoticed.

## [0.44.4] - 2026-07-27

### Fixed

- **An unrecognised lifecycle-driver mode is a usage error, not a JSON parse error.** `main()`
  read stdin before validating the mode, so any unknown flag fell through to `JSON.parse` on an
  empty stdin and reported `Unexpected end of JSON input`. A live session ran
  `lifecycle-driver.mjs --help` and was told its JSON was corrupt — a data problem that did not
  exist, for what was only a mistyped flag.

  The mode is now checked first, and an unrecognised one names the valid modes, which makes
  `--help` self-documenting without adding a flag. A genuinely malformed payload still reports the
  real parse error, so the two failures stay distinguishable.

## [0.44.3] - 2026-07-27

### Fixed

- **The `$?` rule covers the shape rather than one spelling of it.** 0.44.2 told Setup never to
  append `; echo "exit=$?"` — written against the single instance observed. The next run wrote
  `git status --short && echo "clean=$?"`: different separator, different variable name, same
  unresolvable expansion, same refused call. The rule now forbids `$?` outright in any spelling and
  in both skills; Dev had no rule at all, and the failing command came from a Dev-shaped flow.

  It also states why, which the narrow version did not: `$?` conveys nothing here. The tool result
  already carries the exit status, and after `&&` the echo runs only when the command already
  succeeded, so `A && echo "ok=$?"` can print nothing but `0`. Four occurrences in one day across
  three spellings.
- Dev also gains the literal-path rule Setup got in 0.44.2 — a shell variable standing in for a
  path you already know is one more thing the guard must resolve, and buys nothing in a command
  written once.

## [0.44.2] - 2026-07-27

### Fixed

- **A quoted heredoc body is data, not code.** The expansion check ran on the raw command, so text
  inside a `<<'EOF'` body was scanned as shell syntax — and a reconcile commit message carrying
  backticks around `m` and `scaffold.mjs --reconcile` was refused as command substitution. The loop
  could not write its own commit message. A quoted delimiter means the shell performs no expansion
  and no substitution in that body, so it is stripped before the check.

  Only the quoted form. An unquoted `<<EOF` body genuinely does expand, and the existing
  `stripHeredocs` removes both kinds alike — reusing it here would have turned `<<EOF` with
  `$(...)` into a blind spot, so a narrower `stripQuotedHeredocBodies` was added instead. Pinned in
  both directions: quoted bodies with backticks and with literal `$(pwd)` pass, unquoted bodies
  with either still block, a quoted heredoc cannot smuggle a `gh pr merge` after its terminator, and
  substitution outside a heredoc is unaffected.
- **Setup stops writing commands its own guard refuses.** The prescribed one-call audit is
  guard-clean, but the skill then says "follow it with one targeted check" without saying the
  follow-up must be guard-clean too — and Dev's equivalent "No improvised inspection" section had no
  counterpart in Setup. So Setup improvised, and reached for exactly the two shapes policy forbids:
  `node -e '<js>'` to call a contract, and `awk '<program>'` to measure a section. Both are
  executable source the guard cannot read, so both are refused. Observed on consecutive setup runs,
  each spending a refused call and a retry on the same two shapes.

  The refusals were correct; the skill asking for them was not. Setup now carries the same guidance
  Dev has: substitute the literal path wherever the skill writes `<templates>` rather than standing
  a shell variable in for it, call a contract through its CLI or a scratchpad script file rather
  than `node -e`, and measure with `wc -c`, `grep -c` or `sed -n` rather than an awk program — a
  `sed -n '/^## Heading/,$p'` range reads what an awk range would. Each replacement was verified
  against the guard rather than assumed.

## [0.44.1] - 2026-07-27

### Changed

- **A second review engine is opt-in, not the default.** v0.44.0 routed every reviewer role to codex
  automatically, which was wrong: it made an absent codex break a plain run that had asked for
  nothing unusual, and it put a second vendor in the loop by assumption rather than by choice. Every
  role now runs on the orchestrating host unless the invocation says otherwise — `/autoloop:dev with
  codex` sends reviews to codex and appends ` · reviews codex` to the startup banner so a run states
  which engine judged it. The writer always stays on the host. Everything the codex path gained in
  0.44.0 is unchanged and still available; only the default moved. Preflight downgrades a missing
  codex from FAIL to NOTE to match.

### Fixed

- **Setup obeys the configured base branch with its checkout, not only with its audit ref.** Setup
  already audited `origin/<base>` rather than the parked checkout, and treated a unit branch's older
  files as a NOTE rather than drift. That fixed the comparison axis and left the execution axis
  untouched: the hooks load `$CLAUDE_PROJECT_DIR/tools/agentic/*`, so the command guard, the
  preflight and the label hooks all run the WORKING TREE's copies. A session parked on a unit
  branch therefore executes the tools that branch forked with, however current the base is.

  Observed three times in one day on the same repository. A guard fix shipped in 0.42.3, installed,
  and reconciled onto `main` stayed inert across three sessions because each ran from a unit branch
  that predated it — and each session, twice including this one, diagnosed the resulting block as a
  new bug. Setup now fetches and switches to `cfg.baseBranch` on a clean tree before auditing, the
  same rule Dev has applied at Prime all along. A dirty tree or an in-flight loop unit stays human
  work: stop with the remedy, never stash or discard.
- Preflight names the mismatch mechanically, so a stale checkout is visible at session start rather
  than inferred from a confusing refusal several steps later.
- **The command guard resolves a literal assignment on any line, not only the first.** The 0.42.1
  resolver anchored on `^` with a `/gu` regex and no `m` flag, so `^` matched the very start of the
  string and nothing else: an assignment was recognised on line 1 and invisible everywhere after it.
  A live audit battery ran fine as `T=...` on its first line and was refused as opaque the moment a
  `cd` was added above it — the resolver could no longer see the assignment, so the expansion looked
  unreadable. A newline separates commands exactly as `;` does, and is now treated that way.

  Strictly stronger, not looser: `cd /repo` then `verb=merge` then `gh pr $verb 42` now blocks on
  the merge rule itself rather than on shape, and genuinely unresolvable values —
  `T=$(pwd)` — stay opaque and stay blocked.

## [0.44.0] - 2026-07-27

### Added

- **Reviews run on codex, not the writer's own model.** A fresh process gives identity separation,
  not cognitive separation: a reviewer running the writer's model inherits its priors and misses
  what it missed, which is the one thing an independent review exists to avoid. `plan-review`,
  `code-review` and `doubt-review` now dispatch to codex; `implement` stays on claude. The split is
  the tool's default rather than a convention, so a review reaches the writer's model only when
  asked for explicitly with `--engine`.
- **A second engine adapter in `dispatch.mjs`**, selected by the binary's own name so a fixture
  shim on a path and an installed binary resolve alike. Codex runs
  `exec --json --output-schema <schema> -o <last> --sandbox read-only --ephemeral -C <cwd>` with the
  prompt on stdin; its verdict is read from the output-last-message file rather than recovered from
  an event stream, and validated against the same schema as any other. `--sandbox read-only` is
  OS-enforced, so the reviewer's read-only posture is strictly stronger there than the tool
  allowlist it has under claude. Codex refuses a writing role rather than approximating one, and an
  absent codex fails typed — there is still no fallback engine.
- Preflight reports a missing codex at session start, which is where that belongs rather than at
  the first review of a finished unit.

### Changed

- The `loop-smoke` posture audit accepts either proof of the same invariant — claude by permission
  mode and tool ceiling, codex by sandbox — and refuses a write capability in both shapes.
- Review prompts are framed adversarially by contract: a different model is only worth its cost if
  it is asked to disagree, so plan and code review challenge the approach, its assumptions and its
  tradeoffs rather than only hunting defects in the diff.
- The startup banner drops its state badge — a run that is starting has no outcome to report — and
  names the engine pairing instead.

## [0.43.1] - 2026-07-27

### Added

- **A dispatched step names the host that produced it.** Which host ran a review is a property of
  that review: a reviewer sharing the writer's host carries correlated blind spots, an external one
  does not, and the two are not interchangeable evidence. `dispatch.mjs` reports `engine` on every
  typed result, on typed failures, and in each dispatch-log entry — stamped once in the wrapper so
  no return path can omit it, and reduced to the binary's name so a fixture shim and an installed
  `claude` read alike. Banners carry it in a fixed `[HOST]` slot immediately after the step name,
  upper-case and bracketed so an external host is obvious rather than buried among trailing fields.
  Orchestrator-run steps take no slot, which is the honest statement that nothing was dispatched.

### Fixed

- Setup and pitcrew closing rails were left unbadged by the 0.43.0 visual pass. `setup · complete`
  is the line that reports a run finished, so it now carries the same 🟩 as the dev rails.

## [0.43.0] - 2026-07-26

### Added

- **Depth-one overlap is back, and this time it is measured.** v0.39 staged the next eligible unit
  while a dispatch was in flight; v0.40.0 rewrote the skill around the broker and dropped the
  section. Nothing failed when it went, so it stayed gone for three minor versions — a live 0.42.3
  run idled 32 minutes across two dispatches with five eligible issues queued. Restored with the
  trigger generalized to any background dispatch rather than an enumerated step list, and with one
  host-neutral idiom (the dispatch call backgrounded, collected from `--output-file`) replacing the
  branching across Claude, native Codex and opencode. Limits unchanged: one staged ahead, never two
  writers, never claim the staged unit until the worked one is terminal, read the committed tree
  and never the writer's working tree.
- **`overlap-report.mjs`** — the run record's `overlap:` line, computed instead of narrated. Sum of
  dispatch durations minus their union is exactly the wall-clock two or more were in flight, so
  `concurrent 0s` beside `eligible 5` is a run that serialized work it could have overlapped.
  v0.39 had the same line but hand-written, which is precisely why its disappearance went unseen.
  Run scope comes from the run-marker mtime `prime.mjs` already writes.
- **Every dispatch records its own window** to `autoloop/dispatch-log.jsonl` in the common Git
  directory — common so units in separate worktrees stay comparable, inside `.git` so it can never
  be committed. Typed failures are logged beside successes, so idle time cannot be understated by
  counting only what worked.
- **A state badge on every banner** — 🟦 in progress, 🟩 terminal success, 🟥 blocked, 🟨 needs a
  human — plus a round ribbon for code-review convergence against its cap. The `▰▱` ribbon is
  unchanged and the badge is a prefix, so the release-pinned startup literal still matches.
- **Preflight names vendored-tool drift.** `tools/agentic/*` is a copy taken when setup last ran, so
  a released fix reaches a checkout only when setup runs again — and a 0.42.1 command-guard refused
  the audit battery of the 0.42.3 setup that would have replaced it. Two causes, the second
  previously invisible: setup has not run, or the checkout is a unit branch that forked before the
  reconcile landed on its base.

### Fixed

- **Ending a turn mid-unit is a write-back gap.** A live run stopped at step 8 of 11 —
  `stop_reason=end_turn`, not a crash — leaving four commits only in the local checkout. Every
  guard had a reason to stay quiet: clean tree, draft-PR case deliberately a reminder, and step
  labels never advanced past claim so the unit did not look mid-flight. Unpushed work under an open
  loop PR is now a hard gap, checked with `git rev-list --count` against the tracking ref — no
  GraphQL, which is why the draft check was softened in the first place.
- **A skipped step-label swap can no longer pass unseen.** The same run swapped `loop:04-claim` and
  never swapped again, running implement, simplify, diff review and two code-review rounds while
  the issue still advertised claim — and the stale label then hid the abandoned turn. The reminder
  now also fires on the plan-review, implementer and code-review dispatches, which are the moments
  those swaps come due; and an open loop PR with commits pushed beyond its claim whose issue still
  advertises claim is a hard gap at Stop.
- **The review chain names the rule it refused on.** `artifactVersion` must strictly increase per
  round, enforced in `roundHistory` and stated in no prose. The field appeared in the skill only as
  a bare name beside `planFingerprint`, so stamping every round with the plan's version is the
  natural mistake; a live run made it, got one undifferentiated `INVALID_REVIEW_EVIDENCE`, and had
  to bisect. The rule is now documented, and each chain check names itself via `evidenceGap`.
- **Every step prints its ribbon, including no-ops.** A run printed 05/11 then 07/11: step 6 ran,
  decided no simplification was needed, and printed nothing. A missing ribbon reads as a skipped
  step.
- **Liveness is a stated rule.** A turn that has ended emits no heartbeat, so an idle turn and a
  working session are indistinguishable. The unit runs to a terminal state in-turn; the Stop hook
  is the backstop, not the plan.

## [0.42.3] - 2026-07-26

### Fixed

- **The command guard allows an interpreter version probe.** `inlineInterpreterSource` treats an
  interpreter with no script argument as reading source from stdin, which is right for a bare
  `node` and wrong for `node --version`: every argument starts with `-`, so the probe looked like
  the stdin shape. It refused `node --version`, `python3 --version`, `deno --help`, and therefore
  the whole setup audit battery, whose first line is
  `gh auth status && node --version && codex --version`. `--version` and `--help` now read as what
  they are — the interpreter prints and exits without executing anything. Long forms only, because
  `-v` is the version flag for node, ruby, php and perl but means "verbose" for python, where a
  script is still read from stdin. The test runs after the source-flag check, so
  `node --version -e '...'` still blocks on the `-e`, and a bare `node` still blocks.

## [0.42.2] - 2026-07-26

### Fixed

- **The claim commit carries its own identity.** `sanitizedEnvironment` sets
  `GIT_CONFIG_GLOBAL=/dev/null` and strips every `GIT_*` variable, so neither `~/.gitconfig` nor
  `GIT_AUTHOR_*` could reach the claim commit and a checkout without repo-local `user.*` — which is
  what a real checkout looks like — had no identity to commit under at all. A live run died with
  "Author identity unknown" at the claim step. The driver now supplies the GitHub login it already
  authenticated as, which also binds the commit to the identity the merge gate checks later. The
  path was unreachable before 0.42.1: the driver refused every non-manual policy earlier, so
  fixing that is what exposed this.
- **Dispatch no longer forces the engine's env scrub.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` was
  set on every child to satisfy the broker capability `claude.subprocess.credentials-scrubbed`,
  and the broker also swept the stub files scrub mode creates. v0.42.0 deleted the broker, the
  predicate, and the sweeper; only the costs remained. Measured: the child ignored
  `--permission-mode` so the declared postures were never applied, the checkout gained seventeen
  zero-byte stubs nobody removed, and every Bash call died at sandbox start on `/home/.mcp.json`,
  which blocked a live run at the implement step. Roles again run under the posture they declare.
- **An implement dispatch proves it moved the checkout.** `ok` from a review role means a
  schema-valid verdict; from the writer it meant only that the engine answered, so an implement
  whose sandbox never started returned `ok: true` carrying its own error as the text payload.
  Writer dispatches now fingerprint HEAD and porcelain status around the spawn and fail typed with
  `WRITER_MADE_NO_CHANGE`, preserving the engine's text as the diagnostic. A cwd that is not a Git
  work tree, or carries no commit yet, asserts nothing.

## [0.42.1] - 2026-07-26

### Changed

- Setup's WRITE phase reconciles STATE and LOOP through that merge and its report instead of
  reading the templates and splicing prose by hand.
- Setup names the copy of every contract it runs. During a migration the configuration is migrated
  and validated with `<templates>/tools/config-contract.mjs`, never the repository's vendored copy,
  which is still the pre-migration validator until the reconcile lands and rejects the migrated
  block on its version literal.

### Removed

- Tag-time live-control verification. The release gate no longer reads GitHub rulesets or the
  immutable-release setting: `release-verify.mjs` drops the `--check-tag-policy`,
  `--check-base-policy`, and `--check-immutable-releases` modes, the
  `--allow-unverified-live-controls` escape, and the `AUTOLOOP_RELEASE_POLICY_TOKEN`
  credential. Branch, tag, and release protection stay configured on GitHub as the
  maintainer's responsibility; `--release-mode` still verifies the static release contract
  and proves the annotated-tag binding from local git objects.

### Fixed

- **The lifecycle driver accepts every merge policy its contract validates.** A live run planned
  and independently reviewed an issue, then hard-stopped at the claim step because the driver
  required `intent.mergePolicy === 'manual'` on top of the contract's own validation. The
  lifecycle contract accepts `manual`, `ratified`, and `auto` and branches where it matters; the
  extra clause was a leftover from when non-manual was dormant reference code, and it refused
  the claim for every acknowledged non-manual repository — exactly the configuration solo mode
  exists to serve.
- **The command guard resolves literal expansions instead of refusing them.** Every live session
  wrote something like `S=/tmp/x; sha256sum $S/plan.md` and was refused as opaque, then retried
  with a literal path. When a variable is assigned a literal in the same command, the guard now
  substitutes it and judges the real command — strictly stronger than refusal, because
  `verb=merge; gh pr $verb 42` now blocks on the merge rule itself. Command substitution,
  environment variables, and values carrying whitespace or metacharacters stay opaque and stay
  blocked.

### Added

- **`scaffold.mjs --merge-state` / `--merge-loop`** — mechanical STATE and LOOP reconciliation.
  A v0.42.0 migration spent 203 seconds reading templates in fragments and 148 seconds splicing
  prose by hand, over half the run. Ownership is derived from the template's own
  `{{PLACEHOLDER}}` markers rather than declared: a marker's shape determines whether the
  repository owns a fence body, list additions, a whole section, or a scalar. Only Lessons is
  declared, keyed by heading, so a rename fails closed rather than replacing durable memory.
  Structural ambiguity produces a typed report and a non-zero exit, never a lossy merge.
  Verified against a real installed STATE: the three differences from the hand-merged result
  were exactly the decisions it flagged, and LOOP came out byte-identical with no decisions.

## [0.42.0] - 2026-07-26

### Removed

- The authority broker and everything built on it. `run-scope.mjs`, `runtime-contract.mjs`,
  `route-adapter-contract.mjs`, `measurement-contract.mjs`, `intent-contract.mjs`, and
  `continuation-store.mjs` are deleted, together with the closed route catalog, host attestation,
  capability probing and its bwrap smokes, dispatch plans/receipts, relaunch v2 envelopes, and the
  measurement ledger (`docs/measurement.md`,
  `.autoloop/measurement-budget-policy.json`). That machinery existed for unattended merging by
  unattributable actors across hosts; it made the loop unusable for the supervised solo operator it
  actually has. A live run spent 5.5 minutes reverse-engineering the broker envelope protocol and
  still failed closed without reaching implementation.
- The `UserPromptSubmit` / `opencode.user-prompt` intent-capture hooks and the opencode plugin's
  continuation/relaunch subsystem.
- Config keys `runtime`, `engine`, `adapterOptions`, and `measurement`.

### Added

- `dispatch.mjs`: one call runs one role dispatch and returns a typed result.
  `--role <plan-review|implement|code-review|doubt-review> --prompt-file <path> [--tools <csv>]
  [--output-file <path>] [--json]`. It spawns `claude -p` directly — a fresh process per dispatch,
  so writer and reviewer identities never collide. Reviewers get a read-only posture
  (`Glob,Grep,Read`, permission mode `plan`) that can never be handed a write tool; the writer gets
  `Bash,Edit,Glob,Grep,Read,Write` with `acceptEdits`. Review roles return the structured verdict
  schema, parsed and validated, or fail typed. Every failure is `{ok:false, step, error}` with the
  child's stderr preserved — no retries, no fallback engine — and every result reports the
  wrapper's own overhead separately from engine time.
- `checkout-contract.mjs`: the stable checkout and GitHub repository identity probe, extracted from
  the deleted route adapter, where `publish-verdict.mjs` and `lifecycle-driver.mjs` still need it.

### Changed

- `prime.mjs` is one child process: validate ProjectConfig in-process, report the checkout against
  the configured base, run one `scan.mjs`, persist the snapshot, print a decision-sized summary.
  It replaces five broker calls the model had to hand-assemble.
- `review-contract.mjs` keeps every decision — one plan review, delta-scoped rounds after round 1,
  the human-block path for verified out-of-delta Critical/Major, the cap — and takes recorded
  dispatch rounds instead of broker-signed receipts. Freshness is now structural: a unique
  `dispatchId` per round and a `reviewerIdentity` that is never the author's.
- `command-guard.mjs` scopes itself to open runs through a durable run marker `prime.mjs` writes
  and binds to the observed process ancestry, replacing the broker lease. Every guard decision is
  unchanged.
- `loop-smoke.mjs` proves the new path end to end against a shimmed engine — prime, three role
  dispatches, the gate command, the guardrail close — asserts no reviewer dispatch received a write
  tool, and prints a phase timing table. `--real-engine-smoke` now runs ONE real dispatch.
- Config schema `0.26.0`, with a `0.25.0` migration that drops the retired keys and carries every
  remaining value across unchanged, including `merge.policy` and both acknowledgements.

## [0.41.4] - 2026-07-26

### Fixed

- **The isolated posture can dispatch an engine at all.** Every route capability smoke returned
  `route-smoke-failed`, so no live run ever got past the probe. Two upstream engine behaviors,
  both found by reading the engine's own stderr out of the sandbox: Claude Code's env-scrub
  hardening silently forces `--permission-mode` back to `default` (so the writer's Write was
  denied and no proof marker appeared), and its inner sandbox needs to create mount points
  inside `.git`, which read-only Git metadata refused, failing every Bash call. Permissions are
  now derived from each posture's own tool ceiling — the reviewer grants nothing, a net
  narrowing — and read-only Git metadata is a tmpfs with real entries re-bound read-only
  underneath, with the write denials re-verified intact.
- **The engine's sandbox litter no longer reaches a commit.** Scrub mode creates ~17 zero-byte
  stubs (`.env*`, `package.json`, `yarn.lock`, …) for sensitive paths that do not exist; it
  normally hides them by appending to `.git/info/exclude`, which fails precisely because
  Autoloop mounts Git metadata read-only. Untracked litter would have stopped the next run
  through the dirty-tree rule and — since the broker commit stages `git add --all` — landed in
  the pull request. The broker now removes only what appeared during a dispatch: untracked,
  regular, zero-byte, non-symlink, and reported in the typed result. Every guard is
  mutation-proven in the self-tests.
- No error-shaped output on the happy path: typed `snapshot-contract --summary/--section`
  accessors so nothing is hand-parsed, guard refusals reworded as policy with the sanctioned
  alternative named, the capability smoke bounded at 120s per dispatch (it was 20 minutes), and
  bundle files named from the broker run identifier when measurement capture is off.

### Removed

- Tag-time live-control verification and `AUTOLOOP_RELEASE_POLICY_TOKEN`. Repository protection
  is configured on GitHub and remains the maintainer's responsibility; the release gate verifies
  the release contract — version literals, annotated-tag binding, changelog, banners, smoke
  evidence, workflow shape. −937 lines.

### Added

- `loop-smoke.mjs --real-engine-smoke`: the opt-in pre-release gate for `posture: isolated`.
  It runs the full chain with no engine shims and asserts real capabilities (11/11 on a
  bwrap-capable, authenticated host, ~40s). It costs real tokens, so it stays manual — the
  shimmed `loop-smoke` remains in every CI battery.

## [0.41.3] - 2026-07-26

### Fixed

- **The route probe works from the detached broker** — the last gate between prime and unit
  work. `issueCapabilitySnapshot` executes inside the authority broker, which re-parents to
  init, so the live-host ancestry walk found nothing and every live probe failed with
  `INVALID_CAPABILITY_ATTESTATION`; self-tests skip that branch by design and no earlier live
  run had reached the probe. The broker retains its host binding once at startup (a real walk,
  while its spawner's ancestry still proves the session; fail-closed, no fallbacks) and
  broker-side callers compare against it. Proven red first.
- Measured operations and the conclude call bind to an explicit run id from the prime summary:
  interrupted sessions leave run-start-without-run-finish ledgers, so bare exactly-one
  derivation was permanently ambiguous on any repository with history.

### Changed

- **Measurement capture is opt-in** (`measurement.capture`: default `off`, `events` restores
  full capture per repository). The pipeline enforces nothing until its producers land, while
  live runs paid 3–6 minutes of ceremony per run: with capture off, prime is attest → open →
  one plain scan, no ledger opens, commands run unmeasured, and a blocked close is only the
  finish decision.

### Added

- **`loop-smoke.mjs` — the no-model end-to-end release gate**: fixture repository → synthetic
  hook capture → real detached broker → full events-mode prime → route probe → guardrail
  close, asserting typed results, byte-complete artifacts, broker teardown, and a 60-second
  budget (measured 716ms). It runs in every verify battery, reproduces this release's probe
  bug red against the prior tree, and would have caught every live failure of the past day.

## [0.41.2] - 2026-07-26

### Fixed

- Prime returns `hostEvidence`: its internal attest consumes the one-use intent record, so the
  evidence it held was the run's only copy — the first live run blocked at the route probe
  without it. The summary and persisted bundle now carry it; the skill forbids re-attesting.
- Prime persists its full bundle and raw snapshot under `.git/autoloop/prime/` and prints a
  decision-sized summary with per-section counts: the inlined ~300KB snapshot exceeded what a
  model-facing tool result can carry, silently recreating the manual-scan ceremony.

### Changed — startup cost, round two

- `measurement-contract.mjs --measured <operationId> [--action <text>] -- <command>...` runs a
  measured operation in one invocation: the open run, active stage, and operation kind are
  derived from the store (fail-closed on ambiguity), and the assembled input reaches
  `runMeasuredOperation` unchanged — no per-command envelope files, no validation relaxations.
- `prime.mjs --conclude-json` closes a guardrail-blocked run in one call: human wait pair,
  typed-unavailable stage-end, blocked run-finish, and the finish decision, in the exact order
  live sessions performed by hand across two to three minutes.
- Scaffold audit/reconcile report entries carry a `source` field naming each artifact's exact
  template path (renames included), ending spurious hand-diff guesses.

## [0.41.1] - 2026-07-26

### Fixed

- **The loop can start again.** `scan.mjs` printed its ~313KB snapshot and exited via
  `process.exit(await main())`, which discards async-buffered stdout — and stdout is async
  whenever it is a pipe, which the required measured-operation wrapper always is. Every v0.41.0
  Dev run therefore blocked at prime step 10 on a snapshot truncated to one pipe buffer.
  `scan.mjs`, `snapshot-contract.mjs`, and `measurement-contract.mjs` now write primary output
  synchronously (EAGAIN-retrying `writeSync`); an end-to-end self-test pipes 400KB through a
  real child that exits immediately.
- The macOS CI contract job ran 2–3.5 minutes against Ubuntu's ~1: `detectActiveHost()` walks
  the ancestor process chain (`ps` spawns on macOS at ~44ms a call) and was evaluated before
  the self-test-mode short-circuit, charging all 2,304 matrix fixtures — 101 of the suite's
  106 seconds. The mode check now evaluates first; macOS runs at parity (1m04s).
- The permanent slow-suite diagnostics that found it: verify prints per-check durations and
  surfaces each self-test's family histogram and matrix-phase attribution, so the next platform
  stall names its own culprit in the CI log.

### Changed — startup cost

- **One-call prime.** `prime.mjs --dev-json {sessionId}` composes attest → open → mechanical
  measurement-declaration derivation → bind → selection stage-start → the measured startup scan
  into one deterministic invocation returning one typed bundle. It holds no broker authority —
  it issues the same public CLI commands the model previously assembled by hand across ~30
  round trips and ~4–5 minutes; non-scan prime is now ~2 seconds and a live prime is
  scan-dominated. The manual per-op path remains documented for continuations and diagnosis.
- **Release-proven verify.** Install-root verification skips re-spawning a tool's self-test
  when its bytes match the committed release manifest (template sha256 + node major, freshness-
  checked in plugin CI, vendored by scaffold): measured 23.3s → 0.7s. Any byte difference,
  missing entry, node-major mismatch, or unreadable manifest fails open to the real spawn;
  `--full` restores the entire battery; plugin templates always self-test fully.
- Setup's audit uses `scaffold.mjs --audit` — the identical typed reconciliation report with
  zero writes — replacing per-artifact manual diffing, and captures verify output once.

### Added

- One visual language across the cycle: run frame, per-step progress ribbons (eleven cells in
  Dev, eight in Pitcrew, five setup phases), rounded unit banners, and closing rails for
  shipped/blocked/complete. The tool surface is now two-tier: ~8 entry points a session
  invokes; every other vendored file is a library those entry points own.
- `adapter-contract --template-root` accepts the plugin root or the templates directory itself;
  `run-scope` usage names the `<path|->` argument on every operation flag.

## [0.41.0] - 2026-07-26

### Added

- Solo-operator merge mode for single-identity repositories, where the loop necessarily runs
  under the only maintainer's login. `merge.soloOperatorAcknowledged: true` — valid only alongside
  a non-manual policy AND `merge.unverifiedInvocationAcknowledged: true` — waives the four gate
  controls one login cannot satisfy: identity separation, App attestation, live server-policy
  verification, and the approving-review requirement (GitHub forbids self-approval). Everything
  else keeps full strength: exact-head CAS merge with SHA-bound confirmation, required CI green on
  the exact head from `.autoloop/ci-policy.json`, claim/ownership/frozen-plan binding, hard-block
  labels, protected path families, the kill switch, executor-identity matching, and Path-A label
  event verification with head binding. A solo config whose trusted list is not exactly the loop
  login is invalid, and migration never emits the flag. Non-solo behavior is byte-identical.
- Setup fills the vendored merge executor's REPO CONFIG block in the same visible diff that
  vendors it (repository, loop login, required checks from the committed CI policy, and the
  solo-operator transcription), then runs the vendored file's config-derived `--self-test` as
  evidence — a placeholder block refuses every invocation, so an unfilled vendor was an
  incomplete setup.
- `scaffold.mjs` preserves a Setup-filled `auto-merge.mjs` as `kept-modified` instead of
  clobbering it back to placeholders on reconciliation, matching the existing
  `escalate-paths.mjs` policy-preservation rule.

### Fixed

- The merge reference header no longer claims "Setup never installs or invokes this file" —
  false since the 0.40.1 acknowledgement contract — and now states the enablement conditional; a
  self-test case guards the header because contract lint deliberately skips `auto-merge.*`.
- `UNCONDITIONAL_NON_MANUAL_REFUSAL` lint now crosses single line wraps and recognizes
  unconditional `UNVERIFIABLE_INVOCATION_PROVENANCE` rejection claims that name the policy in a
  different table cell; the six stale prose sites it then surfaced in README and the STATE
  template (including two the drift audit had not listed) now state the acknowledgement
  conditional.
- `scaffold.mjs` self-test reported a hardcoded case count; it now counts.

## [0.40.5] - 2026-07-26

### Added

- `scaffold.mjs` performs the complete mechanical scaffold reconciliation in one call: it vendors
  the policy-derived tool set, refreshes host artifacts, merges hooks and `.opencode/opencode.json`
  without clobbering repository-owned entries, folds a legacy root `opencode.json` into
  `.opencode/`, and returns a typed report. Setup drops from dozens of model round trips to a
  handful. A policy-bearing tool whose repository copy differs (`escalate-paths.mjs` carrying extra
  escalate globs) is reported `kept-modified`, never overwritten.
- A contract-lint rule, `UNCONDITIONAL_NON_MANUAL_REFUSAL`: forward operational artifacts may no
  longer claim a non-manual merge policy fails outright without stating the acknowledgement
  conditional.

### Fixed

- Installed STATE prose no longer carries the plugin version. The vendored template embedded it, so
  every patch release dirtied every configured repository's STATE by one literal and forced a
  prose reconciliation per repository per release — the direct cause of a thirteen-minute setup run
  whose entire payload was a version string. STATE references the configuration schema only.
- Setup's evidence surface is now explicitly bounded: static validation and
  `verify.mjs --install-root`, never the repository gate, test suite, or CI. A live session had
  begun repairing a pre-existing failure on the configured base to "prove" a prose edit; a failing
  base is a NOTE for the human, and Setup never modifies repository source.
- Seven skill-prose sites still asserted that v0.40 forbids a non-manual merge policy, contradicting
  the 0.40.1 contract; a Setup session resolving the contradiction refused to offer the policy the
  interview was told to offer. All prose now states the conditional.
- Dev had no non-manual invocation path at all: its terminal step said "never invoke
  auto-merge.mjs" unconditionally. Under an acknowledged non-manual policy the run now invokes the
  vendored executor once for the delivered PR and treats its typed verdict as final; the executor
  independently refetches every ownership, eligibility, evidence, and server-protection predicate
  and refuses with a typed reason when any is missing, and a refusal routes to the human-block path.

## [0.40.4] - 2026-07-26

### Changed

- Setup shows the merge policy in every interview and offers to change it. The 0.40.3 question
  fired only for a repository on or migrating from a non-manual policy, so a repository whose
  earlier migration had already reset `auto` to `manual` was never asked — the trigger state had
  been erased by the very reset the question existed to surface.
- Migration and reconfigure collapse the interview to one summary table and a single accept-all
  confirmation, expanding into individual questions only where an item carries a real decision.
  Fewer questions, never fewer disclosures: everything still appears in the summary and the
  visible diff.

## [0.40.3] - 2026-07-25

### Fixed

- Vendored contract self-tests resolved reviewer templates relative to their own file, which only
  lands in the plugin tree. Once vendored to `tools/agentic/`, `verify.mjs --install-root` failed
  with `ENOENT` unless the templates were also copied loose into `tools/`. The check now applies to
  a shipped template where one exists and is skipped as not applicable where none does, so an
  installed repository needs no stray files.
- The command guard blocked every command in a repository whose configuration still awaited
  migration, including the commands Setup needed to perform it. A migratable schema now reports the
  remedy and yields.
- The command guard applied to every Bash call in a project, so ordinary development fought a policy
  aimed at loop-issued commands. It now enforces only while a run is open, evidenced by a live
  broker lease bound to the caller's own ancestry. Anything unreadable or ambiguous means no run.

### Changed

- `opencode.json` moves to `.opencode/opencode.json`, alongside the other opencode artifacts.
  opencode reads project configuration from either location, verified against 1.18.4, so the
  scaffold no longer adds a loose file to the project root. Setup merges a legacy root copy into
  `.opencode/` and removes it.
- Setup asks about the merge policy instead of silently resetting it. A repository on or migrating
  from `ratified` or `auto` is offered the restore, told in one sentence what an unauthenticated
  trigger means, and has both `merge.policy` and `merge.unverifiedInvocationAcknowledged` written
  together.
- Setup shows every numeric cap with its current value beside the scaffold default and offers to
  change any, calling out `sliceMaxLines` and `codeReviewRoundsPerUnit`. A migrated repository keeps
  its own values, so showing them is what makes a preserved value distinguishable from a silent one.

## [0.40.2] - 2026-07-25

### Added

- `migrateProjectConfig()` migrates a repository configuration from its own version to the current
  schema through an ordered chain, so callers never name a version pair. `MIGRATABLE_CONFIG_VERSIONS`
  declares what it accepts and anything else is a typed `UNSUPPORTED_CONFIG_VERSION`.
- A `0.23.0` migration step. That version predates `gate.quickCommand`,
  `caps.codeReviewRoundsPerUnit`, and the `engine.opencode` block; all three are added
  deterministically, then the existing `0.24.0` step completes the migration.

### Fixed

- A repository on schema `0.23.0` could not upgrade at all. Migration existed only as a single
  hardcoded `0.24.0` to `0.25.0` hop, named for that pair in the function and in Setup's prose, so
  any other version had nowhere to go and Runtime refused the repository outright.

## [0.40.1] - 2026-07-25

### Added

- An explicit `merge.unverifiedInvocationAcknowledged` opt-in. `ratified` and `auto` are no longer
  refused outright: a repository that sets it to `true` records that it accepts a trigger no
  supported transport can authenticate, and Runtime then opens the run. Without it, run open still
  fails closed with `UNVERIFIABLE_INVOCATION_PROVENANCE`. Findings 10 and 11 remain open, so a
  non-manual policy relies on configured base protection for its safety.

### Fixed

- Contract verification no longer depends on the checkout umask. The budget-policy reader accepted
  only modes 600/640/644, so the same commit passed under umask 022 and failed under 002 — Git does
  not track the group-write bit. It now rejects what actually matters: a world-writable policy file.
- The 0.24.0 migration no longer describes a reset merge policy as "legacy", which read as though
  `ratified` and `auto` had been retired. They are current values, and the warning now names the
  acknowledgement that restores them.

## [0.40.0] - 2026-07-25

### Added

- A deterministic runtime contract with a closed five-route catalog, capability-aware dispatch,
  typed route adapters, bounded fallback, and append-only, session-bound relaunch recovery.
- A repository project contract for configuration schema `0.25.0`, including explicit migration
  from schema `0.24.0`.
- Complete repository snapshots with bounded pagination, typed section completeness,
  mutation-driven invalidation, absence-safe stop decisions, and exact per-reference Issue-state
  evidence for dependency closure.
- Durable lifecycle reconciliation, exact-head delivery/review transitions, canonical loop-claim
  parsing, and configured-base lane proofs.
- Atomic write-once, content-fingerprinted, store-authenticated raw workflow event streams with a
  Runtime-bound pre-selection start and plan-bound unit/lane context; required benchmark-manifest
  `comparisonContextFingerprint` and stable
  `checkpointEndpointFingerprint` values; migration comparison with observed, stage-independent
  runtime identity; structured run/unit/metric/provider/value-bound `provider-unit-total`
  provenance; and an exact-replay mode/workload budget contract. Raw invocation fingerprints remain evidence
  with exact value/count distributions instead of fragmenting stable endpoint cohorts.
  Comparisons and budgets reject mixed revisions/configurations, non-completed work, unavailable
  runtime identity, and unsafe numeric magnitudes. Terminal/gate/lifecycle/provider producers and
  real legacy/safe/current cohorts remain pending, so the shipped policy is explicitly
  `pending-evidence`; historical baselines are never synthesized.
- Attributable exact-head CheckRuns, an executor-owned typed gate attestation, and a dormant,
  fail-closed strict-direct authorization reference contract for a future authenticated
  non-manual integration.
- A canonical `VERSION` file and portable release verification for manifests, skill banners,
  changelog metadata, static contract drift, and operational helper assumptions.
- Live release verification for annotated tag ancestry, no-bypass `v*` tag controls, and enabled
  immutable releases, with optional organization-owner enforcement.
- A typed `untested` live-smoke declaration. Contract and release verification both report it as a
  note and neither infers a passed route from it. v0.40.0 ships that declaration: the ten OpenCode
  live checks were not rerun against the v0.40.0 invocation contract, so native opencode and
  Claude-to-opencode are statically verified only and their live behaviour is unproven.
- Practical contribution, security-reporting, and licensing guidance.

### Changed

- Bare Dev, Pitcrew, and doctor invocations now select the active host's safe native route.
  Claude-to-Codex and Claude-to-opencode execution use an explicit current-invocation selector.
  Supported same-UID hooks preserve that selector as
  `intentProvenance: "best-effort-unverified"` and never claim authenticated human attribution.
- Setup scaffolds the safe Claude, Codex, and opencode artifacts for every configured repository;
  artifact presence no longer represents deployment or routing intent.
- Standing project configuration no longer stores `runtime.supportedHosts` or `engine.profile`.
  Tracker configuration is now a discriminated object.
- New scaffolds default to a 700-line slice cap, five code-review convergence rounds, and a
  700-line reversible Path-B limit.
- The fixed four-hour queue-run ceiling and `caps.runWallClockHours` setting are removed; queue
  runs stop on queue exhaustion, explicit invocation bounds, context handoff, or guardrail failure.
- All five routes use fresh Runtime-broker-launched Linux processes: structured Claude print mode,
  `codex exec`, or `opencode run --pure`. Native names the host/engine relationship, not an
  in-session child topology.
- Every typed writer receives writable checkout files with read-only Git metadata; the networkless
  broker makes exactly one clean direct-child commit only after accepting one complete typed
  result. Rewinds, amended history, multiple commits, and dirty completions fail.
- OpenCode writers additionally use a closed checkout-file tool allowlist. The trusted engine
  retains provider transport for inference without exposing it as a model tool.
- Authority-isolated routes require a verified Linux bubblewrap boundary with private home/IPC,
  closed selective mounts, role-scoped checkout access, and no remote Git/GitHub credentials; they
  report a typed capability failure on macOS.
- v0.40 live route execution is Linux-only. Non-Linux probes fail before issuing attempt
  challenges; macOS CI covers portable static contracts without advertising a live route.
- Measurement `run-start` is retained immediately after Runtime opens, before startup operations;
  the first exact plan later binds capability, initial route-state, unit, and lane facts.
- v0.40 Runtime accepts only manual merge. Protected-path guidance now covers both `.opencode/**`
  and `.githooks/**`.
- Schema migration resets legacy `ratified` and `auto` merge policy to manual. v0.40 rejects every
  non-manual run at open before capability probing, scratch creation, or mutation.
- Merge queue remains fail-closed in v0.40 until temporary-head verdict production and durable
  terminal recovery are implemented.

### Security

- Routing input is confined to the current invocation, preventing repository state, historical
  records, and installed artifacts from selecting an execution engine. The captured selector
  grants no lifecycle, human, merge, tag, or release authority.
- Runtime signing keys stay inside a host-bound broker. Finish revokes every run-owned capability,
  continuation validation and CAS remain broker-mediated, and acknowledged terminal delivery,
  stale-lock recovery, and host-death cleanup remove broker authority state.
- Shared claim, lifecycle, lane, verdict, and merge-authorization contracts tighten evidence and
  recovery boundaries.
- Append-only lifecycle comment chains resolve only from positive never-edited evidence. Scan,
  policy publication, the dormant merge reference contract, and the lifecycle driver derive that
  evidence from GitHub, and absent edit evidence is typed incomplete rather than assumed unedited.
  An edited root is accepted only when a successor hash-anchors its exact body.
- The command guard fails closed on malformed hook/config input, active shell expansion, inline
  interpreter source, unknown Git/GitHub aliases, protected refspecs, repository-rule mutation,
  `loop-ready` creation/application/rename, direct merge, release-tag pushes, and release
  publication.
- Exact-head delivery derives the complete required-check set from canonical tracked policy,
  rejects checkout/Git-object drift and path indirection, and protects that policy from loop merge.
- A trusted gate CheckRun can be emitted only after its publisher executes the configured command
  on the exact unchanged clean checkout.
- The dormant non-manual direct-merge reference contract re-fetches issue provenance, human label
  events, dependencies, frozen plans, executor identity, branch protection, applicable rulesets,
  and bypass actors before any SHA-bound merge authorization.

[Unreleased]: https://github.com/fabioneves/autoloop/compare/v0.42.1...HEAD
[0.42.1]: https://github.com/fabioneves/autoloop/compare/v0.42.0...v0.42.1
[0.42.0]: https://github.com/fabioneves/autoloop/compare/v0.41.4...v0.42.0
[0.41.4]: https://github.com/fabioneves/autoloop/compare/v0.41.3...v0.41.4
[0.41.3]: https://github.com/fabioneves/autoloop/compare/v0.41.2...v0.41.3
[0.41.2]: https://github.com/fabioneves/autoloop/compare/v0.41.1...v0.41.2
[0.41.1]: https://github.com/fabioneves/autoloop/compare/v0.41.0...v0.41.1
[0.41.0]: https://github.com/fabioneves/autoloop/compare/v0.40.5...v0.41.0
[0.40.5]: https://github.com/fabioneves/autoloop/compare/v0.40.4...v0.40.5
[0.40.4]: https://github.com/fabioneves/autoloop/compare/v0.40.3...v0.40.4
[0.40.3]: https://github.com/fabioneves/autoloop/compare/v0.40.2...v0.40.3
[0.40.2]: https://github.com/fabioneves/autoloop/compare/v0.40.1...v0.40.2
[0.40.1]: https://github.com/fabioneves/autoloop/compare/v0.40.0...v0.40.1
[0.40.0]: https://github.com/fabioneves/autoloop/compare/v0.39.9...v0.40.0
