# Spec: Elastic scope

Module: `elastic-scope` in [Flow](SPEC-flow.md). Depends on
[Review rounds](SPEC-review-rounds.md).

## Objective

A verified finding is fixed where the defect is, inside the unit, even when the file is outside
the frozen plan boundary. A repair issue is filed only when the defect is in another subsystem.
The operator's own rule applies: a bug in the code path being touched is in scope.

## Current state

The frozen plan names a complete file boundary (`tools/briefs/plan.md:12`). A fix outside it
"needs a separate scope decision; `true` grants no edit authority" (`skills/dev/SKILL.md:588`).
The implementer is told to stay within the boundary (line 474). The result is a repair issue for a
defect one directory away, which the loop then queues as a new unit, or a block.

## Required behavior

1. **Widening is a recorded disposition.** When the host verifies a finding whose fix lies outside
   the boundary, it records `widen` in `dispositions.json` with the finding ID and the added paths.
   The fix dispatch receives the widened boundary. No `unit.mjs --decide` is required for a
   widening; the disposition is the record.
2. **Subsystem test.** A path is in another subsystem when it is outside the plan's module seam:
   a different top-level package or service directory, or a path the plan names as out of scope.
   Such a finding is deferred to a repair (`defer`), as today. The host decides which case applies
   and the disposition names the seam.
3. **Review covers the widening.** The next delta round includes the added paths; the closing
   round is full scope on the exact head. The plan comment is not rewritten; the PR body lists the
   widening under `## Scope changes` with the finding ID.
4. **Implementer latitude.** `tools/briefs/implement.md` allows an edit outside the boundary when
   a plan task cannot pass its test without it, and requires the writer to list each such path in
   its result with the reason. The host records those as `widen` before the first review.
5. **Repair limits unchanged.** At most three repairs per parent, depth one, and a repair is
   eligible on creation through its parent's `loop-ready` provenance, so the loop takes it next.
6. **Lane proof.** `lane-contract.mjs` accepts the widened set as the unit's lane for exact-head
   checks, protected-path checks, and the dirty-tree rule. A widening that adds a protected path
   is a `human:authorize` label, not a block.

## Commands

```bash
node tools/review-contract.mjs --self-test
node tools/lane-contract.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/unit.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/review-contract.mjs`: `widen` disposition, widened boundary in evidence.
- `tools/lane-contract.mjs`: lane from the widened set.
- `tools/briefs/implement.md`, `tools/briefs/fix.md`, `tools/briefs/code-review.md`.
- `skills/dev/SKILL.md` steps 5 and 8; PR body composer in `tools/step.mjs`.
- `tools/regression-index.mjs`, `CHANGELOG.md`.

## Testing strategy

Failing tests first: a `widen` disposition adds a path to the evidence boundary and the next
delta round must cover it; a widening into a protected path labels, does not block; an
implementer result listing an extra path is recorded as `widen`; a path outside the seam yields
`defer` with a repair; the dirty-tree rule accepts a widened path.

## Boundaries

- Always: record every widening with its finding ID; keep the closing full round.
- Ask first: a widening into the loop's own control files.
- Never: widen without a verified finding or a failing plan task; widen into a secret path.

## Success criteria

A defect one directory away from the plan boundary is fixed in the unit with a recorded widening
and one delta round. A defect in another service becomes a repair. Self-tests and the full gate
pass.
