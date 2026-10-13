// The drawings (docs/specs/SPEC-central.md, items 7 to 16): the band's card
// and the pane, as element trees over the surface's table. They hold no `$`:
// register.tsx hands them the table it resolved, the state as last written
// and, for the pane, the handlers behind its buttons and inputs. The texts
// come from view.ts and central.ts; the small builders from kit.ts.
import type { Elements, RenderChildren, RenderElement } from 'claude-code'

import type { StatusPending, StatusProjection, StatusState, StatusTick } from '../../types'
import type { Row, RowAction, Section } from './central'
import { LOG_FILTERS, TABS, glyphTone, liveTab, logTab, pendingQuestion, runTab, statusLine, unitsTab } from './central'
import type { Control } from './control'
import type { Kit } from './kit'
import { GLYPH, PALETTE, cell, empty, header, plain, rule, section, strip, tabs } from './kit'
import { isStale } from './read'
import { HINT, checkedAgo, columnWidths, headerMarks, isNarrow, loopColumn, needsYouRow, phaseRow, proxyColumn, workColumn } from './view'

/** The state while the band or the pane draws: its last projection is drawable (read.ts `isDrawable`). */
export type Drawable = StatusState & { last: StatusProjection }
/** The band draws the tick's clock too: `checked Ns ago` and the stale mark. */
export type BandState = Drawable & StatusTick

/**
 * The band's card (SPEC-central item 7): the header, the three cells, the
 * phase row and the needs-you strip; one row (the header and the cells) when
 * `oneRow`, as while the pane is open. Drawn above the prompt and, for the
 * /autoloop output row, in the transcript.
 */
export function bandTree(kit: Kit, state: BandState, nowMs: number, bodyColumns: number, oneRow: boolean): RenderElement {
  const { Box, Text } = kit
  // Stale: the glyphs that mean "running now" draw hollow, since nothing
  // confirms it (spec item 11).
  const stale = isStale(state.lastOkAtMs, nowMs)
  const live = (glyph: string) => (stale && glyph === GLYPH.active ? GLYPH.notYet : glyph)
  // The one-row form takes the narrow texts whatever the width.
  const narrow = isNarrow(bodyColumns) || oneRow
  const loop = loopColumn(state.last, narrow)
  const work = workColumn(state.last)
  const proxy = state.proxy === null ? null : proxyColumn(state.proxy, narrow)
  // ON is good; UP and OFF are warnings: the glyph and the word wear the same color.
  const proxyColor = proxy?.state === 'on' ? PALETTE.good : PALETTE.warn
  const brand = (
    <Text color={PALETTE.ink}>
      <Text color={PALETTE.accent}>{GLYPH.brand}</Text> autoloop · {checkedAgo(state.lastOkAtMs, nowMs)}
      {headerMarks(state.last, stale).map((mark) => <Text> · <Text color={PALETTE.warn}>{mark}</Text></Text>)}
    </Text>
  )
  const loopHead = (
    <Text color={PALETTE.ink} wrap="truncate-end">
      <Text color={PALETTE.good}>{live(loop.glyph)}</Text> {plain(loop.head)}
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
  if (oneRow) {
    return (
      <Box borderStyle="round" borderColor={PALETTE.ink3} paddingX={1}>
        <Text color={PALETTE.ink} wrap="truncate-end">
          {brand}{sep}{loopHead}{sep}{workText}{proxyHead !== null && <Text>{sep}{proxyHead}</Text>} · <Text color={PALETTE.ink2}>{HINT}</Text>
        </Text>
      </Box>
    )
  }
  const bodies: { title: string; rows: RenderChildren[] }[] = [
    { title: 'loop', rows: [loopHead, loop.detail === null ? null : <Text color={PALETTE.ink2}>{plain(loop.detail)}</Text>] },
    { title: 'work', rows: [workText] },
    ...(proxy === null ? [] : [{ title: 'proxy', rows: [proxyHead, ...proxy.rows.map((row) => <Text color={PALETTE.ink2}>{row}</Text>)] }]),
  ]
  const height = 1 + Math.max(...bodies.map((body) => body.rows.filter((row) => row !== null).length))
  const widths = columnWidths(bodyColumns, bodies.length)
  const phases = phaseRow(state.last)
  const needsYou = needsYouRow(state.last)
  const phaseGlyph = (phase: 'done' | 'current' | 'notYet') =>
    (phase === 'done' ? GLYPH.done : phase === 'current' ? live(GLYPH.active) : GLYPH.notYet)
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
        [<Text color={PALETTE.crit} bold>{GLYPH.needsYou}</Text>, ' #', needsYou.issue, ' ', plain(needsYou.text)],
        `${needsYou.right}${needsYou.more > 0 ? ` · +${needsYou.more} more` : ''}`)}
    </Box>
  )
}

/** The pane's kit: the three elements, and an Input where the surface draws fields (the mobile surface draws none). */
export type PaneKit = Kit & Partial<Pick<Elements['terminal'], 'Input'>>

/** What the pane's hook hands the drawing: the clock, the session, the body's size, and the handlers behind the controls. */
export type PaneHost = {
  nowMs: number
  sessionId: string
  bodyColumns: number
  bodyRows: number
  /** The state as written now: a handler reads it before it acts, never the value the drawing captured. */
  read: () => Promise<StatusState>
  /** One write of the mod's state: the fields `change` returns replace the state's. */
  edit: (change: (state: StatusState) => Partial<StatusState>) => Promise<StatusState>
  /** One control, sent through control.ts. */
  send: (control: Control) => Promise<void>
}

/**
 * The pane (items 8 to 14): the header with the pause button, the tabs, a
 * pending control's question, and the tab's body. The controls (item 16)
 * are its buttons and inputs: each sends one control through `host.send`.
 * A cancel, a merge or an authorize is held as `pending` in the state until
 * its y or n, so the question survives a redraw and a double press asks
 * once; an answer's Enter is its confirmation.
 */
export function paneTree(kit: PaneKit, state: Drawable, host: PaneHost): RenderElement {
  const { Box, Text, Button } = kit
  // The mobile surface draws no field: a block or decide row then stands without its input.
  const Input = kit.Input ?? null
  const projection = state.last
  const setPending = (pending: StatusPending | null) => host.edit(() => ({ pending }))
  const paused = projection.run?.paused === true
  // The press reads the run as last written, not as this drawing saw it: a
  // tick between the draw and the press may have flipped it.
  const pauseButton = (
    <Button key="pause" label={paused ? `${GLYPH.play} resume` : `${GLYPH.paused} pause`} hotkey="p" plain
      onPress={async () => host.send({ kind: (await host.read()).last?.run?.paused === true ? 'unpause' : 'pause' })} />
  )
  const confirmed = (pending: StatusPending): Control => {
    if (pending.kind === 'cancel') return { kind: 'cancel', dispatch: pending.dispatch, issue: pending.issue }
    return pending.kind === 'merge' ? { kind: 'merge', pr: pending.pr } : { kind: 'label', pr: pending.pr }
  }
  const confirmRow = (pending: StatusPending) => (
    <Box gap={1}>
      <Text color={PALETTE.ink}>{plain(pendingQuestion(pending))}</Text>
      <Button key="confirm-yes" label="yes" hotkey="y" plain onPress={async () => {
        await setPending(null)
        await host.send(confirmed(pending))
      }} />
      <Button key="confirm-no" label="no" hotkey="n" plain onPress={() => setPending(null)} />
    </Box>
  )
  // The element a row's action draws: a button at the right that asks y or n, or an Input on the row under.
  const actionButton = (action: RowAction): RenderElement | null => {
    if (action.kind === 'answer') return null
    const key = action.kind === 'cancel' ? `cancel-${action.dispatch}` : `${action.kind}-${action.pr}`
    return <Button key={key} label={action.kind} plain onPress={() => setPending(action)} />
  }
  const drawRow = (r: Row): RenderElement => {
    const line = (
      <Box justifyContent="space-between">
        <Text color={r.dim ? PALETTE.ink2 : PALETTE.ink} wrap="truncate-end">
          {r.lead !== null && <Text color={PALETTE.ink2}>{r.lead}  </Text>}
          {r.glyph !== '' && <Text color={PALETTE[glyphTone(r.glyph)]}>{r.glyph}</Text>}{r.glyph !== '' && ' '}{plain(r.text)}
        </Text>
        {r.right !== null && <Text color={PALETTE.ink2}> {plain(r.right)}</Text>}
        {r.action !== null && actionButton(r.action)}
      </Box>
    )
    if (r.action?.kind !== 'answer' || Input === null) return line
    const issue = r.action.issue
    return (
      <Box flexDirection="column">
        {line}
        <Input key={`answer-${issue}`} placeholder="answer…" onSubmit={(value) => {
          const text = value.trim()
          if (text !== '') void host.send({ kind: 'answer', issue, text })
        }} />
      </Box>
    )
  }
  const drawSection = (s: Section) => section(kit, s.title, s.rows.map(drawRow))
  const body = (): RenderChildren[] => {
    if (state.tab === 'run') {
      const run = runTab(projection, state.proxy, host.sessionId, host.nowMs, host.bodyColumns)
      // The Now section holds the no-unit text and the running dispatches together.
      const now = [...(run.empty === null ? [] : [empty(kit, run.empty)]), ...(run.sections.find((s) => s.title === 'Now')?.rows ?? []).map(drawRow)]
      return [now.length > 0 && section(kit, 'Now', now), ...run.sections.filter((s) => s.title !== 'Now').map(drawSection)]
    }
    if (state.tab === 'units') return unitsTab(projection, host.nowMs).map(drawRow)
    if (state.tab === 'log') {
      return [
        <Box gap={1}>
          {LOG_FILTERS.map(({ filter, label }) => (
            <Button key={`filter-${filter}`} label={label} plain {...(state.logFilter === filter ? { variant: 'primary' as const } : {})}
              onPress={() => host.edit(() => ({ logFilter: filter }))} />
          ))}
          <Text color={PALETTE.ink2}>UTC</Text>
        </Box>,
        ...logTab(projection, state.logFilter).map(drawRow),
      ]
    }
    // Live: a button per running dispatch, `f` for follow, the shown
    // dispatch's title and its lines in the window.
    const view = liveTab(projection, state.streams, state, host.nowMs, host.bodyRows, host.bodyColumns)
    const shown = view.shown
    if (shown === null) return [empty(kit, 'no dispatch has run yet')]
    return [
      <Box gap={1}>
        {view.buttons.map((button) => (
          <Button key={`live-${button.id}`} label={plain(button.label)} plain {...(button.hotkey === null ? {} : { hotkey: button.hotkey })}
            {...(button.active ? { variant: 'primary' as const } : {})} onPress={() => host.edit(() => ({ selected: button.id }))} />
        ))}
        <Button key="follow" label="follow" hotkey="f" plain {...(state.follow ? { variant: 'primary' as const } : {})}
          onPress={() => host.edit((written) => ({ follow: !written.follow }))} />
        {shown.cancel !== null && <Button key="cancel" label="cancel" hotkey="x" plain onPress={() => setPending(shown.cancel)} />}
      </Box>,
      <Text color={PALETTE.ink} wrap="truncate-end">{plain(shown.title)}</Text>,
      ...shown.lines.map((line) => <Text color={line.dim ? PALETTE.ink2 : PALETTE.ink} wrap="truncate-end">{plain(line.text)}</Text>),
    ]
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text color={PALETTE.ink} wrap="truncate-end"><Text color={PALETTE.accent}>{GLYPH.brand}</Text> autoloop · {plain(statusLine(projection))}</Text>
          {pauseButton}
        </Box>
        {tabs(kit, TABS.map(({ tab, label, hotkey }) => ({ label, hotkey, active: state.tab === tab, onPress: () => host.edit(() => ({ tab })) })))}
        {state.pending !== null && confirmRow(state.pending)}
      </Box>
      <Box flexDirection="column" {...(state.tab === 'run' ? { gap: 1 } : {})}>{body()}</Box>
    </Box>
  )
}
