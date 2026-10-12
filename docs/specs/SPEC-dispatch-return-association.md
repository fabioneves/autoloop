# Spec: Dispatch return association

Module: `dispatch-return-association` in [Session recovery fixes](SPEC-session-recovery.md).

## Objective

Make a collected dispatch result identify the work that returned. A late review must not mark a later gate, another review attempt, or a new unit generation as returned. Users are loop operators; consumers are dispatch and status tools.

## Tech stack

Use existing Node.js ESM tools, dispatch result JSON, and repository-local Git metadata. Add no dependency, service, model call, or global setting.

## Required behavior

1. Bind each dispatched attempt to its originating issue and exact step instance before launch. Reuse existing dispatch identity where possible. Include enough identity in the result for collection to distinguish retries, fallbacks, repeated same-role work, and a reopened unit.
2. Parse and validate the result and its association before status mutation. Never assign a returned flag solely to the latest step for an issue.
3. A valid return updates only its matched step and attempt. A stale or duplicate result cannot change the current later step, replace a newer attempt, increment a review round, or reopen a closed unit.
4. Render a matched return using its originating step and result. Do not combine a new step title with an old verdict or model. A previous attempt can be reported as collected without claiming that the latest attempt has returned.
5. Missing, malformed, legacy, or mismatched association data must not assert completion. Use a plain collection line with no status mutation when association cannot be established. Do not discard the dispatch result or alter its success/failure classification.
6. Preserve legitimate off-step roles, including fixes under a review step. Role-to-step name equality alone is not an identity check.
7. Non-dispatch completion needs explicit current-step identity before it can mutate step state. A legacy `--resumed` call without such identity can still print a plain collection line. Gate evidence and publication checks remain authoritative and unchanged.
8. Keep old step records readable. Optional bookkeeping fields must not turn legacy records into a run failure. Do not migrate or rewrite an active run as part of installation.
9. Status bookkeeping must not grant execution permission or weaken writer/reviewer independence, review scope, retries, fallback policy, or exact-head checks.

## Commands

```bash
node tools/step.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

## Project structure

- `tools/step.mjs`: step/attempt identity, result collection, rendering, and self-tests.
- `tools/dispatch.mjs`: launch/result association and fake-CLI integration tests.
- `skills/dev/SKILL.md`: concise collection guidance, only where the interface changes.
- `tools/regression-index.mjs`, `CHANGELOG.md`: regression registration and user-facing change.
- `tasks/plan-session-recovery-release.md`, `tasks/todo-session-recovery-release.md`: implementation plan and task state.

## Code style

Follow existing small exported helpers, injected test boundaries, and typed refusal/fallback conventions. Keep result parsing separate from state mutation. Use an explicit guard rather than guessing:

```js
if (!matched) return plainCollection;
```

Do not add a second dispatch log or a general event framework.

## Testing strategy

Write failing tests first for review launch followed by gate transition before collection; repeated same-role attempts; old duplicate collection; retry/fallback results; a different issue; closed and reopened units; malformed, unreadable, and legacy results; and plain non-dispatch collection. Include a real fake-CLI dispatch path that proves the launch identity reaches the result and is consumed by the status tool.

Check that matched returns retain the correct model, verdict, duration, and review count. Check that unrelated current state is byte-for-byte unchanged on rejected collection. Use temporary synthetic repositories and fake executables, not live runs.

## Boundaries

- Always: preserve dispatch outcomes, old readable records, exact result association, and existing safety checks.
- Ask first: an execution-policy change, new durable data store, or new dependency.
- Never: infer completion from a role name, mutate the latest step before validating its result, change active run pins, or weaken checkout-reader protection.

## Success criteria

A late or duplicate result cannot label newer work as returned. Correctly associated results keep their finished output. Legacy and invalid association data are safe. Focused tests and the full gate pass; simplify before independent review.

## Open questions

None about the required behavior. The implementation plan will select the smallest compatible identity representation.
