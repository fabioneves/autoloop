// The visibility gate and the tick (docs/specs/SPEC-status-mod.md, items 2,
// 4 and 6): the band draws only for a projection that is the mod's schema,
// owned and enabled; the tick runs the producer as a child with the session
// id, skips while the last tick runs, keeps the last value on a failure,
// writes the state only when a read changed it, and writes nothing of a
// session that ended while its reads ran. The host is doubled
// (fixtures/testing.ts `seat`); the projection text is what the producer
// printed (fixtures/projection.ts).
import { expect, test } from 'claude-code/testing'

import { DISABLED, OWNED, UNOWNED } from './fixtures/projection'
import { ENGINE_DRAWS, PERIOD_MS, band, ran, rows, seat, start } from './fixtures/testing'
import { STATUS_SCHEMA, isDrawable, isStale, parseProjection, readProjection } from './read'

/** What the producer prints on a fault past ownership (status.mjs --self-test): owned false with the fault's code, exit 0. */
const FAULT = JSON.stringify({ schema: STATUS_SCHEMA, owned: false, error: 'ENOTDIR' })

test('a session that owns no run: the band passes to the engine', async ($, on) => {
  const h = seat(on, { projection: UNOWNED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(await band($, 120)).toEqual(ENGINE_DRAWS)
  expect(h.passed()).toBe(1)
})

test('an owned run with ui.status false: the band passes', async ($, on) => {
  const h = seat(on, { projection: DISABLED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(await band($, 120)).toEqual(ENGINE_DRAWS)
  expect(h.passed()).toBe(1)
})

test('an owned, enabled run draws the band with the phase and issue', async ($, on) => {
  const h = seat(on, { projection: OWNED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($, 120)
  expect(h.passed()).toBe(0)
  expect(rows(drawn).slice(0, 3)).toEqual(['◆ autoloop · checked 0s ago/autoloop: central', 'LOOP', '● review #412'])
})

test('a wrong schema is not drawable: the read is refused and the band passes', async ($, on) => {
  const other = OWNED.replace(STATUS_SCHEMA, 'autoloop.status/9')
  const h = seat(on, { projection: other })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(parseProjection(other)).toBeNull()
  expect(isDrawable({ schema: 'autoloop.status/9', owned: true, enabled: true })).toBe(false)
  expect(await band($, 120)).toEqual(ENGINE_DRAWS)
  expect(h.held()?.last).toBeUndefined()
})

test('a survey holds the band: the hook passes even for an owned run', async ($, on) => {
  const h = seat(on, { projection: OWNED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(await band($, 120, true)).toEqual(ENGINE_DRAWS)
  expect(h.passed()).toBe(1)
})

test('the tick runs the producer as a child with the session id and a 2 s timeout', async ($, on) => {
  const h = seat(on, { projection: OWNED })
  await start($)
  expect(h.runs.length).toBe(0)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(1)
  const { argv = [], timeoutMs } = h.runs[0] ?? {}
  expect(timeoutMs).toBe(2000)
  expect(argv[0]).toBe('node')
  expect(argv[1]).toMatch(/\/tools\/status\.mjs$/u)
  expect(argv.slice(2)).toEqual(['--json', '--session', 'S-test'])
  const held = h.held()
  expect(held?.last?.owned).toBe(true)
  expect(held?.lastOkAtMs).toBe(PERIOD_MS)
  expect(held?.lastMs).toBe(0)
})

test('each tick asks the host for the session id of the moment: after a change the producer is given the new one', async ($, on) => {
  const h = seat(on, { projection: OWNED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs[0]?.argv.slice(2)).toEqual(['--json', '--session', 'S-test'])
  h.setSession('S-next')
  await h.clock.advance(PERIOD_MS)
  expect(h.runs[1]?.argv.slice(2)).toEqual(['--json', '--session', 'S-next'])
})

test('a tick whose reads changed nothing writes only its clock: the state is written once for two identical ticks', async ($, on) => {
  const h = seat(on, { projection: OWNED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.statusWrites()).toBe(1)
  expect(h.held()?.lastOkAtMs).toBe(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  expect(h.statusWrites()).toBe(1)
  // The clock moved with the second tick all the same.
  expect(h.held()?.lastOkAtMs).toBe(2 * PERIOD_MS)
  expect(h.held()?.last?.unit?.issue).toBe(412)
})

test('a /clear ends the session: the tick stops, the last projection is dropped and the band passes until the next session.start', async ($, on) => {
  const h = seat(on, { projection: OWNED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(1)
  expect(h.passed()).toBe(0)
  await $.session.end({ reason: 'clear', sessionId: 'S-test', resume: { id: 'S-test' } })
  await h.clock.advance(3 * PERIOD_MS)
  expect(h.runs.length).toBe(1)
  expect(h.held()?.last).toBeNull()
  expect(await band($, 120)).toEqual(ENGINE_DRAWS)
  expect(h.passed()).toBe(1)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(2)
  expect(h.held()?.last?.owned).toBe(true)
})

test('a session that ends while a tick reads the producer is not written back: the state stays empty and no live timer starts', async ($, on) => {
  // The producer holds for 2 s; the session ends after 1 s of it. OWNED
  // carries no dispatch, so the running one is given to the tick's read.
  const running = OWNED.replace('"dispatches":[]',
    '"dispatches":[{"dispatch":"d","issue":412,"pr":null,"role":"code-review","model":null,"liveFile":"/tmp/live/d.jsonl","pid":1,"startedAtMs":1,"state":"running"}]')
  const h = seat(on, { projection: () => ({ holdMs: 2000, stdout: running }) })
  await start($)
  await h.clock.advance(PERIOD_MS + 1000)
  await $.session.end({ reason: 'clear', sessionId: 'S-test', resume: { id: 'S-test' } })
  expect(h.held()?.last).toBeNull()
  await h.clock.advance(1000)
  expect(h.held()?.last).toBeNull()
  expect(h.held()?.lastOkAtMs).toBeNull()
  // No 1 s tails: the live timer was not started by the ended tick.
  await h.clock.advance(5000)
  expect(h.tails.length).toBe(0)
  expect(h.runs.length).toBe(1)
})

test('a tick still running is not run again by the next period', async ($, on) => {
  const h = seat(on, { projection: () => ({ holdMs: 2 * PERIOD_MS + 1000, stdout: OWNED }) })
  await start($)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(1)
  // Once the held run returns, the next period runs again.
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(2)
})

test('a rejected run keeps the last projection and marks it stale', async ($, on) => {
  let calls = 0
  const h = seat(on, { projection: () => (calls++ === 0 ? OWNED : { deny: 'the producer could not start' }) })
  await start($)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(2)
  const held = h.held()
  expect(held?.last?.unit?.issue).toBe(412)
  expect(held?.lastOkAtMs).toBe(PERIOD_MS)
  expect(isStale(held?.lastOkAtMs ?? null, h.clock.now())).toBe(false)
  await h.clock.advance(30_000)
  expect(isStale(held?.lastOkAtMs ?? null, h.clock.now())).toBe(true)
  // The band still draws the kept projection, marked stale with hollow glyphs.
  expect(rows(await band($, 120)).slice(0, 3)).toEqual(['◆ autoloop · checked 33s ago · stale/autoloop: central', 'LOOP', '○ review #412'])
})

test('a producer fault (owned false with an error) is a failed read: the last projection is kept and goes stale', async ($, on) => {
  expect(await readProjection(async () => ran(FAULT), '/plugin', 'S-test')).toEqual({ ok: false })
  let calls = 0
  const h = seat(on, { projection: () => (calls++ === 0 ? OWNED : FAULT) })
  await start($)
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(2)
  expect(h.held()?.last?.unit?.issue).toBe(412)
  expect(h.held()?.lastOkAtMs).toBe(PERIOD_MS)
  expect(rows(await band($, 120)).slice(0, 3)).toEqual(['◆ autoloop · checked 3s ago/autoloop: central', 'LOOP', '● review #412'])
  await h.clock.advance(30_000)
  expect(rows(await band($, 120))[0]).toMatch(/^◆ autoloop · checked 33s ago · stale/u)
})

test('a host call that rejects inside the tick is caught: logged once, the last state kept, and the next tick runs', async ($, on) => {
  let denied = 2
  const h = seat(on, { projection: OWNED, denyState: () => denied-- > 0 })
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.held()?.last).toBeUndefined()
  expect(h.logged.length).toBe(1)
  expect(h.logged[0]).toMatch(/tick failed/u)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(2)
  expect(h.logged.length).toBe(1)
  await h.clock.advance(PERIOD_MS)
  expect(h.runs.length).toBe(3)
  expect(h.held()?.last?.owned).toBe(true)
})

test('/autoloop answers that this session owns no run before the pane exists', async ($, on) => {
  const h = seat(on, { projection: UNOWNED })
  await start($)
  await h.clock.advance(PERIOD_MS)
  const answer = await $.command.run({ command: 'autoloop', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 } })
  expect(answer.text).toBe('autoloop: this session owns no run')
})
