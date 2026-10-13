// The live tails (docs/specs/SPEC-central.md, item 2): every second while
// a dispatch runs, the mod tails the last 64 KiB of its live file with
// `tail -c`, renders the complete lines as tools/dispatch-render.mjs
// does, and keeps the last 200 rendered lines per dispatch in $.state. A
// chunk cut mid-line drops its first line; a failed tail keeps the last
// lines; a file that does not grow for 120 s while the dispatch runs is
// quiet; the 1 s tick runs only while a dispatch runs; an ended
// dispatch's tail stays until session.end. The host is doubled (the
// clock, process.run for the producer and for tail); the projection text
// is the producer's own (fixtures/projection.ts); the stream is synthetic
// (fixtures/stream.ts).
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { StatusDispatch, StatusState, StatusStream } from '../../types'

import { OWNED, RUN } from './fixtures/projection'
import { RENDERED, STREAM, STREAM_LINES } from './fixtures/stream'
import { PERIOD_MS, projection, ran, start } from './fixtures/testing'
import {
  LIVE_PERIOD_MS, QUIET_AFTER_MS, STREAM_LINES_MAX, TAIL_BYTES, TAIL_TIMEOUT_MS, isQuiet, pruneStreams, splitTail, tailLive,
} from './read'
import { createRenderer } from './render'

/** The running dispatch of the RUN fixture. */
const RUNNING = projection(RUN).dispatches?.[0] as StatusDispatch
const LIVE_FILE = RUNNING.liveFile as string

type Answer = { stdout: string; exitCode?: number } | { deny: string }

/** Seats the host beneath the mod: the clock, the session id, the registry, the producer, and `tail` answered from `stream()`. */
function host(on: On, stdout: () => string, stream: () => Answer) {
  const clock = mock.clock(on)
  mock.env(on, {})
  const tails: { argv: readonly string[]; timeoutMs: number | undefined }[] = []
  let held: StatusState | null = null
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    if (e.argv[0] !== 'tail') return { value: ran(stdout()) }
    tails.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    const next = stream()
    return 'deny' in next ? { deny: next.deny } : { value: ran(next.stdout, next.exitCode) }
  })
  on('state.set', { plugin: 'autoloop', key: 'status' }, ($, e, next) => {
    held = e.value
    return next(e)
  })
  return { clock, tails, held: () => held, stream: () => held?.streams[RUNNING.dispatch] ?? null }
}

const textEvent = (n: number) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${n}` }] } })

test('the renderer prints each stream-json shape as tools/dispatch-render.mjs does', () => {
  const render = createRenderer()
  expect(STREAM_LINES.flatMap(render)).toEqual(RENDERED)
  expect(render('')).toEqual([])
  expect(render('{"type":"system","subtype":"thinking_tokens","estimated_tokens":"many"}')).toEqual([])
  expect(render('[1]')).toEqual([])
  expect(render(`{"type":"assistant","message":{"content":[{"type":"text","text":"${'x'.repeat(450)}"}]}}`)).toEqual([`│ ${'x'.repeat(400)}…`])
})

test('splitTail: the complete lines of a chunk; a chunk that fills the cap drops its cut first line; an unfinished last line is dropped', () => {
  expect(splitTail('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
  expect(splitTail('a\nb\nc')).toEqual(['a', 'b'])
  expect(splitTail('')).toEqual([])
  expect(splitTail('a')).toEqual([])
  // Under the cap the chunk is the whole file, so its first line is complete.
  expect(splitTail(`${'x'.repeat(100)}\nb\n`)).toEqual(['x'.repeat(100), 'b'])
  // At the cap the chunk starts wherever tail cut it: the first line is a cut line and goes.
  const filled = `${'x'.repeat(TAIL_BYTES - 3)}\nb\n`
  expect(filled.length).toBe(TAIL_BYTES)
  expect(splitTail(filled)).toEqual(['b'])
  // A multi-byte character cut at the head decodes shorter: a chunk within three bytes of the cap is a full one too.
  const wide = `${'é'.repeat((TAIL_BYTES - 4) / 2)}\nb\n`
  expect(new TextEncoder().encode(wide).length).toBe(TAIL_BYTES - 1)
  expect(splitTail(wide)).toEqual(['b'])
  expect(splitTail(`${'x'.repeat(TAIL_BYTES - 7)}\nb\n`)).toEqual(['x'.repeat(TAIL_BYTES - 7), 'b'])
})

test('tailLive runs tail -c 65536 with a 2 s timeout and renders the complete lines; a failed tail is null', async () => {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = []
  const run = (text: string, exitCode = 0) => async (argv: readonly string[], init: { timeoutMs: number }) => {
    calls.push({ argv, timeoutMs: init.timeoutMs })
    return ran(text, exitCode)
  }
  const tailed = await tailLive(run(STREAM), LIVE_FILE)
  expect(calls[0]).toEqual({ argv: ['tail', '-c', '65536', LIVE_FILE], timeoutMs: TAIL_TIMEOUT_MS })
  expect(TAIL_BYTES).toBe(65536)
  expect(TAIL_TIMEOUT_MS).toBe(2000)
  expect(tailed).toEqual({ chunk: STREAM, lines: RENDERED })
  expect(await tailLive(run('', 1), LIVE_FILE)).toBeNull()
  expect(await tailLive(async () => { throw new Error('tail could not start') }, LIVE_FILE)).toBeNull()
})

test('while a dispatch runs the mod tails its live file every second and keeps the rendered lines, capped at 200', async ($, on) => {
  let content = STREAM
  const h = host(on, () => RUN, () => ({ stdout: content }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.tails.length).toBe(0)
  await h.clock.advance(LIVE_PERIOD_MS)
  expect(LIVE_PERIOD_MS).toBe(1000)
  expect(h.tails[0]).toEqual({ argv: ['tail', '-c', '65536', LIVE_FILE], timeoutMs: TAIL_TIMEOUT_MS })
  expect(h.stream()).toEqual({ lines: RENDERED, bytes: STREAM.length, lastGrewAtMs: PERIOD_MS + LIVE_PERIOD_MS })
  // The same chunk again: nothing grew, the lines stay.
  await h.clock.advance(LIVE_PERIOD_MS)
  expect(h.tails.length).toBe(2)
  expect(h.stream()?.lastGrewAtMs).toBe(PERIOD_MS + LIVE_PERIOD_MS)
  // The file grows past the cap: the last 200 rendered lines, the newest last.
  content = `${Array.from({ length: 250 }, (_, n) => textEvent(n)).join('\n')}\n`
  await h.clock.advance(LIVE_PERIOD_MS)
  const stream = h.stream()
  expect(STREAM_LINES_MAX).toBe(200)
  expect(stream?.lines.length).toBe(200)
  expect(stream?.lines[0]).toBe('│ line 50')
  expect(stream?.lines[199]).toBe('│ line 249')
  expect(stream?.bytes).toBe(content.length)
  expect(stream?.lastGrewAtMs).toBe(PERIOD_MS + 3 * LIVE_PERIOD_MS)
})

test('a dispatch is quiet after 120 s without growth while it runs; growth or an end lifts it', async ($, on) => {
  let content = STREAM
  const h = host(on, () => RUN, () => ({ stdout: content }))
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  const grewAt = PERIOD_MS + LIVE_PERIOD_MS
  expect(h.stream()?.lastGrewAtMs).toBe(grewAt)
  await h.clock.advance(QUIET_AFTER_MS - 1)
  expect(QUIET_AFTER_MS).toBe(120_000)
  expect(h.stream()?.lastGrewAtMs).toBe(grewAt)
  expect(isQuiet(h.stream()!, RUNNING, h.clock.now())).toBe(false)
  await h.clock.advance(1)
  expect(isQuiet(h.stream()!, RUNNING, h.clock.now())).toBe(true)
  expect(isQuiet(h.stream()!, { ...RUNNING, state: 'died' }, h.clock.now())).toBe(false)
  content = `${STREAM}${textEvent(1)}\n`
  await h.clock.advance(LIVE_PERIOD_MS)
  expect(h.stream()?.lastGrewAtMs).toBe(h.clock.now())
  expect(isQuiet(h.stream()!, RUNNING, h.clock.now())).toBe(false)
})

test('pruneStreams keeps every running stream and the ended one that grew last', () => {
  const stream = (lastGrewAtMs: number): StatusStream => ({ lines: [], bytes: 0, lastGrewAtMs })
  const streams = { a: stream(1), b: stream(5), c: stream(3), d: stream(4) }
  expect(Object.keys(pruneStreams(streams, ['a', 'c']))).toEqual(['a', 'b', 'c'])
  expect(Object.keys(pruneStreams(streams, []))).toEqual(['b'])
  expect(Object.keys(pruneStreams({}, ['a']))).toEqual([])
})

test('a failed tail keeps the last lines', async ($, on) => {
  let fail = false
  const h = host(on, () => RUN, () => (fail ? { deny: 'tail could not start' } : { stdout: STREAM }))
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  expect(h.stream()?.lines).toEqual(RENDERED)
  fail = true
  await h.clock.advance(2 * LIVE_PERIOD_MS)
  expect(h.tails.length).toBe(3)
  expect(h.stream()).toEqual({ lines: RENDERED, bytes: STREAM.length, lastGrewAtMs: PERIOD_MS + LIVE_PERIOD_MS })
})

test('the 1 s tick starts only when the 3 s tick sees a running dispatch and stops when none runs; the ended tail stays until session.end', async ($, on) => {
  const answers = [OWNED, OWNED, RUN, RUN, OWNED, OWNED]
  let index = 0
  const h = host(on, () => answers[index++] ?? OWNED, () => ({ stdout: STREAM }))
  await start($)
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.tails.length).toBe(0)
  expect(h.held()?.streams).toEqual({})
  // The third projection carries a running dispatch: the tails start.
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  const tailed = h.tails.length
  expect(tailed).toBeGreaterThan(0)
  expect(h.stream()?.lines).toEqual(RENDERED)
  // The fifth projection carries none: the tails stop, the last lines stay.
  await h.clock.advance(PERIOD_MS)
  const after = h.tails.length
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.tails.length).toBe(after)
  expect(h.stream()?.lines).toEqual(RENDERED)
  await $.session.end({ reason: 'clear', sessionId: 'S-test', resume: { id: 'S-test' } })
  expect(h.held()?.streams).toEqual({})
})
