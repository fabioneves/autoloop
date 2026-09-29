# Spec: token economy (v0.56.0)

## Objective

Measured on LFE session 80fc93f6 (2026-09-29, 44 min):

- **Calls and context.** 69 API calls averaged 158k tokens of context each, for 10.8M cache-read
  tokens against 27k output tokens. The cost is context size × call count.
- **The floor.** Context starts at 70.6k tokens (host, CLAUDE.md, STATE, preflight). Loading the
  dev skill adds about 50k, and after that it grows about 500 tokens per call.
- **Tool output is small:** about 80 KB across all 69 Bash results.
- **Repeated refusals.** 7 of the 69 calls re-reconciled closed-issue markers that are refused the
  same way every run.
- **Blocked dispatches.** 3 of the 4 dispatches blocked the orchestrator for the host's 600 s
  foreground ceiling.

Operator decision (2026-09-29): do all of the following and release 0.56.

- **M1. Skill byte budgets.** `verify.mjs` holds a per-skill byte budget (`SKILL_BUDGETS`), fails on
  `SKILL_OVER_BUDGET` or `SKILL_BUDGET_MISSING`, and budgets only ratchet down.
- **M2. Lean dev skill** (137 KB → ≤ 60 KB):
  - every instruction is kept;
  - rationale and incident narrative go, since regression-index incidents and git history hold
    them;
  - each rule is stated once;
  - the 25 regression anchors stay verbatim;
  - the budget is lowered to the new size.
- **M3. Background dispatches.** The guard allows `dispatch-stream.sh` with `run_in_background`,
  because it detaches the dispatch.
  - Verified live: TaskStop mid-run, the dispatch finished ok, and `--wait-file` collected it.
  - A bare `dispatch.mjs --role` in the background is still refused.
  - The skill launches dispatches in the background and collects a killed watcher's result with
    `--wait-file`.
- **M4. Known marker refusals.** `lifecycle-driver --reconcile-issue` records a typed refusal with
  the driver's content hash. Prime moves such a deferred marker into `markers.knownRefused` until
  the marker or the driver changes. Gating markers are always attempted.
- **M5. Skill rules:**
  - never estimate an engine's context window or trim a brief to a guessed limit;
  - batch independent reads into one message.

## Not in scope

- **Base-only checkout** (units in worktrees, retiring hook-relay): its own spec, later.
- **The `PREMERGE_CI_COMPONENT_MISMATCH` contract.** M4 stops the cost, not the refusal.

## Success criteria

- `verify.mjs --plugin-root .` exits 0, with each skill at or under its budget and the dev budget
  ≤ 60,000.
- An independent audit of old vs new finds no dropped instruction, or each drop is fixed.
- The next LFE session shows the lower floor. Measure it: context at the first call after the skill
  loads, and the average per call.
