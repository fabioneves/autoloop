#!/usr/bin/env node
// Module 1 runtime: lifecycle and local controls only. No production queue,
// model dispatch or GitHub adapter is registered.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  abandonPreparedEffect, acquireScheduler, assertNoKnownLegacyOwner, boundGroupState, claimControl, commitTransition, completeControl, createPins, DEFAULT_SUPERVISOR_PROFILE,
  hasUnresolvedEffects as unresolvedEffects,
  listControlRequests, markEffectInFlight, prepareEffect, processGroupOf, processIdentityState,
  readCheckpoint, readCurrentCheckpoint, readPins, readProcessIdentity, readRequest, readSchedulerOwner,
  releaseScheduler, resolveRepository, schedulerDigest, SchedulerError, settleEffect, submitControl, registerWorker,
} from './scheduler-contract.mjs';
import { admitHostInvocation, admitOperatorTerminal, LOOP_COMMAND_SCHEMA } from './loop-admission.mjs';
import { CONFIG_VERSION, resolveConfigText, resolveProjectConfig } from './config-contract.mjs';
import { DEFAULT_MODELS, mergeModels, resolveModels } from './models-config.mjs';
import { readRegularFile } from './run-markers.mjs';

export const LOOP_SCHEMA = 'autoloop.loop/1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function requireCondition(passed, code, message) {
  if (!passed) throw new SchedulerError(code, message);
}
function uuid(value) { return typeof value === 'string' && UUID_RE.test(value); }
export function parseLoopArgs(argv) {
  const [verb, ...flags] = argv;
  requireCondition(['start', 'run', 'status', 'request-status', 'pause', 'resume', 'stop'].includes(verb),
    ['cancel', 'answer', 'merge', 'label'].includes(verb) ? 'UNSUPPORTED_ACTION' : 'INVALID_INPUT', 'The loop operation is not supported.');
  const out = { operation: verb, root: null, runId: null, requestId: null, generation: null,
    supervisorProfile: null, launchReceipt: null, json: false, operatorTerminal: false, hostRequest: false };
  const seen = new Set();
  let foreground = false;
  let supervised = false;
  let immediate = false;
  const valued = { '--root': 'root', '--run': 'runId', '--request': 'requestId', '--generation': 'generation',
    '--supervisor-profile': 'supervisorProfile', '--launch-receipt': 'launchReceipt' };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    requireCondition(!seen.has(flag), 'INVALID_INPUT', 'A loop option is repeated.');
    seen.add(flag);
    if (flag in valued) {
      const value = flags[++index];
      requireCondition(typeof value === 'string' && value !== '' && !value.startsWith('--'), 'INVALID_INPUT', 'A loop option needs a value.');
      out[valued[flag]] = value;
    } else if (flag === '--json') out.json = true;
    else if (flag === '--operator-terminal') out.operatorTerminal = true;
    else if (flag === '--host-request') out.hostRequest = true;
    else if (flag === '--foreground') foreground = true;
    else if (flag === '--supervised') supervised = true;
    else if (flag === '--now') immediate = true;
    else throw new SchedulerError('INVALID_INPUT', 'A loop option is not supported.');
  }
  requireCondition(out.root !== null, 'INVALID_INPUT', 'A repository root is required.');
  if (out.runId !== null) requireCondition(uuid(out.runId), 'INVALID_INPUT', 'The run ID is invalid.');
  if (out.requestId !== null) requireCondition(uuid(out.requestId), 'INVALID_INPUT', 'The request ID is invalid.');
  if (out.generation !== null) {
    requireCondition(/^[1-9]\d*$/u.test(out.generation) && Number.isSafeInteger(Number(out.generation)), 'INVALID_INPUT', 'The target generation is invalid.');
    out.generation = Number(out.generation);
  }
  if (verb === 'run') {
    requireCondition(foreground !== supervised, 'INVALID_INPUT', 'Choose explicit foreground or supervised execution.');
    out.operation = foreground ? 'foreground' : 'supervised';
  } else requireCondition(!foreground && !supervised, 'INVALID_INPUT', 'Execution mode applies only to run.');
  requireCondition(!immediate || verb === 'stop', 'INVALID_INPUT', 'Immediate stop applies only to stop.');
  if (immediate) out.operation = 'stop-now';
  if (['status', 'request-status'].includes(out.operation)) {
    requireCondition(!out.operatorTerminal && !out.hostRequest && out.supervisorProfile === null && out.launchReceipt === null,
      'INVALID_INPUT', 'A read-only command cannot use mutation options.');
  } else if (out.operation === 'supervised') {
    requireCondition(uuid(out.launchReceipt) && uuid(out.runId) && !out.operatorTerminal && !out.hostRequest,
      'HOST_AUTH_REQUIRED', 'Supervised execution requires a verified launch handoff.');
  } else {
    requireCondition(out.operatorTerminal !== out.hostRequest && out.launchReceipt === null,
      'HOST_AUTH_REQUIRED', 'An operator admission route is required.');
  }
  if (['pause', 'resume', 'stop', 'stop-now', 'request-status'].includes(out.operation)) requireCondition(uuid(out.runId) && uuid(out.requestId),
    'INVALID_INPUT', 'Run and request IDs are required.');
  return out;
}
export function loopStatus(repository) {
  const checkpoint = readCurrentCheckpoint(repository);
  if (checkpoint === null) return { state: 'absent' };
  const owner = readSchedulerOwner(repository);
  let state = checkpoint.state;
  if (!['stopped', 'failed'].includes(state) && owner.state !== 'alive') state = 'recovering';
  return { runId: checkpoint.runId, generation: checkpoint.generation, revision: checkpoint.revision, state,
    desiredState: checkpoint.desiredState, queueEnabled: false, ownerState: owner.state,
    owner: checkpoint.owner, error: checkpoint.error };
}

export { assertNoKnownLegacyOwner } from './scheduler-contract.mjs';
function liveWorkers(checkpoint) {
  return checkpoint.workers.filter((worker) => boundGroupState(worker) !== 'empty');
}
function reduceStop(value, mode) {
  const stopMode = value.stopMode === 'immediate' ? 'immediate' : mode;
  return { ...value, state: 'draining', desiredState: 'stopped', stopMode,
    workers: stopMode === 'immediate' ? value.workers.map((worker) => ({ ...worker, cancelledByOperator: true })) : value.workers };
}
export { boundGroupState } from './scheduler-contract.mjs';
function separateOwnedGroup(workerGroup, ownGroup) {
  return Number.isSafeInteger(ownGroup) && ownGroup > 0 && workerGroup > 1 && workerGroup !== ownGroup;
}
function signalBoundGroup(worker, signal) {
  requireCondition(separateOwnedGroup(worker.pgid, processGroupOf(process.pid)) && boundGroupState(worker) === 'alive',
    'OWNER_UNVERIFIED', 'The worker group cannot be verified for signalling.');
  process.kill(-worker.pgid, signal);
}
function cancellationId(runId, requestId, attemptId) {
  const bytes = schedulerDigest({ runId, requestId, attemptId, kind: 'process.cancel' }).slice(0, 32).split('');
  bytes[12] = '5';
  bytes[16] = '8';
  const text = bytes.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
function markRequestUnknown(context, requestId, code, operationId = null) {
  const current = readCheckpoint(context.repository, context.runId);
  const request = current.requests[requestId];
  commitTransition(context.lease, current.revision, (value) => ({ ...value, error: { code, message: 'The run retains work that needs reconciliation.' },
    requests: { ...value.requests, [requestId]: { ...request, status: 'unknown', outcome: {
      schema: 'autoloop.control-outcome/2', requestId, runId: context.runId, requestHash: request.requestHash,
      status: 'unknown', code, appliedRevision: null, operationId, completedAt: null,
    } } } }));
}
function emptyGroupReceipt(worker) {
  return { externalId: worker.attemptId, observationDigest: schedulerDigest({ process: worker.process,
    groupLeader: worker.groupLeader, pgid: worker.pgid, groupAlive: false }), observedAt: Date.now() };
}
function reconcileCancellationEffects(context) {
  let current = readCheckpoint(context.repository, context.runId);
  for (const effect of Object.values(current.outbox)) {
    if (effect.kind !== 'process.cancel' || !['prepared', 'in-flight', 'unknown'].includes(effect.phase)) continue;
    const worker = current.workers.find((value) => value.attemptId === effect.target.attemptId);
    const request = current.requests[effect.requestId];
    if (effect.phase === 'prepared' && !(worker?.cancelledByOperator && worker.unitId === effect.unitId
      && worker.unitGeneration === effect.unitGeneration && effect.attempt === 1 && request?.request.kind === 'stop-now'
      && ['processing', 'unknown'].includes(request.status) && current.desiredState === 'stopped' && current.stopMode === 'immediate'
      && request.request.target.generation === request.claimedGeneration)) continue;
    if (worker && boundGroupState(worker) === 'empty') {
      settleEffect(context.lease, effect.operationId, { attempt: effect.attempt, status: 'applied',
        code: effect.phase === 'prepared' ? 'GROUP_ALREADY_EXITED' : 'GROUP_EXIT_CONFIRMED', receipt: emptyGroupReceipt(worker) });
      current = readCheckpoint(context.repository, context.runId);
    }
  }
}
async function cancelWorkers(context, requestId) {
  let current = readCheckpoint(context.repository, context.runId);
  if (!(current.desiredState === 'stopped' && current.stopMode === 'immediate')) {
    current = commitTransition(context.lease, current.revision, (value) => reduceStop(value, 'immediate'));
  }
  for (const worker of current.workers) {
    const state = boundGroupState(worker);
    if (state === 'empty') continue;
    if (state === 'unknown') {
      markRequestUnknown(context, requestId, 'OWNER_UNVERIFIED');
      return;
    }
    const operationId = cancellationId(context.runId, requestId, worker.attemptId);
    current = readCheckpoint(context.repository, context.runId);
    const previous = current.outbox[operationId];
    if (previous && ['in-flight', 'unknown'].includes(previous.phase)) {
      markRequestUnknown(context, requestId, 'OUTCOME_UNKNOWN', operationId);
      return;
    }
    if (previous?.phase === 'succeeded') continue;
    const effect = { operationId, requestId, runId: context.runId, unitId: worker.unitId, unitGeneration: worker.unitGeneration,
      kind: 'process.cancel', target: { type: 'process', attemptId: worker.attemptId },
      inputDigest: schedulerDigest({ worker, signal: 'SIGTERM', escalation: 'SIGKILL' }), expectedHead: null,
      phase: 'prepared', attempt: 1, receipt: null, error: null };
    try {
      prepareEffect(context.lease, current.revision, effect);
      markEffectInFlight(context.lease, operationId);
      signalBoundGroup(worker, 'SIGTERM');
      const deadline = Date.now() + 10000;
      while (boundGroupState(worker) === 'alive' && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      if (boundGroupState(worker) === 'alive') signalBoundGroup(worker, 'SIGKILL');
      const settleDeadline = Date.now() + 5000;
      while (boundGroupState(worker) !== 'empty' && Date.now() < settleDeadline) {
        if (boundGroupState(worker) === 'unknown') break;
        await new Promise((done) => setTimeout(done, 25));
      }
      if (boundGroupState(worker) !== 'empty') {
        settleEffect(context.lease, operationId, { attempt: 1, status: 'unknown', code: 'OUTCOME_UNKNOWN', receipt: null });
        return;
      }
      settleEffect(context.lease, operationId, { attempt: 1, status: 'applied', code: 'GROUP_EXIT_CONFIRMED', receipt: emptyGroupReceipt(worker) });
    } catch (error) {
      const latest = readCheckpoint(context.repository, context.runId);
      if (['OWNER_UNVERIFIED', 'RECOVERY_REQUIRED', 'ESRCH'].includes(error.code) && boundGroupState(worker) === 'empty') {
        reconcileCancellationEffects(context);
        continue;
      }
      if (latest.outbox[operationId]?.phase === 'in-flight') settleEffect(context.lease, operationId,
        { attempt: 1, status: 'unknown', code: 'OUTCOME_UNKNOWN', receipt: null });
      else if (['OWNER_UNVERIFIED', 'RECOVERY_REQUIRED'].includes(error.code)) markRequestUnknown(context, requestId, 'OWNER_UNVERIFIED');
      else throw error;
      return;
    }
  }
  current = readCheckpoint(context.repository, context.runId);
  if (!['applied', 'refused', 'unknown'].includes(current.requests[requestId].status)) completeControl(context.lease, requestId,
    { status: 'applied', code: 'STOPPING_NOW', operationId: null });
}
function applyLocalControl(context, requestId) {
  const response = claimControl(context.lease, requestId);
  if (['applied', 'refused'].includes(response.status) || response.runId !== context.runId) return;
  const current = readCheckpoint(context.repository, context.runId);
  const request = current.requests[requestId];
  const kind = request.request.kind;
  const linked = Object.values(current.outbox).filter((effect) => effect.requestId === requestId);
  if (linked.some((effect) => ['prepared', 'in-flight', 'unknown'].includes(effect.phase))) return;
  if (kind === 'pause') {
    if (['draining', 'stopped', 'failed'].includes(current.state)) {
      completeControl(context.lease, requestId, { status: 'refused', code: 'RUN_ACTIVE', operationId: null });
      return;
    }
    completeControl(context.lease, requestId, { status: 'applied', code: 'PAUSED', operationId: null },
      (value) => ({ ...value, desiredState: 'paused', state: value.state === 'recovering' ? 'recovering' : 'paused' }));
    return;
  }
  if (kind === 'resume') {
    if (!(current.state === 'paused' || (current.state === 'recovering' && current.desiredState === 'paused'))) {
      completeControl(context.lease, requestId, { status: 'refused', code: 'RESUME_NOT_PAUSED', operationId: null });
      return;
    }
    completeControl(context.lease, requestId, { status: 'applied', code: 'RESUMED', operationId: null },
      (value) => ({ ...value, desiredState: 'running', state: value.state === 'recovering' ? 'recovering' : 'running' }));
    return;
  }
  if (kind === 'stop' || kind === 'stop-now') {
    const mode = kind === 'stop-now' ? 'immediate' : 'graceful';
    if (mode === 'immediate' && liveWorkers(current).length > 0) {
      // Old unknown cancellation intents need readback, not another signal.
      if (request.status === 'unknown') return;
      if (!context.cancellations.has(requestId)) {
        const pending = cancelWorkers(context, requestId).catch((error) => { context.failure = error; })
          .finally(() => context.cancellations.delete(requestId));
        context.cancellations.set(requestId, pending);
      }
      return;
    }
    completeControl(context.lease, requestId, { status: 'applied', code: mode === 'immediate' ? 'STOPPING_NOW' : 'DRAINING', operationId: null },
      (value) => reduceStop(value, mode));
  }
}
function observeRecovery(context) {
  const checkpoint = readCheckpoint(context.repository, context.runId);
  if (checkpoint.state !== 'recovering') return;
  const waiting = unresolvedEffects(checkpoint) || liveWorkers(checkpoint).some((worker) => worker.generation < context.generation);
  if (waiting) return;
  commitTransition(context.lease, checkpoint.revision, (value) => ({ ...value, state: value.desiredState === 'stopped'
    ? 'draining' : value.desiredState, error: null }));
}
function stoppedError(checkpoint, waitingGroup) {
  if (Object.values(checkpoint.outbox).some((effect) => ['in-flight', 'unknown'].includes(effect.phase))) {
    return { code: 'OUTCOME_UNKNOWN', message: 'The run stopped with effects that need readback.' };
  }
  if (unresolvedEffects(checkpoint)) return { code: 'PREPARED_INTENT_RETAINED', message: 'The run retains unstarted cancellation intent.' };
  if (waitingGroup) return { code: 'OWNER_UNVERIFIED', message: 'The run stopped with a group that needs readback.' };
  return checkpoint.error;
}
export async function runLoop({ repository, pins, initiator, tickMs = 1000, onReady = () => {} }) {
  requireCondition(Number.isSafeInteger(tickMs) && tickMs > 0, 'INVALID_INPUT', 'The control tick is invalid.');
  assertNoKnownLegacyOwner(repository);
  const acquired = acquireScheduler(repository, pins, initiator);
  const context = { repository, ...acquired, cancellations: new Map(), failure: null };
  let signalStop = false;
  const onSignal = () => { signalStop = true; };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    let checkpoint = readCheckpoint(repository, context.runId);
    if (checkpoint.state === 'starting') checkpoint = commitTransition(context.lease, checkpoint.revision,
      (value) => ({ ...value, state: 'running' }));
    observeRecovery(context);
    onReady({ runId: context.runId, generation: context.generation, state: readCheckpoint(repository, context.runId).state, queueEnabled: false });
    for (;;) {
      if (signalStop) {
        signalStop = false;
        checkpoint = readCheckpoint(repository, context.runId);
        if (checkpoint.desiredState !== 'stopped') commitTransition(context.lease, checkpoint.revision, (value) => reduceStop(value, 'graceful'));
      }
      for (const requestId of listControlRequests(repository)) applyLocalControl(context, requestId);
      reconcileCancellationEffects(context);
      checkpoint = readCheckpoint(repository, context.runId);
      if (checkpoint.desiredState === 'stopped') {
        for (const effect of Object.values(checkpoint.outbox)) {
          if (effect.phase === 'prepared' && effect.kind !== 'process.cancel') abandonPreparedEffect(context.lease, effect.operationId);
        }
      }
      if (context.failure) throw context.failure;
      observeRecovery(context);
      checkpoint = readCheckpoint(repository, context.runId);
      const waitingCancellation = checkpoint.stopMode === 'immediate' && Object.values(checkpoint.requests)
        .some((request) => request.request.kind === 'stop-now' && request.status === 'unknown');
      const retained = liveWorkers(checkpoint);
      const waitingGroup = checkpoint.stopMode === 'graceful' && retained.length > 0
        && retained.every((worker) => boundGroupState(worker) === 'unknown');
      if (checkpoint.desiredState === 'stopped' && context.cancellations.size === 0
        && (retained.length === 0 || waitingCancellation || waitingGroup)) {
        if (checkpoint.state !== 'stopped') checkpoint = commitTransition(context.lease, checkpoint.revision, (value) => ({ ...value,
          state: 'stopped', desiredState: 'stopped', error: stoppedError(value, waitingGroup) }));
        releaseScheduler(context.lease);
        return { exitCode: 0, runId: context.runId, generation: context.generation, state: 'stopped' };
      }
      await new Promise((done) => setTimeout(done, tickMs));
    }
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

function configuredEngine() {
  for (const entry of String(process.env.PATH ?? '').split(':')) {
    const candidate = join(entry, 'claude');
    try {
      if (lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink()) return realpathSync(candidate);
    } catch { /* next path */ }
  }
  throw new SchedulerError('INVALID_INPUT', 'The pinned Claude executable is not available.');
}
function selectedProfile(path) {
  if (path === null) return DEFAULT_SUPERVISOR_PROFILE;
  let value;
  try { value = JSON.parse(readRegularFile(realpathSync(resolve(path)))); }
  catch { throw new SchedulerError('INVALID_INPUT', 'The supervisor profile cannot be read.'); }
  requireCondition(value?.schema === 'autoloop.supervisor-profile/1'
    && Object.keys(value).sort().join(',') === 'memoryMaxBytes,memorySwapMaxBytes,schema,tasksMax',
  'INVALID_INPUT', 'The supervisor profile is invalid.');
  const { schema, ...profile } = value;
  return profile;
}
export function prepareLoopCommand(options) {
  const repository = resolveRepository(options.root);
  let stored = null;
  try { stored = readCurrentCheckpoint(repository); }
  catch (error) {
    if (error.code !== 'RECOVERY_REQUIRED') throw error;
    const owner = readSchedulerOwner(repository);
    if (owner.lease) stored = { runId: owner.lease.runId, generation: owner.lease.generation, state: 'recovering' };
  }
  const launching = ['start', 'foreground'].includes(options.operation);
  const recovering = launching && stored && (stored.state !== 'stopped'
    || (stored.workers ?? []).some((worker) => boundGroupState(worker) !== 'empty')
    || unresolvedEffects(stored)
    || listControlRequests(repository, stored.runId).length > 0);
  let pins;
  if (recovering) pins = readPins(repository, stored.runId);
  else if (!launching) {
    requireCondition(stored && stored.runId === options.runId, 'RUN_MISMATCH', 'The command names another run.');
    const original = readPins(repository, stored.runId);
    pins = createPins(repository, { pluginRoot: ROOT, enginePath: original.enginePath, config: original.config,
      models: original.models, runId: original.runId, supervisorProfile: original.supervisorProfile });
  } else {
    const config = resolveProjectConfig(repository.coordinatorRoot);
    requireCondition(config?.ok, 'INVALID_INPUT', 'The repository configuration is not available.');
    const models = resolveModels({ projectModels: config.config.models, create: false });
    requireCondition(models.ok, 'INVALID_INPUT', 'The configured model routes are invalid.');
    pins = createPins(repository, { pluginRoot: ROOT, enginePath: configuredEngine(), config: config.config,
      models: models.models, supervisorProfile: selectedProfile(options.supervisorProfile) });
  }
  const launchIdentity = recovering ? stored : null;
  const command = { schema: LOOP_COMMAND_SCHEMA, operation: options.operation, root: repository.coordinatorRoot,
    repositoryKey: repository.repositoryKey, nodePath: realpathSync(process.execPath), entrypoint: realpathSync(fileURLToPath(import.meta.url)),
    pluginRoot: ROOT, pluginVersion: pins.pluginVersion, pluginDigest: pins.pluginDigest,
    runId: launching ? launchIdentity?.runId ?? null : options.runId, requestId: launching ? null : options.requestId,
    generation: launching ? launchIdentity?.generation ?? null : options.generation ?? stored?.generation ?? null,
    payload: launching ? { configDigest: pins.configDigest, modelsDigest: pins.modelsDigest, supervisorProfile: pins.supervisorProfile } : {} };
  return { repository, pins, command };
}
async function stdinEnvelope() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text); }
  catch { throw new SchedulerError('HOST_AUTH_REQUIRED', 'The host envelope is invalid.'); }
}
export async function executeLoopCommand(options) {
  const repository = resolveRepository(options.root);
  if (options.operation === 'status') return loopStatus(repository);
  if (options.operation === 'request-status') return readRequest(repository, options.runId, options.requestId);
  if (options.operation === 'supervised') {
    const { verifySupervisedLaunch } = await import('./loop-supervisor.mjs');
    const context = await verifySupervisedLaunch({ repository, runId: options.runId, launchReceipt: options.launchReceipt });
    return runLoop(context);
  }
  const prepared = prepareLoopCommand(options);
  const actor = options.hostRequest ? await admitHostInvocation(prepared.command, await stdinEnvelope())
    : await admitOperatorTerminal(prepared.command);
  if (options.operation === 'start') {
    const { startSupervised } = await import('./loop-supervisor.mjs');
    return startSupervised({ repository: prepared.repository, pins: prepared.pins,
      initiator: { kind: actor.kind, sessionId: actor.sessionId, process: actor.host } });
  }
  if (options.operation === 'foreground') return runLoop({ repository: prepared.repository, pins: prepared.pins,
    initiator: { kind: actor.kind, sessionId: actor.sessionId, process: actor.host },
    onReady: (data) => process.stdout.write(`${JSON.stringify({ schema: LOOP_SCHEMA, ok: true, data })}\n`) });
  const request = { schema: 'autoloop.control/2', requestId: options.requestId, runId: options.runId,
    kind: options.operation, target: { type: 'run', generation: prepared.command.generation }, payload: {}, submittedAt: Date.now() };
  return { ...submitControl(prepared.repository, actor, request), accepted: true };
}
function errorExit(code) {
  if (code === 'INVALID_INPUT') return 2;
  if (['SUPERVISOR_UNAVAILABLE', 'READINESS_FAILED'].includes(code)) return 4;
  if (['STATE_IO_FAILED', 'STATE_INVALID', 'RECOVERY_REQUIRED'].includes(code)) return 5;
  return 3;
}

async function selfTest() {
  const results = [];
  const check = async (name, run) => {
    try { await run(); results.push([name, true]); }
    catch (error) { results.push([name, false]); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-runtime-')));
  const registerFixtureWorker = (lease, revision, binding) => registerWorker(lease, revision, binding, { guardDirectory: join(scratch, 'workers') });
  try {
    const root = join(scratch, 'repo');
    const git = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8', timeout: 15000 });
    assert.equal(git.status, 0, git.stderr);
    const repository = resolveRepository(root);
    await check('status is a pure read and absent state is not created', () => {
      assert.deepEqual(loopStatus(repository), { state: 'absent' });
      assert.equal(existsSync(join(repository.commonDir, 'autoloop')), false);
    });
    await check('argument parsing distinguishes read-only, admitted foreground and unsupported actions', () => {
      assert.equal(parseLoopArgs(['status', '--root', root, '--json']).operation, 'status');
      assert.equal(parseLoopArgs(['run', '--foreground', '--root', root, '--operator-terminal']).operation, 'foreground');
      assert.equal(parseLoopArgs(['stop', '--now', '--root', root, '--run', randomUUID(), '--request', randomUUID(), '--host-request']).operation, 'stop-now');
      assert.throws(() => parseLoopArgs(['start', '--root', root]), (error) => error.code === 'HOST_AUTH_REQUIRED');
      assert.throws(() => parseLoopArgs(['run', '--supervised', '--root', root]), (error) => error.code === 'HOST_AUTH_REQUIRED');
      assert.throws(() => parseLoopArgs(['merge', '--root', root]), (error) => error.code === 'UNSUPPORTED_ACTION');
      assert.equal(reduceStop({ stopMode: 'immediate', workers: [] }, 'graceful').stopMode, 'immediate');
    });
    await check('an unknown daemon group cannot admit a worker-group signal', () => {
      assert.equal(separateOwnedGroup(123, null), false);
      assert.equal(separateOwnedGroup(123, 123), false);
      assert.equal(separateOwnedGroup(1, 456), false);
      assert.equal(separateOwnedGroup(123, 456), true);
    });
    const fixture = () => {
      const home = join(scratch, randomUUID());
      mkdirSync(home);
      const checkout = join(home, 'repo');
      assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', checkout], { encoding: 'utf8', timeout: 15000 }).status, 0);
      const repository = resolveRepository(checkout);
      const config = resolveConfigText(JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config;
      const pins = createPins(repository, { pluginRoot: ROOT, enginePath: realpathSync(process.execPath), config, models: mergeModels(DEFAULT_MODELS) });
      return { home, repository, pins };
    };
    const actor = () => ({ kind: 'terminal', sessionId: null, host: readProcessIdentity(), invocationId: randomUUID() });
    const control = (runId, kind, generation = 1) => ({ schema: 'autoloop.control/2', requestId: randomUUID(), runId,
      kind, target: { type: 'run', generation }, payload: {}, submittedAt: Date.now() });
    const waitFor = async (predicate, message) => {
      const deadline = Date.now() + 15000;
      while (!predicate()) {
        assert(Date.now() < deadline, message);
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    const children = new Set();
    const startRuntime = async ({ repository, pins }) => {
      const script = `const api = await import(process.argv[1]); const core = await import(process.argv[2]);
        const root = process.argv[3]; const pins = JSON.parse(process.argv[4]);
        process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
        const result = await api.runLoop({ repository: core.resolveRepository(root), pins,
          initiator: { kind: 'terminal', sessionId: null, process: core.readProcessIdentity() }, tickMs: 25,
          onReady: (value) => process.send({ ready: true, ...value }) });
        process.exit(result.exitCode);`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, import.meta.url,
        new URL('./scheduler-contract.mjs', import.meta.url).href, repository.coordinatorRoot, JSON.stringify(pins)], {
        cwd: repository.coordinatorRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.identity = readProcessIdentity(child.pid);
      child.errors = '';
      child.stderr.on('data', (chunk) => { child.errors += chunk; });
      child.closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
      children.add(child);
      child.closed.then(() => children.delete(child));
      const ready = await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('Runtime readiness timed out.')), 15000);
        child.once('message', (value) => { clearTimeout(timer); done(value); });
        child.closed.then(({ code, signal }) => { clearTimeout(timer); fail(new Error(`Runtime ended: ${code ?? signal} ${child.errors}`)); });
      });
      assert.equal(ready.ready, true);
      return child;
    };
    try {
      await check('public status is pure, nonterminal mutations fail closed, and real terminal foreground is admitted', async () => {
        const setup = fixture();
        const entry = fileURLToPath(import.meta.url);
        const invoke = (args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', input: '', timeout: 15000 });
        const status = invoke(['status', '--root', setup.repository.coordinatorRoot, '--json']);
        assert.equal(status.status, 0, status.stderr);
        assert.equal(JSON.parse(status.stdout).data.state, 'absent');
        assert.equal(existsSync(join(setup.repository.commonDir, 'autoloop')), false);
        mkdirSync(join(setup.repository.coordinatorRoot, '.autoloop'));
        writeFileSync(join(setup.repository.coordinatorRoot, '.autoloop', 'config.json'), JSON.stringify(setup.pins.config));
        const bin = join(setup.home, 'bin');
        mkdirSync(bin);
        symlinkSync(process.execPath, join(bin, 'claude'));
        const path = `${bin}:${process.env.PATH ?? ''}`;
        for (const route of ['--operator-terminal', '--host-request']) {
          const refused = spawnSync(process.execPath, [entry, 'run', '--foreground', '--root', setup.repository.coordinatorRoot, route],
            { encoding: 'utf8', input: '', timeout: 15000, env: { ...process.env, PATH: path } });
          assert.equal(refused.status, 3);
          assert.equal(JSON.parse(refused.stdout).error.code, 'HOST_AUTH_REQUIRED');
          assert.equal(existsSync(join(setup.repository.commonDir, 'autoloop')), false);
        }
        const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
        const argv = [process.execPath, entry, 'run', '--foreground', '--root', setup.repository.coordinatorRoot, '--operator-terminal'];
        const args = process.platform === 'darwin' ? ['-q', join(setup.home, 'terminal.log'), ...argv]
          : ['-q', '-e', '-c', argv.map(quote).join(' '), join(setup.home, 'terminal.log')];
        const terminal = spawn('script', args, { env: { ...process.env, PATH: path }, stdio: ['pipe', 'pipe', 'pipe'] });
        terminal.identity = readProcessIdentity(terminal.pid);
        terminal.closed = new Promise((done) => terminal.once('close', (code) => done({ code })));
        children.add(terminal);
        terminal.closed.then(() => children.delete(terminal));
        let output = '';
        terminal.stdout.on('data', (chunk) => { output += chunk; });
        await waitFor(() => output.includes('Type yes'), 'Terminal confirmation was not requested.');
        terminal.stdin.write('yes\n');
        await waitFor(() => output.includes('"queueEnabled":false'), 'Admitted foreground was not ready.');
        const checkpoint = readCurrentCheckpoint(setup.repository);
        assert.equal(checkpoint.initiator.kind, 'terminal');
        const stop = control(checkpoint.runId, 'stop', checkpoint.generation);
        submitControl(setup.repository, actor(), stop);
        assert.equal((await terminal.closed).code, 0);
        assert.equal(readCheckpoint(setup.repository, checkpoint.runId).state, 'stopped');
      });
      await check('broken legacy ownership links are not treated as absent state', () => {
        const setup = fixture();
        assert.doesNotThrow(() => assertNoKnownLegacyOwner(setup.repository));
        const alias = join(setup.home, 'checkout-alias');
        symlinkSync(setup.repository.coordinatorRoot, alias, 'dir');
        assert.doesNotThrow(() => assertNoKnownLegacyOwner(resolveRepository(alias)));
        mkdirSync(join(setup.repository.commonDir, 'autoloop'), { mode: 0o700 });
        symlinkSync(join(setup.home, 'missing-owner-directory'), join(setup.repository.commonDir, 'autoloop', 'run'));
        assert.throws(() => assertNoKnownLegacyOwner(setup.repository), (error) => error.code === 'LEGACY_RUN_ACTIVE');
        assert.throws(() => assertNoKnownLegacyOwner(resolveRepository(alias)), (error) => error.code === 'LEGACY_RUN_ACTIVE');
      });
      await check('a known live legacy Claude owner refuses runtime acquisition across its common directory', async () => {
        const setup = fixture();
        const executable = join(setup.home, 'claude');
        copyFileSync(process.execPath, executable);
        const legacy = spawn(executable, ['-e', "process.on('disconnect', () => process.exit(0)); setInterval(() => {}, 1000); process.send({ready:true});"],
          { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        legacy.identity = readProcessIdentity(legacy.pid);
        legacy.closed = new Promise((done) => legacy.once('close', done));
        children.add(legacy);
        legacy.closed.then(() => children.delete(legacy));
        await new Promise((done) => legacy.once('message', done));
        const directory = join(setup.repository.commonDir, 'autoloop', 'run');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'legacy.json'), JSON.stringify({ version: 1, pids: [legacy.pid], starts: { [legacy.pid]: legacy.identity.start } }));
        await assert.rejects(runLoop({ ...setup, initiator: { kind: 'terminal', sessionId: null, process: readProcessIdentity() } }),
          (error) => error.code === 'LEGACY_RUN_ACTIVE');
        assert.equal(existsSync(join(setup.repository.commonDir, 'autoloop', 'scheduler')), false);
        legacy.kill('SIGTERM');
        await legacy.closed;
      });
      await check('a real foreground runtime applies pause/resume and drains a stopped run', async () => {
        const setup = fixture();
        const child = await startRuntime(setup);
        assert.equal(readCheckpoint(setup.repository, setup.pins.runId).state, 'running');
        for (const [kind, state] of [['pause', 'paused'], ['resume', 'running']]) {
          const request = control(setup.pins.runId, kind);
          submitControl(setup.repository, actor(), request);
          await waitFor(() => readRequest(setup.repository, setup.pins.runId, request.requestId).status === 'applied', 'Control was not applied.');
          assert.equal(readCheckpoint(setup.repository, setup.pins.runId).state, state);
        }
        const stop = control(setup.pins.runId, 'stop');
        submitControl(setup.repository, actor(), stop);
        assert.equal((await child.closed).code, 0);
        assert.equal(readCheckpoint(setup.repository, setup.pins.runId).state, 'stopped');
        assert.equal(readRequest(setup.repository, setup.pins.runId, stop.requestId).status, 'applied');
        assert.equal(readSchedulerOwner(setup.repository).state, 'released');
      });
      await check('graceful stop keeps polling while a real long-running group drains', async () => {
        const setup = fixture();
        const worker = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit(0)); process.on('message', () => process.exit(0)); setInterval(() => {}, 1000);"], {
          detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        worker.identity = readProcessIdentity(worker.pid);
        worker.closed = new Promise((done) => worker.once('close', done));
        children.add(worker);
        worker.closed.then(() => children.delete(worker));
        const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        const attemptId = randomUUID();
        registerFixtureWorker(owner.lease, 1, { schema: 'autoloop.worker-binding/1', runId: setup.pins.runId, generation: 1,
          unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir,
          process: worker.identity, pgid: worker.pid, groupLeader: worker.identity, role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
          liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false });
        commitTransition(owner.lease, 2, (value) => ({ ...value, state: 'failed' }));
        releaseScheduler(owner.lease);
        const runtime = await startRuntime(setup);
        const stop = control(setup.pins.runId, 'stop', 2);
        submitControl(setup.repository, actor(), stop);
        await waitFor(() => readRequest(setup.repository, setup.pins.runId, stop.requestId).status === 'applied', 'Graceful stop was not consumed.');
        const pause = control(setup.pins.runId, 'pause', 2);
        submitControl(setup.repository, actor(), pause);
        await waitFor(() => readRequest(setup.repository, setup.pins.runId, pause.requestId).status === 'refused', 'Draining runtime stopped polling.');
        assert.equal(processIdentityState(worker.identity), 'alive');
        assert.equal(readCheckpoint(setup.repository, setup.pins.runId).state, 'draining');
        worker.send('finish');
        await worker.closed;
        assert.equal((await runtime.closed).code, 0);
      });
      await check('explicit immediate stop during recovery cancels only verified groups and keeps old unknown effects', async () => {
        const setup = fixture();
        const worker = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit(0)); setInterval(() => {}, 1000);"], {
          cwd: setup.repository.coordinatorRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        worker.identity = readProcessIdentity(worker.pid);
        worker.closed = new Promise((done) => worker.once('close', (code, signal) => done({ code, signal })));
        children.add(worker);
        worker.closed.then(() => children.delete(worker));
        const unrelated = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit(0)); setInterval(() => {}, 1000);"], {
          detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        unrelated.identity = readProcessIdentity(unrelated.pid);
        unrelated.closed = new Promise((done) => unrelated.once('close', done));
        children.add(unrelated);
        unrelated.closed.then(() => children.delete(unrelated));
        const old = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        const attemptId = randomUUID();
        const binding = { schema: 'autoloop.worker-binding/1', runId: setup.pins.runId, generation: 1, unitId: randomUUID(), unitGeneration: 1,
          attemptId, sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir,
          process: worker.identity, pgid: worker.pid, groupLeader: worker.identity, role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
          liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
        registerFixtureWorker(old.lease, 1, binding);
        let value = commitTransition(old.lease, 2, (state) => ({ ...state, state: 'running' }));
        const unknownId = randomUUID();
        prepareEffect(old.lease, value.revision, { operationId: unknownId, requestId: null, runId: setup.pins.runId, unitId: null, unitGeneration: null,
          kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: schedulerDigest({ fixture: 'unknown effect' }),
          expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
        markEffectInFlight(old.lease, unknownId);
        value = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(old.lease, value.revision, (state) => ({ ...state, state: 'failed' }));
        releaseScheduler(old.lease);
        const runtime = await startRuntime(setup);
        assert.equal(readCheckpoint(setup.repository, setup.pins.runId).state, 'recovering');
        const stop = control(setup.pins.runId, 'stop-now', 2);
        submitControl(setup.repository, actor(), stop);
        await waitFor(() => processIdentityState(worker.identity) === 'dead', 'The registered worker was not cancelled.');
        await worker.closed;
        assert.equal((await runtime.closed).code, 0);
        const stopped = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(stopped.state, 'stopped');
        assert.equal(stopped.outbox[unknownId].phase, 'unknown');
        assert.equal(stopped.workers[0].cancelledByOperator, true);
        assert.equal(readRequest(setup.repository, setup.pins.runId, stop.requestId).status, 'applied');
        assert.equal(processIdentityState(unrelated.identity), 'alive');
        unrelated.kill('SIGTERM');
        await unrelated.closed;
      });
      await check('multi-group stop retains targets across restart and cannot complete after the first exit', async () => {
        const setup = fixture();
        const makeWorker = (ignoreTerm) => {
          const script = `process.on('disconnect', () => process.exit(0)); process.on('message', () => process.exit(0));
            ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000); process.send({ ready: true });`;
          const child = spawn(process.execPath, ['-e', script], { cwd: setup.repository.coordinatorRoot, detached: true,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
          child.identity = readProcessIdentity(child.pid);
          child.ready = new Promise((done) => child.once('message', done));
          child.closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
          children.add(child);
          child.closed.then(() => children.delete(child));
          return child;
        };
        const firstWorker = makeWorker(false);
        const secondWorker = makeWorker(true);
        await Promise.all([firstWorker.ready, secondWorker.ready]);
        const old = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        let revision = 1;
        const bindings = [];
        for (const worker of [firstWorker, secondWorker]) {
          const attemptId = randomUUID();
          const binding = { schema: 'autoloop.worker-binding/1', runId: setup.pins.runId, generation: 1,
            unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir,
            process: worker.identity, pgid: worker.pid, groupLeader: worker.identity, role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
            liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
          revision = registerFixtureWorker(old.lease, revision, binding).revision;
          bindings.push(binding);
        }
        commitTransition(old.lease, revision, (value) => ({ ...value, state: 'failed' }));
        releaseScheduler(old.lease);
        const runtime = await startRuntime(setup);
        const stop = control(setup.pins.runId, 'stop-now', 2);
        submitControl(setup.repository, actor(), stop);
        await firstWorker.closed;
        await waitFor(() => Object.values(readCheckpoint(setup.repository, setup.pins.runId).outbox)
          .some((effect) => effect.target.attemptId === bindings[0].attemptId && effect.phase === 'succeeded'), 'First cancellation was not settled.');
        const mid = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(processIdentityState(secondWorker.identity), 'alive');
        assert.notEqual(mid.requests[stop.requestId].status, 'applied');
        assert.deepEqual(mid.workers.map((worker) => worker.attemptId), bindings.map((worker) => worker.attemptId));
        runtime.kill('SIGKILL');
        await runtime.closed;
        const recovered = await startRuntime(setup);
        await recovered.closed;
        const waiting = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(waiting.requests[stop.requestId].status, 'unknown');
        assert.deepEqual(waiting.workers.map((worker) => worker.attemptId), bindings.map((worker) => worker.attemptId));
        assert.equal(processIdentityState(secondWorker.identity), 'alive');
        secondWorker.send('finish');
        await secondWorker.closed;
        const reconciler = await startRuntime(setup);
        await reconciler.closed;
        const final = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(final.requests[stop.requestId].status, 'applied');
        assert(final.workers.every((worker) => worker.cancelledByOperator));
      });
      await check('prepared cancellation recovers by empty-group readback without starting an old operation', async () => {
        const setup = fixture();
        const worker = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit(0)); setInterval(() => {}, 1000);"], {
          detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        worker.identity = readProcessIdentity(worker.pid);
        worker.closed = new Promise((done) => worker.once('close', done));
        children.add(worker);
        worker.closed.then(() => children.delete(worker));
        const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        const attemptId = randomUUID();
        const binding = { schema: 'autoloop.worker-binding/1', runId: setup.pins.runId, generation: 1,
          unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir,
          process: worker.identity, pgid: worker.pid, groupLeader: worker.identity, role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
          liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
        registerFixtureWorker(owner.lease, 1, binding);
        commitTransition(owner.lease, 2, (value) => ({ ...value, state: 'running' }));
        const stop = control(setup.pins.runId, 'stop-now');
        submitControl(setup.repository, actor(), stop);
        claimControl(owner.lease, stop.requestId);
        let current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(owner.lease, current.revision, (value) => reduceStop(value, 'immediate'));
        const operationId = randomUUID();
        current = readCheckpoint(setup.repository, setup.pins.runId);
        prepareEffect(owner.lease, current.revision, { operationId, requestId: stop.requestId, runId: setup.pins.runId,
          unitId: binding.unitId, unitGeneration: 1, kind: 'process.cancel', target: { type: 'process', attemptId },
          inputDigest: schedulerDigest({ binding }), expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
        assert.throws(() => abandonPreparedEffect(owner.lease, operationId), (error) => error.code === 'EFFECT_SETTLED');
        worker.kill('SIGTERM');
        await worker.closed;
        assert.throws(() => markEffectInFlight(owner.lease, operationId), (error) => error.code === 'OWNER_UNVERIFIED');
        current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(owner.lease, current.revision, (value) => ({ ...value, state: 'failed' }));
        releaseScheduler(owner.lease);
        const runtime = await startRuntime(setup);
        assert.equal((await runtime.closed).code, 0);
        const final = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(final.outbox[operationId].phase, 'succeeded');
        assert.equal(final.outbox[operationId].attempt, 1);
        assert.equal(final.requests[stop.requestId].status, 'applied');
      });
      await check('ordinary prepared effects and cancellation with no exact binding cannot use absent-group readback', () => {
        const setup = fixture();
        const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        commitTransition(owner.lease, 1, (value) => ({ ...value, state: 'running' }));
        const request = control(setup.pins.runId, 'stop-now');
        submitControl(setup.repository, actor(), request);
        claimControl(owner.lease, request.requestId);
        let current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(owner.lease, current.revision, (value) => reduceStop(value, 'immediate'));
        for (const kind of ['external.fixture', 'process.cancel']) {
          const operationId = randomUUID();
          current = readCheckpoint(setup.repository, setup.pins.runId);
          prepareEffect(owner.lease, current.revision, { operationId, requestId: request.requestId, runId: setup.pins.runId,
            unitId: randomUUID(), unitGeneration: 1, kind, target: { type: 'process', attemptId: randomUUID() },
            inputDigest: schedulerDigest({ kind }), expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
          assert.throws(() => settleEffect(owner.lease, operationId, { attempt: 1, status: 'applied', code: 'GROUP_ALREADY_EXITED',
            receipt: { externalId: randomUUID(), observationDigest: schedulerDigest({ absent: true }), observedAt: Date.now() } }),
          (error) => error.code === 'EFFECT_SETTLED');
          assert.equal(readCheckpoint(setup.repository, setup.pins.runId).outbox[operationId].phase, 'prepared');
        }
        current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(owner.lease, current.revision, (value) => ({ ...value, state: 'failed' }));
        releaseScheduler(owner.lease);
      });
      await check('orderly stop and SIGTERM account for request-independent and linked prepared intents', async () => {
        for (const linked of [false, true]) for (const stopping of ['control', 'signal']) {
          const setup = fixture();
          const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
          commitTransition(owner.lease, 1, (value) => ({ ...value, state: 'running' }));
          const request = linked ? control(setup.pins.runId, 'pause') : null;
          if (request) { submitControl(setup.repository, actor(), request); claimControl(owner.lease, request.requestId); }
          const operationId = randomUUID();
          prepareEffect(owner.lease, readCheckpoint(setup.repository, setup.pins.runId).revision, { operationId,
            requestId: request?.requestId ?? null, runId: setup.pins.runId, unitId: null, unitGeneration: null,
            kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: schedulerDigest({ unstarted: true }),
            expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
          let current = readCheckpoint(setup.repository, setup.pins.runId);
          commitTransition(owner.lease, current.revision, (value) => ({ ...value, state: 'failed' })); releaseScheduler(owner.lease);
          const runtime = await startRuntime(setup);
          assert.equal(readCheckpoint(setup.repository, setup.pins.runId).state, 'recovering');
          if (stopping === 'signal') runtime.kill('SIGTERM');
          else submitControl(setup.repository, actor(), control(setup.pins.runId, 'stop', 2));
          assert.equal((await runtime.closed).code, 0);
          current = readCheckpoint(setup.repository, setup.pins.runId);
          assert.equal(current.state, 'stopped');
          assert.equal(current.outbox[operationId].phase, 'failed');
          assert.equal(current.outbox[operationId].error.code, 'STOPPED_BEFORE_LAUNCH');
          if (request) assert.equal(readRequest(setup.repository, setup.pins.runId, request.requestId).status, 'refused');
          const next = createPins(setup.repository, { pluginRoot: ROOT, enginePath: setup.pins.enginePath,
            config: setup.pins.config, models: setup.pins.models });
          const fresh = acquireScheduler(setup.repository, next, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
          commitTransition(fresh.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(fresh.lease);
        }
      });
      await check('launch selection retains stopped prepared intents before accounting', () => {
        const setup = fixture();
        const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        commitTransition(owner.lease, 1, (value) => ({ ...value, state: 'running' }));
        prepareEffect(owner.lease, 2, { operationId: randomUUID(), requestId: null, runId: setup.pins.runId, unitId: null, unitGeneration: null,
          kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: schedulerDigest({ unstarted: true }),
          expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
        commitTransition(owner.lease, 3, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(owner.lease);
        const prepared = prepareLoopCommand(parseLoopArgs(['run', '--foreground', '--root', setup.repository.coordinatorRoot, '--operator-terminal']));
        assert.equal(prepared.pins.runId, setup.pins.runId);
        assert.equal(prepared.command.runId, setup.pins.runId);
      });
      await check('launch selection recovers stopped unknown work but starts a new completed run', () => {
        const setup = fixture();
        const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        commitTransition(owner.lease, 1, (value) => ({ ...value, state: 'running' }));
        const operationId = randomUUID();
        prepareEffect(owner.lease, 2, { operationId, requestId: null, runId: setup.pins.runId, unitId: null, unitGeneration: null,
          kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: schedulerDigest({ unknown: true }),
          expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
        markEffectInFlight(owner.lease, operationId);
        let current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(owner.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
        releaseScheduler(owner.lease);
        const options = parseLoopArgs(['run', '--foreground', '--root', setup.repository.coordinatorRoot, '--operator-terminal']);
        const recovering = prepareLoopCommand(options);
        assert.equal(recovering.pins.runId, setup.pins.runId);
        assert.equal(recovering.command.runId, setup.pins.runId);
        const resumed = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        settleEffect(resumed.lease, operationId, { attempt: 1, status: 'applied', code: 'READBACK_CONFIRMED', receipt: {
          externalId: operationId, observationDigest: schedulerDigest({ applied: true }), observedAt: Date.now() } });
        current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(resumed.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
        releaseScheduler(resumed.lease);
        mkdirSync(join(setup.repository.coordinatorRoot, '.autoloop'));
        writeFileSync(join(setup.repository.coordinatorRoot, '.autoloop', 'config.json'), JSON.stringify(setup.pins.config));
        const bin = join(setup.home, 'bin');
        mkdirSync(bin);
        symlinkSync(process.execPath, join(bin, 'claude'));
        const priorPath = process.env.PATH;
        let next;
        try {
          process.env.PATH = `${bin}:${priorPath ?? ''}`;
          next = prepareLoopCommand(options);
        } finally { process.env.PATH = priorPath; }
        assert.notEqual(next.pins.runId, setup.pins.runId);
        assert.equal(next.command.runId, null);
        assert.equal(next.command.generation, null);
      });
      await check('a dead worker with a live registered group stays unknown and cannot be erased or replaced', async () => {
        const setup = fixture();
        const script = `const { spawn } = require('node:child_process');
          const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          worker.once('close', () => process.send({ workerExited: true }));
          process.on('message', () => worker.kill('SIGTERM'));
          process.on('disconnect', () => { worker.kill('SIGKILL'); process.exit(0); });
          process.send({ workerPid: worker.pid }); setInterval(() => {}, 1000);`;
        const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        leader.identity = readProcessIdentity(leader.pid);
        leader.closed = new Promise((done) => leader.once('close', done));
        children.add(leader);
        leader.closed.then(() => children.delete(leader));
        const { workerPid } = await new Promise((done) => leader.once('message', done));
        const workerIdentity = readProcessIdentity(workerPid);
        const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        const attemptId = randomUUID();
        const binding = { schema: 'autoloop.worker-binding/1', runId: setup.pins.runId, generation: 1,
          unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir,
          process: workerIdentity, pgid: leader.pid, groupLeader: leader.identity, role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
          liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
        registerFixtureWorker(owner.lease, 1, binding);
        const exited = new Promise((done) => leader.once('message', done));
        leader.send('finish-worker');
        await exited;
        assert.equal(boundGroupState(binding), 'unknown');
        assert.throws(() => commitTransition(owner.lease, 2, (value) => ({ ...value, workers: [] })), (error) => error.code === 'OWNER_UNVERIFIED');
        commitTransition(owner.lease, 2, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
        releaseScheduler(owner.lease);
        assert.equal(prepareLoopCommand(parseLoopArgs(['run', '--foreground', '--root', setup.repository.coordinatorRoot, '--operator-terminal'])).pins.runId, setup.pins.runId);
        const runtime = await startRuntime(setup);
        assert.equal(readCheckpoint(setup.repository, setup.pins.runId).state, 'recovering');
        const stop = control(setup.pins.runId, 'stop', 2);
        submitControl(setup.repository, actor(), stop);
        await runtime.closed;
        const waiting = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(waiting.requests[stop.requestId].status, 'applied');
        assert.equal(waiting.error.code, 'OWNER_UNVERIFIED');
        assert.equal(waiting.workers.length, 1);
        assert.equal(processIdentityState(leader.identity), 'alive');
        leader.kill('SIGTERM');
        await leader.closed;
      });
      if (process.platform === 'linux') await check('dead leader/live child, old boot and unreadable group probes retain unknown ownership', async () => {
        const setup = fixture();
        // A real subreaper keeps the orphan test child observable and reaps it.
        const helper = `import ctypes, json, os, signal, subprocess, sys
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
leader = subprocess.Popen([sys.argv[1], '-e', "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); console.log(child.pid); setInterval(() => {}, 1000);"], start_new_session=True, stdout=subprocess.PIPE, text=True)
child_pid = int(leader.stdout.readline())
print(json.dumps({'leader':leader.pid,'child':child_pid}), flush=True)
try:
    if sys.stdin.readline().strip() == 'exit-leader':
        leader.terminate()
        leader.wait()
        print('leader-exited', flush=True)
        sys.stdin.readline()
finally:
    if leader.poll() is None:
        leader.kill()
        leader.wait()
    try: os.kill(child_pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(child_pid, 0)
    except ChildProcessError: pass
`;
        const reaper = spawn('python3', ['-I', '-u', '-c', helper, process.execPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        reaper.identity = readProcessIdentity(reaper.pid);
        reaper.closed = new Promise((done) => reaper.once('close', done));
        reaper.cleanup = () => reaper.stdin.end();
        children.add(reaper);
        reaper.closed.then(() => children.delete(reaper));
        let output = '';
        reaper.stdout.on('data', (chunk) => { output += chunk; });
        await waitFor(() => output.includes('\n'), 'The group fixture did not start.');
        const ids = JSON.parse(output.split('\n')[0]);
        const owner = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        const attemptId = randomUUID();
        const binding = { schema: 'autoloop.worker-binding/1', runId: setup.pins.runId, generation: 1,
          unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir,
          process: readProcessIdentity(ids.child), pgid: ids.leader, groupLeader: readProcessIdentity(ids.leader), role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
          liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
        registerFixtureWorker(owner.lease, 1, binding);
        reaper.stdin.write('exit-leader\n');
        await waitFor(() => output.includes('leader-exited'), 'The leader did not exit.');
        assert.equal(processIdentityState(binding.groupLeader), 'dead');
        assert.equal(processIdentityState(binding.process), 'alive');
        assert.equal(boundGroupState(binding), 'unknown');
        const oldBoot = { ...binding, process: { ...binding.process, bootId: randomUUID() }, groupLeader: { ...binding.groupLeader, bootId: randomUUID() } };
        assert.equal(boundGroupState(oldBoot), 'unknown');
        const kill = process.kill;
        try {
          process.kill = (pid, signal) => {
            if (pid === -binding.pgid && signal === 0) throw Object.assign(new Error('group access denied'), { code: 'EPERM' });
            return kill(pid, signal);
          };
          assert.equal(boundGroupState(oldBoot), 'unknown');
        } finally { process.kill = kill; }
        assert.throws(() => commitTransition(owner.lease, 2, (value) => ({ ...value, workers: [] })), (error) => error.code === 'OWNER_UNVERIFIED');
        commitTransition(owner.lease, 2, (value) => ({ ...value, state: 'failed' }));
        releaseScheduler(owner.lease);
        const runtime = await startRuntime(setup);
        const stop = control(setup.pins.runId, 'stop-now', 2);
        submitControl(setup.repository, actor(), stop);
        await runtime.closed;
        assert.equal(readRequest(setup.repository, setup.pins.runId, stop.requestId).status, 'unknown');
        assert.equal(processIdentityState(binding.process), 'alive');
        reaper.stdin.end('finish\n');
        await reaper.closed;
        assert.equal(boundGroupState(binding), 'empty');
      });
      await check('recovery cancellation refuses ordinary/old requests, wrong targets and reused groups', async () => {
        const setup = fixture();
        const worker = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit(0)); setInterval(() => {}, 1000);"], {
          cwd: setup.repository.coordinatorRoot, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        worker.identity = readProcessIdentity(worker.pid);
        worker.closed = new Promise((done) => worker.once('close', done));
        children.add(worker);
        worker.closed.then(() => children.delete(worker));
        const old = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        const attemptId = randomUUID();
        const binding = { schema: 'autoloop.worker-binding/1', runId: setup.pins.runId, generation: 1, unitId: randomUUID(), unitGeneration: 1,
          attemptId, sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir,
          process: worker.identity, pgid: worker.pid, groupLeader: worker.identity, role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
          liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
        registerFixtureWorker(old.lease, 1, binding);
        const oldRequest = control(setup.pins.runId, 'stop-now');
        submitControl(setup.repository, actor(), oldRequest);
        claimControl(old.lease, oldRequest.requestId);
        let current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(old.lease, current.revision, (value) => ({ ...value, state: 'failed' }));
        releaseScheduler(old.lease);
        const recovered = acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: readProcessIdentity() });
        const ordinary = control(setup.pins.runId, 'stop', 2);
        const fresh = control(setup.pins.runId, 'stop-now', 2);
        for (const request of [ordinary, fresh]) {
          submitControl(setup.repository, actor(), request);
          claimControl(recovered.lease, request.requestId);
        }
        current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(recovered.lease, current.revision, (value) => ({ ...value, desiredState: 'stopped', stopMode: 'immediate',
          workers: value.workers.map((entry) => ({ ...entry, cancelledByOperator: true })) }));
        const effect = (requestId) => ({ operationId: randomUUID(), requestId, runId: setup.pins.runId, unitId: binding.unitId, unitGeneration: 1,
          kind: 'process.cancel', target: { type: 'process', attemptId }, inputDigest: schedulerDigest({ binding, requestId }),
          expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
        for (const requestId of [ordinary.requestId, oldRequest.requestId]) assert.throws(() => prepareEffect(recovered.lease,
          readCheckpoint(setup.repository, setup.pins.runId).revision, effect(requestId)), (error) => error.code === 'RECOVERY_REQUIRED');
        assert.throws(() => prepareEffect(recovered.lease, readCheckpoint(setup.repository, setup.pins.runId).revision,
          { ...effect(fresh.requestId), runId: randomUUID() }), (error) => error.code === 'INVALID_INPUT');
        assert.throws(() => prepareEffect(recovered.lease, readCheckpoint(setup.repository, setup.pins.runId).revision,
          { ...effect(fresh.requestId), target: { type: 'process', attemptId: randomUUID() } }), (error) => error.code === 'RECOVERY_REQUIRED');
        const stale = control(setup.pins.runId, 'stop-now', 1);
        submitControl(setup.repository, actor(), stale);
        assert.equal(claimControl(recovered.lease, stale.requestId).status, 'refused');
        assert.throws(() => prepareEffect(recovered.lease, readCheckpoint(setup.repository, setup.pins.runId).revision,
          effect(stale.requestId)), (error) => error.code === 'REQUEST_NOT_FOUND' || error.code === 'RECOVERY_REQUIRED');
        const path = join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.pins.runId, 'checkpoint.json');
        const saved = readRegularFile(path);
        const damaged = JSON.parse(saved);
        damaged.workers[0].process.start = process.platform === 'linux' ? '0' : 'Mon Jan 1 00:00:00 1990';
        writeFileSync(path, JSON.stringify(damaged));
        assert.throws(() => prepareEffect(recovered.lease, damaged.revision, effect(fresh.requestId)), (error) => error.code === 'RECOVERY_REQUIRED');
        assert.equal(boundGroupState(damaged.workers[0]), 'unknown');
        assert.equal(processIdentityState(worker.identity), 'alive');
        writeFileSync(path, saved);
        worker.kill('SIGTERM');
        await worker.closed;
        const final = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(recovered.lease, final.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
        releaseScheduler(recovered.lease);
      });
    } finally {
      await Promise.all([...children].map(async (child) => {
        try {
          if (child.cleanup) child.cleanup();
          else if (schedulerDigest(readProcessIdentity(child.pid)) === schedulerDigest(child.identity)) child.kill('SIGKILL');
        } catch { /* already gone */ }
        await child.closed;
      }));
    }
  } finally {
    // Retain test files until removal is permitted in this execution context.
    console.error(`Retained runtime test files: ${scratch}`);
  }
  const failed = results.filter(([, passed]) => !passed);
  console.log(failed.length === 0 ? `self-test OK (${results.length} cases)` : `self-test FAILED (${failed.length}/${results.length})`);
  return failed.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exit(await selfTest() ? 0 : 1);
  try {
    const options = parseLoopArgs(process.argv.slice(2));
    const data = await executeLoopCommand(options);
    if (options.operation !== 'foreground') process.stdout.write(`${JSON.stringify({ schema: LOOP_SCHEMA, ok: true, data })}\n`);
  } catch (error) {
    const code = error instanceof SchedulerError ? error.code : 'STATE_IO_FAILED';
    const message = error instanceof SchedulerError ? error.message : 'The loop command failed.';
    process.stdout.write(`${JSON.stringify({ schema: LOOP_SCHEMA, ok: false, error: { code, message } })}\n`);
    process.exit(errorExit(code));
  }
}
