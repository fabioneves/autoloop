# Capability map: Scheduler

Item 7 of the flow analysis ([Flow](SPEC-flow.md)). Built after [Events and control](SPEC-events.md)
and [Central](SPEC-central.md), against the same contracts.

## Objective

Replace the thirteen-step orchestrator, a Claude session that re-reads its context on every step,
with a Node process that selects an issue, runs one unit session for it from plan to pull request,
runs the reviewer against it, merges, and records. The operator's Claude session starts the
scheduler, shows it in the central, and controls it there. The loop has no orchestrator context,
so it has no compaction, no handoff, and no step bookkeeping for a model to narrate.

## Operator decisions (2026-10-12)

1. A Node scheduler, `tools/loop.mjs`, not a thin Claude scheduler.
2. A daemon: `/autoloop:dev` starts it under `systemd-run --user` with the same caps the gate uses;
   closing the session or the pane does not stop it. `/autoloop stop` (a `stop` control) ends it
   after the running units finish; `/autoloop stop now` cancels them.
3. One unit session per issue, `claude -p` with `stream-json`, from plan to pull request in one
   context; fix rounds resume the same session (`--resume`). The reviewer is a separate `claude -p`
   with the read-only posture, never the writer's session. Plan review is dropped: the reviewer
   reads the posted plan with the code.
4. Two units at once, each in its own worktree; overlap wait keeps them off the same files.
5. The labels `loop-started`, `delivered`, `blocked` stay.
6. The central is the only UI; the scheduler writes events and consumes controls, nothing else
   reaches the operator.

## Modules

| Module ID | Responsibility | Depends on | Spec |
|---|---|---|---|
| `loop-daemon` | Start, stop, pid file, one scheduler per checkout, the 1 s tick, the control consumer. | `events` | later |
| `selection` | Prime, snapshot, eligibility, overlap wait, two slots, worktrees. | `loop-daemon` | later |
| `unit-session` | The unit brief, the `claude -p` launch, the live file, the result contract, resume for fixes, the unit's own gate run. | `loop-daemon` | later |
| `review-loop` | Reviewer dispatch, verdict, three fix rounds then re-plan once, Critical to `POLICY_DENIED`, widen. | `unit-session` | later |
| `deliver-record` | Draft to ready, auto-merge, labels, record, Pitcrew. | `review-loop` | later |

Build order: `loop-daemon` → `selection` → `unit-session` → `review-loop` → `deliver-record`.
Each module is one release; the step machine keeps running the production loop until
`deliver-record` ships, and the dev skill is retired then.

## Shared boundaries

- Keep: reviewer ≠ writer, exact-head review and gate evidence, the run latch and session
  ownership (the scheduler holds the latch; the session that started it owns the run), trusted
  marker chains, auto-merge predicates, protected paths, the dependency hard-defer, Pitcrew.
- Drop: step labels per step, step records, receipts, frozen-plan hash binding (the plan is a
  file in the unit's worktree the reviewer reads at exact head), the staged unit, the dev skill.
- The unit session's brief is the dev skill's "One unit" section rewritten for one context: the
  phases, the gate, the pull request body, the result file. The guard applies to it as to a
  dispatch today.
- Everything the operator sees comes from events; everything the operator does goes through
  controls.
- No live repository intervention, release, installation, or permission change without separate
  approval.

## Measurement

Before the first module: delivered units per day, operator messages per day, review rounds per
unit, tokens per unit (from the proxy), on the production project over one week. Compare after
`deliver-record` runs one week.
