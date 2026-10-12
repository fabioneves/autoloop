# Spec: Events and control

Module: `events`. The contract between the loop (today the step machine, later the
[Scheduler](SPEC-scheduler.md)) and the UI ([Central](SPEC-central.md)). Built first, so the UI
is written once and the loop's rewrite only changes the writer.

## Objective

Every change of the loop's state is one appended line in one file, and every operator control is
one file the loop consumes. The UI reads the event file and nothing else of `.git/autoloop/`;
the loop reads the control directory and nothing else of the UI.

## Current state

State is spread over step records, `dispatch-log.jsonl`, run markers, labels, and draft
reminders, each with its own shape. A dispatch's live file path is known only to the command that
launched it. The UI must re-derive a timeline from step records. There is no control channel: the
operator answers on GitHub and the loop finds the answer at its next prime.

## Required behavior

### The event file

1. **Path and form.** `<git-common-dir>/autoloop/events.jsonl`, append-only, one JSON object per
   line, written with one `appendFileSync` per event (one line is atomic under 4 KiB; an event is
   held under that). The file is rotated by the writer at 10 MiB to `events.1.jsonl`; readers
   read both. A reader skips a line it cannot parse and counts it.
2. **Shape.** `{ v: 1, at, run, kind, issue?, pr?, step?, role?, round?, model?, dispatch?,
   liveFile?, pid?, ms?, ok?, reason?, text?, paths?, by }`. `at` is epoch ms; `run` the run
   marker id; `by` the writer (`step`, `dispatch`, `unit`, `prime`, `publish`, `loop`, `ui`).
   `text` is one line under 200 characters. Nothing else; a new field needs `v: 2`.
3. **Kinds.** `run.start`, `run.end`, `select` (issue chosen), `step` (a transition: `step`,
   `round`, `text`), `dispatch.start` (`role`, `model`, `dispatch`, `liveFile`, `pid`),
   `dispatch.end` (`dispatch`, `ms`, `ok`, `reason`), `decision` (`text`), `wait` (`reason`,
   `issue` or `pr`, `paths`), `resume`, `block` (`reason`, `text`), `deliver` (`pr`), `merge`
   (`pr`, `ok`), `label` (`text`), `control` (`text`: the control the loop applied), `pause`,
   `unpause`.
4. **Writers today.** `step.mjs` writes `step`; `dispatch.mjs` writes `dispatch.start` and
   `dispatch.end` (the live file path, whichever the caller chose, and its own pid, which leads
   the process group under `dispatch-stream.sh`); `unit.mjs` writes `wait`, `resume`,
   `decision`, `block`; `prime.mjs` writes `run.start` (once per run: the run id is kept in
   `autoloop/run-id` until `--close-run` writes `run.end` and clears it), `pause`, `unpause`;
   the delivery path writes `deliver`, `merge`, `label`. `select` is the scheduler's: today the
   first `step` event of an issue marks its selection, since the model chooses from prime's
   `eligible` list. Each write is fail-open: a failure is one stderr line and the tool's own work
   goes on.
5. **The projection reads events.** `status.mjs --json` derives `unit.steps`, `log` (the last 50
   events, newest first), `dispatches` (every `dispatch.start` without a `dispatch.end`; `pid`
   alive is `running`, gone is `died`) and `pr` per issue from the event file, joined with the
   step records it reads today for the card. A run without an event file (an older plugin wrote
   it) projects as today, with empty `log` and `dispatches`.
6. **PR with the issue.** Every event and every projection row that names an issue with an open
   loop pull request also names the PR: `issue` and `pr` together. The text card (`step.mjs`)
   shows `#N · PR #M` once a PR exists.

### The control directory

7. **Path and form.** `<git-common-dir>/autoloop/control/`, one file per control, named
   `<at>-<kind>.json`, written to a temporary name and renamed into place. The loop consumes a
   file by renaming it to `control/done/` after it applied it and writing a `control` event; a
   file it refuses goes to `control/refused/` with a `reason` added. Files older than 7 days in
   `done/` and `refused/` are pruned by the consumer.
8. **Kinds.** `pause` and `unpause` (no new selection while paused; running dispatches finish);
   `cancel` (`dispatch`: the loop ends it with SIGTERM, then SIGKILL after 10 s, and treats it as
   died); `answer` (`issue`, `text`: posted as an issue comment by the loop with the `answered:`
   marker, which lifts a `human:decide` wait as a human comment does); `merge` (`pr`: the loop
   runs its own merge gate; a refusal is reported, never bypassed); `label` (`pr`: the loop removes
   `human:authorize` from the PR, the one swap the merge gate reads; nothing else is relabelled).
   Nothing else.
9. **Consumer today.** `prime.mjs` applies `pause`, `unpause`, `label`, `merge`, and `answer`
   at its start, before the scan: a pause keeps the marker `autoloop/control/paused` and prime
   reports `eligible: []` with `paused: true` until an unpause; a label removes
   `human:authorize` through `gh pr edit`; a merge runs the auto-merge executor, whose gate
   decides and writes the `merge` event; an answer is posted as the `/answer <text>` comment a
   human would write, and the block triage of the same prime lifts the block (`resume` event,
   reason `answer`). `dispatch.mjs --wait-file` applies `cancel` to the dispatch whose
   `dispatch.start` carries the pid it waits on: SIGTERM to the process group (the dispatch
   leads one under `dispatch-stream.sh`), SIGKILL after 10 s, a `dispatch.end` with reason
   `cancelled`, exit 3 as a died dispatch. Each applied control is a `control` event; a refused
   one goes to `control/refused/` with its reason and prime reports it. The UI wakes a parked
   session after it writes a control (`$.prompt.submit` with the text `autoloop: control`), and
   the dev skill's Prime section says that prompt means "run prime, which applies the control".
10. **Consumer later.** The scheduler polls the directory every second and is the only consumer.

### Who writes a control

11. The UI alone, from a button or an input the operator used; never a hook on a model event,
    never a timer. The control file carries `by: 'ui'` and the session id.

## Commands

```bash
node tools/events-contract.mjs --self-test
node tools/step.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/unit.mjs --self-test
node tools/prime.mjs --self-test
node tools/status.mjs --self-test
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/events-contract.mjs` (new): `appendEvent(commonDir, event)`, `readEvents(commonDir)`,
  `writeControl(commonDir, control)`, `takeControls(commonDir, kinds)`, the kind tables, the
  validation, rotation and pruning. Every writer and reader goes through it.
- `tools/step.mjs`, `tools/dispatch.mjs`, `tools/unit.mjs`, `tools/prime.mjs`,
  `tools/publish-verdict.mjs`, `tools/terminal-finalize.mjs`: one call at each state change.
- `tools/status.mjs` and `statusProjection` in `step.mjs`: the derivations of item 5.
- `skills/dev/SKILL.md`: the `autoloop: control` prompt (Prime section); the ribbon rule
  (`A step is announced ONCE, by its ribbon`) says the ribbon is the line `step.mjs` prints on its
  tool row and the model never repeats it in prose.
- `tools/regression-index.mjs`: the double-ribbon incident; `README.md`; `CHANGELOG.md`.

## Testing strategy

- `events-contract.mjs --self-test`: an event round-trips; an unknown kind or an extra field is
  refused; a line over 4 KiB is refused; a malformed line is skipped and counted; rotation at
  the size; a control is written atomically (no partial file visible), consumed once, refused with
  a reason, pruned after 7 days (clock injected).
- Each writer's self-test: the tool's existing cases gain one assertion that the event was
  appended with the right kind and fields, and one that a failing append does not change the
  tool's result.
- `status.mjs --self-test`: `log`, `dispatches` with a live and a dead pid, `unit.steps` with
  rounds and models, `pr` beside `issue`, and the no-event-file fallback.
- Each test is shown failing once before the behavior exists.

## Boundaries

**Always**
- Append-only; the UI never writes an event; the loop never writes a control.
- Fail-open on the writer side: a UI concern never stops a unit.

**Ask first**
- A new event kind or control kind (bump `v`).

**Never**
- A control that bypasses a gate (merge without the merge gate, a label swap other than the one
  named).
- Secrets, tokens, or host paths outside the checkout in an event.

## Success criteria

The central draws the timeline, the log, and the live streams of the running loop from the event
file alone; a pause from the pane stops the next selection; an answer from the pane lifts a decide
wait; a cancel ends a dispatch and the loop records it as died. The text card shows the PR with
the issue. The model announces a step once.
