# Capability Map: Self-healing loop

## Why

The evidence comes from four read-only audits of LFE and LF, covering 716 dispatches, 712 issue timelines, and 9 run sessions from 08-23 to 09-01. They show that runs mostly stop for **environment and loop-machinery** reasons, not code:

| Cause | Evidence | Cost |
|---|---|---|
| Harness permission classifier denies the loop's own tools | 26 denials, **4 run-ending halts**; 11 of the denials hit hand-assembled review-evidence `jq`/Write | ~18h idle |
| Model asks the human mid-run (AskUserQuestion) instead of parking the unit | 3 waits | ~25h idle |
| Host SIGKILL of dispatches | 61 kills, up to 6 attempts on one step; 1 run end (#333) | 3.4h+ |
| Proxied reviewer dies silently | 11% of review dispatches failed; 1 run end (#387) | 6.1h |
| Stop hook false blocks / missed parks | 25 blocks, ~half while a dispatch was running; fires outside runs | turns + 3.3h |
| Review non-convergence | #311 17 rounds / 5 sessions / 8 days, #333 20 rounds | ~44 extra rounds |
| Units that could self-resolve (obsolete, waits-on-another-unit, infra fault, unreviewed fix at cap) | ~19 of 66 blocked units | median 2.9h per block waiting for a human |
| Command-guard refusals of harmless shapes (`$?`, `$(…)`, read-only git) | 128 refusals | one turn each |
| Prose ends the RUN on unit-scoped events | `SKILL.md:1777` "a guardrail failed", `:1790-1793` handoff "stop", `:321` proxy down, `:84-87` transient prime failure | run ends |
| Duplicate full gate (step 9 + terminal-finalize `publish-verdict.mjs:1893`) | 09 gate: 83h label-time on LFE | 1 gate per unit |

Correct human stops stay: spec/contract contradictions (22 units, all from one shape batch), escalate paths, missing environment, merge authority, secrets, and destructive actions.

## Target rule

**A unit stops only for a decision a human must make. The run stops only when no unit can proceed.**

Everything else must do one of the following:
- retry
- fall back
- wait on a recorded wake condition and resume itself
- dispose of the unit with evidence

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `run-continuity` | The run never ends on a unit-scoped event. Covers:<ul><li>rewrite of the run-close/handoff prose</li><li>AskUserQuestion refused mid-run (PreToolUse hook → "park the unit with `human:decide`, take the next")</li><li>Stop hook hard-blocks only while a run is live</li><li>unpushed-work check respects in-flight dispatches</li><li>durable park record `prime.mjs --park <reason> --wake <ts\|base-green\|unit:#N>` that the Stop hook honours</li><li>timed parks (usage limit, red base) arm a one-shot session wake that re-primes and continues</li></ul> | — |
| `permission-surface` | The loop never needs a classifier judgement for its own work. Covers:<ul><li>setup writes explicit allow rules for the loop's tools (`publish-verdict`, `auto-merge.mjs`, dispatch, prime, scan, `gh` reads/label writes) into the target repo's `.claude/settings.json`</li><li>review evidence is assembled by a tool from the stamped dispatch results, never hand-built with `jq`/Write</li><li>a classifier "stage 2 error" is retried once</li></ul> | — |
| `dispatch-resilience` | Effect-free failures retry themselves. Covers:<ul><li>`error.code` recorded in the dispatch log</li><li>reviewer/plan dispatches retry typed transient failures (`ENGINE_EXIT_NONZERO`, `ENGINE_RESULT_MISSING`, `ENGINE_RESULT_EMPTY`, `DISPATCH_TIMEOUT`) up to 2× unchanged</li><li>prime/scan retry transient gh failures with backoff</li><li>after 2 consecutive failures on a route, the run switches that role to the route's fallback (depends on per-role routing)</li><li>**spike first:** detached dispatch launch (`setsid`, result file, `--wait-file` polling) to escape host SIGKILL; adopt only if the spike shows it survives</li></ul> | `run-continuity`, model-routing (`SPEC-model-routing.md`) |
| `self-resolving-units` | Units dispose of themselves when the evidence is mechanical. Covers:<ul><li>obsolete/already delivered with a cited merged PR/commit → `loop-obsolete` + close as not planned (reopenable), not `human:decide`</li><li>waits on unit #N or on a red base → `loop-waiting` with the recorded condition, requeued automatically by prime when it clears</li><li>the same finding id/predicate recurring 3× → auto-deferred to a filed follow-up issue and listed in the PR body (the human sees it at merge), instead of a block</li><li>an out-of-delta verified finding continues with a scope escalation while rounds remain</li><li>at the review cap with an unreviewed fix pushed → one closing round before the cap hand-off</li><li>issue-body edits that only touch task-list checkboxes, or land after merge, no longer mismatch the lifecycle identity</li></ul> | `run-continuity` |
| `limits-never-stop` | Every limit keeps bounding cost, but reaching it now hands off and continues instead of stopping:<ul><li>**Review cap** (`codeReviewRoundsPerUnit`, `review-contract.mjs:643` `REVIEW_CAP_REACHED`): open Majors are filed as follow-up issues and the PR goes ready with them listed; an open Critical leaves the PR **draft** with the Critical listed and labelled `loop-attention`</li><li>**Pitcrew revise cap** (`reviseRoundsPerPr`): same hand-off</li><li>**Gate retries** (`gateRetriesPerUnit`): draft PR with the red gate evidence plus `loop-attention`</li><li>**Slice cap at plan time** (`sliceMaxLines/Files`): the loop files the split sub-issues itself (`## Blocked by` chain, `loop-ready`) and continues with the first slice</li><li>**3rd Major in one predicate**: one automatic re-plan dispatch inside the unit, then the review-cap hand-off</li><li>**3 consecutive host kills on a step**: timed `loop-waiting` retry via the park/wake record</li><li>**Model usage limits**: fallback route, else a timed park until reset with automatic resume; never a run close</li></ul>In every case the unit ends in a state a human reviews at merge time and the run takes the next unit. Merge stays human, so nothing unreviewed ships. | `run-continuity`, `self-resolving-units` |
| `guard-friction` | The command guard refuses only shapes that can hide a git/gh mutation. Covers:<ul><li>`$?`/`$#`/`$$` treated as inert</li><li>`$(…)`/backtick bodies evaluated recursively as commands, not refused outright</li><li>awk refused only when the program has `system(`, `\|`, or `getline`</li><li>read-only git subcommands allow-listed</li><li>inline interpreter source stays refused</li><li>each relaxation pinned by corpus cases on both sides</li></ul> | — |
| `speed` | Less wall-clock per unit, no safety change. Covers:<ul><li>the step-9 preflight gate runs concurrently with the closing review round instead of serially</li><li>terminal-finalize reuses an exact-head, same-`commandHash` `agentic/gate` success instead of re-running the gate on re-invoke</li><li>`step.mjs` composes label swap + snapshot invalidate + clock + ribbon/subject in one call</li><li>the task-panel mirror becomes opt-in</li></ul> | — |
| `decision-digest` | Human decisions batch instead of trickling in. Covers:<ul><li>at run close/park, one digest (issue comment on a pinned tracking issue plus the final chat message) lists every `human:decide`/`human:authorize` with its one-line question</li><li>shape lint checks acceptance criteria against the cited spec/corpus before `loop-ready`, since all 9 contradiction blocks came from one shape batch</li></ul> | `self-resolving-units` |

**Build order:** `run-continuity` → `permission-surface` → `guard-friction` → `dispatch-resilience` (after model-routing) → `self-resolving-units` → `limits-never-stop` → `speed` → `decision-digest`

The order runs from most run-ending hours removed per change down to the least.

## Out of scope (flagged, not planned)

- **SKILL.md diet.** 2,131 lines, ~38k tokens, ~45% incident narrative. Moving it into reference docs would free orchestrator context (fewer compactions: 90 in 9 sessions). Worth its own spec.
- **Plugin churn.** 11 releases in 10 days stranded #314 at a contract boundary. Pinning the plugin per run and applying reconciles between runs is a process change more than code.

## Verification (all modules)

```bash
node templates/tools/verify.mjs --plugin-root .
node templates/tools/verify.mjs --emit-self-test-manifest > templates/tools/self-test-manifest.json
git diff --check
```

- Each module adds failing-first self-tests in the tool it touches.
- Each removed stop gets a `regression-index.mjs` incident that pins its enforcer.
- Live acceptance: one unattended LFE run of at least 3 units in which **no stop occurs except a class-A human decision**, with the dispatch log carrying error codes.
