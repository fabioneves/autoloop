// The status mod (docs/specs/SPEC-status-mod.md, docs/specs/SPEC-central.md):
// a band above the prompt and, on request, a pane for the session that owns
// a run. This module holds the hooks; the reads (the projection, the proxy,
// the live tails) are in read.ts, the stream's renderer in render.ts, the
// band's text in view.ts, the pane's tabs in central.ts, the drawings in
// draw.tsx, the palette, glyphs and element builders in kit.ts. The band
// draws only from a projection that is owned and enabled, so every other
// session sees no change; the pane opens only on /autoloop.
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { StatusProjection, StatusState, StatusStream, StatusTick } from '../../types'
import { LOG_LENGTH, PANE_ID, PANE_TITLE, autoOpenDue, liveRoom, liveScroll, pendingOffered, shownDispatch } from './central'
import type { ControlHost } from './control'
import { refusedText, sendControl } from './control'
import { bandTree, paneTree } from './draw'
import { empty, plain } from './kit'
import type { ProxyFetch, Runner } from './read'
import {
  LIVE_PERIOD_MS, STREAM_LINES_MAX, isDrawable, proxyBase, pruneStreams, readProjection, readProxy, runningDispatches, tailLive,
} from './read'
import { blockedUnits, spinnerWord, toastText } from './view'

const STATUS = { plugin: 'autoloop', key: 'status' } as const
// The tick's clock under its own key: written every tick, so `status` is
// written (and its readers drawn again) only when a read changed it.
const TICK = { plugin: 'autoloop', key: 'tick' } as const
const PERIOD_MS = 3000
/** A tick past this is reported once: the period is not raised by itself (tasks/plan-status-mod.md, risks). */
const SLOW_TICK_MS = 500
const EMPTY: StatusState = {
  last: null, proxy: null, seenBlocked: [], seenRefused: [], pending: null, paneOpen: false, autoOpened: false, streams: {},
  tab: 'run', logFilter: 'all', selected: null, follow: true, liveOffset: 0,
}
const NO_TICK: StatusTick = { lastOkAtMs: null, lastMs: null }
/** The mod's state as last written, EMPTY before the first tick; a field an older module never wrote takes EMPTY's. */
const readState = async ($: EngineInterface): Promise<StatusState> => ({ ...EMPTY, ...(await $.state.get(STATUS)).value })
const readTick = async ($: EngineInterface): Promise<StatusTick> => ({ ...NO_TICK, ...(await $.state.get(TICK)).value })
/**
 * One write of the mod's state: `change` sees the state as last written
 * (EMPTY's fields under it), and the fields it returns replace; null leaves
 * the state as it stands, with no write and so no redraw. Written with the
 * version read, again on a miss, so two handlers before a redraw both land.
 */
async function editState($: EngineInterface, change: (state: StatusState) => Partial<StatusState> | null): Promise<StatusState> {
  for (;;) {
    const held = await $.state.get(STATUS)
    const state = { ...EMPTY, ...held.value }
    const diff = change(state)
    if (diff === null) return state
    const next = { ...state, ...diff }
    if ((await $.state.set(STATUS, next, { ifVersion: held.version })).isSet) return next
  }
}
/** Whether the pane is open, written where the pane opens or closes; the band reads it to draw one row. */
const setPaneOpen = ($: EngineInterface, paneOpen: boolean) => editState($, (state) => (state.paneOpen === paneOpen ? null : { paneOpen }))
/** A toast: the text passes `plain`, since a needs-you text or a producer's error is not the mod's own. */
const toast = ($: EngineInterface, text: string) => $.ui.toast(plain(text))
/** The host beneath a control (control.ts holds no `$`): the producer as a child, the toasts, the prompt queue. */
const controlHost = ($: EngineInterface): ControlHost => ({
  run: (argv, init) => $.process.run(argv, init),
  toast: (text) => toast($, text),
  submit: (text) => $.prompt.submit({ text }),
  pluginRoot: $.plugin.root,
  sessionId: () => $.session.id(),
})
/** Why the pane and the command stay quiet while the projection is not drawable: not the owner, or the band turned off. */
function quietReason(projection: StatusProjection | null): string {
  return projection === null || projection.owned !== true
    ? 'autoloop: this session owns no run'
    : 'autoloop: the status band is off (ui.status is false in .autoloop/config.json)'
}
/**
 * Whether the host draws the pane now, from its own record of this
 * plugin's panes (`$.ui.panes()`): true or false when it answers, null
 * when it does not offer the list, so the state's flag stands.
 */
async function panePlaced($: EngineInterface): Promise<boolean | null> {
  try {
    return (await $.ui.panes()).some((pane) => pane.id === PANE_ID && pane.isPlaced)
  } catch {
    return null
  }
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export const register: Register = (on) => {
  // Module state, not `$.state`: a reload drops the old timer with it.
  let busy = false
  let slowReported = false
  let faultReported = false
  let timer: Timer | null = null
  // What the band's last draw said of the surface: whether it docks a pane; null until a surface said.
  let isFullscreen: boolean | null = null
  // The session's generation: bumped by session.start and session.end, so
  // a tick in flight across either writes nothing of an ended session back.
  let generation = 0
  // The live tails: a 1 s timer while a dispatch runs, and the last chunk
  // tail printed per dispatch, so growth is the chunk differing. The chunks
  // are the tick's working memory, not a drawing's source: a reload drops
  // them, and the next tick reads every file as grown once.
  let liveBusy = false
  let liveTimer: Timer | null = null
  const chunks = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    generation += 1
    await $.command.register({ name: 'autoloop', description: 'Show the state of the run this session owns.' })
    // The proxy is optional: without the variable the cell does not exist
    // and nothing is fetched; a base that is not a loopback URL counts as
    // unset. `claudeproxy` sets it before the session starts.
    const base = proxyBase(await $.env.get('ANTHROPIC_BASE_URL'))
    const run: Runner = (argv, init) => $.process.run(argv, init)
    // $.http.fetch has no timeout of its own: the read races a clock wait,
    // which the settled fetch then aborts.
    const fetch: ProxyFetch = (url, { timeoutMs }) => {
      const stop = new AbortController()
      const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(() => {
        throw new Error(`no answer within ${timeoutMs} ms`)
      })
      return Promise.race([$.http.fetch(url), timeout]).finally(() => stop.abort())
    }
    // One live tick: tail every running dispatch's file, render, keep the
    // last 200 lines, and stamp growth. A tail that fails keeps the last
    // lines; a tick still running is skipped by the next second; a tick
    // that sees no growth and no dispatch come or go writes nothing.
    const liveTick = async () => {
      if (liveBusy) return
      liveBusy = true
      const started = generation
      try {
        const running = runningDispatches((await readState($)).last)
        if (running.length === 0) return
        const nowMs = await $.clock.now()
        const tailed = await Promise.all(running.map(async (dispatch) => ({ id: dispatch.dispatch, tail: await tailLive(run, dispatch.liveFile) })))
        if (started !== generation) return
        const grown: { id: string; lines: string[]; grew: boolean }[] = []
        for (const { id, tail } of tailed) {
          if (tail === null) continue
          grown.push({ id, grew: chunks.get(id) !== tail.chunk, lines: tail.lines.slice(-STREAM_LINES_MAX) })
          chunks.set(id, tail.chunk)
        }
        await editState($, (state) => {
          const streams = { ...state.streams }
          let changed = false
          for (const { id, lines, grew } of grown) {
            const before = state.streams[id]
            if (before !== undefined && !grew) continue
            changed = true
            streams[id] = { lines, lastGrewAtMs: grew || before === undefined ? nowMs : before.lastGrewAtMs }
          }
          const kept = pruneStreams(streams, running.map((dispatch) => dispatch.dispatch))
          return changed || !same(Object.keys(kept), Object.keys(state.streams)) ? { streams: kept } : null
        })
      } catch (error) {
        if (!faultReported) {
          faultReported = true
          $.ui.log(`autoloop status: a live tick failed (${error instanceof Error ? error.message : String(error)})`)
        }
      } finally {
        liveBusy = false
      }
    }
    // The 1 s timer runs only while a dispatch runs: started by the 3 s tick
    // that sees one, cancelled by the one that sees none.
    const syncLive = (projection: StatusProjection | null) => {
      const running = runningDispatches(projection).length > 0
      if (running && liveTimer === null) {
        liveTimer = $.clock.every(LIVE_PERIOD_MS, () => {
          void liveTick()
        })
      } else if (!running && liveTimer !== null) {
        liveTimer.cancel()
        liveTimer = null
      }
    }
    const tick = async () => {
      if (busy) return
      busy = true
      const started = generation
      try {
        const startedAtMs = await $.clock.now()
        // Ownership is the session's: the producer matches this id against
        // the run latch of the Claude process it runs under. Read on every
        // tick, since after a /clear the process goes on under a new id with
        // no session.start.
        const sessionId = await $.session.id()
        // The Log tab is the whole log: 500 entries while it shows, the
        // producer's default otherwise.
        const logLength = (await readState($)).tab === 'log' ? LOG_LENGTH : null
        const [read, proxy, placed] = await Promise.all([
          readProjection(run, $.plugin.root, sessionId, logLength),
          base === null ? null : readProxy(fetch, base),
          panePlaced($),
        ])
        const nowMs = await $.clock.now()
        const lastMs = nowMs - startedAtMs
        // The session ended while the reads ran: nothing of it is written back.
        if (started !== generation) return
        // A unit blocked for the first time in this session is toasted once:
        // the seen list lives in $.state, so a reload does not toast it again.
        // The write goes through `editState`, so a pane flag written meanwhile
        // is kept, and a tick whose reads changed nothing writes nothing but
        // its clock. A failed projection read keeps the last projection;
        // lastOkAtMs not moving is what marks it stale. The proxy read is
        // taken as it came: UP and OFF are facts.
        // A control the loop refused is toasted once the same way, by the
        // control file's name (SPEC-central item 16). A pending control the
        // run outgrew (its dispatch ended) is dropped, so its y sends nothing.
        let fresh: ReturnType<typeof blockedUnits> = []
        let refused: NonNullable<StatusProjection['controls']>['refused'] = []
        await editState($, (state) => {
          const paneOpen = placed ?? state.paneOpen
          if (!read.ok) return same(proxy, state.proxy) && paneOpen === state.paneOpen ? null : { proxy, paneOpen }
          if (same(read.projection, state.last) && same(proxy, state.proxy) && paneOpen === state.paneOpen) return null
          const drawable = isDrawable(read.projection)
          fresh = drawable ? blockedUnits(read.projection).filter((unit) => !state.seenBlocked.includes(unit.issue)) : []
          refused = drawable ? (read.projection.controls?.refused ?? []).filter((entry) => !state.seenRefused.includes(entry.name)) : []
          const pending = state.pending !== null && drawable && pendingOffered(read.projection, state.pending) ? state.pending : null
          return {
            last: read.projection, proxy, paneOpen, pending,
            seenBlocked: [...state.seenBlocked, ...fresh.map((unit) => unit.issue)], seenRefused: [...state.seenRefused, ...refused.map((entry) => entry.name)],
          }
        })
        await $.state.set(TICK, { lastOkAtMs: read.ok ? nowMs : (await readTick($)).lastOkAtMs, lastMs })
        for (const unit of fresh) toast($, toastText({ issue: unit.issue, text: unit.needsYou.text }))
        for (const entry of refused) toast($, refusedText(entry))
        // The pane opens unasked once per session when a tick first sees an
        // owned run under a surface that docks a pane (item 13), never with
        // focus. The host holds the width rule: under its floor the open
        // waits undrawn (`isPlaced` false: the pane is not open to the band),
        // and the band keeps its card until the pane draws.
        if (read.ok && isDrawable(read.projection) && autoOpenDue(await readState($), isFullscreen)) {
          await editState($, () => ({ autoOpened: true }))
          const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
          if (started !== generation) return
          await setPaneOpen($, opened.isPlaced)
        }
        if (read.ok) syncLive(isDrawable(read.projection) ? read.projection : null)
        // ui.status false turns the mod off for the project: the tick stops
        // until the next session.start (spec item 6). An unowned projection
        // keeps it, since the session may come to own a run.
        if (read.ok && read.projection.owned === true && read.projection.enabled === false) timer?.cancel()
        if (lastMs > SLOW_TICK_MS && !slowReported) {
          slowReported = true
          $.ui.log(`autoloop status: a tick took ${lastMs} ms (period ${PERIOD_MS} ms)`)
        }
      } catch (error) {
        // A host call that rejects (the clock, the state) keeps the last
        // state; the next period tries again. Reported once, not every 3 s.
        if (!faultReported) {
          faultReported = true
          $.ui.log(`autoloop status: a tick failed (${error instanceof Error ? error.message : String(error)})`)
        }
      } finally {
        busy = false
      }
    }
    timer?.cancel()
    liveTimer?.cancel()
    liveTimer = null
    timer = $.clock.every(PERIOD_MS, () => {
      void tick()
    })
    return next(e)
  })

  // The conversation ends (a /clear goes on under a new session id with no
  // session.start): the tick stops and the last projection goes, so the band
  // never draws a run this conversation does not own. A tick still in flight
  // sees the generation move and writes nothing back.
  on('session.end', async ($, e, next) => {
    generation += 1
    timer?.cancel()
    timer = null
    liveTimer?.cancel()
    liveTimer = null
    chunks.clear()
    await $.state.set(STATUS, EMPTY)
    await $.state.set(TICK, NO_TICK)
    return next(e)
  })

  // The pane opens on the person's ask alone. While it is open the band
  // draws one row, so the facts are not drawn twice (SPEC-central item 7).
  on('command.run', { command: 'autoloop' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'close') {
      await $.ui.close({ id: PANE_ID })
      await setPaneOpen($, false)
      return { text: 'autoloop: status pane closed' }
    }
    if (args !== '') return { text: `autoloop: unknown argument "${args}"; use /autoloop or /autoloop close` }
    const { last } = await readState($)
    if (!isDrawable(last)) return { text: quietReason(last) }
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    await setPaneOpen($, opened.isPlaced)
    return { text: opened.isPlaced ? 'autoloop: status pane opened' : `autoloop: status pane waits (${opened.reason})` }
  })

  // The person's own close (the close mark, ctrl+x x) reaches the mod here;
  // the literal id, so `claude plugin validate` lists it.
  on('ui.close', { id: 'autoloop' }, async ($, e, next) => {
    const closed = await next(e)
    await setPaneOpen($, false)
    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whether the surface docks a pane, for the unasked open (item 13):
    // read on every draw, since a remote surface reports it once attached.
    isFullscreen = e.viewport?.isFullscreen ?? null
    if (e.props.hasSurvey) return next(e)
    const state = await readState($)
    if (!isDrawable(state.last)) return next(e)
    return bandTree($.ui.resolve(e), { ...state, ...(await readTick($)), last: state.last }, await $.clock.now(), e.props.bodyColumns, state.paneOpen)
  })

  // The spinner's word while the session owns a run with a unit (item 4):
  // the engine's suffix and time stay; without a unit the word is the engine's.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const state = await readState($)
    const word = isDrawable(state.last) ? spinnerWord(state.last) : null
    return word === null ? next(e) : next({ ...e, props: { ...e.props, word } })
  })

  // The /autoloop output row draws the band's card (item 5); the command's
  // other answers (close, an unknown argument, a session that owns no run)
  // keep their text. The transcript row has no body width: the viewport's.
  on('ui.render', { component: 'CommandOutput', props: { command: 'autoloop' } }, async ($, e, next) => {
    if (e.props.args.trim() !== '' || e.props.isErrored) return next(e)
    const state = await readState($)
    if (!isDrawable(state.last)) return next(e)
    return bandTree($.ui.resolve(e), { ...state, ...(await readTick($)), last: state.last }, await $.clock.now(), e.viewport?.columns ?? 80, false)
  })

  // The person's scroll over the pane while the Live tab shows moves the
  // window over the lines and turns follow off; the mod draws the window
  // itself, so the engine's own is left where it is. The other tabs scroll
  // as a pane does. (The test engine's `$.ui.scroll` raises `ui.scroll` with
  // the input given, so central.test.ts drives this hook with a person's
  // scroll.)
  on('ui.scroll', { requestId: 'autoloop' }, async ($, e, next) => {
    const state = await readState($)
    if (state.tab !== 'live' || !isDrawable(state.last)) return next(e)
    const id = shownDispatch(state.last, state.streams, state.selected)
    const lineCount = id === null ? 0 : state.streams[id]?.lines.length ?? 0
    const moved = liveScroll(state, e.by, lineCount, liveRoom(e.bodyRows, state.pending !== null))
    await editState($, () => moved)
    return {}
  })

  // The pane (SPEC-central items 8 to 16), drawn by draw.tsx from the state
  // and the handlers given here. The literal, so `claude plugin validate`
  // lists the pane's id (central.test.ts holds PANE_ID to it). The tick's
  // clock is read too, so the elapsed times move with it.
  on('ui.render', { component: 'Pane', requestId: 'autoloop' }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const state = await readState($)
    await readTick($)
    if (!isDrawable(state.last)) return empty(kit, quietReason(state.last))
    return paneTree(kit, { ...state, last: state.last }, {
      nowMs: await $.clock.now(),
      sessionId: await $.session.id(),
      bodyColumns: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      read: () => readState($),
      edit: (change) => editState($, change),
      send: (control) => sendControl(controlHost($), control),
    })
  })
}
