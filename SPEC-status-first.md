# Spec: status-first orchestrator

## Objective

The orchestrator's window reads as the loop's status: ribbons, parks, results and closing
cards. Machinery stays out of the way. Two constraints hold throughout:
- It is **folded, never hidden.** Mechanics move into single plugin calls. No mutation, failure
  or refusal is ever muted.
- It is **trouble-free.** Rendering can never block the loop, and every new call is idempotent
  and reuses an existing contract instead of re-deciding one.

### Evidence

LFE session 0bf7f2f2 on v0.53.0, unit #350, 09:09–09:51. The main thread printed 14 status
ribbons across roughly 120 tool calls:

| Visible calls | Kind | Why they exist |
|---|---|---|
| 45 | TaskCreate / TaskUpdate / TaskGet | One task per step, a cost stamp on completion, newest-first rewrites, prune to four (`skills/dev/SKILL.md:760-840`) |
| 33 | `jq` / `rg` / `sed` / `Read` | Digging through the snapshot and files by hand for facts a typed accessor could return |
| 6 | `Write` (19 KB) | Dispatch briefs; about half of each is standing role text the orchestrator rewrites from memory (read #350's plan-review, implement and simplify briefs) |
| 4 + 4 + 5 | label swaps, prime/snapshot, `date` | Around every step: read the clock, swap labels, invalidate the snapshot, then compose a ribbon by hand |
| 5 | dispatch | The work itself |

Hand composition is also where the loop fails: jq syntax errors, the 33 hand-built reconcile
requests, staging #356 without an eligibility check, ribbons printed before the park was
recorded.

## Modules (build order)

### M1. `step.mjs`: one call per step transition

```
node <plugin-tools>/step.mjs --issue <N> --to <NN-name> [--round <r>/<cap>] [--executor <MODEL>]
                             [--badge ⏳|🚧|✅|❌|⚠️] [--note "<suffix>"]
node <plugin-tools>/step.mjs --issue <N> --resumed "<what fired>" [--ms <n>]
```

- **`--to`:**
  - Swaps the step label with both halves (`--remove-label loop:<prev> --add-label loop:<to>`).
    Steps 10 and 11 carry no label.
  - The swap command is first passed to the command guard's own `evaluate()`
    (`command-guard.mjs:1931`). A guard refusal is printed verbatim and the tool exits 1, so the
    ladder rules (no backward swap, no unknown label, both halves) cannot drift from the guard.
  - Invalidates the retained prime snapshot (`ISSUE_MUTATION`) through `snapshot-contract`.
  - Records the step start in `.git/autoloop/steps/<N>.json`.
  - Prints exactly one line: the rendered ribbon (M5) with the real clock.
  - **Idempotent:** the same `--to` for the same step prints `already on <step>`. It never swaps
    twice and never reprints the ribbon.
- **`--resumed`** prints the `▶️ resumed` line, with the duration taken from `--ms`.
- **Skill:** the orchestrator runs `step.mjs` and then says nothing further about the step. The
  tool's one-line output is the announcement, so the model no longer composes ribbons, reads
  `date`, or swaps labels by hand.
- **Refusals are loud.** A label swap that GitHub refuses exits 1 with gh's own message. A render
  problem never fails the call: it falls back to a plain `NN/11 NAME` line.

### M2. Role brief templates: the standing half of every brief

- `templates/briefs/<role>.md` holds each role's standing instructions, taken from the current
  skill and today's briefs: the stance, read-only rules, which skill to load, the governance docs
  to read, what to check, and the writer rules (tests are proof, no co-author trailer, verification
  in the commit message, line-delta report).
- `dispatch.mjs` prepends the template for `--role` to the prompt file. It sits beside the existing
  `reviewEnvelopeStamp` and `dispatchContextStamp`, and the stamp records the template's hash.
- **Skill:** the brief file carries only unit facts: artifact paths, human rulings, accepted
  findings, what changed on base, and focus areas. The `Write` preview shrinks to those.
- **Trouble-free:**
  - A missing template is a typed dispatch refusal, never an empty preamble.
  - Templates are covered by `release-verify` and linted for shell fences, as briefs already are
    (`dispatch.mjs:978-990`).

### M3. No task list (operator decision, 2026-09-28)

- **Measured in session 0bf7f2f2.**
  - 43 of 169 orchestrator turns did nothing but TaskCreate/TaskUpdate/TaskGet.
  - Those turns re-read 5.51M of the session's 20.65M cached context tokens.
  - Weighted as input 1 : cache read 0.1 : output 5, that is about 24% of the orchestrator's token
    cost.
  - They took 5.8 minutes of wall time: about 7.4 s per turn, on the orchestrator's critical path.
- **The orchestrator makes no task-list calls.** The panel section of the dev skill goes (run row,
  per-step rows, cost stamps, newest-first rewrites, pruning), and so do:
  - the `🗒 task panel` fate line in the run frame;
  - the task-list lines in `label-swap-reminder.mjs`'s riders;
  - `step-subject.mjs`.
- **Nothing is lost.** Per-step time lives in the closing card (M5) and in `stats.mjs --record` and
  the label timeline, which are durable. The ribbons, the parked block and the cards carry the
  status.
- The regression incidents that pin the panel choreography are retired together with their
  enforcers, and each retirement is named in the commit.

### M4. `snapshot-contract --unit <N> <snapshot>`: one typed unit card

- It returns the compact facts a unit decision needs:
  - labels, `loop-ready` provenance, and whether the body was edited after approval;
  - dependencies and their states;
  - eligibility with the failing predicate named;
  - lifecycle marker phase, PR and root;
  - the open PR, if any.
- The logic reuses `eligibleQueueIssueNumbers`' predicates, split out so each can report its
  reason.
- **Skill:** replaces the `jq` projections in selection, premise and staging.
- **Trouble-free:** read-only, one JSON object, `null` fields when evidence is incomplete.

### M5. Status polish (rendered by tools, so it always aligns)

The same visual language: `∞`, the badges, the closed glyph set, open-right frames. It gains three
things that hand composition could not keep.

1. **A single-line ribbon with a coloured model column** (operator choice, 2026-09-28). Columns
   are fixed and padded: time, unit, badge, step glyph and name, the bar with its counter (or the
   round), the model, then the note. The status line stays under 120 columns.

```text
09:40 #350 ⏳ 🔨 IMPLEMENT    ▰▰▰▰▰▱▱▱▱▱▱ 05/11  🟠 OPUS 5.5    11 files planned
09:51 #350 ⏳ 🧹 SIMPLIFY     ▰▰▰▰▰▰▱▱▱▱▱ 06/11  🟣 FABLE 5.1   393 lines · under est.
10:02 #350 🚧 🔍 CODE-REVIEW  ▰▰▱▱▱ r2/5         🟢 ASTRA 6     2 Major open
10:19 #350 🚧 🔧 FIX          ▰▰▱▱▱ r2/5         🟠 OPUS 5.5    2 Major · invariant-scoped
10:26 #350 ✅ 🔍 CODE-REVIEW  ▰▰▰▱▱ r3/5         🟢 ASTRA 6     clean · converged
10:31 #356 ⏳ 🔬 PLAN-REVIEW  ▰▰▰▱▱▱▱▱▱▱▱ 03/11  🟠 OPUS 5.5 ↪  fallback · FABLE timed out
```

   - **Colour comes from colour emoji,** because raw ANSI does not survive the markdown renderer
     (`step-subject.mjs`). The dots are 🟣 Fable, 🟠 Opus, 🟢 Astra, 🔵 Sonnet, 🟡 Haiku, and ⚪ for
     anything else. They carry no variation selector and are uniformly double-width, so the column
     aligns.
   - **Short names** come from the model id: `claude-fable-5-1` → `FABLE 5.1`,
     `claude-opus-5-5` → `OPUS 5.5`, `gpt-6-astra` → `ASTRA 6`. An unknown id is shown
     upper-cased as it is.
   - `↪` marks a fallback.
   - A step the orchestrator does itself (premise, diff review) shows `⚪ ORCHESTRATOR`.
   - The `[HH:MM][#N]` prefix becomes `HH:MM #N`. `∞` leaves the per-step line and stays on the
     frame, the cards and the parked block.
   - **`step.mjs` prints the finished line and the orchestrator repeats it verbatim** as its
     message text, so it renders as a prominent status line rather than dim tool output. This
     costs no extra turn: the text comes in the turn that reads the result.
   - **The dev skill's "Chat markers" section is rewritten to this format.** The badges and the
     closed step-glyph set are unchanged.

2. **A unit closing card.** One per unit, replacing the bare closing rail. Per-step time is shown
   as bars scaled to the unit's longest step, and the totals go on the bottom rule:

```text
╭─ ✅ #350 SHIPPED · Axis B playback state machine
│  🧭 premise        1m
│  🔬 plan-review    8m  ▰▰▰
│  🔨 implement     11m  ▰▰▰▰
│  🧹 simplify       6m  ▰▰
│  🔍 code-review   42m  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰  r3/5
│  🚦 gate           9m  ▰▰▰
╰─ 1h 17m · 393 lines · 3 rounds · PR #402
```

   It is built from `.git/autoloop/steps/<N>.json` and the dispatch log's `ms`. It shows time only,
   with no cost (operator decision, 2026-09-28). A blocked unit gets the same card with `❌`/`⚠️`
   and its question as the last line.

3. **A parked block that carries the whole run.** The wait branches keep their per-dispatch
   elapsed time, and the resume branch gains the queue state:

```text
🅿️ ┄┄┄┄┄┄┄┄┄┄┄┄ PARKED · 09:53 ┄┄┄┄┄┄┄┄┄┄┄┄
├ #350 · 06 simplify on CLAUDE-FABLE-5-1 · 2m
├ #356 · 03 plan-review on CLAUDE-FABLE-5-1 · 1m
└ queue 57 eligible · #349 ⚠️ awaits /answer · resumes on results
```

   It is rendered by `step.mjs --parked` from the run marker, the live dispatch pids and the prime
   summary. It never prints before `prime --park` succeeded (the rule from 0.53.1).

### M6. A run card after compaction (operator approval, 2026-09-28)

- **Evidence.** In LFE session 0bf7f2f2 auto-compaction took 5 minutes (10:14:40 → 10:19:50),
  in the middle of step 10. The resumed orchestrator then rebuilt its working state by reading
  files, including an 87 KB skill search, and refilled the fresh context.
- **Mechanism (confirmed in code.claude.com/docs/en/hooks).**
  - `SessionStart` fires with source `compact` after both manual and automatic compaction, and a
    hook's stdout is added to the context.
  - LFE's scaffolded `SessionStart` hook has no matcher, so it already re-runs after compaction:
    `session-preflight.sh` plus a full `STATE.md`.
- **The change.** `step.mjs --card-run` prints a run-state card, and scaffold adds it to the
  existing `SessionStart` hook. It prints only when `loopRunIsLive()` holds and is capped at
  1.5 KB. It carries facts, never instructions:
  - each unit in flight with its current step, model and start time (from
    `.git/autoloop/steps/*.json`);
  - running dispatches (pids and result paths);
  - the park, if any;
  - the retained snapshot path with its age;
  - a closing line: "facts as of HH:MM — re-prime before deciding".
- **Not stated in the docs, so verified live, never assumed:** a size limit on injected context,
  and whether `SessionStart` fires for subagents.

## Boundaries

- Always:
  - Every mutation still shows: a step call prints the label change, and a swap that GitHub
    refuses is loud.
  - The command guard stays the single authority on labels.
  - `stats.mjs` and the label timeline stay the durable record.
- Never:
  - Mute a failure or a refusal.
  - Let a rendering error stop a step.
  - Batch several mutations behind one call without printing each.
  - Reprint a ribbon.
- Ask first: changing the badge set, the step-glyph set or the model colours.

## Tests (failing first)

- `step.mjs --self-test`, with gh and guard fakes:
  - the swap argv carries both halves; 10/11 make no swap;
  - a guard refusal is printed and exits 1;
  - `--to` is idempotent;
  - the ribbon is aligned for every step and round form;
  - `--resumed` durations come from `ms`;
  - a render fault falls back to the plain line;
  - the panel line is correct.
- `dispatch.mjs --self-test`:
  - the template is prepended and hash-stamped;
  - a missing template is a typed refusal;
  - a template carrying a shell fence is refused.
- `snapshot-contract --self-test`: the unit card names the failing eligibility predicate for each
  predicate, and is `null`-safe on incomplete sections.
- Card and parked-block rendering from fixture step files and dispatch-log entries, with bars
  scaled and the long-step case covered.
- `regression-index`: incidents for today's hand-composition failures.
- Full gate: `node templates/tools/verify.mjs --plugin-root .`

## Success criteria

- Tokens and time, on the next LFE unit after release, measured from the session JSONL the same
  way as the baseline:
  - orchestrator turns per unit;
  - weighted tokens per unit (input 1 : cache read 0.1 : output 5);
  - orchestrator wall time excluding dispatch waits.
  Each should be at most half of #350's.
- On the next LFE unit after release:
  - visible orchestrator tool calls per unit at most half of #350's baseline;
  - every step announced by exactly one `step.mjs` line;
  - no `date`, no hand `gh issue edit`, and no `jq` into the snapshot in the transcript.
  Record the counts from the session JSONL, measured the same way as the baseline.
- Brief `Write` previews at most half of today's bytes for plan-review, implement and simplify.
- Zero loop stops attributable to M1–M5 across the first three units.

## Decisions

1. The closing card shows time only.
2. The task list is dropped (M3), for token cost and speed.
