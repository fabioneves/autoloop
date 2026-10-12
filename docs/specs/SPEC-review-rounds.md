# Spec: Review rounds

Module: `review-rounds` in [Flow](SPEC-flow.md).

## Objective

A code review converges in at most three fix rounds. A Major that survives three rounds is a
decision, a plan defect, or a deferral; it is not a fourth fix. A Critical still blocks delivery
at any round.

## Current state

`tools/review-contract.mjs:573` sets `REVIEW_ROUND_CAP = 20`, not configurable. The dev skill
(lines 528-545) escalates after two Majors on one predicate and defers a Major raised in three
rounds, but fix rounds continue to the cap. On one project 12 units reached the cap; one unit ran
15 review and 6 fix dispatches in a day, another 8 fix and 8 review rounds plus a two-hour timeout.
Majors in late rounds were raised on lines that earlier fixes added.

## Required behavior

1. **Round budget.** A unit gets round 1 (full artifact) and at most three fix rounds. The
   contract refuses a fourth fix round with `REVIEW_FIX_BUDGET_SPENT`.
2. **Per-predicate count.** Two consecutive Majors on one predicate keep the existing
   whole-invariant rule. A Major re-raised, reworded, or re-filed on the same predicate counts as
   the same finding; it does not reset the budget. The ledger keys findings by stable ID plus
   predicate, not by text.
3. **After the budget.** The host sorts each surviving Major, with the evidence it already
   verified, into one of:
   - `decide`: the reviewer is wrong, or it is a design disagreement; record with
     `unit.mjs --decide` naming the finding ID; disposition `rebut` with the decision link;
   - `re-plan`: the fix keeps regressing or the finding shows a plan defect; one `plan` dispatch
     with the ledger as input, one `implement` dispatch, one full review round; permitted once per
     unit (`REVIEW_REPLAN_SPENT` refuses a second);
   - `defer`: real and outside the unit (see [Elastic scope](SPEC-elastic-scope.md)); a repair
     issue, disposition `defer`.
4. **After the re-plan round.** A Major that is still open is deferred as a repair and the unit
   is delivered as a draft pull request with the ledger under `## Open findings`, labelled
   `human:decide`. This is the only path that waits for a human, and the run record names it.
5. **Critical.** A verified Critical blocks delivery at any round, as today. It is fixed in the
   next round regardless of the budget; a Critical that survives the re-plan round blocks with
   `POLICY_DENIED` and the ledger.
6. **Minors.** Minors never consume the budget and never hold delivery. They ride into the PR
   body under `## Minor findings`.
7. **Closing round.** The last review before delivery is `full` scope on the exact head, as today.
8. **Cap handoff retired.** `REVIEW_CAP_HANDOFF`, `REVIEW_CAP_REACHED`, and
   `REVIEW_CLOSING_ROUND_REQUIRED` are replaced by the transitions above. Status views show
   `fix 2/3`, `re-plan`, or `open findings` instead of round numbers up to 20.

## Commands

```bash
node tools/review-contract.mjs --self-test
node tools/step.mjs --self-test
node tools/unit.mjs --self-test
node tools/parked-disposition.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/review-contract.mjs`: budget, predicate keying, new transitions, retired transitions.
- `tools/step.mjs`, `tools/parked-disposition.mjs`: round display.
- `tools/briefs/code-review.md`, `tools/briefs/fix.md`, `tools/briefs/plan.md` (re-plan input).
- `skills/dev/SKILL.md` step 8; `tools/regression-index.mjs`; `CHANGELOG.md`.

## Testing strategy

Failing tests first: a fourth fix round is refused; a reworded Major on the same predicate keeps
its count; `decide`, `re-plan`, and `defer` each produce the named transition; a second re-plan is
refused; a Critical in round 4 still blocks; Minors do not count; a surviving Major after the
re-plan round yields a draft delivery with `human:decide`. Use the existing synthetic ledger
fixtures.

## Boundaries

- Always: reviewer ≠ writer; exact-head closing round; verified evidence before any disposition.
- Ask first: a budget other than three.
- Never: ship a Critical; discard a Major without a recorded decision or deferral.

## Success criteria

No unit records more than five review dispatches (round 1, three fixes, re-plan round) before
delivery or draft hand-off. A Critical still blocks. Self-tests and the full gate pass.
