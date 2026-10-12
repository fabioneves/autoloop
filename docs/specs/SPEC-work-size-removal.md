# Spec: Remove work-size quotas and reporting

Module: `work-size-removal` in [Session recovery fixes](SPEC-session-recovery.md).

## Objective

Autoloop must deliver readable, correct work without artificial plan-character, file-count, or changed-line quotas. It must not retain those quantities as informational estimates, counters, or reports. This is an operator requirement, not permission to expand functional scope or protected paths.

## Tech stack

Use existing Node.js ESM tools, Markdown skills/briefs, and typed marker readers. Add no dependency or project-config migration.

## Required behavior

1. Do not invent a plan-character, file-count, or changed-line budget. Do not compress prose, split a correct unit, delay delivery, or stop solely to satisfy such a budget. A model-generated estimate or decision cannot turn a numeric work-size target into an authorization boundary.
2. Remove plan-relative size reduction obligations from simplification and its injected reminder. Simplification still improves clarity and structure without weakening behavior, tests, or accepted requirements.
3. Do not ask planners or writers to estimate, count, or report plan characters, changed files as a numeric total, changed lines, production-line totals, or line deltas. Keep actual changed-path identities where needed for scope and effect inspection.
4. Remove these metrics from generated status/card examples, final cards, current shape/outcome marker emission, and sizing-report text and JSON. Current reports must not expose legacy size fields through nested records.
5. Remove the associated current writer options and plumbing. Historical markers remain readable; serializers and reports project only the current supported fields. Do not invent zero values or require replacement metrics. The retired fields were optional, so retain compatible marker versions where the resulting shape permits it.
6. Remove obsolete work-size measurement advice from command-guard refusal messages without changing the guard's permission decisions. Keep safe file-backed inspection guidance and tools needed for functional tests.
7. Preserve complete readable plan bodies and their exact hashes within the existing supported publication format. Do not impose a smaller arbitrary target. This change does not redesign publication transport or remove parser/memory/output safety bounds.
8. Preserve internal exact-head evidence and conservative review-lane classification. Internal machine evidence used to select full review or prove a complete changed-path inventory is not an informational delivery-size report. Never replace real evidence with fabricated small values.
9. Preserve functional acceptance criteria, authorized path identities, protected-path rules, human gates, test assertions, actual corpus/cardinality contracts, review rounds, stage progress, timing, and outcome identity. Do not change independent case/invariant shaping policy in this module.
10. Do not add a prose-number filter or a new blocking rule to enforce the reporting policy. Update the owning instructions, structured producers, and renderers. Do not rewrite historical plans or live decision records during installation.

## Commands

```bash
node tools/dispatch.mjs --self-test
node tools/step.mjs --self-test
node tools/sizing-contract.mjs --self-test
node tools/stats.mjs --self-test
node tools/label-swap-reminder.mjs --self-test
node tools/command-guard.mjs --self-test
node tools/config-contract.mjs --self-test
node tools/lane-contract.mjs --self-test
node tools/auto-merge.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

## Project structure

- `skills/dev/SKILL.md`, `skills/shape/SKILL.md`, `skills/setup/SKILL.md`: planning, collection, and publication guidance.
- `tools/briefs/{plan,plan-review,implement,fix,simplify}.md`: instructions prepended to dispatched roles.
- `tools/label-swap-reminder.mjs`: injected simplification guidance and tests.
- `tools/step.mjs`: card options, output, and tests.
- `tools/sizing-contract.mjs`, `tools/stats.mjs`: current marker emission, historical reading, and report projection.
- `tools/command-guard.mjs`: refusal wording and matching tests, not guard decisions.
- `tools/dispatch.mjs`, `tools/regression-index.mjs`, `tools/contract-lint.mjs`: positive plan acceptance and regression coverage where needed.
- `docs/specs/SPEC-no-limits.md`: identify the superseded historical exception without rewriting release history.

## Code style

Prefer explicit current-record projections over copying legacy objects into output:

```js
return { issue: outcome.issue, result: outcome.result };
```

Preserve the real required fields in each contract. Do not use a generic recursive field-removal framework, fake counters, or unrelated cleanup.

## Testing strategy

First reproduce size-field emission and budget instructions with failing tests. Cover fresh programmatic and CLI marker output, historical marker input, nested JSON and text report output, current cards, retired options, composed role briefs, and injected reminders.

A readable plan above the former loop-invented target must remain valid with its exact body/hash. Existing large-diff merge fixtures must continue to pass with complete evidence. Unauthorized paths, incomplete lane evidence, malformed payloads, and exact-head mismatches must still fail through their existing checks.

Use synthetic fixtures; do not query or edit live issues, frozen plans, or sessions from tests. Simplify before independent review.

## Boundaries

- Always: remove both enforcement pressure and informational work-size output; preserve readable complete work and genuine authorization/evidence contracts.
- Ask first: a publication transport redesign, case/invariant shaping change, review-lane redesign, new dependency, or permission change.
- Never: replace metrics with zeros, weaken a test to fit a quota, expand authorized paths silently, change an active run, or remove resource protection merely because it uses a number.

## Success criteria

Current Autoloop producers and reports do not collect or publish the specified work-size metrics. Role instructions do not invent or enforce such quotas. Old records remain readable without their size fields leaking into current reports. Verification and safety checks remain intact; the full gate passes.

## Open questions

None about the requested work-size reporting behavior. The shared publication-format ceiling remains unchanged; its protocol redesign is outside this task.
