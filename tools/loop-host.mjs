#!/usr/bin/env node
// Private host handoff helper. A protected host gesture admits this process;
// direct Claude ancestry alone does not prove an operator gesture.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireScheduler, commitTransition, createPins, readCheckpoint, readCurrentCheckpoint, readProcessIdentity, releaseScheduler,
  resolveRepository, SchedulerError } from './scheduler-contract.mjs';
import { CONFIG_VERSION, resolveConfigText } from './config-contract.mjs';
import { DEFAULT_MODELS, mergeModels } from './models-config.mjs';
import { HOST_INVOCATION_MAX_AGE_MS, HOST_INVOCATION_SCHEMA, hostCommandDigest, hostInvocationPath, hostRuntimeRoot } from './loop-admission.mjs';
import { directViewerHost, prepareViewerCommand, privateDirectory, publishPrivateJson, readPrivateJson } from './loop-viewer.mjs';
import { parseLoopArgs, prepareLoopCommand } from './loop.mjs';
import { prepareStatusCommand } from './status.mjs';

const REQUEST_KEYS = ['schema', 'route', 'invocationId', 'sessionId', 'root', 'operation', 'runId', 'requestId', 'generation'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function requireHost(passed) {
  if (!passed) throw new SchedulerError('HOST_AUTH_REQUIRED', 'The host request is invalid.');
}
function uuid(value) { return typeof value === 'string' && UUID_RE.test(value); }
export function normalizeHostRequest(request) {
  requireHost(request !== null && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).sort().join('\0') === [...REQUEST_KEYS].sort().join('\0')
    && request.schema === 'autoloop.host-request/1' && uuid(request.invocationId) && uuid(request.sessionId)
    && typeof request.root === 'string' && request.root.startsWith('/')
    && ['start', 'attach', 'disconnect', 'pause', 'resume', 'stop', 'stop-now'].includes(request.operation));
  requireHost(['status', 'loop'].includes(request.route)
    && (['attach', 'disconnect'].includes(request.operation) ? request.route === 'status'
      : request.operation === 'start' ? request.route === 'loop' : true));
  const untargeted = ['start', 'disconnect'].includes(request.operation);
  requireHost(untargeted ? request.runId === null && request.requestId === null && request.generation === null
    : uuid(request.runId) && Number.isSafeInteger(request.generation) && request.generation > 0
      && (request.operation === 'attach' ? request.requestId === null : uuid(request.requestId)));
  if (['attach', 'disconnect'].includes(request.operation)) return prepareViewerCommand(request);
  if (request.route === 'status') return prepareStatusCommand({ control: true, root: request.root, session: request.sessionId,
    kind: request.operation, run: request.runId, request: request.requestId, generation: request.generation,
    pr: null, issue: null, dispatch: null, text: null });
  const argv = [request.operation === 'stop-now' ? 'stop' : request.operation,
    ...(request.operation === 'stop-now' ? ['--now'] : []), '--root', request.root, '--host-request', '--json'];
  if (!untargeted) argv.push('--run', request.runId, '--request', request.requestId, '--generation', String(request.generation));
  return prepareLoopCommand(parseLoopArgs(argv));
}
export function publishHostRequest(request) {
  const prepared = normalizeHostRequest(request);
  const host = directViewerHost();
  const checkpoint = readCurrentCheckpoint(prepared.repository);
  requireHost(!(checkpoint?.workers ?? []).some((worker) => worker.sessionId === request.sessionId
    || [worker.process.pid, worker.groupLeader.pid].includes(host.pid)));
  const issuedAt = Date.now();
  const envelope = { schema: HOST_INVOCATION_SCHEMA, invocationId: request.invocationId, sessionId: request.sessionId,
    commandDigest: hostCommandDigest(prepared.command), host, issuedAt, expiresAt: issuedAt + HOST_INVOCATION_MAX_AGE_MS };
  const runtime = hostRuntimeRoot();
  // The fixed OS account store cannot be redirected by HOME or caller arguments.
  for (const path of [dirname(dirname(runtime)), dirname(runtime), runtime]) privateDirectory(path, true);
  const receiptPath = hostInvocationPath(host, envelope.invocationId);
  privateDirectory(dirname(receiptPath), true);
  publishPrivateJson(receiptPath, envelope);
  return { command: prepared.command, envelope };
}

async function selfTest() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-host-')));
  console.error(`Retained test scratch: ${scratch}`);
  const root = join(scratch, 'repo');
  const accountHome = join(scratch, 'account');
  mkdirSync(accountHome, { mode: 0o700 });
  // Replace only the external OS-account location for the fake host and its
  // real backend children. Production still derives its fixed store itself.
  const preload = join(scratch, 'fixture-account.mjs');
  writeFileSync(preload, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
const account = os.userInfo;
os.userInfo = (...args) => ({ ...account(...args), homedir: ${JSON.stringify(accountHome)} });
os.homedir = () => ${JSON.stringify(accountHome)};
syncBuiltinESMExports();\n`);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', root], { timeout: 15000 }).status, 0);
  const repository = resolveRepository(root);
  const config = resolveConfigText(JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config;
  const pins = createPins(repository, { pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    enginePath: realpathSync(process.execPath), config, models: mergeModels(DEFAULT_MODELS) });
  const acquired = acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
  let checkpoint = readCheckpoint(repository, acquired.runId);
  commitTransition(acquired.lease, checkpoint.revision, (value) => ({ ...value, state: 'running' }));
  const failures = [];
  let cases = 0;
  const check = async (name, run) => {
    cases += 1;
    try { await run(); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const request = { schema: 'autoloop.host-request/1', route: 'status', invocationId: randomUUID(), sessionId: randomUUID(),
    root, operation: 'attach', runId: acquired.runId, requestId: null, generation: 1 };
  await check('private helper rejects caller-selected runtime, PID, path and digest', () => {
    for (const extra of [{ pid: process.pid }, { runtimeRoot: scratch }, { output: scratch }, { commandDigest: 'a'.repeat(64) }]) {
      assert.throws(() => normalizeHostRequest({ ...request, ...extra }), (error) => error.code === 'HOST_AUTH_REQUIRED');
    }
  });
  await check('route enum is mandatory and the route/operation matrix is closed', () => {
    const { route, ...missing } = request;
    for (const input of [missing, { ...request, route: 'arbitrary' }, { ...request, route: 'loop' }, { ...request, operation: 'cancel' },
      { ...request, route: 'status', operation: 'start', runId: null, generation: null }]) {
      assert.throws(() => normalizeHostRequest(input), (error) => error.code === 'HOST_AUTH_REQUIRED');
    }
  });
  await check('a helper called outside a direct Claude host cannot publish a receipt', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { input: JSON.stringify(request), encoding: 'utf8', timeout: 15000 });
    assert.equal(JSON.parse(result.stdout).error.code, 'HOST_AUTH_REQUIRED');
  });
  await check('private directories and receipt files reject links and loose modes', () => {
    const target = join(scratch, 'private');
    mkdirSync(target, { mode: 0o700 });
    const link = join(scratch, 'directory-link');
    symlinkSync(target, link);
    assert.throws(() => privateDirectory(link));
    chmodSync(target, 0o755);
    assert.throws(() => privateDirectory(target));
    chmodSync(target, 0o700);
    const file = join(target, 'loose.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    assert.throws(() => readPrivateJson(file));
    chmodSync(file, 0o600);
    symlinkSync(file, join(target, 'link.json'));
    assert.throws(() => readPrivateJson(join(target, 'link.json')));
  });
  const fakeClaude = join(scratch, 'claude');
  copyFileSync(realpathSync(process.execPath), fakeClaude);
  const hostScript = `import { spawn } from 'node:child_process';
    process.title = 'claude';
    const root = process.argv[1]; const plugin = process.argv[2]; const runId = process.argv[3]; const nodePath = process.argv[4];
    const { userInfo } = await import('node:os');
    const assert = (await import('node:assert/strict')).default;
    assert.equal(userInfo().homedir, process.argv[5], 'The external fixture host must use its temporary OS-account root before publishing receipts.');
    const { randomUUID } = await import('node:crypto');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const call = (argv, input = '') => new Promise((done, fail) => {
      const child = spawn(nodePath, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
      child.once('error', fail); child.once('close', (code) => {
        try { done({ code, json: JSON.parse(stdout), stderr }); } catch { fail(new Error('Invalid child answer: ' + stdout + stderr)); }
      });
      child.stdin.end(input);
    });
    const helper = async (operation, sessionId, fields = {}) => {
      const request = { schema: 'autoloop.host-request/1', route: ['attach', 'disconnect'].includes(operation) ? 'status' : 'loop',
        invocationId: randomUUID(), sessionId, root, operation,
        runId: ['disconnect', 'start'].includes(operation) ? null : runId,
        requestId: ['pause', 'resume', 'stop', 'stop-now'].includes(operation) ? randomUUID() : null,
        generation: ['disconnect', 'start'].includes(operation) ? null : 1, ...fields };
      return { request, result: await call([plugin + '/tools/loop-host.mjs'], JSON.stringify(request)) };
    };
    const backend = (prepared, sessionId, extra = []) => {
      const command = prepared.result.json.command;
      const envelope = prepared.result.json.envelope;
      const args = command.operation === 'attach' || command.operation === 'disconnect'
        ? [command.entrypoint, '--' + command.operation, '--session', sessionId, '--root', root,
          ...(command.runId === null ? [] : ['--run', command.runId]),
          ...(command.generation === null ? [] : ['--generation', String(command.generation)]), '--host-request', ...extra]
        : prepared.request.route === 'status'
          ? [command.entrypoint, '--control', '--session', sessionId, '--root', root, '--kind', command.operation,
            '--run', command.runId, '--request', command.requestId, '--generation', String(command.generation), '--host-request', ...extra]
        : [command.entrypoint, command.operation === 'stop-now' ? 'stop' : command.operation,
          ...(command.operation === 'stop-now' ? ['--now'] : []), '--root', root, '--run', command.runId,
          '--request', command.requestId, '--generation', String(command.generation), '--host-request', '--json', ...extra];
      return call(args, JSON.stringify(envelope));
    };
    const read = (sessionId, ...args) => call([plugin + '/tools/status.mjs', '--json', '--session', sessionId, '--root', root, ...args]);
    const s1 = randomUUID(); const s2 = randomUUID();
    const output = {};
    output.discovery = await call([plugin + '/tools/status.mjs', '--discover', '--session', s1, '--root', root]);
    output.unattached = await read(s1);
    const first = await helper('attach', s1);
    output.helper = first;
    if (first.result.json.command) {
      output.attach = await backend(first, s1);
      output.replay = await backend(first, s1);
      output.attached = await read(s1);
      output.unrelated = await read(randomUUID());
      output.second = await backend(await helper('attach', s2), s2);
      output.secondRead = await read(s2);
      const copied = await helper('attach', s1);
      output.substitutedSession = await backend(copied, s2);
      const changed = await helper('pause', s1);
      changed.result.json.envelope.commandDigest = '0'.repeat(64);
      output.substitutedDigest = await backend(changed, s1);
      const expired = await helper('pause', s1);
      expired.result.json.envelope.issuedAt -= 20000; expired.result.json.envelope.expiresAt -= 20000;
      output.expired = await backend(expired, s1);
      const wrongGeneration = await helper('pause', s1);
      const saved = wrongGeneration.result.json.command.generation;
      wrongGeneration.result.json.command.generation = saved + 1;
      output.wrongGeneration = await backend(wrongGeneration, s1);
      const pause = await helper('pause', s1);
      output.pause = await backend(pause, s1);
      const facade = await helper('resume', s1, { route: 'status' });
      output.facadeControl = await backend(facade, s1);
      const crossRoute = await helper('pause', s1);
      crossRoute.request.route = 'status';
      crossRoute.result.json.command.entrypoint = plugin + '/tools/status.mjs';
      output.crossRoute = await backend(crossRoute, s1);
      output.pendingProjection = await read(s1);
      output.pendingId = pause.request.requestId;
      const interrupted = await helper('attach', s1);
      output.ended = await call([plugin + '/tools/status.mjs', '--viewer-ended', '--session', s1, '--root', root]);
      output.lateAttach = await backend(interrupted, s1);
      output.oldRead = await read(s1);
      output.secondAfterEnd = await read(s2);
      await new Promise((done) => setTimeout(done, 3));
      output.reattach = await backend(await helper('attach', s1), s1);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(root + '/.autoloop', { mode: 0o700 });
      const cfg = await import(plugin + '/tools/config-contract.mjs');
      writeFileSync(root + '/.autoloop/config.json', JSON.stringify({ version: cfg.CONFIG_VERSION, baseBranch: 'main',
        gate: { command: 'node --version' }, ui: { status: false } }));
      output.disabled = await read(s1);
      output.disabledStop = await backend(await helper('stop-now', s1), s1);
      output.unsupported = [];
      for (const kind of ['cancel', 'answer', 'merge', 'label']) {
        output.unsupported.push(await call([plugin + '/tools/status.mjs', '--control', '--session', s1,
          '--root', root, '--run', runId, '--request', randomUUID(), '--kind', kind, '--host-request'], '{}'));
      }
      output.foreignSessionEnd = await call([plugin + '/tools/status.mjs', '--viewer-ended', '--session', randomUUID(), '--root', root]);
      output.ownAfterForeignEnd = await read(s1);
      output.disconnect = await backend(await helper('disconnect', s1), s1);
      output.disconnectAgain = await backend(await helper('disconnect', s1), s1);
      output.afterDisconnect = await read(s1);
    }
    process.send(output, () => process.disconnect());`;
  let hostResult;
  await check('real direct external host publishes a bound helper receipt and consumes it through status', async () => {
    const child = spawn(fakeClaude, ['--input-type=module', '-e', hostScript, root, pins.pluginRoot, acquired.runId, pins.nodePath, accountHome], {
      env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true,
    });
    const closed = new Promise((done) => child.once('close', done));
    try {
      hostResult = await new Promise((done, fail) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('External host timed out.')); }, 60000);
        let stderr = '';
        child.stderr.on('data', (chunk) => stderr += chunk);
        child.once('error', (error) => { clearTimeout(timeout); fail(error); });
        child.once('message', (value) => { clearTimeout(timeout); done(value); });
        child.once('close', (code) => { clearTimeout(timeout); fail(new Error('External host exited ' + code + ': ' + stderr)); });
      });
      await closed;
      assert.equal(hostResult.helper.result.code, 0, JSON.stringify(hostResult.helper.result));
      const envelope = hostResult.helper.result.json.envelope;
      const receiptPath = hostInvocationPath(envelope.host, envelope.invocationId, join(accountHome, '.claude', 'autoloop', 'host-invocations'));
      console.error(`Retained host receipts: ${dirname(receiptPath)}`);
      assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
      assert.deepEqual(readPrivateJson(receiptPath), envelope);
      assert.equal(hostResult.attach.json.data.attached, true);
      assert.equal(hostResult.attached.json.execution.mode, 'daemon');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
  if (hostResult?.attach) {
    await check('discovery, two viewers and unrelated sessions do not transfer execution authority', () => {
      assert.equal(hostResult.discovery.json.data.attached, false);
      assert.equal(hostResult.unattached.json.owned, false);
      assert.equal(hostResult.unrelated.json.owned, false);
      assert.equal(hostResult.secondRead.json.owned, true);
      assert.equal(hostResult.attached.json.execution.queueEnabled, false);
      assert.equal(hostResult.attached.json.unit, null);
    });
    await check('receipt replay, session/digest/generation substitution and expiry are refused', () => {
      for (const key of ['replay', 'substitutedSession', 'substitutedDigest', 'expired', 'wrongGeneration', 'crossRoute']) {
        assert.equal(hostResult[key].json.ok, false, key);
        assert(['HOST_AUTH_REQUIRED', 'TARGET_MISMATCH'].includes(hostResult[key].json.error.code), key);
      }
    });
    await check('daemon controls publish pending receipts, not applied success', () => {
      assert.equal(hostResult.pause.json.data.accepted, true);
      assert.equal(hostResult.pause.json.data.status, 'pending');
      assert.equal(hostResult.facadeControl.json.data.accepted, true);
      assert.equal(hostResult.facadeControl.json.data.status, 'pending');
      const receipt = hostResult.pendingProjection.json.controls.requests.find((entry) => entry.requestId === hostResult.pendingId);
      assert.equal(receipt.status, 'pending');
      assert.equal(receipt.outcome, null);
    });
    await check('end invalidates pending attach and old-session reopen while another viewer stays attached', () => {
      assert.equal(hostResult.ended.json.data.attached, false);
      assert.equal(hostResult.lateAttach.json.error.code, 'SESSION_ENDED');
      assert.equal(hostResult.oldRead.json.owned, false);
      assert.equal(hostResult.secondAfterEnd.json.owned, true);
      assert.equal(hostResult.reattach.json.data.attached, true);
      assert.equal(readCheckpoint(repository, acquired.runId).state, 'running');
    });
    await check('band-disabled explicit stop and unsupported facade controls remain truthful', () => {
      assert.equal(hostResult.disabled.json.enabled, false);
      assert.equal(hostResult.disabledStop.json.data.accepted, true);
      assert.equal(hostResult.disabledStop.json.data.status, 'pending');
      for (const answer of hostResult.unsupported) assert.equal(answer.json.error.code, 'UNSUPPORTED_ACTION');
      assert.equal(hostResult.ownAfterForeignEnd.json.owned, true);
    });
    await check('a non-Claude host cannot end another viewer or attach with copied input', () => {
      const answer = spawnSync(process.execPath, [join(pins.pluginRoot, 'tools', 'status.mjs'), '--viewer-ended',
        '--session', hostResult.helper.request.sessionId, '--root', root], { encoding: 'utf8', timeout: 15000 });
      assert.equal(JSON.parse(answer.stdout).error.code, 'HOST_AUTH_REQUIRED');
      const read = spawnSync(process.execPath, [join(pins.pluginRoot, 'tools', 'status.mjs'), '--json',
        '--session', hostResult.helper.request.sessionId, '--root', root], { encoding: 'utf8', timeout: 15000 });
      assert.equal(JSON.parse(read.stdout).owned, false);
    });
    await check('disconnect is idempotent and leaves daemon and other viewers unchanged', () => {
      assert.equal(hostResult.disconnect.json.data.attached, false);
      assert.equal(hostResult.disconnectAgain.json.data.attached, false);
      assert.equal(hostResult.afterDisconnect.json.owned, false);
      assert.equal(readCheckpoint(repository, acquired.runId).state, 'running');
    });
  }
  checkpoint = readCheckpoint(repository, acquired.runId);
  commitTransition(acquired.lease, checkpoint.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
  releaseScheduler(acquired.lease);
  console.log(failures.length ? `self-test FAILED (${failures.length}/${cases})` : `self-test OK (${cases} cases)`);
  return failures.length === 0;
}
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exit(await selfTest() ? 0 : 1);
  if (process.argv.length !== 2) {
    process.stdout.write(`${JSON.stringify({ schema: 'autoloop.loop/1', ok: false,
      error: { code: 'HOST_AUTH_REQUIRED', message: 'The helper invocation is invalid.' } })}\n`);
    process.exit(3);
  }
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    const result = publishHostRequest(JSON.parse(text));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: 'autoloop.loop/1', ok: false,
      error: { code: error instanceof SchedulerError ? error.code : 'HOST_AUTH_REQUIRED', message: 'The host request cannot be prepared.' } })}\n`);
    process.exitCode = 3;
  }
}
