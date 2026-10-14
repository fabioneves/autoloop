# Spec: Unit session

Module: `unit-session`. Depends on `loop-daemon`, `selection`. Index: [Scheduler](SPEC-scheduler.md).
Plan tasks 8–10. Claim/proof foundations belong here, before review module 4 and publication
module 5. This spec does not claim a unit runner exists in module 1.

## Objective

Use one persistent Claude Code session per unit. It plans read-only, then resumes with writer
tools after admission. Test-driven build, verification, behavior-preserving simplification and
fixes stay in that session. There is no plan-review or separate simplify dispatch.
The daemon validates checkpoints; worker prose cannot grant claim/review/delivery authority.

Module 3 completes plan/build/simplify and resumed-fix integration with a fake external engine.
It supplies real versioned claim foundations, including the trusted posted plan. It does not
publish review success, make a PR ready, or perform a merge. Production routing stays legacy.

## Tech stack and commands

Use Node ESM and the installed Claude Code CLI. Reuse route resolution, permission/tool
ceilings, environment construction, result parsing and identity normalization from
`tools/dispatch.mjs`. Do not run its synchronous execution loop inside the daemon control tick.

```bash
node tools/unit-session.mjs --self-test
node tools/unit-proof-contract.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/claim-contract.mjs --self-test
node tools/checkout-contract.mjs --self-test
node tools/lifecycle-contract.mjs --self-test
node tools/scheduler-selection.mjs --self-test
node tools/verify.mjs --plugin-root .
claude plugin validate --strict .
claude plugin test .
```

The first two commands become executable in module 3. Worker argv is daemon-owned, not a
model/operator bypass CLI. This is the required session selection on the installed headless CLI:

```text
claude --print --session-id <unit-session-uuid> --output-format stream-json --verbose ...
claude --print --resume <unit-session-uuid> --output-format stream-json --verbose ...
```

The omitted arguments are the pinned model/effort, explicit tools, posture, settings, structured
result schema and strict MCP restrictions from the verified dispatch provider. They are required,
not inherited defaults. Initial planning uses permission mode `plan` and no writer/Bash tools.
Writer continuation uses the existing validated writer posture, only after persisted admission.
Omit `--no-session-persistence` for the unit. The existing dispatch argv includes it
(`tools/dispatch.mjs:454–461`), so do not use that argv unchanged for persistent units.
Never use `--continue`; it selects an unrelated recent
conversation. Confirm CLI support in implementation tests against the installed reference:
https://code.claude.com/docs/en/headless. No paid model call is part of unattended verification.

## Project structure

- `tools/unit-session.mjs`: asynchronous spawn/resume, binding, streams, result validation,
  planning/admission handshake, checkpoints and interruption. Embedded self-tests.
- `tools/unit-proof-contract.mjs`: plan artifact, trusted posted reference and v2 claim/code
  evidence validation. This provider ships in module 3, not first in review/publication.
- `tools/briefs/unit.md`: later unit brief, containing the unit phases and required checkpoint
  results. It replaces multiple dispatch briefs only on the new path.
- `tools/dispatch.mjs`: reuse/extract safe launch providers; retain legacy CLI and schemas.
- `tools/lifecycle-contract.mjs`, `tools/lifecycle-driver.mjs`, `tools/snapshot-contract.mjs`:
  minimum versioned claim/posted-plan reader support needed by the new handshake/recovery.
- `tools/scheduler-contract.mjs`, `tools/run-markers.mjs` and guards: durable attempts and bound
  worker identity before tools. `tools/verify.mjs`: registration.

The unit's verified `git rev-parse --absolute-git-dir` is its administrative storage root.
Use `<worktree-git-dir>/autoloop/units/<unit-id>/plans/sha256/<digest>.json` for immutable artifacts.
This works for a linked worktree without a `.git` directory. Never put plugin state or a generated
plan file into the target repository just to replace the old hash contract.

## Provider interfaces and persistent identity

```text
startUnitPlan(lease, unitBinding) -> bound Attempt
resumeUnit(lease, unitId, unitGeneration, checkpointOrFeedback) -> bound Attempt
storePlanArtifact(lease, unitId, planGeneration, validatedPlan) -> PlanReference
establishClaim(lease, unitId, planReference, admission) -> ClaimProof|Waiting|Refusal
verifyUnitCheckpoint(lease, attempt, workerResult, observedGit) -> persisted disposition
reconcileUnit(lease, unitId) -> observed/waiting/cancelled disposition
```

`UnitBinding` requires run/repository identity, unit ID/generation, reserved issue authorization,
slot, worktree binding, persistent session UUID and pinned route. `Attempt` adds a new attempt
UUID, daemon generation, phase, actual process/group identity, actual engine session UUID,
stream path and status. Resume keeps the unit/session, not the previous attempt ID.
The stream's returned session ID must equal the assigned/resumed one. Reject cross-unit,
cross-worktree, stale-generation and foreign-session results. Do not accept environment IDs alone.

Prepare and persist launch intent before spawn. Bind the OS process, session, worktree and
posture before any model tool can run. The first tool hook checks the bound attempt; a missing
or uncertain binding refuses tools. A child crash between spawn and registration does not cause
blind replay. Reconcile the process and repository first. Store streams separately from state.

## Immutable plan and versioned proof

`PlanArtifact` uses schema `autoloop.plan-artifact/1` and exactly these fields:
`repositoryKey`, `unitId`, `unitGeneration`, `issue`, `issueBodyDigest`, `authorizationDigest`,
`planGeneration`, `baseOid`, `title`, `prBody`, `body`, `boundary`.
`body` is the complete validated plan text; no summarization replaces it. Hash canonical JSON
using the project's stable serializer and exact UTF-8 strings. Artifact digest is SHA-256 of
those bytes. Create it without overwrite; verify the digest again on every read. An existing
path with different content is an integrity failure. A changed plan has a new generation/digest.

`PlanReference = { schema: autoloop.plan-reference/1, digest, planGeneration, worktreeGitDir,
unitId, unitGeneration, postedPlan }`.
`postedPlan = { repository, issue, commentId, authorLogin, contentDigest, markerDigest }`.
The exact posted body has this versioned marker and the unchanged artifact `body` after it:

```text
<!-- autoloop-plan-v2 {"unitId":"<uuid>","planGeneration":1,"planDigest":"<sha256>"} -->
<exact plan body>
```

Use canonical marker JSON and one newline. `contentDigest` hashes the entire posted UTF-8 body.
Verify author identity through the existing trusted driver/marker rules, not an arbitrary comment
with a matching marker. Bind repository/issue/comment ID, complete body and content digest.
Read back the posted plan through the outbox before establishing the claim. Edited, missing,
wrong-author or incompletely fetched plan comments cannot authorize new work or recovery.
A posted reference is mandatory for new claims, not only for legacy recovery.

`ClaimProof` uses schema `autoloop.unit-claim/2` with required fields:
`runId`, `unitId`, `unitGeneration`, `repositoryKey`, `repository`, `issueAuthorization`,
`planReference`, `baseOid`, `branch`, `claimCommit`, `remoteClaimHead`, `pr` and `proofDigest`.
`issueAuthorization` binds the approved issue and exact body/evidence digests. `pr` is a verified
canonical draft claim PR when the existing lifecycle requires it. Branch/closing text match
`parseLoopClaim`. Local and remote claim containment must be verified. Claim operations are
recorded in the daemon outbox before external effects. Module 3 adds only these foundation effects;
ready/publication/merge remain unsupported until module 5.

`CodeProof` uses schema `autoloop.unit-evidence/2` with required fields:
`claimProofDigest`, `planDigest`, `planGeneration`, `issueAuthorizationDigest`, `repositoryKey`,
`baseOid`, `headOid`, `treeOid`, `unitId`, `unitGeneration`, `writers`, `proofDigest`.
`writers` records every actual engine/model identity that wrote the artifact, including fallback.
All fields are checked against live Git and the immutable claim/artifact. Head and tree are both
required; equal tree alone cannot authorize a moved head. The digest uses canonical JSON without
its own digest field. No dummy `planHash`, fabricated legacy comment ID or optional check.

Define explicit version-discriminated readers. Legacy v1 marker/intents/revisions retain their
current `planHash`, `planCommentId`, exact published content and trusted marker-chain checks.
Never convert a v1 record to v2 by filling missing proof. Unknown versions are refused.
Module 4 extends review readers; module 5 extends final publication/merge readers. Their absent
providers remain unsupported rather than producing legacy-shaped success.

## Unit checkpoint contract

The engine returns schema `autoloop.unit-result/1` with required `runId`, `generation`, `unitId`,
`unitGeneration`, `attemptId`, `sessionId`, `phase`, `outcome` and `data`.
`phase = plan|build|verify|simplify|fix|replan`.
`outcome = checkpoint|waiting|failed|widen-request`; the payload is phase-specific.

Planning returns the structured title/PR body/complete plan body/boundary. The daemon stores the
artifact, posts/verifies the plan, acquires admission and establishes claim before writer tools.
If foundation order requires a local claim edit, that edit also occurs only after path admission.
Planning never edits repository files. A denied plan waits read-only with named conflicts.

Build/fix returns observed commit/head references, test evidence references and checkpoint text.
Verify reports real command exits and head/tree evidence. Simplify reports changed or verified
no-op, with the same evidence binding. A no-op does not require an empty commit. The daemon
checks actual files, diff paths, commits and gate output; `ok` prose is not completion evidence.
Widen-request proposes extra paths and stops before editing them. The daemon obtains new path
admission and authorization before resuming. A changed plan/head invalidates review and gate proof.

The unit brief requires failing behavior tests before implementation, real integration parts,
a deliberate test mutation and behavior-preserving simplification before independent review.
Keep the project's independent gate; unit claims cannot replace it. Review feedback resumes the
same unit session. A missing transcript produces visible recovery waiting, not a new session
silently substituted for it.

## Code style

Use module 1 ESM/error conventions and discriminated result shapes. For example:

```js
return { outcome: 'waiting', code: 'PLAN_REFERENCE_INVALID', unitId };
```

Keep human text separate from proof. Treat engine streams and GitHub responses as untrusted.

## Testing strategy and specific acceptance

Use real temporary Git, linked worktree admin storage, checkpoints, process groups and files.
Fake only external Claude CLI/GitHub. Register self-tests in `tools/verify.mjs`; show red runs
before implementation and detect a deliberate mutation. No paid call or live PR is required.

1. Fake CLI observes explicit initial UUID and the same `--resume` UUID for admitted writing and
   fixes. New attempts have distinct IDs. Planning has no writer tools; no separate simplify or
   plan-review process exists. Session persistence is enabled.
2. Before first tools, the real binding exists. Wrong session, stale generation, wrong worktree,
   route fallback collision and copied IDs cannot create valid results.
3. Real immutable artifacts round-trip. Edited bytes, wrong generation/digest and symlink paths
   fail. Main/linked worktrees use correct admin storage without tracked plan state.
4. New and legacy claim recovery both require trusted posted-plan identity/content. Wrong author,
   edited/missing comment, wrong issue/base, ambiguous branch claim and missing proof fail.
5. Module 3 foundation readers validate v2 without dummy legacy data; old fixtures remain valid
   through unchanged v1 checks. Unsupported review/publication never reports success.
6. Fake-engine integration completes plan/build/verify/simplify, accepts fix feedback and resumes
   the same session. Real Git/tests prove effects, no-op simplification and changed-head invalidation.
7. Crash after edits or remote claim effect is reconciled before resume. Live children are not
   duplicated. Verified descendant cancellation retains streams/worktrees and prevents auto retry.
8. Linux/macOS self-tests, existing dispatch/claim/lifecycle tests and the full gate pass.

## Boundaries

**Always:** bind before tools; plan before writing; reserve before widened edits; real artifact and
posted-plan proof; persistent session for fixes; independent gates; retain interrupted evidence.

**Ask first:** paid engines, transcript migration, production claims, unsupported legacy transitions,
new credentials/dependencies, permission changes and worktree deletion.

**Never:** `--continue`; dummy legacy proof; optional posted-plan validation; tracked plugin plan
state; first-party mocks; blind writer replay; separate simplify/plan-review dispatch; ready/merge
success before the delivery provider exists.
