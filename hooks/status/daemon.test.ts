// Host API doubles use the real producer's daemon fixtures. No first-party
// normalizer, attachment store or control contract is replaced by a test double.
import { expect, test } from 'claude-code/testing'
import type { On, ProcessRunInit } from 'claude-code'
import { commandDigest } from './daemon'
import { DAEMON_ACCEPTED, DAEMON_HOST_COMMAND, DAEMON_PAUSED, DAEMON_RUNNING } from './fixtures/daemon'
import { autoloopCommand, band, buttons, pane, press, projection, ran, rows, seat, start } from './fixtures/testing'
import { phaseRow } from './view'

const SESSION = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const NOW = 1791849600000
function daemonHost(on: On, projectionText = DAEMON_RUNNING, options: { holdHelper?: boolean; failBackend?: boolean; refusal?: boolean; refusalCode?: string; alter?: string } = {}) {
  const calls: { argv: readonly string[]; init?: ProcessRunInit }[] = []
  let plugin = ''
  let helperStarted: (() => void) | null = null
  let finishHelper: (() => void) | null = null
  const started = new Promise<void>((done) => { helperStarted = done })
  const held = new Promise<void>((done) => { finishHelper = done })
  on('fs.stat', ($, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  const h = seat(on, { projection: projectionText, now: NOW, process: async (argv, init) => {
    if (argv[1]?.endsWith('/loop-host.mjs')) {
      calls.push({ argv, init })
      plugin = argv[1].slice(0, -'/tools/loop-host.mjs'.length)
      const request = JSON.parse(init?.stdin ?? '{}')
      helperStarted?.()
      if (options.holdHelper) await held
      const command = { ...JSON.parse(DAEMON_HOST_COMMAND), pluginRoot: plugin, root: request.root,
        operation: request.operation, runId: request.runId, requestId: request.requestId, generation: request.generation,
        entrypoint: `${plugin}/tools/${['attach', 'disconnect'].includes(request.operation) ? 'status' : 'loop'}.mjs` }
      if (options.alter === 'generation') command.generation += 1
      if (options.alter === 'run') command.runId = '44444444-4444-4444-8444-444444444444'
      if (options.alter === 'entrypoint') command.entrypoint = '/other/loop.mjs'
      const envelope = { schema: 'autoloop.host-invocation/1', invocationId: request.invocationId, sessionId: request.sessionId,
        commandDigest: await commandDigest(command), host: { pid: 123, start: 'host-start', bootId: 'host-boot' }, issuedAt: NOW, expiresAt: NOW + 10000 }
      if (options.alter === 'digest') envelope.commandDigest = '0'.repeat(64)
      if (options.alter === 'session') envelope.sessionId = '44444444-4444-4444-8444-444444444444'
      if (options.alter === 'expiry') envelope.expiresAt = NOW - 1
      return ran(JSON.stringify({ command, envelope }))
    }
    if (argv.includes('--discover')) {
      calls.push({ argv, init })
      return ran(JSON.stringify({ schema: 'autoloop.loop/1', ok: true, data: { attached: false,
        candidate: { runId: RUN, generation: 1, state: 'running', queueEnabled: false } } }))
    }
    if (argv.includes('--host-request')) {
      calls.push({ argv, init })
      if (options.failBackend) throw new Error('external host lost the result')
      if (options.refusal || options.refusalCode !== undefined) return ran(JSON.stringify({ schema: 'autoloop.loop/1', ok: false,
        error: { code: options.refusalCode ?? 'TARGET_MISMATCH', message: 'The target cannot be verified.' } }), 3)
      const envelope = JSON.parse(init?.stdin ?? '{}')
      if (argv.includes('--attach') || argv.includes('--disconnect')) return ran(JSON.stringify({ schema: 'autoloop.loop/1', ok: true,
        data: { runId: RUN, sessionId: envelope.sessionId, attached: argv.includes('--attach') } }))
      const data = JSON.parse(DAEMON_ACCEPTED)
      data.data.requestId = argv[argv.indexOf('--request') + 1]
      return ran(JSON.stringify(data))
    }
    if (argv[2] === 'request-status') {
      calls.push({ argv, init })
      const data = JSON.parse(DAEMON_ACCEPTED)
      data.data.requestId = argv[argv.indexOf('--request') + 1]
      delete data.data.accepted
      return ran(JSON.stringify(data))
    }
    if (argv.includes('--viewer-ended')) { calls.push({ argv, init }); return ran(JSON.stringify({ schema: 'autoloop.loop/1', ok: true, data: { runId: RUN, sessionId: SESSION, attached: false } })) }
    return undefined
  } })
  h.setSession(SESSION)
  return { ...h, calls, started, finish: () => finishHelper?.(), plugin: () => plugin }
}

test('daemon state is not idle, and an ordered phase does not prove review or gate success', () => {
  const p = projection(DAEMON_RUNNING)
  expect(phaseRow({ ...p, phases: ['plan', 'review', 'gate', 'deliver'], unit: { ...projection(DAEMON_PAUSED).unit!, phase: 'deliver' } })).toBeNull()
})

test('an unattached command discovers a candidate but does not attach or open a pane', async ($, on) => {
  const h = daemonHost(on, JSON.stringify({ schema: 'autoloop.status/1', owned: false }))
  await start($)
  const result = await autoloopCommand($, '')
  expect(result.text).toContain('daemon running')
  expect(result.text).toContain('/autoloop attach')
  expect(h.calls.some((call) => call.argv[1]?.endsWith('/loop-host.mjs'))).toBe(false)
  expect(h.opens).toEqual([])
})

test('a host-stamped command attaches through two direct calls, with the receipt only on stdin', async ($, on) => {
  const h = daemonHost(on)
  await start($)
  const result = await autoloopCommand($, 'attach')
  expect(result.text).toContain('attached')
  const helper = h.calls.find((call) => call.argv[1]?.endsWith('/loop-host.mjs'))!
  const backend = h.calls.find((call) => call.argv.includes('--host-request'))!
  expect(helper.argv.length).toBe(2)
  expect(JSON.parse(helper.init!.stdin!).sessionId).toBe(SESSION)
  expect(backend.argv[0]).toBe('/fixture-node')
  expect(backend.argv.includes('--attach')).toBe(true)
  expect(JSON.parse(backend.init!.stdin!).schema).toBe('autoloop.host-invocation/1')
  expect(result.text).not.toContain('commandDigest')
  expect(h.prompts).toEqual([])
})

test('SDK, plugin, scheduled, task and unclassified commands cannot create a gesture', async ($, on) => {
  const h = daemonHost(on)
  await start($)
  for (const origin of [{ kind: 'sdk' }, { kind: 'plugin', name: 'autoloop' }, { kind: 'scheduled-trigger' }, { kind: 'task-notification' }, { kind: 'unclassified' }] as const) {
    const result = await $.command.run({ command: 'autoloop', args: 'pause', origin, presentation: { isFullscreen: true, columns: 160 } })
    expect(result.text).toContain('HOST_AUTH_REQUIRED')
  }
  expect(h.calls).toEqual([])
})

test('daemon pause button uses an explicit host press, sends a pending request, and never wakes Claude', async ($, on) => {
  const h = daemonHost(on)
  await start($)
  await h.clock.advance(3000)
  const drawn = await pane($)
  expect(rows(drawn).join(' ')).toContain('daemon running')
  expect(buttons(drawn).some((button) => button.props.key === 'daemon-pause')).toBe(true)
  expect(buttons(drawn).some((button) => button.props.key === 'cancel')).toBe(false)
  await press($, 'daemon-pause')
  expect(h.toasts.join(' ')).toContain('accepted')
  expect(h.toasts.join(' ')).toContain('pending')
  expect(h.prompts).toEqual([])
})

test('closing the pane is not disconnect or stop; stop still works with ui.status false', async ($, on) => {
  const h = daemonHost(on, JSON.stringify({ ...projection(DAEMON_RUNNING), enabled: false }))
  await start($)
  await h.clock.advance(3000)
  await autoloopCommand($, 'close')
  expect(h.calls).toEqual([])
  const result = await autoloopCommand($, 'stop now')
  expect(result.text).toContain('accepted')
  const backend = h.calls.find((call) => call.argv.includes('--host-request'))!
  expect(backend.argv.includes('--now')).toBe(true)
  expect(h.prompts).toEqual([])
})

test('an explicit backend refusal remains refused and is not changed to an unknown request', async ($, on) => {
  const h = daemonHost(on, DAEMON_RUNNING, { refusal: true })
  await start($)
  const result = await autoloopCommand($, 'pause')
  expect(result.text).toContain('TARGET_MISMATCH')
  expect(h.calls.some((call) => call.argv[2] === 'request-status')).toBe(false)
})

for (const refusalCode of ['OUTCOME_UNKNOWN', 'STATE_IO_FAILED']) {
  test(`${refusalCode} queries the same durable request rather than inventing refusal`, async ($, on) => {
    const h = daemonHost(on, DAEMON_RUNNING, { refusalCode })
    await start($)
    const result = await autoloopCommand($, 'pause')
    expect(result.text).toContain('pending')
    const submitted = h.calls.find((call) => call.argv.includes('--host-request'))!
    const queried = h.calls.find((call) => call.argv[2] === 'request-status')!
    expect(queried.argv[queried.argv.indexOf('--request') + 1]).toBe(submitted.argv[submitted.argv.indexOf('--request') + 1])
  })
}

test('unknown daemon submission queries the same request UUID instead of resending', async ($, on) => {
  const h = daemonHost(on, DAEMON_RUNNING, { failBackend: true })
  await start($)
  const result = await autoloopCommand($, 'pause')
  expect(result.text).toContain('pending')
  const submitted = h.calls.find((call) => call.argv.includes('--host-request'))!
  const queried = h.calls.find((call) => call.argv[2] === 'request-status')!
  expect(queried.argv[queried.argv.indexOf('--request') + 1]).toBe(submitted.argv[submitted.argv.indexOf('--request') + 1])
  expect(h.calls.filter((call) => call.argv[1]?.endsWith('/loop-host.mjs')).length).toBe(1)
})

for (const alter of ['generation', 'run', 'entrypoint', 'digest', 'session', 'expiry']) {
  test(`helper ${alter} substitution is refused before backend execution`, async ($, on) => {
    const h = daemonHost(on, DAEMON_RUNNING, { alter })
    await start($)
    const result = await autoloopCommand($, 'pause')
    expect(result.text).toContain('HOST_AUTH_REQUIRED')
    expect(h.calls.some((call) => call.argv.includes('--host-request'))).toBe(false)
  })
}

test('two command presses while a handoff is pending do not create two requests', async ($, on) => {
  const h = daemonHost(on, DAEMON_RUNNING, { holdHelper: true })
  await start($)
  const first = autoloopCommand($, 'pause')
  await h.started
  const second = await autoloopCommand($, 'pause')
  expect(second.text).toContain('pending')
  h.finish()
  await first
  expect(h.calls.filter((call) => call.argv.includes('--host-request')).length).toBe(1)
})

test('clear during handoff consumes no backend permission and revokes only display lifetime', async ($, on) => {
  const h = daemonHost(on, DAEMON_RUNNING, { holdHelper: true })
  await start($)
  const first = autoloopCommand($, 'attach')
  await h.started
  h.setSession('44444444-4444-4444-8444-444444444444')
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { command: 'claude --resume fixture' } })
  h.finish()
  const result = await first
  expect(result.text).toContain('HOST_AUTH_REQUIRED')
  expect(h.calls.some((call) => call.argv.includes('--host-request'))).toBe(false)
  expect(h.calls.find((call) => call.argv.includes('--viewer-ended'))!.argv).toContain(SESSION)
  expect(h.held()?.last).toBeNull()
})

test('a process call without an unconsumed gesture is denied, even from a copied plugin path', async ($, on) => {
  daemonHost(on)
  await start($)
  let refused = false
  try { await $.process.run(['node', '/fixture-plugin/tools/loop-host.mjs'], { stdin: '{}', timeoutMs: 10000 }) }
  catch { refused = true }
  expect(refused).toBe(true)
})
