# Capability map: Flow

## Objective

Make the loop deliver units with less resistance from its own rules. A run must stop only for a
tool fault it cannot absorb, an action that needs a secret or an irreversible authorization, or a
Critical finding. Everything else is decided, fixed, or recorded by the loop and reviewed by the
operator in the pull request, the same way an attended session works.

## Evidence (2026-07 to 2026-10, one production project, anonymized)

- Guard refusals and policy refusals were the most frequent stop category. Of 98 recorded
  incidents, 16 were guard false positives and 5 were needless waits on a human.
- Protected-path labels parked delivered pull requests under an automatic merge policy. Delivered
  units on the same files then conflicted with each other: nine open pull requests formed two
  conflict groups.
- 33 premise blocks waited for a human decision; most were specification gaps on issues written
  weeks before they were built.
- 12 units reached the code-review round cap of 20. Rounds after the third did not converge; fixes
  introduced new Majors.
- Fixes outside the frozen file boundary became repair issues, which the loop then queued behind
  the stopped run.

## Modules

| Module ID | Responsibility | Depends on | Spec |
|---|---|---|---|
| `guard-reduction` | Keep only the guard rules that prevent an irreversible or unauthorized act. | — | [Guard reduction](SPEC-guard-reduction.md) |
| `protected-path-reduction` | Limit built-in protected paths to secrets, workflows, and the loop's own files. | — | [Protected-path reduction](SPEC-protected-path-reduction.md) |
| `premise-decisions` | Decide specification gaps; block only for authorization. | — | [Premise decisions](SPEC-premise-decisions.md) |
| `review-rounds` | Three fix rounds per predicate, then decide, re-plan once, or defer. | — | [Review rounds](SPEC-review-rounds.md) |
| `elastic-scope` | Let a fix touch what a verified finding requires inside the unit. | `review-rounds` | [Elastic scope](SPEC-elastic-scope.md) |
| `overlap-wait` | Do not start a unit whose boundary overlaps a delivered, unmerged pull request. | `protected-path-reduction` | [Overlap wait](SPEC-overlap-wait.md) |

Build order: `guard-reduction` → `protected-path-reduction` → `premise-decisions` →
`review-rounds` → `elastic-scope` → `overlap-wait`.

## Shared boundaries

- Keep exact-head review and gate evidence, reviewer ≠ writer, trusted marker chains, and the
  session-ownership predicate unchanged.
- Remove rules; do not add configuration switches to keep them optional.
- Every removed rule loses its self-test and its skill text. Skill byte budgets only go down.
- Use synthetic test data. Do not commit session records, host paths, or private project details.
- No live repository intervention, release, installation, or permission change without separate
  approval. A later module, one session per unit, is specified separately after these six run.

## Measurement

Before the release, record on the production project: delivered units per day, operator messages
per day, review rounds per unit, and reverted or reworked pull requests. Compare after one week.
