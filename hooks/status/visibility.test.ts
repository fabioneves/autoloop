// The visibility gate and the tick (docs/specs/SPEC-status-mod.md, items 2,
// 4 and 6): the band draws only for a projection that is the mod's schema,
// owned and enabled; the tick runs the producer as a child with the session
// id, skips while the last tick runs, and keeps the last value on a failure.
// The host is doubled (process.run, session.id, the clock); the projection
// text is what the producer printed (fixtures/projection.ts).
import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { StatusState } from '../../types'

import { DISABLED, OWNED, UNOWNED } from './fixtures/projection'
import { PERIOD_MS, band, ran, start, texts } from './fixtures/testing'
import { STATUS_SCHEMA, isDrawable, isStale, parseProjection } from './read'

const ENGINE_DRAWS: RenderElement = { type: 'Text', children: ['engine'] }

type Answer = { stdout: string; exitCode?: number } | { deny: string } | { holdMs: number }

/** Seats the host beneath the mod: the clock, the session id, the command registry and the producer. */
function host(on: On, answer: () => Answer) {
  const clock = mock.clock(on)
  // No ANTHROPIC_BASE_URL: the proxy column does not exist here.
  mock.env(on, {})
  const runs: { argv: readonly string[]; timeoutMs: number | undefined }[] = []
  let passed = 0
  let held: StatusState | null = null
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', async ($, e) => {
    runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    const next = answer()
    if ('deny' in next) return { deny: next.deny }
    if ('holdMs' in next) {
      await clock.sleep(next.holdMs)
      return { value: ran(OWNED) }
    }
    return { value: ran(next.stdout, next.exitCode) }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => {
    passed += 1
    return ENGINE_DRAWS
  })
  // The test's `$` has no state noun: the mod's writes are read on their way down.
  on('state.set', { plugin: 'autoloop', key: 'status' }, ($, e, next) => {
    held = e.value
    return next(e)
  })
  return { clock, runs, passed: () => passed, held: () => held }
}

test('a session that owns no run: the band passes to the engine', async ($, on) => {
  const h = host(on, () => ({ stdout: UNOWNED }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(await band($, 120)).toEqual(ENGINE_DRAWS)
  expect(h.passed()).toBe(1)
})

test('an owned run with ui.status false: the band passes', async ($, on) => {
  const h = host(on, () => ({ stdout: DISABLED }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(await band($, 120)).toEqual(ENGINE_DRAWS)
  expect(h.passed()).toBe(1)
})

test('an owned, enabled run draws the band with the phase and issue', async ($, on) => {
  const h = host(on, () => ({ stdout: OWNED }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await band($, 120)
  expect(h.passed()).toBe(0)
  expect(texts(drawn)).toMatch(/^◆ autoloop · checked 0s ago · \[expand\]● review #412/u)
})

test('a wrong schema is not drawable: the read is refused and the band passes', async ($, on) => {
  const other = OWNED.replace(STATUS_SCHEMA, 'autoloop.status/9')
  const h = host(on, () => ({ stdout: other }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(parseProjection(other)).toBeNull()
  expect(isDrawable({ schema: 'autoloop.status/9', owned: true, enabled: true })).toBe(false)
  expect(await band($, 120)).toEqual(ENGINE_DRAWS)
  expect(h.held()?.last).toBeNull()
})

test('a survey holds the band: the hook passes even for an owned run', async ($, on) => {
  const h = host(on, () => ({ stdout: OWNED }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(await band($, 120, true)).toEqual(ENGINE_DRAWS)
  expect(h.passed()).toBe(1)
})

test('the tick runs the producer as a child with the session id and a 2 s timeout', async ($, on) => {
  const h = host(on, () => ({ stdout: OWNED }))
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

test('a tick still running is not run again by the next period', async ($, on) => {
  const h = host(on, () => ({ holdMs: 2 * PERIOD_MS + 1000 }))
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
  const h = host(on, () => (calls++ === 0 ? { stdout: OWNED } : { deny: 'the producer could not start' }))
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
  expect(texts(await band($, 120))).toMatch(/^◆ autoloop · stale · checked 33s ago · \[expand\]○ review #412/u)
})

test('/autoloop answers that this session owns no run before the pane exists', async ($, on) => {
  const h = host(on, () => ({ stdout: UNOWNED }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  const answer = await $.command.run({ command: 'autoloop', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 } })
  expect(answer.text).toBe('autoloop: this session owns no run')
})
