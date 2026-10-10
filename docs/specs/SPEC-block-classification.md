# Spec: Block classification

Module: `block-classification` in [Session recovery fixes](SPEC-session-recovery.md).
Depends on `revision-recovery` and its typed `REVISION_REQUIRED` result.

## Objective

Prevent a tool recovery fault from becoming a false human decision. A loop operator must receive a human question only for the documented closed human class. Internal failures must retain their evidence and use the supported repair path.

## Tech stack

Use the existing Node.js ESM unit tool and Markdown skills. Add no dependency, configuration setting, or new queue state.

## Required behavior

1. Enforce new human-block reasons before the first GitHub query or mutation. Replace acceptance of any uppercase reason with a closed set:
   - `TRUST_REQUIRED`: a trust or authorization decision that belongs to a human.
   - `IRREVERSIBLE_ACTION`: an irreversible act that needs human approval.
   - `UNSPECIFIED_VALUE`: a missing product or contract value with no clearly better choice.
   - `POLICY_DENIED`: a genuine policy or permission denial; preserve the denial verbatim.
2. A tool refusal, unsupported recovery, unknown reason, or generic `LIFECYCLE_MARKER_INVALID` must not create a human block. Return a typed refusal with the accepted human categories and the repair/decide guidance. Do not silently convert a reason to a permitted one.
3. Dev and Pitcrew consume `REVISION_REQUIRED` as a supported revision path. Preserve its source/current-head evidence. Do not label a valid historical marker malformed because the live PR moved.
4. A genuinely untrusted, malformed, or conflicting authoritative marker remains a safety stop. If resolution needs a human trust choice, use `TRUST_REQUIRED` and ask that specific question. Otherwise report the tool fault and preserve its evidence. Never bypass the driver or weaken a gate.
5. Keep legacy block markers readable for the digest and trusted `/answer` handling. The new creation rule is not a retroactive parser rejection.
6. Do not automatically clear an existing human gate. Previously misclassified blocks can use the existing trusted answer/lift path once the operator authorizes recovery. This change must not invent that authorization.
7. Update the public command guidance and relevant examples together. The closed policy must agree with what `unit.mjs` accepts.

## Commands

```bash
node tools/unit.mjs --self-test
node tools/lifecycle-driver.mjs --self-test
node tools/command-guard.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

Use the existing `node tools/unit.mjs --block --issue N --reason CODE --question TEXT` entry point. Its accepted creation reasons become closed. No application build is required.

## Project structure

- `tools/unit.mjs`: reason validation at the mutation boundary, typed refusal, command usage, and unit tests.
- `skills/dev/SKILL.md`, `skills/pitcrew/SKILL.md`: human classification and lifecycle recovery handling.
- `tools/command-guard.mjs`, `tools/regression-index.mjs`: affected command examples and regression coverage where required.
- `CHANGELOG.md`: accepted-reason change and compatibility note.
- `tasks/plan-session-recovery.md`, `tasks/todo-session-recovery.md`: implementation plan and task progress.

## Code style

Use the existing pure validation and refusal idiom. For example:

```js
if (!HUMAN_BLOCK_REASONS.has(reason)) {
  return refusal('NON_HUMAN_BLOCK_REASON', detail);
}
```

Keep the reason set in one owning module. Do not add a general policy engine or infer trust from free-form question text.

## Testing strategy

Add failing tests that prove an arbitrary uppercase reason and the observed lifecycle-fault reason currently create human blocks. Then cover every supported reason, no-effects refusal, gate validation, legacy marker parsing, digest visibility, and trusted answer/lift behavior. Check that `REVISION_REQUIRED` routes to revision rather than `--block` in the skill contracts.

Use the existing fake command runner to assert that rejected reasons make zero GitHub calls. Keep authorization tests unchanged unless the accepted reason vocabulary requires a fixture update.

## Boundaries

- Always: preserve genuine human choices, denied permissions, historical block records, and trusted answer rules.
- Ask first: new human categories, a permission change, automatic removal of an existing human gate, or live issue changes.
- Never: turn an internal error into a human question, infer a human answer, weaken a gate, or hide a safety refusal.

## Success criteria

Only the closed human reasons can create new human blocks. Recovery faults receive an actionable tool result with no issue mutation. Legacy block records remain readable and answerable. The skills, command usage, tests, and changelog agree. Focused tests and the full repository gate pass; changes are simplified and independently reviewed.

## Open questions

None. The specification is approved.
