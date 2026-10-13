// The central pane (docs/specs/SPEC-central.md, items 8 to 14): pure
// builders from the projection, the proxy read, the streams and the state
// to row models per tab. They hold no `$`; register.tsx draws what they
// return with the kit. Each row hands back its glyph apart from its text,
// so status is carried by the glyph and the words, never by color alone.
import type { ProxyRead, StatusEvent, StatusPending, StatusProjectedDispatch, StatusProjection, StatusState, StatusStream, StatusUnit, StatusWait, StatusWorkedUnit } from '../../types'
import { GLYPH } from './kit'
import { isQuiet, runningDispatches, visibleDispatches } from './read'
import { answerText, blockedUnits, duration, loopColumn, parts, ref, requestedName, roundLabel, shortModel, truncate } from './view'

export const PANE_ID = 'autoloop'
export const PANE_TITLE = 'autoloop'

export type Tab = 'run' | 'live' | 'units' | 'log'
export const TABS: readonly { tab: Tab; label: string; hotkey: string }[] = Object.freeze([
  { tab: 'run', label: 'Run', hotkey: '1' },
  { tab: 'live', label: 'Live', hotkey: '2' },
  { tab: 'units', label: 'Units', hotkey: '3' },
  { tab: 'log', label: 'Log', hotkey: '4' },
])

/** Under this many body columns the Run tab drops the Proxy section and the Timeline keeps names only (spec item 14). */
export const NARROW_COLUMNS = 60
/** The log length asked for while the Log tab is shown; the producer's default otherwise. */
export const LOG_LENGTH = 500
/** A unit's title is cut past this many characters on the Units tab. */
const TITLE_MAX = 40

/**
 * The control a row offers (item 16): a `cancel` button beside a running
 * dispatch, `merge` or `authorize` on a unit with a PR (each asked y or n
 * as a pending control), an `answer` input under a block or decide (Enter
 * is its confirmation). draw.tsx draws the element and sends the control;
 * the row holds only the facts.
 */
export type RowAction = StatusPending | { kind: 'answer'; issue: number }

export type Row = {
  /** Drawn dim before the glyph: the Log tab's time. */
  lead: string | null
  /** The status glyph; '' for a row without one. */
  glyph: string
  text: string
  /** Drawn dim at the right edge: `answer on #417`, `this session`. */
  right: string | null
  /** A dim row: a blocked unit's needs-you text under its row. */
  dim: boolean
  action: RowAction | null
}

export type Section = { title: string; rows: Row[] }

const row = (glyph: string, text: string, right: string | null = null, dim = false, action: RowAction | null = null): Row =>
  ({ lead: null, glyph, text, right, dim, action })

/** The header's status line: the Loop cell's text, `paused` after it while the run is paused. */
export function statusLine(projection: StatusProjection): string {
  if (projection.execution?.mode === 'daemon') return loopColumn(projection, true).head
  return parts([loopColumn(projection, true).head, projection.run?.paused === true ? 'paused' : null])
}

/**
 * Whether a tick that sees an owned run opens the pane unasked (item 13):
 * once per session, only where the surface said it docks a pane
 * (`isFullscreen` true; false or unknown never), and not while it is open.
 * The width rule is the host's: an open under the floor waits undrawn.
 */
export function autoOpenDue(held: Pick<StatusState, 'autoOpened' | 'paneOpen'>, isFullscreen: boolean | null): boolean {
  return !held.autoOpened && !held.paneOpen && isFullscreen === true
}

/** The color key a glyph wears, so the drawing and the tests agree on it. */
export function glyphTone(glyph: string): 'good' | 'warn' | 'crit' | 'ink3' | 'accent' {
  if (glyph === GLYPH.needsYou || glyph === GLYPH.failed) return 'crit'
  if (glyph === GLYPH.waiting || glyph === GLYPH.paused) return 'warn'
  if (glyph === GLYPH.notYet || glyph === GLYPH.dot) return 'ink3'
  if (glyph === GLYPH.brand || glyph === GLYPH.play) return 'accent'
  return 'good'
}

// The Run tab (item 9).

/** The `--log` clock's `HH:MM` of an ISO instant, in UTC as the producer prints it. */
const utcMinute = (iso: string): string => `${iso.slice(11, 16)} UTC`

/** What the Now section says without a unit: the next selection when the run is parked until a known time. */
export function noUnitText(projection: StatusProjection): string {
  if (projection.execution?.mode === 'daemon') return 'module 1 · queue disabled · no production units'
  const until = projection.run?.parkedUntil ?? null
  return until === null ? 'no unit in flight' : `no unit in flight · next selection at ${utcMinute(until)}`
}

/** The worked unit's elapsed: since it started while in flight, else since it returned. */
function unitElapsed(unit: StatusWorkedUnit, nowMs: number): string | null {
  if (unit.inFlight) return duration(nowMs - unit.startedAtMs)
  return unit.returnedAtMs === null ? null : `returned ${duration(nowMs - unit.returnedAtMs)} ago`
}

/** Running legacy dispatches offer cancel. Every retained daemon binding shows its verified state without a unit action. */
export function dispatchRows(projection: StatusProjection, nowMs: number): Row[] {
  return visibleDispatches(projection).map((dispatch) => {
    const name = dispatchName(dispatch, dispatch.dispatch)
    if (projection.execution?.mode === 'daemon') return row(
      dispatch.state === 'running' && dispatch.observation === 'alive' ? GLYPH.play : GLYPH.waiting,
      daemonDispatchTitle(dispatch),
    )
    return row(GLYPH.play, parts([name, dispatch.model === null ? null : shortModel(dispatch.model), duration(nowMs - dispatch.startedAtMs)]), null, false,
      { kind: 'cancel', dispatch: dispatch.dispatch, issue: dispatch.issue, name })
  })
}

/** Now: the phase, unit, PR and title on one row; the role, round, model and elapsed on the next; then the running dispatches. */
export function nowSection(projection: StatusProjection, nowMs: number): Section {
  const unit = projection.unit ?? null
  const dispatches = dispatchRows(projection, nowMs)
  if (unit === null) return { title: 'Now', rows: dispatches }
  const loop = loopColumn(projection, false)
  return { title: 'Now', rows: [row(GLYPH.active, loop.head), row('', parts([loop.detail, unitElapsed(unit, nowMs)])), ...dispatches] }
}

/** `08-code-review` as `code-review`: the step's name less its order. */
export const stepName = (step: string): string => step.replace(/^\d+-/u, '')

/** Timeline: one row per step of the worked unit, `✓` returned or `●` in flight; names only when narrow. */
export function timelineSection(projection: StatusProjection, nowMs: number, narrow: boolean): Section {
  if (projection.execution?.mode === 'daemon') return { title: 'Timeline', rows: [] }
  const steps = projection.unit?.steps ?? []
  return {
    title: 'Timeline',
    rows: steps.map((step) => {
      const returned = step.returnedAtMs !== null
      const glyph = returned ? GLYPH.done : GLYPH.active
      const name = stepName(step.step)
      if (narrow) return row(glyph, name)
      const spent = duration((step.returnedAtMs ?? nowMs) - step.startedAtMs)
      return row(glyph, parts([name, roundLabel(step.round), spent, step.model === null ? null : shortModel(step.model)]))
    }),
  }
}

/**
 * The control a unit with a PR offers (item 16): `merge` only when the
 * loop's own gate may merge it (delivered, no human to answer), `authorize`
 * only when it carries `human:authorize`; nothing otherwise.
 */
export function prAction(unit: StatusUnit): StatusPending | null {
  if (unit.pr === null) return null
  if (unit.needsYou?.kind === 'authorize') return { kind: 'authorize', pr: unit.pr }
  return unit.needsYou === null && unit.disposition === 'delivered' ? { kind: 'merge', pr: unit.pr } : null
}

/** Needs you: every unit a human must answer, oldest first, its text and what answers it: an answer input, or the authorize button. */
export function needsYouSection(projection: StatusProjection): Section {
  return {
    title: 'Needs you',
    rows: blockedUnits(projection).map((unit) => row(GLYPH.needsYou, parts([ref(unit.issue, unit.pr), unit.needsYou.text]), answerText(unit), false,
      unit.needsYou.kind === 'authorize' ? prAction(unit) : { kind: 'answer', issue: unit.issue })),
  }
}

/** The question a pending control asks: `cancel #517 implement?`, `merge PR #700?`, `authorize PR #701?`. */
export function pendingQuestion(pending: StatusPending): string {
  return pending.kind === 'cancel' ? `cancel ${pending.name}?` : `${pending.kind} PR #${pending.pr}?`
}

/**
 * Whether the projection still offers a pending control: its dispatch
 * still runs, or a unit still offers that merge or authorize. A pending
 * control the run outgrew is dropped by the tick, so its y sends nothing.
 */
export function pendingOffered(projection: StatusProjection, pending: StatusPending): boolean {
  if (projection.execution?.mode === 'daemon') return false // Module 1 has no unit actions.
  if (pending.kind === 'cancel') return runningDispatches(projection).some((dispatch) => dispatch.dispatch === pending.dispatch)
  return (projection.units ?? []).some((unit) => {
    const action = prAction(unit)
    return action !== null && action.kind === pending.kind && action.pr === pending.pr
  })
}

/** What a unit waits for: `waits on #399`, `waits on PR #204 · src/a.mjs`, `waits until 10:50 UTC`, `waits on a green base`. */
export function waitText(wait: StatusWait): string {
  if (wait.kind === 'issue') return `waits on #${wait.number}`
  if (wait.kind === 'pr') return parts([`waits on PR #${wait.number}`, wait.paths === null ? null : wait.paths.join(', ')])
  if (wait.kind === 'base') return 'waits on a green base'
  return wait.until === null ? 'waits on time' : `waits until ${utcMinute(wait.until)}`
}

export function waitingSection(projection: StatusProjection): Section {
  return {
    title: 'Waiting',
    rows: (projection.units ?? []).filter((unit) => unit.disposition === 'waiting')
      .map((unit) => row(GLYPH.waiting, unit.waitingOn === null ? parts([`#${unit.issue}`, unit.detail]) : `#${unit.issue} ${waitText(unit.waitingOn)}`)),
  }
}

/** Delivered: `#N · PR #M · <detail>`, `merge pending` without a detail. */
export function deliveredSection(projection: StatusProjection): Section {
  return {
    title: 'Delivered',
    rows: (projection.units ?? []).filter((unit) => unit.disposition === 'delivered')
      .map((unit) => row(GLYPH.done, parts([ref(unit.issue, unit.pr), unit.detail ?? 'merge pending']), null, false, prAction(unit))),
  }
}

/** Proxy: one row per active request, requested → served (requested alone while the served model is null), elapsed, `this session`. */
export function proxySection(proxy: ProxyRead | null, sessionId: string): Section {
  const requests = proxy === null ? [] : proxy.requests
  return {
    title: 'Proxy',
    rows: requests.map((request) => {
      const requested = requestedName(request)
      const models = request.model === null ? requested : `${requested} → ${shortModel(request.model)}`
      return row(GLYPH.active, parts([models, request.elapsedMs === null ? null : duration(request.elapsedMs)]),
        request.sessionId !== null && request.sessionId === sessionId ? 'this session' : null)
    }),
  }
}

export type RunView = { sections: Section[]; empty: string | null }

/** The Run tab: the sections in the spec's order, those with rows only; `empty` is the Now section's text without a unit. */
export function runTab(projection: StatusProjection, proxy: ProxyRead | null, sessionId: string, nowMs: number, bodyColumns: number): RunView {
  const narrow = bodyColumns < NARROW_COLUMNS
  const sections = [
    nowSection(projection, nowMs), timelineSection(projection, nowMs, narrow), needsYouSection(projection), waitingSection(projection),
    deliveredSection(projection), ...(narrow ? [] : [proxySection(proxy, sessionId)]),
  ].filter((section) => section.rows.length > 0)
  if (projection.execution?.mode === 'daemon') {
    const requests = projection.controls?.requests ?? []
    if (requests.length > 0) sections.push({ title: 'Controls', rows: requests.map((request) => row(
      request.status === 'refused' ? GLYPH.failed : request.status === 'applied' ? GLYPH.done : GLYPH.waiting,
      parts([`${request.requestId} · ${request.status}`, request.outcome?.code]),
    )) })
    if (projection.execution.eventLogError !== null) sections.push({ title: 'History', rows: [row(GLYPH.waiting, projection.execution.eventLogError)] })
  }
  return { sections, empty: (projection.unit ?? null) === null ? noUnitText(projection) : null }
}

// The Units tab (item 11).

const UNIT_GLYPH: Record<StatusUnit['disposition'], string> = {
  active: GLYPH.active, waiting: GLYPH.waiting, blocked: GLYPH.needsYou, returned: GLYPH.done, delivered: GLYPH.done,
}

/** When a unit last changed: its newest log event, else the worked unit's start; null when the run recorded none. */
export function lastChangeMs(projection: StatusProjection, issue: number): number | null {
  const event = (projection.log ?? []).find((entry) => entry.issue === issue)
  if (event !== undefined) return event.at
  const unit = projection.unit ?? null
  return unit !== null && unit.issue === issue ? unit.startedAtMs : null
}

/** The Units tab: one row per unit in the run's order, a blocked unit's needs-you text as a dim row under it. */
export function unitsTab(projection: StatusProjection, nowMs: number): Row[] {
  return (projection.units ?? []).flatMap((unit) => {
    const changed = lastChangeMs(projection, unit.issue)
    const detail = unit.detail === unit.disposition ? null : unit.detail
    const main = row(UNIT_GLYPH[unit.disposition], parts([
      ref(unit.issue, unit.pr), unit.title === null ? null : truncate(unit.title, TITLE_MAX), unit.disposition, detail,
      changed === null ? null : duration(nowMs - changed),
    ]))
    return unit.needsYou === null ? [main] : [main, row('', unit.needsYou.text, null, true)]
  })
}

// The Log tab (item 12).

export type LogFilter = 'all' | 'steps' | 'dispatches' | 'needsYou' | 'controls'
export const LOG_FILTERS: readonly { filter: LogFilter; label: string }[] = Object.freeze([
  { filter: 'all', label: 'all' },
  { filter: 'steps', label: 'steps' },
  { filter: 'dispatches', label: 'dispatches' },
  { filter: 'needsYou', label: 'needs you' },
  { filter: 'controls', label: 'controls' },
])

const FILTER_KINDS: Record<Exclude<LogFilter, 'all'>, string[]> = {
  steps: ['step', 'decision', 'resume'],
  dispatches: ['dispatch.start', 'dispatch.end'],
  needsYou: ['block', 'wait'],
  controls: ['control', 'pause', 'unpause', 'label', 'merge'],
}

export function passesFilter(event: StatusEvent, filter: LogFilter): boolean {
  return filter === 'all' || FILTER_KINDS[filter].includes(event.kind)
}

/**
 * `HH:MM:SS` of an instant in UTC: the hooks module has no clock zone to
 * read, and the producer prints every instant in UTC too (`parkedUntil`,
 * a wait's `until`), so the Log tab marks its column `UTC`.
 */
export const clockText = (atMs: number): string => new Date(atMs).toISOString().slice(11, 19)

/** The round as the event file spells it (`fix-2`, `re-plan`, `open-findings`) in the band's words. */
export function roundText(round: string): string {
  const fix = /^fix-(\d+)$/u.exec(round)
  return fix ? `fix ${fix[1]}` : round === 'open-findings' ? 'open findings' : round
}

const prText = (pr: number | undefined): string => (pr === undefined ? 'a PR' : `PR #${pr}`)

/** The glyph and the one-line text of an event, by kind. */
export function eventText(event: StatusEvent): { glyph: string; what: string } {
  const role = event.role ?? 'dispatch'
  switch (event.kind) {
    case 'step': return { glyph: GLYPH.step, what: parts([stepName(event.step ?? ''), event.round === undefined ? null : roundText(event.round)]) }
    case 'dispatch.start': return { glyph: GLYPH.play, what: parts([role, event.model === undefined ? null : shortModel(event.model)]) }
    case 'dispatch.end': {
      const spent = event.ms === undefined ? null : duration(event.ms)
      return event.ok === true
        ? { glyph: GLYPH.done, what: parts([`${role} returned`, spent]) }
        : { glyph: GLYPH.failed, what: parts([`${role} ${event.reason ?? 'failed'}`, spent]) }
    }
    case 'decision': return { glyph: GLYPH.active, what: `decided: ${event.text ?? ''}` }
    case 'wait': {
      if (event.reason === 'pr') return { glyph: GLYPH.waiting, what: `waits on ${prText(event.pr)}${event.paths === undefined ? '' : ` (${event.paths.join(', ')})`}` }
      return { glyph: GLYPH.waiting, what: event.reason === 'time' ? `waits ${event.text ?? 'on time'}` : `waits on ${event.text ?? event.reason ?? ''}` }
    }
    case 'resume': return { glyph: GLYPH.play, what: parts(['resumed', event.text]) }
    case 'block': return { glyph: GLYPH.needsYou, what: parts([`blocked ${event.reason ?? ''}`.trim(), event.text]) }
    case 'deliver': return { glyph: GLYPH.done, what: `delivered ${prText(event.pr)}` }
    case 'merge': return event.ok === true
      ? { glyph: GLYPH.done, what: `merged ${prText(event.pr)}` }
      : { glyph: GLYPH.failed, what: `merge refused: ${event.reason ?? 'no reason'}` }
    case 'label': return { glyph: GLYPH.dot, what: `label: ${event.text ?? ''}` }
    case 'control': return { glyph: GLYPH.dot, what: `you: ${event.text ?? ''}` }
    case 'pause': return { glyph: GLYPH.paused, what: 'paused' }
    case 'unpause': return { glyph: GLYPH.play, what: 'resumed by you' }
    case 'run.start': return { glyph: GLYPH.brand, what: 'run started' }
    case 'run.end': return { glyph: GLYPH.brand, what: parts(['run ended', event.reason]) }
    default: return { glyph: GLYPH.dot, what: event.kind }
  }
}

/** The widest writer's name (`dispatch`), so the what column lines up. */
const BY_WIDTH = 8

/** One log row: `HH:MM:SS  <glyph> <by>  #N PR #M  <what>`; the time is the row's lead. */
export function logRow(event: StatusEvent): Row {
  const { glyph, what } = eventText(event)
  const issue = event.issue === undefined ? null : `#${event.issue}${event.pr === undefined ? '' : ` PR #${event.pr}`}`
  return { lead: clockText(event.at), glyph, text: [event.by.padEnd(BY_WIDTH), issue, what].filter((part) => part !== null).join('  '), right: null, dim: false, action: null }
}

/** The Log tab: the projection's log as it comes (newest first), those the filter passes. */
export function logTab(projection: StatusProjection, filter: LogFilter): Row[] {
  return (projection.log ?? []).filter((event) => passesFilter(event, filter)).map(logRow)
}

// The Live tab (item 10).

/** The rows the tab draws over the lines: the header, the tabs, the gap under them, the buttons row and the title; one more while a question shows. */
const LIVE_CHROME_ROWS = 5
const LIVE_HOTKEYS = ['a', 'b', 'c', 'd', 'e']

export type LiveLine = { text: string; dim: boolean }
export type LiveView = {
  /** One per visible binding; legacy shows only running dispatches. */
  buttons: { id: string; label: string; hotkey: string | null; active: boolean }[]
  /** The dispatch shown with its title row and the lines in the window; null when none has run; `cancel` while it runs (item 16). */
  shown: { id: string; title: string; lines: LiveLine[]; cancel: StatusPending | null } | null
}

export type LiveState = Pick<StatusState, 'selected' | 'follow' | 'liveOffset' | 'pending'>

/** `14 lines`, `2.1k lines` from a thousand. */
export const linesText = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k lines` : `${count} lines`)

/** Show a selected visible binding, then the first, then the cached stream that grew last. Daemon visibility does not imply tail eligibility. */
export function shownDispatch(projection: StatusProjection, streams: Record<string, StatusStream>, selected: string | null): string | null {
  const visible = visibleDispatches(projection).map((dispatch) => dispatch.dispatch)
  if (visible.length > 0) return selected !== null && visible.includes(selected) ? selected : visible[0] ?? null
  const ended = Object.entries(streams).sort(([, left], [, right]) => right.lastGrewAtMs - left.lastGrewAtMs)
  return ended[0]?.[0] ?? null
}

/** `#517 implement`: the dispatch's issue and role; the id when the projection names neither. */
function dispatchName(dispatch: { issue: number | null; role: string | null }, id: string): string {
  const words = [dispatch.issue === null ? null : `#${dispatch.issue}`, dispatch.role].filter((word): word is string => word !== null)
  return words.length === 0 ? id : words.join(' ')
}

/** Daemon titles use verified process facts, never an event's outcome. */
function daemonDispatchTitle(dispatch: StatusProjectedDispatch): string {
  let status = 'process identity unknown'
  if (dispatch.state === 'running' && dispatch.observation === 'alive') status = 'running'
  else if (dispatch.observation === 'empty') status = 'process group exited · outcome unknown'
  return parts([dispatchName(dispatch, dispatch.dispatch), dispatch.model === null ? null : shortModel(dispatch.model), status])
}

/** The title row of a dispatch: running with its elapsed, lines and `quiet`; ended with its outcome from the log; died when gone. */
export function liveTitle(projection: StatusProjection, id: string, stream: StatusStream | undefined, nowMs: number, narrow: boolean): string {
  const log = projection.log ?? []
  const listed = (projection.dispatches ?? []).find((dispatch) => dispatch.dispatch === id) ?? null
  if (projection.execution?.mode === 'daemon') {
    // An event line cannot establish a daemon worker result. Absence from the
    // checkpoint is not success; uncertain process identity is not a dead worker.
    return listed === null ? `${id} · not in checkpoint · outcome unknown` : daemonDispatchTitle(listed)
  }
  const started = log.find((event) => event.kind === 'dispatch.start' && event.dispatch === id)
  const end = log.find((event) => event.kind === 'dispatch.end' && event.dispatch === id)
  // An ended dispatch is named by its start event, or by its end event when the log no longer holds the start.
  const named = started ?? end
  const facts = listed ?? { issue: named?.issue ?? null, role: named?.role ?? null, model: started?.model ?? null }
  const name = dispatchName(facts, id)
  const model = facts.model === null ? null : shortModel(facts.model)
  if (listed !== null && listed.state === 'running') {
    const lines = stream === undefined || narrow ? null : linesText(stream.lines.length)
    const quiet = stream !== undefined && isQuiet(stream, listed, nowMs) ? `quiet ${duration(nowMs - stream.lastGrewAtMs)}` : null
    return parts([name, model, duration(nowMs - listed.startedAtMs), lines, quiet])
  }
  if (end !== undefined) return parts([name, model, `ended ${duration(nowMs - end.at)} ago`, end.ok === true ? 'ok' : end.reason ?? 'failed'])
  return parts([name, model, 'died', stream === undefined ? null : `last wrote ${duration(nowMs - stream.lastGrewAtMs)} ago`])
}

/** The window's rows for the lines: the body less the tab's chrome (and the question's row while one shows), one at least. */
export const liveRoom = (bodyRows: number, pendingShown: boolean): number => Math.max(1, bodyRows - LIVE_CHROME_ROWS - (pendingShown ? 1 : 0))

/** A scroll by `by` rows: follow goes off, and the window moves from where it stands, clamped to the lines. */
export function liveScroll(state: Pick<LiveState, 'follow' | 'liveOffset'>, by: number, lineCount: number, room: number): Pick<LiveState, 'follow' | 'liveOffset'> {
  const last = Math.max(0, lineCount - room)
  const from = state.follow ? last : state.liveOffset
  return { follow: false, liveOffset: Math.min(last, Math.max(0, from + by)) }
}

/** The Live tab: the buttons, and the shown dispatch's title and lines in the window (the end while following, else from the offset). */
export function liveTab(
  projection: StatusProjection, streams: Record<string, StatusStream>, state: LiveState, nowMs: number, bodyRows: number, bodyColumns: number,
): LiveView {
  const id = shownDispatch(projection, streams, state.selected)
  const running = runningDispatches(projection)
  const buttons = visibleDispatches(projection).map((dispatch, index) => ({
    id: dispatch.dispatch, label: dispatchName(dispatch, dispatch.dispatch), hotkey: LIVE_HOTKEYS[index] ?? null, active: dispatch.dispatch === id,
  }))
  if (id === null) return { buttons, shown: null }
  const runs = running.find((dispatch) => dispatch.dispatch === id)
  const cancel: StatusPending | null = runs === undefined || projection.execution?.mode === 'daemon' ? null
    : { kind: 'cancel', dispatch: id, issue: runs.issue, name: dispatchName(runs, id) }
  const stream = streams[id]
  const lines = stream?.lines ?? []
  const room = liveRoom(bodyRows, state.pending !== null)
  const offset = state.follow ? Math.max(0, lines.length - room) : Math.min(state.liveOffset, Math.max(0, lines.length - room))
  return {
    buttons,
    shown: {
      id,
      title: liveTitle(projection, id, stream, nowMs, bodyColumns < NARROW_COLUMNS),
      lines: lines.slice(offset, offset + room).map((text) => ({ text, dim: text.startsWith(GLYPH.thinking) })),
      cancel,
    },
  }
}
