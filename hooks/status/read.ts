// The projection read (docs/specs/SPEC-status-mod.md, items 1, 2 and 4): the
// producer `tools/status.mjs --json --session <id>` run as a child of the
// Claude process, parsed and held to its schema. Pure over an injected
// runner, so a test doubles the host and not the producer.
import type { StatusProjection } from '../../types'

export const STATUS_SCHEMA = 'autoloop.status/1'
export const READ_TIMEOUT_MS = 2000
export const STALE_AFTER_MS = 30_000

export type Runner = (
  argv: readonly string[],
  init: { timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string }>

export type ProjectionRead = { ok: true; projection: StatusProjection } | { ok: false }

export function projectionArgv(pluginRoot: string, sessionId: string): string[] {
  return ['node', `${pluginRoot}/tools/status.mjs`, '--json', '--session', sessionId]
}

/** The producer's stdout as a projection, or null when it is not this mod's schema. */
export function parseProjection(text: string): StatusProjection | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record['schema'] !== STATUS_SCHEMA || typeof record['owned'] !== 'boolean') return null
  return record as StatusProjection
}

/** One read: a child that cannot start, exits non-zero or prints another schema is a failed read. */
export async function readProjection(run: Runner, pluginRoot: string, sessionId: string): Promise<ProjectionRead> {
  try {
    const result = await run(projectionArgv(pluginRoot, sessionId), { timeoutMs: READ_TIMEOUT_MS })
    if (result.exitCode !== 0) return { ok: false }
    const projection = parseProjection(result.stdout)
    return projection === null ? { ok: false } : { ok: true, projection }
  } catch {
    return { ok: false }
  }
}

/**
 * Whether the band may draw from a projection: the session owns a run and
 * the project has not turned the band off. The schema is checked again
 * here because `$.state` outlives the module: a value an older module
 * version wrote may carry another schema.
 */
export function isDrawable(projection: StatusProjection | null): projection is StatusProjection {
  return projection !== null && projection.schema === STATUS_SCHEMA
    && projection.owned === true && projection.enabled === true
}

/** Stale: no successful read yet, or none within the last 30 s. */
export function isStale(lastOkAtMs: number | null, nowMs: number): boolean {
  return lastOkAtMs === null || nowMs - lastOkAtMs > STALE_AFTER_MS
}
