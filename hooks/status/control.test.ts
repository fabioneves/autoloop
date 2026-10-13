// The controls (docs/specs/SPEC-central.md item 16): each button or input
// of the pane runs `tools/status.mjs --control` once, with the kind and its
// fields, toasts the outcome and queues one `autoloop: control` prompt that
// wakes a parked session. A cancel asks once (y sends, n drops); merge and
// authorize show only when the projection allows them; a failed run toasts
// its error and queues no prompt; a control the loop refused toasts once.
// The host is doubled: the producer answers the projection fixture or a
// control answer, the prompt queue records what was submitted.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { StatusProjection } from '../../types'

import { OWNED, RUN } from './fixtures/projection'
import { AT_10_30, PERIOD_MS, buttons, pane, press, projection, ran, rows, start } from './fixtures/testing'
import { PANE_ID, runTab } from './central'
import { WAKE_PROMPT, controlArgv, controlName, parseControlAnswer, refusedText } from './control'
import { LIVE_PERIOD_MS } from './read'
import { STREAM } from './fixtures/stream'


/** Seats the host: the producer answers the projection, or a control's answer; the prompts and toasts are recorded. */
function host(on: On, stdout: () => string, control: () => string = () => JSON.stringify({ ok: true, name: '1-x.json', kind: 'x' })) {
  const clock = mock.clock(on, { now: AT_10_30 })
  mock.env(on, {})
  const controls: (readonly string[])[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  on('session.id', () => ({ value: 'S-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    if (e.argv[0] !== 'node') return { value: ran(STREAM) }
    if (e.argv.includes('--control')) {
      controls.push(e.argv)
      return { value: ran(control()) }
    }
    return { value: ran(stdout()) }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  return { clock, controls, prompts, toasts }
}

const type = ($: Engine, key: string, text: string) => $.ui.input({ plugin: 'autoloop', key, text, requestId: PANE_ID })

/** The argv the mod must run for a control, less the plugin root the test cannot know. */
const tail = (argv: readonly string[]) => argv.slice(2)

/** Starts the session, ticks once (the fixture's needs-you toasts go by) and draws the pane. */
async function open($: Engine, h: ReturnType<typeof host>) {
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

test('the toasts name a control by its kind and its PR, issue or dispatch; a refusal carries the reason', () => {
  expect(controlName({ kind: 'pause' })).toBe('pause')
  expect(controlName({ kind: 'merge', pr: 700 })).toBe('merge PR #700')
  expect(controlName({ kind: 'answer', issue: 417 })).toBe('answer #417')
  expect(controlName({ kind: 'cancel', dispatch: 'd412', issue: null })).toBe('cancel d412')
  expect(controlName({ kind: null })).toBe('control')
  expect(refusedText({ kind: 'merge', pr: 700, issue: null, reason: 'checks pending' })).toBe('✗ merge PR #700 refused: checks pending')
  expect(parseControlAnswer(ran('{"ok":true,"name":"1-pause.json","kind":"pause"}'))).toEqual({ ok: true, name: '1-pause.json' })
  expect(parseControlAnswer(ran('{"ok":false,"error":"this session owns no run"}'))).toEqual({ ok: false, error: 'this session owns no run' })
  expect(parseControlAnswer(ran('', 1))).toEqual({ ok: false, error: 'the producer exited 1' })
  expect(parseControlAnswer(ran('{}'))).toEqual({ ok: false, error: 'the producer refused the control' })
})

test('the pause button sends pause, toasts, and queues one wake prompt; while paused it reads resume and sends unpause', async ($, on) => {
  let text = RUN
  const h = host(on, () => text)
  await open($, h)
  const pause = buttons(await pane($)).find((button) => button.props.key === 'pause')
  expect([pause?.props.label, pause?.props.hotkey, pause?.props.plain]).toEqual(['⏸ pause', 'p', true])
  await press($, 'pause')
  expect(h.controls.map(tail)).toEqual([['--control', '--session', 'S-test', '--kind', 'pause']])
  expect(h.prompts).toEqual([WAKE_PROMPT])
  expect(h.toasts).toEqual(['✓ pause sent'])
  const paused: StatusProjection = { ...projection(RUN), run: { ...projection(RUN).run!, paused: true } }
  text = JSON.stringify(paused)
  await h.clock.advance(PERIOD_MS)
  expect(buttons(await pane($)).find((button) => button.props.key === 'pause')?.props.label).toBe('▶ resume')
  await press($, 'pause')
  expect(h.controls.map(tail)[1]).toEqual(['--control', '--session', 'S-test', '--kind', 'unpause'])
  expect(h.prompts).toEqual([WAKE_PROMPT, WAKE_PROMPT])
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

test('merge shows on a delivered unit the loop\'s gate may merge, authorize on one that carries human:authorize; each sends its control', async ($, on) => {
  const h = host(on, () => RUN)
  await open($, h)
  const keys = buttons(await pane($)).map((button) => button.props.key).filter((key) => key?.startsWith('merge-') || key?.startsWith('authorize-'))
  expect(keys).toEqual(['authorize-701', 'merge-700'])
  expect(rows(await pane($))).toContain('✓ #416 · PR #700 · automatic merge pending (checks pending)[merge]')
  await press($, 'merge-700')
  await press($, 'authorize-701')
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

test('a control the producer refuses, or that fails to run, toasts the error and queues no prompt', async ($, on) => {
  let answer = JSON.stringify({ ok: false, error: 'this session owns no run' })
  const h = host(on, () => RUN, () => answer)
  await open($, h)
  await press($, 'pause')
  expect(h.toasts).toEqual(['✗ pause: this session owns no run'])
  expect(h.prompts).toEqual([])
  answer = ''
  await press($, 'merge-700')
  expect(h.toasts[1]).toBe('✗ merge PR #700: the producer printed no answer')
  expect(h.prompts).toEqual([])
})

test('a control the loop refused is toasted once with its reason, not again on the next tick', async ($, on) => {
  const refused = (names: string[]) => JSON.stringify({ ...projection(OWNED), controls: { refused: names.map((name) => ({ name, kind: 'merge', pr: 700, issue: null, reason: 'checks pending' })) } })
  let text = refused(['1-merge.json'])
  const h = host(on, () => text)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts).toEqual(['✗ merge PR #700 refused: checks pending'])
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts.length).toBe(1)
  text = refused(['1-merge.json', '2-merge.json'])
  await h.clock.advance(PERIOD_MS)
  expect(h.toasts.length).toBe(2)
})
