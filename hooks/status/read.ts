// The two reads (docs/specs/SPEC-status-mod.md, items 1 to 4): the
// projection, `tools/status.mjs --json --session <id>` run as a child of the
// Claude process and held to its schema; and the proxy, `GET <base>/status`
// without auth. Each is pure over an injected runner or fetch, so a test
// doubles the host and not the producer.
import type { ProxyRead, ProxyRequest, StatusProjection } from '../../types'

export const STATUS_SCHEMA = 'autoloop.status/1'
export const READ_TIMEOUT_MS = 2000
export const PROXY_TIMEOUT_MS = 2000
export const STALE_AFTER_MS = 30_000

export type Runner = (
  argv: readonly string[],
  init: { timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string }>

export type ProjectionRead = { ok: true; projection: StatusProjection } | { ok: false }

export function projectionArgv(pluginRoot: string, sessionId: string): string[] {
  return ['node', `${pluginRoot}/tools/status.mjs`, '--json', '--session', sessionId]
}

/** The text as one JSON object, or null when it is not one. */
function parseRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** The producer's stdout as a projection, or null when it is not this mod's schema. */
export function parseProjection(text: string): StatusProjection | null {
  const record = parseRecord(text)
  if (record === null || record['schema'] !== STATUS_SCHEMA || typeof record['owned'] !== 'boolean') return null
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

export type ProxyFetch = (
  url: string,
  init: { timeoutMs: number },
) => Promise<{ status: number; text: string }>

export function proxyUrl(base: string): string {
  return `${base.replace(/\/+$/u, '')}/status`
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** The proxy's body as its active requests, or null when it is not `{ ok: true, active_requests: [...] }`. */
export function parseProxyStatus(text: string): ProxyRequest[] | null {
  const record = parseRecord(text)
  if (record === null || record['ok'] !== true || !Array.isArray(record['active_requests'])) return null
  const requests: ProxyRequest[] = []
  for (const entry of record['active_requests'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null
    const fields = entry as Record<string, unknown>
    requests.push({
      id: String(fields['id'] ?? ''),
      startedAt: stringOrNull(fields['started_at']),
      elapsedMs: typeof fields['elapsed_ms'] === 'number' ? fields['elapsed_ms'] : null,
      requestedModel: stringOrNull(fields['requested_model']),
      model: stringOrNull(fields['model']),
      sessionId: stringOrNull(fields['session_id']),
    })
  }
  return requests
}

/** One proxy read: a rejected fetch, a non-200 or a body that does not parse is OFF. */
export async function readProxy(fetch: ProxyFetch, base: string): Promise<ProxyRead> {
  try {
    const result = await fetch(proxyUrl(base), { timeoutMs: PROXY_TIMEOUT_MS })
    if (result.status !== 200) return { on: false }
    const requests = parseProxyStatus(result.text)
    return requests === null ? { on: false } : { on: true, requests }
  } catch {
    return { on: false }
  }
}
