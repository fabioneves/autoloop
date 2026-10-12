# Spec: Premise decisions

Module: `premise-decisions` in [Flow](SPEC-flow.md).

## Objective

A specification gap is decided by the loop and recorded on the issue, so the operator reviews the
decision in the pull request. A block is used only when the loop needs something it must not
create: a secret, an irreversible external action, or a policy exception.

## Current state

`tools/unit.mjs:69-71` accepts four block reasons: `TRUST_REQUIRED`, `IRREVERSIBLE_ACTION`,
`UNSPECIFIED_VALUE`, `POLICY_DENIED`. The dev skill (lines 333-383) sends ambiguity and open
design choices to `--decide`, and `human` cases to `--block`. In practice the planner reads a
contradiction between an issue and the specification as `TRUST_REQUIRED` or `UNSPECIFIED_VALUE`
and blocks. On one project 33 units blocked this way; ten of them in one hour on a batch of
decision-shaped issues.

## Required behavior

1. **Block reasons.** `--block` accepts `IRREVERSIBLE_ACTION` (an external action that cannot be
   undone: production write, provisioning, a message sent) and `POLICY_DENIED` (the loop needs a
   secret, a new dependency install, a permission, or an exception to a STATE rule).
   `TRUST_REQUIRED` and `UNSPECIFIED_VALUE` are refused with a remedy that names `--decide`.
2. **Decide is the default.** A contradiction between the issue and the specification, a
   missing acceptance value the loop can choose, an open design choice, a ratification question,
   or a scope question is decided with `unit.mjs --decide`. The decision comment records the
   question, the choice, the alternatives, and the evidence.
3. **Decisions are visible in the pull request.** The pull request body lists every decision of
   the unit under `## Decisions`, each with its issue comment link. The run record repeats the
   list. The parked card shows a decision count per unit.
4. **Reversal path unchanged.** A trusted `/answer` after a decision reverses it; the loop plans
   from the answer and never re-takes the decision (dev skill, lines 355-360).
5. **Planner brief.** `tools/briefs/plan.md` instructs the planner to decide, not to request
   ratification, and to carry each decision into the plan's premises. The plan-review brief
   checks that a decision is recorded, not that it was approved.
6. **Existing blocks.** Open blocks keep their labels and comments. A resumed unit whose block
   reason is now refused is treated as decided by the `/answer` that lifted it.

## Commands

```bash
node tools/unit.mjs --self-test
node tools/step.mjs --self-test
node tools/parked-disposition.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/unit.mjs`: `HUMAN_BLOCK_REASONS`, refusal remedy, decision comment format.
- `tools/step.mjs`, `tools/parked-disposition.mjs`: decision count on cards; `## Decisions` in
  the PR body composer.
- `tools/briefs/plan.md`, `tools/briefs/plan-review.md`, `skills/dev/SKILL.md` Autonomy table.
- `tools/regression-index.mjs`, `CHANGELOG.md`.

## Testing strategy

Failing tests first: `--block --reason TRUST_REQUIRED` and `UNSPECIFIED_VALUE` are refused with
the `--decide` remedy; `IRREVERSIBLE_ACTION` and `POLICY_DENIED` still block; a decision comment
round-trips with question, choice, alternatives, and evidence; the PR body composer lists two
decisions; a card shows the count; a later `/answer` reverses a decision and the premise step
reads the answer.

## Boundaries

- Always: record every decision on the issue before planning from it.
- Ask first: adding a new block reason.
- Never: decide a secret value, a dependency install, or an external irreversible action.

## Success criteria

A batch of decision-shaped issues is planned and delivered with recorded decisions and no block.
A unit that needs a secret still blocks with `POLICY_DENIED`. Self-tests and the full gate pass.
