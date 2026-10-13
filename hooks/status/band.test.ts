// The band's rows and states (docs/specs/SPEC-status-mod.md, items 6, 8, 9,
// 11, 12 and 16, and release two items 8, 9 and 13): the card with its
// header and labelled cells, the phase row under a worked unit, the
// needs-you strip for the oldest unit a human must answer, one toast per
// newly blocked unit kept in $.state through a reload, hollow glyphs and
// `stale` past 30 s, `paused`, the one-row form while the pane is open, the
// narrow rules at 119 and 120 columns, and the tick stopping on
// `enabled: false` until the next session.start. The host is doubled; the
// projection text is the producer's own (fixtures/projection.ts); the proxy
// body is hand-written (an external service).
import { expect, mock, test } from 'claude-code/testing'
import type { HttpResponse, On, PaneOpenArgs, RenderElement } from 'claude-code'
import type { StatusState } from '../../types'

import { BLOCKED_THREE, DISABLED, FALLBACK, IDLE, IDLE_DELIVERED, OPEN_FINDINGS, OWNED, RUN, UNOWNED } from './fixtures/projection'
import { PERIOD_MS, band, buttons, findColor, findText, projection, ran, rows, start, texts } from './fixtures/testing'
import { PALETTE } from './kit'
import { PANE_ID } from './pane'
import { needsYouRow, phaseRow, toastText } from './view'

const BASE = 'http://127.0.0.1:8787'
const THREE = JSON.stringify({ ok: true, active_requests: [
  { id: 'r1', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model: 'claude-opus-5-5', model: 'anthropic-gateway-opus[1m]', session_id: 'S-test' },
  { id: 'r2', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model: 'gpt-6-astra', model: null, session_id: 'S-other' },
  { id: 'r3', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model: 'claude-opus-5-5', model: null, session_id: 'S-test' },
] })

type Answer = { stdout: string } | { deny: string }

/** Seats the host beneath the mod: the clock, the environment, the session id, the registry, the producer, the proxy, and the toasts. */
function host(on: On, answer: () => Answer, env: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.env(on, env)
  let runs = 0
  let held: StatusState | null = null
  const toasts: string[] = []
  const opens: PaneOpenArgs[] = []
  on('session.id', () => ({ value: 'S-test' }))
  on('ui.open', ($, e) => {
    opens.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
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
  return { clock, runs: () => runs, held: () => held, toasts, opens }
}

const HEADER = '◆ autoloop · checked 0s ago/autoloop: central'


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

test('the drawn card: one round box; the header with the command hint; labelled cells; the phase row; the needs-you strip with a bold `!`', async ($, on) => {
  const h = host(on, () => ({ stdout: RUN }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($)
  expect(drawn.type === 'Box' ? drawn.props?.['borderStyle'] : null).toBe('round')
  expect(rows(drawn)).toEqual([
    HEADER,
    'LOOP',
    '● review #412 · Session recovery',
    'code-review · fix 2/3 · ASTRA 6',
    'WORK',
    '2 active · 3 waiting · 6 needs you',
    '✓ plan  ✓ build  ✓ simplify  ● review  ○ gate  ○ deliver',
    '! #417 Needs a policy answeranswer on #417 · +5 more',
  ])
  expect(findText(drawn, 'LOOP')?.props?.['dimColor']).toBe(true)
  expect(findColor(drawn, '!')).toBe(PALETTE.crit)
  expect(findText(drawn, '!')?.props?.['bold']).toBe(true)
  const row = boxAround(drawn, 'answer on #417')
  expect(row?.type === 'Box' ? row.props?.['backgroundColor'] : null).toBe(PALETTE.card)
  // The rules between the cells are drawn as `│`, one per row of the tallest cell.
  expect(texts(drawn)).toMatch(/Session recovery.*│/u)
})

test('no Button and no hotkey hint anywhere: the hint names the command', async ($, on) => {
  const h = host(on, () => ({ stdout: RUN }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($)
  expect(buttons(drawn)).toEqual([])
  expect(texts(drawn)).not.toMatch(/expand|e:/u)
  expect(texts(drawn)).toMatch(/\/autoloop: central/u)
})

test('the Loop cell names the PR beside the issue once one exists', async ($, on) => {
  const h = host(on, () => ({ stdout: FALLBACK }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).slice(1, 4)).toEqual(['LOOP', '● simplify #413 · PR #702 · Simplify the guard', 'simplify · OPUS 5.5 (fallback)'])
  expect(rows(await band($, 100))[2]).toBe('● simplify #413 · PR #702')
})

test('the header says paused while the run is paused', async ($, on) => {
  const h = host(on, () => ({ stdout: RUN.replace('"paused":false', '"paused":true') }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($)
  expect(rows(drawn)[0]).toBe('◆ autoloop · checked 0s ago · paused/autoloop: central')
  expect(findColor(drawn, 'paused')).toBe(PALETTE.warn)
})

test('while the pane is open the band is one row: the header and the three cells, no labels, no phase row, no strip', async ($, on) => {
  const h = host(on, () => ({ stdout: RUN }), { ANTHROPIC_BASE_URL: BASE })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).length).toBe(12)
  await $.command.run({ command: 'autoloop', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(h.opens.map((open) => open.id)).toEqual([PANE_ID])
  expect(h.held()?.paneOpen).toBe(true)
  const one = await band($)
  expect(rows(one)).toEqual(['◆ autoloop · checked 0s ago │ ● review #412 │ 2 active · 3 waiting · 6 needs you │ ● ON · 3 req · /autoloop: central'])
  expect(one.type === 'Box' ? one.props?.['borderStyle'] : null).toBe('round')
  expect(findColor(one, '6 needs you')).toBe(PALETTE.crit)
  // /autoloop close: the full card comes back. The person's own close (the
  // close mark, ctrl+x x) reaches the mod as `ui.close`, which the test
  // engine's `$.ui` cannot raise; `claude plugin validate` lists the hook.
  await $.command.run({ command: 'autoloop', args: 'close', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(h.held()?.paneOpen).toBe(false)
  expect(rows(await band($)).length).toBe(12)
})

test('one needs-you unit draws no `+n more`; no phase row without a unit; no needs-you row without a blocked unit', async ($, on) => {
  const answers = [IDLE_DELIVERED, OWNED, IDLE]
  let index = 0
  const h = host(on, () => ({ stdout: answers[index++] ?? IDLE }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).slice(1)).toEqual([
    'LOOP',
    '○ Idle · last delivered #416',
    'WORK',
    '0 active · 0 waiting · 1 needs you',
    '! #424 PR awaiting authorizationmerge or label PR #701',
  ])
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).slice(1)).toEqual([
    'LOOP',
    '● review #412',
    'code-review · fix 2/3 · ASTRA 6',
    'WORK',
    '1 active · 0 waiting',
    '✓ plan  ✓ build  ✓ simplify  ● review  ○ gate  ○ deliver',
  ])
  await h.clock.advance(PERIOD_MS)
  expect(rows(await band($)).slice(1)).toEqual(['LOOP', '○ Idle', 'WORK', '0 active · 1 waiting'])
})

test('a long title cannot add rows: the Loop head and the needs-you row truncate at the edge', async ($, on) => {
  const long = 'x'.repeat(200)
  const h = host(on, () => ({ stdout: RUN.replaceAll('Session recovery', long).replaceAll('Needs a policy answer', long) }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($)
  expect(rows(drawn).length).toBe(8)
  expect(findText(drawn, `review #412 · ${long}`)?.props?.['wrap']).toBe('truncate-end')
  expect(findText(drawn, long)?.props?.['wrap']).toBe('truncate-end')
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
  expect(rows(drawn)[0]).toBe('◆ autoloop · checked 30s ago/autoloop: central')
  expect(rows(drawn)[2]).toBe('● review #412 · Session recovery')
  await h.clock.advance(1)
  drawn = await band($)
  expect(rows(drawn)[0]).toBe('◆ autoloop · checked 30s ago · stale/autoloop: central')
  expect(findColor(drawn, 'stale')).toBe(PALETTE.warn)
  expect(rows(drawn)[2]).toBe('○ review #412 · Session recovery')
  expect(rows(drawn)[6]).toBe('✓ plan  ✓ build  ✓ simplify  ○ review  ○ gate  ○ deliver')
})

test('narrow: at 119 columns the Loop column drops the title and the proxy collapses; 120 is not narrow', async ($, on) => {
  const h = host(on, () => ({ stdout: RUN }), { ANTHROPIC_BASE_URL: BASE })
  await start($)
  await h.clock.advance(PERIOD_MS)
  const narrow = rows(await band($, 119))
  expect(narrow[2]).toBe('● review #412')
  expect(narrow.slice(6, 8)).toEqual(['PROXY', '● ON · 3 req'])
  const wide = rows(await band($, 120))
  expect(wide[2]).toBe('● review #412 · Session recovery')
  expect(wide.slice(6, 10)).toEqual(['PROXY', '● ON · 3 requests', 'OPUS 5.5 ×2', 'ASTRA 6 ×1'])
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
