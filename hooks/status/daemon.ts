// Trusted daemon control client. No model-callable receipt issuer is registered.
// command.run origins and ui.press are host events; plugin origin by itself is
// not authorization. Each direct process call consumes one exact private entry.
import type { Args, CommandRunInput, Origin, ProcessRunInit, ProcessRunResult, UiPressArgument } from 'claude-code'
import type { StatusControlResponse, StatusProjection } from '../../types'
import { readProjection } from './read'

export type DaemonOperation = 'start' | 'attach' | 'disconnect' | 'pause' | 'resume' | 'stop' | 'stop-now'
type HostRequest = {
  schema: 'autoloop.host-request/1'
  route: 'status' | 'loop'
  invocationId: string
  sessionId: string
  root: string
  operation: DaemonOperation
  runId: string | null
  requestId: string | null
  generation: number | null
}
type HostCommand = {
  schema: 'autoloop.loop-command/1'
  operation: DaemonOperation
  root: string
  repositoryKey: string
  nodePath: string
  entrypoint: string
  pluginRoot: string
  pluginVersion: string
  pluginDigest: string
  runId: string | null
  requestId: string | null
  generation: number | null
  payload: Record<string, unknown>
}
type HostEnvelope = {
  schema: 'autoloop.host-invocation/1'
  invocationId: string
  sessionId: string
  commandDigest: string
  host: { pid: number; start: string; bootId: string }
  issuedAt: number
  expiresAt: number
}
type PendingCall = {
  request: HostRequest | null
  sessionId: string
  root: string
  epoch: number
  expiresAt: number
  argv: readonly string[]
  init: ProcessRunInit
  ending: boolean
}
export type DaemonHost = {
  pluginRoot: string
  sessionId: () => Promise<string>
  root: () => Promise<string>
  now: () => Promise<number>
  resolve: (path: string) => Promise<string>
  run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  read: () => Promise<StatusProjection | null>
  project: (projection: StatusProjection | null) => Promise<void>
  toast: (text: string) => void
  log: (text: string) => void
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const HASH = /^[0-9a-f]{64}$/u
const DENY = 'HOST_AUTH_REQUIRED: no matching operator gesture'
const TIMEOUT_MS = 10000
const CONTROL_KINDS = ['pause', 'resume', 'stop', 'stop-now'] as const
const UNCERTAIN_CODES = new Set(['OUTCOME_UNKNOWN', 'STATE_IO_FAILED', 'STATE_INVALID', 'RECOVERY_REQUIRED', 'OWNER_UNVERIFIED'])
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): boolean {
  return record(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export async function commandDigest(command: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(command)))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}
class DaemonError extends Error {
  constructor(readonly code: string, readonly knownRefusal = false) {
    super(`${code}: ${UNCERTAIN_CODES.has(code) && !knownRefusal ? 'no verified daemon answer' : 'the daemon operation was refused'}`)
  }
}
function refusal(code = 'HOST_AUTH_REQUIRED', knownRefusal = false): DaemonError { return new DaemonError(code, knownRefusal) }
function parsed(text: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw refusal('OUTCOME_UNKNOWN') }
  if (!record(value)) throw refusal('OUTCOME_UNKNOWN')
  return value
}
function loopData(result: { exitCode: number; stdout: string }): Record<string, unknown> {
  const answer = parsed(result.stdout)
  if (answer['schema'] !== 'autoloop.loop/1') throw refusal('OUTCOME_UNKNOWN')
  if (answer['ok'] !== true || result.exitCode !== 0) {
    const error = answer['error']
    const code = record(error) && typeof error['code'] === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(error['code']) ? error['code'] : 'OUTCOME_UNKNOWN'
    throw refusal(code, !UNCERTAIN_CODES.has(code))
  }
  if (!record(answer['data'])) throw refusal('OUTCOME_UNKNOWN')
  return answer['data']
}
export function receiptText(operation: string, data: Record<string, unknown>): string {
  if (!uuid(data['requestId']) || !uuid(data['runId']) || !['pending', 'processing', 'applied', 'refused', 'unknown'].includes(String(data['status']))) {
    throw refusal('OUTCOME_UNKNOWN')
  }
  const receipt = data as unknown as StatusControlResponse
  const accepted = data['accepted'] === true ? 'accepted · ' : ''
  const code = receipt.outcome?.code === undefined ? '' : ` · ${receipt.outcome.code}`
  return `autoloop: ${operation} ${accepted}${receipt.status}${code} · request ${receipt.requestId}`
}
function backendArgv(command: HostCommand, sessionId: string): string[] {
  if (command.operation === 'attach' || command.operation === 'disconnect') {
    return [command.nodePath, command.entrypoint, `--${command.operation}`, '--session', sessionId, '--root', command.root,
      ...(command.runId === null ? [] : ['--run', command.runId]),
      ...(command.generation === null ? [] : ['--generation', String(command.generation)]), '--host-request']
  }
  return [command.nodePath, command.entrypoint, command.operation === 'stop-now' ? 'stop' : command.operation,
    ...(command.operation === 'stop-now' ? ['--now'] : []), '--root', command.root,
    ...(command.runId === null ? [] : ['--run', command.runId]),
    ...(command.requestId === null ? [] : ['--request', command.requestId]),
    ...(command.generation === null ? [] : ['--generation', String(command.generation)]), '--host-request', '--json']
}
function guarded(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.endsWith('/loop-host.mjs'))
    || (argv.some((arg) => arg.endsWith('/status.mjs')) && ['--host-request', '--attach', '--disconnect', '--viewer-ended'].some((flag) => argv.includes(flag)))
    || (argv.some((arg) => arg.endsWith('/loop.mjs')) && argv.some((arg) => ['start', 'run', 'pause', 'resume', 'stop'].includes(arg)))
}
/** Created once by register. Maps are module-private, never $.state/store/env. */
export function daemonClient() {
  const pendingGestures = new Map<string, PendingCall>()
  const inFlight = new Map<string, string>()
  // Lifetime tracking can only revoke a display. It never admits a process call.
  const viewerSessions = new Set<string>()
  let epoch = 0
  const admitProcess = async (host: DaemonHost, e: Args<'process.run'>, origin: Origin): Promise<boolean> => {
    if (origin.plugin !== 'autoloop' || origin.tier !== 'user') return false
    const entry = [...pendingGestures.entries()].find(([, call]) => canonical(call.argv) === canonical(e.argv) && canonical(call.init) === canonical(e.init))
    if (entry === undefined) return false
    const [id, call] = entry
    if (call.epoch !== epoch || call.expiresAt <= await host.now() || call.root !== await host.root()
      || (!call.ending && call.sessionId !== await host.sessionId())) return false
    // Consume before next. A replay, another plugin or a nested call has no entry.
    pendingGestures.delete(id)
    return true
  }

  const discover = async (host: DaemonHost, sessionId: string, root: string) => {
    const data = loopData(await host.run(['node', `${host.pluginRoot}/tools/status.mjs`, '--discover', '--session', sessionId, '--root', root], { timeoutMs: 2000 }))
    const candidate = data['candidate']
    if (!record(candidate) || !uuid(candidate['runId']) || !positive(candidate['generation'])) throw refusal('RUN_MISMATCH')
    return { runId: candidate['runId'], generation: candidate['generation'] }
  }
  const validateHandoff = async (host: DaemonHost, request: HostRequest, answer: Record<string, unknown>) => {
    const command = answer['command']
    const envelope = answer['envelope']
    if (!exact(answer, ['command', 'envelope']) || !exact(command, ['schema', 'operation', 'root', 'repositoryKey', 'nodePath', 'entrypoint',
      'pluginRoot', 'pluginVersion', 'pluginDigest', 'runId', 'requestId', 'generation', 'payload'])
      || !exact(envelope, ['schema', 'invocationId', 'sessionId', 'commandDigest', 'host', 'issuedAt', 'expiresAt'])) throw refusal()
    const c = command as unknown as HostCommand
    const e = envelope as unknown as HostEnvelope
    const pluginRoot = await host.resolve(host.pluginRoot)
    const root = await host.resolve(request.root)
    const entrypoint = await host.resolve(`${host.pluginRoot}/tools/${['attach', 'disconnect'].includes(request.operation) ? 'status' : 'loop'}.mjs`)
    const now = await host.now()
    if (c.schema !== 'autoloop.loop-command/1' || c.operation !== request.operation || c.root !== root || c.pluginRoot !== pluginRoot
      || c.entrypoint !== entrypoint || typeof c.nodePath !== 'string' || !c.nodePath.startsWith('/') || !HASH.test(c.repositoryKey) || !HASH.test(c.pluginDigest)
      || typeof c.pluginVersion !== 'string' || c.pluginVersion === '' || c.requestId !== request.requestId
      || (request.operation !== 'start' && (c.runId !== request.runId || c.generation !== request.generation))
      || (request.operation !== 'start' && !exact(c.payload, [])) || (request.operation === 'start' && !exact(c.payload, ['configDigest', 'modelsDigest', 'supervisorProfile']))
      || e.schema !== 'autoloop.host-invocation/1' || e.invocationId !== request.invocationId || e.sessionId !== request.sessionId
      || !exact(e.host, ['pid', 'start', 'bootId']) || !positive(e.host.pid) || typeof e.host.start !== 'string' || e.host.start === ''
      || typeof e.host.bootId !== 'string' || e.host.bootId === '' || !Number.isSafeInteger(e.issuedAt) || !Number.isSafeInteger(e.expiresAt)
      || e.issuedAt > now || e.expiresAt <= now || e.expiresAt <= e.issuedAt || e.expiresAt - e.issuedAt > 10000
      || e.commandDigest !== await commandDigest(c)) throw refusal()
    return { command: c, envelope: e }
  }
  const invoke = async (host: DaemonHost, operation: DaemonOperation): Promise<string> => {
    const sessionId = await host.sessionId()
    const root = await host.root()
    const started = epoch
    if (!uuid(sessionId)) throw refusal()
    if (operation === 'attach') viewerSessions.add(sessionId)
    const key = canonical({ sessionId, root, operation })
    if (inFlight.has(key)) return `autoloop: ${operation} request pending`
    const callId = crypto.randomUUID()
    inFlight.set(key, callId)
    let request: HostRequest | null = null
    try {
      let target: { runId: string | null; generation: number | null } = { runId: null, generation: null }
      if (!['start', 'disconnect'].includes(operation)) {
        const projection = await host.read()
        target = projection?.attachment?.sessionId === sessionId && projection.execution !== undefined
          ? { runId: projection.execution.runId, generation: projection.execution.generation } : await discover(host, sessionId, root)
      }
      request = { schema: 'autoloop.host-request/1', route: ['attach', 'disconnect'].includes(operation) ? 'status' : 'loop',
        invocationId: crypto.randomUUID(), sessionId, root, operation,
        runId: target.runId, requestId: CONTROL_KINDS.some((kind) => kind === operation) ? crypto.randomUUID() : null, generation: target.generation }
      const helperArgv = ['node', `${host.pluginRoot}/tools/loop-host.mjs`]
      const helperInit = { stdin: JSON.stringify(request), timeoutMs: TIMEOUT_MS }
      pendingGestures.set(request.invocationId, { request, sessionId, root, epoch: started, expiresAt: (await host.now()) + TIMEOUT_MS,
        argv: helperArgv, init: helperInit, ending: false })
      const helper = await host.run(helperArgv, helperInit)
      if (helper.exitCode !== 0) { loopData(helper); throw refusal() }
      const handoff = await validateHandoff(host, request, parsed(helper.stdout))
      if (started !== epoch || sessionId !== await host.sessionId() || root !== await host.root()) throw refusal()
      const argv = backendArgv(handoff.command, sessionId)
      const init = { stdin: JSON.stringify(handoff.envelope), timeoutMs: TIMEOUT_MS }
      pendingGestures.set(request.invocationId, { request, sessionId, root, epoch: started, expiresAt: handoff.envelope.expiresAt, argv, init, ending: false })
      let data: Record<string, unknown>
      try {
        data = loopData(await host.run(argv, init))
      } catch (error) {
        // An unavailable answer can follow a durable write. Query the SAME UUID;
        // never automatically generate another submission or retarget it.
        if (error instanceof DaemonError && error.knownRefusal) throw error
        if (request.requestId === null || request.runId === null) throw error
        try {
          data = loopData(await host.run([handoff.command.nodePath, handoff.command.entrypoint, 'request-status', '--root', handoff.command.root,
            '--run', request.runId, '--request', request.requestId, '--json'], { timeoutMs: 2000 }))
        } catch { return `autoloop: ${operation} unknown · request ${request.requestId}` }
      }
      if (started !== epoch || sessionId !== await host.sessionId()) throw refusal()
      if (request.requestId !== null) {
        if (data['requestId'] !== request.requestId || data['runId'] !== request.runId) throw refusal('OUTCOME_UNKNOWN')
        return receiptText(operation, data)
      }
      if (operation === 'attach' || operation === 'disconnect') {
        if (data['sessionId'] !== sessionId || data['attached'] !== (operation === 'attach') || (operation === 'attach' && data['runId'] !== request.runId)) throw refusal('OUTCOME_UNKNOWN')
        if (operation === 'disconnect') { viewerSessions.delete(sessionId); await host.project(null) }
        const read = await readProjection((argv, init) => host.run(argv, init), host.pluginRoot, sessionId, null, root)
        if (started === epoch && sessionId === await host.sessionId() && read.ok) await host.project(read.projection)
        return `autoloop: ${operation === 'attach' ? 'attached' : 'disconnected'} · daemon unchanged`
      }
      return `autoloop: start ${String(data['state'] ?? 'unknown')}`
    } finally {
      if (request !== null) pendingGestures.delete(request.invocationId)
      if (inFlight.get(key) === callId) inFlight.delete(key)
    }
  }
  const safely = async (host: DaemonHost, operation: DaemonOperation) => {
    try { return await invoke(host, operation) }
    catch (error) { return `autoloop: ${error instanceof DaemonError ? error.message : 'OUTCOME_UNKNOWN: no verified daemon answer'}` }
  }
  const press = async (host: DaemonHost, e: UiPressArgument): Promise<boolean> => {
    const operations: Record<string, DaemonOperation> = { 'daemon-pause': 'pause', 'daemon-resume': 'resume',
      'daemon-stop': 'stop', 'daemon-stop-now': 'stop-now', 'daemon-disconnect': 'disconnect' }
    const operation = operations[e.element]
    if (operation === undefined) return false
    const projection = await host.read()
    if (e.plugin !== 'autoloop' || e.component !== 'Pane' || e.requestId !== 'autoloop' || e.link !== undefined
      || projection?.execution === undefined || projection.attachment?.sessionId !== await host.sessionId()
      || (operation !== 'disconnect' && !projection.execution.supportedControls.includes(operation as typeof CONTROL_KINDS[number]))) return true
    host.toast(await safely(host, operation))
    return true
  }
  return {
    guarded, admitProcess, press,
    reset: () => { epoch += 1; pendingGestures.clear(); inFlight.clear() },
    observe: (projection: StatusProjection | null) => {
      if (projection?.attachment?.kind === 'viewer') viewerSessions.add(projection.attachment.sessionId)
    },
    candidateText: async (host: DaemonHost): Promise<string | null> => {
      const sessionId = await host.sessionId()
      if (!uuid(sessionId)) return null
      try {
        const data = loopData(await host.run(['node', `${host.pluginRoot}/tools/status.mjs`, '--discover', '--session', sessionId,
          '--root', await host.root()], { timeoutMs: 2000 }))
        const candidate = data['candidate']
        if (candidate === null) return null
        if (data['attached'] !== false || !record(candidate) || !uuid(candidate['runId']) || !positive(candidate['generation'])
          || !['starting', 'running', 'paused', 'draining', 'recovering', 'stopped', 'failed'].includes(String(candidate['state']))
          || candidate['queueEnabled'] !== false) throw refusal('STATE_INVALID')
        return `autoloop: daemon ${String(candidate['state'])} · unattached · use /autoloop attach`
      } catch (error) { return `autoloop: discovery unavailable (${error instanceof DaemonError ? error.code : 'STATE_IO_FAILED'})` }
    },
    command: async (host: DaemonHost, e: CommandRunInput): Promise<{ text: string } | null> => {
      const operation: DaemonOperation | undefined = e.args.trim() === 'stop now' ? 'stop-now'
        : (['start', 'attach', 'disconnect', 'pause', 'resume', 'stop'].includes(e.args.trim()) ? e.args.trim() as DaemonOperation : undefined)
      if (operation === undefined) return null
      if (!['composer', 'bridge'].includes(e.origin.kind)) return { text: `autoloop: ${DENY}` }
      return { text: await safely(host, operation) }
    },
    end: async (host: DaemonHost, sessionId: string) => {
      const touched = viewerSessions.delete(sessionId)
      epoch += 1
      pendingGestures.clear()
      inFlight.clear()
      if (!uuid(sessionId)) return // Legacy records keep the legacy lifetime path.
      if (!touched && (await host.read())?.attachment?.sessionId !== sessionId) return
      const id = crypto.randomUUID()
      try {
        const root = await host.root()
        const argv = ['node', `${host.pluginRoot}/tools/status.mjs`, '--viewer-ended', '--session', sessionId, '--root', root]
        const init = { timeoutMs: 2000 }
        pendingGestures.set(id, { request: null, sessionId, root, epoch, expiresAt: (await host.now()) + 2000, argv, init, ending: true })
        await host.run(argv, init)
      }
      catch { host.log('autoloop: viewer lifetime revocation failed; no daemon operation was sent') }
      finally { pendingGestures.delete(id) }
    },
  }
}
