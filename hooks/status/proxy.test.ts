// The Proxy cell (docs/specs/SPEC-status-mod.md, items 3, 4, 7, 10 and 12):
// no cell without ANTHROPIC_BASE_URL; with it, each tick fetches
// <base>/status without auth and with a 2 s timeout. Three states: ON (200
// and a parsed body) groups the active requests by requested model, UP is
// any other answer, OFF is no answer within 2 s; each a fact, not stale.
// The proxy is an external service, so its bodies are hand-written here;
// the projection is the producer's own (fixtures/projection.ts).
import { expect, mock, test } from 'claude-code/testing'
import type { HttpInit, HttpResponse, On, RenderElement } from 'claude-code'
import type { StatusState } from '../../types'

import { OWNED } from './fixtures/projection'
import { PERIOD_MS, band, findColor, ran, rows, start, texts } from './fixtures/testing'
import { PROXY_TIMEOUT_MS, parseProxyStatus, proxyBase, proxyUrl, readProxy } from './read'
import { PALETTE } from './kit'
import { modelCounts, proxyColumn } from './view'

const BASE = 'http://127.0.0.1:8787'

const request = (id: string, requested_model: string | null, model: string | null = null) => ({
  id, started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model, model, session_id: 'S-test',
})
const THREE = JSON.stringify({ ok: true, active_requests: [
  request('r1', 'claude-opus-5-5', 'anthropic-gateway-opus[1m]'),
  request('r2', 'gpt-6-astra'),
  request('r3', 'claude-opus-5-5'),
] })
const NONE = JSON.stringify({ ok: true, active_requests: [] })

function response(text: string, status = 200): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text }
}

type Answer = { body: string; status?: number } | { deny: string } | { holdMs: number }

/** Seats the host beneath the mod: the clock, the environment, the session id, the producer and the proxy. */
function host(on: On, env: Record<string, string>, answer: () => Answer, options: { holdRunMs?: number } = {}) {
  const clock = mock.clock(on)
  mock.env(on, env)
  const fetches: { url: string; init: HttpInit | undefined }[] = []
  let runs = 0
  let held: StatusState | null = null
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', async () => {
    runs += 1
    if (options.holdRunMs !== undefined) await clock.sleep(options.holdRunMs)
    return { value: ran(OWNED) }
  })
  on('http.fetch', async ($, e) => {
    fetches.push({ url: e.url, init: e.init })
    const next = answer()
    if ('deny' in next) return { deny: next.deny }
    if ('holdMs' in next) {
      await clock.sleep(next.holdMs)
      return { value: response(THREE) }
    }
    return { value: response(next.body, next.status) }
  })
  on('state.set', { plugin: 'autoloop', key: 'status' }, ($, e, next) => {
    held = e.value
    return next(e)
  })
  return { clock, fetches, runs: () => runs, held: () => held }
}

/** The cell Boxes of the band's second row (the rules between them are Boxes too, one `│` per row). */
function columnBoxes(tree: RenderElement): RenderElement[] {
  const body = tree.type === 'Box' ? tree.children?.[1] : undefined
  if (body === undefined || typeof body === 'string' || body.type !== 'Box') return []
  return (body.children ?? []).filter((child): child is RenderElement => typeof child !== 'string' && child.type === 'Box' && !/^│+$/u.test(texts(child)))
}

function columns(tree: RenderElement): number[] {
  return columnBoxes(tree).map((box) => (box.type === 'Box' ? Number(box.props?.['width']) : -1))
}

/** The rows of the band's last column, the proxy's. */
function proxyRows(tree: RenderElement): string[] {
  const last = columnBoxes(tree).at(-1)
  return last === undefined ? [] : rows(last)
}

test('readProxy: ON with the active requests on a 200 and a parsed body; UP on a 404, a 500, a body that does not parse, or ok false; OFF on a rejection', async () => {
  const calls: { url: string; timeoutMs: number }[] = []
  const fetcher = (text: string, status = 200) => async (url: string, init: { timeoutMs: number }) => {
    calls.push({ url, timeoutMs: init.timeoutMs })
    return response(text, status)
  }
  const on = await readProxy(fetcher(THREE), `${BASE}/`)
  expect(on.state).toBe('on')
  expect(on.requests.map((entry) => entry.requestedModel)).toEqual(['claude-opus-5-5', 'gpt-6-astra', 'claude-opus-5-5'])
  expect(on.requests[0]).toEqual({ id: 'r1', startedAt: '2026-09-28T10:29:00.000Z', elapsedMs: 1200,
    requestedModel: 'claude-opus-5-5', model: 'anthropic-gateway-opus[1m]', sessionId: 'S-test' })
  expect(calls[0]).toEqual({ url: `${BASE}/status`, timeoutMs: PROXY_TIMEOUT_MS })
  expect(PROXY_TIMEOUT_MS).toBe(2000)
  expect(proxyUrl(BASE)).toBe(`${BASE}/status`)
  expect(await readProxy(async () => { throw new Error('refused') }, BASE)).toEqual({ state: 'off', requests: [] })
  expect(await readProxy(async () => { throw new Error('no answer within 2000 ms') }, BASE)).toEqual({ state: 'off', requests: [] })
  expect(await readProxy(fetcher('not found', 404), BASE)).toEqual({ state: 'up', requests: [] })
  expect(await readProxy(fetcher(THREE, 500), BASE)).toEqual({ state: 'up', requests: [] })
  expect(await readProxy(fetcher('<html>'), BASE)).toEqual({ state: 'up', requests: [] })
  expect(await readProxy(fetcher(JSON.stringify({ ok: false, active_requests: [] })), BASE)).toEqual({ state: 'up', requests: [] })
  expect(parseProxyStatus(JSON.stringify({ ok: true, active_requests: 'none' }))).toBeNull()
  expect(parseProxyStatus(JSON.stringify({ ok: true, active_requests: [{ id: 'x' }] }))).toEqual([
    { id: 'x', startedAt: null, elapsedMs: null, requestedModel: null, model: null, sessionId: null },
  ])
})

test('proxyBase takes an http or https loopback URL and refuses everything else (spec item 3)', () => {
  expect(proxyBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  expect(proxyBase('http://localhost:8787/')).toBe('http://localhost:8787/')
  expect(proxyBase('http://[::1]:8787')).toBe('http://[::1]:8787')
  expect(proxyBase('https://localhost')).toBe('https://localhost')
  expect(proxyBase('https://api.example.com')).toBeNull()
  expect(proxyBase('http://10.0.0.5:8787')).toBeNull()
  expect(proxyBase('http://127.0.0.1.example.com:8787')).toBeNull()
  expect(proxyBase('ftp://127.0.0.1')).toBeNull()
  expect(proxyBase('127.0.0.1:8787')).toBeNull()
  expect(proxyBase('not a url')).toBeNull()
  expect(proxyBase('')).toBeNull()
  expect(proxyBase(undefined)).toBeNull()
})

// A base that is not a loopback URL counts as unset: the unauthenticated
// read never leaves this machine.
for (const base of ['https://gateway.example.com', 'http://10.0.0.5:8787', '::1:8787']) {
  test(`ANTHROPIC_BASE_URL ${base}: no fetch and no column`, async ($, on) => {
    const h = host(on, { ANTHROPIC_BASE_URL: base }, () => ({ body: THREE }))
    await start($)
    await h.clock.advance(PERIOD_MS)
    expect(h.fetches.length).toBe(0)
    expect(h.held()?.proxy).toBeNull()
    const drawn = await band($)
    expect(columns(drawn)).toEqual([78, 79])
    expect(texts(drawn)).not.toMatch(/ON|UP|OFF/u)
  })
}

test('ANTHROPIC_BASE_URL on a loopback host with a port: the column, fetched at <base>/status', async ($, on) => {
  const h = host(on, { ANTHROPIC_BASE_URL: 'http://[::1]:8787' }, () => ({ body: THREE }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.fetches[0]?.url).toBe('http://[::1]:8787/status')
  expect(columns(await band($))).toEqual([52, 52, 52])
})

test('the proxy cell groups requests by model, sorted by count then name, and collapses when narrow; UP and OFF carry their words', async () => {
  const proxy = await readProxy(async () => response(THREE), BASE)
  expect(modelCounts(proxy.requests)).toEqual([{ model: 'OPUS 5.5', count: 2 }, { model: 'ASTRA 6', count: 1 }])
  expect(proxyColumn(proxy, false)).toEqual({ state: 'on', glyph: '●', word: 'ON', tail: ' · 3 requests', rows: ['OPUS 5.5 ×2', 'ASTRA 6 ×1'] })
  expect(proxyColumn(proxy, true)).toEqual({ state: 'on', glyph: '●', word: 'ON', tail: ' · 3 req', rows: [] })
  expect(proxyColumn({ state: 'up', requests: [] }, false)).toEqual({ state: 'up', glyph: '◐', word: 'UP', tail: ' · no status', rows: [] })
  expect(proxyColumn({ state: 'up', requests: [] }, true)).toEqual({ state: 'up', glyph: '◐', word: 'UP', tail: ' · no status', rows: [] })
  expect(proxyColumn({ state: 'off', requests: [] }, false)).toEqual({ state: 'off', glyph: '○', word: 'OFF', tail: '', rows: [] })
  expect(proxyColumn({ state: 'off', requests: [] }, true)).toEqual({ state: 'off', glyph: '○', word: 'OFF', tail: '', rows: [] })
  // Ties sort by name; a null requested model is grouped as unknown.
  expect(modelCounts([request('a', 'gpt-6-astra'), request('b', null), request('c', 'claude-opus-5-5')].map((entry) => ({
    id: entry.id, startedAt: null, elapsedMs: null, requestedModel: entry.requested_model, model: null, sessionId: null,
  })))).toEqual([{ model: 'ASTRA 6', count: 1 }, { model: 'OPUS 5.5', count: 1 }, { model: 'unknown', count: 1 }])
})

test('ANTHROPIC_BASE_URL unset: no fetch, no column, two columns share the body', async ($, on) => {
  const h = host(on, {}, () => ({ body: THREE }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.fetches.length).toBe(0)
  expect(h.held()?.proxy).toBeNull()
  const drawn = await band($)
  expect(columns(drawn)).toEqual([78, 79])
  expect(texts(drawn)).not.toMatch(/ON|UP|OFF/u)
})

test('ANTHROPIC_BASE_URL set: each tick fetches <base>/status without auth; ON draws the count and one row per model', async ($, on) => {
  const h = host(on, { ANTHROPIC_BASE_URL: BASE }, () => ({ body: THREE }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.fetches.length).toBe(1)
  expect(h.fetches[0]?.url).toBe(`${BASE}/status`)
  expect(h.fetches[0]?.init?.auth).toBeUndefined()
  expect(h.held()?.proxy?.state).toBe('on')
  const drawn = await band($)
  expect(columns(drawn)).toEqual([52, 52, 52])
  expect(proxyRows(drawn)).toEqual(['PROXY', '● ON · 3 requests', 'OPUS 5.5 ×2', 'ASTRA 6 ×1'])
  expect(findColor(drawn, 'ON')).toBe(PALETTE.good)
  await h.clock.advance(PERIOD_MS)
  expect(h.fetches.length).toBe(2)
})

test('three fetch outcomes, three states: a 200 with a body is ON, a 404 or a 500 or a body that does not parse is UP, a rejection is OFF; each drops the last value', async ($, on) => {
  const answers: Answer[] = [{ body: THREE }, { deny: 'connection refused' }, { body: THREE }, { body: 'not found', status: 404 },
    { body: THREE }, { body: 'oops', status: 500 }, { body: THREE }, { body: '<html>' }, { body: THREE }, { body: JSON.stringify({ ok: false }) }]
  const expected: { state: string; rows: string[]; word: string; color: string }[] = [
    { state: 'off', rows: ['PROXY', '○ OFF'], word: 'OFF', color: PALETTE.warn },
    { state: 'up', rows: ['PROXY', '◐ UP · no status'], word: 'UP', color: PALETTE.warn },
    { state: 'up', rows: ['PROXY', '◐ UP · no status'], word: 'UP', color: PALETTE.warn },
    { state: 'up', rows: ['PROXY', '◐ UP · no status'], word: 'UP', color: PALETTE.warn },
    { state: 'up', rows: ['PROXY', '◐ UP · no status'], word: 'UP', color: PALETTE.warn },
  ]
  let index = 0
  const h = host(on, { ANTHROPIC_BASE_URL: BASE }, () => answers[index++] ?? { deny: 'out of answers' })
  await start($)
  for (const want of expected) {
    await h.clock.advance(PERIOD_MS)
    expect(h.held()?.proxy?.state).toBe('on')
    await h.clock.advance(PERIOD_MS)
    expect(h.held()?.proxy).toEqual({ state: want.state, requests: [] })
    const drawn = await band($)
    expect(proxyRows(drawn)).toEqual(want.rows)
    expect(findColor(drawn, want.word)).toBe(want.color)
  }
  // The projection read went on through every proxy failure.
  expect(h.held()?.lastOkAtMs).toBe(10 * PERIOD_MS)
})

test('a proxy that does not answer within 2 s reads OFF; the tick ends then', async ($, on) => {
  const h = host(on, { ANTHROPIC_BASE_URL: BASE }, () => ({ holdMs: 5000 }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.held()).toBeNull()
  await h.clock.advance(PROXY_TIMEOUT_MS - 1)
  expect(h.held()).toBeNull()
  await h.clock.advance(1)
  expect(h.held()?.proxy).toEqual({ state: 'off', requests: [] })
  expect(h.held()?.lastMs).toBe(PROXY_TIMEOUT_MS)
  expect(h.held()?.last?.owned).toBe(true)
})

test('one tick runs both reads; a tick still running is skipped by the next period', async ($, on) => {
  const h = host(on, { ANTHROPIC_BASE_URL: BASE }, () => ({ body: NONE }), { holdRunMs: 2 * PERIOD_MS + 1000 })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs()).toBe(1)
  expect(h.fetches.length).toBe(1)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs()).toBe(1)
  expect(h.fetches.length).toBe(1)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs()).toBe(2)
  expect(h.fetches.length).toBe(2)
  expect(proxyRows(await band($))).toEqual(['PROXY', '● ON · 0 requests'])
})

test('under 120 columns the proxy cell reads ON · n req with no model rows', async ($, on) => {
  const h = host(on, { ANTHROPIC_BASE_URL: BASE }, () => ({ body: THREE }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($, 100)
  expect(columnBoxes(drawn).slice(1).flatMap(rows)).toEqual(['WORK', '1 active · 0 waiting', 'PROXY', '● ON · 3 req'])
  expect(columns(drawn)).toEqual([32, 32, 32])
})
