// The central pane (docs/specs/SPEC-central.md, items 8 to 14): pure
// builders from the projection, the proxy read, the streams and the state
// to row models per tab. They hold no `$`; register.tsx draws what they
// return with the kit. Each row hands back its glyph apart from its text,
// so status is carried by the glyph and the words, never by color alone.
import type { ProxyRead, StatusEvent, StatusProjection, StatusState, StatusStream, StatusUnit, StatusWait, StatusWorkedUnit } from '../../types'
import { GLYPH } from './kit'
import { isQuiet, runningDispatches } from './read'
import { blockedUnits, duration, loopColumn, modelName, prToAuthorize, requestedName, roundLabel, shortModel } from './view'

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
}

export type Section = { title: string; rows: Row[] }

const row = (glyph: string, text: string, right: string | null = null, dim = false): Row => ({ lead: null, glyph, text, right, dim })

const parts = (list: (string | null | undefined)[]): string => list.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ')

/** `#412 · PR #702`, or `#412` without a PR. */
const ref = (issue: number, pr: number | null | undefined): string => (pr === null || pr === undefined ? `#${issue}` : `#${issue} · PR #${pr}`)

/** The header's status line: the Loop cell's text, `paused` after it while the run is paused. */
export function statusLine(projection: StatusProjection): string {
  return parts([loopColumn(projection, true).head, projection.run?.paused === true ? 'paused' : null])
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
  const until = projection.run?.parkedUntil ?? null
  return until === null ? 'no unit in flight' : `no unit in flight · next selection at ${utcMinute(until)}`
}

/** The worked unit's elapsed: since it started while in flight, else since it returned. */
function unitElapsed(unit: StatusWorkedUnit, nowMs: number): string | null {
  if (unit.inFlight) return duration(nowMs - unit.startedAtMs)
  return unit.returnedAtMs === null ? null : `returned ${duration(nowMs - unit.returnedAtMs)} ago`
}

/** Now: the phase, unit, PR and title on one row; the role, round, model and elapsed on the next. */
export function nowSection(projection: StatusProjection, nowMs: number): Section {
  const unit = projection.unit ?? null
  if (unit === null) return { title: 'Now', rows: [] }
  const loop = loopColumn(projection, false)
  return { title: 'Now', rows: [row(GLYPH.active, loop.head), row('', parts([loop.detail, unitElapsed(unit, nowMs)]))] }
}

/** `08-code-review` as `code-review`: the step's name less its order. */
export const stepName = (step: string): string => step.replace(/^\d+-/u, '')

/** Timeline: one row per step of the worked unit, `✓` returned or `●` in flight; names only when narrow. */
export function timelineSection(projection: StatusProjection, nowMs: number, narrow: boolean): Section {
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

/** What answers a unit that needs a human: `answer on #N`, or `merge or label PR #M` for an authorization with its PR. */
function answerText(unit: StatusUnit): string {
  const pr = prToAuthorize(unit)
  return pr === null ? `answer on #${unit.issue}` : `merge or label PR #${pr}`
}

/** Needs you: every unit a human must answer, oldest first, its text and what answers it. */
export function needsYouSection(projection: StatusProjection): Section {
  return {
    title: 'Needs you',
    rows: blockedUnits(projection).map((unit) => row(GLYPH.needsYou, parts([ref(unit.issue, unit.pr), unit.needsYou.text]), answerText(unit))),
  }
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
      .map((unit) => row(GLYPH.done, parts([ref(unit.issue, unit.pr), unit.detail ?? 'merge pending']))),
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
  return { sections, empty: (projection.unit ?? null) === null ? noUnitText(projection) : null }
}

// The Units tab (item 11).

const UNIT_GLYPH: Record<StatusUnit['disposition'], string> = {
  active: GLYPH.active, waiting: GLYPH.waiting, blocked: GLYPH.needsYou, returned: GLYPH.done, delivered: GLYPH.done,
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

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
  return { lead: clockText(event.at), glyph, text: [event.by.padEnd(BY_WIDTH), issue, what].filter((part) => part !== null).join('  '), right: null, dim: false }
}

/** The Log tab: the projection's log as it comes (newest first), those the filter passes. */
export function logTab(projection: StatusProjection, filter: LogFilter): Row[] {
  return (projection.log ?? []).filter((event) => passesFilter(event, filter)).map(logRow)
}

// The Live tab (item 10).

/** The rows the tab draws over the lines: the header, the tabs, the buttons row and the title. */
const LIVE_CHROME_ROWS = 4
const LIVE_HOTKEYS = ['a', 'b', 'c', 'd', 'e']

export type LiveLine = { text: string; dim: boolean }
export type LiveView = {
  /** One per running dispatch: `#517 implement`, hotkeys `a`..`e` in order (none past the fifth), the selected one active. */
  buttons: { id: string; label: string; hotkey: string | null; active: boolean }[]
  /** The dispatch shown with its title row and the lines in the window; null when none has run. */
  shown: { id: string; title: string; lines: LiveLine[] } | null
}

export type LiveState = Pick<StatusState, 'selected' | 'follow' | 'liveOffset'>

/** `14 lines`, `2.1k lines` from a thousand. */
export const linesText = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k lines` : `${count} lines`)

/** The dispatch the tab shows: the selected running one, else the first running one, else the ended stream that grew last. */
export function shownDispatch(projection: StatusProjection, streams: Record<string, StatusStream>, selected: string | null): string | null {
  const running = runningDispatches(projection).map((dispatch) => dispatch.dispatch)
  if (running.length > 0) return selected !== null && running.includes(selected) ? selected : running[0] ?? null
  const ended = Object.entries(streams).sort(([, left], [, right]) => right.lastGrewAtMs - left.lastGrewAtMs)
  return ended[0]?.[0] ?? null
}

/** `#517 implement`: the dispatch's issue and role; the id when the projection names neither. */
function dispatchName(dispatch: { issue: number | null; role: string | null }, id: string): string {
  const words = [dispatch.issue === null ? null : `#${dispatch.issue}`, dispatch.role].filter((word): word is string => word !== null)
  return words.length === 0 ? id : words.join(' ')
}

/** The title row of a dispatch: running with its elapsed, lines and `quiet`; ended with its outcome from the log; died when gone. */
export function liveTitle(projection: StatusProjection, id: string, stream: StatusStream | undefined, nowMs: number, narrow: boolean): string {
  const log = projection.log ?? []
  const listed = (projection.dispatches ?? []).find((dispatch) => dispatch.dispatch === id) ?? null
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
  if (end !== undefined) return parts([name, model, `ended ${duration(nowMs - end.at)} ago`, end.ok === true ? 'ok' : 'failed'])
  return parts([name, model, 'died', stream === undefined ? null : `last wrote ${duration(nowMs - stream.lastGrewAtMs)} ago`])
}

/** The window's rows for the lines: the body less the tab's chrome, one at least. */
export const liveRoom = (bodyRows: number): number => Math.max(1, bodyRows - LIVE_CHROME_ROWS)

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
  const buttons = runningDispatches(projection).map((dispatch, index) => ({
    id: dispatch.dispatch, label: dispatchName(dispatch, dispatch.dispatch), hotkey: LIVE_HOTKEYS[index] ?? null, active: dispatch.dispatch === id,
  }))
  if (id === null) return { buttons, shown: null }
  const stream = streams[id]
  const lines = stream?.lines ?? []
  const room = liveRoom(bodyRows)
  const offset = state.follow ? Math.max(0, lines.length - room) : Math.min(state.liveOffset, Math.max(0, lines.length - room))
  return {
    buttons,
    shown: {
      id,
      title: liveTitle(projection, id, stream, nowMs, bodyColumns < NARROW_COLUMNS),
      lines: lines.slice(offset, offset + room).map((text) => ({ text, dim: text.startsWith(GLYPH.thinking) })),
    },
  }
}
