// The band's Loop and Work columns (docs/specs/SPEC-status-mod.md, items 7,
// 10, 12, 13 and 17): the pure view functions over the producer's own
// projections (fixtures/projection.ts), and the band drawn through the mod
// with a doubled host. The header counts from the mock clock; the tick's
// duration is read back from state.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement } from 'claude-code'
import type { StatusProjection, StatusState } from '../../types'

import { FALLBACK, IDLE, IDLE_DELIVERED, OPEN_FINDINGS, OWNED, REPLAN, RUN, WAITING } from './fixtures/projection'
import { parseProjection } from './read'
import { PALETTE } from './theme'
import { checkedAgo, columnWidths, isNarrow, loopColumn, shortModel, workColumn } from './view'

const PERIOD_MS = 3000

function projection(text: string): StatusProjection {
  const parsed = parseProjection(text)
  if (parsed === null) throw new Error('the fixture is not a projection')
  return parsed
}

function ran(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** Seats the host beneath the mod: the clock, the session id, the registry, no proxy, and the producer. */
function host(on: On, stdout: () => string, options: { holdMs?: number } = {}) {
  const clock = mock.clock(on)
  mock.env(on, {})
  let held: StatusState | null = null
  const logged: string[] = []
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', async () => {
    if (options.holdMs !== undefined) await clock.sleep(options.holdMs)
    return { value: ran(stdout()) }
  })
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('state.set', { plugin: 'autoloop', key: 'status' }, ($, e, next) => {
    held = e.value
    return next(e)
  })
  return { clock, held: () => held, logged }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

function band($: Engine, bodyColumns = 160) {
  return $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns, scroll: { offset: 0, bodyRows: 7 }, view: {} },
  })
}

function texts(tree: RenderElement): string {
  if (tree.type === 'Button') return `[${tree.props.label}]`
  const children = 'children' in tree ? tree.children ?? [] : []
  return children.map((child) => (typeof child === 'string' ? child : texts(child))).join('')
}

/** The band's rows: a column Box, or a row Box of Boxes, lists its children's rows; a row Box of texts is one row. */
function rows(tree: RenderElement): string[] {
  const children = 'children' in tree ? tree.children ?? [] : []
  const column = tree.type === 'Box' && tree.props?.['flexDirection'] === 'column'
  const holdsBoxes = children.some((child) => typeof child !== 'string' && child.type === 'Box')
  if (tree.type !== 'Box' || (!column && !holdsBoxes)) return [texts(tree)]
  return children.flatMap((child) => (typeof child === 'string' ? [child] : rows(child)))
}

function findColor(tree: RenderElement, text: string): string | undefined {
  if (tree.type === 'Text' && (tree.children ?? []).includes(text)) return tree.props?.['color'] as string | undefined
  const children = 'children' in tree ? tree.children ?? [] : []
  for (const child of children) {
    if (typeof child === 'string') continue
    const found = findColor(child, text)
    if (found !== undefined) return found
  }
  return undefined
}

test('shortModel names a model as step.mjs does', () => {
  // The expected names are step.mjs shortModel's own output on this list
  // (`node -e "import('./tools/step.mjs').then(m => ...)"`), so the two stay one rule.
  expect(['claude-opus-5-5', 'anthropic-gateway-fable[1m]', 'gpt-6-astra', 'gpt-sol-fast', 'claude-haiku-4-5-20251001', 'opus[1m]', null]
    .map(shortModel)).toEqual(['OPUS 5.5', 'FABLE', 'ASTRA 6', 'GPT-SOL-FAST', 'HAIKU 4.5', 'OPUS', ''])
})

test('the Loop column: an in-flight fix round names the phase, issue, title, role, round and pinned model', () => {
  const loop = loopColumn(projection(RUN), false)
  expect(loop.glyph).toBe('●')
  expect(loop.head).toBe('review #412 · Session recovery')
  expect(loop.detail).toBe('code-review · fix 2/3 · ASTRA 6')
})

test('the Loop column: a re-plan round, an open-findings round, and a returned unit with no round', () => {
  expect(loopColumn(projection(REPLAN), false).detail).toBe('code-review · re-plan · ASTRA 6')
  expect(loopColumn(projection(OPEN_FINDINGS), false).detail).toBe('code-review · open findings · ASTRA 6')
  const returned = loopColumn(projection(FALLBACK), false)
  expect(returned.glyph).toBe('●')
  expect(returned.head).toBe('simplify #413 · Simplify the guard')
})

test('the Loop column: a fallback model says so, named as the one that ran', () => {
  expect(loopColumn(projection(FALLBACK), false).detail).toBe('simplify · OPUS 5.5 (fallback)')
})

test('the Loop column: idle with the newest delivered unit, idle with none, and a unit without a title', () => {
  const delivered = loopColumn(projection(IDLE_DELIVERED), false)
  expect(delivered.glyph).toBe('○')
  expect(delivered.head).toBe('Idle · last delivered #416')
  expect(delivered.detail).toBeNull()
  expect(loopColumn(projection(IDLE), false).head).toBe('Idle')
  expect(loopColumn(projection(WAITING), false).head).toBe('Idle')
  expect(loopColumn(projection(OWNED), false).head).toBe('review #412')
})

test('narrow: the Loop column drops the title; 120 columns is not narrow', () => {
  expect(isNarrow(119)).toBe(true)
  expect(isNarrow(120)).toBe(false)
  expect(loopColumn(projection(RUN), true).head).toBe('review #412')
  expect(loopColumn(projection(RUN), true).detail).toBe('code-review · fix 2/3 · ASTRA 6')
})

test('the Work column counts, hot only when a unit needs you', () => {
  expect(workColumn(projection(RUN))).toEqual({ counts: '2 active · 3 waiting', needsYou: '6 needs you', hot: true })
  expect(workColumn(projection(OWNED))).toEqual({ counts: '1 active · 0 waiting', needsYou: '0 needs you', hot: false })
  expect(workColumn(projection(WAITING))).toEqual({ counts: '0 active · 2 waiting', needsYou: '0 needs you', hot: false })
})

test('the header counts from the last successful read', () => {
  expect(checkedAgo(3000, 3000)).toBe('checked 0s ago')
  expect(checkedAgo(3000, 7400)).toBe('checked 4s ago')
  expect(checkedAgo(null, 7400)).toBe('not checked yet')
})

test('column widths share the body: two columns without the proxy, three with it', () => {
  expect(columnWidths(160, 2)).toEqual([80, 80])
  expect(columnWidths(160, 3)).toEqual([53, 53, 54])
  expect(columnWidths(100, 3)).toEqual([33, 33, 34])
})

test('the band draws the header, the Loop column and the Work column from the projection', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(2000)
  const drawn = await band($)
  expect(rows(drawn)).toEqual([
    '◆ autoloop · checked 2s ago · [expand]',
    '● review #412 · Session recovery',
    'code-review · fix 2/3 · ASTRA 6',
    '2 active · 3 waiting · 6 needs you',
    '✓ plan  ✓ build  ✓ simplify  ● review  ○ gate  ○ deliver',
    '! #417 Needs a policy answeranswer on #417 · +5 more',
  ])
  expect(findColor(drawn, '6 needs you')).toBe(PALETTE.crit)
})

test('needs you wears the ink color while nothing is blocked', async ($, on) => {
  const h = host(on, () => OWNED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($)
  expect(findColor(drawn, '0 needs you')).toBe(PALETTE.ink)
})

test('quiet minimum: the header plus one row per column when nothing is in flight or blocked', async ($, on) => {
  const h = host(on, () => IDLE)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($))).toEqual([
    '◆ autoloop · checked 0s ago · [expand]',
    '○ Idle',
    '0 active · 1 waiting · 0 needs you',
  ])
})

test('under 120 columns the Loop column drops the title', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($, 100))[1]).toBe('● review #412')
  expect(rows(await band($, 120))[1]).toBe('● review #412 · Session recovery')
})

test('expand is a Button with hotkey e that only marks the pane open', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($)
  const button = (function find(tree: RenderElement): RenderElement | null {
    if (tree.type === 'Button') return tree
    const children = 'children' in tree ? tree.children ?? [] : []
    for (const child of children) {
      if (typeof child === 'string') continue
      const found = find(child)
      if (found !== null) return found
    }
    return null
  })(drawn)
  expect(button?.type).toBe('Button')
  expect(button?.type === 'Button' ? button.props.hotkey : null).toBe('e')
  expect(h.held()?.paneOpen).toBe(false)
  await $.ui.press({ plugin: 'autoloop', key: 'expand' })
  expect(h.held()?.paneOpen).toBe(true)
  expect(h.held()?.last?.unit?.issue).toBe(412)
})

test('the tick records its duration; one over 500 ms is logged once', async ($, on) => {
  const h = host(on, () => RUN, { holdMs: 700 })
  await start($)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(700)
  expect(h.held()?.lastMs).toBe(700)
  expect(h.logged.length).toBe(1)
  expect(h.logged[0]).toMatch(/700 ms/u)
  await h.clock.advance(PERIOD_MS + 700)
  expect(h.logged.length).toBe(1)
})
