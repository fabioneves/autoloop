# Spec: Repair verification scope

## Objective

Keep Autoloop's verification work inside the approved unit contract, including temporary
helpers that do not appear in the delivered diff. Users are loop operators; consumers are
the orchestrator and its planning, plan-review, implement, and fix roles.

One workflow change covers three linked corrections:

1. Account for auxiliary verification work when planning and reviewing scope.
2. Reassess the proof method before expanding a repair into a new verification system.
3. Preserve executable feedback when an author has file tools but cannot run commands.

The failure to prevent is a small delivered artifact concealing an unplanned verifier,
generator, and control suite, all authored before any runnable result or scope decision.

## Tech stack

Existing Markdown skills and standing briefs, verified by the repository's Node.js ESM
contract checks. No dependencies, runtime protocol, configuration, or permission changes.

## Commands

```bash
node tools/dispatch.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

Use the affected existing self-tests for red/green development; run the full verification
command before completion. No application build is required for this prose-contract change.

## Project structure

- `skills/dev/SKILL.md`: orchestrator scope decisions, dispatch collection, and repair escalation.
- `tools/briefs/plan.md`: planned evidence method and complete auxiliary-work boundary.
- `tools/briefs/plan-review.md`: feasibility and proof-limit checks on that method.
- `tools/briefs/implement.md`, `tools/briefs/fix.md`: writer boundaries and restricted execution handoff.
- Existing contract tests under `tools/`: regressions for the affected instructions.
- `CHANGELOG.md`: unreleased user-facing outcome.
- `tasks/plan.md`, `tasks/todo.md`: downstream local implementation plan and task tracking.

## Required behavior

### Auxiliary work is in scope

Plans identify the evidence domain, existing tools to reuse, any auxiliary verifier or
generator required, what the checks prove, and what still needs source review. Plan review
checks whether this method is feasible with the available tools and covers its stated claims.
Temporary location and exclusion from production-line counts do not exempt auxiliary code
from the work boundary. Existing git-based production-size reporting remains unchanged.

A writer that needs an unplanned evidence model, generator, or control system reports the
method/scope mismatch and partial effects; it does not silently build it or replan itself.
Ordinary helpers already covered by the approved method can proceed without a new ceremony.

### Reassess before expanding a repair

Before dispatching a repair that changes the verification method, including repeated-predicate
whole-invariant escalation, the orchestrator checks whether the complete obligation still fits
the approved method and boundary. Do not require a complete replacement verification system
merely to decide whether to replan or to measure the proposed artifact.

If it fits, preserve the existing complete-invariant fix and review. Otherwise record a scope
or method decision first and use the existing replanning/repair path. Decomposition must name
independently useful slices and how they aggregate to the complete obligation; all unresolved
findings and acceptance criteria remain visible. A validated slice is not complete delivery.

Preserve existing authorization: a repair's successor is an ordinary issue that a human must
queue. Difficult work alone is not a human block, and a permission denial is not bypassed.
Do not add a second initial plan-review dispatch.

### Restricted execution still gets feedback

When the requested work needs execution but the author cannot execute, the brief asks for the
smallest runnable end-to-end slice, its entry point, expected checks, and a representative
failure/control. The author reports unexecuted checks and returns for authorized orchestrator
inspection and execution before further expansion; do not batch an entire untested subsystem.
If a useful runnable slice is not feasible, report that for the method decision above.

The handoff is partial work, not a passed test, closed finding, or completed fix. Existing
writer no-change detection and partial-effects reconciliation stay intact. No dummy checkout
edits to satisfy no-change detection. A tool restriction or denied command must not be
circumvented by delegating that denied action to the orchestrator or another agent.

## Code style

Use the existing short imperative bullets and named-role vocabulary. For example:

```markdown
- Stay inside the frozen plan's boundary; do not replan.
- Never weaken a test, gate or review predicate to clear a finding.
```

Keep policy ownership clear: writers report mismatches; the orchestrator records decisions.
Extend existing contract checks rather than introducing a new framework or duplicated policy.
Keep the current instruction byte budgets; simplify affected wording instead of raising them.

## Testing strategy

Add failing checks for the missing instructions using the existing contract-test idiom, then
make them pass with the smallest brief/workflow edits. Cover auxiliary-work scope in planning
and plan review, reassessment before invariant expansion, writer mismatch handoff, and restricted
execution feedback in both implement and fix paths. Retain checks for existing authorization,
review completeness, writer no-change behavior, and instruction byte budgets.

Static checks prove the instructions are present and connected, not that a model will always
follow them. Inspect the combined standing briefs and orchestrator flow for contradictions.
Live-session validation remains distinct from repository verification; do not claim the stopped
session has received these changes. Simplify before independent review.

## Boundaries

- Always: preserve complete acceptance obligations, open findings, exact-head evidence, role
  permissions, single-writer discipline, and existing repair provenance; verify before commits.
- Ask first: a runtime/schema/configuration change, dependency, permission change, public
  publication, release/install, or intervention in another session.
- Never: add work/time/line/retry caps; relax review or gates; raise instruction byte budgets;
  grant recursive repair authorization; restore restricted tools; delete files without approval;
  commit secrets or host/project-specific incident artifacts.

## Success criteria

- Plans and their review explicitly include auxiliary proof work and its evidence limits.
- Repair-method reassessment happens before commissioning an expanded verification system.
- Writers report a method mismatch rather than expanding or replanning autonomously.
- Restricted authors return runnable partial work for permitted execution before expansion.
- No partial handoff is represented as verified delivery or used to bypass a denied action.
- Existing contract checks and full verification pass, with unchanged instruction budgets.
- Changes are simplified, independently reviewed, and documented in the changelog.

## Open questions

None about scope. Spec approval is required before planning and implementation.
