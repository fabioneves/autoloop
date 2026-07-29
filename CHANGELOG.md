# Changelog

Notable changes to Autoloop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow semantic versioning.

## [0.49.33] - 2026-07-29

### Fixed

- **The panel is pruned at the park; the newest-first rewrite is dropped.** v0.49.30 asked for a
  delete-and-recreate of the completed window on EVERY step completion, so the newest finish would
  take the lowest ID and sit on top. A live run on that version did not do it, which is the answer
  to whether the cost was affordable: about ten tool calls in the same turn that collects a typed
  result, composes a subject, swaps labels and prints a ribbon — the same
  recall-plus-mechanical-work shape that made three earlier rules decay.

  The rewrite is gone. What replaces it is a prune to the four most recent completed rows at each
  park and closing rail, which fits without truncation. That buys the thing that was actually
  broken: a hidden row cannot be read at all, while an out-of-order one can, because every row
  already carries `[<elapsed>] [<HH:MM>]` and four timestamped rows order by eye. Buy the
  visibility, skip the ordering.

### Changed

- **An escalation block ships its options as instructions, not as prose.** The decision stays the
  human's — the loop still may not carve a predicate until told, because a loop that shrinks its own
  scope when work gets hard does exactly that, invisibly. What moves is the ASSEMBLY, which was
  never the human's job and which the loop already holds every input for. A live block offered three
  options in prose and left a human to derive a forty-line carve-out instruction from the round
  table, including which findings belonged to which predicate — where exactly one of five sat in the
  other predicate and had to STAY rather than carve. Get that wrong and the reduction ships a known
  unbounded enumeration under a clean-looking diff.

  Each option now arrives pre-computed: the cap option names the field, the cap and the rounds
  spent; the re-plan option names the mis-enumerated invariant and says plainly that a re-plan
  cannot resume the unit, since the marker binds `planHash` and `issueBodyHash`; the carve-out
  option groups every open finding BY PREDICATE with carve-or-stay marked, names what ships and
  what the PR body must disclaim, and states the loop's own assessment of the three honesty
  conditions with evidence. All three carry equal specificity — an option that is cheaper to accept
  because it arrived ready-to-run is a thumb on a scale that exists to guard against scope evasion —
  and the loop states a recommendation and argues it.

  Same lesson as the completed-step cost, the background gate wait and the gate-resolution check,
  with a human in the middle instead of a shell: work described in prose gets re-derived by hand,
  once, under less context than the writer had.

## [0.49.32] - 2026-07-29

### Added

- **Gate-command discoverability is a command, not a rule.** `config-contract.mjs --resolve` prints
  one PASS/FAIL line per configured gate command and exits non-zero when an executable is absent.
  It examines only the first word, resolved against PATH the way a shell would, and executes
  nothing — "is it there", never "does it work". Path-shaped names are treated as a file question,
  since `./x` and `/usr/bin/x` never consult PATH.

  It exists because v0.49.30 asked Setup to state whether each configured command resolves and gave
  it no command to do so, and a rule with no command gets re-derived as a shell line. The line the
  reader reaches for is `command -v <exe>` — which runs against the repository's OWN vendored guard,
  and during Setup that guard is the PRE-RECONCILE copy. A live audit was refused by the very file
  the reconcile was about to replace: a bootstrap no session can argue its way out of, since the
  fix it needs is the one it is installing. v0.49.31 fixed the guard; this removes the shell probe
  entirely, which is the part that stops the next such fix from having the same problem.

## [0.49.31] - 2026-07-29

### Fixed

- **`command -v <interpreter>` is a lookup, not an invocation.** A live setup lost a round to
  `command -v php` while checking whether its configured gate still resolves — the discoverability
  probe this plugin's own setup skill asks for, refused as inline interpreter source. `command` is
  a passthrough wrapper, so the name behind it sat in executable position, and with no script
  argument that is the read-from-stdin shape; `-v`/`-V` are exactly the flags that make the builtin
  describe rather than execute. `which php` and `type -p python3` were never affected, since
  neither is a wrapper and the name after them was already in argument position. `command php -r …`
  and bare `command node` still block — the wrapper launders nothing without the lookup flag.

  Recorded plainly because the plugin caused its own refusal from both ends: v0.49.30's setup skill
  asks for a gate-resolution probe, `command -v` is the portable way to write one, and v0.49.26's
  positional fix is what made the wrapper case reachable at all.

## [0.49.30] - 2026-07-28

### Changed

- **Shape sizes a unit by CASES, not lines.** One unit is one invariant whose complete case
  enumeration fits in about five cases; past that, unfinishable, more than one hard invariant, or an
  independently shippable half all mean split. Lines were the wrong measure and only looked right:
  they are countable solely after the work is done, they are language-relative, and they did not
  explain either failure — an 858-line unit blocked on ONE predicate whose domain was the unbounded
  set of stored encodings, and a 200-line unit with that invariant fails identically. Cases are
  checkable from the issue text before filing, causal rather than correlated (cases drive tests
  drive diff drive review rounds), language-neutral, and already owed by the plan, so shape asks
  upfront for what the plan must produce anyway. The ~300-line figure survives as a tripwire that
  sends the reader to the case list — the caps stay a ceiling, and a ceiling is an attractor: under
  a 700-line cap units reliably landed at 800–1000, so raising it to 1000 moves the overshoot rather
  than buying headroom. Two live runs
  shipped nothing and both blocked on the same-predicate escalation — the loop noticing an
  invariant too large to enumerate, which is a shaping failure surfacing three hours late. One unit
  ran 858 production lines across 14 files inside a 1000/20 cap and spent 4 of 6 review rounds on a
  single predicate three fixes each failed to close; another's own run concluded it should have
  been split, one half having converged cleanly. The real unit of size is the invariant, not the
  line count: a unit stating two independent invariants gets two independent chances to trip
  escalation, and the cost is multiplicative. Shape now aims at roughly a third of the caps and
  splits on any of — more than one hard invariant, an independently shippable half, or an invariant
  quantified over an open-ended domain — proposing the split concretely rather than advising one.

### Added

- **The dispatch result's payload field is documented per role.** The skill named `.plan.body` once
  and never said where a verdict or a writer's text lands, so a live run spent three calls probing
  `jq -r '.text // .result // .finalMessage'` for a review result that was under `.verdict` — a
  guess sequence that cannot succeed, since none of those names exists on a verdict. There are
  exactly three payload fields, one per role shape: `.plan`, `.verdict`, `.text`.
- **Shaping predictions and unit outcomes are recorded as typed markers.** Shape ends every issue
  body with `<!-- autoloop-shape-v1 {"cases":…,"invariants":…} -->` and the loop ends every run
  record with `<!-- autoloop-outcome-v1 {"issue":…,"codeRounds":…,"escalated":…} -->`. Neither adds
  information — both restate what the prose already says — but prose is authored fresh each run and
  cannot be queried across units, so today the numbers are readable and uncountable, and the sizing
  rule above can only ever be argued rather than measured. The pair is what makes "do five-case
  units really converge faster than nine-case ones" an answerable question. Both live on the issue
  rather than in `.git/autoloop/`, because the dispatch log is per-checkout and machine-local and a
  rule calibrated on one laptop's history is not calibrated. Outcomes are emitted for blocked and
  deferred units too: a unit that cost four rounds and shipped nothing is the most informative row
  there is. Both are composed by `sizing-contract.mjs` rather than hand-written — a format recalled
  under load decays, and a field that drifts across runs makes the whole series unqueryable, so the
  tool validates and refuses rather than emitting a broken record. Two records in one body are a
  conflict, not a last-write-wins. Instrumentation only — nothing reads them yet, and a handful of
  units is not a sample.
- **A clean sweep is celebrated, and only a clean sweep.** A unit reaching `delivered` earns a `🎉`
  on its SHIPPED rail, and a run whose every unit shipped — nothing blocked, deferred, or waiting
  on a human — closes with a flourish instead of the plain rail. One blocked unit and the run gets
  the plain form with `🏁`, no confetti and no stars: a run that ends with a human gated out is not
  a clean sweep, and saying so beside a celebration would teach the reader to skim both. This is
  the `⚠️`-on-every-review lesson applied before the mark exists rather than after it stops being
  read. The run's close now bookends the `┏━━ ∞ RUN OPEN` frame in the same open-right shape, so a
  scrollback shows both ends of a run at a glance — ragged-right and padded by nothing, so no
  terminal can misalign it.

### Fixed

- **A rebased claim branch can no longer wedge a merged unit.** `#149` shipped and PR `#238` merged,
  but its terminal backfill was refused `ARTIFACT_IDENTITY_MISMATCH(local-claim)` on every attempt,
  leaving a permanent `draft-pr` marker on a closed unit. The branch had been rebased after the
  claim — which rewrites every OID on it, the claim commit included — so the marker held the
  original while the surviving local branch carried the rewrite. Once a PR is merged the local
  branch is leftover history, not evidence: the merge commit on the base is the proof. The
  absent-and-merged case was already handled; presence was the gap. Live units keep the full
  comparison, which is where it does its job.
- **Policy is read from the configured base, never the working tree.** A unit branch that forked
  days ago carries a fossilized `STATE.md`, and a stale cap reads exactly like a real one: a live
  review raised a Critical for a 700-line slice-cap breach that did not exist — 700 was the unit
  branch's value, the base had since raised it to 1000 — and closing it cost a review round plus a
  rebuttal. This is the third instance of one trap, after `tools/agentic/**` running from the
  branch it forked with and a planner reading base premises from its launch checkout, so it is now
  stated once as a rule: anything governing the run comes from `origin/<base>`; only the unit's own
  code comes from the unit's tree.
- **Simplify never falls back onto the writer's model.** Step 06 is pinned to `fable` precisely so
  a fresh model reads what `opus` wrote, and the usage-limit fallback sent it to `opus` — satisfying
  the retry while destroying the decorrelation the step exists for. It now falls back to a
  non-implementer model, and skips rather than running decorrelated-in-name-only: not running a
  clarity pass costs clarity, running a fake one costs the guarantee.
- **Pitcrew reports a pre-publish marker instead of claiming it.** A PR sitting at `draft-pr` with a
  red check was claimed, correctly diagnosed as a flake outside the diff, and then could not be
  acted on — `beginLifecycleRevision` enters at `premerge-record`, so a unit that never got that far
  has an unfinished Dev run rather than a revision. Both ends of the phase range now behave the
  same way: the marker phase names the owner, and Pitcrew owns only the middle.
- **Overlap accounting measures THIS run, not the last prime.** A live five-hour run reported
  `dispatches 8 · concurrent 0s` while its dispatch log held 57 entries and four genuinely
  concurrent pairs; the run recorded it as a possible tool gap rather than correcting it by hand,
  which is how it got found. Run markers accumulate — one per prime, never pruned, 27 in that
  checkout — and the window boundary was `Math.max` over all their mtimes, so it anchored to the
  most recent PRIME and discarded every dispatch issued before it. The boundary is now the marker
  naming a live PID in this process's ancestry, the same evidence `command-guard.mjs` uses to
  decide a run is open; a marker whose orchestrator has exited cannot be this run, and an
  unresolvable ancestry means no boundary rather than a wrong one. Measured against the same log,
  the corrected report reads `dispatches 57 · wall 564m · concurrent 93m`. The accounting that
  exists to make overlap a measurement instead of a claim was itself unmeasured.
- **Completed panel rows read newest-first.** The panel groups by status and orders within a group
  by task ID, which is assigned at creation and never changes — no task field sets position. Left
  alone, completed rows sit oldest-first and the panel truncates the tail, so the rows it hides are
  always the most recent ones. A live 16-row panel hid eleven completed rows, every one of them
  newer than the three shown, which is exactly backwards for a reader asking what just finished.
  Completing a step now keeps a bounded window of the five most recent completed rows and
  delete-and-recreates the ones older than it, so their IDs land above and the just-completed row
  sits directly under the in-progress spinners. A pruned row loses convenience, not evidence:
  `stats.mjs` derives step timings from the label timeline, so the durable record is GitHub's — a
  correction to this skill's own claim that the panel was the only place those numbers survived.

## [0.49.29] - 2026-07-28

### Fixed

- **The dispatch ceiling is per posture; a flat one killed a working writer.** A writer grinding a
  Go slice was killed at the flat 30-minute bound mid-task, its tokens spent and unrecoverable.
  The constant carried its own falsified assumption — "the longest observed healthy implement
  dispatch is minutes, and a run that needs more than half an hour has a different problem" — and
  a writer that had landed two commits is not a different problem. Raising it globally would have
  bought that back by making every wedged reviewer cost four times as much to notice, so the bound
  is now per posture: a writer grinds against the slice caps rather than the clock and gets 120
  minutes; a reviewer returns one typed verdict, the longest healthy one observed being a
  13-minute codex review, and gets 45. An unknown role gets the tighter one, never the writer
  budget. The typed timeout names which ceiling fired and warns against a blind retry, because a
  killed writer may have committed real work first.
- **A writer commits per plan task, not once at the end.** The implement step asked for
  "conventional commit", singular, so a writer committing incrementally was luck rather than
  instruction — and that luck is the only reason the timeout above cost a tail instead of
  everything, since the writer happened to have committed eight times. A commit is the only part
  of a writer's work that outlives the writer. Committing per task turns that into a floor at no
  cost: the plan already enumerates the tasks and TDD already makes each green before the next. It
  is also what makes a timeout reconcilable by inspecting the branch instead of retrying blindly.
- **The park push is not step 10.** A run parked at step 5 with eight local commits, reasoning
  "the push happens at step 10, per the flow" — the same failure as the four-commit incident the
  liveness rule already records, re-derived from the step list instead of from the rule. The loop
  branch exists on the remote from the claim, so pushing while parked updates a draft nobody is
  reading and pre-empts nothing; step 10 VERIFIES and binds a pushed head, which is a different act
  from getting the bytes off the machine.
- **A step is announced once, by its ribbon.** A live run followed its SIMPLIFY ribbon with an
  improvised `▶ #123 · step 6/11 — SIMPLIFY (fresh simplifier, FABLE)`, repeating the issue,
  counter, step name and executor while telling the reader nothing new — and overloading `▶️`,
  which already means resumed-from-a-wait in the closed badge vocabulary.
- **The planner is handed the base as files, never as a command it cannot run.** The `plan` role's
  posture is `Glob,Grep,Read` with no Bash, so the prompt's `git show origin/<base>:<path>` was not
  a slow instruction but an impossible one — and a planner given it reads the working tree instead,
  which during staged planning is checked out on the WORKED unit's branch. A live plan for `#124`
  verified every base premise against `#123`'s branch; it disclosed this and marked the premises
  affected, and only the reviewer's `premise-committed-base-unverified` finding caught it. The base
  is now materialized with `git worktree add --detach <scratchpad>/base origin/<base>` and named in
  the prompt, so ordinary reads are reads of the base; the plan reviewer and the plan revision get
  the same directory, since they check the same premises under the same posture. The general rule:
  a read-only role reads the working tree it is launched in, so either that tree is what you want
  read or you give it a materialized copy that is — never a command it cannot run.
- **The run row survives housekeeping.** A live panel lost the `∞ autoloop — <phase>` row
  mid-flight and showed two dispatch rows with nothing saying the run was alive or what phase it
  was in — the exact failure that row exists to prevent, reached by tidying instead of by silence.
  It is the one deliberately long-lived entry in a panel of short-lived ones, which makes it the
  row most likely to be mistaken for a leftover: hosts nudge toward pruning stale task lists, and a
  row in-progress for an hour looks like what that nudge describes. Its longevity is its function.
  It is now never completed, deleted or tidied before the closing rail, and a phase retitle that
  finds no row creates one instead of skipping.
- **Dispositions are recorded in the ledger, not recited in chat.** A live plan review printed a
  wide table of eighteen findings, fourteen of them "fix — carried verbatim". The ledger passed
  forward in `priorFindings` is the record and the only one with authority; a disposition string in
  chat has none. Every Critical/Major is still dispositioned — what the run says out loud is the
  verdict, the severity counts, and a line per finding that is NOT a plain fix, each with the
  evidence that decided it. Judgment is the one thing a reader cannot reconstruct from the ledger;
  "fix as written" is fully reconstructible, and the revision prompt carries it verbatim anyway.
- **The inline-awk refusal names the plainer spelling first.** Blocked pulling a number out of
  `git diff --stat`, it offered only "put the program in a file and run `awk -f <file>`" — more
  ceremony than the measurement. It now names `git diff --shortstat`, `wc -l`, `cut -f<n>` and
  `sort | uniq -c` before the file form, the lesson the fanout remedy already learned.

## [0.49.28] - 2026-07-28

### Fixed

- **Reconfigure asks about the gate, the one value that can rot.** Setup already listed the gate
  among its questions, but the interview scaling expanded an item into its own question only for
  drift, caps, or the merge policy — so on migration and reconfigure, which is what an existing
  repository runs, the gate collapsed into the summary table and was carried forward without
  anyone being asked again. That is the mode where it matters most: the gate decides whether code
  ships, and it is the only setting whose value is an executable that can rot WITHOUT changing —
  a script the repository deleted, a compose service renamed, a package script moved. A cap
  preserved across a migration is merely unexamined; a gate command preserved across a migration
  can point at nothing, and the run finds out at step 09 on an artifact already planned,
  implemented, simplified and review-converged. The interview now also states whether each
  configured command resolves, reusing the discoverability check Doctor already runs, and reports
  rather than repairs.
- **A refusal names its tokens as English.** A live refusal read
  `` `$p`, a command substitution cannot be resolved statically `` — a comma splice that parses as
  one garbled subject and hides that two separate things need fixing. Named tokens now join with
  `and`, and an over-long list states its remainder (`and 2 more unresolved tokens`) instead of
  truncating at three in silence, which sent the reader back for a second refusal having already
  fixed everything the first one mentioned.
- **A background gate is awaited, not slept on.** The gate step said a long gate "runs in the
  background with a monitor on the log's tail" and never named the command, while dispatch waits
  get a concrete typed tool. Given a description instead of a shape, a live run composed
  `sleep 45; tail -30 <log>` — which the host blocks outright — and spent the round learning a rule
  instead of gating. The step now names the facility (`run_in_background` on Claude Code, which
  re-invokes the turn on exit with the status), says to park with the gate as a branch, and names
  the Monitor `until` loop for the case where something genuinely must be polled. A backgrounded
  gate feels like something to check on when it is something to be told about — the same mistake as
  watching a dispatch instead of parking on its result file.
- **The parked header stops depending on a glyph width nobody agrees on.** Two attempts tuned the
  space between `🅿️` and `∞`: one space fused them into `🅿️∞`, two rendered as a wide gap on some
  surfaces and no gap at all on others — in the same environment, on the same day. A glyph whose
  advance width is not agreed on cannot be padded correctly, because there is no correct number;
  every value is right somewhere and wrong somewhere else, so each fix moves the breakage instead
  of removing it. The `∞` leaves the header, the badge is followed only by the decorative dotted
  rule, and the glyph rule now states the stronger conclusion: put nothing beside an unstable
  glyph rather than choosing a width for it.
- **The scratchpad is a write target, never a working directory.** A live run composed
  `cd <scratchpad> && gh pr view 238 …` and lost a round to `not a git repository`: `gh` infers the
  repository from the checkout it stands in, and the redirect had already truncated its output file
  before the failure, leaving a zero-byte result that looks real. The skill taught this exact
  lesson scoped to the lifecycle driver alone; it is now one general rule under Context economy
  covering `git`, `gh`, the driver and the gate alike. The shape is tempting precisely BECAUSE
  those rules send bulky artifacts to the scratchpad — the destination looks like somewhere to go,
  when it is only somewhere to write.

## [0.49.27] - 2026-07-28

### Fixed

- **A review with findings is roadworks, not a warning.** The badge table put "an open Major"
  under the needs-a-human badge, so every review returning `fail` badged itself as a cry for help —
  four times a unit on a run that needed no help at all, because the loop dispositions every
  finding and fixes them in its own rounds. A badge that fires when nothing is wanted stops being
  read on the run where something is: the reader has been trained that it means carry on. `🚧` now
  carries "findings to work through", `⚠️` means stop-and-ask and nothing else, and badges gain an
  explicit precedence (`⚠️` › `❌` › `🚧` › `⏳`) because a round carrying open findings could
  honestly have claimed two of them. Pitcrew takes the same split and needed it more — servicing
  findings is its ordinary state, so it was the surface warning most often about the least.
- **A retired artifact reports its absence instead of inviting a probe.** `.autoloop/ci-policy.json`
  has been retired since v0.49.0, and the reconcile report named it only when it removed one. A
  live session could not tell that silence from an unperformed check, so it probed with
  `ls .autoloop/ci-policy.json` — where the PASSING result prints `No such file or directory` and
  reads as an error. The report now states the outcome either way (`removed` or `absent`), matching
  the `identical` rows it already carries for files it changed nothing about, and the setup skill
  says to read the typed report rather than re-derive it in the shell.

### Changed

- **The run frame and the parked wait are drawn, not narrated.** The run frame opened the whole
  session as a bare one-liner while a unit got a box and a close got a rail — the outermost thing
  in the run ranked lowest on the screen. It is now an open-right block (`┏━━ ∞ RUN OPEN · HH:MM`)
  whose rows cannot misalign, because a closed box must pad every row to one width across a
  changing queue count and a varying model name, and a frame that draws wrong is worse than no
  frame. It carries no wordmark: the skill's first output already draws `AUTOLOOP`, and a second
  mark in a different letterform would make one product look like two. The review engine moves from
  an appended banner fragment to its own row. The parked heartbeat becomes a titled block with one
  `├` per thing in flight, drops the `[HH:MM][#N]` prefix because a park routinely spans units —
  each branch leads with the `#N` that is actually true — and aligns flush at column zero, clear of
  a variation-selector badge whose width no two terminals agree on.

## [0.49.26] - 2026-07-28

### Fixed

- **The plan stays on the host model.** The review-engine recording was keyed to the reviewer
  POSTURE, and `plan` shares that posture for its read-only sandbox while being authored work — so
  a recorded `claude gpt-5.6-sol @<proxy> !xhigh` fed its model, proxy URL and effort to the
  PLANNER. The skill's `--model fable` pin did not save it: a pin sets a model NAME while the
  injected `ANTHROPIC_BASE_URL` made the review proxy resolve it, so planning silently ran on the
  reviewer's model — the exact decorrelation the loop exists to preserve, inverted. Routing now
  keys on the verdict RESULT: only `plan-review`, `code-review` and `doubt-review` read the
  recording, `plan` and `implement` stay on the host engine, model, proxy and effort, and codex
  refuses to author a plan as it already refuses to implement.
- **A tool name in argument position is data, not an invocation.** `git log --oneline | grep node`
  was refused as inline interpreter source, and `git log --grep xargs` as inline command assembly —
  plain read-only history queries denied for naming a tool, because detection searched the whole
  segment while the `git`/`gh` rules had judged by position for versions. Interpreter and assembler
  detection is now positional too. Closing that opened a laundering gap one word wide
  (`time xargs -n1 gh`), so the passthrough-wrapper set grew — `time`, `exec`, `sudo`, `doas`,
  `setsid`, `stdbuf`, `ionice` — and `find -exec`/`-execdir`/`-ok`/`-okdir` are understood to
  forward execution. Old was diffed against new across every affected shape: three cases flip to
  allow and nothing that previously denied escapes.

### Added

- **A completed step composes its cost instead of remembering it.** The panel rule shipped in
  v0.49.21 as prose and live runs kept shipping bare rows (`∞ #123 — 02 PLAN [OPUS]`) with no
  `[elapsed] [HH:MM]`. The rule was never the problem: obeying it asked for millisecond division
  and a clock read in the same turn as collecting a typed result, disposing findings and swapping
  labels, and recall-plus-arithmetic under load is the shape that decays. `step-subject.mjs` turns
  the numbers the loop already holds into a command — elapsed formatted, clock read, executor slot
  upper-cased, composition idempotent so a resumed unit cannot grow a second pair of brackets.
  Sub-minute steps round up to `1min`, because a cost profile must never report a step as free.
  Colour stays the host's: a task subject is plain text and no ANSI escape survives a markdown
  renderer, so CAPS is the whole highlight mechanism the panel affords.

## [0.49.25] - 2026-07-28

### Fixed

- **The label refusal names the working command.** Seventeen loop runs in one day walked the same
  dead end: apply `human:authorize` with `gh pr edit` (allowed — but it fails on hosts whose gh
  still queries deprecated Projects-classic cards), fall back to raw `gh api …/issues/<n>/labels`
  (guard-denied), and only then rediscover `gh issue edit <n> --add-label`, which works on PRs and
  never touches project cards. The deny reason said "use a canonical gh issue command" without
  naming one — the same outcome-without-command gap as 0.49.22's expansion refusal. The refusal now
  names the vehicle, the corpus pins `gh issue/pr edit … --add-label human:authorize` as allowed,
  and the dev skill and STATE template prescribe the command where `human:authorize` self-apply is
  described.

## [0.49.24] - 2026-07-28

### Fixed

- **`--sort-versions` takes the basename of path lines instead of silently dropping them.** Two
  live setups lost their first command to `ls -d <cache>/*/ | xargs -n1 basename` — refused for the
  `xargs` — while the skill insisted there was "nothing to pre-clean". There was: a full-path line
  (`/…/autoloop/0.49.16/`) was silently dropped, so the basename instinct was answering a **real**
  hazard the prose denied, with the one vehicle the guard refuses. Tolerance now lives in the tool,
  where it holds for every composition, instead of in prose that has to win an argument with a
  model's correct intuition.
- **The setup skill shows the whole pipeline, not half of it.** The version-currency block showed
  only the `--sort-versions | tail -3` end and left the `ls` half to be composed — the same
  outcome-without-command gap as the proxy probe (0.49.22) and the exit-3 merge contract (0.49.17).
  It is now one complete literal: `ls <cache> | node <templates>/tools/release-verify.mjs
  --sort-versions | tail -3`, with `xargs` named as the decoration that has now cost two setups
  their first command.

## [0.49.23] - 2026-07-28

### Added

- **Context economy: the window is a budget, spent like the caps.** The run closes on "context
  budget spent", so every avoidable byte in the window is a unit not worked. Four rules in the dev
  skill, none trading away evidence:
  - **Bulky artifacts move file-to-file; the context sees hashes and verdicts.** A plan body is up
    to 64 KB and must be handled byte-exactly — so reading it into the window is not just costly
    but *useless*: the orchestrator can never act on a paraphrase. `jq -j` to a file, `--body-file`
    to post, the portable fingerprint helper to verify; the window needs the title, the hash, and
    the verdict.
  - **Bounded reads only**: field projections on typed results, `tail -20` on logs, never an
    unbounded read of anything a dispatch produced.
  - **Narration is the delta**: ribbons, the task panel and the digest carry run state; prose says
    what changed and what needs the human, and never re-describes a typed result just collected.
  - **After compaction, byte-exact values are re-fetched, never recalled.** A summary paraphrasing
    a SHA or planHash is the trailing-newline bug in a new coat. Prefer unit-boundary handoff over
    mid-unit compaction — a terminal unit resumes from its marker with no context at all.

## [0.49.22] - 2026-07-28

### Fixed

- **An expansion refusal names the token that blocked and the remedy for its shape, instead of
  warning about a hazard that isn't there.** A read-only `for s in …; do sed …; done` byte count was
  refused with *"can hide a mutation. Use literal canonical commands; split discovery and mutation
  into separate tool calls"* — there was no mutation, and the loop variable that actually defeated
  resolution went unmentioned. Wrong advice is worse than generic advice, because the reader fixes
  the half the message names. Each shape now answers for itself:
  - a loop variable → names it, and says to write the iterations as literal commands or move the
    loop into a reviewed program file;
  - `$?` → says an exit status **has no literal form**, so the "assign it in the same command" path
    is impossible, and points at the two places the outcome already exists: the tool runner's own
    report of a non-zero exit, and `ok: false` in the typed tool's output;
  - a bare variable or command substitution → names it and points at the substitution path that
    does work (assign a literal in the SAME command and the guard judges the real thing).

  The blocks themselves are unchanged and all correct — a loop variable genuinely cannot be resolved
  statically. Three message checks and a corpus case pin the remedies, and one check asserts the old
  "hide a mutation" text never comes back on a loop.
- **The proxy preflight gives the command, not just the outcome.** The skill said to probe "the
  recorded URL" without showing how, so a run read the URL back out of `.git/autoloop/review-engine`
  with a command substitution — which the guard refuses, correctly, since it cannot see which host
  would be contacted. The URL is a literal the run chose one command earlier: the recording exists
  for `dispatch.mjs`, which reads the file itself, while the probe is for the run, which already
  knows the value. Same shape as the exit-3 merge contract fixed in 0.49.17 — an outcome described
  without an executable command is an invitation to improvise into a refusal.

## [0.49.21] - 2026-07-28

### Fixed

- **A quoted heredoc body no longer defeats the expansion resolver, so the loop can write its own
  commit messages again.** `<<'EOF'` has a literal body — the shell expands nothing inside it — and
  the guard's *detector* was taught that (`stripQuotedHeredocBodies`) after a commit message
  carrying backticks was refused as command substitution. The *resolver* was not. So
  `SP=/tmp/…` + `cat > $SP/commit-msg.txt <<'EOF'` resolved fine until the message itself mentioned
  `$?` or `$(git rev-parse HEAD)`, at which point the resolver read prose as live source, returned
  null, and the whole command was refused as opaque. Commit messages describing shell work are
  exactly the ones that mention shell — every message written today about the `$?` fix would have
  tripped it. Resolvability is now judged on the same stripped text the detector judges. Two corpus
  cases pin it, including the negative: an expansion with no literal assignment in the same command
  stays refused.

- **A plan is no longer discarded over a character in its title, and the refusal says which
  character.** `INVALID_PLAN_RESULT` reported "structured output is not a valid plan" — a boolean
  validator behind a categorical message — and a live run spent ~40 minutes of `OPUS` re-planning
  before finding that an em-dash in the *title* was the whole fault. A model writing in this
  repository's own prose style hits the ASCII rule naturally. Refusals now name the field, the
  reason, and for a title the exact character and codepoint (`replace "—" (U+2014)`). The policy was
  also inverted: the ASCII rule exists because the ORCHESTRATOR composes titles from a safe
  allowlist while the body is the model's work, so a non-ASCII title now returns the new
  `INVALID_PLAN_TITLE` with the sound artifact under `rejectedPlan` — retitle and proceed, never
  re-dispatch. Throwing away a 48 KB body to protect a field the caller was going to author anyway
  had it backwards.

### Changed

- **Every model name is UPPER-CASE everywhere it appears** — executor slots, parked lines,
  collection lines, task subjects, `activeForm`, digest: `OPUS`, `FABLE`, `SONNET`, `GPT-5.6-SOL`.
  Who judged or wrote is the fact an operator scans for, and one casing rule makes it findable in a
  wall of lower-case prose. Outside fenced ribbon blocks the name is a code span so the host renders
  it distinctly. Colour stays the host's choice — no ANSI escape survives a markdown renderer, so
  CAPS plus a code span is the whole mechanism.
- **A completed step keeps its cost in the task subject**: `∞ #123 — 03 PLAN-REVIEW [GPT-5.6-SOL]
  [11min] [14:35]`. The panel is the only place a finished step's numbers survive — the collection
  line that stated them scrolls away, and the closing rail carries the unit total, not the per-step
  breakdown. Read down the rows and you have a cost profile: which step ate the run, and whether a
  model was slow or merely queued.

## [0.49.20] - 2026-07-28

### Changed

- **Slice budgets NOTE an overage; they never block a unit.** A live unit sat at 722 lines against a
  700-line budget with both suites green, committed and pushed, one decision short of shipping. The
  human raised the cap — which is the only answer that block can ever produce, because by the time
  lines are countable the work is done, the budget knows nothing it did not know at shaping time,
  and the answer is "merge it anyway" every time. **A cap whose verdict is always the same is not a
  gate**, it is a human decision spent per unit for no information. `caps.sliceMaxLines` and
  `caps.sliceMaxFiles` stay exactly where they pay off — `autoloop:shape` sizing issues before the
  queue — and a finished over-budget slice now states the overage in its pull-request body
  (`slice: 722 lines vs 700 budget`) and goes ready. Shaving code to clear a count is explicitly
  forbidden: a diff edited to satisfy a number is worse than an honest overage.
- **`autoloop:shape` says that its sizing is the only sizing.** Its intro promised an oversized unit
  would "blow the slice cap mid-build", which is no longer true and was the weaker claim anyway. The
  real consequence of filing an oversized unit is a pull request reviewed at a size where
  cross-model review thins out silently — nothing downstream catches it.

## [0.49.19] - 2026-07-28

### Fixed

- **The lessons curation budget was orphaned by its own migration.** `docs/agentic/LESSONS.md`
  reached 8010 bytes with nothing reporting it, while ARCH's budget worked fine. The rule existed —
  as dev-skill prose naming "STATE Lessons over 3000 bytes", a section the v0.49.14 STATE diet had
  moved into its own file. It pointed at nothing, so it silently never fired: a migration
  retargeted the document and left its maintenance rule behind. Both budgets now live in
  `scaffold.mjs --reconcile`/`--audit`, which names the file, its size, and the curation rule in
  its warnings, so the check fires whether or not a session remembers the rule.
- **STATE stops implying the loop enforces slice size.** It described all five caps with one
  sentence — "at a cap it blocks that unit and takes the next one" — which is true of
  `gateRetriesPerUnit`, `codeReviewRoundsPerUnit` and `reviseRoundsPerPr`, and false of
  `sliceMaxLines` and `sliceMaxFiles`. Those two are shaping budgets: `autoloop:shape` sizes issues
  against them while decomposing a spec, and `autoloop:dev` never re-checks size, so an oversized
  issue that reached the queue is not refused at selection — it is discovered mid-build. A reader
  who believed the loop guarded slice size had no reason to look for the real guard, which runs
  before the queue and is human-invoked. The two kinds are now stated separately.
- **LESSONS is budgeted at 6000 bytes, tighter than ARCH's 8000, on purpose.** ARCH maps a whole
  codebase and grows with it. LESSONS is supposed to *shrink*: its own pruning rule retires any
  lesson a guard, contract, or hook has since come to enforce. v0.49.18 is exactly that case — the
  command-guard change turned "name the remedy, not the category" from a lesson into a mechanism,
  so any entry about vague guard refusals is now deletable. A lessons file that only grows stops
  being read, and an unread lesson prevents nothing.

## [0.49.18] - 2026-07-28

### Changed

- **The task panel drops the per-unit umbrella row and gains a run row that names the phase.** The
  umbrella carried the issue title, but it duplicated the `∞ #<N> — ` prefix its own step rows
  already showed, doubled every unit's row count in a narrow panel, and — in-progress from
  selection to close — never changed. It also had to be created at a moment nothing else depended
  on, so a live run shipped `#82` with a step row and no umbrella while `#87` had both;
  half-mirrored reads worse than not mirroring. In its place, one `∞ autoloop — <phase>` row
  retitled at each phase change (`selecting`, `syncing base`, `parked on 2 dispatches`,
  `draining queue`, `posting digest`). It covers the case the umbrella never did: the panel going
  empty *between* units, which is exactly when a live run looks stopped, since no dispatch is
  producing output either. The changing subject is the whole point — a row that reads the same
  from start to finish asserts only that something is running.

### Fixed

- **A guard refusal names the command to run instead, not just the category it caught.** A live
  session was refused for `ls -d … | xargs -n1 basename` — a plain directory listing — and the
  advice, "use literal canonical commands, a reviewed program file, or the typed tool commands",
  never said which literal command that was. It then ran the plain listing anyway, a round later.
  The block itself is correct and stays: `xargs` builds commands out of data the guard cannot read.
  What changed is that the refusal now names the remedy for the shape it actually caught — `ls -1
  <dir>` to list, a reviewed program file to act on each entry, `awk -f <file>` for inline `awk`
  program text. The message policy already demanded a closing sentence naming the sanctioned
  alternative; generic prose satisfied it on shape while naming nothing, so the self-test now
  checks that distinct shapes give distinct, concrete remedies.

- **The driver already reports merge state; nothing said to stop hand-querying it.** A session lost
  a round to `gh pr view --json merged`, which is not a field — `merged` is real in the REST
  representation and in GraphQL, but `gh pr view --json` spells it `mergedAt`. Three surfaces, two
  of which have it. The dev skill now says to read the driver's reconcile output, which reports
  `phase`, `merged` and the merge commit from the same live facts it acts on, and names the gh-side
  spellings for the cases that genuinely need them.

  This is the third instance today of one disease — `ARTIFACT_IDENTITY_MISMATCH(merge)`, the
  exit-3 merge contract, and now the guard: **a typed refusal that names only its category makes
  the reader reverse-engineer the tool.** Every one of them cost a live session a round or an hour.

## [0.49.17] - 2026-07-28

### Fixed

- **The merge outcome is readable without the idiom the guard forbids.** Setup documented its
  merge outcome as "exit 3", and the guard blocks `$?` as an active shell expansion — correctly,
  since it cannot judge a command whose text depends on state it cannot read. So every setup ran
  the documented command, lost a round to a refusal, and then read the report anyway. The contract
  was never exit-only: `mergeMain` returns `report.ok ? 0 : 3`, so the same fact sits in the report
  beside the `ambiguities` list that says what to fix. Nothing pointed at it, and the default mode
  splits the report to stderr and the document to stdout, which is what makes the outcome look
  unreachable once stdout is redirected. A tool contract expressed only as an exit code, under a
  guard that forbids reading exit codes, is a defect in the pair rather than in either half.
- **Shipped as its own version, because the cache is keyed by one.** The fix above merged to `main`
  without a version bump, leaving `main` claiming `0.49.16` while the `v0.49.16` tag pointed at an
  earlier commit — and since the plugin cache is keyed by version, a reinstall would have reused
  the stale build and silently delivered none of it.

## [0.49.16] - 2026-07-28

### Changed

- **The loop never presents a menu.** v0.49.12 removed the question-and-wait from every *gate*,
  but a live run hit a case no rule named — an unexplained `ARTIFACT_IDENTITY_MISMATCH` on a unit
  that was already merged and delivered — and fell back to asking, leaving three eligible issues
  idle over a missing bookkeeping comment. The rule is now general and covers novel situations
  explicitly: no "how should I proceed?", no options A/B/C, no "shall I continue?". Take the most
  conservative action that keeps the run moving — label the affected unit, record the evidence
  verbatim, continue with the rest of the queue — and put the decision and its reasoning in the
  run record, which is where the operator reviews and reverses it. An unattended run is unattended
  at the moment it would ask, so a question is a stop with extra words.
- **A mismatched marker blocks its own unit, never the run.** And a marker whose unit is already
  terminal — issue closed, pull request merged — blocks nothing at all: it cannot be duplicated,
  abandoned, or re-run, so it is a defect report and the queue is untouched.

### Fixed

- **`ARTIFACT_IDENTITY_MISMATCH` names the predicate that fired, not just the artifact.** A live
  run met `ARTIFACT_IDENTITY_MISMATCH(merge)` on a unit whose every observable merge fact was
  consistent — single pull request on the branch, marker head equal to the pull request head, a
  valid merge commit, no terminal record yet — and could not tell which of four merge predicates
  had refused without reading `lifecycle-contract.mjs`. Each now reports what it compared and both
  values (`merged head vs marker head: observed 37d4ff0e45d8… · expected d00a9fbb6c20…`), and the
  fourth, which requires an UNMERGED pull request, says so in words rather than presenting as an
  identity mismatch. Same disease as the reconcile-request and terminal-state refusals fixed
  earlier today: a typed refusal that names only its category makes the operator reverse-engineer
  the tool.
- **The merge commit is read from GraphQL, and the wedge it caused is cleared.** Naming the
  predicate immediately exposed the real defect behind every `ARTIFACT_IDENTITY_MISMATCH(merge)`:
  REST API version `2026-03-10` removed `merge_commit_sha` from *both* the list and the single
  pull-request representation, so `lifecycle-driver.mjs` read `undefined` and the contract
  correctly refused a merge fact it could not verify. The contract was right the whole time; the
  facts handed to it were incomplete. GraphQL still exposes `mergeCommit.oid` — the same fact from
  the same source of truth — so the driver reads it there. Every already-merged unit stuck this way
  reconciles to `terminal-record` on its next pass.

### Added

- **A live API-shape check on the release train.** No fixture could have caught the field removal
  above: a fixture encodes what we *believe* the API returns, so it agrees with the code and both
  are wrong together. `api-shape.mjs` probes the pinned API version for every field these tools
  actually read, names the tool that reads each one, and fails with the field, the surface and the
  version when one disappears. It runs on tags, where a network call is affordable.
- **An incident index that keeps its own tests honest.** `guard-corpus.json` already required every
  case to name the run that earned it; `regression-index.mjs` extends that to defects whose
  enforcer is a self-test elsewhere in the tree. It deliberately does not re-test them — it asserts
  the pinning case still exists, because a regression suite fails by having a case quietly deleted
  during a refactor, not by asserting the wrong thing. Seven incidents registered, and adding one
  without an enforcer fails the battery.

### Fixed (found by the release gate itself)

- **Release workflow requirements are counted inside the release-verify step.** They describe that
  invocation, but were counted across the whole workflow, which silently reserved
  `--repository "$GITHUB_REPOSITORY"` file-wide — so adding the api-shape step failed a rule that
  had nothing to say about it. The tempting fix was to spell the flag differently and dodge the
  contract; the correct one was to scope the check to what it actually means.

## [0.49.15] - 2026-07-28

### Fixed

- **The setup audit battery no longer reports failure on a healthy repository.** It is a
  diagnostic chain, so its exit status is whatever its last command returned — and the two
  commands most likely to end it fail precisely when nothing is wrong: `grep -v '^PASS '` exits 1
  when every check passed and it matches nothing, and `wc` exits 1 when an optional file such as
  `ARCH.md` is absent. Both now carry `|| true`, the size probe globs `docs/agentic/*.md` so a new
  file like `LESSONS.md` is included automatically, and the skill states the rule: read the
  battery by its sections, never by its exit code — for a pass/fail signal run
  `verify.mjs --install-root` on its own and read its status.

## [0.49.14] - 2026-07-28

### Fixed

- **Reconcile reports STATE drift, so the diet actually reaches configured repositories.** An
  audit of a live repo showed the gap: the lessons migration ran and LESSONS.md was seeded, but
  STATE itself was never mentioned — LOOP has always been reported as `kept` with a pointer to its
  merge command, and STATE had no equivalent. An operator could reconcile, watch the migration,
  and never learn that 22 KB of superseded template prose was still being injected into every
  session. STATE now reports `identical` or `kept` with the `--merge-state` remedy, and the stale
  "still carries its Lessons learned section" warning is gone — the migration moves it, so the two
  contradicted each other in the same report.

## [0.49.13] - 2026-07-28

### Fixed

- **Blocking a unit no longer destroys the authorization only a human can restore.** The block
  flow stripped `loop-ready` along with the step labels — but `loop-blocked` already removes the
  issue from the eligible set, so removing the authorization token as well was redundant, and it
  is the one label no loop path may re-apply. The result was a deadlock: the human's one-action
  unblock (remove `loop-blocked`) left the unit converging all the way to a finalizer that refuses
  without `loop-ready`, twice in live runs, after ninety minutes of dispatches each time. Blocking
  now removes `loop-started` and the `loop:*` step label and nothing else, in the skill and in the
  mechanical label-swap rider that had been prescribing the removal.

### Changed

- **STATE goes on a diet, and setup upgrades existing repositories automatically.** The template
  was 29 KB and every byte of it is injected into every session — roughly 90% of a configured
  repository's STATE was autoloop's own prose, including 6 KB explaining that the queue is not in
  the file and 6 KB of playbooks the dev skill already governs. The template is now **6.8 KB** and
  holds only what the loop cannot know without the operator: mission, config, autonomy limits,
  protected ground, security, and where state really lives.
- **Durable memory moves to `docs/agentic/LESSONS.md`**, read on demand instead of injected, and
  seeded from a template that states the pruning rule: a lesson that has become a mechanism — a
  guard rule, a contract check, a hook — is deleted, because the mechanism is the memory. Curate it
  like `ARCH.md`: periodically, against a size budget, in its own maintenance unit. STATE keeps the
  opposite regime: it is policy, it changes rarely and deliberately, and Setup owns the edits.
- **Reconcile runs ordered upgrade jobs.** `REPO_MIGRATIONS` is the mechanism; its first entry
  moves a legacy `Lessons learned` section out of STATE into LESSONS.md. Every job is idempotent,
  writes the new home before clearing the old one (an interrupted migration duplicates memory
  rather than losing it), and reports itself in the results so the change lands in a visible diff.
  Audit mode reports without writing, and `--merge-state` refuses outright when a template no
  longer owns a section the installed document still carries — no merge can strip durable memory.

## [0.49.12] - 2026-07-28

### Changed

- **State badges say what they mean, and terminal lines stop dangling.** The coloured squares
  become semantic across every skill and the mechanical label-swap reminder: ⏳ in progress ·
  ✅ complete · ❌ blocked · ⚠️ needs a human. Closing rails drop the half-box `╰─ … ─╯`, which
  promised a left edge no earlier line ever drew and read as debris on a screen full of prose, in
  favour of a symmetric `══ … ══` terminator. The rounded frame survives in exactly one place —
  the unit banner, where all four corners exist.

- **A human gate stops a unit, never the run.** The loop runs unattended, so every human-gated
  outcome is now a label plus an evidence-backed reason plus the next unit — never a question and
  a wait. At a cap-exhausted review it applies `loop-blocked` + `human:decide` naming the open
  finding, the fix scope, the round history, and the human's three options (authorize a higher
  cap, re-plan, split the predicate), then takes the next eligible unit in the same turn. The same
  shape covers a missing `loop-ready`, a `human:authorize` path, a dependency or secret
  hard-defer, a failed premise, and a refused merge predicate. `run complete` means the queue is
  drained, a bound was reached, or the context is handing off — never that one unit needed a
  human.
- Two things stay genuinely blocking, because continuing past them is worse than stopping: a red
  baseline gate still parks the run on the base going green (every unit would fail identically
  until the remedy lands), and a guardrail refusal the loop cannot satisfy still stops with the
  remedy stated.
- **The carve-out has a runbook, and it is the human's call.** Splitting an unconverged predicate
  into its own issue is documented — separability, independent value, and the shipped unit no
  longer claiming what it no longer does, plus findings carried across with evidence, the frozen
  plan amended, the artifact reduced, and one more full-artifact review — but the loop performs it
  on instruction, never as its own opening move, because a carve-out it reaches for unprompted is
  how scope evasion starts.

## [0.49.11] - 2026-07-28

### Fixed

- **The merge executor runs from the base checkout, closing the last fossil hole.** v0.49.10 moved
  the flow's contract tools to the installed plugin but kept `auto-merge.mjs` vendored, because it
  carries the repository's Setup-filled policy — which left a unit branch able to reach delivery
  and then face a merge executor 1,500 lines behind base. A live run refused to perform an
  irreversible merge with it, correctly. The executor is a GitHub-API operation on a pull request
  and reads nothing from the worktree, so it now runs after the switch back to base, where the
  vendored copy is the repository's current policy. `gate.mjs` remains the exception that must run
  against the unit's own tree; hooks remain the only tools with no escape from a fossil branch.

## [0.49.10] - 2026-07-28

### Changed

- **A branch's age can no longer block its delivery.** A unit branch snapshots `tools/agentic/**`
  when it forks and every invocation runs the working tree's copy, so a branch that outlives a few
  releases executes the code that had the bugs — one live unit ran a finalize with tools 4,300
  lines behind base, and five sessions hit some version of this. The flow's CONTRACT tools
  (dispatch, lifecycle-driver, publish-verdict, the review/delivery/attestation/snapshot
  contracts, prime, scan) now run from the installed plugin: they are pure executors of their
  inputs plus live GitHub state, so a branch's copy is an accident of its fork date, never an
  authority. The repository's own policy tools stay vendored — `auto-merge.mjs`, `gate.mjs`,
  `escalate-paths.mjs`, and every hook. Drift is checked mechanically at claim and before the
  terminal flow (`git diff --stat origin/<base>...HEAD -- tools/agentic/`) rather than assumed.
- **Behind base: merge for code, never for tooling.** Pre-review and behind, merge freely; a real
  conflict is Pitcrew's revision path, which re-reviews the resolution. Post-review with no
  conflict, do not merge — a merge moves the head, review evidence binds
  `committedHead == reviewedHead == gatedHead`, and a live unit's base sync is exactly what
  stranded its marker at a superseded head. The arithmetic settles it: on a day with eleven
  plugin releases, a "behind base → merge" reflex would have re-reviewed every in-flight unit
  eleven times over files those units never touched.

- **Every timeline line leads with `[HH:MM][#N]`.** The clock and the unit move from the tail of
  each ribbon to its left edge, and the issue number stops repeating in the body. A run interleaves
  two units across a dozen steps, and a reader scans a column for "when" and "which" rather than
  the end of every line. Ribbons, `♡ parked`/`♡ resumed` heartbeats, and closing rails all carry
  the prefix, in Dev and Pitcrew alike. Round-scoped steps keep the step number too —
  `08/11 CODE-REVIEW r2/5`, `08/11 FIX r2/5` — with the cells counting rounds against the cap, so
  one format holds for every line in the run whatever it happens to count.
- **Each step draws its own glyph** between the counter and the name, from a closed set where a
  glyph never means two things: 🔁 reconcile · 🧭 premise · 📐 plan · 🔬 plan-review · 📌 claim ·
  🔨 implement · 🧹 simplify · 👓 diff-review · 🔍 code-review · 🔧 fix · 🚦 gate · 📦 publish ·
  📝 record. 🔬 scrutinises a plan and 🔍 scrutinises code; 🔨 builds and 🔧 repairs. The state
  badge is unchanged — the glyph says what the step is, the badge how it is going. Pitcrew draws
  the same glyphs for the same kinds of work. The wait lines get their own pair — 🅿️ parked,
  ▶️ resumed — plus 💤 for an idle run and 🏁 on the run's closing rail.

### Fixed

- **A resumed unit learns it lost its authorization at selection, not after ninety minutes.**
  `loop-ready` is the human's authorization token; the defer and block flows strip it and the loop
  may never re-apply it, so a unit that lost it cannot finalize — correctly, since losing it
  mid-run is the kill switch. A live run resumed such a unit from its marker, carried it across
  seven dispatches to gate-green and review-clean, and only then hit the check. Selection now
  requires the label for marker-driven resumes too, reports the one command its human runs, and
  takes other work; and the finalizer's refusal names the failing precondition instead of
  returning a bare mismatch.
- **A run record that mentions the lifecycle marker is no longer treated as one.** Candidacy was a
  substring test on `autoloop-lifecycle-v1`, so every comment discussing the marker — the loop
  writes those — became a malformed candidate and failed the premerge derivation closed. Candidacy
  is now the HTML-comment opening token; an edited or corrupted real marker still carries it, so
  nothing that used to fail closed now passes.

## [0.49.9] - 2026-07-28

### Added

- **Every dispatch stamps the revision it launched in; no model transcribes a SHA.** A live
  orchestrator hand-copied a head OID into a review prompt, invented its eighth character, and the
  reviewer correctly refused to attach a closing verdict to a revision it could not match — ten
  minutes of reviewer time lost to a transcription no model should have been asked to perform.
  `dispatch.mjs` now appends an `autoloop-dispatch-context-v1` stamp derived from the checkout it
  is about to launch in, naming the revision and whether the tree is clean, and declaring itself
  the authority over any revision named elsewhere in the prompt. Fail-open: an unreadable checkout
  stamps nothing rather than failing a dispatch. The skill adds the matching rule — a 40-hex OID
  is copied from the tool result that produced it or supplied by the machine, never typed from
  memory.

### Changed

- **The README describes the v0.49 loop.** Steps 2 and 6 are dispatches, not orchestrator work;
  the pipeline table, the invariant-first planning rule, the same-predicate escalation, the
  per-step model and effort division, the `plan` role, and the live-watchable dispatch pane are
  all documented.

## [0.49.8] - 2026-07-28

### Added

- **`--effort <low|medium|high|xhigh|max>` on a dispatch, and reviews run `xhigh`.** One flag
  spans both CLIs — `--effort` on claude, the `model_reasoning_effort` config override on codex —
  and the level is stamped into the typed result and the dispatch log beside engine and model. The
  review-engine recording carries it as a `!<level>` token (`claude gpt-5.6-sol @<url> !xhigh`),
  so every reviewer inherits the depth without per-call flags; an unknown level fails the whole
  recording closed, and writers keep the engine default. A review round costs a wall-clock
  dispatch whether it reasons hard or not, so depth spent there is rounds not spent later. Seam
  tests drive the real CLI parse through to the engine argv — the flag-drop class that once cost
  six releases.

## [0.49.7] - 2026-07-28

### Changed

- **Step 6 simplifies for real, before any review round sees the artifact.** The slot that cost a
  label swap now dispatches one behavior-preserving pass (implement role, opus) whose prompt loads
  `agent-skills:code-simplification` and carries the measured diff against the plan's predicted
  line budget — over budget makes reduction a required outcome. The pass runs on **fable, not the
  implementer's opus**: simplifying is a reading task before a writing one, so a fresh model that
  does not inherit the writer's priors is the same decorrelation that makes cross-model review
  work, applied a step earlier. The pass may not edit test files
  and must leave the unit's tests green before returning; the orchestrator re-runs them and reads
  the diff, and a behavior change is reverted rather than fixed. Every line the reviewer reads is
  surface it can find something in: a live unit spent three of its four rounds re-reporting
  `artifact-line-budget-exceeded`, a number the orchestrator can measure in one command instead of
  learning one review round at a time. A trivial diff (~50 lines, two files) may still be handled
  inline.

## [0.49.6] - 2026-07-28

### Changed

- **Plans state invariants, not examples — the review-round lever.** Two live units burned five
  and seven rounds discovering one rule case-by-case: each fix closed the reported instance and
  the next round found the adjacent one, because the plan described *a* case instead of the
  property holding over *all* of them. Plans now state every behavioral rule as a quantified
  invariant citing its spec line, enumerate the cases it implies (marking deliberate exclusions
  as non-behavior), give each case a failing-first test, and name the invariant's joint failure
  mode. A rule that cannot be stated over its whole domain is an underspecified premise the plan
  must declare.
- **Plan review checks invariant completeness explicitly** — an incomplete invariant is a
  plan-level Major, and the cheapest Major in the loop to find there rather than one review round
  at a time.
- **Two consecutive same-predicate Majors escalate the fix from instance to invariant.** When
  rounds N and N+1 land on the same rule or predicate with different cases, the N+2 fix derives
  the complete invariant from spec, enumerates every implied case including unreported ones,
  tests each, and satisfies it jointly; the next review is scoped to the invariant. A third
  consecutive Major in that predicate is a planning failure — block for re-plan or split the
  predicate into its own issue. A live unit found this rule empirically at the cost of two
  rounds.
- **At the review cap, block — never widen it mid-unit.** `caps.codeReviewRoundsPerUnit` is STATE
  policy on an escalate path; a verified open Major at the cap is `loop-blocked` + `human:decide`
  carrying the finding, fix scope, and round history. A quiet ProjectConfig edit would make the
  loop its own policy author.

### Fixed

- **Driver terminal results carry the transition's detail.** A live identity-mismatch
  investigation took ten minutes because `driveLifecycle` returned only `{state,action,code}`,
  dropping the `{artifact}` field that named the failing comparison all along.
- **The frozen-artifact rule names the `jq -j` extraction idiom** — `--jq`/`jq -r` append the
  trailing newline that has now cost three sessions a planHash mismatch.

## [0.49.5] - 2026-07-27

### Changed

- **Plan revision is a dispatch, not session work.** After plan-review dispositions (which stay
  in-session — that is judgment), the revision itself goes out as one `--role plan --model fable`
  dispatch carrying the plan, the verified findings, and their dispositions, returning the
  revised artifact typed. The bounded-and-bulky rule that moved planning out of the session
  moves plan-fixing out too; the one-plan-review rule is untouched — the revision ships
  reviewed-once with dispositions recorded.
- **Task-panel prefix rule is explicit for sub-steps.** Fix rounds, doubt reviews, and plan
  revisions carry the same `∞ #<N> — ` subject prefix; the named examples were never an
  exhaustive list, and a live session formatted a fix-round row step-first.

## [0.49.4] - 2026-07-27

### Changed

- **Base first, then prime.** The dev loop's start order inverted: attribute any dirty tree,
  fetch and switch to the configured base, pull fast-forward (a non-fast-forward pull is human
  divergence — stop), THEN prime. Prime and the hooks execute the working tree's tool copies, so
  priming a parked unit branch ran whatever tools that branch forked with — the drift trap that
  has cost four sessions. STATE is read from the base checkout, never from a session injection
  that may predate the switch.

## [0.49.3] - 2026-07-27

### Fixed

- **The reconcile-request refusal names its failing field.** `lifecycle reconcile request is
  invalid` with no detail cost a lost cycle in two separate live sessions — both times the same
  silent cause: a locally recomposed `plan.body` whose sha256 no longer matched the frozen
  `intent.planHash`. `reconcileRequestGaps()` now reports every failing clause, the hash
  mismatch names both prefixes and states the remedy, and the skill's claim step says it
  outright: `plan.body` is the frozen plan comment fetched byte-exact from GitHub, never a
  local recomposition.

## [0.49.2] - 2026-07-27

### Fixed

- **Proxy mode is self-contained: dispatch injects the proxy URL.** The recording gains an
  `@<url>` token (`claude gpt-5.6-sol @http://127.0.0.1:18765`) and `dispatch.mjs` injects it as
  `ANTHROPIC_BASE_URL` into REVIEWER dispatches itself — `with proxy` no longer depends on how
  the host session was launched. A live run refused a healthy proxy because the session env
  lacked the variable, after misreading the port's listener as Docker plumbing. The preflight is
  now one probe of the recorded URL (answering = running), and the skill forbids inferring proxy
  absence from env vars, PATH, or process names — and forbids ever starting one. Writers still
  never read the recording, so a writer can never be proxied. Malformed `@` tokens fail the whole
  recording closed.
- **A red baseline gate parks the run instead of ending it.** A live run proved its gate failure
  pre-existing on main, found the open PR that fixes it, and still declared `run complete` — a
  one-merge remedy became a dead loop. The gate step now names the remedy, blocks the affected
  units, and parks on the base going green; `run complete` is for an exhausted queue only.
- **Reviewer prompts carry the ledger identity rule.** A live round re-used a finding id with
  rewritten summary/evidence and the review contract correctly refused to authenticate the round
  history — unfixable after the fact. Later-round prompts must state: re-opening keeps the
  original text byte-identical; new evidence is a new finding.
- **The gate command runs alone.** `cfg.gate.command; tail <log>` reports the tail's exit status
  as the task's — a live run read a red gate as 0 that way. The log plus the gate's own exit code
  are the evidence.

## [0.49.1] - 2026-07-27

### Fixed

- **Ready-head is earned, never inferred from a quiet head.** A live run wedged two units:
  `reconcileLifecycle` treated "delivery is green for this head" as ready-head discovery, and on
  a head where no CI triggered, delivery is trivially green — so a bare claim commit bound
  `ready-head` at claim, and every later push became a permanent `ARTIFACT_IDENTITY_MISMATCH`.
  Discovery now additionally requires both verdict statuses (`agentic/gate`, `agentic/review`
  success) on the exact head: a genuinely crashed post-finalize unit has them, a bare head
  cannot. A green-but-unverdicted head resumes unit work; a `loop-delivered` label without the
  statuses fails closed.
- **A superseded ready-head unbinds instead of wedging.** When the claim-verified remote head
  moves past a plain forward `ready-head` marker (base sync, new work), the marker now takes a
  typed `unbind-ready-head` transition back to `draft-pr` and re-earns ready-head on the new
  head — rediscovery demands fresh verdict statuses, so unbinding never skips review or gate.
  Revision, premerge, and merge markers keep their stricter machinery. Crash-recovery self-test
  pins unbind → re-bind → terminal convergence.

## [0.49.0] - 2026-07-27

### Changed

- **Simple delivery: verdicts are commit statuses again.** The whole v0.40 finalize/merge
  evidence layer is gone, per `docs/specs/simple-delivery.md`. `publish-verdict.mjs` posts
  `agentic/gate` and `agentic/review` as SHA-bound, success-only COMMIT STATUSES whose
  descriptions carry the verdict summary's sha256 prefix — PAT-writable, where the v0.40
  CheckRun writes were App-only by GitHub design and 403'd every solo finalize. The premerge
  record is v2: `review`/`gate` anchor on `{summaryHash}` verified byte-for-byte against the
  live status description, `ci` on the delivery evidence fingerprint alone.
- **The CI predicate is the triggered-checks floor.** Every check run and commit status on the
  exact head must be green — red blocks, pending blocks, a repository with no CI has nothing to
  wait for. `delivery-contract.mjs` reads only PAT-readable evidence (check runs + combined
  statuses, double-fetched for stability) and no longer compares against any required-check
  list, branch-protection rule, or ruleset.
- **Non-manual merge is solo-only.** `ratified`/`auto` require the recorded
  `merge.soloOperatorAcknowledged: true` and `merge.unverifiedInvocationAcknowledged: true`;
  anything else refuses typed at finalize and at merge authorization, naming the spec. The
  v0.40 multi-actor unattended mode was never usable on a shared login and is retired, not
  preserved.

### Removed

- **`.autoloop/ci-policy.json` and everything that read it** — the template, `canonicalCiPolicy`,
  the committed-vs-server comparison (unsatisfiable by construction on a free plan), the
  rules/branch-protection endpoint reads, and the free-plan-403 handling those reads needed.
  Scaffold reconcile now REMOVES a lingering copy from configured repos in the visible diff and
  reports it; `verify --install-root` flags a copy left behind.
- **CheckRun publication and the App layer** — `ensurePublishedCheckRun`, `--expect-app-id`,
  producer pinning, server-pinned workflow validation, and the `--ownership-attestation-file`
  ceremony (the premerge record already carries the ownership facts). The terminal-finalize
  surface is two flags: `--request-file` and `--review-evidence-file`.

### Added

- **The guard fences hand-posted statuses.** Statuses being PAT-writable is what makes solo
  delivery possible — and what makes a hand-typed `gh api …/statuses/<sha>` a verdict forgery.
  Mutating status posts are blocked with a typed reason; combined-status reads pass; corpus
  entries pin the forgery shape, the read, and the sanctioned publisher invocation.

## [0.48.3] - 2026-07-27

### Fixed

- **The step-10 finalize example carries its mandatory flags.** Under a non-manual merge policy
  the terminal finalizer requires `--ownership-attestation-file` and `--expect-app-id` and refuses
  without them — and the skill's example showed neither, so a live session lost a cycle
  rediscovering both from the refusal. The example now includes them, names the exact
  `KEYS.ownership` shape from `attestation-contract.mjs` and where each value comes from (the
  lifecycle marker and claim, never re-derived), and states the manual-mode inverse: both flags
  forbidden.
- **The optimistic full-close is executable, not just prose.** 0.46.0 made "convergence may only
  close on a full-artifact round" the skill's rule — and the review contract kept refusing it:
  rounds after the first were delta-only, so round > 1 with full scope returned
  `INVALID_REVIEW_INPUT`. A live session caught the contradiction mid-unit, correctly ruled that
  the contract wins, worked within it, and flagged the defect upstream. Round 1 remains full-only;
  later rounds now accept either scope, with the closing full round pinned by fixture: a clean
  round-2 full-artifact review publishes success. The delta-blindness human-block path stays
  delta-scoped, since a full round has no out-of-scope findings by construction.

## [0.48.2] - 2026-07-27

### Fixed

- **Setup says that `--sort-versions` needs no pre-cleaning.** A live run decorated the version
  pipe with `xargs -n1 basename` against a hazard that does not exist — the sorter silently drops
  non-version lines — and was correctly refused for the xargs, not the goal. The skill now states
  the guarantee where the command is prescribed, which removes the reason to improvise.

## [0.48.1] - 2026-07-27

### Changed

- **Every dispatched step's ribbon names its executor — engine and model.** The slot is
  `[ENGINE]` when no model is pinned and `[ENGINE:MODEL]` when one is, read from the dispatch
  result's own `engine` and `model` stamps rather than composed by hand: `[CLAUDE:OPUS]` writes,
  `[CLAUDE:FABLE]` plans and fixes, `[CODEX]` reviews, `[CLAUDE:GPT-5.6-SOL]` under the proxy.
  With models chooseable per step, who judged or wrote belongs on the line that reports it.
  Orchestrator-run steps keep no slot — the session's model is on the startup banner.
- Corpus grows to 39: the prescribed version-currency pipe (allow) and the live improvised
  `xargs -n1 basename` variant (block — xargs executes its arguments).

## [0.48.0] - 2026-07-27

### Added

- **`/autoloop:dev with proxy` — reviews on a proxied model, same harness.** The recorded review
  choice now carries an optional model (`claude gpt-5.6-sol[1m]`), so review dispatches keep the
  claude engine — structured verdicts, live streaming, tool ceilings — while the reviewing MODEL
  decorrelates from the writer through claude-code-proxy. Review ribbons carry the model in the
  host slot, since the engine name alone would lie about who judged; preflight NOTEs a proxied
  recording without `ANTHROPIC_BASE_URL`, where every review would fail typed on an unknown
  model. The writer never runs a proxied model — cross-MODEL review is the invariant, whichever
  harness carries it — and unlike `with codex`, the reviewer's read-only posture is the tool
  ceiling rather than an OS sandbox, stated in the skill rather than discovered.
- **Pitcrew never claims a unit whose marker is past review.** Behind-base was an actionability
  trigger on its own, so a `ready-head` unit — deliverable as-is, since the merge executor binds
  the exact PR head and GitHub merges a behind-but-CLEAN PR fine — was claimed for revision, hit
  `beginLifecycleRevision`'s `premerge-record` requirement, and blocked with "no sanctioned loop
  path". The refusal was right; the claim was the bug. Behind-base is now actionable only when
  the marker phase can actually enter the revision contract; at `ready-head` and beyond the PR is
  Dev's to finalize, and Pitcrew says so and moves on.
- **Planning is a dispatch — `--role plan`.** The last big in-session work leaves the orchestrator:
  a read-only-postured planner reads STATE, the checklist and the spec with its own tools, takes
  the full issue and constraints in its prompt, and returns the typed `{title, prBody, body}` the
  driver's request wants — schema-forced on both engines, validated against the driver's own
  limits, `INVALID_PLAN_RESULT` typed on mismatch. The orchestrator keeps premise, selection,
  `planHash`, intent composition and claim. With the flag this buys the knob planning never had:
  standing default `--model fable`, while the session model no longer constrains plan quality.
- **`--model` pins the engine's model per dispatch.** Claude spells it `--model`, codex `-m`; the
  pin crosses the CLI seam with a regression test that drives the real argv (the `--engine` lesson,
  applied preemptively — the flag would have shipped dead without it), and the chosen model is
  stamped into the typed result and the dispatch log so the record says who actually judged or
  wrote. Proven live: a dispatch pinned to `opus` answered as `claude-opus-5` in its own event
  stream. Model names are engine vocabulary and the skill says so — claude aliases never ride
  `--engine codex`. Standing operator defaults recorded in the skill: implement on `opus`, fix
  dispatches on `fable`, everything else on the saved default.

## [0.47.0] - 2026-07-27

### Added

- **The guard corpus: real session traffic as a permanent regression gate.** Five of one day's
  bugs were guard verdicts on commands no unit fixture contained — version probes, multi-line
  assignments, quoted heredoc bodies, `git` inside prose, inline PR bodies. The corpus carries
  those command shapes (sanitized, each tagged with the incident that earned its place), the
  guard replays it in its self-test and via a dedicated `--corpus` mode, and `verify` gates it on
  both the plugin and every installed repository — a corpus edit is re-proven even when the
  manifest fast-path skips the unchanged tool. Thirty-six cases at birth; every future false
  positive becomes an entry.
- **Setup phase ribbons are mechanically anchored.** Prose alone proved intermittent across three
  wordings — one ribbon of five, then none, then a scattered subset. Dev's ribbons hold because
  riders ride label swaps; setup has no labels, so its ribbons now ride the commands each phase
  inevitably runs: `--sort-versions` anchors RESOLVE, `scaffold --audit` anchors AUDIT and points
  at INTERVIEW, `--reconcile`/`--merge-*` anchor WRITE, install-root verify anchors VERIFY. The
  PostToolUse reminder names the ribbon due now and the one after it.

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
