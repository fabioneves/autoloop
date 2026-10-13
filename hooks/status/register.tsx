// The status mod (docs/specs/SPEC-status-mod.md, docs/specs/SPEC-central.md):
// a band above the prompt and, on request, a pane for the session that owns
// a run. This module holds the hooks; the reads are in read.ts, the band's
// text in view.ts, the pane's sections in pane.ts, the palette, glyphs and
// element builders in kit.ts. The band draws only from a projection that is
// owned and enabled, so every other session sees no change; the pane opens
// only on /autoloop.
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'
import { update } from 'claude-code'

import type { StatusProjection, StatusState } from '../../types'
import { GLYPH, PALETTE, cell, header, rule, strip } from './kit'
import { PANE_ID, PANE_TITLE, paneSections } from './pane'
import type { ProxyFetch } from './read'
import { isDrawable, isStale, proxyBase, readProjection, readProxy } from './read'
import {
  HINT, blockedUnits, checkedAgo, columnWidths, headerMarks, isNarrow, loopColumn, needsYouRow, phaseRow, proxyColumn, toastText,
  workColumn,
} from './view'

const STATUS = { plugin: 'autoloop', key: 'status' } as const
const PERIOD_MS = 3000
/** A tick past this is reported once: the period is not raised by itself (tasks/plan-status-mod.md, risks). */
const SLOW_TICK_MS = 500
const EMPTY: StatusState = { last: null, lastOkAtMs: null, lastMs: null, proxy: null, seenBlocked: [], paneOpen: false }
/** The mod's state as last written; EMPTY before the first tick. */
const heldState = async ($: EngineInterface): Promise<StatusState> => (await $.state.get(STATUS)).value ?? EMPTY
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

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'autoloop', description: 'Show the state of the run this session owns.' })
    // The proxy is optional: without the variable the cell does not exist
    // and nothing is fetched; a base that is not a loopback URL counts as
    // unset. `claudeproxy` sets it before the session starts.
    const base = proxyBase(await $.env.get('ANTHROPIC_BASE_URL'))
    const run = (argv: readonly string[], init: { timeoutMs: number }) => $.process.run(argv, init)
    // $.http.fetch has no timeout of its own: the read races a clock wait,
    // which the settled fetch then aborts.
    const fetch: ProxyFetch = (url, { timeoutMs }) => {
      const stop = new AbortController()
      const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(() => {
        throw new Error(`no answer within ${timeoutMs} ms`)
      })
      return Promise.race([$.http.fetch(url), timeout]).finally(() => stop.abort())
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
        const [read, proxy] = await Promise.all([
          readProjection(run, $.plugin.root, sessionId),
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

  // The literal, so `claude plugin validate` lists the pane's id (pane.test.ts holds PANE_ID to it).
  on('ui.render', { component: 'Pane', requestId: 'autoloop' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const held = await heldState($)
    if (!isDrawable(held.last)) return <Text color={PALETTE.ink2}>{quietReason(held.last)}</Text>
    const sections = paneSections(held.last, held.proxy, await $.session.id(), await $.clock.now())
    const glyphColor = (glyph: string) => (glyph === GLYPH.needsYou ? PALETTE.crit : glyph === GLYPH.waiting ? PALETTE.warn : PALETTE.good)
    return (
      <Box flexDirection="column">
        {sections.map((section) => (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={PALETTE.ink2} bold>{section.title}</Text>
            {section.rows.map((row) => (
              <Text color={PALETTE.ink}>
                <Text color={glyphColor(row.glyph)}>{row.glyph}</Text> {row.text}
                {row.chips.map((chip) => <Text color={PALETTE.info}>  {chip}</Text>)}
                {row.mark !== null && <Text> · <Text color={PALETTE.accent}>{row.mark}</Text></Text>}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
