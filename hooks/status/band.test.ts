// The band's rows and states (docs/specs/SPEC-status-mod.md, items 6, 8, 9,
// 11, 12 and 16): the phase row under a worked unit, the needs-you row for
// the oldest unit a human must answer, one toast per newly blocked unit kept
// in $.state through a reload, hollow glyphs and `stale` past 30 s, the
// narrow rules at 119 and 120 columns, and the tick stopping on
// `enabled: false` until the next session.start. The host is doubled; the
// projection text is the producer's own (fixtures/projection.ts); the proxy
// body is hand-written (an external service).
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpResponse, On, ProcessRunResult, RenderElement } from 'claude-code'
import type { StatusProjection, StatusState } from '../../types'

import { BLOCKED_THREE, DISABLED, FALLBACK, IDLE, IDLE_DELIVERED, OPEN_FINDINGS, OWNED, RUN, UNOWNED } from './fixtures/projection'
import { parseProjection } from './read'
import { PALETTE } from './theme'
import { needsYouRow, phaseRow, toastText } from './view'

const PERIOD_MS = 3000
const BASE = 'http://127.0.0.1:8787'
const THREE = JSON.stringify({ ok: true, active_requests: [
  { id: 'r1', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model: 'claude-opus-5-5', model: 'anthropic-gateway-opus[1m]', session_id: 'S-test' },
  { id: 'r2', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model: 'gpt-6-astra', model: null, session_id: 'S-other' },
  { id: 'r3', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model: 'claude-opus-5-5', model: null, session_id: 'S-test' },
] })

function projection(text: string): StatusProjection {
  const parsed = parseProjection(text)
  if (parsed === null) throw new Error('the fixture is not a projection')
  return parsed
}

function ran(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

type Answer = { stdout: string } | { deny: string }

/** Seats the host beneath the mod: the clock, the environment, the session id, the registry, the producer, the proxy, and the toasts. */
function host(on: On, answer: () => Answer, env: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.env(on, env)
  let runs = 0
  let held: StatusState | null = null
  const toasts: string[] = []
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => {
    runs += 1
    const next = answer()
    return 'deny' in next ? { deny: next.deny } : { value: ran(next.stdout) }
  })
  on('http.fetch', () => {
    const response: HttpResponse = { status: 200, ok: true, headers: {}, text: THREE }
    return { value: response }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('state.set', { plugin: 'autoloop', key: 'status' }, ($, e, next) => {
    held = e.value
    return next(e)
  })
  return { clock, runs: () => runs, held: () => held, toasts }
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

/** The Box that holds `text` somewhere beneath it and is nearest to it. */
function boxAround(tree: RenderElement, text: string): RenderElement | null {
  const children = 'children' in tree ? tree.children ?? [] : []
  for (const child of children) {
    if (typeof child === 'string') continue
    const found = boxAround(child, text)
    if (found !== null) return found
  }
  return tree.type === 'Box' && texts(tree).includes(text) ? tree : null
}

const PHASES = ['plan', 'build', 'simplify', 'review', 'gate', 'deliver']

test('the phase row marks the phases before the current done, the current, and the rest not yet; none without a unit', () => {
  expect(phaseRow(projection(RUN))).toEqual(PHASES.map((label, index) => ({ label, state: index < 3 ? 'done' : index === 3 ? 'current' : 'notYet' })))
  expect(phaseRow(projection(FALLBACK))?.map((cell) => cell.state)).toEqual(['done', 'done', 'current', 'notYet', 'notYet', 'notYet'])
  expect(phaseRow(projection(IDLE))).toBeNull()
  expect(phaseRow(projection(IDLE_DELIVERED))).toBeNull()
})

test('the needs-you row names the oldest unit a human must answer, with the answer per kind and the count of the rest', () => {
  expect(needsYouRow(projection(OPEN_FINDINGS))).toEqual({ issue: 419, text: 'Draft handed off after the scan', right: 'answer on #419', more: 0 })
  expect(needsYouRow(projection(BLOCKED_THREE))).toEqual({ issue: 417, text: 'Needs a policy answer', right: 'answer on #417', more: 2 })
  expect(needsYouRow(projection(IDLE_DELIVERED))).toEqual({ issue: 424, text: 'PR awaiting authorization', right: 'merge or label PR #701', more: 0 })
  expect(needsYouRow(projection(RUN))?.more).toBe(5)
  expect(needsYouRow(projection(OWNED))).toBeNull()
  expect(needsYouRow(projection(IDLE))).toBeNull()
})

test('the drawn band: phase row under the columns, then the highlighted needs-you row with the right-hand answer', async ($, on) => {
  const h = host(on, () => ({ stdout: RUN }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($)
  expect(rows(drawn)).toEqual([
    '◆ autoloop · checked 0s ago · [expand]',
    '● review #412 · Session recovery',
    'code-review · fix 2/3 · ASTRA 6',
    '2 active · 3 waiting · 6 needs you',
    '✓ plan  ✓ build  ✓ simplify  ● review  ○ gate  ○ deliver',
    '! #417 Needs a policy answeranswer on #417 · +5 more',
  ])
  expect(findColor(drawn, '!')).toBe(PALETTE.crit)
  const row = boxAround(drawn, 'answer on #417')
  expect(row?.type === 'Box' ? row.props?.['backgroundColor'] : null).toBe(PALETTE.card)
})

test('one needs-you unit draws no `+n more`; no phase row without a unit; no needs-you row without a blocked unit', async ($, on) => {
  const answers = [IDLE_DELIVERED, OWNED, IDLE]
  let index = 0
  const h = host(on, () => ({ stdout: answers[index++] ?? IDLE }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).slice(1)).toEqual([
    '○ Idle · last delivered #416',
    '0 active · 0 waiting · 1 needs you',
    '! #424 PR awaiting authorizationmerge or label PR #701',
  ])
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).slice(1)).toEqual([
    '● review #412',
    'code-review · fix 2/3 · ASTRA 6',
    '1 active · 0 waiting · 0 needs you',
    '✓ plan  ✓ build  ✓ simplify  ● review  ○ gate  ○ deliver',
  ])
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).slice(1)).toEqual(['○ Idle', '0 active · 1 waiting · 0 needs you'])
})

test('toastText shortens the question', () => {
  expect(toastText({ issue: 417, text: 'Needs a policy answer' })).toBe('#417 needs you: Needs a policy answer')
  expect(toastText({ issue: 9, text: 'x'.repeat(80) })).toBe(`#9 needs you: ${'x'.repeat(59)}…`)
})

test('one toast per unit the first time it is blocked: not again on the next tick, nor after a reload, and a new one when a unit joins', async ($, on) => {
  const answers = [OPEN_FINDINGS, OPEN_FINDINGS, BLOCKED_THREE, BLOCKED_THREE]
  let index = 0
  const h = host(on, () => ({ stdout: answers[index++] ?? BLOCKED_THREE }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts).toEqual(['#419 needs you: Draft handed off after the scan'])
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts.length).toBe(1)
  // A reload runs register and session.start again over the state the host
  // kept: what was toasted stays toasted.
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts).toEqual([
    '#419 needs you: Draft handed off after the scan',
    '#417 needs you: Needs a policy answer',
    '#418 needs you: Draft with open findings',
    '#424 needs you: PR awaiting authorization',
  ])
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts.length).toBe(4)
  expect(h.held()?.seenBlocked).toEqual([419, 417, 418, 424])
})

test('no toast while the band is off (ui.status false) or the session owns no run', async ($, on) => {
  const answers = [DISABLED, UNOWNED]
  let index = 0
  const h = host(on, () => ({ stdout: answers[index++] ?? UNOWNED }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts).toEqual([])
})

test('past 30 s without a successful read the header says stale and the glyphs turn hollow', async ($, on) => {
  let calls = 0
  const h = host(on, () => (calls++ === 0 ? { stdout: RUN } : { deny: 'the producer could not start' }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(30_000)
  let drawn = await band($)
  expect(rows(drawn)[0]).toBe('◆ autoloop · checked 30s ago · [expand]')
  expect(rows(drawn)[1]).toBe('● review #412 · Session recovery')
  await h.clock.advance(1)
  drawn = await band($)
  expect(rows(drawn)[0]).toBe('◆ autoloop · stale · checked 30s ago · [expand]')
  expect(findColor(drawn, 'stale')).toBe(PALETTE.warn)
  expect(rows(drawn)[1]).toBe('○ review #412 · Session recovery')
  expect(rows(drawn)[4]).toBe('✓ plan  ✓ build  ✓ simplify  ○ review  ○ gate  ○ deliver')
})

test('narrow: at 119 columns the Loop column drops the title and the proxy collapses; 120 is not narrow', async ($, on) => {
  const h = host(on, () => ({ stdout: RUN }), { ANTHROPIC_BASE_URL: BASE })
  await start($)
  await h.clock.advance(PERIOD_MS)
  const narrow = rows(await band($, 119))
  expect(narrow[1]).toBe('● review #412')
  expect(narrow.slice(4, 5)).toEqual(['● ON · 3 req'])
  const wide = rows(await band($, 120))
  expect(wide[1]).toBe('● review #412 · Session recovery')
  expect(wide.slice(4, 7)).toEqual(['● ON · 3 active requests', 'OPUS 5.5 ×2', 'ASTRA 6 ×1'])
})

test('a projection with enabled false stops the tick until the next session.start; an unowned one keeps it', async ($, on) => {
  let first = true
  const h = host(on, () => {
    const stdout = first ? DISABLED : UNOWNED
    first = false
    return { stdout }
  })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs()).toBe(1)
  await h.clock.advance(3 * PERIOD_MS)
  expect(h.runs()).toBe(1)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs()).toBe(2)
  await h.clock.advance(3 * PERIOD_MS)
  expect(h.runs()).toBe(5)
})
