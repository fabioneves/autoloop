// The band's view (docs/specs/SPEC-status-mod.md, items 7 to 12, 16 and 17,
// and release two items 8, 10 and 13): pure functions from the projection
// and the proxy read to cell and row text. They hold no `$`; register.tsx
// draws what they return. Status is carried by a glyph and a word, so each
// cell hands back its glyph apart from its text.
import type { ProxyRead, ProxyRequest, StatusProjection, StatusRound, StatusUnit, StatusWorkedUnit } from '../../types'
import { GLYPH } from './kit'

/** Under this many body columns the band drops its wider texts (spec item 12). */
export const NARROW_COLUMNS = 120

export function isNarrow(bodyColumns: number): boolean {
  return bodyColumns < NARROW_COLUMNS
}

/** The parts that are text, joined with ` · `. */
export const parts = (list: (string | null | undefined)[]): string =>
  list.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ')

/** `#412 · PR #702`, or `#412` without a PR. */
export const ref = (issue: number, pr: number | null | undefined): string => (pr === null || pr === undefined ? `#${issue}` : `#${issue} · PR #${pr}`)

/** The text cut to `max` characters, an ellipsis as the last. */
export const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * A model id as a short name: tools/step.mjs `shortModel`, kept identical
 * so the band and the card name a model the same way (view.test.ts holds
 * the parity list).
 */
export function shortModel(id: string | null | undefined): string {
  const model = String(id ?? '').toLowerCase().replace(/^[a-z]+-gateway-/u, '').replace(/\[1m\]$/u, '')
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/u.exec(model)
  if (claude) return `${(claude[1] ?? '').toUpperCase()} ${claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]}`
  const gpt = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/u.exec(model)
  if (gpt) return `${(gpt[2] ?? '').toUpperCase()} ${gpt[1]}`
  return model.toUpperCase()
}

/** A span as step.mjs `duration` prints it (`45s`, `3m 2s`, `1h 05m`), kept identical. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The header's age of the last successful read. */
export function checkedAgo(lastOkAtMs: number | null, nowMs: number): string {
  if (lastOkAtMs === null) return 'not checked yet'
  return `checked ${Math.max(0, Math.floor((nowMs - lastOkAtMs) / 1000))}s ago`
}

/** The header's marks after the age, each drawn in the warning color: `stale`, `paused`. */
export function headerMarks(projection: StatusProjection, stale: boolean): string[] {
  return [stale ? 'stale' : null, projection.run?.paused === true ? 'paused' : null]
    .filter((mark): mark is string => mark !== null)
}

/** The command the hint on the right names. */
export const HINT = '/autoloop: central'

/** The round as the `--round` grammar names it: `fix 2/3`, `re-plan`, `open findings`, `full`; null without one. */
export function roundLabel(round: StatusRound | null): string | null {
  if (round === null) return null
  if (round.kind === 'fix') return `fix ${round.n ?? '?'}${round.budget === undefined ? '' : `/${round.budget}`}`
  return round.kind === 'open-findings' ? 'open findings' : round.kind
}

/** A model's short name, marked when it ran as a fallback: `OPUS 5.5 (fallback)`. */
export function modelName(model: string, fallback: boolean): string {
  return fallback ? `${shortModel(model)} (fallback)` : shortModel(model)
}

/** The model a proxy request asked for; `unknown` when it named none. */
export function requestedName(request: ProxyRequest): string {
  return request.requestedModel === null ? 'unknown' : shortModel(request.requestedModel)
}

/** The model the Loop column names: the one that ran under a fallback, else the role's pinned one. */
function modelLabel(unit: StatusWorkedUnit, models: Record<string, string>): string | null {
  const pinned = unit.role === null ? undefined : models[unit.role]
  const named = unit.fallback ? unit.model ?? pinned : pinned ?? unit.model
  return named === undefined || named === null ? null : modelName(named, unit.fallback)
}

export type LoopColumn = {
  glyph: string
  /** `review #412 · PR #702 · Session recovery`, or `Idle · last delivered #416`. */
  head: string
  /** `code-review · fix 2/3 · ASTRA 6`; null while idle. */
  detail: string | null
}

export function loopColumn(projection: StatusProjection, narrow: boolean): LoopColumn {
  if (projection.execution?.mode === 'daemon') {
    const execution = projection.execution
    const glyph = execution.state === 'running' ? GLYPH.active : execution.state === 'paused' ? GLYPH.paused : GLYPH.notYet
    return { glyph, head: `daemon ${execution.state}`, detail: narrow ? null : 'queue disabled · viewer only' }
  }
  const unit = projection.unit ?? null
  if (unit === null) {
    // The newest delivered unit: issue numbers rise with time, and the
    // projection carries no time on a unit.
    const delivered = (projection.units ?? []).filter((entry) => entry.disposition === 'delivered')
      .map((entry) => entry.issue)
    const last = delivered.length === 0 ? null : Math.max(...delivered)
    return { glyph: GLYPH.notYet, head: last === null ? 'Idle' : `Idle · last delivered #${last}`, detail: null }
  }
  const title = narrow || unit.title === null ? '' : ` · ${unit.title}`
  const detail = parts([unit.role, roundLabel(unit.round), modelLabel(unit, projection.models ?? {})])
  return { glyph: GLYPH.active, head: `${unit.phase} ${ref(unit.issue, unit.pr)}${title}`, detail: detail === '' ? null : detail }
}

/** The spinner's word while the session owns a run with a unit (SPEC-central item 4): `autoloop · build #517 · PR #530 · implement`; null without a unit. */
export function spinnerWord(projection: StatusProjection): string | null {
  const unit = projection.unit ?? null
  if (unit === null) return null
  return parts(['autoloop', `${unit.phase} ${ref(unit.issue, unit.pr)}`, unit.role])
}

export type WorkColumn = {
  counts: string
  /** `6 needs you`, drawn in the critical color; null while no unit needs a human (spec item 7). */
  needsYou: string | null
}

export function workColumn(projection: StatusProjection): WorkColumn {
  const counts = projection.counts ?? { active: 0, waiting: 0, blocked: 0 }
  return {
    counts: `${counts.active} active · ${counts.waiting} waiting`,
    needsYou: counts.blocked > 0 ? `${counts.blocked} needs you` : null,
  }
}

/** The body less the box's two border columns and one rule between each pair of cells, shared over the cells, the last one taking the remainder. */
export function columnWidths(bodyColumns: number, count: number): number[] {
  const inner = Math.max(count, bodyColumns - 2 - (count - 1))
  const each = Math.floor(inner / count)
  return Array.from({ length: count }, (_, index) => (index === count - 1 ? inner - each * (count - 1) : each))
}

/** The requests grouped by requested model, most first, ties by name; a request with no model is `unknown`. */
export function modelCounts(requests: ProxyRequest[]): { model: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const request of requests) {
    const model = requestedName(request)
    counts.set(model, (counts.get(model) ?? 0) + 1)
  }
  return [...counts].map(([model, count]) => ({ model, count }))
    .sort((left, right) => right.count - left.count || left.model.localeCompare(right.model))
}

export type ProxyColumn = {
  state: ProxyRead['state']
  /** `●` ON, `◐` UP, `○` OFF. */
  glyph: string
  word: 'ON' | 'UP' | 'OFF'
  /** After the word: ` · 3 requests` (narrow ` · 3 req`), ` · no status`, or nothing. */
  tail: string
  /** `OPUS 5.5 ×2`, one per model; none unless ON and not narrow. */
  rows: string[]
}

/** The three states of release two, item 10: `● ON · n requests`, `◐ UP · no status`, `○ OFF`. */
export function proxyColumn(proxy: ProxyRead, narrow: boolean): ProxyColumn {
  if (proxy.state === 'off') return { state: 'off', glyph: GLYPH.notYet, word: 'OFF', tail: '', rows: [] }
  if (proxy.state === 'up') return { state: 'up', glyph: GLYPH.half, word: 'UP', tail: ' · no status', rows: [] }
  const count = proxy.requests.length
  return {
    state: 'on', glyph: GLYPH.active, word: 'ON', tail: narrow ? ` · ${count} req` : ` · ${count} requests`,
    rows: narrow ? [] : modelCounts(proxy.requests).map(({ model, count: n }) => `${model} ×${n}`),
  }
}

export type PhaseCell = { label: string; state: 'done' | 'current' | 'notYet' }

/** The producer's phases against the worked unit's: null without a unit (spec item 8). */
export function phaseRow(projection: StatusProjection): PhaseCell[] | null {
  // An ordered phase index is not independent review/gate evidence. The daemon
  // module exposes no such evidence, so it draws no completion row.
  if (projection.execution?.mode === 'daemon') return null
  const unit = projection.unit ?? null
  if (unit === null) return null
  const phases = projection.phases ?? []
  const current = phases.indexOf(unit.phase)
  return phases.map((label, index) => ({ label, state: index < current ? 'done' : index === current ? 'current' : 'notYet' }))
}

export type BlockedUnit = StatusUnit & { needsYou: NonNullable<StatusUnit['needsYou']> }

/** The units a human must answer, oldest first: issue numbers rise with time, and the projection carries no time on a unit. */
export function blockedUnits(projection: StatusProjection): BlockedUnit[] {
  return (projection.units ?? []).filter((unit): unit is BlockedUnit => unit.needsYou !== null)
    .sort((left, right) => left.issue - right.issue)
}

/** The PR a human must merge or label: an authorization that carries one; null when the answer goes on the issue. */
export function prToAuthorize(unit: StatusUnit): number | null {
  return unit.needsYou?.kind === 'authorize' ? unit.pr : null
}

/** What answers a unit that needs a human: `answer on #N`, or `merge or label PR #M` for an authorization with its PR. */
export function answerText(unit: StatusUnit): string {
  const pr = prToAuthorize(unit)
  return pr === null ? `answer on #${unit.issue}` : `merge or label PR #${pr}`
}

export type NeedsYouRow = {
  issue: number
  text: string
  /** What answers it: `answer on #N`, or `merge or label PR #M` for an authorization with its PR. */
  right: string
  /** How many more units need a human. */
  more: number
}

/** The band's needs-you row for the oldest blocked unit (spec item 9); null while none is blocked. */
export function needsYouRow(projection: StatusProjection): NeedsYouRow | null {
  const [oldest, ...rest] = blockedUnits(projection)
  if (oldest === undefined) return null
  return { issue: oldest.issue, text: oldest.needsYou.text, right: answerText(oldest), more: rest.length }
}

const TOAST_TEXT_MAX = 60

/** The toast for a unit newly blocked (spec item 16): `#N needs you: <short>`. */
export function toastText(unit: { issue: number; text: string }): string {
  return `#${unit.issue} needs you: ${truncate(unit.text, TOAST_TEXT_MAX)}`
}
