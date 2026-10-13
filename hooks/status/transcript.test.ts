// The transcript (docs/specs/SPEC-central.md, items 4, 5 and 13): while
// the session owns a run the spinner's word is the loop's state; the
// `/autoloop` output row draws the band's card; the pane opens unasked once
// per session when a tick first sees an owned run under the fullscreen
// renderer, never on the classic one. The host is doubled; the projection
// text is the producer's own (fixtures/projection.ts).
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PaneOpenArgs, RenderViewport } from 'claude-code'

import { FALLBACK, RUN, UNOWNED, WAITING } from './fixtures/projection'
import { ENGINE_DRAWS, PERIOD_MS, band, findText, projection, ran, rows, start } from './fixtures/testing'
import { PANE_ID, autoOpenDue } from './central'
import { spinnerWord } from './view'

/** Seats the host: the clock, the producer, the panes, and the engine's own drawing beneath the spinner and the output row. */
function host(on: On, stdout: () => string) {
  const clock = mock.clock(on)
  mock.env(on, {})
  const opens: PaneOpenArgs[] = []
  const words: string[] = []
  let outputPassed = 0
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The producer's calls alone take an answer; a running dispatch's tail is live.test.ts's.
  on('process.run', ($, e) => ({ value: ran(e.argv[0] === 'node' ? stdout() : '') }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opens.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ENGINE_DRAWS)
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    words.push(e.props.word)
    return ENGINE_DRAWS
  })
  on('ui.render', { component: 'CommandOutput' }, () => {
    outputPassed += 1
    return ENGINE_DRAWS
  })
  return { clock, opens, words, outputPassed: () => outputPassed }
}

const spinner = ($: Engine) => $.ui.render({
  surface: 'terminal', component: 'Spinner', requestId: 'spinner',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
})

const output = ($: Engine, args = '', text = 'autoloop: status pane opened') => $.ui.render({
  surface: 'terminal', component: 'CommandOutput', requestId: 'output', viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { command: 'autoloop', args, text, isErrored: false },
})

test('spinnerWord names the phase, the issue, the PR and the role; null without a unit', () => {
  expect(spinnerWord(projection(RUN))).toBe('autoloop · review #412 · code-review')
  expect(spinnerWord(projection(FALLBACK))).toBe('autoloop · simplify #413 · PR #702 · simplify')
  expect(spinnerWord({ ...projection(RUN), unit: { ...projection(RUN).unit!, role: null } })).toBe('autoloop · review #412')
  expect(spinnerWord(projection(WAITING))).toBeNull()
})

test('the spinner word is the loop\'s state while the session owns a run with a unit, and untouched otherwise', async ($, on) => {
  const answers = [RUN, FALLBACK, WAITING, UNOWNED]
  let index = 0
  const h = host(on, () => answers[index++] ?? UNOWNED)
  await start($)
  await spinner($)
  expect(h.words).toEqual(['Sauteing'])
  await h.clock.advance(PERIOD_MS)
  await spinner($)
  expect(h.words[1]).toBe('autoloop · review #412 · code-review')
  await h.clock.advance(PERIOD_MS)
  await spinner($)
  expect(h.words[2]).toBe('autoloop · simplify #413 · PR #702 · simplify')
  await h.clock.advance(PERIOD_MS)
  await spinner($)
  expect(h.words[3]).toBe('Sauteing')
  await h.clock.advance(PERIOD_MS)
  await spinner($)
  expect(h.words[4]).toBe('Sauteing')
})

test('the /autoloop output row draws the band\'s card for the owner; its other answers and an unowned session keep the engine\'s row', async ($, on) => {
  const answers = [RUN, UNOWNED]
  let index = 0
  const h = host(on, () => answers[index++] ?? UNOWNED)
  await start($)
  expect(await output($)).toEqual(ENGINE_DRAWS)
  expect(h.outputPassed()).toBe(1)
  await h.clock.advance(PERIOD_MS)
  const card = await output($)
  expect(findText(card, '◆')).toBeDefined()
  expect(rows(card)[0]).toContain('autoloop · checked 0s ago')
  expect(rows(card)).toContain('● review #412 · Session recovery')
  expect(h.outputPassed()).toBe(1)
  expect(await output($, 'close', 'autoloop: status pane closed')).toEqual(ENGINE_DRAWS)
  expect(h.outputPassed()).toBe(2)
  await h.clock.advance(PERIOD_MS)
  expect(await output($)).toEqual(ENGINE_DRAWS)
  expect(h.outputPassed()).toBe(3)
})

test('autoOpenDue: once, under fullscreen, while the pane is not open', () => {
  expect(autoOpenDue({ autoOpened: false, paneOpen: false }, true)).toBe(true)
  expect(autoOpenDue({ autoOpened: true, paneOpen: false }, true)).toBe(false)
  expect(autoOpenDue({ autoOpened: false, paneOpen: true }, true)).toBe(false)
  expect(autoOpenDue({ autoOpened: false, paneOpen: false }, false)).toBe(false)
  expect(autoOpenDue({ autoOpened: false, paneOpen: false }, null)).toBe(false)
})

const FULLSCREEN: RenderViewport = { columns: 160, rows: 40, isFullscreen: true }

test('the pane opens unasked once when a tick first sees an owned run after the band drew under fullscreen', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await band($, 160, false, FULLSCREEN)
  expect(h.opens).toEqual([])
  await h.clock.advance(PERIOD_MS)
  expect(h.opens.map((open) => [open.id, open.title, 'focus' in open])).toEqual([[PANE_ID, 'autoloop', false]])
  await h.clock.advance(3 * PERIOD_MS)
  await band($, 160, false, FULLSCREEN)
  expect(h.opens.length).toBe(1)
  // The band then draws its one-row form: the pane is open.
  expect(rows(await band($, 160, false, FULLSCREEN)).length).toBe(1)
})

test('the pane never opens unasked on the classic renderer (isFullscreen false) or where the surface has not said', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await band($, 160, false, { columns: 160, rows: 40, isFullscreen: false })
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.opens).toEqual([])
  await band($, 160, false, { columns: 160, rows: 40 })
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.opens).toEqual([])
  await band($, 160)
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.opens).toEqual([])
  // Fullscreen reported later: the next tick opens it.
  await band($, 160, false, FULLSCREEN)
  await h.clock.advance(PERIOD_MS)
  expect(h.opens.length).toBe(1)
})
