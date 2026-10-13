// The pane and /autoloop (docs/specs/SPEC-status-mod.md, items 14 and 15):
// the command opens pane `autoloop` for the session that owns a run and
// answers otherwise; `/autoloop close` closes it; nothing opens it unasked. The sections are pure builders
// over the producer's own projection (fixtures/projection.ts) and a
// hand-written proxy body; empty sections are not drawn.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpResponse, On, PaneOpenArgs } from 'claude-code'

import { DISABLED, IDLE, OWNED, RUN, UNOWNED, WAITS } from './fixtures/projection'
import { PERIOD_MS, band, findColor, projection, ran, rows, start } from './fixtures/testing'
import {
  PANE_ID, activeSection, deliveredSection, needsYouSection, paneSections, proxySection, waitingSection,
} from './pane'
import { readProxy } from './read'
import { PALETTE } from './kit'

const BASE = 'http://127.0.0.1:8787'
/** The fixture's clock: 10:30 on 2026-09-28, three minutes after #412's fix round started. */
const AT_10_30 = Date.UTC(2026, 8, 28, 10, 30)
const THREE = JSON.stringify({ ok: true, active_requests: [
  { id: 'r1', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 61_000, requested_model: 'claude-opus-5-5', model: 'anthropic-gateway-opus[1m]', session_id: 'S-test' },
  { id: 'r2', started_at: '2026-09-28T10:29:30.000Z', elapsed_ms: 30_000, requested_model: 'gpt-6-astra', model: null, session_id: 'S-other' },
  { id: 'r3', started_at: '2026-09-28T10:29:59.000Z', elapsed_ms: 1_000, requested_model: null, model: null, session_id: null },
] })

/** Seats the host beneath the mod: the clock at 10:30, the environment, the session id, the registry, the producer, the proxy, the panes and the toasts. */
function host(on: On, stdout: () => string, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: AT_10_30 })
  mock.env(on, env)
  const opens: PaneOpenArgs[] = []
  const closes: string[] = []
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: ran(stdout()) }))
  on('http.fetch', () => {
    const response: HttpResponse = { status: 200, ok: true, headers: {}, text: THREE }
    return { value: response }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opens.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    closes.push(e.id)
    return { value: undefined }
  })
  return { clock, opens, closes }
}

function command($: Engine, args: string) {
  return $.command.run({ command: 'autoloop', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

function pane($: Engine) {
  return $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: { title: 'autoloop', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

test('the Needs you section lists every unit a human must answer, oldest first, with a chip for the answer or the PR', () => {
  const section = needsYouSection(projection(RUN))
  expect(section.title).toBe('Needs you')
  expect(section.rows.map((row) => [row.glyph, row.text, row.chips])).toEqual([
    ['!', '#417 Needs a policy answer', ['answer on #417']],
    ['!', '#418 Draft with open findings', ['answer on #418']],
    ['!', '#419 Draft handed off after the scan', ['answer on #419']],
    ['!', '#423 Needs an authorization', ['answer on #423']],
    ['!', '#424 PR awaiting authorization', ['PR #701']],
    ['!', '#430 Blocked without a record', ['answer on #430']],
  ])
  expect(needsYouSection(projection(OWNED)).rows).toEqual([])
})

test('the Active section names phase, role, round and model, with the time since the worked unit started', () => {
  const section = activeSection(projection(RUN), AT_10_30 + 3000)
  expect(section.title).toBe('Active')
  expect(section.rows.map((row) => `${row.glyph} ${row.text}`)).toEqual([
    '● #412 Session recovery · review · code-review · fix 2/3 · ASTRA 6 · 3m 3s',
    '● #421 Fix round in flight · review · fix · fix 1/3 · OPUS 5.5',
  ])
  // OWNED has no title, and its step started a minute before this clock.
  expect(activeSection(projection(OWNED), AT_10_30).rows.map((row) => row.text)).toEqual(['#412 · review · code-review · fix 2/3 · ASTRA 6 · 1m 0s'])
  expect(activeSection(projection(IDLE), AT_10_30).rows).toEqual([])
})

test('the Waiting section names what each unit waits for: an issue, a PR with paths, a time, a green base, or the detail', () => {
  expect(waitingSection(projection(WAITS)).rows.map((row) => `${row.glyph} ${row.text}`)).toEqual([
    '◷ #414 Waits on an issue · issue #399',
    '◷ #415 Waits on a PR · PR #204 (src/a.mjs, src/b.mjs)',
    '◷ #426 Waits on time · until 10:50 UTC',
    '◷ #427 Waits on the base · base green',
  ])
  expect(waitingSection(projection(IDLE)).rows.map((row) => row.text)).toEqual(['#420 Staged plan · staged, not dispatched'])
  expect(waitingSection(projection(OWNED)).rows).toEqual([])
})

test('the Delivered section lists a pending merge with its PR and detail', () => {
  expect(deliveredSection(projection(RUN)).rows.map((row) => `${row.glyph} ${row.text}`)).toEqual([
    '✓ #416 Delivered, merge pending · PR #700 · automatic merge pending (checks pending)',
  ])
  expect(deliveredSection(projection(OWNED)).rows).toEqual([])
})

test('the Proxy section: one row per request, requested → served (or requested alone), elapsed, and the this-session mark', async () => {
  const proxy = await readProxy(async () => ({ status: 200, text: THREE }), BASE)
  const section = proxySection(proxy, 'S-test')
  expect(section.title).toBe('Proxy')
  expect(section.rows.map((row) => [row.glyph, row.text, row.mark])).toEqual([
    ['●', 'OPUS 5.5 → OPUS · 1m 1s', 'this session'],
    ['●', 'ASTRA 6 · 30s', null],
    ['●', 'unknown · 1s', null],
  ])
  expect(proxySection({ state: 'off', requests: [] }, 'S-test').rows).toEqual([])
  expect(proxySection(null, 'S-test').rows).toEqual([])
})

test('paneSections keeps the order and drops the empty ones', async () => {
  const proxy = await readProxy(async () => ({ status: 200, text: THREE }), BASE)
  expect(paneSections(projection(RUN), proxy, 'S-test', AT_10_30).map((section) => section.title))
    .toEqual(['Needs you', 'Active', 'Waiting', 'Delivered', 'Proxy'])
  expect(paneSections(projection(IDLE), null, 'S-test', AT_10_30).map((section) => section.title)).toEqual(['Waiting'])
  expect(paneSections(projection(OWNED), { state: 'up', requests: [] }, 'S-test', AT_10_30).map((section) => section.title)).toEqual(['Active'])
})

test('the pane id is the literal the Pane matcher names', () => {
  expect(PANE_ID).toBe('autoloop')
})

test('/autoloop from a session that owns no run answers so and opens nothing', async ($, on) => {
  const h = host(on, () => UNOWNED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect((await command($, '')).text).toBe('autoloop: this session owns no run')
  expect(h.opens).toEqual([])
})

test('/autoloop opens the pane autoloop for the owner; /autoloop close closes it', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect((await command($, '')).text).toBe('autoloop: status pane opened')
  expect(h.opens.map((open) => open.id)).toEqual([PANE_ID])
  expect(h.closes).toEqual([])
  expect((await command($, 'close')).text).toBe('autoloop: status pane closed')
  expect(h.closes).toEqual([PANE_ID])
  expect((await command($, 'other')).text).toBe('autoloop: unknown argument "other"; use /autoloop or /autoloop close')
  expect(h.opens.length).toBe(1)
})

test('/autoloop in a project with ui.status false opens nothing and says so', async ($, on) => {
  const h = host(on, () => DISABLED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect((await command($, '')).text).toBe('autoloop: the status band is off (ui.status is false in .autoloop/config.json)')
  expect(h.opens).toEqual([])
})

test('nothing opens the pane on session.start, a tick or a draw of the band', async ($, on) => {
  const h = host(on, () => RUN, { ANTHROPIC_BASE_URL: BASE })
  await start($)
  await h.clock.advance(3 * PERIOD_MS)
  await band($)
  expect(h.opens).toEqual([])
})

test('the pane draws each section from the last reads, with the this-session mark', async ($, on) => {
  const h = host(on, () => RUN, { ANTHROPIC_BASE_URL: BASE })
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await pane($)
  expect(rows(drawn)).toEqual([
    'Needs you',
    '! #417 Needs a policy answer  answer on #417',
    '! #418 Draft with open findings  answer on #418',
    '! #419 Draft handed off after the scan  answer on #419',
    '! #423 Needs an authorization  answer on #423',
    '! #424 PR awaiting authorization  PR #701',
    '! #430 Blocked without a record  answer on #430',
    'Active',
    '● #412 Session recovery · review · code-review · fix 2/3 · ASTRA 6 · 3m 3s',
    '● #421 Fix round in flight · review · fix · fix 1/3 · OPUS 5.5',
    'Waiting',
    '◷ #414 Waits on an issue · issue #399',
    '◷ #415 Waits on a PR · PR #204 (src/a.mjs, src/b.mjs)',
    '◷ #420 Staged plan · staged, not dispatched',
    'Delivered',
    '✓ #416 Delivered, merge pending · PR #700 · automatic merge pending (checks pending)',
    'Proxy',
    '● OPUS 5.5 → OPUS · 1m 1s · this session',
    '● ASTRA 6 · 30s',
    '● unknown · 1s',
  ])
  expect(findColor(drawn, '!')).toBe(PALETTE.crit)
  expect(findColor(drawn, 'this session')).toBe(PALETTE.accent)
})

test('the pane leaves empty sections out, and says so when the session owns no run', async ($, on) => {
  const answers = [IDLE, UNOWNED]
  let index = 0
  const h = host(on, () => answers[index++] ?? UNOWNED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await pane($))).toEqual(['Waiting', '◷ #420 Staged plan · staged, not dispatched'])
  await h.clock.advance(PERIOD_MS)
  expect(rows(await pane($))).toEqual(['autoloop: this session owns no run'])
})
