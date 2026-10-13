# Spec: Review loop

Module: `review-loop`. Depends on `unit-session`. Index: [Scheduler](SPEC-scheduler.md).
Plan tasks 11–12. Module 3 supplies claim/artifact proof first; module 4 extends review consumers.
This is a delivery boundary, not a module 1 reviewer implementation.

## Objective

Run an independent read-only reviewer against the exact admitted plan and code head.
Return findings to the persistent unit session for judgment and fixes. The review ledger, not
worker prose, determines convergence. No plan-review dispatch is added.

Module 4 completes independent reviews and resumed fixes in synthetic integration tests.
A clean review provides publication eligibility evidence, not publication or merge success.
Production still uses the legacy path until final cutover.

## Tech stack and commands

Use Node ESM and existing `tools/review-contract.mjs` providers: `appendRound`,
`reviewTransition`, `artifactFingerprintOf`, `authorizeReviewPublication`, widening and delta
helpers. Use the explicit dispatch permission/tool ceilings and structured review envelopes.

```bash
node tools/scheduler-review.mjs --self-test
node tools/review-contract.mjs --self-test
node tools/unit-proof-contract.mjs --self-test
node tools/unit-session.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/scheduler-selection.mjs --self-test
node tools/verify.mjs --plugin-root .
claude plugin validate --strict .
claude plugin test .
```

The new review runner self-test becomes executable in module 4. Reviewer launch is daemon-owned.
It uses a fresh explicit session/attempt, read-only posture and the pinned review route.
Do not use the unit's `--resume`, or run a reviewer through an operator control bypass.

## Project structure

- `tools/scheduler-review.mjs`: asynchronous reviewer launch, exact artifact input, ledger
  transitions and feedback to the unit provider. Embedded self-tests.
- `tools/review-contract.mjs`: version-discriminated review evidence readers and existing reducer.
- `tools/unit-proof-contract.mjs`: module 3 proof provider, reused without weakening checks.
- `tools/dispatch.mjs`, review briefs and `tools/unit-session.mjs`: independent reviewer boundary
  and persistent feedback continuation. Preserve legacy role/CLI contracts.
- `tools/scheduler-contract.mjs`: one-writer persistence of rounds/attempts and effects.
- `tools/verify.mjs`: executable/test registration.

Review records live in the protected unit Git-admin storage and are referenced from checkpoint.
They are not reconstructed from UI events or a textual model summary.

## Provider interfaces

```text
prepareReview(lease, unitId, codeProof, scope) -> ReviewAttempt|Refusal
acceptReview(lease, attempt, envelope, liveFacts) -> ReviewTransition
continueAfterReview(lease, unitId, transition) -> resumed fix|replan|waiting|clean
authorizeUnitPublication({ claimProof, codeProof, reviewEvidence, liveCheckout }) -> eligibility|refusal
```

Module 3 supplies immutable `PlanReference`, `ClaimProof`, `CodeProof` and persistent sessions.
The reviewer receives the exact artifact bytes plus verified posted-plan identity/content, approved
issue, repository/base, head/tree and review scope. It does not read an arbitrary mutable plan file.

`ReviewAttempt` requires run/daemon generation, unit ID/generation, attempt UUID, fresh session
UUID, role, scope (`full|delta`), round, claim/code proof digests, plan digest/generation, head/tree,
actual reviewer model identity, read-only process binding and expected delta base where applicable.
Bind the reviewer before tools. Its output must match this attempt and the real engine identity.
A worker cannot supply its own author/reviewer identity as trusted evidence.

A new `autoloop.review-evidence/2` envelope binds required `claimProofDigest`, `codeProofDigest`,
`planDigest`, `planGeneration`, `issueAuthorizationDigest`, `repositoryKey`, `baseOid`, `headOid`,
`treeOid`, all actual writer identities, reviewer attempts, config/checklist fingerprints,
round ledger, dispositions and its own evidence digest. Validate all required fields against
provider records and live facts. Preserve each version's exact schema; do not make old fields
optional to accept new evidence. Legacy evidence uses the unchanged legacy validator.

`PublicationEligibility = { schema: autoloop.review-eligibility/2, unitId, unitGeneration,
headOid, treeOid, planDigest, planGeneration, claimProofDigest, codeProofDigest,
reviewEvidenceDigest, repositoryKey, configDigest }`.
Only a verified clean complete full closing review can produce it. Module 5 consumes it alongside
fresh gate/remote evidence. It is not permission to mutate GitHub by itself.

## Required behavior

1. Resolve identities through the existing route/alias normalization and actual served model.
   Reviewer must differ from every model that wrote the artifact, including fallbacks. Different
   effort, context suffix or model alias alone does not prove independence. A route collision
   refuses/reselects under allowed policy; it never silently lets a writer review itself.
2. Read-only means no repository, scheduler-state, GitHub or authorization mutation by reviewer
   tools. Keep command/edit guards and tool ceilings; a review label is not a sandbox.
3. Keep existing full/delta round ledger, finding fingerprints and supported dispositions.
   A fix checkpoint invalidates exact-head eligibility. Delta reviews inspect verified changed
   paths; a full closing review is still required. Delta-only evidence cannot close the unit.
4. The unit session judges findings with evidence, fixes valid findings and reports dispositions.
   Do not accept a caller-authored clean verdict or silently discard unaddressed findings.
   Simplification, if needed after fixes, occurs in the same unit session before review.
5. Retain three fix rounds and one re-plan allowance from the current reducer. Retain the
   reducer's post-budget disposition and Critical handling, including `POLICY_DENIED` where
   required. Do not create an endless restart or a new artificial work-size limit.
6. Widening goes through module 2 admission before edits and existing protected-path policy.
   A changed plan creates a new module 3 artifact/post and invalidates old proof. Waiting on
   overlap is not a clean review or terminal delivery. Re-plan retains the unit session.
7. Tree fingerprint is useful for finding continuity, but publication must also match exact head,
   clean checkout, plan generation and complete evidence. The existing tree fingerprint and
   exact-head publication checks are separate (`tools/review-contract.mjs:1414–1443`).
   An empty commit/rebase with equal tree does not silently inherit exact-head authority.
8. A reviewer crash/unknown result waits or retries as a new verified attempt. Never use stale
   output or rotated event history as a verdict. Controls stay responsive while review runs.

## Code style

Follow module 1 result/error conventions. Reuse pure review reducers rather than parallel logic.
An attempt mismatch is a refusal, for example:

```js
return { ok: false, error: { code: 'REVIEW_ATTEMPT_MISMATCH', message: 'The result names another attempt.' } };
```

Keep findings as data and operator text separate from authorization proof.

## Testing strategy and specific acceptance

Register tests in `tools/verify.mjs`. Use real Git/worktrees, plan artifacts, daemon transactions
and CLI child processes. Fake only the external reviewer/engine and GitHub. Show failing runs
before implementation and detect a deliberate mutation of the new authorization behavior.

1. Reviewer is a fresh read-only session, separate from the resumed unit. Actual writer/reviewer
   aliases and fallback collisions fail independence. Reviewer edits are denied before effects.
2. Legacy fixtures still pass their old checks. New proof rejects altered/missing plan, edited
   posted content, wrong issue/base/head/tree, stale generation and replayed attempt.
3. Full review → resumed fix in the same unit session → delta/full closing review completes
   with real changed Git artifacts. Findings/dispositions remain bound across rounds.
4. Open findings, unauthenticated rebuttal, delta-only closure, dirty checkout and changed head
   cannot produce publication eligibility, even when the tree is unchanged.
5. Three-round exhaustion, one re-plan allowance, Critical handling and widening use the current
   reducer's specified dispositions. Out-of-bound edits fail; widening waits before edits.
6. Reviewer timeout/crash leaves visible durable state. Pause/stop remains responsive; cancelled
   units do not restart automatically. No production publication adapter is invoked.
7. Both CI platforms and existing review/dispatch/ownership tests pass. No paid model call is
   needed to prove these interfaces.

## Boundaries

**Always:** distinct actual models, fresh reviewer session, read-only binding before tools,
exact artifact/head proof, complete closing review and simplify before review.

**Ask first:** changed review policy/budgets, new disposition categories, paid acceptance calls,
permission/route changes and publication activation.

**Never:** plan-review dispatch; separate simplify dispatch; writer self-review; caller-authored
clean evidence; delta-only final approval; dummy proof; publication/merge success in module 4.
