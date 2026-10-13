// The status mod (docs/specs/SPEC-status-mod.md, docs/specs/SPEC-central.md):
// a band above the prompt and, on request, a pane for the session that owns
// a run. This module holds the hooks; the reads (the projection, the proxy,
// the live tails) are in read.ts, the stream's renderer in render.ts, the
// band's text in view.ts, the pane's tabs in central.ts, the palette,
// glyphs and element builders in kit.ts. The band draws only from a projection that is
// owned and enabled, so every other session sees no change; the pane opens
// only on /autoloop.
import type { EngineInterface, Register, RenderChildren, RenderElement, Timer } from 'claude-code'
import { update } from 'claude-code'

import type { StatusProjection, StatusState, StatusStream } from '../../types'
import type { Row, Section } from './central'
import {
  LOG_FILTERS, LOG_LENGTH, PANE_ID, PANE_TITLE, TABS, glyphTone, liveRoom, liveScroll, liveTab, logTab, runTab, shownDispatch, statusLine, unitsTab,
} from './central'
import { GLYPH, PALETTE, cell, empty, header, rule, section, strip, tabs } from './kit'
import type { ProxyFetch, Runner } from './read'
import {
  LIVE_PERIOD_MS, STREAM_LINES_MAX, isDrawable, isStale, proxyBase, pruneStreams, readProjection, readProxy, runningDispatches, tailLive,
} from './read'
import {
  HINT, blockedUnits, checkedAgo, columnWidths, headerMarks, isNarrow, loopColumn, needsYouRow, phaseRow, proxyColumn, toastText,
  workColumn,
} from './view'

const STATUS = { plugin: 'autoloop', key: 'status' } as const
const PERIOD_MS = 3000
/** A tick past this is reported once: the period is not raised by itself (tasks/plan-status-mod.md, risks). */
const SLOW_TICK_MS = 500
const EMPTY: StatusState = {
  last: null, lastOkAtMs: null, lastMs: null, proxy: null, seenBlocked: [], paneOpen: false, streams: {},
  tab: 'run', logFilter: 'all', selected: null, follow: true, liveOffset: 0,
}
/** The mod's state as last written, EMPTY before the first tick; a field an older module never wrote takes EMPTY's. */
const heldState = async ($: EngineInterface): Promise<StatusState> => ({ ...EMPTY, ...(await $.state.get(STATUS)).value })
/** Whether the pane is open, written where the pane opens or closes; the band reads it to draw one row. */
const setPaneOpen = ($: EngineInterface, paneOpen: boolean) =>
  update($, STATUS, (held) => ({ ...(held ?? EMPTY), paneOpen }))
/** Why the pane and the command stay quiet while the projection is not drawable: not the owner, or the band turned off. */
function quietReason(projection: StatusProjection | null): string {
  return projection === null || projection.owned !== true
    ? 'autoloop: this session owns no run'
    : 'autoloop: the status band is off (ui.status is false in .autoloop/config.json)'
}

export const register: Register = (on) => {
  // Module state, not `$.state`: a reload drops the old timer with it.
  let busy = false
  let slowReported = false
  let faultReported = false
  let timer: Timer | null = null
  // The live tails: a 1 s timer while a dispatch runs, and the last chunk
  // tail printed per dispatch, so growth is the chunk differing. The chunks
  // are the tick's working memory, not a drawing's source: a reload drops
  // them, and the next tick reads every file as grown once.
  let liveBusy = false
  let liveTimer: Timer | null = null
  const chunks = new Map<string, string>()

  on('session.start', async ($, e, next) => {
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
    // lines; a tick still running is skipped by the next second.
    const liveTick = async () => {
      if (liveBusy) return
      liveBusy = true
      try {
        const running = runningDispatches((await heldState($)).last)
        if (running.length === 0) return
        const nowMs = await $.clock.now()
        const tailed = await Promise.all(running.map(async (dispatch) => ({ id: dispatch.dispatch, tail: await tailLive(run, dispatch.liveFile) })))
        const grown: { id: string; stream: Omit<StatusStream, 'lastGrewAtMs'>; grew: boolean }[] = []
        for (const { id, tail } of tailed) {
          if (tail === null) continue
          grown.push({ id, grew: chunks.get(id) !== tail.chunk, stream: { lines: tail.lines.slice(-STREAM_LINES_MAX), bytes: tail.chunk.length } })
          chunks.set(id, tail.chunk)
        }
        await update($, STATUS, (value) => {
          const held = value ?? EMPTY
          const streams = { ...held.streams }
          for (const { id, stream, grew } of grown) {
            const before = held.streams[id]
            streams[id] = { ...stream, lastGrewAtMs: grew || before === undefined ? nowMs : before.lastGrewAtMs }
          }
          return { ...held, streams: pruneStreams(streams, running.map((dispatch) => dispatch.dispatch)) }
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
      try {
        const startedAtMs = await $.clock.now()
        // Ownership is the session's: the producer matches this id against
        // the run latch of the Claude process it runs under. Read on every
        // tick, since after a /clear the process goes on under a new id with
        // no session.start.
        const sessionId = await $.session.id()
        // The Log tab is the whole log: 500 entries while it shows, the
        // producer's default otherwise.
        const logLength = (await heldState($)).tab === 'log' ? LOG_LENGTH : null
        const [read, proxy] = await Promise.all([
          readProjection(run, $.plugin.root, sessionId, logLength),
          base === null ? null : readProxy(fetch, base),
        ])
        const nowMs = await $.clock.now()
        const lastMs = nowMs - startedAtMs
        // A unit blocked for the first time in this session is toasted once:
        // the seen list lives in $.state, so a reload does not toast it again.
        // The write goes through `update`, so a pane flag written meanwhile
        // is kept. A failed projection read keeps the last projection;
        // lastOkAtMs not moving is what marks it stale. The proxy read is
        // taken as it came: UP and OFF are facts.
        let fresh: ReturnType<typeof blockedUnits> = []
        await update($, STATUS, (value) => {
          const held = value ?? EMPTY
          if (!read.ok) return { ...held, lastMs, proxy }
          fresh = isDrawable(read.projection)
            ? blockedUnits(read.projection).filter((unit) => !held.seenBlocked.includes(unit.issue)) : []
          return { ...held, last: read.projection, lastOkAtMs: nowMs, lastMs, proxy, seenBlocked: [...held.seenBlocked, ...fresh.map((unit) => unit.issue)] }
        })
        for (const unit of fresh) $.ui.toast(toastText({ issue: unit.issue, text: unit.needsYou.text }))
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
  // never draws a run this conversation does not own.
  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = null
    liveTimer?.cancel()
    liveTimer = null
    chunks.clear()
    await $.state.set(STATUS, EMPTY)
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
    const { last } = await heldState($)
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
    if (e.props.hasSurvey) return next(e)
    const held = await heldState($)
    if (!isDrawable(held.last)) return next(e)
    const nowMs = await $.clock.now()
    // Stale: the glyphs that mean "running now" draw hollow, since nothing
    // confirms it (spec item 11).
    const stale = isStale(held.lastOkAtMs, nowMs)
    const live = (glyph: string) => (stale && glyph === GLYPH.active ? GLYPH.notYet : glyph)
    // The one-row form takes the narrow texts whatever the width.
    const narrow = isNarrow(e.props.bodyColumns) || held.paneOpen
    const loop = loopColumn(held.last, narrow)
    const work = workColumn(held.last)
    const proxy = held.proxy === null ? null : proxyColumn(held.proxy, narrow)
    const kit = $.ui.resolve(e)
    const { Box, Text } = kit
    // ON is good; UP and OFF are warnings: the glyph and the word wear the same color.
    const proxyColor = proxy?.state === 'on' ? PALETTE.good : PALETTE.warn
    const brand = (
      <Text color={PALETTE.ink}>
        <Text color={PALETTE.accent}>{GLYPH.brand}</Text> autoloop · {checkedAgo(held.lastOkAtMs, nowMs)}
        {headerMarks(held.last, stale).map((mark) => <Text> · <Text color={PALETTE.warn}>{mark}</Text></Text>)}
      </Text>
    )
    const loopHead = (
      <Text color={PALETTE.ink} wrap="truncate-end">
        <Text color={PALETTE.good}>{live(loop.glyph)}</Text> {loop.head}
      </Text>
    )
    const workText = (
      <Text color={PALETTE.ink}>
        {work.counts}{work.needsYou !== null && <Text> · <Text color={PALETTE.crit}>{work.needsYou}</Text></Text>}
      </Text>
    )
    const proxyHead = proxy === null ? null : (
      <Text color={PALETTE.ink}>
        <Text color={proxyColor}>{live(proxy.glyph)}</Text> <Text color={proxyColor}>{proxy.word}</Text>{proxy.tail}
      </Text>
    )
    const sep = <Text color={PALETTE.ink3}> {GLYPH.rule} </Text>
    if (held.paneOpen) {
      return (
        <Box borderStyle="round" borderColor={PALETTE.ink3} paddingX={1}>
          <Text color={PALETTE.ink} wrap="truncate-end">
            {brand}{sep}{loopHead}{sep}{workText}{proxyHead !== null && <Text>{sep}{proxyHead}</Text>} · <Text color={PALETTE.ink2}>{HINT}</Text>
          </Text>
        </Box>
      )
    }
    const bodies: { title: string; rows: RenderChildren[] }[] = [
      { title: 'loop', rows: [loopHead, loop.detail === null ? null : <Text color={PALETTE.ink2}>{loop.detail}</Text>] },
      { title: 'work', rows: [workText] },
      ...(proxy === null ? [] : [{ title: 'proxy', rows: [proxyHead, ...proxy.rows.map((row) => <Text color={PALETTE.ink2}>{row}</Text>)] }]),
    ]
    const height = 1 + Math.max(...bodies.map((body) => body.rows.filter((row) => row !== null).length))
    const widths = columnWidths(e.props.bodyColumns, bodies.length)
    const phases = phaseRow(held.last)
    const needsYou = needsYouRow(held.last)
    const phaseGlyph = (state: 'done' | 'current' | 'notYet') =>
      (state === 'done' ? GLYPH.done : state === 'current' ? live(GLYPH.active) : GLYPH.notYet)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={PALETTE.ink3}>
        <Box paddingX={1}>{header(kit, brand, HINT)}</Box>
        <Box>
          {bodies.flatMap((body, index) => [
            index === 0 ? null : rule(kit, height),
            cell(kit, body.title, body.rows, widths[index] ?? 0),
          ])}
        </Box>
        {phases !== null && (
          <Box paddingX={1}>
            <Text color={PALETTE.ink}>
              {phases.map((phase, index) => {
                const notYet = phase.state === 'notYet'
                return (
                  <Text color={notYet ? PALETTE.ink3 : PALETTE.ink}>
                    {index === 0 ? '' : '  '}<Text color={notYet ? PALETTE.ink3 : PALETTE.good}>{phaseGlyph(phase.state)}</Text> {phase.label}
                  </Text>
                )
              })}
            </Text>
          </Box>
        )}
        {needsYou !== null && strip(kit,
          [<Text color={PALETTE.crit} bold>{GLYPH.needsYou}</Text>, ' #', needsYou.issue, ' ', needsYou.text],
          `${needsYou.right}${needsYou.more > 0 ? ` · +${needsYou.more} more` : ''}`)}
      </Box>
    )
  })

  // The person's scroll over the pane while the Live tab shows moves the
  // window over the lines and turns follow off; the mod draws the window
  // itself, so the engine's own is left where it is. The other tabs scroll
  // as a pane does. (The test engine raises `ui.scroll` with the
  // `$.ui.scroll` argument, not the person's input, so central.test.ts holds
  // `liveScroll` to the rule and not this hook.)
  on('ui.scroll', { requestId: 'autoloop' }, async ($, e, next) => {
    const held = await heldState($)
    if (held.tab !== 'live' || !isDrawable(held.last)) return next(e)
    const id = shownDispatch(held.last, held.streams, held.selected)
    const lineCount = id === null ? 0 : held.streams[id]?.lines.length ?? 0
    const moved = liveScroll(held, e.by, lineCount, liveRoom(e.bodyRows))
    await update($, STATUS, (value) => ({ ...EMPTY, ...value, ...moved }))
    return {}
  })

  // The literal, so `claude plugin validate` lists the pane's id (central.test.ts holds PANE_ID to it).
  on('ui.render', { component: 'Pane', requestId: 'autoloop' }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const { Box, Text, Button } = kit
    const held = await heldState($)
    if (!isDrawable(held.last)) return <Text color={PALETTE.ink2}>{quietReason(held.last)}</Text>
    const projection = held.last
    const nowMs = await $.clock.now()
    const sessionId = await $.session.id()
    const setTab = (tab: StatusState['tab']) => update($, STATUS, (value) => ({ ...EMPTY, ...value, tab }))
    const setFilter = (logFilter: StatusState['logFilter']) => update($, STATUS, (value) => ({ ...EMPTY, ...value, logFilter }))
    const drawRow = (r: Row): RenderElement => (
      <Box justifyContent="space-between">
        <Text color={r.dim ? PALETTE.ink2 : PALETTE.ink} wrap="truncate-end">
          {r.lead !== null && <Text color={PALETTE.ink2}>{r.lead}  </Text>}
          {r.glyph !== '' && <Text color={PALETTE[glyphTone(r.glyph)]}>{r.glyph}</Text>}{r.glyph !== '' && ' '}{r.text}
        </Text>
        {r.right !== null && <Text color={PALETTE.ink2}> {r.right}</Text>}
      </Box>
    )
    const drawSection = (s: Section) => section(kit, s.title, s.rows.map(drawRow))
    const body = (): RenderChildren[] => {
      if (held.tab === 'run') {
        const run = runTab(projection, held.proxy, sessionId, nowMs, e.props.bodyColumns)
        return [run.empty !== null && section(kit, 'Now', [empty(kit, run.empty)]), ...run.sections.map(drawSection)]
      }
      if (held.tab === 'units') return unitsTab(projection, nowMs).map(drawRow)
      if (held.tab === 'log') {
        return [
          <Box gap={1}>
            {LOG_FILTERS.map(({ filter, label }) => (
              <Button key={`filter-${filter}`} label={label} plain {...(held.logFilter === filter ? { variant: 'primary' as const } : {})} onPress={() => setFilter(filter)} />
            ))}
            <Text color={PALETTE.ink2}>UTC</Text>
          </Box>,
          ...logTab(projection, held.logFilter).map(drawRow),
        ]
      }
      // Live: a button per running dispatch, `f` for follow, the shown
      // dispatch's title and its lines in the window.
      const view = liveTab(projection, held.streams, held, nowMs, e.props.scroll.bodyRows, e.props.bodyColumns)
      if (view.shown === null) return [empty(kit, 'no dispatch has run yet')]
      const select = (selected: string) => update($, STATUS, (value) => ({ ...EMPTY, ...value, selected }))
      const toggleFollow = () => update($, STATUS, (value) => ({ ...EMPTY, ...value, follow: !(value?.follow ?? true) }))
      return [
        <Box gap={1}>
          {view.buttons.map((button) => (
            <Button key={`live-${button.id}`} label={button.label} plain {...(button.hotkey === null ? {} : { hotkey: button.hotkey })}
              {...(button.active ? { variant: 'primary' as const } : {})} onPress={() => select(button.id)} />
          ))}
          <Button key="follow" label="follow" hotkey="f" plain {...(held.follow ? { variant: 'primary' as const } : {})} onPress={toggleFollow} />
        </Box>,
        <Text color={PALETTE.ink} wrap="truncate-end">{view.shown.title}</Text>,
        ...view.shown.lines.map((line) => <Text color={line.dim ? PALETTE.ink2 : PALETTE.ink} wrap="truncate-end">{line.text}</Text>),
      ]
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {header(kit, <Text color={PALETTE.ink}><Text color={PALETTE.accent}>{GLYPH.brand}</Text> autoloop · {statusLine(projection)}</Text>)}
          {tabs(kit, TABS.map(({ tab, label, hotkey }) => ({ label, hotkey, active: held.tab === tab, onPress: () => setTab(tab) })))}
        </Box>
        {held.tab === 'run' ? <Box flexDirection="column" gap={1}>{body()}</Box> : <Box flexDirection="column">{body()}</Box>}
      </Box>
    )
  })
}
