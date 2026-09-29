# Spec: run-continuity (module of SPEC-self-healing.md)

## Objective

The run never ends, or waits on a human, because of something that concerns only one unit.

From the audit:
- AskUserQuestion waits cost ~25h.
- Uncaught parks cost 3.3h.
- Stop-hook false blocks: 25.
- The prose closes the RUN on "a guardrail failed" (`SKILL.md:1777`) and on any human handoff (`:1790-1793`).
- Usage-limit and red-base parks become run closes, because the Stop hook has no evidence for them (`writeback-check.mjs:408-455`).

## Behaviour

1. **AskUserQuestion is refused while a run is live.**
   - `command-guard.mjs` also answers PreToolUse for `AskUserQuestion`. Claude hook matcher: `Bash|AskUserQuestion`. Codex and opencode are unchanged.
   - While `loopRunIsLive()` is true, the guard denies with this instruction: record the question on the unit's issue, label it `human:decide`, and take the next unit. If no unit can proceed, run `prime.mjs --close-run` first, then ask.
   - With no live run (none open, or closed), the tool passes.
2. **Stop-hook hard gaps apply only to an open run.** Outside an open run (`loopRunIsOpen() === false`), every hard gap is reported as a reminder (exit 0). Human sessions in a loop repo are never blocked (`SKILL.md:82`).
3. **Unpushed work under in-flight evidence is a reminder.** When `runInFlightEvidence`/`dispatchProcessInFlight` reports a running dispatch, `checkUnpushedLoopWork` gaps become reminders: the writer is mid-commit. Without in-flight evidence they stay hard.
4. **Durable timed park.**
   - `prime.mjs --park <reason> --minutes <1..720>` stamps `park: {reason, until}` on the live run markers.
   - `checkDarkRun` treats an unexpired park as in-flight evidence (`run parked until HH:MM: <reason>`).
   - An expired park counts for nothing, so a run that failed to wake is caught as dark.
   - `--close-run` is unchanged. A new `prime` writes a fresh marker, which clears the park.
5. **Prose (`skills/dev/SKILL.md`).**
   - Run-close conditions: queue exhausted, context budget spent, invocation bound reached, or a **run-scoped** guardrail failed. The run-scoped guardrails are a dirty or divergent base checkout, unreadable STATE/config, and a proxy that doesn't answer when every remaining unit needs it.
   - A human handoff blocks the unit and the run continues.
   - Usage limit or red base: park with `prime.mjs --park … --minutes N`, then arm a one-shot session wake (CronCreate/ScheduleWakeup where the host has it) that resumes the run. Never close for these.
   - Never ask the operator a question mid-run (hard rule).

## Boundaries

- Keep: every class-A stop, `stop_hook_active` loop prevention, and the fail-open on infrastructure errors.
- Do not relax the dark-run rule itself. Only add evidence it honours.

## Tests (failing first)

- `command-guard.mjs --self-test`:
  - AskUserQuestion is denied when the run is live and allowed when it is not.
  - The deny text names `human:decide` and `--close-run`.
- `writeback-check.mjs --self-test`:
  - Hard gaps are demoted when the run is not open.
  - Unpushed work is demoted under in-flight evidence and stays hard without it.
  - The park reads as in-flight until it expires and is ignored after.
- `prime.mjs --self-test`:
  - `--park` argument parsing (bounds, missing reason).
  - The park is stamped on own markers only; `--close-run` keeps it closable.
- `verify.mjs`: the hook contract accepts the new Claude matcher.
- `regression-index.mjs`: incidents for the AskUserQuestion waits, the false blocks outside runs, and park-becomes-close.
