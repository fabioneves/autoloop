# Spec: Deliver and record

Module: `deliver-record`. Depends on `selection`, `review-loop`. Index: [Scheduler](SPEC-scheduler.md).
Plan tasks 13–15. This is the final delivery/cutover boundary, not a module 1 GitHub adapter.

## Objective

Deliver independently reviewed units through the existing gate and lifecycle. Preserve trusted
issue/PR association, protected-path authorization, terminal labels and exact-head merge policy.
Reconcile uncertain remote effects before retry. Integrate revisions and Pitcrew without taking
over human work. Activate the new production path only after full acceptance and separate approval.

## Tech stack and commands

Use Node ESM, real Git and the existing GitHub CLI boundary. Reuse `driveLifecycle`,
`driveLifecycleRevision`, `finalizeTerminalDelivery`, terminal readbacks and auto-merge predicates.
Use module 3 claim/code proof and module 4 publication eligibility without dummy v1 fields.

```bash
node tools/scheduler-delivery.mjs --self-test
node tools/lifecycle-contract.mjs --self-test
node tools/lifecycle-driver.mjs --self-test
node tools/publish-verdict.mjs --self-test
node tools/delivery-contract.mjs --self-test
node tools/merge-authorization-contract.mjs --self-test
node tools/auto-merge.mjs --self-test
node tools/unit-proof-contract.mjs --self-test
node tools/review-contract.mjs --self-test
node tools/verify.mjs --plugin-root .
claude plugin validate --strict .
claude plugin test .
```

`tools/scheduler-delivery.mjs` becomes executable in module 5. No live `gh` mutation is a test
command here. Daemon remote controls gain adapters only when their full predicates are tested.
`/autoloop:dev` changes to start/attach only at separately approved final cutover, not at module 1.

## Project structure

- `tools/scheduler-delivery.mjs`: asynchronous daemon delivery/revision adapter and outbox
  reconciliation. Embedded self-tests.
- `tools/lifecycle-contract.mjs`, `tools/lifecycle-driver.mjs`, `tools/publish-verdict.mjs`,
  `tools/delivery-contract.mjs`, `tools/merge-authorization-contract.mjs`,
  `tools/auto-merge.mjs`: explicit v2 readers and existing publication/merge rules.
  `terminal-finalize` is a subcommand of `publish-verdict.mjs`, not a separate file.
  Retain old validators/readers.
- `tools/snapshot-contract.mjs`, `tools/scan.mjs`: new lifecycle/terminal evidence inventory.
- `skills/pitcrew/SKILL.md`: supported scheduler revision path, after its provider exists.
- `skills/dev/SKILL.md`: launch/control description only after deliberate cutover.
- `tools/regression-index.mjs`, `tools/verify.mjs`: map old enforcement anchors to new providers
  before retiring legacy-only bookkeeping; register new tests.

Keep records in protected Git-admin state and existing trusted remote marker chains.
The UI receives producer projections, not lifecycle internals or raw GitHub command output.

## Provider interfaces

```text
prepareDelivery(lease, unitId, publicationEligibility, gateEvidence) -> DeliveryIntent|Refusal
driveUnitDelivery(lease, intent, observations) -> delivered|waiting|refused
reconcileDelivery(lease, operationId, completeRemoteFacts) -> applied|not-applied|unknown
prepareRevision(lease, unitId, sourceOwnership, expectedHead) -> RevisionIntent|Refusal
recordTerminal(lease, unitId, completeFacts) -> TerminalReceipt|Refusal
inventoryCutover({ repository, legacyRuns, workers, lifecycleRecords }) -> safe|waiting|refused
```

`DeliveryIntent` uses schema `autoloop.delivery-intent/2`, with required run/unit/generation,
repository/issue/PR/branch identity, `claimProofDigest`, `planReference`, `codeProofDigest`,
`publicationEligibility`, `gateEvidence`, `expectedHead`, `expectedTree`, `baseOid`,
`configDigest`, `mergePolicy` and `intentDigest`.
`gateEvidence` binds command/config fingerprint, exact head/tree, clean checkout, verified exit
and independent gate identity. Worker prose cannot fill these fields.

`RevisionIntent` additionally binds source trusted lifecycle marker/record, previous reviewed
head, observed delivered head, posted-plan reference and a new revision identity. Validate
ownership before creating or reusing a claim. A changed head never receives copied old evidence.

`TerminalReceipt` uses schema `autoloop.terminal-receipt/2`, with required run/unit/issue/PR,
claim/code/review/gate digests, delivered head, nullable verified merge OID, terminal disposition,
remote record/label readback identities and receipt digest. `delivered` is not `merged`.
Pending or unknown merge outcome remains waiting; it cannot produce a merged terminal receipt.
Remote trusted marker/record envelopes need explicit versioned serializers/parsers consistent
with these proofs. Never weaken v1 schemas to accept v2. Unknown/incomplete records are refused.

## Required behavior

1. Verify live issue authorization, canonical branch/closing claim, trusted posted plan and
   complete marker chain before delivery. Revalidate exact reviewed head/tree and clean checkout.
2. Run the existing independent final gate. Retain draft-to-ready order, post-ready check settling,
   finalizer readbacks and evidence freezing at the correct point. Red/pending CI cannot become
   success from pre-ready evidence or an empty triggered-check set at a bare claim head.
3. Preserve configured merge policy, manual authorization and protected-path checks. A control
   cannot bypass a gate. `label` removes only the currently supported `human:authorize` condition
   on a verified loop PR after an explicit operator request; it is not arbitrary relabeling.
4. Serialize branch publication and merge resources across both slots. Recheck target head and
   policy before each effect. Exact-head compare-and-swap submission and required server-side
   predicates stay in effect. An in-tool refetch alone does not close a merge authorization race.
5. Record operation intent before external effects and durable outcomes before acknowledgment.
   On timeout/crash, read back actual PR, comment, branch, label or merge facts. Search by trusted
   operation/marker identity and verify content, actor and head. Retry only verified not-applied
   effects. An ambiguous readback remains `OUTCOME_UNKNOWN`, not an automatic repeat.
6. Record `loop-started`, `delivered` and `blocked` under existing lifecycle rules. Stop creating
   per-step labels/receipts for new daemon units only after their consumers use durable attempt
   and proof identities. Preserve reviewer attempts, fingerprints and final gate evidence.
7. Delivered revisions use supported lifecycle transitions and fresh review/gate evidence.
   Pitcrew only services Autoloop-owned PRs in its approved conditions. Detect conflicts and
   external/human edits; do not silently adopt, overwrite or recreate their claim ownership.
8. Keep controls responsive during publication/check waits. Graceful stop can store a delivered,
   CI/merge/human waiting disposition and finish without waiting indefinitely. Unknown effects
   remain recoverable. Immediate operator cancellation does not schedule automatic continuation.

## Cutover boundary

Inventory legacy runs, live/inherited dispatches, worktrees and lifecycle evidence before routing
changes. Module 1 mutual exclusion still applies, including simultaneous starts from linked
worktrees. Do not start both schedulers for one common directory.
Old-version runs and detached dispatches must be drained before activation, and participating
sessions must use upgraded entry points. The shared gate cannot retroactively coordinate old binaries.

Drain legacy work or use its existing supported recovery. Retain legacy published-plan/hash
validation and old record readers. Unsupported legacy phases remain refused with a reason,
not converted by missing-field defaults. Do not close PRs, relabel live issues, terminate sessions
or delete worktrees as an incidental migration step.

After synthetic full acceptance and separately approved activation, `/autoloop:dev` starts or
attaches to the daemon. Central remains inside Claude Code with no model wake prompt for daemon
controls. The dev skill becomes launch/control guidance. Retire old-only enforcement only after
mapping each regression anchor to a tested new provider. Do not remove readers needed by old PRs.
Release merge, tag, installation and live migration remain separate approvals.

## Code style

Use module 1 ESM/error conventions and existing pure lifecycle decisions. Keep external
observations separate from effects. An uncertain effect must remain explicit:

```js
return { outcome: 'waiting', code: 'OUTCOME_UNKNOWN', operationId };
```

No credentials, private repository names or real host paths in public fixtures or remote records.

## Testing strategy and specific acceptance

Use real temporary Git repositories/worktrees, local remote repositories, checkpoints, locks and
processes. Fake only external GitHub/Claude/supervisor/host APIs. Assert durable outcomes and
observed state, not first-party call order. Register tests, show failing runs before implementation
and detect deliberate mutation of exact-head/outbox behavior.

1. Legacy v1 recovery remains valid only with its exact trusted posted plan and existing hashes.
   New v2 delivery validates every proof field; missing/edited plan content and changed head/tree
   cannot publish or merge.
2. Red/pending CI, policy change, protected-path authorization, post-ready checks and moved heads
   produce truthful waiting/refusal. Exact-head and server-side merge predicates are preserved.
3. Crash after PR/comment/label/merge effect, before receipt and before ack is reconciled. Unknown
   outcomes do not repeat effects or produce terminal success. Duplicate controls replay receipts.
4. Both writers can deliver independent branches; shared merge/branch resources serialize.
   Conflict repair and changed delivered heads require fresh revision, review and gate evidence.
   External human edits and unsupported legacy transitions are refused without destructive action.
5. Full synthetic scenario: trusted queue → two independent worktrees → read-only plans → atomic
   path admission → persistent build/simplify → independent review → resumed fix → full closing
   review → final gate → delivery/merge/record. A third conflicting unit waits and replans after
   complete dependency readback. Restart at effect boundaries retains authority and work.
6. Central shows both units, real streams, waits, errors and durable control outcomes. User pause,
   resume, cancel, answer, merge/authorize and graceful/immediate stop work through their gates.
   Viewer exit/reattach does not interrupt execution; no background Bash/tmux path is used.
7. Final routing is not enabled by these tests. Both CI platforms, strict plugin validation,
   plugin tests and the full resource-capped gate pass before activation approval.

## Boundaries

**Always:** trusted versioned proof, fresh independent gates, exact-head merge checks, remote
readback, unknown-outcome retention, legacy readers and deliberate cutover.

**Ask first:** live GitHub mutations/migration, PR closures, label changes, service activation,
release/install, paid acceptance calls, permission/dependency changes and worktree deletion.

**Never:** concurrent legacy/daemon schedulers; false exactly-once claim; copied proof on a changed
head; unsupported-phase success; human-work takeover; silent destructive migration; automatic
production activation from plan approval.
