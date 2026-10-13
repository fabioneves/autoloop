# Capability map: Scheduler

Item 7 of [Flow](SPEC-flow.md). Providers: [Events and control](SPEC-events.md) and
[Central](SPEC-central.md). Approved plan: `tasks/plan-scheduler.md`.
Checklist: `tasks/todo-scheduler.md`. This map specifies the new path, not its activation.

## Objective

Replace the model scheduler with a Node daemon. The operator uses Central inside Claude Code.
Two isolated unit worktrees can operate at the same time. Each issue has one persistent unit
session. Fixes resume that session. A separate read-only reviewer uses a distinct model.

The daemon owns scheduling and durable state. Central is a viewer and control client.
Closing a viewer does not stop a run. No tmux pane or host background Bash job is required.

## Approved capability map

| Module ID | Responsibility | Depends on | Specification |
|---|---|---|---|
| `loop-daemon` | Supervision, repository lock, checkpoint, outbox, controls, worker bindings, viewer attachment. No production queue. | `events`, `central` | [SPEC-loop-daemon.md](SPEC-loop-daemon.md) |
| `selection` | Root-explicit trusted snapshots, issue reservations, two slots, worktrees, atomic path admission and widening. | `loop-daemon` | [SPEC-selection.md](SPEC-selection.md) |
| `unit-session` | Persistent session, read-only plan handshake, immutable plan artifact, versioned claim foundation, build/test/simplify checkpoints and interruption. | `loop-daemon`, `selection` | [SPEC-unit-session.md](SPEC-unit-session.md) |
| `review-loop` | Independent reviewer, exact-head proof, full/delta ledger, resumed fixes, three fix rounds and one re-plan. | `unit-session` | [SPEC-review-loop.md](SPEC-review-loop.md) |
| `deliver-record` | Publication, final gate, merge reconciliation, labels, terminal records, Pitcrew and deliberate cutover. | `selection`, `review-loop` | [SPEC-deliver-record.md](SPEC-deliver-record.md) |

Build order: `loop-daemon` → `selection` → `unit-session` → `review-loop` → `deliver-record`.
Each module has a separate release boundary. Approval of the plan is not approval to merge,
tag, install, activate a service, or change production routing.

Module 1 is complete when supervised lifecycle, durable controls/status and Central attachment
work. It does not select production issues. Later module specs define provider interfaces and
acceptance conditions. An absent provider reports `UNSUPPORTED_ACTION`; it never returns a
simulated success. Claim foundations ship in module 3, before review and publication readers.

## Shared contracts

- One scheduler per canonical common Git directory, including all linked worktrees.
  Exclusive acquisition includes both daemon start and legacy prime start.
- Keep initiating session, daemon owner, bound worker and attached viewer identities separate.
  An ordinary session is not a viewer or writer. Attachment gives no writer latch.
- Bind processes to start identity, boot identity and scheduler generation. Pin plugin path,
  version, effective configuration and model routes for a run. A PID alone is not authority.
- Checkpoint and outbox are authoritative. One daemon writer serializes state transitions.
  Events are fail-open UI data. Never reconstruct state from rotated logs.
- Durable controls bind request ID, run and target generation. Claim atomically, deduplicate,
  store an outcome, and reconcile uncertain effects before retry. Do not promise exactly-once
  GitHub effects.
- Operator actions enter through a trusted mod/host invocation. Model tools cannot attach,
  issue controls, or change scheduler state. `by: ui`, a session string, and user-set environment
  variables do not establish operator authority. Same-OS-user processes are not a security
  isolation boundary.
- Reserve an issue before planning. Reserve paths atomically before writer tools or any widened
  edit. Check both active units and delivered PR paths. Directory-prefix overlap is symmetric.
- The coordinator checkout never changes branch. Allocate worktrees from verified base OIDs.
  Respect worktree-scoped Git-admin storage; do not change a shared base ref to satisfy a check.
- The plan is immutable and content-addressed in protected worktree-scoped Git-admin storage.
  New claims require a trusted posted-plan identity and its exact content, as legacy recovery
  does. A versioned proof binds plan digest/generation, approved issue, repository/base and
  exact head/tree. No dummy legacy hash and no optional authorization check.
- Keep old evidence validators/readers. Keep trusted marker chains, reviewer attempts,
  fingerprints, independent gates, protected-path authorization and exact-head merge predicates.
- Use the pinned implementation model for planning, writing, simplification and fixes in the
  unit session. No separate simplify or plan-review dispatch. Review stays separate and distinct
  from every actual writer model, including fallback models.
- Graceful stop drains to completed or persisted waiting dispositions. Immediate stop cancels
  verified process groups. Operator-cancelled work does not restart automatically.
- Never persist credentials or complete launch environments. Never adopt, replace or delete
  foreign or dirty worktrees.

These contracts replace the old map's per-checkout ownership, worktree plan-file and dropped-hash
wording. The released `events` and `central` behavior remains the legacy path. Versioned daemon
protocols stay behind the compatible `autoloop.status/1` producer.

## Commands and structure

Executable commands, source locations, style, tests and boundaries are defined in each linked
module spec. No new executable exists merely because its command appears in a specification.

Current checks for this specification-only change:

```bash
git diff --check
git diff --cached --check
```

Do not change the initiative plan or checklist in this specification task.

## Acceptance and delivery boundaries

1. Each module spec covers objective, commands, structure, style, tests and boundaries.
2. Module 1 defines executable lifecycle/control/status contracts. Its tests use real temporary
   Git repositories and processes. External effect tests prove outbox crash reconciliation.
3. Modules 2–5 define interfaces and separate completion conditions without claiming their
   implementation in module 1.
4. The legacy production path remains until module 5 passes full acceptance and cutover is
   separately approved. Either start path refuses when the other owns the repository.
5. Full acceptance includes queue trust, independent concurrent work, conflict waits, persistent
   fixes, independent review, gated delivery, merge recovery and all Central controls.
6. No real service, paid model call, GitHub mutation, worktree deletion, or live migration occurs
   during specification or unattended synthetic verification.

## Measurement

Compare delivered units, operator messages, review rounds and model tokens before and after
approved final cutover. Use measured production data. Do not report informational file, text or
changed-line counts as limits or completion evidence.
