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
4. **After the re-plan round.** The re-plan round can be the first to see a finding, so the
   contract admits exactly one round after it: a fix round when every open `fix` entry is
   Critical, or a closing round whose only open entries are `defer` naming a `seam` or `rebut`
   naming a decision link. A fix round is followed by the closing full round, under the same
   limit on `defer` and `rebut`. Any other round after the re-plan is `REVIEW_REPLAN_SPENT`. A
   gating finding outside the delta of a round after the re-plan gets no widened round: it is
   the hand-off below (rule 4) or the block (rule 5). A Major still open at the re-plan round or at the
   closing round is deferred as a repair and the unit is delivered as a draft pull request with
   the ledger under `## Open findings`; `step.mjs --round open-findings` labels the issue
   `human:decide`. This is the only path that waits for a human, and the run record names it.
5. **Critical.** A verified Critical blocks delivery at any round, as today. It is fixed in the
   next round regardless of the budget, the re-plan round included (rule 4); a Critical still
   open after that admitted fix round blocks with `POLICY_DENIED` and the ledger.
5a. **Rework after the hand-off.** A draft (`REVIEW_OPEN_FINDINGS`) or block (`POLICY_DENIED`)
   hand-off after the re-plan names its `round` and its `reviewEvidenceFingerprint`. The block or
   decision on it records both (`unit.mjs --review-fingerprint --review-round`). A rework
   reopens the unit in the same ledger, with no history reset: one fix round (any severity),
   then the closing full round with no fix. Neither round defers a finding without a `seam` or
   rebuts one without a decision link. Each round from the fix round on carries the
   `reworkAuthorization` `{kind, issue, comment, round, evidenceFingerprint}`, which binds to
   the exact evidence of the hand-off round. Two kinds exist: `answer`, a trusted `/answer
   rework…` posted after the loop's block on that hand-off and not superseded by a newer
   answer; and `decision`, the loop's own `rework…` decision on it, whose newest trusted
   `/answer`, if any, is `rework…` too. The loop's newest marker on the hand-off decides alone: an
   older marker never stands behind its no. A unit gets one `decision` rework. Any number of `answer` reworks is possible,
   each bound to a later hand-off. A rework that names other evidence, a round that is not a
   hand-off, or a round past its closing round is `REVIEW_REWORK_SPENT`; a rework on evidence
   that is not a hand-off is refused when appended (`REWORK_NOT_AUTHORIZABLE`). A finding still
   open after the rework is handed off again by rule 4 or 5. The publisher posts no
   `agentic/review` until it has derived each rework again from the issue's comments, read from
   the validated publication repository (never the ambient `GH_REPO` or remote), with the
   comment on that repository's issue. `step.mjs
   --round rework` names the fix round (LFE, 2026-10-15: #519 had a human's "rework" answer and
   no transition that admitted it).
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
re-plan round yields a draft delivery with `human:decide`; a Critical first seen in the re-plan
round gets one fix round and the closing full round, a second fix round is refused. A rework
bound to the hand-off admits one fix round and the closing round; other evidence, a second decided
rework, or a round past the closing round is refused; a forged or reversed rework publishes
nothing. Use the existing synthetic ledger fixtures.

## Boundaries

- Always: reviewer ≠ writer; exact-head closing round; verified evidence before any disposition.
- Ask first: a budget other than three.
- Never: ship a Critical; discard a Major without a recorded decision or deferral.

## Success criteria

No unit records more than five review dispatches (round 1, three fixes, re-plan round) before
delivery or draft hand-off, and each rework adds at most two. A Critical still blocks. Self-tests and the full gate pass.
