// The three reads (docs/specs/SPEC-status-mod.md, items 1 to 4, and
// SPEC-central.md item 2): the projection, `tools/status.mjs --json
// --session <id>` run as a child of the Claude process and held to its
// schema; the proxy, `GET <base>/status` without auth; and the live tails
// of running dispatches. Each is pure over an injected runner or fetch, so
// a test doubles the host and not the producer.
import type { ProxyRead, ProxyRequest, StatusDispatch, StatusProjection, StatusStream } from '../../types'
import { createRenderer } from './render'

export const STATUS_SCHEMA = 'autoloop.status/1'
export const READ_TIMEOUT_MS = 2000
export const PROXY_TIMEOUT_MS = 2000
export const STALE_AFTER_MS = 30_000

export type Runner = (
  argv: readonly string[],
  init: { timeoutMs: number; stdin?: string },
) => Promise<{ exitCode: number; stdout: string }>

export type ProjectionRead = { ok: true; projection: StatusProjection } | { ok: false }

/** The producer's argv; `logLength` asks for that many log entries (the Log tab's 500), the producer's default otherwise. */
export function projectionArgv(pluginRoot: string, sessionId: string, logLength: number | null = null, root: string | null = null): string[] {
  return ['node', `${pluginRoot}/tools/status.mjs`, '--json', '--session', sessionId,
    ...(logLength === null ? [] : ['--log', String(logLength)]), ...(root === null ? [] : ['--root', root])]
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

/**
 * One read: a child that cannot start, exits non-zero, prints another schema
 * or reports a fault (`owned: false` with `error`, exit 0: the producer never
 * throws) is a failed read, so the last projection is kept and goes stale.
 */
export async function readProjection(run: Runner, pluginRoot: string, sessionId: string, logLength: number | null = null, root: string | null = null): Promise<ProjectionRead> {
  try {
    const result = await run(projectionArgv(pluginRoot, sessionId, logLength, root), { timeoutMs: READ_TIMEOUT_MS })
    if (result.exitCode !== 0) return { ok: false }
    const projection = parseProjection(result.stdout)
    return projection === null || projection.error !== undefined ? { ok: false } : { ok: true, projection }
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The proxy base `ANTHROPIC_BASE_URL` names, or null: unset, not a URL, not
 * http or https, or not a loopback host (spec item 3). The read carries no
 * auth, so it never leaves this machine: a public gateway gets no column and
 * no fetch.
 */
export function proxyBase(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return LOOPBACK_HOSTS.has(url.hostname) ? value : null
}

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

/**
 * One proxy read: a 200 with a parsed body is `on`; any other answer (a
 * non-200, a body that does not parse) is `up`, the port answers without a
 * status; a rejected or timed-out fetch is `off`.
 */
export async function readProxy(fetch: ProxyFetch, base: string): Promise<ProxyRead> {
  let result: { status: number; text: string }
  try {
    result = await fetch(proxyUrl(base), { timeoutMs: PROXY_TIMEOUT_MS })
  } catch {
    return { state: 'off', requests: [] }
  }
  const requests = result.status === 200 ? parseProxyStatus(result.text) : null
  return requests === null ? { state: 'up', requests: [] } : { state: 'on', requests }
}

// The live tails (docs/specs/SPEC-central.md, item 2): the last 64 KiB of
// a running dispatch's live file through `tail -c`, since `$.fs.read` is
// capped at 4 MiB and a stream can be larger; the complete lines rendered
// as tools/dispatch-render.mjs renders them (render.ts).

export const TAIL_BYTES = 65536
export const TAIL_TIMEOUT_MS = 2000
export const LIVE_PERIOD_MS = 1000
/** A running dispatch whose file did not grow for this long is quiet. */
export const QUIET_AFTER_MS = 120_000
/** Rendered lines kept per dispatch. */
export const STREAM_LINES_MAX = 200

/** `tail -c 65536 -- <file>`: the `--` so a path can never read as a flag. */
export function tailArgv(liveFile: string): string[] {
  return ['tail', '-c', String(TAIL_BYTES), '--', liveFile]
}

const BYTES = new TextEncoder()

/**
 * The complete lines of a chunk. A chunk that fills the cap starts wherever
 * tail cut the file, so its first line is a cut line and goes (a cut
 * multi-byte character at its head decodes to a replacement character, so
 * the byte count is read with a margin); a chunk under the cap is the whole
 * file. The text after the last newline is a line still being written.
 */
export function splitTail(chunk: string): string[] {
  const cut = BYTES.encode(chunk).length >= TAIL_BYTES - 3
  const lines = chunk.split('\n')
  lines.pop()
  return cut ? lines.slice(1) : lines
}

export type Tailed = { chunk: string; lines: string[] }

/** One tail of a live file, rendered; null when tail could not run or failed, so the last lines are kept. */
export async function tailLive(run: Runner, liveFile: string): Promise<Tailed | null> {
  try {
    const result = await run(tailArgv(liveFile), { timeoutMs: TAIL_TIMEOUT_MS })
    if (result.exitCode !== 0) return null
    const render = createRenderer()
    return { chunk: result.stdout, lines: splitTail(result.stdout).flatMap(render) }
  } catch {
    return null
  }
}

/** The dispatches whose live file the mod tails: running, with an absolute file path (a relative one is not a dispatch's). */
export function runningDispatches(projection: StatusProjection | null): (StatusDispatch & { liveFile: string })[] {
  return (projection?.dispatches ?? []).filter((dispatch): dispatch is StatusDispatch & { liveFile: string } =>
    dispatch.state === 'running' && dispatch.liveFile !== null && dispatch.liveFile.startsWith('/'))
}

/**
 * The streams kept: every running dispatch's, and of the ended ones the
 * one that grew last (the Live tab shows the last ended dispatch's tail),
 * so a long session does not carry every dispatch's lines in its state.
 */
export function pruneStreams(streams: Record<string, StatusStream>, running: string[]): Record<string, StatusStream> {
  const ended = Object.entries(streams).filter(([id]) => !running.includes(id))
    .sort(([, left], [, right]) => right.lastGrewAtMs - left.lastGrewAtMs)
  const kept = new Set([...running, ...ended.slice(0, 1).map(([id]) => id)])
  return Object.fromEntries(Object.entries(streams).filter(([id]) => kept.has(id)))
}

/** Quiet: the dispatch runs and its file did not grow for 120 s. A died or ended dispatch is never quiet. */
export function isQuiet(stream: StatusStream, dispatch: StatusDispatch, nowMs: number): boolean {
  return dispatch.state === 'running' && nowMs - stream.lastGrewAtMs >= QUIET_AFTER_MS
}
