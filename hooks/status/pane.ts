// The pane's sections (docs/specs/SPEC-status-mod.md, item 15): pure
// builders from the projection and the proxy read to rows. They hold no `$`;
// register.tsx draws what they return, and a section with no rows is not
// drawn. Each row hands back its glyph apart from its text, so status is
// carried by the glyph and the words.
import type { ProxyRead, StatusProjection, StatusUnit, StatusWait } from '../../types'
import { GLYPH } from './kit'
import { blockedUnits, duration, modelName, prToAuthorize, requestedName, roundLabel, shortModel } from './view'

export const PANE_ID = 'autoloop'
export const PANE_TITLE = 'autoloop'

export type PaneRow = {
  glyph: string
  /** `#417 Needs a policy answer`, `OPUS 5.5 → OPUS · 1m 1s`. */
  text: string
  /** Drawn after the text: `answer on #417`, `PR #701`. */
  chips: string[]
  /** `this session` on a proxy request of this session; null otherwise. */
  mark: string | null
}

export type PaneSection = { title: 'Needs you' | 'Active' | 'Waiting' | 'Delivered' | 'Proxy'; rows: PaneRow[] }

const row = (glyph: string, parts: (string | null)[], chips: string[] = [], mark: string | null = null): PaneRow =>
  ({ glyph, text: parts.filter((part): part is string => part !== null).join(' · '), chips, mark })

/** `#412 Session recovery`, or `#412` without a title. */
const head = (unit: StatusUnit): string => (unit.title === null ? `#${unit.issue}` : `#${unit.issue} ${unit.title}`)

export function needsYouSection(projection: StatusProjection): PaneSection {
  return {
    title: 'Needs you',
    rows: blockedUnits(projection).map((unit) => {
      const pr = prToAuthorize(unit)
      return row(GLYPH.needsYou, [head(unit)], [pr === null ? `answer on #${unit.issue}` : `PR #${pr}`])
    }),
  }
}

/** The active units; the worked one carries the time since it started and its fallback mark. */
export function activeSection(projection: StatusProjection, nowMs: number): PaneSection {
  const worked = projection.unit ?? null
  const units = (projection.units ?? []).filter((unit) => unit.disposition === 'active')
  return {
    title: 'Active',
    rows: units.map((unit) => {
      const isWorked = worked !== null && worked.issue === unit.issue
      const model = unit.model === null ? null : modelName(unit.model, isWorked && worked.fallback)
      const elapsed = isWorked ? duration(nowMs - worked.startedAtMs) : null
      return row(GLYPH.active, [head(unit), unit.phase, unit.role, roundLabel(unit.round), model, elapsed])
    }),
  }
}

/** What a unit waits for, as the projection reads it back from the step's wait note. */
export function waitLabel(wait: StatusWait): string {
  if (wait.kind === 'issue') return `issue #${wait.number}`
  if (wait.kind === 'pr') return `PR #${wait.number}${wait.paths === null ? '' : ` (${wait.paths.join(', ')})`}`
  if (wait.kind === 'base') return 'base green'
  // The producer prints `until` as an ISO instant; the pane shows its minute in UTC.
  return wait.until === null ? 'time' : `until ${wait.until.slice(11, 16)} UTC`
}

export function waitingSection(projection: StatusProjection): PaneSection {
  return {
    title: 'Waiting',
    rows: (projection.units ?? []).filter((unit) => unit.disposition === 'waiting')
      .map((unit) => row(GLYPH.waiting, [head(unit), unit.waitingOn === null ? unit.detail : waitLabel(unit.waitingOn)])),
  }
}

export function deliveredSection(projection: StatusProjection): PaneSection {
  return {
    title: 'Delivered',
    rows: (projection.units ?? []).filter((unit) => unit.disposition === 'delivered')
      .map((unit) => row(GLYPH.done, [head(unit), unit.pr === null ? null : `PR #${unit.pr}`, unit.detail])),
  }
}

/** One row per active request: requested → served (requested alone while the served model is null), elapsed, this session. */
export function proxySection(proxy: ProxyRead | null, sessionId: string): PaneSection {
  const requests = proxy === null ? [] : proxy.requests
  return {
    title: 'Proxy',
    rows: requests.map((request) => {
      const requested = requestedName(request)
      const models = request.model === null ? requested : `${requested} → ${shortModel(request.model)}`
      return row(GLYPH.active, [models, request.elapsedMs === null ? null : duration(request.elapsedMs)], [],
        request.sessionId !== null && request.sessionId === sessionId ? 'this session' : null)
    }),
  }
}

/** The sections in the spec's order, those with rows only. */
export function paneSections(projection: StatusProjection, proxy: ProxyRead | null, sessionId: string, nowMs: number): PaneSection[] {
  return [
    needsYouSection(projection), activeSection(projection, nowMs), waitingSection(projection), deliveredSection(projection),
    proxySection(proxy, sessionId),
  ].filter((section) => section.rows.length > 0)
}
