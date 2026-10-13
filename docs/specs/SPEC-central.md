# Spec: Central

Module: `central`, release two of the status mod ([Status mod](SPEC-status-mod.md)). Depends on
[Events and control](SPEC-events.md). Everything is drawn by Claude Code's own UI through the
mod API. No terminal multiplexer, no second process. The [Scheduler](SPEC-scheduler.md) later
replaces the loop under it without a change to the mod.

## Objective

A session that owns a run reads as autoloop's own workplace. The operator sees, without a command
and without leaving the transcript: what the loop does now, each step of the current unit with its
model and time, what each running dispatch writes as it writes it, what waits, and what needs a
human. A parked session (the orchestrator waits for background dispatches) is the case that
matters most: today the transcript shows a text card and then nothing.

## Current state

- The band (v0.70.0) is bare text in three columns; the pane opens inline and lists five sections
  of text; nothing shows a running dispatch.
- The host can redraw transcript rows: `ToolUse` (a tool call, with `isRunning`, `input`,
  `output`), `UserMessage` with `origin.kind: task-notification` (the row that wakes the loop),
  `Spinner`, `ToolProgress` (the background hint), `CommandOutput`. A `Pane` docks beside the
  transcript in the fullscreen renderer and opens inline above the prompt in the classic one; the
  host lets a mod open a pane unasked only in the fullscreen renderer at 144 columns or more
  (110 once the operator opened it). `ctrl+x tab` focuses the band and panes, `ctrl+x x` closes a
  pane, `ctrl+x` with an arrow resizes it; a `Button` hotkey works only while its site holds the
  keyboard, a mouse click works always.
- The mod has `$.fs.read` (files up to 4 MiB), `$.process.run`, `$.state` with subscriptions
  (a `set` redraws its readers), `tool.call` and `turn.*` events, and `Box` borders, backgrounds,
  padding and gaps.
- `dispatch.mjs` streams engine events to a live file whose path the orchestrator passes with
  `--live-file`; the launch command is a `Bash` tool call the mod sees in `tool.call`.
  `dispatch-render.mjs` turns one event line into human lines (`createRenderer`).

## Required behavior

### Sources

1. **Projection.** `status.mjs --json --session <id>` as today, every 3 s; schema
   `autoloop.status/1` gains `unit.steps[]`, `log[]`, `dispatches[]` and `pr` beside every
   `issue`, all derived from the event file ([Events](SPEC-events.md), item 5). The mod reads no
   file under `.git/autoloop/` itself.
2. **Live tail.** Every 1 s while a dispatch runs, the mod reads the last 64 KiB of each running
   dispatch's live file (`$.process.run(['tail', '-c', '65536', liveFile])`; `$.fs.read` is
   capped at 4 MiB and a stream can be larger), renders the complete lines through
   `createRenderer` from `dispatch-render.mjs` (shipped in the plugin, imported as a plain
   module), and keeps the last 200 rendered lines per dispatch in `$.state` (`streams`). A file
   that does not grow for 120 s while its pid lives is `quiet`.
3. **Proxy.** Three states (status mod spec, release two, item 10).

### The transcript

4. **Spinner.** While the session owns a run, the spinner word is the loop's state:
   `autoloop · build #517 · PR #530 · implement` with the engine's suffix and time
   (`next({ ...e, props })`).
5. **Command output.** `/autoloop` draws its answer as the band's card (`CommandOutput` with
   `props.command: 'autoloop'`) instead of plain text.
6. **One ribbon.** The double step line (the tool row's card and the model's echo) is removed in
   the dev skill, not in the mod ([Events](SPEC-events.md), project structure). No other
   transcript row is redrawn: dispatch cards and wake rows would be thrown away by the scheduler.

### The band

7. **Card.** As the status mod spec, release two, items 8 to 10: one `round` box, three labelled
   cells, a needs-you strip, `/autoloop: central` as the hint on the right. The Loop cell names
   the unit as `#517 · PR #530` once a PR exists. While the central pane is open the band is one
   row (the header and the three cells, no phase row, no strip), so the facts are not drawn
   twice.

### The central pane

8. **One pane, four tabs.** `$.ui.open({ id: 'autoloop', title: 'autoloop' })`. The first row
    is the header, `◆ autoloop · <status line>`; the second row holds the tabs as plain digit
    buttons: `1 Run · 2 Live · 3 Units · 4 Log`, the active one `variant="primary"`. The tab is
    `$.state` (`tab`), so a redraw keeps it. A click selects a tab at any time; the digit while the
    pane holds the keyboard (`ctrl+x tab` or a click).
9. **Run.** Sections (dim label, rows, `gap={1}`): `Now` (phase, unit, role, round, model,
    elapsed); `Timeline` (one row per step of the current unit: `✓ plan 14m · astra`,
    `● implement 4m · opus`, `○ test`; rounds as `fix 2/3`, `re-plan`, `open findings`);
   `Needs you` (as the band's strip, every unit, with `answer` and `decide` inputs, item 16);
   `Waiting` (`#N waits on PR #M · paths`, `#N waits on #M`); `Delivered` (`#N · PR #M · merge
   pending`, with `merge` and `authorize` buttons, item 16); `Proxy` (one row per request:
    `requested → model · 12s`, `this session` mark). Empty sections are not drawn; an empty run
    says `no unit in flight · next selection at <time>` when known.
10. **Live.** A row of plain buttons, one per running dispatch (`#517 implement`, `#520
    plan-review`), the selected one primary, hotkeys `a`..`e` in order; `f` toggles follow;
    `x` cancels the selected dispatch (item 16). Under
    it the selected dispatch's rendered lines, as many as `e.props.scroll.bodyRows` allows, newest
    at the bottom while following; the pane's own scroll (`$.ui.scroll`, PgUp/PgDn) moves the
    window and turns follow off. The title row says `#517 implement · opus · 4m12s · 2.1k lines`,
    or `quiet 2m`, or `ended 30s ago · ok`. No running dispatch: the last ended dispatch's tail
    with its title. Reasoning ticks (`⋯ thinking ~2k tok`) draw dim.
11. **Units.** One row per unit of the run, newest first: glyph, `#N`, `PR #M` when one exists,
    title (truncated), disposition word, last step, elapsed since the last change. Blocked units
    carry their needs-you text as a second dim row.
12. **Log.** The projection's `log[]`: `12:30:41 ✓ #517 PR #530 code-review returned · 3m ·
    fix 1/3`, `12:28:02 → #517 review`, `12:10:00 ! #441 blocked · human:decide`,
    `12:05:00 ⏸ paused by you`. Newest first. The Log tab is the loop's log; the transcript is
    not.
13. **Opening.** `/autoloop` opens the pane (inline on the classic renderer, docked in
    fullscreen) and `/autoloop close` closes it. The mod opens it unasked once per session when
    the session owns a run, `e.viewport.isFullscreen` is true, and the width allows it (the host's
    rule); on the classic renderer it never opens unasked. The pane is never opened with `focus`.
14. **Scale.** `e.props.bodyColumns` under 60: the Run tab drops the Proxy section and the
    Timeline shows glyphs with names only; the Live title drops the line count. Rows truncate
    (`wrap="truncate-end"`); nothing wraps except stream lines, which truncate too.
15. **Kit.** One file `hooks/status/kit.ts` holds `header`, `section`, `tabs`, `num`, `empty`,
    the palette (theme keys only: `claude`, `success`, `warning`, `error`, `inactive`) and the
    glyphs (`● ○ ! ✓ ✗ ▶ ⋯`). Color never carries a state alone.

### Controls

16. **Four controls, through the control directory only.** Each is a `Button` or an `Input` the
    operator uses; the mod writes one control file ([Events](SPEC-events.md), items 7 to 11),
    shows a toast with what it wrote, and wakes a parked session with `$.prompt.submit` of the
    text `autoloop: control`. The mod never runs `gh`, `git`, or a loop tool for a control.
    - `pause` / `resume`: a button in the pane header (`⏸ pause` / `▶ resume`); the band header
      shows `paused` while paused.
    - `cancel`: `x` on the Live tab, and a `cancel` button beside each running dispatch on the
      Run tab; it asks once (`cancel #517 implement? y/n` as two buttons).
    - `answer`: an `Input` under a needs-you row of kind `block` or `decide`; Enter writes the
      `answer` control with the issue and the text.
    - `merge` and `authorize`: buttons on a Delivered row; `merge` is shown only when the
      projection says the PR is mergeable by the loop's own gate (`disposition: delivered`,
      no `human:authorize`); `authorize` only when it carries the label. Each asks once as a
      cancel does (`merge PR #700? y/n`), since the control is not undone.
    A pending question the run outgrew (its dispatch ended, its PR no longer offers the
    control) is dropped at the next tick. A repeat of a control while its producer runs is
    dropped.
    A control the loop refuses (`control/refused/`) is shown as a toast with the reason at the
    next tick.

### Ownership and quiet

17. As today: nothing draws in a session that owns no run or in a project with
    `ui.status: false`; `session.end` drops every state; the tick stops when `enabled` is false.

## Commands

```bash
node tools/status.mjs --self-test
node tools/step.mjs --self-test
node tools/dispatch.mjs --self-test
node tools/dispatch-render.mjs --self-test
node tools/config-contract.mjs --self-test
claude plugin validate --strict .
claude plugin test .
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/step.mjs` and `tools/status.mjs`: the projection fields of [Events](SPEC-events.md)
  item 5; `tools/dispatch-render.mjs`: unchanged, imported by the mod.
- `hooks/status/register.tsx`: the hooks (`session.start`, `session.end`, `command.run`,
  `ui.render` for `AbovePrompt`, `Pane`, `Spinner`, `CommandOutput`, `ui.press`, `ui.input`);
  `read.ts`: projection, tails, proxy; `control.ts`: the control files; `view.ts`: band text;
  `central.ts`: the four tabs' rows; `kit.ts` (the palette and glyphs of `theme.ts` move in);
  `pane.ts` removed; `fixtures/`: projection fixtures from `status.mjs --fixtures` and a
  synthetic stream.
- `types/index.d.ts`: `PluginState` gains `streams`, `tab`, `follow`, `selected`, `pending`
  (a cancel, a merge or an authorize awaiting its y/n), and the `tick` key (the tick's clock,
  written every tick so `status` is written only when a read changed it).
- `README.md` `## Status band` becomes `## Central`; `CHANGELOG.md`; `skills/dev/SKILL.md`
  unchanged (the loop does not learn about the UI).

## Code style

As the mod today: TypeScript under `hooks/status/`, host types from the plugin-authoring skill,
pure view functions over the projection, no module-level state that a drawing reads. Public
repository: synthetic fixtures, no project names or host paths.

## Testing strategy

- The producer's tests are in [Events](SPEC-events.md).
- `claude plugin test`: the spinner word while owned and untouched when not; the band is one row
  while the pane is open and names the PR with the issue; each tab's rows from one fixture at 90
  and 50 columns; the Live tab follows and stops following on a scroll; the three proxy states;
  the pane opens unasked only under fullscreen at the host's width; no draw in a session that
  owns no run; each control writes exactly one well-formed file and one wake prompt, `merge` and
  `authorize` appear only when the projection allows them, a cancel needs its y, a refused control
  toasts its reason. The host is the only test double (`$.process.run` returns `status.mjs
  --fixtures` output and a synthetic tail; `$.http.fetch` the proxy; `$.fs.write` the control
  file).
- Each test is shown failing once before the behavior exists.

## Boundaries

**Always**
- No GitHub call and no git write from the mod; the only writes are `$.state`, `$.store`, and
  control files.
- Keep every `step.mjs` mode and the dispatch protocol unchanged.

**Ask first**
- A fifth control.
- Opening the pane unasked on the classic renderer.
- Redrawing transcript rows beyond the spinner and `/autoloop` output.

**Never**
- Draw a state that was not read; never a guessed model or an invented result.
- A hotkey hint for a key the composer would type.

## Success criteria

In a parked session with two dispatches running, the band names both units with their PRs, the
central pane's Live tab shows either stream moving, the Run tab shows the timeline with models and
times, a block raises a toast and the needs-you strip, an answer typed under it lifts the wait, a
pause stops the next selection, and the proxy reads ON, UP, or OFF truthfully. The model announces
a step once. Self-tests, `claude plugin test`, and the full gate pass.
