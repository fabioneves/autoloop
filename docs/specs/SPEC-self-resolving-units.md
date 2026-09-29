# Spec: self-resolving-units (module of SPEC-self-healing.md)

## Objective

A unit whose outcome is mechanical disposes of itself instead of asking a human. Every row below is
a `human:decide`/`human-block` today; after this module it is a recorded, reversible state the loop
enters by itself, and the run takes the next unit.

| Case | Today (cited) | After |
|---|---|---|
| Premise: obsolete / already delivered | block `human:decide` (`SKILL.md:959-961`) | `unit.mjs --obsolete`: verifies the cited merged PR or base-reachable commit, labels `loop-obsolete`, closes **not planned** with the evidence (reopen undoes it) |
| Waits on unit #N, or on a red base | block `human:decide` (`SKILL.md:1842-1848`, `:1604-1613`) | `unit.mjs --wait`: label `loop-waiting` + a machine comment recording the condition; prime lifts it when the condition clears |
| Same finding id re-raised in 3 rounds | cap hand-off (`review-contract.mjs:648`) | `defer` disposition (Major only) naming a filed follow-up issue; listed in the PR body |
| Verified out-of-delta finding | `human-block VERIFIED_OUT_OF_DELTA_FINDING` (`review-contract.mjs:617-624`) | `continue REVIEW_FULL_ROUND_REQUIRED` while rounds remain: fix, then a `full` round |
| Cap round with gating findings | `human-block REVIEW_CAP_REACHED`; any round past it refused (`:528-530`) | `continue REVIEW_CLOSING_ROUND_REQUIRED`: fix, then exactly one `full` round cap+1; gating there → `REVIEW_CAP_REACHED` |
| Checkbox toggle or post-merge body edit | driver throws "live issue does not match" (`lifecycle-driver.mjs:497-501`) | the driver's live check accepts a body whose only change is task-list ticks, and skips the body on a closed issue. Merge authorization is out of scope: it also refuses any `lastEditedAt` after approval, and auto-merge is manual-only |

Why a comment and not `## Blocked by`: editing the body after `loop-ready` makes the issue ineligible
(`snapshot-contract.mjs:1107-1108`), which is exactly the stop this module removes.

## Behaviour

1. **`unit.mjs`** (new, `templates/tools/`), one bare call per disposition:
   - `--obsolete --issue N --pr M | --commit SHA [--note text]`: refuses `EVIDENCE_NOT_DELIVERED` unless PR M
     is merged into the configured base, or SHA is an ancestor of `origin/<base>`. Then comments the
     evidence, adds `loop-obsolete`, closes `--reason "not planned"`.
   - `--wait --issue N --on-issue M | --on-base-red [--note text]`: posts
     `<!-- autoloop-waiting-v1 {"on":"issue","number":M} -->` or `{"on":"base","oid":<origin/base oid>}`,
     adds `loop-waiting`. Refuses waiting on itself, or on a closed issue.
   - Pure cores exported for tests: `waitCondition(commentBody)`, `waitCleared(condition, facts)`.
2. **Eligibility:** `loop-waiting` makes an issue ineligible (`eligibleQueueIssueNumbers`, `checkDarkRun`).
3. **Prime lifts waits:** before its scan, prime calls `unit.mjs`'s `liftWaits` in process. It lists
   the open `loop-waiting` issues with their comments and reads the newest waiting marker. It removes
   `loop-waiting` when `issue M` is CLOSED or `origin/<base>` has moved off the recorded oid, and prints
   `lifted: #N (reason)`. Because this happens before the scan, the snapshot already sees the unit as
   eligible, and no new snapshot section is needed. A waiting issue with no parseable marker stays and is
   reported. A lift error leaves the issue waiting and never fails prime. `loop-ready` is never touched,
   so provenance is unchanged.
4. **Review contract:** `defer` disposition (`{findingId, disposition: 'defer', followUpIssue, rationale}`),
   valid only for a Major raised in ≥ 3 rounds; the finding leaves the gating set and the transition reports
   `deferred`. Out-of-delta and closing-round transitions as in the table. Critical is never deferred.
5. **`issueBodyIdentity(body)`** in `lifecycle-contract.mjs`: sha256 of the body with every task-list mark
   `[x]`/`[X]` → `[ ]`. The driver accepts `recorded === sha256(body) || recorded === issueBodyIdentity(body)`.
   The recorded raw hash stays: issues are approved with unticked lists, so no recording change is needed.
6. **Labels:** setup creates `loop-waiting` and `loop-obsolete`. `unit.mjs` also creates a missing one on
   first use and retries the add once, so a repository set up earlier needs no re-run.
7. **Prose:** premise, handoff, red-base, and review sections route to the above.

## Boundaries

- Never: delete issues or comments; defer a Critical; close an issue without verified delivery evidence;
  remove `loop-ready`; edit an issue body.
- Keep: every existing `reviewTransition` rule not named above; `--append-escalation-round` unchanged.

## Tests (failing first)

- `unit.mjs --self-test`: marker round-trip; cleared on closed dependency / moved base, not otherwise;
  self-wait refused; obsolete refuses an unmerged PR and a non-ancestor commit (fake gh/git runners).
- `snapshot-contract`: `loop-waiting` issue ineligible. `writeback-check`: dark-run skips it.
- `unit.mjs --self-test` (`liftWaits`, fake runner): lifts a cleared wait, keeps an uncleared one and a
  markerless one. `prime`: prints one line per lifted or still-waiting unit.
- `review-contract`: defer accepted at 3 raisings, refused at 2 and for Critical; out-of-delta continues
  below the cap; cap round continues; cap+1 full round allowed once and its gating → `REVIEW_CAP_REACHED`.
- `lifecycle-driver`: checkbox toggle keeps identity; a text edit still mismatches; a closed issue skips
  the live body check.
- `regression-index`: one incident pinned to the above.
