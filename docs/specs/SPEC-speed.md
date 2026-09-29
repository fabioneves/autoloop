# Spec: speed (module of SPEC-self-healing.md)

## Objective

One full gate per unit instead of two, started as early as the head is final. Nothing about safety
changes.

## Evidence and scope

| Item | Evidence | This module |
|---|---|---|
| Duplicate full gate: step 9 runs `cfg.gate.command` raw (`SKILL.md` step 9), then `terminal-finalize` runs it again (`publish-verdict.mjs:1893` `executeGateSummary`), and again on every re-invoke after a `did not settle` refusal | 83h of `loop:09-gate` label time on LFE | **Built** (behaviours 1 and 2) |
| Gate waits for the review to close | step 9 follows step 8 serially | **Built** as prose (behaviour 3) |
| `step.mjs` composing label swap, snapshot invalidate, clock and ribbon | none measured | **Deferred**, because per CLAUDE.md we measure before optimizing. It needs per-step turn counts from run transcripts first |
| Task-panel mirror opt-in | none measured | **Deferred**, same reason |

## Behaviour

1. **`terminalGateSummary(snapshot, config, {fetchStatuses, execute})`** in `publish-verdict.mjs`
   recomputes the gate attestation the head would get, from the head, the command hash, the config
   hash and the repository fingerprint.
   - If the head's single `agentic/gate` status carries exactly that attestation's description, the
     function returns it without running the gate.
   - In every other case it runs the gate as today: no status, a different command or config, a
     conflicting status, incomplete evidence, or a failed read.
   - The trust is the same as `ensurePublishedStatus`'s existing reuse. The status is SHA-bound, and
     only `publish-verdict` writes it, which the guard enforces.
   - `terminal-finalize` uses this function.
2. **Step 9** pushes the head, then runs the gate through
   `node <plugin-tools>/publish-verdict.mjs gate <head>` in the background with a log. That command
   runs `cfg.gate.command`, requires the tree to be unchanged and clean, and publishes
   `agentic/gate` only when the gate is green. `terminal-finalize` then reuses it. A red gate
   publishes nothing and follows the existing gate-red path.
3. **Overlap (prose):** when a `full` review round is dispatched for head H, which covers every
   closing round, the same turn starts the step-9 gate on H in the background. A clean round finds
   the gate done or running. A round that gates needs a new head anyway, so the only loss is one
   background gate.

## Boundaries

- Never reuse a status across heads, commands, configs or repositories, or one that conflicts. Never
  skip the gate in the `gate` publisher itself.
- Keep the gate's clean-tree preconditions and the terminal finalizer's other checks unchanged.

## Tests (failing first, `publish-verdict.mjs --self-test`)

- A matching exact-head status is reused and the gate is not executed.
- A status from a different gate command runs the gate.
- An incomplete or throwing status read runs the gate.
- No status runs the gate.
- `regression-index`: one incident pinned to `terminalGateSummary` and the step-9 prose.
