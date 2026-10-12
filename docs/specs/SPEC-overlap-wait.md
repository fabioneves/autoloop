# Spec: Overlap wait

Module: `overlap-wait` in [Flow](SPEC-flow.md). Depends on
[Protected-path reduction](SPEC-protected-path-reduction.md).

## Objective

The loop does not open a second pull request on files that a delivered, unmerged loop pull
request already changes. It waits for that pull request to merge, then plans on the merged base.
Conflicting loop pull requests never form.

## Current state

A delivered unit waits for merge (automatic merge pending, CI, or a label). Meanwhile selection
takes the next eligible issue, which often touches the same files; its pull request is delivered
too, and merging either one conflicts the other. On one project nine open pull requests formed
two conflict groups of four and three. `unit.mjs --wait --on-issue <M>` already exists and prime
lifts it when #M closes (`unit.mjs:47`).

## Required behavior

1. **Plan boundary is structured.** The `plan` result carries `boundary: string[]`, the complete
   file boundary as repository-relative paths or directory prefixes, in addition to the prose plan
   body. `INVALID_PLAN_RESULT` refuses a plan without it.
2. **Delivered set.** The scan records, for each open loop pull request at `ready-head` or
   `premerge-record`, its changed file paths. The snapshot section is invalidated when a loop
   pull request merges or closes.
3. **Overlap check at plan review.** After the plan is reviewed and before claim, the host
   compares `boundary` with the delivered set. An intersection means the unit waits:
   `unit.mjs --wait --issue <N> --on-pr <M>` records the pull request number and the overlapping
   paths in the wait comment. Prime lifts the wait when #M merges or closes and marks the unit
   `resumed:`; the resumed unit re-plans on the new base (one `plan` dispatch with the frozen
   plan as input; no new plan review), then claims.
4. **No overlap at premise.** The premise step does not compare; the boundary is not known
   before planning. A dependency on an open issue stays `--on-issue`.
5. **Pitcrew first.** A delivered pull request that conflicts with base after another merge is
   revised by Pitcrew as today. With this module, that path is for human-authored merges, not
   loop-on-loop conflicts.
6. **Staged read-only unit.** The one staged unit may plan while another is delivered; its claim
   is subject to the same check.
7. **Status.** The parked card shows `waits on PR #M (paths)` for a unit held by overlap.

## Commands

```bash
node tools/unit.mjs --self-test
node tools/prime.mjs --self-test
node tools/scan.mjs --self-test
node tools/snapshot-contract.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/parked-disposition.mjs --self-test
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/dispatch.mjs`: `boundary` in the plan result shape; `tools/briefs/plan.md`.
- `tools/scan.mjs`, `tools/snapshot-contract.mjs`: delivered set with changed paths.
- `tools/unit.mjs`: `--on-pr`; `tools/prime.mjs`: lift on merge or close.
- `tools/parked-disposition.mjs`, `tools/step.mjs`: card text.
- `skills/dev/SKILL.md` steps 3 and 4; `tools/regression-index.mjs`; `CHANGELOG.md`.

## Testing strategy

Failing tests first: a plan result without `boundary` is refused; a boundary that intersects a
delivered pull request's files produces a wait with the pull request number and paths; a directory
prefix matches a file under it; prime lifts the wait when the pull request merges and prints
`resumed:`; a resumed unit re-plans once without a plan review; no intersection claims as today;
the card names the pull request.

## Boundaries

- Always: compare against delivered loop pull requests only; keep exact-head rules.
- Ask first: comparing against human-authored open pull requests.
- Never: start a unit whose boundary overlaps a delivered loop pull request; merge base into a
  delivered pull request to resolve a loop-on-loop conflict.

## Success criteria

With two eligible issues on the same files, the second waits until the first merges, then
delivers on the merged base. No two open loop pull requests share a changed file. Self-tests and
the full gate pass.
