# Spec: loop-authored-work (module of SPEC-initiative.md)

## Objective

The loop can work on the repairs it files. Today every follow-up it files lacks `loop-ready`, and `eligibleQueueIssueNumbers` (`snapshot-contract.mjs:1084`) accepts only issues whose last `loop-ready` label event came from a trusted actor. So "fix it" ends in an issue that only a human can start.

A repair issue inherits authorization from a trusted `loop-ready` parent instead.

## Behaviour

1. **Filing** (`unit.mjs --repair`, new), as one bare call:

   `unit.mjs --repair --parent N --title "<title>" --body-file <path> [--blocks-parent]`

   - It refuses unless the parent is eligible now, or is a unit this run owns.
   - It creates the issue with the label `loop-repair`, never `loop-ready`.
   - The body ends with `<!-- autoloop-repair-v1 {"parent":N,"parentLabeledBy":…,"parentLabeledAt":…,"depth":1} -->`, copied from the parent's trusted provenance.
   - `--blocks-parent` also runs `unit.mjs --wait --issue N --on-issue <repair>`.

2. **Eligibility** (`snapshot-contract.mjs`): an issue is eligible under exactly one of two rules.
   - Today's `loop-ready` rule, unchanged.
   - **Repair rule.** All of these must hold:
     - the issue carries `loop-repair`;
     - its author is the authenticated runner;
     - its body carries exactly one `autoloop-repair-v1` marker;
     - `lastEditedAt` is null;
     - the marker's `parentLabeledBy`/`parentLabeledAt` match a trusted `queue-label` evidence entry for the parent, checked the same way as today;
     - `depth` is 1.

   Dependencies, blocked, waiting, owned and recovering filters apply as today.

3. **Scan:** the queue section also fetches open `loop-repair` issues, along with the parent's label timeline and author evidence. The existing `authorVerification` section records the evidence.

4. **Bounds:**
   - At most 3 open repair issues per parent. A fourth `--repair` is refused (`REPAIR_BUDGET_EXHAUSTED`), and the loop treats that as `decide`: it folds the work into an existing repair or defers it.
   - Depth is 1. A repair unit's own repairs are filed as plain follow-ups (no `loop-repair`), and it is a human's call whether to queue them.

5. **Parent standing** (review fix, 2026-09-25). A repair is eligible only while one of these holds:
   - its parent is open and not `loop-blocked`, so the loop cannot route around its own human gate;
   - its parent was delivered: closed as completed and carrying `loop-delivered`, so a carve-out's remainder outlives the parent.

   A parent a human closed any other way revokes its repairs. The budget of three per parent is enforced at scan time, taking the oldest three, as well as at filing. A repair whose facts cannot be read drops out of that scan and does not make the queue incomplete. `--blocks-parent` is recorded in the marker, so the snapshot can put that repair first.

6. **Revocation:** removing `loop-ready` from the parent revokes every repair still open under it, because eligibility re-checks the parent's provenance. Adding `loop-blocked` to a repair revokes that repair.

6. **Priority:** a repair that `--blocks-parent` is selected before other queue work.

## Boundaries

- Never: apply `loop-ready`; mark an issue `loop-repair` that the loop did not author; file a repair for a `human`-class matter; edit a repair's body after filing.
- Guard: `command-guard.mjs` keeps refusing `loop-ready` mutations. Add `loop-repair` to its label vocabulary only for `unit.mjs`, and refuse a raw `gh issue edit --add-label loop-repair`.

## Tests (failing first)

- `snapshot-contract` self-test:
  - Eligible: a repair with trusted parent evidence.
  - Refused: a repair with an edited body, a foreign author, depth 2, or parent evidence that no longer matches (parent relabelled by an untrusted actor, or the label removed).
- `unit.mjs --self-test`: `--repair` refuses an ineligible parent and a fourth open repair; the marker round-trips.
- `command-guard` self-test: raw `--add-label loop-repair` refused; `loop-ready` refusals unchanged.

## Success criteria

- The LF case replays end to end with fixtures: #248 is gate-red because of a base dependency advisory. The loop files a repair (`--blocks-parent`), works the repair, #248 lifts from `loop-waiting`, and #248 delivers. No human label is needed.
- `node templates/tools/verify.mjs --plugin-root .` passes.
