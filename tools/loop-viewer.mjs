#!/usr/bin/env node
// Viewer bindings are display admission, never scheduler or worker authority.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireScheduler, boundGroupState, commitTransition, createPins, listControlRequests, readCheckpoint,
  readCurrentCheckpoint, readPins, readProcessIdentity, readRequest, readSchedulerOwner, registerWorker,
  releaseScheduler, resolveRepository, schedulerDigest, SchedulerError, submitControl, validateCheckpoint } from './scheduler-contract.mjs';
import { CONFIG_VERSION, resolveConfigText, resolveProjectConfig, statusBandEnabled } from './config-contract.mjs';
import { DEFAULT_MODELS, mergeModels } from './models-config.mjs';
import { LOOP_COMMAND_SCHEMA, validateLoopCommand } from './loop-admission.mjs';
import { isClaudeProcess, procEntry } from './run-markers.mjs';
import { appendEvent, readEvents } from './events-contract.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VIEWER_SCHEMA = 'autoloop.viewer/1';
export const SUPPORTED_CONTROLS = Object.freeze(['pause', 'resume', 'stop', 'stop-now']);
function requireCondition(passed, code, message) {
  if (!passed) throw new SchedulerError(code, message);
}
function uuid(value) { return typeof value === 'string' && UUID_RE.test(value); }
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function pathPresent(path) {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new SchedulerError('STATE_IO_FAILED', 'A viewer path cannot be read.');
  }
}
/** Private stores refuse links and loose modes. Check the opened descriptor too. */
export function privateDirectory(path, create = false) {
  const canonical = resolve(path);
  if (create) {
    try { mkdirSync(canonical, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new SchedulerError('STATE_IO_FAILED', 'A private directory cannot be created.'); }
  }
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    const named = lstatSync(canonical);
    requireCondition(info.isDirectory() && named.isDirectory() && info.ino === named.ino && info.dev === named.dev
      && realpathSync(canonical) === canonical && info.uid === userInfo().uid && (info.mode & 0o777) === 0o700,
    'STATE_INVALID', 'A private directory has unsafe identity or permissions.');
  } finally { closeSync(fd); }
  return canonical;
}
export function readPrivateJson(path) {
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireCondition(info.isFile() && info.uid === userInfo().uid && (info.mode & 0o777) === 0o600,
      'STATE_INVALID', 'A private file has unsafe identity or permissions.');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
/** Flush an exclusive regular file, then link it to its public immutable name. Retain scratch files. */
export function publishPrivateJson(path, value) {
  privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.publish-${randomUUID()}.json`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    requireCondition(fstatSync(fd).isFile() && (fstatSync(fd).mode & 0o777) === 0o600, 'STATE_INVALID', 'The private file mode is invalid.');
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  linkSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function directViewerHost() {
  const entry = procEntry(process.ppid);
  requireCondition(entry !== null && isClaudeProcess(entry[1], entry[2]), 'HOST_AUTH_REQUIRED', 'The direct viewer host cannot be verified.');
  return readProcessIdentity(process.ppid);
}
/** Normalizer for status.mjs attach/disconnect. Neither is a loop CLI verb. */
export function prepareViewerCommand({ operation, root, sessionId, runId = null, requestId = null, generation = null }) {
  requireCondition(['attach', 'disconnect'].includes(operation) && uuid(sessionId) && requestId === null,
    'INVALID_INPUT', 'The viewer command is invalid.');
  const repository = resolveRepository(root);
  let checkpoint = null;
  let pins;
  if (operation === 'attach') {
    requireCondition(uuid(runId), 'INVALID_INPUT', 'An explicit run ID is required.');
    checkpoint = readCurrentCheckpoint(repository);
    requireCondition(checkpoint?.runId === runId, 'RUN_MISMATCH', 'The viewer names another run.');
    requireCondition(generation === null || generation === checkpoint.generation, 'TARGET_MISMATCH', 'The viewer generation changed.');
    generation ??= checkpoint.generation;
    const stored = readPins(repository, runId);
    pins = createPins(repository, { pluginRoot: ROOT, enginePath: stored.enginePath, config: stored.config,
      models: stored.models, runId, supervisorProfile: stored.supervisorProfile });
    requireCondition(stored.pluginRoot === pins.pluginRoot && stored.pluginVersion === pins.pluginVersion
      && stored.pluginDigest === pins.pluginDigest && stored.nodePath === pins.nodePath,
    'PINS_CHANGED', 'The pinned viewer implementation changed.');
  } else {
    requireCondition(runId === null && generation === null, 'INVALID_INPUT', 'Disconnect does not select a run.');
    // Disconnect still works after the run ends or project settings become invalid.
    // These local values only let createPins verify the installed plugin identity.
    const config = resolveConfigText(JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config;
    pins = createPins(repository, { pluginRoot: ROOT, enginePath: process.execPath, config, models: mergeModels(DEFAULT_MODELS) });
  }
  const command = { schema: LOOP_COMMAND_SCHEMA, operation, root: repository.coordinatorRoot,
    repositoryKey: repository.repositoryKey, nodePath: realpathSync(process.execPath), entrypoint: realpathSync(join(ROOT, 'tools', 'status.mjs')),
    pluginRoot: ROOT, pluginVersion: pins.pluginVersion, pluginDigest: pins.pluginDigest,
    runId, requestId: null, generation, payload: {} };
  requireCondition(validateLoopCommand(command).length === 0, 'INVALID_INPUT', 'The normalized viewer command is invalid.');
  return { repository, checkpoint, command };
}
function bindingDirectory(repository, host, sessionId, create = false) {
  requireCondition(uuid(sessionId) && exactKeys(host, ['pid', 'start', 'bootId']), 'HOST_AUTH_REQUIRED', 'The viewer identity is invalid.');
  // Git admin ancestors can belong to legacy state. The new viewer store is private.
  for (const path of [repository.commonDir, join(repository.commonDir, 'autoloop')]) {
    if (!pathPresent(path)) {
      if (!create) return null;
      mkdirSync(path, { mode: 0o700 });
    }
    requireCondition(lstatSync(path).isDirectory() && realpathSync(path) === path, 'STATE_INVALID', 'The viewer ancestor is not a real directory.');
  }
  let directory = join(repository.commonDir, 'autoloop', 'viewers');
  for (const name of [null, `${host.pid}-${schedulerDigest(host)}`, sessionId]) {
    if (name !== null) directory = join(directory, name);
    if (!create && !pathPresent(directory)) return null;
    privateDirectory(directory, create);
  }
  return directory;
}
function latestBinding(repository, host, sessionId, create = false) {
  const directory = bindingDirectory(repository, host, sessionId, create);
  if (directory === null) return { directory, binding: null };
  const names = readdirSync(directory).filter((name) => /^\d{16}\.json$/u.test(name)).sort();
  let binding = null;
  for (const [index, name] of names.entries()) {
    requireCondition(Number(name.slice(0, 16)) === index + 1, 'STATE_INVALID', 'The viewer history has a missing revision.');
    const value = readPrivateJson(join(directory, name));
    requireCondition(exactKeys(value, ['schema', 'repositoryKey', 'sessionId', 'host', 'revision', 'runId', 'generation', 'attachedAt', 'closedAt'])
      && value.schema === VIEWER_SCHEMA && value.repositoryKey === repository.repositoryKey && value.sessionId === sessionId
      && schedulerDigest(value.host) === schedulerDigest(host) && value.revision === index + 1
      && (value.runId === null || uuid(value.runId)) && (value.generation === null || (Number.isSafeInteger(value.generation) && value.generation > 0))
      && (value.attachedAt === null || Number.isSafeInteger(value.attachedAt)) && (value.closedAt === null || Number.isSafeInteger(value.closedAt)),
    'STATE_INVALID', 'The viewer binding is invalid.');
    binding = value;
  }
  return { directory, binding };
}
/** Append-only revisions fence simultaneous attach/end operations without deleting a lock. */
function changeBinding(repository, host, sessionId, change) {
  for (;;) {
    const { directory, binding } = latestBinding(repository, host, sessionId, true);
    const updated = change(binding);
    if (updated === null) return binding;
    const value = { schema: VIEWER_SCHEMA, repositoryKey: repository.repositoryKey, sessionId, host,
      revision: (binding?.revision ?? 0) + 1, ...updated };
    try {
      publishPrivateJson(join(directory, `${String(value.revision).padStart(16, '0')}.json`), value);
      return value;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
export function attachViewer(repository, actor, runId, generation, issuedAt) {
  requireCondition(actor.kind === 'mod' && uuid(actor.sessionId) && Number.isSafeInteger(issuedAt), 'HOST_AUTH_REQUIRED', 'Viewer attachment requires host admission.');
  const binding = changeBinding(repository, actor.host, actor.sessionId, (current) => {
    requireCondition(current?.closedAt === null || current === null || issuedAt > current.closedAt,
      'SESSION_ENDED', 'This attachment was issued before the viewer ended.');
    if (current?.closedAt === null) {
      requireCondition(current.runId === runId, 'VIEWER_ATTACHED', 'Disconnect before attaching another run.');
      return null;
    }
    return { runId, generation, attachedAt: Date.now(), closedAt: null };
  });
  return { runId: binding.runId, sessionId: actor.sessionId, attached: true };
}
export function disconnectViewer(repository, actor) {
  requireCondition(actor.kind === 'mod' && uuid(actor.sessionId), 'HOST_AUTH_REQUIRED', 'Viewer disconnect requires host admission.');
  return endViewer(repository, actor.sessionId, actor.host);
}
/** Reduction only. Never admits a viewer or changes a daemon/checkpoint/control. */
export function endViewer(repository, sessionId, host = directViewerHost()) {
  const binding = changeBinding(repository, host, sessionId, (current) => current?.closedAt !== null && current !== null ? null
    : { runId: current?.runId ?? null, generation: current?.generation ?? null,
      attachedAt: current?.attachedAt ?? null, closedAt: Date.now() });
  return { runId: binding.runId, sessionId, attached: false };
}
export function readViewer(repository, sessionId) {
  if (!uuid(sessionId)) return null; // Legacy session IDs retain their existing predicate.
  let host;
  try { host = directViewerHost(); }
  catch (error) { if (error.code === 'HOST_AUTH_REQUIRED') return null; throw error; }
  const { binding } = latestBinding(repository, host, sessionId);
  return binding?.closedAt === null && binding.runId !== null ? binding : null;
}
function checkpointState(repository, checkpoint) {
  if (['stopped', 'failed'].includes(checkpoint.state)) return checkpoint.state;
  const owner = readSchedulerOwner(repository);
  return owner.state === 'alive' && owner.lease?.runId === checkpoint.runId
    && owner.lease.generation === checkpoint.generation ? checkpoint.state : 'recovering';
}
export function discoverViewer(repository) {
  const checkpoint = readCurrentCheckpoint(repository);
  return { candidate: checkpoint === null ? null : { runId: checkpoint.runId, generation: checkpoint.generation,
    state: checkpointState(repository, checkpoint), queueEnabled: false }, attached: false };
}
function readDaemonLog(repository, runId, logLimit) {
  let log = [];
  let eventLogError = null;
  try {
    for (const name of ['events.jsonl', 'events.1.jsonl']) {
      const path = join(repository.commonDir, 'autoloop', name);
      if (pathPresent(path)) requireCondition(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'EVENT_LOG_INVALID', 'The event history is not a regular file.');
    }
    const recorded = readEvents(repository.commonDir);
    log = recorded.events.filter((event) => event.run === runId).slice(-logLimit).reverse()
      .map(({ v, run, ...event }) => event);
    if (recorded.skipped > 0) eventLogError = 'EVENT_LOG_INVALID';
  } catch { eventLogError = 'EVENT_LOG_UNAVAILABLE'; }
  return { log, eventLogError };
}
export function daemonProjection(repository, checkpoint, viewer, { logLimit = 50 } = {}) {
  requireCondition(validateCheckpoint(checkpoint).length === 0, 'STATE_INVALID', 'The daemon checkpoint is invalid.');
  const state = checkpointState(repository, checkpoint);
  const config = resolveProjectConfig(repository.coordinatorRoot);
  const { log, eventLogError } = readDaemonLog(repository, checkpoint.runId, logLimit);
  const requestIds = new Set([...Object.keys(checkpoint.requests), ...listControlRequests(repository, checkpoint.runId)]);
  const requests = [...requestIds].sort().map((id) => readRequest(repository, checkpoint.runId, id));
  const dispatches = checkpoint.workers.map((worker) => {
    const observation = boundGroupState(worker);
    let dispatchState = 'unknown';
    if (observation === 'alive') dispatchState = 'running';
    else if (observation === 'empty') dispatchState = 'died';
    return { dispatch: worker.attemptId, issue: null, pr: null, role: worker.role, model: worker.actualModel,
      liveFile: worker.liveFile, pid: worker.process.pid, startedAtMs: 0,
      state: dispatchState, observation };
  });
  return { schema: 'autoloop.status/1', owned: true, enabled: statusBandEnabled(config?.ok ? config.config : null),
    run: { openedAtMs: checkpoint.createdAt, paused: checkpoint.desiredState === 'paused', parkedUntil: null,
      closedAt: checkpoint.stoppedAt === null ? null : new Date(checkpoint.stoppedAt).toISOString(), snapshotScannedAt: null, snapshotAuthority: 'none' },
    phases: [], unit: null, units: [], counts: { active: dispatches.filter((entry) => entry.state === 'running').length,
      waiting: dispatches.filter((entry) => entry.state === 'unknown').length, blocked: 0, delivered: 0, eligible: null }, models: {}, log, dispatches, controls: { refused: [], requests },
    execution: { mode: 'daemon', runId: checkpoint.runId, generation: checkpoint.generation, state, queueEnabled: false,
      lastCheckpointAt: checkpoint.updatedAt, eventLogError, supportedControls: [...SUPPORTED_CONTROLS] },
    attachment: { kind: 'viewer', sessionId: viewer.sessionId } };
}

// A real group leader retains its group after its registered worker exits.
// IPC orders registration before exit; all guard state stays in test scratch.
async function workerGroupFixture(repository, acquired, scratch, run) {
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    worker.once('spawn', () => process.send({ pid: worker.pid }));
    process.on('message', () => worker.kill('SIGTERM'));
    worker.once('close', () => process.send({ exited: true }));
    process.on('SIGTERM', () => { worker.kill('SIGTERM'); process.exit(0); });
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise((done) => leader.once('close', done));
  const message = () => new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('The fixture group did not respond.')), 5000);
    leader.once('message', (value) => { clearTimeout(timer); done(value); });
  });
  try {
    const { pid } = await message();
    const attemptId = '44444444-4444-4444-8444-444444444444';
    const worker = { schema: 'autoloop.worker-binding/1', runId: acquired.runId, generation: 1,
      unitId: '55555555-5555-4555-8555-555555555555', unitGeneration: 1, attemptId,
      sessionId: '66666666-6666-4666-8666-666666666666', worktreeGitDir: repository.commonDir,
      process: readProcessIdentity(pid), pgid: leader.pid, groupLeader: readProcessIdentity(leader.pid),
      role: 'implement', posture: 'writer', actualModel: 'external-fixture',
      liveFile: join(repository.commonDir, 'autoloop', 'scheduler', 'runs', acquired.runId, 'streams', `${attemptId}.jsonl`),
      cancelledByOperator: false };
    const checkpoint = registerWorker(acquired.lease, readCheckpoint(repository, acquired.runId).revision, worker,
      { guardDirectory: join(scratch, 'workers') });
    await run(checkpoint, async () => {
      const exited = message();
      leader.send({ exitWorker: true });
      assert.deepEqual(await exited, { exited: true });
    }, async () => { leader.kill('SIGTERM'); await closed; });
  } finally {
    leader.kill('SIGTERM');
    await closed;
  }
}

export async function daemonFixturesText() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-viewer-fixtures-')));
  console.error(`Retained test scratch: ${scratch}`);
  const root = join(scratch, 'repo');
  // Test Git-admin state must be private even with a group-writable host umask.
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', '--shared=0700', root], { timeout: 15000 }).status, 0);
  const originalClock = Date.now;
  Date.now = () => 1791849600000;
  try {
    const repository = resolveRepository(root);
    const config = resolveConfigText(JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config;
    const pins = createPins(repository, { runId: '22222222-2222-4222-8222-222222222222', pluginRoot: ROOT,
      enginePath: process.execPath, config, models: mergeModels(DEFAULT_MODELS) });
    const actor = { kind: 'terminal', sessionId: null, host: readProcessIdentity(), invocationId: randomUUID() };
    const acquired = acquireScheduler(repository, pins, { kind: actor.kind, sessionId: null, process: actor.host });
    const viewer = { sessionId: '11111111-1111-4111-8111-111111111111' };
    const lines = ['// Generated by tools/loop-viewer.mjs --fixtures from real scheduler state.'];
    let checkpoint = readCheckpoint(repository, acquired.runId);
    for (const state of ['running', 'paused', 'draining', 'recovering', 'failed', 'stopped']) {
      // Each fixture projects a schema-validated checkpoint. State selection is
      // test instrumentation, not phase-index completion or event reconstruction.
      const projected = daemonProjection(repository, { ...checkpoint, state,
        desiredState: state === 'paused' ? 'paused' : ['stopped', 'draining'].includes(state) ? 'stopped' : 'running',
        stoppedAt: state === 'stopped' ? Date.now() : null }, viewer);
      lines.push(`export const DAEMON_${state.toUpperCase()} = ${JSON.stringify(JSON.stringify(projected))};`);
    }
    const response = submitControl(repository, actor, { schema: 'autoloop.control/2', requestId: '33333333-3333-4333-8333-333333333333',
      runId: acquired.runId, kind: 'pause', target: { type: 'run', generation: 1 }, payload: {}, submittedAt: Date.now() });
    lines.push(`export const DAEMON_PENDING = ${JSON.stringify(JSON.stringify(daemonProjection(repository, checkpoint, viewer)))};`);
    lines.push(`export const DAEMON_ACCEPTED = ${JSON.stringify(JSON.stringify({ schema: 'autoloop.loop/1', ok: true, data: { ...response, accepted: true } }))};`);
    const prepared = prepareViewerCommand({ operation: 'attach', root, sessionId: viewer.sessionId, runId: acquired.runId, generation: 1 });
    // Logical host paths make the external-host fixtures portable. Tests bind
    // those paths to the test host's plugin/root before delivering the answer.
    const command = { ...prepared.command, root: '/fixture-repo', pluginRoot: '/fixture-plugin',
      repositoryKey: createHash('sha256').update('/fixture-repo/.git').digest('hex'),
      entrypoint: '/fixture-plugin/tools/status.mjs', nodePath: '/fixture-node', pluginDigest: 'a'.repeat(64) };
    lines.push(`export const DAEMON_HOST_COMMAND = ${JSON.stringify(JSON.stringify(command))};`);
    await workerGroupFixture(repository, acquired, scratch, async (bound, exitWorker, stopLeader) => {
      const fixture = (name) => {
        const projected = daemonProjection(repository, bound, viewer);
        // Replace only volatile OS/path fields, not state, counts or observations.
        projected.dispatches = projected.dispatches.map((entry) => ({ ...entry, pid: 123,
          liveFile: `/fixture-repo/.git/autoloop/scheduler/runs/${acquired.runId}/streams/${entry.dispatch}.jsonl` }));
        lines.push(`export const DAEMON_${name} = ${JSON.stringify(JSON.stringify(projected))};`);
      };
      fixture('RUNNING_GROUP');
      await exitWorker();
      fixture('UNKNOWN_GROUP');
      await stopLeader();
      fixture('EXITED_GROUP');
    });
    checkpoint = readCheckpoint(repository, acquired.runId);
    checkpoint = commitTransition(acquired.lease, checkpoint.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
    releaseScheduler(acquired.lease);
    return `${lines.join('\n')}\n`;
  } finally { Date.now = originalClock; }
}

async function selfTest() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-viewer-')));
  console.error(`Retained test scratch: ${scratch}`);
  const root = join(scratch, 'repo');
  // Test Git-admin state must be private even with a group-writable host umask.
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', '--shared=0700', root], { timeout: 15000 }).status, 0);
  const repository = resolveRepository(root);
  const config = resolveConfigText(JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config;
  const pins = createPins(repository, { pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    enginePath: realpathSync(process.execPath), config, models: mergeModels(DEFAULT_MODELS) });
  const acquired = acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
  const failures = [];
  let cases = 0;
  const check = async (name, run) => {
    cases += 1;
    try { await run(); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  };
  await check('viewer normalization uses status entrypoint and exact schema, not the loop parser', () => {
    const sessionId = randomUUID();
    const prepared = prepareViewerCommand({ operation: 'attach', root, sessionId, runId: acquired.runId,
      requestId: null, generation: 1 });
    assert.equal(prepared.command.entrypoint, realpathSync(join(pins.pluginRoot, 'tools', 'status.mjs')));
    assert.equal(prepared.command.operation, 'attach');
    assert.equal(prepared.command.runId, acquired.runId);
    assert.equal(prepared.command.generation, 1);
    assert.equal(prepared.command.root, repository.coordinatorRoot);
  });
  await check('discovery never creates a viewer and exposes only a candidate', () => {
    const result = discoverViewer(repository);
    assert.deepEqual(Object.keys(result).sort(), ['attached', 'candidate']);
    assert.equal(result.attached, false);
    assert.equal(result.candidate.runId, acquired.runId);
    assert.equal(result.candidate.queueEnabled, false);
  });
  await check('checkpoint projection retains truthful empty module and receipts without event authority', () => {
    let checkpoint = readCheckpoint(repository, acquired.runId);
    checkpoint = commitTransition(acquired.lease, checkpoint.revision, (value) => ({ ...value, state: 'paused', desiredState: 'paused' }));
    const projection = daemonProjection(repository, checkpoint, { sessionId: randomUUID() });
    assert.equal(projection.execution.state, 'paused');
    assert.equal(projection.execution.queueEnabled, false);
    assert.deepEqual(projection.execution.supportedControls, ['pause', 'resume', 'stop', 'stop-now']);
    assert.deepEqual(projection.units, []);
    assert.equal(projection.unit, null);
    assert.equal(projection.counts.delivered, 0);
    assert.deepEqual(projection.phases, []);
    assert.deepEqual(projection.controls.requests, []);
  });
  await check('rotated, forged-success and failed event history cannot remove a live registered worker', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const closed = new Promise((done) => child.once('close', done));
    try {
      const identity = readProcessIdentity(child.pid);
      const attemptId = randomUUID();
      const current = readCheckpoint(repository, acquired.runId);
      const worker = { schema: 'autoloop.worker-binding/1', runId: acquired.runId, generation: 1,
        unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: randomUUID(), worktreeGitDir: repository.commonDir,
        process: identity, pgid: child.pid, groupLeader: identity, role: 'implement', posture: 'writer', actualModel: 'external-fixture',
        liveFile: join(repository.commonDir, 'autoloop', 'scheduler', 'runs', acquired.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
      const checkpoint = registerWorker(acquired.lease, current.revision, worker, { guardDirectory: join(scratch, 'workers') });
      const viewer = { sessionId: randomUUID() };
      const before = daemonProjection(repository, checkpoint, viewer);
      assert.equal(before.dispatches[0].state, 'running');
      assert.equal(before.dispatches[0].observation, 'alive');
      const event = { v: 1, at: Date.now(), run: acquired.runId, kind: 'dispatch.end', by: 'dispatch', dispatch: attemptId, ok: true, ms: 1 };
      assert.equal(appendEvent(repository.commonDir, event, { maxBytes: 1 }).ok, true);
      assert.equal(appendEvent(repository.commonDir, { ...event, at: event.at + 1 }, { maxBytes: 1 }).ok, true);
      const rotated = daemonProjection(repository, checkpoint, viewer);
      assert.deepEqual(rotated.dispatches, before.dispatches);
      assert.equal(rotated.counts.delivered, 0);
      const events = join(repository.commonDir, 'autoloop', 'events.jsonl');
      renameSync(events, `${events}.retained`);
      symlinkSync(`${events}.retained`, events);
      const failedLog = daemonProjection(repository, checkpoint, viewer);
      assert.deepEqual(failedLog.dispatches, before.dispatches);
      assert.equal(failedLog.execution.eventLogError, 'EVENT_LOG_UNAVAILABLE');
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  });
  await check('a dead worker with a live group leader stays unknown and waiting until confirmed group exit', async () => {
    await workerGroupFixture(repository, acquired, scratch, async (checkpoint, exitWorker, stopLeader) => {
      const worker = checkpoint.workers.find((entry) => entry.attemptId === '44444444-4444-4444-8444-444444444444');
      const viewer = { sessionId: randomUUID() };
      assert.equal(boundGroupState(worker), 'alive');
      const before = daemonProjection(repository, checkpoint, viewer);
      assert.equal(before.dispatches.find((entry) => entry.dispatch === worker.attemptId).state, 'running');
      await exitWorker();
      assert.equal(boundGroupState(worker), 'unknown');
      const uncertain = daemonProjection(repository, checkpoint, viewer);
      const dispatch = uncertain.dispatches.find((entry) => entry.dispatch === worker.attemptId);
      assert.equal(dispatch.state, 'unknown');
      assert.equal(dispatch.observation, 'unknown');
      assert.equal(uncertain.counts.active, 0);
      assert.equal(uncertain.counts.waiting, 1);
      assert.equal(uncertain.execution.queueEnabled, false);
      assert.equal(uncertain.counts.delivered, 0);
      await stopLeader();
      assert.equal(boundGroupState(worker), 'empty');
      const exited = daemonProjection(repository, checkpoint, viewer);
      assert.equal(exited.dispatches.find((entry) => entry.dispatch === worker.attemptId).state, 'died');
      assert.equal(exited.counts.active, 0);
      assert.equal(exited.counts.waiting, 0);
    });
  });
  await check('daemon plugin fixtures are generated from the real producer contract', async () => {
    assert.equal(await daemonFixturesText(), readFileSync(join(ROOT, 'hooks', 'status', 'fixtures', 'daemon.ts'), 'utf8'));
  });
  let checkpoint = readCheckpoint(repository, acquired.runId);
  checkpoint = commitTransition(acquired.lease, checkpoint.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
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
  if (process.argv.length === 3 && process.argv[2] === '--fixtures') {
    process.stdout.write(await daemonFixturesText());
  } else {
    console.error('usage: loop-viewer.mjs --self-test | --fixtures');
    process.exit(2);
  }
}
