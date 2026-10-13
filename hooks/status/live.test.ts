// The live tails (docs/specs/SPEC-central.md, item 2): every second while
// a dispatch runs, the mod tails the last 64 KiB of its live file with
// `tail -c -- <file>`, renders the complete lines as tools/dispatch-render.mjs
// does, and keeps the last 200 rendered lines per dispatch in $.state. A
// chunk cut mid-line drops its first line; a failed tail keeps the last
// lines; a tick that sees no growth writes nothing; a file that does not
// grow for 120 s while the dispatch runs is quiet; the 1 s tick runs only
// while a dispatch runs; an ended dispatch's tail stays until session.end;
// only an absolute live file is tailed. The host is doubled
// (fixtures/testing.ts `seat`); the projection text is the producer's own
// (fixtures/projection.ts); the stream is synthetic (fixtures/stream.ts).
import { expect, test } from 'claude-code/testing'
import type { StatusDispatch, StatusStream } from '../../types'

import { OWNED, RUN, TWO_DISPATCHES } from './fixtures/projection'
import { RENDERED, STREAM, STREAM_LINES } from './fixtures/stream'
import type { Answer } from './fixtures/testing'
import { PERIOD_MS, projection, ran, seat, start } from './fixtures/testing'
import {
  LIVE_PERIOD_MS, QUIET_AFTER_MS, STREAM_LINES_MAX, TAIL_BYTES, TAIL_TIMEOUT_MS, isQuiet, pruneStreams, runningDispatches, splitTail, tailArgv, tailLive,
} from './read'
import { createRenderer } from './render'

/** The running dispatch of the RUN fixture. */
const RUNNING = projection(RUN).dispatches?.[0] as StatusDispatch
const LIVE_FILE = RUNNING.liveFile as string
const TAIL = ['tail', '-c', '65536', '--', LIVE_FILE]

/** Seats the host: the producer's text from `stdout()`, `tail` answered from `stream()`. */
function host(on: Parameters<typeof seat>[0], stdout: () => string, stream: () => Answer) {
  const h = seat(on, { projection: stdout, tail: stream })
  return { ...h, stream: () => h.stream(RUNNING.dispatch) }
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

test('a stream line with an OSC 52 payload, an SGR sequence or a C0 character renders with no escape in it', () => {
  const render = createRenderer()
  const text = 'copy \\u001b]52;c;aGVsbG8=\\u0007 this \\u001b[31mred\\u001b[0m \\u0007bell'
  expect(render(`{"type":"assistant","message":{"content":[{"type":"text","text":"${text}"}]}}`)).toEqual(['│ copy  this red bell'])
  expect(render(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo \\u001b[2J"}}]}}`)).toEqual(['▸ $ echo'])
  expect(render(`{"type":"error","message":"\\u001b[1mboom\\u001b[0m"}`)).toEqual(['✖ boom'])
  expect(render('\u001b[31mnot json\u001b[0m')).toEqual(['· not json'])
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

test('tailLive runs tail -c 65536 -- <file> with a 2 s timeout and renders the complete lines; a failed tail is null', async () => {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = []
  const run = (text: string, exitCode = 0) => async (argv: readonly string[], init: { timeoutMs: number }) => {
    calls.push({ argv, timeoutMs: init.timeoutMs })
    return ran(text, exitCode)
  }
  const tailed = await tailLive(run(STREAM), LIVE_FILE)
  expect(calls[0]).toEqual({ argv: TAIL, timeoutMs: TAIL_TIMEOUT_MS })
  expect(tailArgv('-n')).toEqual(['tail', '-c', '65536', '--', '-n'])
  expect(TAIL_BYTES).toBe(65536)
  expect(TAIL_TIMEOUT_MS).toBe(2000)
  expect(tailed).toEqual({ chunk: STREAM, lines: RENDERED })
  expect(await tailLive(run('', 1), LIVE_FILE)).toBeNull()
  expect(await tailLive(async () => { throw new Error('tail could not start') }, LIVE_FILE)).toBeNull()
})

test('only a running dispatch with an absolute live file is tailed: a relative path or a flag is not', async ($, on) => {
  const relative = { ...RUNNING, dispatch: 'rel', liveFile: 'live/412.jsonl' }
  const flag = { ...RUNNING, dispatch: 'flag', liveFile: '-n' }
  const none = { ...RUNNING, dispatch: 'none', liveFile: null }
  const text = JSON.stringify({ ...projection(RUN), dispatches: [RUNNING, relative, flag, none] })
  expect(runningDispatches(projection(text)).map((dispatch) => dispatch.dispatch)).toEqual(['d412'])
  const h = host(on, () => text, () => ({ stdout: STREAM }))
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  expect(h.tails.map((call) => call.argv)).toEqual([TAIL])
  expect(Object.keys(h.held()?.streams ?? {})).toEqual(['d412'])
})

test('while a dispatch runs the mod tails its live file every second and keeps the rendered lines, capped at 200; a tick without growth writes nothing', async ($, on) => {
  let content = STREAM
  const h = host(on, () => RUN, () => ({ stdout: content }))
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.tails.length).toBe(0)
  const written = h.statusWrites()
  await h.clock.advance(LIVE_PERIOD_MS)
  expect(LIVE_PERIOD_MS).toBe(1000)
  expect(h.tails[0]).toEqual({ argv: TAIL, timeoutMs: TAIL_TIMEOUT_MS })
  expect(h.stream()).toEqual({ lines: RENDERED, lastGrewAtMs: PERIOD_MS + LIVE_PERIOD_MS })
  expect(h.statusWrites()).toBe(written + 1)
  // The same chunk again: nothing grew, the lines stay, and the state is not written.
  await h.clock.advance(LIVE_PERIOD_MS)
  expect(h.tails.length).toBe(2)
  expect(h.stream()?.lastGrewAtMs).toBe(PERIOD_MS + LIVE_PERIOD_MS)
  expect(h.statusWrites()).toBe(written + 1)
  // The file grows past the cap: the last 200 rendered lines, the newest last.
  content = `${Array.from({ length: 250 }, (_, n) => textEvent(n)).join('\n')}\n`
  await h.clock.advance(LIVE_PERIOD_MS)
  const stream = h.stream()
  expect(STREAM_LINES_MAX).toBe(200)
  expect(stream?.lines.length).toBe(200)
  expect(stream?.lines[0]).toBe('│ line 50')
  expect(stream?.lines[199]).toBe('│ line 249')
  expect(stream?.lastGrewAtMs).toBe(PERIOD_MS + 3 * LIVE_PERIOD_MS)
  expect(h.statusWrites()).toBe(written + 2)
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
  const stream = (lastGrewAtMs: number): StatusStream => ({ lines: [], lastGrewAtMs })
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
  expect(h.stream()).toEqual({ lines: RENDERED, lastGrewAtMs: PERIOD_MS + LIVE_PERIOD_MS })
})

test('the 1 s tick starts only when the 3 s tick sees a running dispatch and stops when none runs; the ended tail stays until session.end', async ($, on) => {
  const answers = [OWNED, OWNED, RUN, RUN, OWNED, OWNED]
  let index = 0
  const h = host(on, () => answers[index++] ?? OWNED, () => ({ stdout: STREAM }))
  await start($)
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.tails.length).toBe(0)
  expect(h.held()?.streams).toEqual({})
  // The third projection carries a running dispatch: a tail every second from then on (three by 12 s).
  await h.clock.advance(PERIOD_MS)
  await h.clock.advance(PERIOD_MS)
  expect(h.tails.length).toBe(3)
  expect(h.stream()?.lines).toEqual(RENDERED)
  // The fifth projection carries none: the 3 s tick, first at 15 s, cancels the
  // 1 s timer before its own 15 s turn; the tails stop at five, the last lines stay.
  await h.clock.advance(PERIOD_MS)
  expect(h.tails.length).toBe(5)
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.tails.length).toBe(5)
  expect(h.stream()?.lines).toEqual(RENDERED)
  await $.session.end({ reason: 'clear', sessionId: 'S-test', resume: { id: 'S-test' } })
  expect(h.held()?.streams).toEqual({})
})

test('two running dispatches are tailed in one tick, each to its own stream', async ($, on) => {
  const h = host(on, () => TWO_DISPATCHES, () => ({ stdout: STREAM }))
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  expect(h.tails.map((call) => call.argv[4])).toEqual(['/tmp/live/421-fix-r1.jsonl', LIVE_FILE])
  expect(Object.keys(h.held()?.streams ?? {})).toEqual(['d421', 'd412'])
})
