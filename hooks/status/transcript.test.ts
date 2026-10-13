// The transcript (docs/specs/SPEC-central.md, items 4, 5 and 13): while
// the session owns a run the spinner's word is the loop's state; the
// `/autoloop` output row draws the band's card; the pane opens unasked once
// per session when a tick first sees an owned run under the fullscreen
// renderer, never on the classic one; an open the host does not place
// leaves the band its card. The host is doubled (fixtures/testing.ts
// `seat`); the projection text is the producer's own
// (fixtures/projection.ts).
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { RenderViewport } from 'claude-code'

import { FALLBACK, RUN, UNOWNED, WAITING } from './fixtures/projection'
import { ENGINE_DRAWS, PERIOD_MS, band, findText, projection, rows, seat, start } from './fixtures/testing'
import { PANE_ID, autoOpenDue } from './central'
import { spinnerWord } from './view'

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
  const h = seat(on, { projection: () => answers[index++] ?? UNOWNED })
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
  const h = seat(on, { projection: () => answers[index++] ?? UNOWNED })
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
  const h = seat(on, { projection: RUN })
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
  const h = seat(on, { projection: RUN })
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

test('an unasked open the host does not place leaves the band its card and is not asked again; the tick takes the pane as placed once the host lists it so', async ($, on) => {
  const h = seat(on, { projection: RUN, placed: false })
  await start($)
  await band($, 160, false, FULLSCREEN)
  await h.clock.advance(PERIOD_MS)
  expect(h.opens.length).toBe(1)
  expect(h.held()?.autoOpened).toBe(true)
  expect(h.held()?.paneOpen).toBe(false)
  expect(rows(await band($, 160, false, FULLSCREEN)).length).toBe(8)
  await h.clock.advance(2 * PERIOD_MS)
  expect(h.opens.length).toBe(1)
  // The terminal widens: the host's own record lists the pane as placed, and the next tick reads it.
  h.panes[0]!.isPlaced = true
  await h.clock.advance(PERIOD_MS)
  expect(h.held()?.paneOpen).toBe(true)
  expect(rows(await band($, 160, false, FULLSCREEN)).length).toBe(1)
  // The person closes it by hand: the host no longer lists it.
  h.panes.length = 0
  await h.clock.advance(PERIOD_MS)
  expect(h.held()?.paneOpen).toBe(false)
})
