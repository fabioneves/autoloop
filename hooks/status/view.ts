// The band's view (docs/specs/SPEC-status-mod.md, items 7 to 13, 16 and
// 17): pure functions from the projection and the proxy read to column and
// row text. They hold no `$`; register.tsx draws what they return. Status is
// carried by a glyph and a word, so each column hands back its glyph apart
// from its text.
import type { ProxyRead, ProxyRequest, StatusProjection, StatusRound, StatusUnit, StatusWorkedUnit } from '../../types'
import { GLYPH } from './theme'

/** Under this many body columns the band drops its wider texts (spec item 12). */
export const NARROW_COLUMNS = 120

export function isNarrow(bodyColumns: number): boolean {
  return bodyColumns < NARROW_COLUMNS
}

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

/** The round as the `--round` grammar names it: `fix 2/3`, `re-plan`, `open findings`, `full`. */
export function roundLabel(round: StatusRound): string {
  if (round.kind === 'fix') return `fix ${round.n ?? '?'}${round.budget === undefined ? '' : `/${round.budget}`}`
  return round.kind === 'open-findings' ? 'open findings' : round.kind
}

/** The model the Loop column names: the one that ran under a fallback, else the role's pinned one. */
function modelLabel(unit: StatusWorkedUnit, models: Record<string, string>): string | null {
  const pinned = unit.role === null ? undefined : models[unit.role]
  const named = unit.fallback ? unit.model ?? pinned : pinned ?? unit.model
  if (named === undefined || named === null) return null
  return unit.fallback ? `${shortModel(named)} (fallback)` : shortModel(named)
}

export type LoopColumn = {
  glyph: string
  /** `review #412 · Session recovery`, or `Idle · last delivered #416`. */
  head: string
  /** `code-review · fix 2/3 · ASTRA 6`; null while idle. */
  detail: string | null
}

export function loopColumn(projection: StatusProjection, narrow: boolean): LoopColumn {
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
  const detail = [unit.role, unit.round === null ? null : roundLabel(unit.round), modelLabel(unit, projection.models ?? {})]
    .filter((part): part is string => part !== null)
  return { glyph: GLYPH.active, head: `${unit.phase} #${unit.issue}${title}`, detail: detail.length === 0 ? null : detail.join(' · ') }
}

export type WorkColumn = {
  counts: string
  needsYou: string
  /** Drawn in the critical color: at least one unit needs a human. */
  hot: boolean
}

export function workColumn(projection: StatusProjection): WorkColumn {
  const counts = projection.counts ?? { active: 0, waiting: 0, blocked: 0 }
  return {
    counts: `${counts.active} active · ${counts.waiting} waiting`,
    needsYou: `${counts.blocked} needs you`,
    hot: counts.blocked > 0,
  }
}

/** The body shared over the columns in cells, the last one taking the remainder. */
export function columnWidths(bodyColumns: number, count: number): number[] {
  const each = Math.floor(bodyColumns / count)
  return Array.from({ length: count }, (_, index) => (index === count - 1 ? bodyColumns - each * (count - 1) : each))
}

/** The requests grouped by requested model, most first, ties by name; a request with no model is `unknown`. */
export function modelCounts(requests: ProxyRequest[]): { model: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const request of requests) {
    const model = request.requestedModel === null ? 'unknown' : shortModel(request.requestedModel)
    counts.set(model, (counts.get(model) ?? 0) + 1)
  }
  return [...counts].map(([model, count]) => ({ model, count }))
    .sort((left, right) => right.count - left.count || left.model.localeCompare(right.model))
}

export type ProxyColumn = {
  on: boolean
  word: 'ON' | 'OFF'
  /** After the word: ` · 3 active requests`, ` · 0 requests`, or narrow ` · 3 req`. */
  tail: string
  /** `OPUS 5.5 ×2`, one per model; none while OFF or narrow. */
  rows: string[]
}

export function proxyColumn(proxy: ProxyRead, narrow: boolean): ProxyColumn {
  const count = proxy.on ? proxy.requests.length : 0
  if (narrow) return { on: proxy.on, word: proxy.on ? 'ON' : 'OFF', tail: ` · ${count} req`, rows: [] }
  if (!proxy.on) return { on: false, word: 'OFF', tail: ' · 0 requests', rows: [] }
  return {
    on: true, word: 'ON', tail: ` · ${count} active requests`,
    rows: modelCounts(proxy.requests).map(({ model, count: n }) => `${model} ×${n}`),
  }
}

export type PhaseCell = { label: string; state: 'done' | 'current' | 'notYet' }

/** The producer's phases against the worked unit's: null without a unit (spec item 8). */
export function phaseRow(projection: StatusProjection): PhaseCell[] | null {
  const unit = projection.unit ?? null
  if (unit === null) return null
  const phases = projection.phases ?? []
  const current = phases.indexOf(unit.phase)
  return phases.map((label, index) => ({ label, state: index < current ? 'done' : index === current ? 'current' : 'notYet' }))
}

/** The units a human must answer, oldest first: issue numbers rise with time, and the projection carries no time on a unit. */
export function blockedUnits(projection: StatusProjection): StatusUnit[] {
  return (projection.units ?? []).filter((unit) => unit.needsYou !== null).sort((left, right) => left.issue - right.issue)
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
  if (oldest === undefined || oldest.needsYou === null) return null
  const right = oldest.needsYou.kind === 'authorize' && oldest.pr !== null
    ? `merge or label PR #${oldest.pr}` : `answer on #${oldest.issue}`
  return { issue: oldest.issue, text: oldest.needsYou.text, right, more: rest.length }
}

const TOAST_TEXT_MAX = 60

/** The toast for a unit newly blocked (spec item 16): `#N needs you: <short>`. */
export function toastText(unit: { issue: number; text: string }): string {
  const short = unit.text.length > TOAST_TEXT_MAX ? `${unit.text.slice(0, TOAST_TEXT_MAX - 1)}…` : unit.text
  return `#${unit.issue} needs you: ${short}`
}
