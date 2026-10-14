// What the test files share: the producer's text as a projection, the
// host seated beneath the mod with its recorders, the band and the pane
// drawn through the engine, and the drawn tree read back as rows and
// colors. The host is doubled here and nowhere else: the producer answers
// by what it was asked (`--json`, `--control`, `tail`), never by call order.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpInit, On, PaneOpenArgs, ProcessRunInit, ProcessRunResult, RenderElement, RenderViewport, UiPane } from 'claude-code'
import type { StatusProjection, StatusState, StatusTick } from '../../../types'

import { PANE_ID } from '../central'
import { parseProjection } from '../read'
import { STREAM } from './stream'

/** The mod's tick period, as register.tsx holds it. */
export const PERIOD_MS = 3000
/** The proxy base the tests set: a loopback URL. */
export const BASE = 'http://127.0.0.1:8787'
/** The fixture's clock: 10:30 on 2026-09-28, three minutes after #412's fix round started. */
export const AT_10_30 = Date.UTC(2026, 8, 28, 10, 30)
/** What the engine draws beneath the mod, so a test sees the mod stand aside. */
export const ENGINE_DRAWS: RenderElement = { type: 'Text', children: ['engine'] }
/** One active request as the proxy lists it, 1.2 s in, this session's. */
export const request = (id: string, requested_model: string | null, model: string | null = null) => ({
  id, started_at: '2026-09-28T10:29:00.000Z', elapsed_ms: 1200, requested_model, model, session_id: 'S-test',
})
/** The proxy's body with three active requests: two Opus (one served), one Astra. */
export const THREE = JSON.stringify({ ok: true, active_requests: [
  request('r1', 'claude-opus-5-5', 'anthropic-gateway-opus[1m]'),
  request('r2', 'gpt-6-astra'),
  request('r3', 'claude-opus-5-5'),
] })
/** The producer's answer to a control it wrote. */
export const CONTROL_OK = JSON.stringify({ ok: true, name: '1-x.json', kind: 'x' })

export function projection(text: string): StatusProjection {
  const parsed = parseProjection(text)
  if (parsed === null) throw new Error('the fixture is not a projection')
  return parsed
}

export function ran(stdout: string, exitCode = 0): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** What a doubled child or fetch does: prints, is refused, or holds on the clock and then prints. */
export type Answer = { stdout: string; exitCode?: number } | { deny: string } | { holdMs: number; stdout: string }
export type ProxyAnswer = { body: string; status?: number } | { deny: string } | { holdMs: number; body: string }

export type SeatOptions = {
  /** The producer's text for `--json`: one text, or a function for a sequence or a failure. */
  projection?: string | (() => string | Answer)
  /** The producer's answer to `--control`; a written control by default. */
  control?: () => string | Answer
  /** What `tail` prints; the synthetic stream by default. */
  tail?: () => Answer
  /** The proxy's answer; THREE by default. */
  proxy?: () => ProxyAnswer
  env?: Record<string, string>
  /** The clock's start; the engine's own when left out. */
  now?: number
  /** `ui.open`'s answer: placed by default. */
  placed?: boolean
  /** When true, a write of the mod's state is refused. */
  denyState?: () => boolean
  /** An external host process answer for daemon commands; undefined uses the existing producer fixture. */
  process?: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult | undefined>
  root?: string
}

function answerOf(value: string | Answer): Answer {
  return typeof value === 'string' ? { stdout: value } : value
}

/**
 * Seats the host beneath the mod: the clock, the environment, the session,
 * the registry, the producer and `tail` as children, the proxy, the panes,
 * the toasts, the log, the prompt queue, the engine's own drawings beneath
 * the band, the spinner and the output row, and the state as written. The
 * recorders say what the mod asked of it.
 */
export function seat(on: On, options: SeatOptions = {}) {
  const clock = mock.clock(on, options.now === undefined ? {} : { now: options.now })
  mock.env(on, options.env ?? {})
  const runs: { argv: readonly string[]; timeoutMs: number | undefined }[] = []
  const tails: { argv: readonly string[]; timeoutMs: number | undefined }[] = []
  const controls: (readonly string[])[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const logged: string[] = []
  const opens: PaneOpenArgs[] = []
  const closes: string[] = []
  const fetches: { url: string; init: HttpInit | undefined }[] = []
  const words: string[] = []
  const panes: UiPane[] = []
  let passed = 0
  let outputPassed = 0
  let scrolls = 0
  let statusWrites = 0
  let held: StatusState | null = null
  let tick: StatusTick | null = null
  let sessionId = 'S-test'
  const projectionText = options.projection ?? ''
  const answer = async (value: Answer): Promise<{ value: ProcessRunResult } | { deny: string }> => {
    if ('deny' in value) return { deny: value.deny }
    if ('holdMs' in value) await clock.sleep(value.holdMs)
    return { value: ran(value.stdout, 'exitCode' in value ? value.exitCode : 0) }
  }
  on('session.id', () => ({ value: sessionId }))
  on('session.root', () => ({ value: options.root ?? '/work' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', async ($, e) => {
    const call = { argv: e.argv, timeoutMs: e.init?.timeoutMs }
    const external = await options.process?.(e.argv, e.init)
    if (external !== undefined) return { value: external }
    if (e.argv[0] === 'tail') {
      tails.push(call)
      return answer(options.tail?.() ?? { stdout: STREAM })
    }
    runs.push(call)
    if (e.argv.includes('--control')) {
      controls.push(e.argv)
      return answer(answerOf(options.control?.() ?? CONTROL_OK))
    }
    return answer(answerOf(typeof projectionText === 'string' ? projectionText : projectionText()))
  })
  on('http.fetch', async ($, e) => {
    fetches.push({ url: e.url, init: e.init })
    const next = options.proxy?.() ?? { body: THREE }
    if ('deny' in next) return { deny: next.deny }
    if ('holdMs' in next) await clock.sleep(next.holdMs)
    const status = 'status' in next && next.status !== undefined ? next.status : 200
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: next.body } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    opens.push(e)
    const isPlaced = options.placed ?? true
    const listed = panes.find((pane) => pane.id === e.id)
    if (listed === undefined) panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced })
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'unasked under 144 columns (120 now)' } }
  })
  on('ui.close', ($, e) => {
    closes.push(e.id)
    const index = panes.findIndex((pane) => pane.id === e.id)
    if (index >= 0) panes.splice(index, 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes] }))
  // The engine's own scroll beneath the mod's hook: the move it makes when the hook passes.
  on('ui.scroll', () => {
    scrolls += 1
    return {}
  })
  on('ui.render', { component: 'AbovePrompt' }, () => {
    passed += 1
    return ENGINE_DRAWS
  })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    words.push(e.props.word)
    return ENGINE_DRAWS
  })
  on('ui.render', { component: 'CommandOutput' }, () => {
    outputPassed += 1
    return ENGINE_DRAWS
  })
  // The test's `$` has no state noun: the mod's writes are read on their way down.
  on('state.set', { plugin: 'autoloop', key: 'status' }, ($, e, next) => {
    if (options.denyState?.() === true) return { deny: 'the state is not writable now' }
    statusWrites += 1
    held = e.value
    return next(e)
  })
  on('state.set', { plugin: 'autoloop', key: 'tick' }, ($, e, next) => {
    tick = e.value
    return next(e)
  })
  return {
    clock, runs, tails, controls, prompts, toasts, logged, opens, closes, fetches, words, panes,
    /** The producer's `--json` argvs. */
    argvs: () => runs.filter((call) => call.argv.includes('--json')).map((call) => call.argv),
    passed: () => passed,
    outputPassed: () => outputPassed,
    /** The scrolls the engine made itself, the hook having passed. */
    scrolls: () => scrolls,
    /** Writes of the mod's `status` key, so a test counts what a tick wrote. */
    statusWrites: () => statusWrites,
    /** The state as last written, the tick's clock beside it. */
    held: (): (StatusState & StatusTick) | null => (held === null && tick === null ? null : { ...(held as StatusState), ...(tick as StatusTick) }),
    /** The live stream of the dispatch `id` as last written. */
    stream: (id: string) => held?.streams[id] ?? null,
    setSession: (id: string) => { sessionId = id },
  }
}

export type Seat = ReturnType<typeof seat>

export async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

/** The /autoloop command as the person types it from the composer. */
export function autoloopCommand($: Engine, args: string) {
  return $.command.run({ command: 'autoloop', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

/** Draws the band; `viewport` is what the surface measured, left out as a surface that has not measured. */
export function band($: Engine, bodyColumns = 160, hasSurvey = false, viewport?: RenderViewport) {
  return $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    ...(viewport === undefined ? {} : { viewport }),
    props: { hasSurvey, isWorking: false, maxRows: 8, bodyColumns, scroll: { offset: 0, bodyRows: 7 }, view: {} },
  })
}

/** Draws the pane docked and unfocused. */
export function pane($: Engine, bodyColumns = 90, bodyRows = 40) {
  return $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: { title: 'autoloop', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  })
}

/** A press on the pane's element `key`. */
export const press = ($: Engine, key: string) => $.ui.press({ plugin: 'autoloop', key, requestId: PANE_ID })

/** Enter on the pane's Input `key` with `text` in it. */
export const type = ($: Engine, key: string, text: string) => $.ui.input({ plugin: 'autoloop', key, text, requestId: PANE_ID })

/** A tree's text, a Button as `[label]` and an Input as `(placeholder)`. */
export function texts(tree: RenderElement): string {
  if (tree.type === 'Button') return `[${tree.props.label}]`
  if (tree.type === 'Input') return `(${tree.props.placeholder ?? tree.props.key})`
  const children = 'children' in tree ? tree.children ?? [] : []
  return children.map((child) => (typeof child === 'string' ? child : texts(child))).join('')
}

/** A rule between two cells (kit `rule`): `│` glyphs and nothing else; left out of the rows. */
function isRule(tree: RenderElement): boolean {
  return tree.type === 'Box' && /^│+$/u.test(texts(tree))
}

/** The drawing's rows: a column Box, or a row Box of Boxes, lists its children's rows; a row Box of texts is one row; rules are skipped. */
export function rows(tree: RenderElement): string[] {
  const children = 'children' in tree ? tree.children ?? [] : []
  const column = tree.type === 'Box' && tree.props?.['flexDirection'] === 'column'
  const holdsBoxes = children.some((child) => typeof child !== 'string' && child.type === 'Box')
  if (tree.type !== 'Box' || (!column && !holdsBoxes)) return [texts(tree)]
  return children.flatMap((child) => (typeof child === 'string' ? [child] : isRule(child) ? [] : rows(child)))
}

/** The rows a drawing takes on the surface: a column Box stacks its children with its `gap` between them; a row Box is as tall as its tallest child. */
export function rowCount(tree: RenderElement): number {
  if (tree.type !== 'Box') return 1
  const children = (tree.children ?? []).filter((child): child is string | RenderElement => typeof child === 'string' || (typeof child === 'object' && child !== null))
  const counts = children.map((child) => (typeof child === 'string' ? 1 : rowCount(child)))
  if (tree.props?.['flexDirection'] !== 'column') return Math.max(1, ...counts)
  return counts.reduce((sum, count) => sum + count, 0) + Number(tree.props?.['gap'] ?? 0) * Math.max(0, counts.length - 1)
}

/** The Buttons anywhere in the tree. */
export function buttons(tree: RenderElement): Extract<RenderElement, { type: 'Button' }>[] {
  if (tree.type === 'Button') return [tree]
  const children = 'children' in tree ? tree.children ?? [] : []
  return children.flatMap((child) => (typeof child === 'string' ? [] : buttons(child)))
}

type TextElement = Extract<RenderElement, { type: 'Text' }>

/** The Text element that holds `text` as one of its own children. */
export function findText(tree: RenderElement, text: string): TextElement | undefined {
  if (tree.type === 'Text' && (tree.children ?? []).includes(text)) return tree
  const children = 'children' in tree ? tree.children ?? [] : []
  for (const child of children) {
    if (typeof child === 'string') continue
    const found = findText(child, text)
    if (found !== undefined) return found
  }
  return undefined
}

export function findColor(tree: RenderElement, text: string): string | undefined {
  return findText(tree, text)?.props?.['color'] as string | undefined
}
