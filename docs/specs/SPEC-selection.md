# Spec: Selection

Module: `selection`. Depends on `loop-daemon`. Index: [Scheduler](SPEC-scheduler.md).
Plan tasks 5–7. This defines module 2 interfaces, not a module 1 queue implementation.

## Objective

Select only authorized work from complete trusted evidence. Reserve issues before planning.
Allocate two independent unit worktrees. Admit writer paths atomically before any edit.
Conflicting units wait rather than write at the same time.

Module 2 completes a synthetic queue/admission path. It has no production unit engine or
publication provider. A request to execute those operations remains `UNSUPPORTED_ACTION`.
Legacy production scheduling remains active until final cutover.

## Tech stack and commands

Use Node ESM, real Git and the daemon checkpoint transaction API. Reuse `repositorySnapshot`
in `tools/scan.mjs`; `verifySnapshot`, `eligibleIssueNumbers`, `markerSchedule`, `unitCard`,
`deliveredPullRequests` and `invalidateSnapshot` in `tools/snapshot-contract.mjs`; wait helpers
in `tools/unit.mjs`. Keep legacy entry points working.

Current commands and required new self-test entry:

```bash
node tools/scan.mjs --self-test
node tools/snapshot-contract.mjs --self-test
node tools/unit.mjs --self-test
node tools/scheduler-selection.mjs --self-test
node tools/scheduler-contract.mjs --self-test
node tools/verify.mjs --plugin-root .
claude plugin validate --strict .
claude plugin test .
```

`tools/scheduler-selection.mjs` becomes executable in module 2. Its self-test uses a synthetic
queue and fake external GitHub only. Do not add a bypass CLI that injects authorized issues
or enables production queue execution before cutover.

## Project structure

- `tools/scheduler-selection.mjs`: root-explicit scan adapter, selection, recovery inventory,
  issue/slot allocation, boundary admission and widening. Embedded self-tests.
- `tools/scan.mjs`, `tools/snapshot-contract.mjs`, `tools/prime.mjs`: root-explicit provider
  extraction and linked-worktree-safe snapshot persistence; preserve legacy commands.
- `tools/unit.mjs`, `tools/lane-contract.mjs`: path/wait providers where suitable.
- `tools/scheduler-contract.mjs`: transactions and versioned reservation/unit records.
- `tools/verify.mjs`: register the new executable/tests.

The current `repositorySnapshot` does not take an explicit root (`tools/scan.mjs:1493`).
The current `persistPrimeSnapshot` constructs `<cwd>/.git/autoloop/prime`
(`tools/prime.mjs:625–631`); linked worktrees have a `.git` file. Fix these assumptions in module 2. Use Git-resolved administrative paths, not string joins
through `.git`. Keep shared reservations in common-directory scheduler state. Store a unit's
snapshot under its verified worktree Git directory. A snapshot reference records that directory,
repository key, base/head OIDs and content digest.

## Provider interfaces

Module 1 supplies the exclusive lease and transaction operations. Module 2 supplies:

```text
scanRepository({ root, pins }) -> validated SnapshotReference
inventoryRecovery({ snapshot, checkpoint }) -> recovery/wait/refusal candidates
reserveIssue(lease, expectedRevision, issueAuthorization) -> UnitReservation|Refusal
allocateWorktree(lease, unitId, baseOid) -> WorktreeBinding|Refusal
admitBoundary(lease, expectedRevision, planCandidate) -> Admission|Wait|Refusal
widenBoundary(lease, expectedRevision, unitId, proposedBoundary) -> Admission|Wait|Refusal
reconcileWaits(lease, completeSnapshot) -> persisted transitions
```

A `Refusal` follows the `autoloop.loop/1` error shape. A `Wait` includes `code`, `unitId`,
`conflicts: [{ type: unit|pr|issue, id, paths }]` and a durable wake condition. Unknown scan facts
cannot prove absence. Recovery work precedes new selection. Paused, draining, halted or
recovering runs admit no new issues. Recheck issue authorization at reservation and writer admission.

`UnitReservation` has schema `autoloop.reservation/1` and required fields `runId`, `unitId`,
`unitGeneration`, `issue`, `repositoryKey`, `issueAuthorization`, `slot`, `baseOid`, `worktree`,
`paths`, `state` and `createdRevision`. `slot` is `1|2`; `worktree` is nullable before allocation;
`paths` is empty before admission. `state = planning|admitted|waiting|recovering|released`.
`issueAuthorization` includes the approved issue/body digest, trusted authorization evidence
and its source IDs. A worker's issue number or claim is not that evidence.

`WorktreeBinding = { root, gitDir, commonDir, repositoryKey, branch, baseOid, createdByRun,
unitId, unitGeneration }`. Verify Git's returned paths and actual branch/head before use.
Use the configured base's verified commit OID, not a mutable shared base ref. Never switch
branches in the coordinator checkout, rewrite its working tree, or move a shared base ref for
snapshot/claim validation. Keep the canonical branch/issue association from `claim-contract.mjs`.

`Admission = { schema: autoloop.admission/1, runId, unitId, unitGeneration, planGeneration,
planDigest, baseOid, boundary, reservationRevision }`. The plan provider in module 3 supplies
real digest/generation values. Module 2 synthetic fixtures use real hashed fixture plans,
not legacy placeholder hashes. This admission is not review or publication authority.

## Admission rules

1. Reserve the issue in one checkpoint transaction before starting planning. One repository
   cannot reserve the same issue twice, including recovery/delivered work. No check-then-write.
2. Allocate at most two working slots. Planning may overlap. The daemon owns creation effects
   through the outbox and verifies worktree creation after an uncertain result.
3. Do not adopt foreign/dirty worktrees. Keep failed/interrupted worktrees and their bindings.
   Do not free a slot or reservation while a worker or edit outcome is uncertain.
4. Validate repo-relative paths: no absolute path, traversal, glob, empty component, `.git`
   alias, symlink escape or unsupported normalization. Use exact file paths and trailing-slash
   directory prefixes. Normalize separators and use filesystem-aware case rules where needed.
5. File/file conflicts on equality. Directory/file conflicts when the file is below the directory.
   Directory/directory conflicts when either prefix contains the other. `src/a/` does not contain
   `src/ab/`. Check both directions, not only files inside the candidate's boundary.
6. Atomically compare the candidate with every active reservation and complete delivered-PR
   file set. `overlapWith` (`tools/unit.mjs:175–182`) currently checks delivered PRs only;
   it is not parallel-writer exclusion.
   Persist all admitted paths before enabling writer tools. Conflicting units remain read-only.
7. Widening uses the same transaction before the additional edit. Retain old paths while a widen
   request waits. A changed plan increments generation through module 3 and invalidates old
   admission/review/gate proof. Protected paths also require the existing authorization policy.
8. Release paths only after verified worker exit and disposition. A delivered PR continues to
   exclude overlapping work through its observed changed files. Merge/closure wakes a waiter
   only after complete readback. Re-plan against the new base in the same unit session before
   readmission; an old plan does not resume writing automatically.

## Code style

Follow module 1 ESM/error conventions. Keep symmetric intersection pure; persistence uses
real daemon transactions. A directory prefix must be tested with its separator:

```js
const containsPath = (directory, file) => directory.endsWith('/') && file.startsWith(directory);
```

This example is one predicate, not the complete symmetric admission algorithm.

## Testing strategy and specific acceptance

Register self-tests in `tools/verify.mjs`. Use real temporary repositories, branches, linked
worktrees, checkpoint files and competing child processes. Fake only external GitHub responses.
Show a failing run before behavior exists and a mutation that the new test detects.

1. Recovery candidates precede new issues; incomplete sections, invalidated evidence, halted
   runs and revoked issue authorization do not admit new work.
2. Two concurrent issue reservations yield one owner. Independent issues obtain slots 1 and 2.
   A third waits. Unknown/live recovered workers keep their reservations.
3. Main and linked checkout snapshots/claims use correct admin paths and the same repository
   identity. Coordinator branch/head/tree and shared base ref remain unchanged.
4. Independent boundaries admit two writers. Equal files, nested directory prefixes, opposite
   prefix directions and widening conflicts admit only one. Test each direction and race.
5. Dirty/foreign/symlinked worktrees are refused without modification or deletion. An uncertain
   worktree creation is reconciled before retry.
6. PR merge/closure releases a wait with verified facts. A moved base requires re-plan and a new
   admission. Protected-path widening cannot start an unauthorized edit.
7. Synthetic queue completion proves selection/admission only. No fake model result, ready PR
   or delivery is produced. Legacy scan/prime tests remain green on Linux and macOS.

## Boundaries

**Always:** root-explicit reads, complete evidence, atomic issue/path reservations, symmetric
prefix checks, admission before edits, real worktree identity and recovery-first order.

**Ask first:** production queue activation, changed authorization policy, worktree deletion,
GitHub mutations outside later approved providers, dependencies and base-policy changes.

**Never:** shared-base-ref hacks; coordinator branch switching; foreign/dirty worktree adoption;
post-edit overlap checks as admission; unknown treated as absent; writer execution without module 3.
