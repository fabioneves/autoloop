// The status mod's state contract (docs/specs/SPEC-status-mod.md): what the
// plugin keeps in `$.state` under its own name, so a hot reload of the module
// keeps the last projection and the toasts already shown.

/** One unit of the run as the projection lists it. */
export type StatusUnit = {
  issue: number
  title: string | null
  disposition: 'active' | 'waiting' | 'blocked' | 'returned' | 'delivered'
  phase: string | null
  role: string | null
  model: string | null
  round: StatusRound | null
  detail: string | null
  waitingOn: StatusWait | null
  pr: number | null
  decisions: number
  needsYou: { kind: 'block' | 'decide' | 'authorize'; text: string } | null
}

export type StatusRound = { kind: 'full' | 'fix' | 're-plan' | 'open-findings'; n?: number; budget?: number }

export type StatusWait = { kind: 'issue' | 'pr' | 'base' | 'time'; number: number | null; paths: string[] | null; until: string | null }

/** The worked unit: the newest unstaged step, in flight or returned. */
export type StatusWorkedUnit = {
  issue: number
  title: string | null
  phase: string
  role: string | null
  model: string | null
  fallback: boolean
  round: StatusRound | null
  inFlight: boolean
  startedAtMs: number
  returnedAtMs: number | null
  waitingOn: StatusWait | null
  decisions: number
  /** The open loop pull request, from the scan or the deliver event. */
  pr: number | null
  /** The unit's steps this run, from the event file (SPEC-events item 5). */
  steps: StatusStep[]
}

/** One step of the worked unit as the event file recorded it. */
export type StatusStep = {
  step: string
  role: string | null
  round: StatusRound | null
  model: string | null
  startedAtMs: number
  /** When its dispatch returned; null while it runs or when none ran. */
  returnedAtMs: number | null
}

/** One event of the run's log: the event file's line less `v` and `run`, with the PR beside the issue when known. */
export type StatusEvent = {
  at: number
  kind: string
  by: string
  issue?: number
  pr?: number
  step?: string
  round?: string
  role?: string
  model?: string
  dispatch?: string
  liveFile?: string
  pid?: number
  ms?: number
  ok?: boolean
  reason?: string
  text?: string
  paths?: string[]
}

/** A dispatch with a start and no end: running while its pid lives, died when it is gone. */
export type StatusDispatch = {
  dispatch: string
  issue: number | null
  pr: number | null
  role: string | null
  model: string | null
  liveFile: string | null
  pid: number | null
  startedAtMs: number
  state: 'running' | 'died'
}

/**
 * What `tools/status.mjs --json --session <id>` prints: `owned: false` alone
 * for a session that owns no run, the rest for the owner.
 */
export type StatusProjection = {
  schema: string
  owned: boolean
  error?: string
  enabled?: boolean
  run?: {
    openedAtMs: number
    parkedUntil: string | null
    closedAt: string | null
    snapshotScannedAt: string | null
    snapshotAuthority: 'current' | 'history' | 'none'
  }
  phases?: string[]
  unit?: StatusWorkedUnit | null
  units?: StatusUnit[]
  counts?: { active: number; waiting: number; blocked: number; delivered: number; eligible: number | null }
  models?: Record<string, string>
  /** The run's last 50 events, newest first. */
  log?: StatusEvent[]
  dispatches?: StatusDispatch[]
}

/** One active request as the proxy's `GET /status` lists it (its snake_case fields, read leniently). */
export type ProxyRequest = {
  id: string
  startedAt: string | null
  elapsedMs: number | null
  requestedModel: string | null
  model: string | null
  sessionId: string | null
}

/**
 * The proxy read: ON with the active requests, or OFF. OFF is a fact, not a
 * stale value: a failed fetch, a non-200 or a body that does not parse drops
 * the last ON read.
 */
export type ProxyRead = { on: true; requests: ProxyRequest[] } | { on: false }

/** The mod's session state: the last reads and what it has already shown. */
export type StatusState = {
  /** The last projection that parsed, kept through failed reads. */
  last: StatusProjection | null
  /** When the last successful read finished; stale past 30 s. */
  lastOkAtMs: number | null
  /** How long the last tick took, successful or not. */
  lastMs: number | null
  /** The last proxy read; null while ANTHROPIC_BASE_URL is unset (no column) or before the first tick. */
  proxy: ProxyRead | null
  /** Issues whose needs-you toast was shown in this session. */
  seenBlocked: number[]
}

declare module 'claude-code' {
  interface PluginState {
    autoloop: { status: StatusState }
  }
}
