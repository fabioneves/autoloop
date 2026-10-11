# Spec: Revision recovery

Module: `revision-recovery` in [Session recovery fixes](SPEC-session-recovery.md).

## Objective

Let Pitcrew start a new revision when an open, owned PR changed after delivery. The old delivered head is A. The current, unreviewed head is B. Recovery must preserve the evidence for A without using it to approve B.

Users are loop operators. Consumers are the lifecycle driver, Dev, and Pitcrew.

## Tech stack

Use the existing Node.js ESM tools and Markdown skills. Add no dependency or configuration setting.

## Required behavior

1. Keep the existing same-head revision request valid. Add an explicit optional `recoveryHeadOid` to the revision request. `expectedHeadOid` still binds A; `recoveryHeadOid` binds B. The field is not a general bypass for a head mismatch.
2. Authenticate the existing marker chain and historical premerge record for A. Check the issue, owned branch, PR identity, claim ancestry, source epoch, source plan, lifecycle identity, and premerge ID/hash/comment. Read the live PR and branch head independently. Require an open, unmerged PR and stable B. Its live base must match the request's configured base before effects and on replay. Refuse a merge operation, incomplete evidence, or a real human gate.
3. Require the new frozen revision plan and current writer authority. Before the first effect, verify both source identity and current-head prerequisites. Keep compare-and-swap and readback checks around each effect.
4. Bind B in the durable revision intent and preserve that binding in revision history. A changed B, a competing request, or a conflicting staged intent must not silently replace the first intent. An interrupted request can replay without duplicate audit entries or repeated completed effects.
5. Start one new `draft-pr` epoch. Preserve the audit for A. Clear active approved-head, premerge, and merge fields. Return the PR to draft during recovery, under the same guarded driver path. Do not carry review or gate approval from A into the new epoch.
6. Require fresh review, the full configured gate, and exact-head finalization for the eventual B or C head. Existing delivery and merge checks stay unchanged.
7. A normal reconcile of a valid delivered-A/current-B state returns a typed `REVISION_REQUIRED` result with source/current heads and the supported revision action. It must not call the trusted marker malformed. Distinguish this case from wrong ownership, an invalid chain, and unrelated identity mismatches.
8. Production evidence reads must support historical A and current B separately. A pure contract test with a synthetic adapter is not sufficient proof of the production path.
9. Existing issue-level human blocks remain authoritative. This module does not clear them, infer a human answer, or edit marker comments outside the owning driver. PR-level `human:authorize` is a merge signal under Dev's publish policy, not a revision block; preserve it without granting merge authority.

## Commands

```bash
node tools/lifecycle-contract.mjs --self-test
node tools/lifecycle-driver.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

The existing entry point remains `node tools/lifecycle-driver.mjs --begin-revision-json`, with its JSON request on stdin. No separate application build is required; the full gate checks tool syntax and contracts.

## Project structure

- `tools/lifecycle-contract.mjs`: strict revision request/intent/history validation, recovery outcome, and pure transition tests.
- `tools/lifecycle-driver.mjs`: authenticated evidence, guarded effects, replay, and production-path tests.
- `skills/pitcrew/SKILL.md`, `skills/dev/SKILL.md`: supported recovery procedure and fresh-evidence requirements.
- `tools/regression-index.mjs`, `CHANGELOG.md`: regression registration and user-facing change.
- `tasks/plan-session-recovery.md`, `tasks/todo-session-recovery.md`: approved task plan and progress, with unrelated content preserved.

## Code style

Use the existing strict object schemas, small pure transitions, and injected adapters. For example:

```js
return transition('resume', 'begin-revision', 'REVISION_REQUIRED', {
  sourceHeadOid: markerValue.headOid,
  currentHeadOid: observed.remoteClaim.headOid,
});
```

Use existing names and error conventions. Add no generic recovery framework. Put verification evidence and rationale in commit messages, not source comments.

## Testing strategy

Add failing fixtures before changing behavior. Use synthetic delivered and current heads for both merge-updated PR shapes. Cover:

- Normal same-head revision and old request/marker readability.
- Delivered A/current B recovery, followed by a genuinely fresh finalization.
- Historical A evidence through the production reader, not only injected transition inputs.
- Replay after each durable effect and exactly one epoch/audit entry.
- B to C races, stale source identity, conflicting intents, and a stable-read failure.
- Wrong PR, branch, author, claim ancestry, plan, or premerge binding.
- Closed or merged PR, merge-in-progress, missing evidence, and real human gates.
- Rejection of A's review/gate evidence for B, including when B already has unrelated green CI.
- No effects for an invalid request or failed prerequisite.

Use existing test shims and adapters. Do not invent a new verifier subsystem or fetch live project data for tests.

## Boundaries

- Always: preserve historical evidence, exact-head approval, actor authority, scoped writes, and replay safety.
- Ask first: a dependency, permission change, unrelated schema change, release/install, live PR intervention, or external publication.
- Never: use A's approval for B, overwrite a marker manually, relax a delivery predicate, clear a real human gate, reset a branch, or merge during recovery.

## Success criteria

Both changed-head fixtures can enter a new unapproved revision through the production driver. Invalid and racing cases fail without unauthorized effects. Fresh review and gate evidence remain necessary. Existing revision behavior and the full repository gate pass. Changes are simplified and independently reviewed.

## Open questions

None. The specification is approved.
