// The status mod (docs/specs/SPEC-status-mod.md): a band above the prompt
// for the session that owns a run. This module holds the hooks; the read is
// in read.ts, the column text in view.ts, the palette in theme.ts. The band
// draws only from a projection that is owned and enabled, so every other
// session sees no change. This release draws the header and the Loop, Work
// and Proxy columns; the phase row, the needs-you row and the pane are later
// tasks.
import type { Register } from 'claude-code'

import type { StatusProjection, StatusState } from '../../types'
import type { ProxyFetch } from './read'
import { isDrawable, readProjection, readProxy } from './read'
import { GLYPH, PALETTE } from './theme'
import { checkedAgo, columnWidths, isNarrow, loopColumn, proxyColumn, workColumn } from './view'

const STATUS = { plugin: 'autoloop', key: 'status' } as const
const PERIOD_MS = 3000
/** A tick past this is reported once: the period is not raised by itself (tasks/plan-status-mod.md, risks). */
const SLOW_TICK_MS = 500
const EMPTY: StatusState = { last: null, lastOkAtMs: null, lastMs: null, proxy: null, seenBlocked: [], paneOpen: false }

/** The command's answer before the pane exists: the worked unit's phase and issue, or idle. */
function summary(projection: StatusProjection): string {
  const unit = projection.unit ?? null
  return unit === null ? 'idle' : `${unit.phase} #${unit.issue}`
}

export const register: Register = (on) => {
  // Module state, not `$.state`: a reload drops the old timer with it.
  let busy = false
  let slowReported = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'autoloop', description: 'Show the state of the run this session owns.' })
    // Ownership is the session's: the producer matches this id against the
    // run latch of the Claude process it runs under.
    const sessionId = await $.session.id()
    // The proxy is optional: without the variable the column does not exist
    // and nothing is fetched. `claudeproxy` sets it before the session starts.
    const base = await $.env.get('ANTHROPIC_BASE_URL')
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
        const [read, proxy] = await Promise.all([
          readProjection(run, $.plugin.root, sessionId),
          base === undefined || base === '' ? null : readProxy(fetch, base),
        ])
        const nowMs = await $.clock.now()
        const lastMs = nowMs - startedAtMs
        const held = (await $.state.get(STATUS)).value ?? EMPTY
        // A failed projection read keeps the last projection; lastOkAtMs not
        // moving is what marks it stale. The proxy read is taken as it came:
        // OFF is a fact.
        await $.state.set(STATUS, read.ok
          ? { ...held, last: read.projection, lastOkAtMs: nowMs, lastMs, proxy }
          : { ...held, lastMs, proxy })
        if (lastMs > SLOW_TICK_MS && !slowReported) {
          slowReported = true
          $.ui.log(`autoloop status: a tick took ${lastMs} ms (period ${PERIOD_MS} ms)`)
        }
      } finally {
        busy = false
      }
    }
    $.clock.every(PERIOD_MS, () => {
      void tick()
    })
    return next(e)
  })

  on('command.run', { command: 'autoloop' }, async ($) => {
    const last = (await $.state.get(STATUS)).value?.last ?? null
    if (last === null || last.owned !== true) return { text: 'autoloop: this session owns no run' }
    // The pane is a later task; until then the command answers the band's line.
    return { text: `autoloop: ${summary(last)}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const held = (await $.state.get(STATUS)).value ?? EMPTY
    if (!isDrawable(held.last)) return next(e)
    const nowMs = await $.clock.now()
    const narrow = isNarrow(e.props.bodyColumns)
    const loop = loopColumn(held.last, narrow)
    const work = workColumn(held.last)
    const proxy = held.proxy === null ? null : proxyColumn(held.proxy, narrow)
    const [loopWidth, workWidth, proxyWidth] = columnWidths(e.props.bodyColumns, proxy === null ? 2 : 3)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The pane is a later task: the press only marks it open in state.
    const expand = async () => {
      const current = (await $.state.get(STATUS)).value ?? EMPTY
      await $.state.set(STATUS, { ...current, paneOpen: true })
    }
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={PALETTE.ink}>
            <Text color={PALETTE.accent}>{GLYPH.brand}</Text> autoloop · {checkedAgo(held.lastOkAtMs, nowMs)} ·{' '}
          </Text>
          <Button key="expand" label="expand" hotkey="e" plain onPress={() => void expand()} />
        </Box>
        <Box>
          <Box flexDirection="column" width={loopWidth}>
            <Text color={PALETTE.ink}>
              <Text color={PALETTE.good}>{loop.glyph}</Text> {loop.head}
            </Text>
            {loop.detail !== null && <Text color={PALETTE.ink2}>{loop.detail}</Text>}
          </Box>
          <Box flexDirection="column" width={workWidth}>
            <Text color={PALETTE.ink}>
              {work.counts} · <Text color={work.hot ? PALETTE.crit : PALETTE.ink}>{work.needsYou}</Text>
            </Text>
          </Box>
          {proxy !== null && (
            <Box flexDirection="column" width={proxyWidth}>
              <Text color={PALETTE.ink}>
                <Text color={proxy.on ? PALETTE.good : PALETTE.warn}>{proxy.on ? GLYPH.active : GLYPH.notYet}</Text>{' '}
                <Text color={proxy.on ? PALETTE.good : PALETTE.warn}>{proxy.word}</Text>{proxy.tail}
              </Text>
              {proxy.rows.map((row) => <Text color={PALETTE.ink2}>{row}</Text>)}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
