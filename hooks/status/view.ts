// The band's view (docs/specs/SPEC-status-mod.md, items 7, 10, 12, 13 and
// 17): pure functions from the projection and the proxy read to column text. They hold no `$`;
// register.tsx draws what they return. Status is carried by a glyph and a
// word, so each column hands back its glyph apart from its text.
import type { ProxyRead, ProxyRequest, StatusProjection, StatusRound, StatusWorkedUnit } from '../../types'
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

/** The header's age of the last successful read. */
export function checkedAgo(lastOkAtMs: number | null, nowMs: number): string {
  if (lastOkAtMs === null) return 'not checked yet'
  return `checked ${Math.max(0, Math.floor((nowMs - lastOkAtMs) / 1000))}s ago`
}

/** The round as the `--round` grammar names it: `fix 2/3`, `re-plan`, `open findings`, `full`. */
function roundLabel(round: StatusRound): string {
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
