// The controls (docs/specs/SPEC-central.md item 16): each button or input
// of the pane runs `tools/status.mjs --control` once, with the kind and its
// fields, toasts the outcome and queues one `autoloop: control` prompt that
// wakes a parked session. A cancel, a merge and an authorize ask once (y
// sends, n drops; a pending question the run outgrew is dropped by the
// tick); an answer's Enter sends once while the producer runs; merge and
// authorize show only when the projection allows them; a failed run toasts
// its error and queues no prompt; a control the loop refused toasts once.
// The host is doubled (fixtures/testing.ts `seat`): the producer answers
// the projection fixture or a control answer, the prompt queue records what
// was submitted.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { StatusProjection } from '../../types'

import { OWNED, PAUSED, REFUSED, RUN } from './fixtures/projection'
import type { Answer, Seat } from './fixtures/testing'
import { AT_10_30, PERIOD_MS, buttons, pane, press, projection, ran, rows, seat, start, type } from './fixtures/testing'
import { PANE_ID, pendingOffered, pendingQuestion, runTab } from './central'
import { CONTROL_TIMEOUT_MS, NO_ANSWER, WAKE_PROMPT, controlArgv, controlName, parseControlAnswer, refusedText } from './control'
import { LIVE_PERIOD_MS } from './read'

/** Seats the host at 10:30: the producer answers the projection, or a control's answer. */
const host = (on: Parameters<typeof seat>[0], stdout: () => string, control?: () => string | Answer) =>
  seat(on, { now: AT_10_30, projection: stdout, ...(control === undefined ? {} : { control }) })

/** The argv the mod must run for a control, less the plugin root the test cannot know. */
const tail = (argv: readonly string[]) => argv.slice(2)

/** Starts the session, ticks once (the fixture's needs-you toasts go by) and draws the pane. */
async function open($: Engine, h: Seat) {
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  h.toasts.length = 0
  await pane($)
}

test('controlArgv names the producer\'s --control mode with the kind and its fields', () => {
  expect(controlArgv('/p', 'S', { kind: 'pause' })).toEqual(['node', '/p/tools/status.mjs', '--control', '--session', 'S', '--kind', 'pause'])
  expect(tail(controlArgv('/p', 'S', { kind: 'unpause' }))).toEqual(['--control', '--session', 'S', '--kind', 'unpause'])
  expect(tail(controlArgv('/p', 'S', { kind: 'cancel', dispatch: 'd412', issue: 412 }))).toEqual(['--control', '--session', 'S', '--kind', 'cancel', '--dispatch', 'd412', '--issue', '412'])
  expect(tail(controlArgv('/p', 'S', { kind: 'cancel', dispatch: 'd412', issue: null }))).toEqual(['--control', '--session', 'S', '--kind', 'cancel', '--dispatch', 'd412'])
  expect(tail(controlArgv('/p', 'S', { kind: 'answer', issue: 417, text: 'use the spec' }))).toEqual(['--control', '--session', 'S', '--kind', 'answer', '--issue', '417', '--text', 'use the spec'])
  expect(tail(controlArgv('/p', 'S', { kind: 'merge', pr: 700 }))).toEqual(['--control', '--session', 'S', '--kind', 'merge', '--pr', '700'])
  expect(tail(controlArgv('/p', 'S', { kind: 'label', pr: 701 }))).toEqual(['--control', '--session', 'S', '--kind', 'label', '--pr', '701'])
})

test('the toasts name a control by its kind and its PR, issue or dispatch; a refusal carries the reason; no answer says the file may be written', () => {
  expect(controlName({ kind: 'pause' })).toBe('pause')
  expect(controlName({ kind: 'merge', pr: 700 })).toBe('merge PR #700')
  expect(controlName({ kind: 'answer', issue: 417 })).toBe('answer #417')
  expect(controlName({ kind: 'cancel', dispatch: 'd412', issue: null })).toBe('cancel d412')
  expect(controlName({ kind: null })).toBe('control')
  expect(refusedText({ kind: 'merge', pr: 700, issue: null, reason: 'checks pending' })).toBe('✗ merge PR #700 refused: checks pending')
  expect(parseControlAnswer(ran('{"ok":true,"name":"1-pause.json","kind":"pause"}'))).toEqual({ ok: true, name: '1-pause.json' })
  expect(parseControlAnswer(ran('{"ok":false,"error":"this session owns no run"}'))).toEqual({ ok: false, error: 'this session owns no run' })
  expect(parseControlAnswer(ran('', 1))).toEqual({ ok: false, error: 'the producer exited 1' })
  expect(parseControlAnswer(ran(''))).toEqual({ ok: false, error: NO_ANSWER })
  expect(parseControlAnswer(ran('{}'))).toEqual({ ok: false, error: 'the producer refused the control' })
  expect(NO_ANSWER).toBe('no answer: applied at the next prime if written')
  // The producer reads the projection before it writes: the timeout holds more than a read's 2 s.
  expect(CONTROL_TIMEOUT_MS).toBe(10_000)
  expect(pendingQuestion({ kind: 'cancel', dispatch: 'd', issue: 1, name: '#1 fix' })).toBe('cancel #1 fix?')
  expect(pendingQuestion({ kind: 'merge', pr: 700 })).toBe('merge PR #700?')
  expect(pendingQuestion({ kind: 'authorize', pr: 701 })).toBe('authorize PR #701?')
})

test('the pause button sends pause with a 10 s timeout, toasts, and queues one wake prompt; while paused it reads resume and sends unpause', async ($, on) => {
  let text = RUN
  const h = host(on, () => text)
  await open($, h)
  const pause = buttons(await pane($)).find((button) => button.props.key === 'pause')
  expect([pause?.props.label, pause?.props.hotkey, pause?.props.plain]).toEqual(['⏸ pause', 'p', true])
  await press($, 'pause')
  expect(h.controls.map(tail)).toEqual([['--control', '--session', 'S-test', '--kind', 'pause']])
  expect(h.runs.find((call) => call.argv.includes('--control'))?.timeoutMs).toBe(CONTROL_TIMEOUT_MS)
  expect(h.prompts).toEqual([WAKE_PROMPT])
  expect(h.toasts).toEqual(['✓ pause sent'])
  text = PAUSED
  await h.clock.advance(PERIOD_MS)
  expect(buttons(await pane($)).find((button) => button.props.key === 'pause')?.props.label).toBe('▶ resume')
  await press($, 'pause')
  expect(h.controls.map(tail)[1]).toEqual(['--control', '--session', 'S-test', '--kind', 'unpause'])
  expect(h.prompts).toEqual([WAKE_PROMPT, WAKE_PROMPT])
})

test('the pause button reads the run as last written: a press after a tick that flipped paused sends the kind of the moment', async ($, on) => {
  let text = RUN
  const h = host(on, () => text)
  await open($, h)
  // The pane drew `pause`; a tick then sees the run paused, with no redraw between.
  text = PAUSED
  await h.clock.advance(PERIOD_MS)
  await press($, 'pause')
  expect(h.controls.map(tail)).toEqual([['--control', '--session', 'S-test', '--kind', 'unpause']])
  text = RUN
  await h.clock.advance(PERIOD_MS)
  await press($, 'pause')
  expect(h.controls.map(tail)[1]).toEqual(['--control', '--session', 'S-test', '--kind', 'pause'])
})

test('the Run tab lists each running dispatch under Now with a cancel button; a press asks y/n, y sends cancel once, n sends nothing', async ($, on) => {
  const h = host(on, () => RUN)
  await open($, h)
  const now = runTab(projection(RUN), null, 'S-test', AT_10_30, 90).sections[0]
  expect(now?.rows.map((row) => [row.glyph, row.text, row.action])).toEqual([
    ['●', 'review #412 · Session recovery', null],
    ['', 'code-review · fix 2/3 · ASTRA 6 · 3m 0s', null],
    ['▶', '#412 code-review · ASTRA 6 · 2m 0s', { kind: 'cancel', dispatch: 'd412', issue: 412, name: '#412 code-review' }],
  ])
  expect(rows(await pane($)).slice(2, 6)).toEqual(['NOW', '● review #412 · Session recovery', 'code-review · fix 2/3 · ASTRA 6 · 3m 4s', '▶ #412 code-review · ASTRA 6 · 2m 4s[cancel]'])
  await press($, 'cancel-d412')
  expect(h.controls).toEqual([])
  const asked = rows(await pane($))
  expect(asked[2]).toBe('cancel #412 code-review?[yes][no]')
  const confirm = buttons(await pane($)).filter((button) => button.props.key?.startsWith('confirm-'))
  expect(confirm.map((button) => [button.props.key, button.props.hotkey, button.props.plain])).toEqual([['confirm-yes', 'y', true], ['confirm-no', 'n', true]])
  await press($, 'confirm-no')
  expect(h.controls).toEqual([])
  expect(rows(await pane($))[2]).toBe('NOW')
  await press($, 'cancel-d412')
  await pane($)
  await press($, 'confirm-yes')
  expect(h.controls.map(tail)).toEqual([['--control', '--session', 'S-test', '--kind', 'cancel', '--dispatch', 'd412', '--issue', '412']])
  expect(h.prompts).toEqual([WAKE_PROMPT])
  expect(h.toasts).toEqual(['✓ cancel #412 sent'])
  expect(rows(await pane($))[2]).toBe('NOW')
})

test('the Live tab\'s x cancels the shown running dispatch after its y; no button when no dispatch runs', async ($, on) => {
  let text = RUN
  const h = host(on, () => text)
  await open($, h)
  await press($, 'tab-2')
  const cancel = buttons(await pane($)).find((button) => button.props.key === 'cancel')
  expect([cancel?.props.label, cancel?.props.hotkey, cancel?.props.plain]).toEqual(['cancel', 'x', true])
  await press($, 'cancel')
  expect(rows(await pane($))[2]).toBe('cancel #412 code-review?[yes][no]')
  await press($, 'confirm-yes')
  expect(h.controls.map(tail)).toEqual([['--control', '--session', 'S-test', '--kind', 'cancel', '--dispatch', 'd412', '--issue', '412']])
  expect(h.prompts).toEqual([WAKE_PROMPT])
  text = JSON.stringify({ ...projection(RUN), dispatches: [] })
  await h.clock.advance(PERIOD_MS)
  expect(buttons(await pane($)).find((button) => button.props.key === 'cancel')).toBeUndefined()
})

test('a pending cancel does not outlive its dispatch: once the tick sees it gone the question goes, and y sends nothing', async ($, on) => {
  let text = RUN
  const h = host(on, () => text)
  await open($, h)
  await press($, 'cancel-d412')
  expect(rows(await pane($))[2]).toBe('cancel #412 code-review?[yes][no]')
  expect(h.held()?.pending).toEqual({ kind: 'cancel', dispatch: 'd412', issue: 412, name: '#412 code-review' })
  text = JSON.stringify({ ...projection(RUN), dispatches: [] })
  await h.clock.advance(PERIOD_MS)
  expect(h.held()?.pending).toBeNull()
  expect(rows(await pane($))[2]).toBe('NOW')
  // The y of the question drawn before the tick: a redraw has taken the row, and the pane drawn now has none.
  expect(buttons(await pane($)).find((button) => button.props.key === 'confirm-yes')).toBeUndefined()
  expect(h.controls).toEqual([])
  expect(pendingOffered(projection(RUN), { kind: 'cancel', dispatch: 'd412', issue: 412, name: 'x' })).toBe(true)
  expect(pendingOffered(projection(RUN), { kind: 'cancel', dispatch: 'd9', issue: 412, name: 'x' })).toBe(false)
  expect(pendingOffered(projection(RUN), { kind: 'merge', pr: 700 })).toBe(true)
  expect(pendingOffered(projection(RUN), { kind: 'merge', pr: 701 })).toBe(false)
  expect(pendingOffered(projection(RUN), { kind: 'authorize', pr: 701 })).toBe(true)
  expect(pendingOffered(projection(OWNED), { kind: 'merge', pr: 700 })).toBe(false)
})

test('an Input under a needs-you row of kind block or decide sends answer with the issue and the text; empty text sends nothing', async ($, on) => {
  const h = host(on, () => RUN)
  await open($, h)
  const drawn = rows(await pane($))
  const needsYou = drawn.slice(drawn.indexOf('NEEDS YOU') + 1, drawn.indexOf('WAITING'))
  expect(needsYou).toEqual([
    '! #417 · Needs a policy answer answer on #417', '(answer…)',
    '! #418 · Draft with open findings answer on #418', '(answer…)',
    '! #419 · Draft handed off after the scan answer on #419', '(answer…)',
    '! #423 · Needs an authorization answer on #423', '(answer…)',
    '! #424 · PR #701 · PR awaiting authorization merge or label PR #701[authorize]',
    '! #430 · Blocked without a record answer on #430', '(answer…)',
  ])
  await type($, 'answer-417', '   ')
  expect(h.controls).toEqual([])
  await type($, 'answer-417', 'use the spec')
  expect(h.controls.map(tail)).toEqual([['--control', '--session', 'S-test', '--kind', 'answer', '--issue', '417', '--text', 'use the spec']])
  expect(h.prompts).toEqual([WAKE_PROMPT])
  expect(h.toasts).toEqual(['✓ answer #417 sent'])
})

test('an Enter twice on an answer while the producer runs sends one control; once it returned, another Enter sends again', async ($, on) => {
  const h = host(on, () => RUN, () => ({ holdMs: 500, stdout: JSON.stringify({ ok: true, name: '1-answer.json', kind: 'answer' }) }))
  await open($, h)
  await type($, 'answer-417', 'use the spec')
  await type($, 'answer-417', 'use the spec')
  expect(h.controls.length).toBe(1)
  await h.clock.advance(500)
  expect(h.toasts).toEqual(['✓ answer #417 sent'])
  expect(h.prompts).toEqual([WAKE_PROMPT])
  await type($, 'answer-417', 'and the plan')
  expect(h.controls.length).toBe(2)
})

test('merge shows on a delivered unit the loop\'s gate may merge, authorize on one that carries human:authorize; each asks y/n and sends its control once', async ($, on) => {
  const h = host(on, () => RUN)
  await open($, h)
  const keys = buttons(await pane($)).map((button) => button.props.key).filter((key) => key?.startsWith('merge-') || key?.startsWith('authorize-'))
  expect(keys).toEqual(['authorize-701', 'merge-700'])
  expect(rows(await pane($))).toContain('✓ #416 · PR #700 · automatic merge pending (checks pending)[merge]')
  // A double press asks once and sends nothing until its y.
  await press($, 'merge-700')
  await press($, 'merge-700')
  expect(h.controls).toEqual([])
  expect(rows(await pane($))[2]).toBe('merge PR #700?[yes][no]')
  await press($, 'confirm-yes')
  expect(h.controls.map(tail)).toEqual([['--control', '--session', 'S-test', '--kind', 'merge', '--pr', '700']])
  expect(rows(await pane($))[2]).toBe('NOW')
  await press($, 'authorize-701')
  expect(rows(await pane($))[2]).toBe('authorize PR #701?[yes][no]')
  await press($, 'confirm-no')
  expect(h.controls.length).toBe(1)
  await press($, 'authorize-701')
  await pane($)
  await press($, 'confirm-yes')
  expect(h.controls.map(tail)).toEqual([
    ['--control', '--session', 'S-test', '--kind', 'merge', '--pr', '700'],
    ['--control', '--session', 'S-test', '--kind', 'label', '--pr', '701'],
  ])
  expect(h.prompts).toEqual([WAKE_PROMPT, WAKE_PROMPT])
  expect(h.toasts).toEqual(['✓ merge PR #700 sent', '✓ label PR #701 sent'])
  // A delivered unit that needs an authorization, or one without a PR, offers no merge.
  const run = projection(RUN)
  const held: StatusProjection = { ...run, units: run.units!.map((unit) => (unit.issue === 416 ? { ...unit, needsYou: { kind: 'authorize' as const, text: 'x' } } : unit)) }
  expect(runTab(held, null, 'S-test', AT_10_30, 90).sections.find((section) => section.title === 'Delivered')?.rows[0]?.action).toEqual({ kind: 'authorize', pr: 700 })
  const bare: StatusProjection = { ...run, units: run.units!.map((unit) => (unit.issue === 416 ? { ...unit, pr: null } : unit)) }
  expect(runTab(bare, null, 'S-test', AT_10_30, 90).sections.find((section) => section.title === 'Delivered')?.rows[0]?.action).toBeNull()
  expect(buttons(await pane($)).find((button) => button.props.key === 'merge-700')?.props.hotkey).toBeUndefined()
})

test('a control the producer refuses, fails to run, or does not answer toasts the error and queues no prompt', async ($, on) => {
  let answer: string | Answer = JSON.stringify({ ok: false, error: 'this session owns no run' })
  const h = host(on, () => RUN, () => answer)
  await open($, h)
  await press($, 'pause')
  expect(h.toasts).toEqual(['✗ pause: this session owns no run'])
  expect(h.prompts).toEqual([])
  answer = ''
  await press($, 'merge-700')
  await pane($)
  await press($, 'confirm-yes')
  expect(h.toasts[1]).toBe(`✗ merge PR #700: ${NO_ANSWER}`)
  expect(h.prompts).toEqual([])
  // The child is killed at the timeout: the call rejects, and the file may be written all the same.
  answer = { deny: 'the child outlasted 10000 ms' }
  await press($, 'pause')
  expect(h.toasts[2]).toMatch(/^✗ pause: no answer: applied at the next prime if written \(.*the child outlasted 10000 ms\)$/u)
  expect(h.prompts).toEqual([])
})

test('a control the loop refused is toasted once with its reason, not again on the next tick', async ($, on) => {
  const refused = (names: string[]) => JSON.stringify({ ...projection(OWNED), controls: { refused: names.map((name) => ({ name, kind: 'merge', pr: 700, issue: null, reason: 'checks pending' })) } })
  let text = REFUSED
  const h = host(on, () => text)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts).toEqual(['#417 needs you: Needs a policy answer', '#418 needs you: Draft with open findings', '#419 needs you: Draft handed off after the scan',
    '#423 needs you: Needs an authorization', '#424 needs you: PR awaiting authorization', '#430 needs you: Blocked without a record',
    '✗ merge PR #700 refused: merge gate: checks pending'])
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts.length).toBe(7)
  text = refused(['1-merge.json', '2-merge.json'])
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts.length).toBe(9)
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts.length).toBe(9)
})
