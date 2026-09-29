# Spec: run-hygiene

## Objective

Three defects seen in the LFE run on 2026-09-28 (v0.52.0) stop recurring. Each is one concern, with
its own task and commit.

## H1. A rejected tool call parks the run; it never closes it

Evidence, from the LFE transcript:
1. At 03:38:11, `prime.mjs --json` went to a permission prompt.
2. The prompt was answered "no" 11s later (`toolDenialKind: "user-rejected"`). The operator states
   they did not answer it. No other local session sent input, and no Remote Control was attached.
3. At 03:40:21 a plan dispatch finished and woke the turn.
4. The Stop hook demanded "take the next unit, or close if a human asked for the session back"
   (`writeback-check.mjs:540-546`).
5. The orchestrator read the rejection as that request and ran `--close-run` at 03:41:17, with 39
   eligible units queued.

Behaviour:
- Skill (`skills/dev/SKILL.md`, after "Timed park"): a rejected or interrupted tool call with no
  operator message is not a request for the session back.
  - Do not retry the rejected call.
  - Park the run with `prime.mjs --park "tool call rejected; resumes on operator message" --minutes 720`.
  - Arm no wake, and end the turn. The operator's next message resumes the run: a fresh prime
    clears the park.
  - Only an operator's own words asking for the session back close the run.
- Stop hook text (`writeback-check.mjs:540-546`): "a human asked for the session back" becomes "a
  human asked for the session back in a message". Append: "A rejected or interrupted tool call is
  not that request: park instead with `prime.mjs --park "tool call rejected; resumes on operator
  message" --minutes 720`."
- Tests: the `writeback-check.mjs --self-test` hard-gap text names both the message condition and the
  park command. `regression-index.mjs` gets the 2026-09-28 incident.

Not in scope: why the prompt appeared, or what answered it. The logs cannot show either. Adding
permission allow rules for loop tools is the deferred item in `SPEC-permission-surface.md`. A
wildcard rule such as `Bash(node /…/autoloop/*/templates/tools/prime.mjs --json)` also matches a
path-traversal argument, so it needs its own decision.

## H2. Selection and staging draw only from the eligible set

Evidence:
- The orchestrator staged #356 with a read-only agent that ran for 5.5 min, then found #356
  ineligible: its body was edited 2026-09-27, after the `loop-ready` label went on 2026-08-26.
  #355, #357 and #389 are in the same state.
- `eligibleQueueIssueNumbers` (`snapshot-contract.mjs:1155`) already computes the eligible set.
- Prime's summary never prints that set (`prime.mjs:389` prints section counts only), and the dev skill
  never points selection or staging at it. The orchestrator re-derived eligibility with ad-hoc
  `jq`.

Behaviour:
- `prime.mjs --json` summary gains `eligible: [<issue numbers>]`, computed by the exported
  `eligibleQueueIssueNumbers` over the snapshot prime just wrote, in queue order.
  - When a queue or dependency section is incomplete, `eligible` is `null`, never a partial list.
  - The `--summary` accessor in `snapshot-contract.mjs` prints the same field, so a re-derived
    snapshot has it too.
- Skill: step 1 selection and the "Overlap (depth one)" staging rule take units only from
  `eligible` in the current summary. When `eligible` is `null`, follow the existing
  incomplete-section rule.
- Tests:
  - `prime.mjs --self-test`: the summary carries `eligible`, and it excludes an issue edited after
    its `loop-ready` label.
  - `snapshot-contract.mjs --self-test`: the `--summary` output carries the same list, and `null`
    when the queue section is incomplete.

## H3. `stats.mjs` measures a resumed unit's steps against the right terminal

Evidence:
- `stats.mjs` on LFE printed a gate duration of `-357600s` for #334. That distorts the gate
  aggregate's min and mean.
- `computeUnitStats` takes the FIRST terminal label (`stats.mjs:45-46`). #334 was blocked on
  2026-08-28, resumed, and reached `loop:09-gate` on 2026-09-01. The gate step's end fell back to the
  08-28 terminal, before its own start (`stats.mjs:59-60`).

Behaviour:
- A step's fallback end and its stranded check use the first terminal label at or after that step's
  start. `totalMs` is unchanged.
- A step with no terminal, next step or unlabel after its start has `ms: null`, as today.
- Tests (`stats.mjs --self-test`):
  - The #334 shape (blocked, resumed, stranded at gate) → gate `ms` ≥ 0, measured to the later
    terminal or `null`.
  - The existing fixtures are unchanged.

## Boundaries

- Never:
  - Weaken the Stop hook's dark-run gap. H1 changes its wording, not its logic.
  - Compute eligibility anywhere except `eligibleQueueIssueNumbers`.
- Full gate: `node templates/tools/verify.mjs --plugin-root .`

## Success criteria

- All three self-test additions fail before their fix and pass after it.
- `verify.mjs` is green.
- `stats.mjs` on LFE shows no negative durations.
