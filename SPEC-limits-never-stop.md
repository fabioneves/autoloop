# Spec: limits-never-stop (module of SPEC-self-healing.md)

## Objective

A limit still bounds cost. Reaching one hands the unit to the human at merge time and the run takes
the next unit. It never parks the unit on a `human:decide` whose only possible answer is "ship it
with the known issues listed" or "try again later".

## Scope, checked against the code (it differs from the capability map)

| Limit | Today (cited) | This module |
|---|---|---|
| Review cap, open Majors only | closing round → `human-block REVIEW_CAP_REACHED` (`review-contract.mjs:702`), then the SKILL's three-option `human:decide` block (`SKILL.md:1407-1445`) | **Changed.** Under manual merge policy the contract returns `clean REVIEW_CAP_HANDOFF` listing the open Majors. The loop files one follow-up issue per Major, lists them in the PR body, and publishes as usual. The human sees them at merge |
| Review cap, an open Critical | same | **Unchanged.** A Critical is a real human decision; the run already continues |
| Review cap under a non-manual merge policy | same | **Unchanged.** A hand-off must never reach auto-merge |
| 3 consecutive host kills on one step | `loop-blocked` + `human:decide` (`SKILL.md:514-515`) | **Changed.** `unit.mjs --wait --issue N --minutes 60` records a timed wait, and prime lifts it once the time has passed |
| Model usage limits | fallback route in the tool, else a timed park (dispatch-resilience, run-continuity) | Already done |
| Slice budgets | NOTE in the PR body, never block (`SKILL.md:1449-1452`). Dev has no plan-time slice stop; splitting is enforced in `autoloop:shape` (`sizing-contract.mjs:57`) before the queue | Already done. No change |
| 3rd Major in one predicate → automatic re-plan | the SKILL's invariant escalation (`SKILL.md:1379-1389`) | **Dropped.** A re-plan cannot resume a unit, because the marker binds `planHash`/`issueBodyHash`, so it is a new issue. The case is already absorbed: the finding defers at 3 raisings (self-resolving-units), or it reaches the cap hand-off above |
| Gate retries exhausted | block (`SKILL.md:1693`) | **Unchanged.** A red gate after the retries is a failing unit, not a limit artifact. A draft PR plus a different label would only rename the block. A red **base** is already a wait |
| Pitcrew revise cap | block (`pitcrew/SKILL.md:272-274`) | **Unchanged.** Pitcrew runs on a PR a human is already reviewing, so the human is already there. Its review rounds inherit the cap hand-off through the same contract |

## Behaviour

1. **`reviewTransition`**, round > cap (the closing full round), gating findings remain:
   - every gating finding is a `Major`, and `projectConfig.merge.policy === 'manual'`: the result is
     `decision('clean', 'REVIEW_CAP_HANDOFF', {handedOffFindings: [{id, severity}], deferredFindings?,
     reviewedHead, reviewedCheckout, reviewEvidenceFingerprint})`. It is publishable, so
     `authorizeReviewPublication` accepts it, and the CheckRun summary carries the code;
   - otherwise the result is `human-block REVIEW_CAP_REACHED`, as today.
2. **`unit.mjs --wait --minutes <1..720>`** records `{"on":"time","until":<iso>}`. `waitCleared` clears
   it once `facts.now >= until`, and `liftWaits` passes `now`.
3. **Prose.** SKILL cap section: `REVIEW_CAP_HANDOFF` → one `gh issue create` per handed-off Major
   (no `loop-ready`), then `## Open findings at the review cap` in the PR body with the follow-up
   numbers, then continue to the gate. `REVIEW_CAP_REACHED` keeps today's three-option block, and now
   only a Critical or a non-manual policy reaches it. The kill bound becomes the timed wait. Pitcrew
   gets a matching line.

## Boundaries

- Never: a hand-off with an open Critical; a hand-off under a non-manual merge policy; a hand-off
  before the closing full round; an edit to any other `reviewTransition` rule.
- Merge stays human, and the PR body lists every handed-off finding.

## Tests (failing first)

- `review-contract`: a closing round with only Majors under manual policy → `clean REVIEW_CAP_HANDOFF`,
  `authorizeReviewPublication` authorized. With a Critical → `REVIEW_CAP_REACHED`. With a non-manual
  policy → `REVIEW_CAP_REACHED`. At the cap round itself it is still `REVIEW_CLOSING_ROUND_REQUIRED`.
- `unit.mjs`: a timed wait round-trips, clears at or after `until`, and holds before it. `--minutes`
  out of range is refused.
- `regression-index`: one incident pinned to the hand-off and the timed wait.
