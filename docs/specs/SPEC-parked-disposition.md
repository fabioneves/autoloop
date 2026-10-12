# Spec: Parked disposition

Module: `parked-disposition` in [Session recovery fixes](SPEC-session-recovery.md).

## Objective

Show what each open unit is waiting for. Old local reconciliation markers must not conceal known waiting, blocked, repair, or automatic-merge states. Users are loop operators; consumers are parked views and terminal cards.

## Tech stack

Use existing Node.js ESM status tools, validated snapshot/configuration data, and local step records. Add no dependency, polling service, or new GitHub query to a status read.

## Required behavior

1. Prefer a valid, current observation of a unit's disposition over an old local reconciliation label. Reuse snapshot freshness and schema checks. Do not use an invalid, foreign, or stale snapshot as current authority.
2. Identify human-blocked, waiting, and repair work when supported by the observed labels or typed lifecycle result. Keep the issue visible. Do not describe an elapsed reconciliation timestamp as proof that a process has run for that duration.
3. Preserve valid local staged work that is not yet in the remote issue steps. Newer local activity must not be overwritten by an older snapshot. If evidence cannot establish the current disposition, retain an explicitly qualified local/unknown state rather than guess or hide the unit.
4. Missing snapshot membership, age, or a failed query must not imply completion. Do not close open units or clear their human labels to clean the display.
5. A delivered card must reflect the configured merge policy or an explicit verified disposition. Reserve “awaits human merge” for manual merge or an actual human gate. Use “merge pending” for a non-manual merge that has not completed; preserve a known waiting reason.
6. Keep a known automatic merge pending in the parked/status view until a later verified outcome. Entering the record step or printing a delivered card must not silently erase unfinished merge work. A later shipped or human disposition must supersede the pending state without duplicate cards.
7. Treat merge readiness and execution as separate facts. Green checks do not prove a merge occurred or that every merge predicate passed. Do not trigger a merge from status rendering.
8. Preserve checkout-reader protection. A reader whose process cwd is the primary checkout can block a checkout switch even if its prompt names immutable files. Report that scheduling wait accurately; do not grant an exemption based on prompt text.
9. Keep existing legacy step records readable. Status reads must not modify live GitHub state, run ownership, pinned models, review evidence, or gate evidence.

## Commands

```bash
node tools/step.mjs --self-test
node tools/snapshot-contract.mjs --self-test
node tools/unit.mjs --self-test
node tools/lifecycle-driver.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

## Project structure

- `tools/step.mjs`: status projection, card wording, pending disposition, and self-tests.
- `tools/snapshot-contract.mjs`: reuse its snapshot shape and freshness helpers.
- `tools/unit.mjs` and `tools/lifecycle-driver.mjs`: reuse existing typed disposition/close-out boundaries where required.
- `tools/config-contract.mjs`: reuse the existing merge-policy resolver.
- `skills/dev/SKILL.md`, `skills/pitcrew/SKILL.md`: status reporting guidance where required.
- `tools/regression-index.mjs`, `CHANGELOG.md`: regression registration and user-facing change.
- `tasks/plan-session-recovery-release.md`, `tasks/todo-session-recovery-release.md`: implementation plan and task state.

## Code style

Keep status projection separate from remote effects. Reuse existing typed outcomes and config readers. Use a small table or explicit guards for mutually exclusive display states; do not add a second lifecycle engine.

```js
if (humanGate) return blockedStatus;
if (mergePending) return pendingStatus;
```

## Testing strategy

Write failing tests for a local reconcile marker with current waiting, human-blocked, and repair observations; newer local staged work; stale, malformed, foreign, or incomplete snapshots; an issue absent from a snapshot; manual/automatic/ratified/unknown policy cards; delivered automatic work that reaches the record step but remains merge-pending; and subsequent shipped/human close-out.

Use synthetic fixtures and injected snapshot/configuration readers. Check that rendering makes no GitHub call, does not erase open work, and cannot claim a merge from green checks or elapsed time.

## Boundaries

- Always: show known blockers, preserve unknown cases and open work, distinguish delivered from merged, and retain exact-head safeguards.
- Ask first: new remote queries, a changed merge predicate, automatic repair of run ownership, or checkout scheduling changes.
- Never: hide work by age, weaken the reader guard, clear a human gate, change active pins, or perform a merge from a display command.

## Success criteria

Parked output distinguishes active work from known waits and blocks. Automatic-merge cards do not ask for a human merge unless a human disposition actually applies. Pending automatic work stays visible until its verified outcome. Focused tests and the full gate pass; simplify before independent review.

## Open questions

None about scope. Keep checkout scheduling unchanged; launching staged readers in separate checkouts is separate work.
