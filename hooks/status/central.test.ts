// The central pane (docs/specs/SPEC-central.md, items 8, 9, 11, 12, 13 and
// 14): /autoloop opens pane `autoloop` for the session that owns a run and
// answers otherwise, `/autoloop close` closes it, nothing opens it unasked
// without a fullscreen viewport. The pane draws a header, the four tabs
// and the shown tab's rows: Run's sections, Units' rows, Log's rows with a
// UTC time and a filter. The tab and the filter live in $.state, so a
// redraw keeps them and a press changes them; while the Log tab shows, the
// tick asks the producer for 500 entries. The row builders are pure over
// the producer's own projection (fixtures/projection.ts) and a hand-written
// proxy body; the host is doubled (fixtures/testing.ts `seat`).
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { StatusEvent, StatusProjection } from '../../types'

import { DISABLED, FALLBACK, IDLE, OWNED, PAUSED, RUN, TWO_DISPATCHES, UNOWNED, WAITING, WAITS } from './fixtures/projection'
import { AT_10_30, BASE, PERIOD_MS, autoloopCommand, band, buttons, findColor, pane, press, projection, rowCount, rows, seat, start } from './fixtures/testing'
import { RENDERED, STREAM } from './fixtures/stream'
import {
  LOG_LENGTH, PANE_ID, clockText, eventText, linesText, liveRoom, liveScroll, liveTab, liveTitle, logRow, logTab, noUnitText, passesFilter, runTab,
  statusLine, unitsTab, waitText,
} from './central'
import type { LogFilter, Row } from './central'
import { PALETTE, plain } from './kit'
import { LIVE_PERIOD_MS, QUIET_AFTER_MS, projectionArgv, readProxy } from './read'

/** The proxy's body for the Proxy section: one request of this session served, one of another requested only, one unknown. */
const SERVED = JSON.stringify({ ok: true, active_requests: [
  { id: 'r1', started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 61_000, requested_model: 'claude-opus-5-5', model: 'anthropic-gateway-opus[1m]', session_id: 'S-test' },
  { id: 'r2', started_at: '2026-09-28T10:29:30.000Z', elapsed_ms: 30_000, requested_model: 'gpt-6-astra', model: null, session_id: 'S-other' },
  { id: 'r3', started_at: '2026-09-28T10:29:59.000Z', elapsed_ms: 1_000, requested_model: null, model: null, session_id: null },
] })

/** A row as one line: the lead, the glyph, the text and the right-hand text. */
const line = (row: Row): string =>
  `${row.lead === null ? '' : `${row.lead}  `}${row.glyph === '' ? '' : `${row.glyph} `}${row.text}${row.right === null ? '' : ` ${row.right}`}`

/** Seats the host at 10:30 with the producer's text from `stdout()` and the served proxy body. */
const host = (on: Parameters<typeof seat>[0], stdout: () => string, env: Record<string, string> = {}) =>
  seat(on, { now: AT_10_30, projection: stdout, env, proxy: () => ({ body: SERVED }) })

const HEADER = ['◆ autoloop · review #412[⏸ pause]', '[Run][Live][Units][Log]']

test('the header names the loop state and marks a paused run', () => {
  expect(statusLine(projection(RUN))).toBe('review #412')
  expect(statusLine(projection(WAITING))).toBe('Idle')
  expect(statusLine(projection(PAUSED))).toBe('review #412 · paused')
})

test('the Run tab at 90 columns: Now, Timeline, Needs you, Waiting, Delivered and Proxy, each with its rows', async () => {
  const proxy = await readProxy(async () => ({ status: 200, text: SERVED }), BASE)
  const run = runTab(projection(RUN), proxy, 'S-test', AT_10_30, 90)
  expect(run.empty).toBeNull()
  expect(run.sections.map((section) => [section.title, ...section.rows.map(line)])).toEqual([
    ['Now', '● review #412 · Session recovery', 'code-review · fix 2/3 · ASTRA 6 · 3m 0s', '▶ #412 code-review · ASTRA 6 · 2m 0s'],
    ['Timeline', '✓ plan · 15m 0s · ASTRA 6', '● code-review · fix 2/3 · 3m 0s · ASTRA 6'],
    ['Needs you',
      '! #417 · Needs a policy answer answer on #417',
      '! #418 · Draft with open findings answer on #418',
      '! #419 · Draft handed off after the scan answer on #419',
      '! #423 · Needs an authorization answer on #423',
      '! #424 · PR #701 · PR awaiting authorization merge or label PR #701',
      '! #430 · Blocked without a record answer on #430'],
    ['Waiting', '◷ #414 waits on #399', '◷ #415 waits on PR #204 · src/a.mjs, src/b.mjs', '◷ #420 · staged, not dispatched'],
    ['Delivered', '✓ #416 · PR #700 · automatic merge pending (checks pending)'],
    ['Proxy', '● OPUS 5.5 → OPUS · 1m 1s this session', '● ASTRA 6 · 30s', '● unknown · 1s'],
  ])
})

test('the Run tab at 59 columns drops the Proxy section and keeps the Timeline to glyphs and names; 60 is not narrow', async () => {
  const proxy = await readProxy(async () => ({ status: 200, text: SERVED }), BASE)
  const titles = (columns: number) => runTab(projection(RUN), proxy, 'S-test', AT_10_30, columns).sections.map((section) => section.title)
  expect(titles(59)).toEqual(['Now', 'Timeline', 'Needs you', 'Waiting', 'Delivered'])
  expect(runTab(projection(RUN), proxy, 'S-test', AT_10_30, 59).sections[1]?.rows.map(line)).toEqual(['✓ plan', '● code-review'])
  expect(titles(60)).toEqual(['Now', 'Timeline', 'Needs you', 'Waiting', 'Delivered', 'Proxy'])
  expect(runTab(projection(RUN), proxy, 'S-test', AT_10_30, 60).sections[1]?.rows.map(line)).toEqual(['✓ plan · 15m 0s · ASTRA 6', '● code-review · fix 2/3 · 3m 0s · ASTRA 6'])
})

test('the Run tab without a unit says so and names the next selection; a returned unit says when it returned', () => {
  expect(noUnitText(projection(WAITING))).toBe('no unit in flight · next selection at 11:00 UTC')
  expect(noUnitText({ ...projection(WAITING), run: { ...projection(WAITING).run!, parkedUntil: null } })).toBe('no unit in flight')
  const waiting = runTab(projection(WAITING), null, 'S-test', AT_10_30, 90)
  expect(waiting.empty).toBe('no unit in flight · next selection at 11:00 UTC')
  expect(waiting.sections.map((section) => section.title)).toEqual(['Waiting'])
  const owned = runTab(projection(OWNED), { state: 'up', requests: [] }, 'S-test', AT_10_30, 90)
  expect(owned.sections.map((section) => [section.title, ...section.rows.map(line)])).toEqual([['Now', '● review #412', 'code-review · fix 2/3 · ASTRA 6 · 1m 0s']])
  const fallback = runTab(projection(FALLBACK), null, 'S-test', AT_10_30, 90)
  expect(fallback.sections[0]?.rows.map(line)).toEqual(['● simplify #413 · PR #702 · Simplify the guard', 'simplify · OPUS 5.5 (fallback) · returned 1m 0s ago'])
})

test('the Waiting rows name what each unit waits for: an issue, a PR with paths, a time, a green base', () => {
  const run = runTab(projection(WAITS), null, 'S-test', AT_10_30, 90)
  expect(run.sections.find((section) => section.title === 'Waiting')?.rows.map(line)).toEqual([
    '◷ #414 waits on #399',
    '◷ #415 waits on PR #204 · src/a.mjs, src/b.mjs',
    '◷ #426 waits until 10:50 UTC',
    '◷ #427 waits on a green base',
  ])
  expect(waitText({ kind: 'time', number: null, paths: null, until: null })).toBe('waits on time')
  expect(waitText({ kind: 'pr', number: 7, paths: null, until: null })).toBe('waits on PR #7')
})

test('the Units tab: one row per unit in the run\'s order with its glyph, PR, title, disposition, detail and age; a blocked unit carries its text dim', () => {
  const units = unitsTab(projection(RUN), AT_10_30)
  expect(units.map(line)).toEqual([
    '● #412 · Session recovery · active · 2m 0s',
    '✓ #413 · PR #702 · Simplify the guard · returned · 49m 0s',
    '◷ #414 · Waits on an issue · waiting · waiting per scan 10:10',
    '◷ #415 · Waits on a PR · waiting · waiting per scan 10:10 · 25m 0s',
    '✓ #416 · PR #700 · Delivered, merge pending · delivered · automatic merge pending (checks pending) · 50m 0s',
    '! #417 · Needs a policy answer · blocked · blocked (human:decide, loop-blocked) per scan 10:10 · 18m 0s',
    'Needs a policy answer',
    '! #418 · Draft with open findings · blocked · blocked (human:decide) per scan 10:10',
    'Draft with open findings',
    '✓ #419 · Draft handed off after the scan · returned',
    'Draft handed off after the scan',
    '◷ #420 · Staged plan · waiting · staged, not dispatched',
    '● #421 · Fix round in flight · active',
    '✓ #422 · Re-plan round returned · returned',
    '! #423 · Needs an authorization · blocked · blocked (human:authorize, loop-blocked) per scan 10:10',
    'Needs an authorization',
    '! #424 · PR #701 · PR awaiting authorization · blocked · blocked (human:authorize) per scan 10:10',
    'PR awaiting authorization',
    '✓ #425 · Seen in an earlier run · returned · last seen 08:00 (earlier run)',
    '! #430 · Blocked without a record · blocked · awaits /answer',
    'Blocked without a record',
  ])
  expect(units.filter((row) => row.dim).map((row) => row.text)).toEqual([
    'Needs a policy answer', 'Draft with open findings', 'Draft handed off after the scan', 'Needs an authorization', 'PR awaiting authorization',
    'Blocked without a record',
  ])
  // A long title is cut at 40 characters; OWNED's unit has none and its age is the step's start.
  const long: StatusProjection = { ...projection(OWNED), units: [{ ...projection(OWNED).units![0]!, title: 'x'.repeat(50) }] }
  expect(unitsTab(long, AT_10_30).map(line)).toEqual([`● #412 · ${'x'.repeat(39)}… · active · 1m 0s`])
})

test('the Log tab: every entry newest first as HH:MM:SS (UTC), glyph, writer, issue and PR, and one line per kind', () => {
  expect(logTab(projection(RUN), 'all').map(line)).toEqual([
    '10:28:00  ▶ dispatch  #412  code-review · ASTRA 6',
    '10:27:00  → step      #412  code-review · fix 2',
    '10:12:00  ! unit      #417  blocked POLICY_DENIED · May the workflow change proceed?',
    '10:05:00  ◷ unit      #415 PR #204  waits on PR #204 (src/a.mjs, src/b.mjs)',
    '09:41:00  ✓ publish   #413 PR #702  delivered PR #702',
    '09:40:00  ✓ publish   #416 PR #700  delivered PR #700',
    '08:55:00  ✓ dispatch  #412  plan returned · 14m 0s',
    '08:41:00  ▶ dispatch  #412  plan · ASTRA 6',
    '08:40:00  → step      #412  plan',
    '08:30:00  ◆ prime     run started',
  ])
  expect(clockText(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('03:04:05')
  expect(logTab(projection(OWNED), 'all')).toEqual([])
})

test('the Log tab prints the kinds the fixtures lack: a failed dispatch, a decision, waits, a resume, merges, a label, a control, a pause and the run\'s end', () => {
  const at = Date.UTC(2026, 8, 28, 12, 30, 41)
  const what = (event: Omit<StatusEvent, 'at' | 'by'> & { by?: string }) => line(logRow({ at, by: 'unit', ...event }))
  expect(what({ kind: 'dispatch.end', by: 'dispatch', issue: 517, pr: 530, role: 'fix', ms: 65_000, ok: false, reason: 'DISPATCH_TIMEOUT' }))
    .toBe('12:30:41  ✗ dispatch  #517 PR #530  fix DISPATCH_TIMEOUT · 1m 5s')
  expect(what({ kind: 'decision', issue: 517, text: 'keep the guard' })).toBe('12:30:41  ● unit      #517  decided: keep the guard')
  expect(what({ kind: 'wait', issue: 517, reason: 'issue', text: '#399' })).toBe('12:30:41  ◷ unit      #517  waits on #399')
  expect(what({ kind: 'wait', issue: 517, reason: 'time', text: '5 min' })).toBe('12:30:41  ◷ unit      #517  waits 5 min')
  expect(what({ kind: 'wait', issue: 517, reason: 'base', text: 'a green main' })).toBe('12:30:41  ◷ unit      #517  waits on a green main')
  expect(what({ kind: 'resume', issue: 517, reason: 'answer', text: 'go ahead' })).toBe('12:30:41  ▶ unit      #517  resumed · go ahead')
  expect(what({ kind: 'merge', by: 'publish', pr: 530, ok: true })).toBe('12:30:41  ✓ publish   merged PR #530')
  expect(what({ kind: 'merge', by: 'publish', pr: 530, ok: false, reason: 'base moved' })).toBe('12:30:41  ✗ publish   merge refused: base moved')
  expect(what({ kind: 'label', by: 'publish', issue: 517, pr: 530, text: 'human:authorize' })).toBe('12:30:41  · publish   #517 PR #530  label: human:authorize')
  expect(what({ kind: 'control', by: 'prime', text: 'pause' })).toBe('12:30:41  · prime     you: pause')
  expect(what({ kind: 'pause', by: 'prime' })).toBe('12:30:41  ⏸ prime     paused')
  expect(what({ kind: 'unpause', by: 'prime' })).toBe('12:30:41  ▶ prime     resumed by you')
  expect(what({ kind: 'run.end', by: 'prime', reason: 'closed' })).toBe('12:30:41  ◆ prime     run ended · closed')
  expect(what({ kind: 'step', issue: 517, step: '08-code-review', round: 'open-findings' })).toBe('12:30:41  → unit      #517  code-review · open findings')
  expect(what({ kind: 'select', by: 'loop' })).toBe('12:30:41  · loop      select')
  expect(eventText({ at, by: 'dispatch', kind: 'dispatch.end', ok: true, ms: 1000 })).toEqual({ glyph: '✓', what: 'dispatch returned · 1s' })
})

/** Every event kind the contract names (tools/events-contract.mjs EVENT_KINDS). */
const KINDS = ['run.start', 'run.end', 'select', 'step', 'dispatch.start', 'dispatch.end', 'decision', 'wait', 'resume', 'block', 'deliver', 'merge', 'label', 'control', 'pause', 'unpause']

test('the Log filter keeps steps, dispatches, needs-you and control kinds apart, and `all` keeps every kind', () => {
  const kinds = (filter: LogFilter) => logTab(projection(RUN), filter).map((row) => row.lead)
  expect(kinds('steps')).toEqual(['10:27:00', '08:40:00'])
  expect(kinds('dispatches')).toEqual(['10:28:00', '08:55:00', '08:41:00'])
  expect(kinds('needsYou')).toEqual(['10:12:00', '10:05:00'])
  expect(kinds('controls')).toEqual([])
  const every: StatusProjection = { ...projection(RUN), log: KINDS.map((kind) => ({ at: AT_10_30, by: 'prime', kind })) }
  const passing = (filter: LogFilter) => every.log!.filter((event) => passesFilter(event, filter)).map((event) => event.kind)
  expect(passing('all')).toEqual(KINDS)
  expect(passing('steps')).toEqual(['step', 'decision', 'resume'])
  expect(passing('dispatches')).toEqual(['dispatch.start', 'dispatch.end'])
  expect(passing('needsYou')).toEqual(['wait', 'block'])
  expect(passing('controls')).toEqual(['merge', 'label', 'control', 'pause', 'unpause'])
  expect(logTab(every, 'controls').map((row) => row.glyph)).toEqual(['✗', '·', '·', '⏸', '▶'])
})

test('the pane id is the literal the Pane matcher names', () => {
  expect(PANE_ID).toBe('autoloop')
})

test('/autoloop from a session that owns no run answers so and opens nothing', async ($, on) => {
  const h = host(on, () => UNOWNED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect((await autoloopCommand($, '')).text).toBe('autoloop: this session owns no run')
  expect(h.opens).toEqual([])
})

test('/autoloop opens the pane autoloop for the owner; /autoloop close closes it', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect((await autoloopCommand($, '')).text).toBe('autoloop: status pane opened')
  expect(h.opens.map((open) => open.id)).toEqual([PANE_ID])
  expect(h.closes).toEqual([])
  expect((await autoloopCommand($, 'close')).text).toBe('autoloop: status pane closed')
  expect(h.closes).toEqual([PANE_ID])
  expect((await autoloopCommand($, 'other')).text).toBe('autoloop: unknown argument "other"; use /autoloop or /autoloop close')
  expect(h.opens.length).toBe(1)
})

test('/autoloop in a project with ui.status false opens nothing and says so', async ($, on) => {
  const h = host(on, () => DISABLED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect((await autoloopCommand($, '')).text).toBe('autoloop: the status band is off (ui.status is false in .autoloop/config.json)')
  expect(h.opens).toEqual([])
})

test('nothing opens the pane on session.start, a tick or a draw of the band without a fullscreen viewport', async ($, on) => {
  const h = host(on, () => RUN, { ANTHROPIC_BASE_URL: BASE })
  await start($)
  await h.clock.advance(3 * PERIOD_MS)
  await band($)
  expect(h.opens).toEqual([])
})

test('the pane draws the header, the four tabs and the Run tab from the last reads, with the this-session mark', async ($, on) => {
  const h = host(on, () => RUN, { ANTHROPIC_BASE_URL: BASE })
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = await pane($)
  expect(rows(drawn)).toEqual([
    ...HEADER,
    'NOW',
    '● review #412 · Session recovery',
    'code-review · fix 2/3 · ASTRA 6 · 3m 3s',
    '▶ #412 code-review · ASTRA 6 · 2m 3s[cancel]',
    'TIMELINE',
    '✓ plan · 15m 0s · ASTRA 6',
    '● code-review · fix 2/3 · 3m 3s · ASTRA 6',
    'NEEDS YOU',
    '! #417 · Needs a policy answer answer on #417', '(answer…)',
    '! #418 · Draft with open findings answer on #418', '(answer…)',
    '! #419 · Draft handed off after the scan answer on #419', '(answer…)',
    '! #423 · Needs an authorization answer on #423', '(answer…)',
    '! #424 · PR #701 · PR awaiting authorization merge or label PR #701[authorize]',
    '! #430 · Blocked without a record answer on #430', '(answer…)',
    'WAITING',
    '◷ #414 waits on #399',
    '◷ #415 waits on PR #204 · src/a.mjs, src/b.mjs',
    '◷ #420 · staged, not dispatched',
    'DELIVERED',
    '✓ #416 · PR #700 · automatic merge pending (checks pending)[merge]',
    'PROXY',
    '● OPUS 5.5 → OPUS · 1m 1s this session',
    '● ASTRA 6 · 30s',
    '● unknown · 1s',
  ])
  expect(findColor(drawn, '!')).toBe(PALETTE.crit)
  expect(findColor(drawn, 'this session')).toBe(PALETTE.ink2)
  const tabRow = buttons(drawn).filter((button) => button.props.key?.startsWith('tab-'))
  expect(tabRow.map((button) => [button.props.hotkey, button.props.label, button.props.variant ?? null, button.props.plain ?? null]))
    .toEqual([['1', 'Run', 'primary', true], ['2', 'Live', null, true], ['3', 'Units', null, true], ['4', 'Log', null, true]])
  // At 59 columns the Proxy section goes and the Timeline keeps names; at 60 both stay.
  const narrow = rows(await pane($, 59))
  expect(narrow).not.toContain('PROXY')
  expect(narrow).toContain('✓ plan')
  const wide = rows(await pane($, 60))
  expect(wide).toContain('PROXY')
  expect(wide).toContain('✓ plan · 15m 0s · ASTRA 6')
})

test('the pane without a unit says so, leaves empty sections out, and says when the session owns no run', async ($, on) => {
  const answers = [IDLE, UNOWNED]
  let index = 0
  const h = host(on, () => answers[index++] ?? UNOWNED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  expect(rows(await pane($))).toEqual([
    '◆ autoloop · Idle[⏸ pause]', '[Run][Live][Units][Log]', 'NOW', 'no unit in flight · next selection at 11:00 UTC', 'WAITING', '◷ #420 · staged, not dispatched',
  ])
  await h.clock.advance(PERIOD_MS)
  expect(rows(await pane($))).toEqual(['autoloop: this session owns no run'])
})

test('a press on a tab changes it, a redraw keeps it, and the Units and Log tabs draw their rows', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS)
  await pane($)
  await press($, 'tab-3')
  // The drawn rows are the builders' rows at the clock of the draw, 3 s past the fixture's.
  expect(rows(await pane($))).toEqual([...HEADER, ...unitsTab(projection(RUN), AT_10_30 + PERIOD_MS).map(line)])
  expect(rows(await pane($))[2]).toBe('● #412 · Session recovery · active · 2m 3s')
  expect(buttons(await pane($)).find((button) => button.props.key === 'tab-3')?.props.variant).toBe('primary')
  await press($, 'tab-4')
  expect(rows(await pane($))).toEqual([...HEADER, '[all][steps][dispatches][needs you][controls]UTC', ...logTab(projection(RUN), 'all').map(line)])
  expect(rows(await pane($))[3]).toBe('10:28:00  ▶ dispatch  #412  code-review · ASTRA 6')
  await press($, 'filter-needsYou')
  const filtered = rows(await pane($))
  expect(filtered.slice(3)).toEqual([
    '10:12:00  ! unit      #417  blocked POLICY_DENIED · May the workflow change proceed?',
    '10:05:00  ◷ unit      #415 PR #204  waits on PR #204 (src/a.mjs, src/b.mjs)',
  ])
  expect(buttons(await pane($)).find((button) => button.props.key === 'filter-needsYou')?.props.variant).toBe('primary')
  await press($, 'tab-1')
  expect(rows(await pane($))[2]).toBe('NOW')
})

test('while the Log tab shows, the tick asks the producer for 500 entries; the other tabs take the default', async ($, on) => {
  const h = host(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS)
  const root = String(h.argvs()[0]?.[1]).replace(/\/tools\/status\.mjs$/u, '')
  expect(h.argvs()[0]).toEqual(projectionArgv(root, 'S-test'))
  expect(h.argvs()[0]).not.toContain('--log')
  await pane($)
  await press($, 'tab-4')
  await h.clock.advance(PERIOD_MS)
  expect(LOG_LENGTH).toBe(500)
  expect(h.argvs()[1]).toEqual(projectionArgv(root, 'S-test', LOG_LENGTH))
  expect(h.argvs()[1]?.slice(-2)).toEqual(['--log', '500'])
  await press($, 'tab-3')
  await h.clock.advance(PERIOD_MS)
  expect(h.argvs()[2]).not.toContain('--log')
})

// A text from outside the mod (an issue title, an event's text) reaches
// the pane and the band with its control sequences removed.

test('a needs-you title with a C0 character, and a log text with a bidi override, are drawn without them', async ($, on) => {
  const hostile = RUN.replaceAll('Needs a policy answer', 'Needs\\u0007 a \\u001b[31mpolicy answer').replaceAll('May the workflow change proceed?', 'May the \\u202eworkflow\\u202c proceed?')
  const h = host(on, () => hostile)
  await start($)
  await h.clock.advance(PERIOD_MS)
  const drawn = rows(await pane($))
  expect(drawn).toContain('! #417 · Needs a policy answer answer on #417')
  expect(drawn.join('\n')).not.toMatch(/[\u0007\u001b]/u)
  expect(rows(await band($))).toContain('! #417 Needs a policy answeranswer on #417 · +5 more')
  expect(h.toasts).toContain('#417 needs you: Needs a policy answer')
  await press($, 'tab-4')
  const log = rows(await pane($))
  expect(log).toContain('10:12:00  ! unit      #417  blocked POLICY_DENIED · May the workflow proceed?')
  expect(log.join('\n')).not.toMatch(/[‪-‮]/u)
  expect(plain('a\u001b]52;c;aGVsbG8=\u0007b\u001b[1mc\u001b[0m\td\u0085e​f')).toBe('abc\tdef')
})

// The Live tab (SPEC-central item 10): a button per running dispatch
// (`a`..`e`), the selected one primary; `f` toggles follow; the title
// row's three states; the window over the lines; the empty state.

/** RUN with its dispatches and log replaced: an ended one. */
function withDispatches(dispatches: unknown[], log: unknown[] = projection(RUN).log ?? []): string {
  return JSON.stringify({ ...projection(RUN), dispatches, log })
}
const D412 = projection(RUN).dispatches![0]!

/** Seats the host with a producer and a tail: the producer's text from `stdout()`, every tail the synthetic stream. */
const liveHost = (on: Parameters<typeof seat>[0], stdout: () => string) => seat(on, { now: AT_10_30, projection: stdout, tail: () => ({ stdout: STREAM }) })

const live = async ($: Engine, bodyRows = 40, bodyColumns = 90) => rows(await pane($, bodyColumns, bodyRows))
const LIVE = { selected: null, follow: true, liveOffset: 0, pending: null }

test('the Live tab lists a button per running dispatch with the hotkeys a and b, the selected one primary, and a press selects', async ($, on) => {
  const h = liveHost(on, () => TWO_DISPATCHES)
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  await pane($)
  await press($, 'tab-2')
  const drawn = await pane($)
  const row = buttons(drawn).filter((button) => button.props.key?.startsWith('live-') || button.props.key === 'follow')
  expect(row.map((button) => [button.props.key, button.props.label, button.props.hotkey, button.props.variant ?? null]))
    .toEqual([['live-d421', '#421 fix', 'a', 'primary'], ['live-d412', '#412 code-review', 'b', null], ['follow', 'follow', 'f', 'primary']])
  expect((await live($))[3]).toBe('#421 fix · OPUS 5.5 · 59m 4s · 20 lines')
  await press($, 'live-d412')
  expect((await live($))[3]).toBe('#412 code-review · ASTRA 6 · 2m 4s · 20 lines')
  expect(buttons(await pane($)).find((button) => button.props.key === 'live-d412')?.props.variant).toBe('primary')
  // The selection stays on d412 while it runs; when it ends the first running one is shown again.
  expect(liveTab(projection(TWO_DISPATCHES), {}, { ...LIVE, selected: 'd412' }, AT_10_30, 40, 90).shown?.id).toBe('d412')
  expect(liveTab(projection(RUN), {}, { ...LIVE, selected: 'd421' }, AT_10_30, 40, 90).shown?.id).toBe('d412')
})

test('the Live tab follows the stream\'s end; f turns follow off and the window starts at the offset; the window fits the body', async ($, on) => {
  const h = liveHost(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  await pane($)
  await press($, 'tab-2')
  // 10 body rows less the five of header, tabs, the gap, buttons and title: five lines, the newest last.
  expect(liveRoom(10, false)).toBe(5)
  const small = await pane($, 90, 10)
  expect(rows(small).slice(2)).toEqual(['[#412 code-review][follow][cancel]', '#412 code-review · ASTRA 6 · 2m 4s · 20 lines', ...RENDERED.slice(-5)])
  expect(rowCount(small)).toBe(10)
  expect((await live($, 40)).slice(4)).toEqual(RENDERED)
  await press($, 'follow')
  expect(buttons(await pane($)).find((button) => button.props.key === 'follow')?.props.variant).toBeUndefined()
  expect((await live($, 10)).slice(4)).toEqual(RENDERED.slice(0, 5))
  await press($, 'follow')
  expect((await live($, 10)).slice(4)).toEqual(RENDERED.slice(-5))
  // While the cancel question shows, its row takes one more.
  await press($, 'cancel')
  expect(liveRoom(10, true)).toBe(4)
  const asked = await pane($, 90, 10)
  expect(rows(asked)[2]).toBe('cancel #412 code-review?[yes][no]')
  expect(rows(asked).slice(5)).toEqual(RENDERED.slice(-4))
  expect(rowCount(asked)).toBe(10)
  await press($, 'confirm-no')
  expect(rowCount(await pane($, 90, 10))).toBe(10)
  // A reasoning tick draws dim.
  const view = liveTab(projection(RUN), { d412: { lines: RENDERED, lastGrewAtMs: AT_10_30 } }, LIVE, AT_10_30, 40, 90)
  expect(view.shown?.lines.filter((line) => line.dim).map((line) => line.text)).toEqual(['⋯ thinking ~2k tok'])
})

test('a scroll over the pane while the Live tab shows moves the window by the rows asked and turns follow off', async ($, on) => {
  const h = liveHost(on, () => RUN)
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  await pane($)
  await press($, 'tab-2')
  // Following: the window ends at line 20 of 20, five rows; two up lands at offset 13.
  const scroll = (by: number) => $.ui.scroll({ component: 'Pane', requestId: PANE_ID, offset: 0, by, bodyRows: 10, contentRows: 20, origin: { kind: 'person' } })
  expect(await scroll(-2)).toEqual({})
  expect(h.held()?.follow).toBe(false)
  expect(h.held()?.liveOffset).toBe(13)
  expect((await live($, 10)).slice(4)).toEqual(RENDERED.slice(13, 18))
  await scroll(-30)
  expect(h.held()?.liveOffset).toBe(0)
  await scroll(3)
  expect(h.held()?.liveOffset).toBe(3)
  expect((await live($, 10)).slice(4)).toEqual(RENDERED.slice(3, 8))
  // The rule the hook applies: from the window's place, by the rows asked, clamped; follow goes off.
  expect(liveScroll({ follow: true, liveOffset: 0 }, -2, 20, 5)).toEqual({ follow: false, liveOffset: 13 })
  expect(liveScroll({ follow: false, liveOffset: 6 }, 3, 14, 6)).toEqual({ follow: false, liveOffset: 8 })
  expect(liveScroll({ follow: false, liveOffset: 6 }, 30, 14, 6)).toEqual({ follow: false, liveOffset: 8 })
  expect(liveScroll({ follow: false, liveOffset: 6 }, -30, 14, 6)).toEqual({ follow: false, liveOffset: 0 })
  expect(liveScroll({ follow: true, liveOffset: 0 }, 1, 3, 6)).toEqual({ follow: false, liveOffset: 0 })
  // On another tab the scroll is the engine's.
  expect(h.scrolls()).toBe(0)
  await press($, 'tab-1')
  await scroll(-2)
  expect(h.scrolls()).toBe(1)
  expect(h.held()?.liveOffset).toBe(3)
})

test('the Live title says quiet after 120 s without growth, ended with the outcome from the log, or died when the dispatch is gone; 59 columns drops the line count', async ($, on) => {
  let text = RUN
  const h = liveHost(on, () => text)
  await start($)
  await h.clock.advance(PERIOD_MS + LIVE_PERIOD_MS)
  await pane($)
  await press($, 'tab-2')
  await h.clock.advance(QUIET_AFTER_MS)
  expect((await live($))[3]).toBe('#412 code-review · ASTRA 6 · 4m 4s · 20 lines · quiet 2m 0s')
  expect((await live($, 40, 60))[3]).toBe('#412 code-review · ASTRA 6 · 4m 4s · 20 lines · quiet 2m 0s')
  expect((await live($, 40, 59))[3]).toBe('#412 code-review · ASTRA 6 · 4m 4s · quiet 2m 0s')
  // The dispatch ends well: the log's dispatch.end names the outcome and the time.
  const endedAt = h.clock.now()
  text = withDispatches([], [{ at: endedAt, by: 'dispatch', kind: 'dispatch.end', issue: 412, dispatch: 'd412', role: 'code-review', ms: 250_000, ok: true }, ...(projection(RUN).log ?? [])])
  await h.clock.advance(PERIOD_MS + 30_000)
  expect((await live($)).slice(2, 4)).toEqual(['[follow]', '#412 code-review · ASTRA 6 · ended 33s ago · ok'])
  expect((await live($)).slice(4)).toEqual(RENDERED)
  // A failed end names its reason; a cancel is not a failure.
  text = withDispatches([], [{ at: endedAt, by: 'dispatch', kind: 'dispatch.end', issue: 412, dispatch: 'd412', role: 'code-review', ms: 250_000, ok: false, reason: 'DISPATCH_TIMEOUT' }])
  await h.clock.advance(PERIOD_MS)
  // The log holds no start for it: the end event names the issue and the role, and no model is claimed.
  expect((await live($))[3]).toBe('#412 code-review · ended 36s ago · DISPATCH_TIMEOUT')
  text = withDispatches([], [{ at: endedAt, by: 'dispatch', kind: 'dispatch.end', issue: 412, dispatch: 'd412', role: 'code-review', ms: 250_000, ok: false, reason: 'cancelled' }])
  await h.clock.advance(PERIOD_MS)
  expect((await live($))[3]).toBe('#412 code-review · ended 39s ago · cancelled')
  text = withDispatches([], [{ at: endedAt, by: 'dispatch', kind: 'dispatch.end', issue: 412, dispatch: 'd412', role: 'code-review', ok: false }])
  await h.clock.advance(PERIOD_MS)
  expect((await live($))[3]).toBe('#412 code-review · ended 42s ago · failed')
  // Gone from the dispatches with no end recorded: died, dated by the last growth; an empty log leaves only the id to name it.
  text = withDispatches([], [])
  await h.clock.advance(PERIOD_MS)
  expect((await live($))[3]).toBe('d412 · died · last wrote 2m 45s ago')
  expect(liveTitle(projection(withDispatches([{ ...D412, state: 'died' }], [])), 'd412', undefined, AT_10_30, false)).toBe('#412 code-review · ASTRA 6 · died')
  expect(linesText(999)).toBe('999 lines')
  expect(linesText(2140)).toBe('2.1k lines')
})

test('the Live tab without any dispatch says that none has run', async ($, on) => {
  const h = liveHost(on, () => OWNED)
  await start($)
  await h.clock.advance(PERIOD_MS)
  await pane($)
  await press($, 'tab-2')
  expect((await live($)).slice(2)).toEqual(['no dispatch has run yet'])
})
