#!/usr/bin/env node
// Durable scheduler state (docs/specs/SPEC-loop-daemon.md). No daemon launch,
// queue selection or operator-admission shortcut lives in this module.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigText, validateConfig } from './config-contract.mjs';
import { DEFAULT_MODELS, invariantProblems, mergeModels, MODEL_ROLES, modelsShapeProblems } from './models-config.mjs';
import { isClaudeProcess, processAlive, processStart, procEntry, readRegularFile, publishWorkerGuard, readBootIdentity } from './run-markers.mjs';
import { boundedGit } from './git-budget.mjs';
import { runningDispatches } from './inherited-dispatch.mjs';

export const CHECKPOINT_SCHEMA = 'autoloop.scheduler-checkpoint/1';
export const PINS_SCHEMA = 'autoloop.scheduler-pins/1';
export const CURRENT_SCHEMA = 'autoloop.scheduler-current/1';
export const CONTROL_SCHEMA = 'autoloop.control/2';
export const OUTCOME_SCHEMA = 'autoloop.control-outcome/2';
export const DEFAULT_SUPERVISOR_PROFILE = Object.freeze({
  memoryMaxBytes: 6442450944, memorySwapMaxBytes: 0, tasksMax: 2048,
});
const HASH_RE = /^[0-9a-f]{64}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const leases = new WeakMap();

export class SchedulerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}
function requireCondition(passed, code, message) {
  if (!passed) throw new SchedulerError(code, message);
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function nonempty(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}
function uuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}
function hash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export function schedulerDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function gitFact(root, args) {
  const result = boundedGit(['-C', root, 'rev-parse', ...args], {
    maxBuffer: 1024 * 1024,
  });
  requireCondition(result.status === 0 && !result.error, 'REPOSITORY_INVALID', 'The repository cannot be verified.');
  return result.stdout.trim();
}
export function resolveRepository(root) {
  requireCondition(nonempty(root), 'INVALID_INPUT', 'A repository root is required.');
  try {
    const directory = realpathSync(resolve(root));
    const coordinatorRoot = realpathSync(gitFact(directory, ['--show-toplevel']));
    const commonDir = realpathSync(gitFact(directory, ['--path-format=absolute', '--git-common-dir']));
    requireCondition(lstatSync(commonDir).isDirectory(), 'REPOSITORY_INVALID', 'The common Git directory is invalid.');
    return Object.freeze({
      repositoryKey: createHash('sha256').update(commonDir, 'utf8').digest('hex'),
      commonDir, coordinatorRoot,
    });
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('REPOSITORY_INVALID', 'The repository cannot be verified.');
  }
}

export function assertNoKnownLegacyOwner(repository, { owner = null, sessionId = null } = {}) {
  const parent = join(repository.commonDir, 'autoloop');
  if (!present(parent)) return;
  requireCondition(lstatSync(parent).isDirectory() && realpathSync(parent) === parent,
    'LEGACY_RUN_ACTIVE', 'Legacy ownership storage cannot be verified.');
  const directory = join(parent, 'run');
  if (!present(directory)) return;
  requireCondition(lstatSync(directory).isDirectory() && realpathSync(directory) === directory,
    'LEGACY_RUN_ACTIVE', 'Legacy ownership cannot be verified.');
  for (const name of readdirSync(directory).filter((value) => value.endsWith('.json'))) {
    let marker;
    try { marker = JSON.parse(readRegularFile(join(directory, name))); }
    catch { throw new SchedulerError('LEGACY_RUN_ACTIVE', 'A legacy owner record cannot be read.'); }
    requireCondition(marker?.version === 1 && Array.isArray(marker.pids), 'LEGACY_RUN_ACTIVE', 'A legacy owner record is invalid.');
    if (marker.closedAt !== undefined) continue;
    if (marker.owner !== undefined) {
      requireCondition(validProcess(marker.owner), 'OWNER_UNVERIFIED', 'Legacy owner identity is invalid.');
      const state = ownerState(marker.owner);
      if (state === 'dead') continue;
      requireCondition(state !== 'unknown', 'OWNER_UNVERIFIED', 'Legacy owner identity is unknown.');
      if (owner !== null && schedulerDigest(owner) === schedulerDigest(marker.owner) && sessionId === marker.sessionId) continue;
      const error = new SchedulerError('LEGACY_RUN_ACTIVE', 'A legacy loop still owns this repository.');
      Object.assign(error, { owner: marker.owner, sessionId: marker.sessionId, markerPath: join(directory, name) });
      throw error;
    }
    for (const pid of marker.pids) {
      if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) continue;
      const entry = procEntry(pid);
      if (entry === null) throw new SchedulerError('LEGACY_RUN_ACTIVE', 'Legacy process identity is unknown.');
      if (!isClaudeProcess(entry[1], entry[2])) continue;
      const start = processStart(pid);
      const recorded = marker.starts?.[pid];
      if (recorded !== undefined && recorded !== null && start !== null && start !== recorded) continue;
      if (owner?.pid === pid && owner.start === start && sessionId === marker.sessionId) continue;
      const error = new SchedulerError('LEGACY_RUN_ACTIVE', 'A known legacy loop still owns this repository. Drain old runs before migration.');
      Object.assign(error, { owner: start === null ? { pid, start: null, bootId: readBootIdentity() } : readProcessIdentity(pid),
        sessionId: marker.sessionId ?? null, markerPath: join(directory, name) });
      throw error;
    }
  }
}

function safeDirectory(path, create = false, observe = () => {}) {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw new SchedulerError('STATE_IO_FAILED', 'The state directory cannot be created.');
    }
  }
  try {
    requireCondition(lstatSync(path).isDirectory() && realpathSync(path) === path,
      'STATE_INVALID', 'A state directory is not a real directory.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      requireCondition(fstatSync(fd).isDirectory(), 'STATE_INVALID', 'A state directory is invalid.');
    } finally {
      closeSync(fd);
    }
    if (create) {
      // Flush even an existing entry: a preceding mkdir may have failed its flush.
      observe('directory-parent-sync', path);
      syncDirectory(dirname(path));
      observe('directory-parent-flushed', path);
    }
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('STATE_IO_FAILED', 'A state directory cannot be read or flushed.');
  }
  return path;
}
function stateDirectory(repository, create = false, observe = () => {}) {
  let directory = safeDirectory(repository.commonDir);
  for (const name of ['autoloop', 'scheduler']) directory = safeDirectory(join(directory, name), create, observe);
  return directory;
}
function childDirectory(parent, name, create = false, observe = () => {}) {
  requireCondition(nonempty(name) && !name.includes('/') && name !== '.' && name !== '..', 'INVALID_INPUT', 'A state component is invalid.');
  return safeDirectory(join(safeDirectory(parent), name), create, observe);
}
function stateJson(path, optional = false) {
  try {
    safeDirectory(dirname(path));
    return JSON.parse(readRegularFile(path));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(error instanceof SyntaxError ? 'STATE_INVALID' : 'STATE_IO_FAILED', 'A state record cannot be read.');
  }
}
function syncDirectory(path) {
  const fd = openSync(safeDirectory(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    requireCondition(fstatSync(fd).isDirectory(), 'STATE_INVALID', 'A flush target is not a directory.');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
// Instrumentation is for crash/OS-failure tests, not an alternate filesystem.
// Acknowledgment follows the file flush, publication and directory flush.
function durableWrite(path, value, { exclusive = false, observe = () => {} } = {}) {
  const directory = safeDirectory(dirname(path));
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, `${canonicalJson(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    observe('temporary-flushed', path);
    safeDirectory(directory);
    if (exclusive) linkSync(temporary, path);
    else {
      if (existsSync(path)) requireCondition(lstatSync(path).isFile(), 'STATE_INVALID', 'A state record is not a regular file.');
      renameSync(temporary, path);
    }
    observe('published', path);
    syncDirectory(directory);
    observe('directory-flushed', path);
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    const failure = new SchedulerError(error.code === 'EEXIST' ? 'STATE_CONFLICT' : 'STATE_IO_FAILED', 'A durable state write failed.');
    failure.ioCode = error.code ?? null;
    throw failure;
  } finally {
    // Only this call's exclusive temporary file; authoritative state is never pruned.
    try { unlinkSync(temporary); } catch { /* retained after an interrupted write */ }
  }
}

export { readBootIdentity } from './run-markers.mjs';
function validProcess(value) {
  return exactKeys(value, ['pid', 'start', 'bootId']) && positive(value.pid) && nonempty(value.start) && nonempty(value.bootId)
    && ((uuid(value.bootId) && /^\d+$/u.test(value.start)) || (/^darwin:\d+:\d+$/u.test(value.bootId)
      && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/u.test(value.start)));
}
export function readProcessIdentity(pid = process.pid) {
  requireCondition(positive(pid), 'INVALID_INPUT', 'A process ID is invalid.');
  const bootId = readBootIdentity();
  const start = processStart(pid);
  requireCondition(nonempty(bootId) && nonempty(start) && processAlive(pid) && processStart(pid) === start,
    'OWNER_UNVERIFIED', 'The process identity cannot be verified.');
  return { pid, start, bootId };
}
function ownerState(owner, observe = () => {}) {
  try {
    observe('owner-boot', owner);
    const boot = readBootIdentity();
    if (boot === null) return 'unknown';
    if (boot !== owner.bootId) return 'dead';
    if (!processAlive(owner.pid)) return 'dead';
    observe('owner-start', owner);
    const start = processStart(owner.pid);
    return start === null ? 'unknown' : start === owner.start ? 'alive' : 'dead';
  } catch { return 'unknown'; }
}
export function processIdentityState(identity) {
  requireCondition(validProcess(identity), 'INVALID_INPUT', 'The process identity is invalid.');
  return ownerState(identity);
}
function safeValues(value) {
  if (typeof value === 'string') return !/sk-ant-[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|-----BEGIN .*PRIVATE KEY-----/u.test(value);
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(safeValues);
  if (!record(value)) return false;
  return Object.entries(value).every(([key, item]) => !/^(?:api[-_]?key|auth(?:orization)?|password|secret|token|credentials|env|environment)$/iu.test(key) && safeValues(item));
}
function regularBytes(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireCondition(fstatSync(fd).isFile(), 'INVALID_INPUT', 'Plugin content must be a regular file.');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function pluginFingerprint(pluginRoot) {
  const files = [];
  const visit = (path, name) => {
    const info = lstatSync(path);
    requireCondition(!info.isSymbolicLink(), 'INVALID_INPUT', 'Plugin content cannot be a symbolic link.');
    if (info.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
    } else {
      requireCondition(info.isFile(), 'INVALID_INPUT', 'Plugin content must be a regular file.');
      files.push([name, createHash('sha256').update(regularBytes(path)).digest('hex')]);
    }
  };
  visit(join(pluginRoot, '.claude-plugin', 'plugin.json'), '.claude-plugin/plugin.json');
  for (const name of ['tools', 'hooks', 'skills', 'templates', 'types']) {
    const path = join(pluginRoot, name);
    if (existsSync(path)) visit(path, name);
  }
  return schedulerDigest(files);
}
function validProfile(value) {
  return exactKeys(value, ['memoryMaxBytes', 'memorySwapMaxBytes', 'tasksMax']) && positive(value.memoryMaxBytes)
    && timestamp(value.memorySwapMaxBytes) && positive(value.tasksMax);
}
const PIN_KEYS = ['schema', 'runId', 'repositoryKey', 'commonDir', 'coordinatorRoot', 'baseBranch',
  'pluginRoot', 'pluginVersion', 'pluginDigest', 'nodePath', 'enginePath', 'config', 'configDigest',
  'models', 'modelsDigest', 'supervisorProfile', 'createdAt'];
export function validatePins(value) {
  const errors = [];
  if (!exactKeys(value, PIN_KEYS) || value.schema !== PINS_SCHEMA) return ['Pins do not match their schema.'];
  if (!uuid(value.runId) || !hash(value.repositoryKey) || !hash(value.pluginDigest)
    || !hash(value.configDigest) || !hash(value.modelsDigest) || !timestamp(value.createdAt)) errors.push('Pin identity is invalid.');
  for (const key of ['commonDir', 'coordinatorRoot', 'pluginRoot', 'nodePath', 'enginePath']) {
    if (!nonempty(value[key]) || !isAbsolute(value[key])) errors.push('A pinned path is invalid.');
  }
  if (!nonempty(value.pluginVersion) || !nonempty(value.baseBranch) || !validProfile(value.supervisorProfile)) errors.push('Pin settings are invalid.');
  if (!safeValues(value) || validateConfig(value.config).length > 0 || value.config.baseBranch !== value.baseBranch
    || schedulerDigest(value.config) !== value.configDigest) errors.push('Pinned configuration is invalid.');
  if (modelsShapeProblems(value.models, 'models').length > 0 || !exactKeys(value.models, MODEL_ROLES)
    || MODEL_ROLES.some((role) => !exactKeys(value.models[role], ['model', 'effort', 'fallback']) || !nonempty(value.models[role].model))
    || schedulerDigest(value.models) !== value.modelsDigest) errors.push('Pinned model routes are invalid.');
  else if (invariantProblems(value.models).length > 0) errors.push('Pinned model identities are not independent.');
  return errors;
}
export function createPins(repository, { pluginRoot, enginePath, config, models, runId = randomUUID(),
  supervisorProfile = DEFAULT_SUPERVISOR_PROFILE, createdAt = Date.now() }) {
  try {
    const root = realpathSync(pluginRoot);
    const metadata = JSON.parse(readRegularFile(join(root, '.claude-plugin', 'plugin.json')));
    const pins = {
      schema: PINS_SCHEMA, runId, repositoryKey: repository.repositoryKey,
      commonDir: repository.commonDir, coordinatorRoot: repository.coordinatorRoot, baseBranch: config?.baseBranch,
      pluginRoot: root, pluginVersion: metadata.version, pluginDigest: pluginFingerprint(root),
      nodePath: realpathSync(process.execPath), enginePath: realpathSync(enginePath),
      config, configDigest: schedulerDigest(config), models, modelsDigest: schedulerDigest(models),
      supervisorProfile: { ...supervisorProfile }, createdAt,
    };
    requireCondition(validatePins(pins).length === 0, 'INVALID_INPUT', 'The launch pins are invalid.');
    return JSON.parse(canonicalJson(pins));
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('INVALID_INPUT', 'The launch pins cannot be verified.');
  }
}

const CHECKPOINT_KEYS = ['schema', 'runId', 'repositoryKey', 'generation', 'revision', 'owner', 'initiator',
  'pinsDigest', 'state', 'desiredState', 'stopMode', 'queueEnabled', 'units', 'reservations', 'workers',
  'requests', 'outbox', 'createdAt', 'updatedAt', 'stoppedAt', 'error'];
const STATES = new Set(['starting', 'recovering', 'running', 'paused', 'draining', 'stopped', 'failed']);
function validInitiator(value) {
  return exactKeys(value, ['kind', 'sessionId', 'process']) && ['mod', 'terminal'].includes(value.kind)
    && (value.kind === 'mod' ? uuid(value.sessionId) : value.sessionId === null) && validProcess(value.process);
}
function validError(value) {
  return value === null || (exactKeys(value, ['code', 'message']) && nonempty(value.code) && /^[A-Z][A-Z0-9_]*$/u.test(value.code)
    && nonempty(value.message) && safeValues(value));
}
const WORKER_KEYS = ['schema', 'runId', 'generation', 'unitId', 'unitGeneration', 'attemptId', 'sessionId',
  'worktreeGitDir', 'process', 'pgid', 'groupLeader', 'role', 'posture', 'actualModel', 'liveFile', 'cancelledByOperator'];
function validWorker(value) {
  return exactKeys(value, WORKER_KEYS) && value.schema === 'autoloop.worker-binding/1'
    && [value.runId, value.unitId, value.attemptId, value.sessionId].every(uuid)
    && positive(value.generation) && positive(value.unitGeneration) && validProcess(value.process)
    && positive(value.pgid) && validProcess(value.groupLeader) && value.groupLeader.pid === value.pgid
    && ['plan', 'implement', 'fix', 'simplify', 'code-review', 'diff-review', 'doubt-review'].includes(value.role)
    && ['plan', 'writer', 'read-only'].includes(value.posture) && nonempty(value.actualModel)
    && [value.worktreeGitDir, value.liveFile].every((path) => nonempty(path) && isAbsolute(path))
    && typeof value.cancelledByOperator === 'boolean' && safeValues(value);
}
export function validateCheckpoint(value) {
  const errors = [];
  if (!exactKeys(value, CHECKPOINT_KEYS) || value.schema !== CHECKPOINT_SCHEMA) return ['Checkpoint does not match its schema.'];
  if (!uuid(value.runId) || !hash(value.repositoryKey) || !positive(value.generation) || !positive(value.revision)
    || !hash(value.pinsDigest) || (value.owner !== null && !validProcess(value.owner)) || !validInitiator(value.initiator)) errors.push('Checkpoint identity is invalid.');
  if (!STATES.has(value.state) || !['running', 'paused', 'stopped'].includes(value.desiredState)
    || ![null, 'graceful', 'immediate'].includes(value.stopMode) || value.queueEnabled !== false) errors.push('Checkpoint lifecycle is invalid.');
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.updatedAt < value.createdAt
    || (value.stoppedAt !== null && !timestamp(value.stoppedAt)) || !validError(value.error)) errors.push('Checkpoint timestamps or error are invalid.');
  if (value.state === 'stopped' && (value.desiredState !== 'stopped' || value.stoppedAt === null)) errors.push('A stopped checkpoint needs stopped intent and time.');
  if (!Array.isArray(value.units) || value.units.length !== 0 || !Array.isArray(value.reservations) || value.reservations.length !== 0) errors.push('Unit and reservation providers are not available.');
  if (!Array.isArray(value.workers) || value.workers.some((worker) => !validWorker(worker) || worker.runId !== value.runId
    || worker.generation > value.generation) || new Set(value.workers.map((worker) => worker.attemptId)).size !== value.workers.length) errors.push('Worker bindings are invalid.');
  if (!record(value.requests) || Object.entries(value.requests).some(([id, request]) => !uuid(id) || !validRequestRecord(request, value, id))) errors.push('Request records are invalid.');
  if (!record(value.outbox) || Object.entries(value.outbox).some(([id, effect]) => !uuid(id) || !validEffect(effect)
    || effect.operationId !== id || effect.runId !== value.runId || (effect.requestId !== null && !value.requests?.[effect.requestId]))) errors.push('Outbox records are invalid.');
  if (!safeValues(value)) errors.push('Checkpoint contains unsupported values.');
  return errors;
}
function present(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new SchedulerError('STATE_IO_FAILED', 'A state path cannot be inspected.');
  }
}
function existingState(repository) {
  let directory = safeDirectory(repository.commonDir);
  for (const name of ['autoloop', 'scheduler']) {
    directory = join(directory, name);
    if (!present(directory)) return null;
    safeDirectory(directory);
  }
  return directory;
}
function verifyRepository(repository) {
  requireCondition(exactKeys(repository, ['repositoryKey', 'commonDir', 'coordinatorRoot']), 'INVALID_INPUT', 'Repository identity is invalid.');
  const actual = resolveRepository(repository.coordinatorRoot);
  requireCondition(actual.repositoryKey === repository.repositoryKey && actual.commonDir === repository.commonDir,
    'REPOSITORY_INVALID', 'Repository identity changed.');
}
const LEASE_SCHEMA = 'autoloop.scheduler-lease/1';
const RELEASE_SCHEMA = 'autoloop.scheduler-release/1';
function validLeaseRecord(value, sequence, repository) {
  return exactKeys(value, ['schema', 'sequence', 'leaseId', 'repositoryKey', 'runId', 'generation', 'owner', 'createdAt'])
    && value.schema === LEASE_SCHEMA && value.sequence === sequence && positive(sequence) && uuid(value.leaseId)
    && value.repositoryKey === repository.repositoryKey && uuid(value.runId) && positive(value.generation)
    && validProcess(value.owner) && timestamp(value.createdAt);
}
function validRelease(value, lease) {
  return exactKeys(value, ['schema', 'sequence', 'leaseId', 'owner', 'releasedAt']) && value.schema === RELEASE_SCHEMA
    && value.sequence === lease.sequence && value.leaseId === lease.leaseId && schedulerDigest(value.owner) === schedulerDigest(lease.owner)
    && timestamp(value.releasedAt) && value.releasedAt >= lease.createdAt;
}
// Lease records are never removed or replaced. Contenders for the same next
// sequence link a complete immutable record; one link wins. A successor needs
// a verified dead/released predecessor. There is no stale-directory rename race.
function readLedger(repository, create = false, observe = () => {}) {
  const state = create ? stateDirectory(repository, true, observe) : existingState(repository);
  if (state === null) return [];
  const path = join(state, 'lock');
  if (!create && !present(path)) {
    requireCondition(!present(join(state, 'runs')) && !present(join(state, 'current.json')),
      'STATE_INVALID', 'Retained run state has no authoritative lease ledger.');
    return [];
  }
  const directory = childDirectory(state, 'lock', create, observe);
  const names = readdirSync(directory);
  const sequences = [];
  for (const name of names) {
    if (/^\.[0-9a-f-]+\.tmp$/u.test(name)) continue;
    const match = /^([1-9]\d*)\.json$/u.exec(name);
    if (match) sequences.push(Number(match[1]));
    else requireCondition(/^[1-9]\d*\.released\.json$/u.test(name), 'STATE_INVALID', 'The lease ledger has an unknown entry.');
  }
  sequences.sort((left, right) => left - right);
  if (sequences.length === 0) requireCondition(!present(join(state, 'runs')) && !present(join(state, 'current.json')),
    'STATE_INVALID', 'Retained run state has no authoritative leases.');
  const ledger = [];
  const generations = new Map();
  for (let index = 0; index < sequences.length; index += 1) {
    const sequence = sequences[index];
    requireCondition(positive(sequence) && sequence === index + 1, 'STATE_INVALID', 'The lease ledger is not contiguous.');
    const value = stateJson(join(directory, `${sequence}.json`));
    requireCondition(validLeaseRecord(value, sequence, repository), 'STATE_INVALID', 'A lease record is invalid.');
    requireCondition(value.generation === (generations.get(value.runId) ?? 0) + 1, 'STATE_INVALID', 'Lease generations are invalid.');
    generations.set(value.runId, value.generation);
    const released = stateJson(join(directory, `${sequence}.released.json`), true);
    requireCondition(released === null || validRelease(released, value), 'STATE_INVALID', 'A release record is invalid.');
    ledger.push({ record: value, released: released !== null });
  }
  for (const name of names.filter((name) => name.endsWith('.released.json'))) {
    const sequence = Number(name.split('.')[0]);
    requireCondition(positive(sequence) && sequence <= ledger.length, 'STATE_INVALID', 'A release has no lease record.');
  }
  return ledger;
}
function runDirectory(repository, runId, create = false, observe = () => {}) {
  requireCondition(uuid(runId), 'INVALID_INPUT', 'A run ID is invalid.');
  const state = create ? stateDirectory(repository, true, observe) : existingState(repository);
  requireCondition(state !== null, 'RUN_NOT_FOUND', 'The run does not exist.');
  const runs = childDirectory(state, 'runs', create, observe);
  return childDirectory(runs, runId, create, observe);
}
export function readPins(repository, runId) {
  const pins = stateJson(join(runDirectory(repository, runId), 'pins.json'));
  requireCondition(validatePins(pins).length === 0 && pins.runId === runId && pins.repositoryKey === repository.repositoryKey
    && pins.commonDir === repository.commonDir, 'STATE_INVALID', 'Pinned run identity is invalid.');
  return pins;
}
function rawCheckpoint(repository, runId) {
  const directory = runDirectory(repository, runId);
  const checkpoint = stateJson(join(directory, 'checkpoint.json'));
  const pins = readPins(repository, runId);
  requireCondition(validateCheckpoint(checkpoint).length === 0 && checkpoint.runId === runId
    && checkpoint.repositoryKey === repository.repositoryKey && checkpoint.pinsDigest === schedulerDigest(pins),
  'STATE_INVALID', 'The checkpoint is invalid.');
  requireCondition(readLedger(repository).some(({ record: item }) => item.runId === runId && item.generation === checkpoint.generation
    && schedulerDigest(item.owner) === schedulerDigest(checkpoint.owner)), 'STATE_INVALID', 'The checkpoint has no matching authoritative lease.');
  return checkpoint;
}
function currentPointer(repository) {
  const state = existingState(repository);
  if (state === null) return null;
  const pointer = stateJson(join(state, 'current.json'), true);
  requireCondition(pointer === null || (exactKeys(pointer, ['schema', 'runId']) && pointer.schema === CURRENT_SCHEMA && uuid(pointer.runId)),
    'STATE_INVALID', 'The current run pointer is invalid.');
  return pointer;
}
export function readSchedulerOwner(repository) {
  verifyRepository(repository);
  const ledger = readLedger(repository);
  const last = ledger.at(-1);
  if (!last) {
    requireCondition(currentPointer(repository) === null, 'STATE_INVALID', 'A current run has no lease.');
    return { lease: null, released: false, state: 'absent' };
  }
  return { lease: last.record, released: last.released, state: last.released ? 'released' : ownerState(last.record.owner) };
}
export function readCheckpoint(repository, runId) {
  verifyRepository(repository);
  const ledger = readLedger(repository);
  const checkpoint = rawCheckpoint(repository, runId);
  const matching = ledger.filter(({ record: item }) => item.runId === runId).at(-1);
  requireCondition(matching && matching.record.generation === checkpoint.generation
    && schedulerDigest(matching.record.owner) === schedulerDigest(checkpoint.owner), 'RECOVERY_REQUIRED', 'The checkpoint owner needs recovery.');
  return checkpoint;
}
export function assertPinsLive(repository, pins) {
  requireCondition(validatePins(pins).length === 0 && pins.repositoryKey === repository.repositoryKey && pins.commonDir === repository.commonDir,
    'INVALID_INPUT', 'The launch pins are invalid.');
  requireCondition(resolveRepository(pins.coordinatorRoot).repositoryKey === repository.repositoryKey,
    'REPOSITORY_INVALID', 'The pinned checkout belongs to another repository.');
  try {
    requireCondition(realpathSync(pins.pluginRoot) === pins.pluginRoot && pluginFingerprint(pins.pluginRoot) === pins.pluginDigest,
      'PINS_CHANGED', 'The pinned plugin content changed.');
    for (const path of [pins.nodePath, pins.enginePath]) requireCondition(realpathSync(path) === path && lstatSync(path).isFile(),
      'PINS_CHANGED', 'A pinned executable changed.');
    const metadata = JSON.parse(readRegularFile(join(pins.pluginRoot, '.claude-plugin', 'plugin.json')));
    requireCondition(metadata.version === pins.pluginVersion, 'PINS_CHANGED', 'The pinned plugin version changed.');
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('PINS_CHANGED', 'Pinned implementation content cannot be verified.');
  }
}
function newCheckpoint(repository, pins, initiator, owner, generation) {
  const now = Date.now();
  return {
    schema: CHECKPOINT_SCHEMA, runId: pins.runId, repositoryKey: repository.repositoryKey, generation, revision: 1,
    owner, initiator, pinsDigest: schedulerDigest(pins), state: 'starting', desiredState: 'running', stopMode: null,
    queueEnabled: false, units: [], reservations: [], workers: [], requests: {}, outbox: {},
    createdAt: now, updatedAt: now, stoppedAt: null, error: null,
  };
}
// Both upgraded start paths hold this short gate until lifetime ownership is
// published. The immutable link election is the same primitive as the scheduler
// lease: no stale rename, age threshold or unknown-owner takeover is used.
export function withExecutionAdmission(repository, establish, { observe = () => {} } = {}) {
  verifyRepository(repository);
  const directory = childDirectory(stateDirectory(repository, true, observe), 'admission', true, observe);
  const owner = readProcessIdentity();
  const until = Date.now() + 10_000;
  let identity;
  for (;;) {
    const names = readdirSync(directory).filter((name) => !/^\.[0-9a-f-]+\.tmp$/u.test(name));
    requireCondition(names.every((name) => /^[1-9]\d*(?:\.released)?\.json$/u.test(name)), 'STATE_INVALID', 'The admission ledger has an unknown entry.');
    const sequences = names.filter((name) => /^\d+\.json$/u.test(name)).map((name) => Number(name.split('.')[0])).sort((a, b) => a - b);
    requireCondition(sequences.every((sequence, index) => sequence === index + 1), 'STATE_INVALID', 'The admission ledger is not contiguous.');
    let previous = null;
    for (const sequence of sequences) {
      const item = stateJson(join(directory, `${sequence}.json`));
      requireCondition(exactKeys(item, ['schema', 'sequence', 'leaseId', 'repositoryKey', 'owner', 'createdAt'])
        && item.schema === 'autoloop.execution-admission/1' && item.sequence === sequence && uuid(item.leaseId)
        && item.repositoryKey === repository.repositoryKey && validProcess(item.owner) && timestamp(item.createdAt),
      'STATE_INVALID', 'An admission record is invalid.');
      const release = stateJson(join(directory, `${sequence}.released.json`), true);
      requireCondition(release === null || validRelease(release, item), 'STATE_INVALID', 'An admission release is invalid.');
      previous = { item, released: release !== null };
    }
    requireCondition(names.filter((name) => name.endsWith('.released.json')).every((name) => Number(name.split('.')[0]) <= sequences.length),
      'STATE_INVALID', 'An admission release has no owner.');
    if (previous && !previous.released) {
      const state = ownerState(previous.item.owner);
      requireCondition(state !== 'unknown', 'OWNER_UNVERIFIED', 'The admission owner cannot be verified.');
      if (state === 'alive') {
        const error = new SchedulerError('ADMISSION_BUSY', 'Repository admission is held by another process.');
        error.owner = previous.item.owner;
        if (schedulerDigest(owner) === schedulerDigest(previous.item.owner) || Date.now() >= until) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
    }
    identity = { schema: 'autoloop.execution-admission/1', sequence: sequences.length + 1, leaseId: randomUUID(),
      repositoryKey: repository.repositoryKey, owner, createdAt: Date.now() };
    try {
      durableWrite(join(directory, `${identity.sequence}.json`), identity, { exclusive: true, observe });
      break;
    } catch (error) {
      if (error.code !== 'STATE_CONFLICT') throw error;
    }
  }
  const fence = () => {
    const later = join(directory, `${identity.sequence + 1}.json`);
    requireCondition(!present(later) && schedulerDigest(readProcessIdentity()) === schedulerDigest(owner)
      && schedulerDigest(stateJson(join(directory, `${identity.sequence}.json`))) === schedulerDigest(identity),
    'LEASE_INVALID', 'Repository admission was superseded.');
  };
  try {
    fence();
    const result = establish(fence);
    requireCondition(!result || typeof result.then !== 'function', 'INVALID_INPUT', 'Repository admission must be synchronous.');
    fence();
    return result;
  } finally {
    fence();
    durableWrite(join(directory, `${identity.sequence}.released.json`), { schema: RELEASE_SCHEMA, sequence: identity.sequence,
      leaseId: identity.leaseId, owner, releasedAt: Date.now() }, { exclusive: true, observe });
  }
}

export function assertNoSchedulerOwner(repository) {
  const held = readSchedulerOwner(repository);
  const refuse = (code, message) => {
    const error = new SchedulerError(code, message);
    Object.assign(error, { owner: held.lease?.owner ?? null, runId: held.lease?.runId ?? null });
    throw error;
  };
  if (held.state === 'unknown') refuse('OWNER_UNVERIFIED', 'The scheduler owner cannot be verified.');
  if (held.state === 'alive') refuse('SCHEDULER_ACTIVE', 'A scheduler owns this repository.');
  if (held.lease === null) return;
  const current = readCurrentCheckpoint(repository);
  if (!current || current.state !== 'stopped' || retainedWorkers(current) || hasUnresolvedEffects(current) || pendingRequests(repository, current)) {
    refuse('SCHEDULER_ACTIVE', 'The scheduler run needs recovery before legacy admission.');
  }
}
function assertNoLegacyWorkers(repository) {
  const workers = runningDispatches(repository.coordinatorRoot);
  // A platform without /proc cannot inspect legacy detached dispatches. Legacy
  // runs must be drained before migration; absence here is not all-version proof.
  if (workers === null) return;
  const worker = workers[0];
  if (worker) {
    const error = new SchedulerError('LEGACY_RUN_ACTIVE', 'A legacy dispatch still occupies this repository.');
    Object.assign(error, { owner: readProcessIdentity(worker.pid), workerPid: worker.pid });
    throw error;
  }
}
export function acquireScheduler(repository, pins, initiator, options = {}) {
  return withExecutionAdmission(repository, () => {
    assertNoKnownLegacyOwner(repository);
    assertNoLegacyWorkers(repository);
    options.admissionObserve?.('daemon-admission-checked');
    return acquireSchedulerWithinAdmission(repository, pins, initiator, options);
  }, { observe: options.observe });
}
function acquireSchedulerWithinAdmission(repository, pins, initiator, { observe = () => {} } = {}) {
  verifyRepository(repository);
  assertPinsLive(repository, pins);
  requireCondition(validInitiator(initiator), 'INVALID_INPUT', 'The initiating identity is invalid.');
  const ledger = readLedger(repository, true, observe);
  const previous = ledger.at(-1);
  if (previous && !previous.released) {
    const state = ownerState(previous.record.owner, observe);
    requireCondition(state !== 'unknown', 'OWNER_UNVERIFIED', 'The preceding owner cannot be verified.');
    if (state !== 'dead') {
      const error = new SchedulerError('SCHEDULER_ACTIVE', 'A scheduler already owns this repository.');
      Object.assign(error, { owner: previous.record.owner, runId: previous.record.runId });
      throw error;
    }
  }
  const pointer = currentPointer(repository);
  if (pointer && !ledger.some(({ record: item }) => item.runId === pointer.runId)) {
    requireCondition(readLedger(repository).length === ledger.length, 'SCHEDULER_ACTIVE', 'Another scheduler acquired the repository.');
    throw new SchedulerError('STATE_INVALID', 'The current pointer has no lease.');
  }
  const previousId = previous?.record.runId ?? pointer?.runId ?? null;
  let recovered = null;
  if (previousId !== null) {
    const path = join(stateDirectory(repository), 'runs', previousId);
    if (present(path) && present(join(safeDirectory(path), 'checkpoint.json'))) recovered = rawCheckpoint(repository, previousId);
    if (recovered === null || recovered.state !== 'stopped' || retainedWorkers(recovered) || hasUnresolvedEffects(recovered) || pendingRequests(repository, recovered)) {
      requireCondition(previousId === pins.runId, 'RUN_MISMATCH', 'Recover the preceding run before starting another.');
    }
  }
  if (recovered && recovered.runId === pins.runId) {
    requireCondition(recovered.state !== 'stopped' || retainedWorkers(recovered) || hasUnresolvedEffects(recovered) || pendingRequests(repository, recovered),
      'RUN_ENDED', 'A completed stopped run cannot be reopened.');
    requireCondition(schedulerDigest(readPins(repository, pins.runId)) === schedulerDigest(pins), 'PINS_CHANGED', 'The run pins changed.');
  } else requireCondition(!ledger.some(({ record: item }) => item.runId === pins.runId) || recovered === null,
    'RUN_ENDED', 'A previous run ID cannot be reused.');
  const owner = readProcessIdentity();
  const generation = (ledger.filter(({ record: item }) => item.runId === pins.runId).at(-1)?.record.generation ?? 0) + 1;
  const sequence = ledger.length + 1;
  const identity = { schema: LEASE_SCHEMA, sequence, leaseId: randomUUID(), repositoryKey: repository.repositoryKey,
    runId: pins.runId, generation, owner, createdAt: Date.now() };
  const lock = childDirectory(stateDirectory(repository), 'lock');
  try {
    durableWrite(join(lock, `${sequence}.json`), identity, { exclusive: true, observe });
  } catch (error) {
    if (error.code === 'STATE_CONFLICT') throw new SchedulerError('SCHEDULER_ACTIVE', 'Another scheduler acquired the repository.');
    throw error;
  }
  const lease = Object.freeze({});
  const binding = { repository: Object.freeze({ ...repository }), identity, active: true, observe, writing: false };
  leases.set(lease, binding);
  try {
    const directory = runDirectory(repository, pins.runId, true, observe);
    childDirectory(directory, 'streams', true, observe);
    const pinPath = join(directory, 'pins.json');
    if (present(pinPath)) requireCondition(schedulerDigest(readPins(repository, pins.runId)) === schedulerDigest(pins), 'PINS_CHANGED', 'The immutable pins changed.');
    else durableWrite(pinPath, pins, { exclusive: true, observe });
    let checkpoint = recovered?.runId === pins.runId ? {
      ...recovered, generation, revision: recovered.revision + 1, owner, state: 'recovering', updatedAt: Math.max(Date.now(), recovered.updatedAt), stoppedAt: null,
    } : newCheckpoint(repository, pins, initiator, owner, generation);
    // Interrupted effects survive acquisition as unknown; recovery must read
    // the actual effect before any new attempt. Worker bindings remain intact.
    checkpoint = recoverEffects(checkpoint);
    requireCondition(validateCheckpoint(checkpoint).length === 0, 'STATE_INVALID', 'The recovered checkpoint is invalid.');
    durableWrite(join(directory, 'checkpoint.json'), checkpoint, { observe });
    durableWrite(join(stateDirectory(repository), 'current.json'), { schema: CURRENT_SCHEMA, runId: pins.runId }, { observe });
    return { runId: pins.runId, generation, lease };
  } catch (error) {
    binding.active = false;
    try { publishRelease(binding); } catch { /* incomplete acquisition remains visible */ }
    throw error;
  }
}
function heldLease(lease, allowWriting = false) {
  const binding = leases.get(lease);
  requireCondition(binding?.active === true, 'LEASE_INVALID', 'The writer lease is not active.');
  requireCondition(allowWriting || !binding.writing, 'STATE_BUSY', 'Another checkpoint transition is in progress.');
  const owner = readProcessIdentity();
  const last = readLedger(binding.repository).at(-1);
  requireCondition(last && !last.released && canonicalJson(last.record) === canonicalJson(binding.identity)
    && schedulerDigest(owner) === schedulerDigest(binding.identity.owner), 'LEASE_INVALID', 'The writer lease was superseded.');
  return binding;
}
export function commitTransition(lease, expectedRevision, transition) {
  const binding = heldLease(lease);
  binding.writing = true;
  try {
    return writeTransition(lease, binding, expectedRevision, transition);
  } finally {
    binding.writing = false;
  }
}
function writeTransition(lease, binding, expectedRevision, transition) {
  const current = readCheckpoint(binding.repository, binding.identity.runId);
  requireCondition(current.generation === binding.identity.generation, 'LEASE_INVALID', 'The writer generation changed.');
  requireCondition(current.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
  requireCondition(typeof transition === 'function', 'INVALID_INPUT', 'A state transition is required.');
  const proposed = transition(JSON.parse(canonicalJson(current)));
  requireCondition(record(proposed), 'STATE_INVALID', 'The transition returned invalid state.');
  requireCondition(proposed.queueEnabled === false, 'UNSUPPORTED_ACTION', 'Production queue execution is not available.');
  for (const key of ['schema', 'runId', 'repositoryKey', 'generation', 'revision', 'owner', 'initiator', 'pinsDigest', 'createdAt']) {
    requireCondition(canonicalJson(proposed[key]) === canonicalJson(current[key]), 'STATE_INVALID', 'A transition changed immutable run identity.');
  }
  const updated = { ...proposed, revision: current.revision + 1, updatedAt: Date.now(),
    stoppedAt: proposed.state === 'stopped' ? proposed.stoppedAt ?? Date.now() : proposed.stoppedAt };
  requireCondition(validateCheckpoint(updated).length === 0, 'STATE_INVALID', 'The transition returned invalid state.');
  validatePersistentTransition(binding, current, updated);
  for (const worker of current.workers) {
    const kept = updated.workers.find((item) => item.attemptId === worker.attemptId);
    requireCondition(kept !== undefined || boundGroupState(worker) === 'empty', 'OWNER_UNVERIFIED', 'A live or uncertain worker binding cannot be erased.');
    if (current.desiredState === 'stopped' && current.stopMode === 'immediate' && worker.cancelledByOperator) {
      requireCondition(kept !== undefined, 'STATE_INVALID', 'Immediate stop must retain its complete target set.');
    }
    if (kept) {
      requireCondition(canonicalJson({ ...kept, cancelledByOperator: worker.cancelledByOperator }) === canonicalJson(worker)
        && (!worker.cancelledByOperator || kept.cancelledByOperator), 'STATE_INVALID', 'A worker binding changed identity or cancellation.');
    }
  }
  requireCondition(!(current.state === 'recovering' && ['running', 'paused'].includes(updated.state)
    && (hasUnresolvedEffects(updated) || updated.workers.some((worker) => worker.generation < updated.generation && boundGroupState(worker) !== 'empty'))),
    'RECOVERY_REQUIRED', 'Uncertain effects and workers must be reconciled first.');
  // Recheck after the reducer and before publication; nested writes are refused.
  heldLease(lease, true);
  requireCondition(readCheckpoint(binding.repository, binding.identity.runId).revision === expectedRevision,
    'REVISION_MISMATCH', 'The checkpoint revision changed during the transition.');
  try {
    durableWrite(join(runDirectory(binding.repository, current.runId), 'checkpoint.json'), updated, { observe: binding.observe });
  } catch (error) {
    binding.active = false;
    throw error;
  }
  return updated;
}
function publishRelease(binding) {
  const { repository, identity } = binding;
  durableWrite(join(childDirectory(stateDirectory(repository), 'lock'), `${identity.sequence}.released.json`), {
    schema: RELEASE_SCHEMA, sequence: identity.sequence, leaseId: identity.leaseId, owner: identity.owner, releasedAt: Date.now(),
  }, { exclusive: true, observe: binding.observe });
}
export function releaseScheduler(lease) {
  const binding = heldLease(lease);
  const checkpoint = readCheckpoint(binding.repository, binding.identity.runId);
  requireCondition(['stopped', 'failed'].includes(checkpoint.state), 'RUN_ACTIVE', 'Drain and record the run before releasing it.');
  // Revoke locally before publication lets a successor acquire the repository.
  binding.active = false;
  publishRelease(binding);
}
function recoverEffects(checkpoint) {
  const outbox = Object.fromEntries(Object.entries(checkpoint.outbox).map(([id, effect]) => [id,
    effect.phase === 'in-flight' ? { ...effect, phase: 'unknown', receipt: null,
      error: { code: 'OUTCOME_UNKNOWN', message: 'The interrupted effect needs readback.' } } : effect]));
  const requests = Object.fromEntries(Object.entries(checkpoint.requests).map(([id, request]) => {
    if (!['processing', 'unknown'].includes(request.status)) return [id, request];
    const linked = Object.values(outbox).find((effect) => effect.requestId === id && ['in-flight', 'unknown'].includes(effect.phase));
    return [id, { ...request, status: 'unknown', outcome: outcomeFor(request, 'unknown', 'OUTCOME_UNKNOWN', null, linked?.operationId ?? null) }];
  }));
  return { ...checkpoint, outbox, requests };
}
export function hasUnresolvedEffects(checkpoint) {
  return Object.values(checkpoint.outbox ?? {}).some((effect) => ['prepared', 'in-flight', 'unknown'].includes(effect.phase));
}

function retainedWorkers(checkpoint) {
  return checkpoint.workers.some((worker) => boundGroupState(worker) !== 'empty');
}
export function boundGroupState(worker) {
  requireCondition(validWorker(worker), 'INVALID_INPUT', 'The worker binding is invalid.');
  const leader = ownerState(worker.groupLeader);
  const processState = ownerState(worker.process);
  if (leader === 'dead' && processState === 'dead') {
    try { process.kill(-worker.pgid, 0); }
    catch (error) { if (error.code === 'ESRCH') return 'empty'; }
  }
  if (leader !== 'alive' || processState !== 'alive') return 'unknown';
  return processGroupOf(worker.groupLeader.pid) === worker.pgid && processGroupOf(worker.process.pid) === worker.pgid
    && worker.groupLeader.pid === worker.pgid ? 'alive' : 'unknown';
}
export function processGroupOf(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readRegularFile(`/proc/${pid}/stat`);
      const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      return positive(group) ? group : null;
    }
    const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const group = Number(result.stdout?.trim());
    return result.status === 0 && positive(group) ? group : null;
  } catch { return null; }
}
// The trusted launcher supplies this binding, not a worker result or event line.
// Tool guards must match the persisted binding before admitting model tools.
export function registerWorker(lease, expectedRevision, worker, { guardDirectory } = {}) {
  const binding = heldLease(lease);
  requireCondition(validWorker(worker) && worker.runId === binding.identity.runId && worker.generation === binding.identity.generation,
    'TARGET_MISMATCH', 'The worker binding names another attempt or generation.');
  requireCondition(schedulerDigest(readProcessIdentity(worker.process.pid)) === schedulerDigest(worker.process)
    && schedulerDigest(readProcessIdentity(worker.groupLeader.pid)) === schedulerDigest(worker.groupLeader)
    && processGroupOf(worker.process.pid) === worker.pgid && processGroupOf(worker.groupLeader.pid) === worker.pgid,
  'OWNER_UNVERIFIED', 'The worker process group cannot be verified.');
  const common = gitFact(binding.repository.coordinatorRoot, ['--path-format=absolute', '--git-common-dir']);
  const observed = spawnSync('git', ['--git-dir', worker.worktreeGitDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8', timeout: 15000,
  });
  requireCondition(realpathSync(worker.worktreeGitDir) === worker.worktreeGitDir && observed.status === 0
    && realpathSync(observed.stdout.trim()) === realpathSync(common), 'TARGET_MISMATCH', 'The worker worktree belongs to another repository.');
  const streams = childDirectory(runDirectory(binding.repository, worker.runId), 'streams');
  requireCondition(dirname(worker.liveFile) === streams && nonempty(relative(streams, worker.liveFile))
    && !relative(streams, worker.liveFile).startsWith('..'), 'TARGET_MISMATCH', 'The worker stream is outside its run.');
  const current = readCheckpoint(binding.repository, worker.runId);
  requireCondition(current.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
  const previous = current.workers.find((item) => item.attemptId === worker.attemptId);
  if (previous) {
    requireCondition(schedulerDigest(previous) === schedulerDigest(worker), 'TARGET_MISMATCH', 'The attempt already has another binding.');
    return current;
  }
  requireCondition(!['stopped', 'failed'].includes(current.state) && current.desiredState !== 'stopped', 'RUN_ACTIVE', 'This run cannot start another worker.');
  requireCondition(!current.workers.some((item) => item.unitId === worker.unitId || item.sessionId === worker.sessionId),
    'TARGET_MISMATCH', 'The unit or session already has a worker binding.');
  const pins = readPins(binding.repository, worker.runId);
  assertPinsLive(binding.repository, pins);
  try {
    publishWorkerGuard(binding.repository, worker, { baseBranch: pins.baseBranch, pinsDigest: current.pinsDigest }, { directory: guardDirectory });
  } catch { throw new SchedulerError('STATE_IO_FAILED', 'The immutable worker guard binding cannot be published.'); }
  if (!present(worker.liveFile)) {
    const fd = openSync(worker.liveFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(streams);
  } else readRegularFile(worker.liveFile);
  return commitTransition(lease, expectedRevision, (value) => ({ ...value, workers: [...value.workers, worker] }));
}

const CONTROL_KEYS = ['schema', 'requestId', 'runId', 'kind', 'target', 'payload', 'submittedAt', 'actor'];
const RUN_CONTROLS = new Set(['pause', 'resume', 'stop', 'stop-now']);
function validActor(value) {
  return exactKeys(value, ['kind', 'sessionId', 'host', 'invocationId']) && ['mod', 'terminal'].includes(value.kind)
    && (value.kind === 'mod' ? uuid(value.sessionId) : value.sessionId === null) && validProcess(value.host) && uuid(value.invocationId);
}
function validOid(value) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}
export function validateControl(value) {
  if (!exactKeys(value, CONTROL_KEYS) || value.schema !== CONTROL_SCHEMA || !uuid(value.requestId) || !uuid(value.runId)
    || !timestamp(value.submittedAt) || !validActor(value.actor) || !safeValues(value)) return ['Control identity is invalid.'];
  const target = value.target;
  if (RUN_CONTROLS.has(value.kind)) return exactKeys(target, ['type', 'generation']) && target.type === 'run' && positive(target.generation)
    && exactKeys(value.payload, []) ? [] : ['Run control target is invalid.'];
  if (value.kind === 'cancel') return exactKeys(target, ['type', 'unitId', 'unitGeneration', 'attemptId']) && target.type === 'unit'
    && uuid(target.unitId) && positive(target.unitGeneration) && uuid(target.attemptId) && exactKeys(value.payload, []) ? [] : ['Cancel target is invalid.'];
  if (value.kind === 'answer') return exactKeys(target, ['type', 'unitId', 'unitGeneration', 'issue']) && target.type === 'unit'
    && uuid(target.unitId) && positive(target.unitGeneration) && positive(target.issue)
    && exactKeys(value.payload, ['text']) && nonempty(value.payload.text) ? [] : ['Answer target is invalid.'];
  if (['merge', 'label'].includes(value.kind)) return exactKeys(target, ['type', 'unitId', 'unitGeneration', 'pr', 'expectedHead'])
    && target.type === 'pr' && uuid(target.unitId) && positive(target.unitGeneration) && positive(target.pr)
    && validOid(target.expectedHead) && exactKeys(value.payload, []) ? [] : ['PR control target is invalid.'];
  return ['Control kind is unsupported.'];
}
export function controlDigest(control) {
  return schedulerDigest(Object.fromEntries(['schema', 'requestId', 'runId', 'kind', 'target', 'payload'].map((key) => [key, control[key]])));
}
function validOutcome(value) {
  return exactKeys(value, ['schema', 'requestId', 'runId', 'requestHash', 'status', 'code', 'appliedRevision', 'operationId', 'completedAt'])
    && value.schema === OUTCOME_SCHEMA && uuid(value.requestId) && uuid(value.runId) && hash(value.requestHash)
    && ['applied', 'refused', 'unknown'].includes(value.status) && nonempty(value.code) && /^[A-Z][A-Z0-9_]*$/u.test(value.code)
    && (value.operationId === null || uuid(value.operationId)) && (value.status === 'unknown'
      ? value.appliedRevision === null && value.completedAt === null : positive(value.appliedRevision) && timestamp(value.completedAt));
}
function validRequestRecord(value, checkpoint, id) {
  if (!exactKeys(value, ['requestHash', 'request', 'status', 'claimedGeneration', 'outcome']) || validateControl(value.request).length !== 0
    || value.request.requestId !== id || value.request.runId !== checkpoint.runId || value.requestHash !== controlDigest(value.request)
    || !['pending', 'processing', 'applied', 'refused', 'unknown'].includes(value.status)) return false;
  if (value.status === 'pending') return value.claimedGeneration === null && value.outcome === null;
  if (!positive(value.claimedGeneration) || value.claimedGeneration > checkpoint.generation) return false;
  if (value.status === 'processing') return value.outcome === null;
  return validOutcome(value.outcome) && value.outcome.requestId === id && value.outcome.runId === checkpoint.runId
    && value.outcome.requestHash === value.requestHash && value.outcome.status === value.status
    && (value.outcome.appliedRevision === null || value.outcome.appliedRevision <= checkpoint.revision)
    && (value.outcome.operationId === null || checkpoint.outbox?.[value.outcome.operationId]?.requestId === id);
}
function controlDirectory(repository, part, create = false, observe = () => {}) {
  let directory = safeDirectory(repository.commonDir);
  for (const name of ['autoloop', 'control', 'v2', part]) {
    const next = join(directory, name);
    if (!create && !present(next)) return null;
    directory = childDirectory(directory, name, create, observe);
  }
  return directory;
}
function immutableControl(repository, requestId, optional = false) {
  requireCondition(uuid(requestId), 'INVALID_INPUT', 'A request ID is invalid.');
  const directory = controlDirectory(repository, 'requests');
  if (directory === null) {
    requireCondition(optional, 'REQUEST_NOT_FOUND', 'The request does not exist.');
    return null;
  }
  const control = stateJson(join(directory, `${requestId}.json`), true);
  requireCondition(control !== null || optional, 'REQUEST_NOT_FOUND', 'The request does not exist.');
  requireCondition(control === null || (validateControl(control).length === 0 && control.requestId === requestId),
    'STATE_INVALID', 'The immutable request is invalid.');
  return control;
}
function queuedRequestIds(repository, runId, checkpoint) {
  const directory = controlDirectory(repository, 'requests');
  if (directory === null) return [];
  const ids = [];
  for (const name of readdirSync(directory)) {
    if (/^\.[0-9a-f-]+\.tmp$/u.test(name)) continue;
    requireCondition(name.endsWith('.json') && uuid(name.slice(0, -5)), 'STATE_INVALID', 'A request filename is invalid.');
    const id = name.slice(0, -5);
    const control = immutableControl(repository, id);
    if (runId !== null && control.runId !== runId) continue;
    const observed = checkpoint ?? readCheckpoint(repository, control.runId);
    if (!['applied', 'refused'].includes(observed.requests[id]?.status)) ids.push(id);
  }
  return ids.sort();
}
export function listControlRequests(repository, runId = null) {
  verifyRepository(repository);
  return queuedRequestIds(repository, runId, runId === null ? null : readCheckpoint(repository, runId));
}
function pendingRequests(repository, checkpoint) {
  return queuedRequestIds(repository, checkpoint.runId, checkpoint).length > 0;
}
function responseOf(request) {
  return { requestId: request.request.requestId, runId: request.request.runId, status: request.status, outcome: request.outcome };
}
export function readCurrentCheckpoint(repository) {
  verifyRepository(repository);
  const pointer = currentPointer(repository);
  const latest = readLedger(repository).at(-1);
  if (pointer === null) {
    requireCondition(!latest, 'RECOVERY_REQUIRED', 'The current run pointer needs recovery.');
    return null;
  }
  requireCondition(latest?.record.runId === pointer.runId, 'RECOVERY_REQUIRED', 'The current run pointer needs recovery.');
  return readCheckpoint(repository, pointer.runId);
}
export function readRequest(repository, runId, requestId) {
  requireCondition(uuid(requestId), 'INVALID_INPUT', 'A request ID is invalid.');
  const checkpoint = readCheckpoint(repository, runId);
  if (checkpoint.requests[requestId]) return responseOf(checkpoint.requests[requestId]);
  const control = immutableControl(repository, requestId);
  requireCondition(control.runId === runId, 'RUN_MISMATCH', 'The request belongs to another run.');
  return { requestId, runId, status: 'pending', outcome: null };
}
// Internal storage provider, not operator admission. The host layer must first
// admit this actor through its provenance/receipt or terminal route. No mutation
// CLI is exposed here. JSON actor/by/env fields are not a host authorization API.
export function submitControl(repository, admittedActor, request, { observe = () => {} } = {}) {
  requireCondition(exactKeys(request, CONTROL_KEYS.filter((key) => key !== 'actor')) && validActor(admittedActor),
    'INVALID_INPUT', 'The request or admitted actor is invalid.');
  const control = { ...request, actor: admittedActor };
  requireCondition(validateControl(control).length === 0, 'INVALID_INPUT', 'The request is invalid.');
  verifyRepository(repository);
  const current = readCurrentCheckpoint(repository);
  requireCondition(current !== null, 'RUN_MISMATCH', 'There is no current run for this request.');
  requireCondition(ownerState(admittedActor.host) === 'alive' && !current.workers.some((worker) =>
    [worker.process.pid, worker.groupLeader.pid].includes(admittedActor.host.pid)
      || (admittedActor.sessionId !== null && worker.sessionId === admittedActor.sessionId)),
  'HOST_AUTH_REQUIRED', 'A worker cannot submit an operator request.');
  let checkpoint = current;
  if (control.runId !== current.runId) {
    const path = join(stateDirectory(repository), 'runs', control.runId);
    if (present(path)) checkpoint = readCheckpoint(repository, control.runId);
  }
  const recorded = checkpoint.runId === control.runId ? checkpoint.requests[control.requestId] : null;
  if (recorded) {
    requireCondition(recorded.requestHash === controlDigest(control), 'REQUEST_ID_CONFLICT', 'The request ID has another payload.');
    return responseOf(recorded);
  }
  requireCondition(control.runId === current.runId, 'RUN_MISMATCH', 'The request names another run.');
  requireCondition(RUN_CONTROLS.has(control.kind), 'UNSUPPORTED_ACTION', 'Unit actions are not available in this module.');
  requireCondition(current.state !== 'stopped', 'RUN_ENDED', 'The run is stopped.');
  const requests = controlDirectory(repository, 'requests', true, observe);
  const path = join(requests, `${control.requestId}.json`);
  try {
    durableWrite(path, control, { exclusive: true, observe });
  } catch (error) {
    if (error.code !== 'STATE_CONFLICT') throw error;
    const existing = immutableControl(repository, control.requestId);
    requireCondition(controlDigest(existing) === controlDigest(control), 'REQUEST_ID_CONFLICT', 'The request ID has another payload.');
  }
  const original = immutableControl(repository, control.requestId);
  const pending = controlDirectory(repository, 'pending', true, observe);
  const processing = controlDirectory(repository, 'processing', true, observe);
  const pendingPath = join(pending, `${control.requestId}.json`);
  const processingPath = join(processing, `${control.requestId}.json`);
  if (present(processingPath)) checkTransport(processingPath, original);
  else {
    try { durableWrite(pendingPath, original, { exclusive: true, observe }); }
    catch (error) {
      if (error.code !== 'STATE_CONFLICT') throw error;
      checkTransport(pendingPath, original);
    }
  }
  const latest = readCurrentCheckpoint(repository);
  requireCondition(latest?.runId === control.runId, 'RUN_MISMATCH', 'The run ended before request publication completed.');
  requireCondition(latest.state !== 'stopped', 'RUN_ENDED', 'The run stopped before request publication completed.');
  return readRequest(repository, control.runId, control.requestId);
}
function outcomeFor(request, status, code, revision, operationId = null) {
  return { schema: OUTCOME_SCHEMA, requestId: request.request.requestId, runId: request.request.runId,
    requestHash: request.requestHash, status, code, appliedRevision: status === 'unknown' ? null : revision,
    operationId, completedAt: status === 'unknown' ? null : Date.now() };
}
function publishOutcome(repository, outcome, observe = () => {}) {
  const directory = controlDirectory(repository, 'outcomes', true, observe);
  const path = join(directory, `${outcome.requestId}.json`);
  const previous = stateJson(path, true);
  if (previous !== null) {
    requireCondition(validOutcome(previous) && previous.requestHash === outcome.requestHash,
      'STATE_INVALID', 'The outcome transport is invalid.');
    if (schedulerDigest(previous) === schedulerDigest(outcome)) return;
    requireCondition(previous.status === 'unknown', 'STATE_INVALID', 'A final outcome cannot be replaced.');
  }
  durableWrite(path, outcome, { exclusive: previous === null, observe });
}
function checkTransport(path, control) {
  const value = stateJson(path);
  requireCondition(validateControl(value).length === 0 && canonicalJson(value) === canonicalJson(control),
    'STATE_INVALID', 'The request transport changed.');
}
function claimTransport(binding, control) {
  const requestId = control.requestId;
  const processing = controlDirectory(binding.repository, 'processing', true, binding.observe);
  const processingPath = join(processing, `${requestId}.json`);
  if (present(processingPath)) checkTransport(processingPath, control);
  else {
    const pending = controlDirectory(binding.repository, 'pending', true, binding.observe);
    const pendingPath = join(pending, `${requestId}.json`);
    if (present(pendingPath)) {
      checkTransport(pendingPath, control);
      renameSync(pendingPath, processingPath);
      syncDirectory(pending);
      syncDirectory(processing);
      binding.observe('control-claimed', processingPath);
    } else durableWrite(processingPath, control, { exclusive: true, observe: binding.observe });
  }
}
// A producer can publish after an old run stops. The current exclusive
// repository writer may append a refusal to that ended run, never replay its
// effects or reopen its state. Historical execution owner/generation stay bound
// to their original lease; the current lease fences this administrative write.
function refuseForeignControl(lease, binding, control) {
  const current = readCheckpoint(binding.repository, control.runId);
  const previous = current.requests[control.requestId];
  if (previous && ['applied', 'refused'].includes(previous.status)) return { ...responseOf(previous), claimedNow: false };
  requireCondition(['stopped', 'failed'].includes(current.state), 'RUN_MISMATCH', 'The request belongs to another active run.');
  requireCondition(!Object.values(current.outbox).some((effect) => effect.requestId === control.requestId
    && ['prepared', 'in-flight', 'unknown'].includes(effect.phase)), 'OUTCOME_UNKNOWN', 'The historical request needs effect reconciliation.');
  claimTransport(binding, control);
  const claimed = previous ?? { requestHash: controlDigest(control), request: control, status: 'processing',
    claimedGeneration: current.generation, outcome: null };
  const outcome = outcomeFor(claimed, 'refused', 'RUN_MISMATCH', current.revision + 1);
  const updated = { ...current, revision: current.revision + 1, updatedAt: Math.max(Date.now(), current.updatedAt),
    requests: { ...current.requests, [control.requestId]: { ...claimed, status: 'refused', outcome } } };
  requireCondition(validateCheckpoint(updated).length === 0, 'STATE_INVALID', 'The historical refusal is invalid.');
  validatePersistentTransition(binding, current, updated);
  binding.writing = true;
  try {
    heldLease(lease, true);
    requireCondition(readCheckpoint(binding.repository, control.runId).revision === current.revision,
      'REVISION_MISMATCH', 'The historical checkpoint changed.');
    durableWrite(join(runDirectory(binding.repository, control.runId), 'checkpoint.json'), updated, { observe: binding.observe });
  } catch (error) {
    binding.active = false;
    throw error;
  } finally {
    binding.writing = false;
  }
  publishOutcome(binding.repository, outcome, binding.observe);
  return { ...responseOf(updated.requests[control.requestId]), claimedNow: true };
}
export function claimControl(lease, requestId) {
  const binding = heldLease(lease);
  requireCondition(uuid(requestId), 'INVALID_INPUT', 'A request ID is invalid.');
  const current = readCheckpoint(binding.repository, binding.identity.runId);
  if (current.requests[requestId]) return { ...responseOf(current.requests[requestId]), claimedNow: false };
  const control = immutableControl(binding.repository, requestId);
  if (control.runId !== current.runId) return refuseForeignControl(lease, binding, control);
  claimTransport(binding, control);
  let refusal = null;
  if (!RUN_CONTROLS.has(control.kind)) refusal = 'UNSUPPORTED_ACTION';
  else if (control.target.generation !== current.generation) refusal = 'TARGET_MISMATCH';
  else if (current.workers.some((worker) => [worker.process.pid, worker.groupLeader.pid].includes(control.actor.host.pid)
    || (control.actor.sessionId !== null && control.actor.sessionId === worker.sessionId))) refusal = 'HOST_AUTH_REQUIRED';
  const claimed = { requestHash: controlDigest(control), request: control, status: refusal ? 'refused' : 'processing',
    claimedGeneration: current.generation, outcome: null };
  if (refusal) claimed.outcome = outcomeFor(claimed, 'refused', refusal, current.revision + 1);
  const updated = commitTransition(lease, current.revision, (value) => ({ ...value, requests: { ...value.requests, [requestId]: claimed } }));
  if (claimed.outcome) publishOutcome(binding.repository, claimed.outcome, binding.observe);
  return { ...responseOf(updated.requests[requestId]), claimedNow: true };
}
export function completeControl(lease, requestId, result, transition = (value) => value) {
  const binding = heldLease(lease);
  requireCondition(uuid(requestId) && exactKeys(result, ['status', 'code', 'operationId'])
    && ['applied', 'refused'].includes(result.status) && nonempty(result.code) && /^[A-Z][A-Z0-9_]*$/u.test(result.code)
    && (result.operationId === null || uuid(result.operationId)), 'INVALID_INPUT', 'The control result is invalid.');
  const current = readCheckpoint(binding.repository, binding.identity.runId);
  const request = current.requests[requestId];
  requireCondition(request, 'REQUEST_NOT_FOUND', 'The request has not been claimed.');
  if (['applied', 'refused'].includes(request.status)) {
    requireCondition(request.status === result.status && request.outcome.code === result.code
      && request.outcome.operationId === result.operationId, 'REQUEST_SETTLED', 'The request already has another outcome.');
    return current;
  }
  const linked = Object.values(current.outbox).filter((effect) => effect.requestId === requestId);
  requireCondition(linked.every((effect) => !['prepared', 'in-flight', 'unknown'].includes(effect.phase)),
    'OUTCOME_UNKNOWN', 'The request has an unresolved effect.');
  if (result.status === 'applied') requireCondition(linked.every((effect) => effect.phase === 'succeeded'),
    'OUTCOME_UNKNOWN', 'The request has incomplete effects.');
  const outcome = outcomeFor(request, result.status, result.code, current.revision + 1, result.operationId);
  const updated = commitTransition(lease, current.revision, (value) => {
    const changed = transition(value);
    if (request.request.kind === 'stop-now' && result.status === 'applied') requireCondition(changed.desiredState === 'stopped'
      && changed.stopMode === 'immediate' && cancellationGroupsExited(changed), 'OUTCOME_UNKNOWN', 'Immediate stop has unconfirmed target groups.');
    return { ...changed, requests: { ...changed.requests, [requestId]: { ...request, status: result.status, outcome } } };
  });
  publishOutcome(binding.repository, outcome, binding.observe);
  return updated;
}

const EFFECT_KEYS = ['operationId', 'requestId', 'runId', 'unitId', 'unitGeneration', 'kind', 'target',
  'inputDigest', 'expectedHead', 'phase', 'attempt', 'receipt', 'error'];
function validReceipt(value) {
  return exactKeys(value, ['externalId', 'observationDigest', 'observedAt'])
    && (value.externalId === null || (nonempty(value.externalId) && /^[A-Za-z0-9._:-]+$/u.test(value.externalId)))
    && hash(value.observationDigest) && timestamp(value.observedAt) && safeValues(value);
}
function validEffect(value) {
  if (!exactKeys(value, EFFECT_KEYS) || !uuid(value.operationId) || !uuid(value.runId)
    || (value.requestId !== null && !uuid(value.requestId)) || (value.unitId === null
      ? value.unitGeneration !== null : !uuid(value.unitId) || !positive(value.unitGeneration))
    || !nonempty(value.kind) || !/^[a-z]+(?:[.-][a-z]+)*$/u.test(value.kind) || !hash(value.inputDigest)
    || (value.expectedHead !== null && !validOid(value.expectedHead)) || !positive(value.attempt)
    || !['prepared', 'in-flight', 'unknown', 'succeeded', 'failed'].includes(value.phase)
    || (value.receipt !== null && !validReceipt(value.receipt)) || !validError(value.error) || !safeValues(value)) return false;
  const target = value.target;
  if (!(exactKeys(target, ['type', 'attemptId']) && target.type === 'process' && uuid(target.attemptId))
    && !(exactKeys(target, ['type', 'id']) && target.type === 'external' && uuid(target.id))) return false;
  if (value.phase === 'succeeded') return value.receipt !== null && value.error === null;
  if (value.phase === 'unknown') return value.receipt === null && value.error?.code === 'OUTCOME_UNKNOWN';
  if (value.phase === 'failed') return value.error !== null;
  if (value.phase === 'in-flight') return value.receipt === null && value.error === null;
  return value.attempt === 1 ? value.receipt === null && value.error === null
    : value.receipt !== null && value.error?.code === 'NOT_APPLIED';
}
function effectIntent(value) {
  return Object.fromEntries(EFFECT_KEYS.filter((key) => !['phase', 'attempt', 'receipt', 'error'].includes(key)).map((key) => [key, value[key]]));
}
function validatePersistentTransition(binding, current, updated) {
  const nextStates = {
    starting: ['starting', 'running', 'paused', 'recovering', 'draining', 'stopped', 'failed'],
    recovering: ['recovering', 'running', 'paused', 'draining', 'stopped', 'failed'],
    running: ['running', 'paused', 'draining', 'stopped', 'failed'],
    paused: ['paused', 'running', 'draining', 'stopped', 'failed'],
    draining: ['draining', 'stopped', 'failed'], stopped: ['stopped'], failed: ['failed', 'draining', 'stopped'],
  };
  requireCondition(nextStates[current.state].includes(updated.state), 'STATE_INVALID', 'The lifecycle transition is not supported.');
  for (const [id, request] of Object.entries(current.requests)) {
    const kept = updated.requests[id];
    requireCondition(kept && kept.requestHash === request.requestHash && canonicalJson(kept.request) === canonicalJson(request.request)
      && (request.claimedGeneration === null || kept.claimedGeneration === request.claimedGeneration),
    'STATE_INVALID', 'An authoritative request cannot be removed or replaced.');
    if (['applied', 'refused'].includes(request.status)) requireCondition(canonicalJson(kept) === canonicalJson(request),
      'STATE_INVALID', 'A final request receipt cannot change.');
  }
  for (const [id, request] of Object.entries(updated.requests)) {
    if (!current.requests[id]) requireCondition(canonicalJson(immutableControl(binding.repository, id)) === canonicalJson(request.request),
      'STATE_INVALID', 'A claim must bind its immutable submitted request.');
  }
  for (const [id, effect] of Object.entries(current.outbox)) {
    const kept = updated.outbox[id];
    requireCondition(kept && canonicalJson(effectIntent(kept)) === canonicalJson(effectIntent(effect)),
      'STATE_INVALID', 'An outbox intent cannot be removed or replaced.');
    if (['succeeded', 'failed'].includes(effect.phase)) requireCondition(canonicalJson(kept) === canonicalJson(effect),
      'STATE_INVALID', 'A final effect receipt cannot change.');
    requireCondition(kept.attempt === effect.attempt || (kept.attempt === effect.attempt + 1 && kept.phase === 'prepared'
      && kept.error?.code === 'NOT_APPLIED' && kept.receipt !== null), 'STATE_INVALID', 'A retry needs verified not-applied evidence.');
    if (kept.phase !== effect.phase) {
      const next = { prepared: ['in-flight', 'succeeded', 'failed'], 'in-flight': ['unknown', 'prepared', 'succeeded', 'failed'],
        unknown: ['prepared', 'succeeded', 'failed'], succeeded: [], failed: [] };
      if (effect.phase === 'prepared' && kept.phase === 'failed') requireCondition(canAbandonPreparedEffect(current, effect)
        && kept.error?.code === 'STOPPED_BEFORE_LAUNCH' && kept.attempt === effect.attempt
        && canonicalJson(kept.receipt) === canonicalJson(effect.receipt),
      'STATE_INVALID', 'Only stopped unstarted intent can be abandoned.');
      if (effect.phase === 'prepared' && kept.phase === 'succeeded') requireCondition(preparedCancellationExited(current, effect)
        && validAbsentGroupReceipt(current, effect, kept.receipt), 'STATE_INVALID', 'Only confirmed absent cancellation targets can settle before execution.');
      requireCondition(next[effect.phase].includes(kept.phase), 'STATE_INVALID', 'The effect phase transition is invalid.');
      if (kept.phase === 'prepared') requireCondition(kept.attempt === effect.attempt + 1 && kept.receipt !== null
        && kept.error?.code === 'NOT_APPLIED', 'STATE_INVALID', 'An uncertain effect cannot reset without readback.');
    }
  }
  for (const [id, effect] of Object.entries(updated.outbox)) {
    if (!current.outbox[id]) requireCondition(effect.phase === 'prepared' && effect.attempt === 1 && effect.receipt === null && effect.error === null,
      'STATE_INVALID', 'An effect must be prepared before execution.');
  }
}
function explicitRecoveryCancellation(checkpoint, effect) {
  if (['starting', 'stopped', 'failed'].includes(checkpoint.state) || checkpoint.desiredState !== 'stopped'
    || checkpoint.stopMode !== 'immediate' || effect.kind !== 'process.cancel' || effect.attempt !== 1
    || effect.target.type !== 'process' || effect.requestId === null) return false;
  const record = checkpoint.requests[effect.requestId];
  if (!record || record.status !== 'processing' || record.claimedGeneration !== checkpoint.generation
    || record.request.runId !== checkpoint.runId || record.request.kind !== 'stop-now'
    || record.request.target.type !== 'run' || record.request.target.generation !== checkpoint.generation) return false;
  const worker = checkpoint.workers.find((binding) => binding.attemptId === effect.target.attemptId);
  if (!worker || !checkpoint.workers.every((binding) => binding.cancelledByOperator)
    || effect.unitId !== worker.unitId || effect.unitGeneration !== worker.unitGeneration) return false;
  return boundGroupState(worker) === 'alive';
}
export function prepareEffect(lease, expectedRevision, effect) {
  const binding = heldLease(lease);
  requireCondition(validEffect(effect) && effect.runId === binding.identity.runId && effect.phase === 'prepared'
    && effect.attempt === 1 && effect.receipt === null && effect.error === null, 'INVALID_INPUT', 'The effect intent is invalid.');
  const current = readCheckpoint(binding.repository, binding.identity.runId);
  requireCondition(current.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
  const previous = current.outbox[effect.operationId];
  if (previous) {
    requireCondition(canonicalJson(effectIntent(previous)) === canonicalJson(effectIntent(effect)), 'EFFECT_ID_CONFLICT', 'The operation ID has another intent.');
    return current;
  }
  requireCondition((!['starting', 'recovering'].includes(current.state) && !Object.values(current.outbox).some((item) => item.phase === 'unknown'))
    || explicitRecoveryCancellation(current, effect), 'RECOVERY_REQUIRED', 'Recover uncertain effects before preparing new work.');
  requireCondition(!['stopped', 'failed'].includes(current.state)
    && !(current.desiredState === 'stopped' && effect.kind === 'process.start'), 'RUN_ACTIVE', 'This run cannot start new work.');
  if (effect.requestId !== null) requireCondition(['processing', 'unknown'].includes(current.requests[effect.requestId]?.status),
    'REQUEST_NOT_FOUND', 'The effect needs a claimed request.');
  assertPinsLive(binding.repository, readPins(binding.repository, current.runId));
  return commitTransition(lease, expectedRevision, (value) => ({ ...value, outbox: { ...value.outbox, [effect.operationId]: effect } }));
}
export function markEffectInFlight(lease, operationId) {
  const binding = heldLease(lease);
  requireCondition(uuid(operationId), 'INVALID_INPUT', 'An operation ID is invalid.');
  const current = readCheckpoint(binding.repository, binding.identity.runId);
  const effect = current.outbox[operationId];
  requireCondition(effect, 'EFFECT_NOT_FOUND', 'The effect does not exist.');
  requireCondition(effect.phase !== 'unknown', 'OUTCOME_UNKNOWN', 'Reconcile this effect before retry.');
  requireCondition(effect.phase === 'prepared', 'EFFECT_SETTLED', 'The effect cannot start again.');
  if (effect.kind === 'process.cancel') {
    const worker = current.workers.find((value) => value.attemptId === effect.target.attemptId);
    requireCondition(worker && worker.unitId === effect.unitId && worker.unitGeneration === effect.unitGeneration
      && boundGroupState(worker) === 'alive', 'OWNER_UNVERIFIED', 'The cancellation target cannot be verified.');
  }
  requireCondition((!['starting', 'recovering', 'stopped', 'failed'].includes(current.state)
    && !Object.values(current.outbox).some((item) => item.phase === 'unknown')) || explicitRecoveryCancellation(current, effect),
  'RECOVERY_REQUIRED', 'Reconcile uncertain work first.');
  requireCondition(current.desiredState !== 'stopped' || explicitRecoveryCancellation(current, effect),
    'RUN_ACTIVE', 'Stopped intent cannot launch an effect.');
  assertPinsLive(binding.repository, readPins(binding.repository, current.runId));
  return commitTransition(lease, current.revision, (value) => ({ ...value, outbox: { ...value.outbox,
    [operationId]: { ...effect, phase: 'in-flight', receipt: null, error: null } } }));
}
function preparedCancellationExited(checkpoint, effect) {
  if (effect.kind !== 'process.cancel' || effect.phase !== 'prepared' || effect.attempt !== 1
    || effect.runId !== checkpoint.runId || effect.requestId === null || effect.target.type !== 'process'
    || checkpoint.desiredState !== 'stopped' || checkpoint.stopMode !== 'immediate') return false;
  const request = checkpoint.requests[effect.requestId];
  const worker = checkpoint.workers.find((value) => value.attemptId === effect.target.attemptId);
  return request && ['processing', 'unknown'].includes(request.status) && request.request.runId === effect.runId
    && request.request.kind === 'stop-now' && request.request.target.type === 'run'
    && request.request.target.generation === request.claimedGeneration && worker && worker.cancelledByOperator
    && worker.unitId === effect.unitId && worker.unitGeneration === effect.unitGeneration && boundGroupState(worker) === 'empty';
}
function validAbsentGroupReceipt(checkpoint, effect, receipt) {
  const worker = checkpoint.workers.find((value) => value.attemptId === effect.target.attemptId);
  return worker && receipt?.externalId === worker.attemptId && receipt.observationDigest === schedulerDigest({
    process: worker.process, groupLeader: worker.groupLeader, pgid: worker.pgid, groupAlive: false });
}
function cancellationGroupsExited(checkpoint) {
  return checkpoint.workers.every((worker) => worker.cancelledByOperator && boundGroupState(worker) === 'empty');
}
function canAbandonPreparedEffect(checkpoint, effect) {
  // Cancellation retains its desired group exit; it must use exact readback.
  return checkpoint.desiredState === 'stopped' && effect.phase === 'prepared' && effect.kind !== 'process.cancel';
}
export function abandonPreparedEffect(lease, operationId) {
  const binding = heldLease(lease);
  requireCondition(uuid(operationId), 'INVALID_INPUT', 'An operation ID is invalid.');
  const current = readCheckpoint(binding.repository, binding.identity.runId);
  const effect = current.outbox[operationId];
  requireCondition(effect, 'EFFECT_NOT_FOUND', 'The effect does not exist.');
  requireCondition(current.desiredState === 'stopped', 'RUN_ACTIVE', 'Stopped intent is required before abandonment.');
  requireCondition(canAbandonPreparedEffect(current, effect), 'EFFECT_SETTLED', 'The effect needs execution readback, not abandonment.');
  let outcome = null;
  const updated = commitTransition(lease, current.revision, (value) => {
    const outbox = { ...value.outbox, [operationId]: { ...effect, phase: 'failed',
      error: { code: 'STOPPED_BEFORE_LAUNCH', message: 'Stopped intent prevented effect invocation.' } } };
    const requests = { ...value.requests };
    if (effect.requestId !== null) {
      const request = requests[effect.requestId];
      requireCondition(!['applied', 'refused'].includes(request.status), 'REQUEST_SETTLED', 'The linked request is already settled.');
      const linked = Object.values(outbox).filter((item) => item.requestId === effect.requestId);
      if (linked.every((item) => ['succeeded', 'failed'].includes(item.phase))
        && (request.request.kind !== 'stop-now' || cancellationGroupsExited(value))) {
        outcome = outcomeFor(request, 'refused', 'STOPPED_BEFORE_LAUNCH', current.revision + 1, operationId);
        requests[effect.requestId] = { ...request, status: 'refused', outcome };
      }
    }
    return { ...value, outbox, requests };
  });
  if (outcome) publishOutcome(binding.repository, outcome, binding.observe);
  return updated;
}
export function settleEffect(lease, operationId, observation) {
  const binding = heldLease(lease);
  requireCondition(uuid(operationId) && exactKeys(observation, ['attempt', 'status', 'code', 'receipt'])
    && positive(observation.attempt) && ['applied', 'not-applied', 'unknown', 'failed'].includes(observation.status)
    && nonempty(observation.code) && /^[A-Z][A-Z0-9_]*$/u.test(observation.code) && (observation.receipt === null || validReceipt(observation.receipt)),
  'INVALID_INPUT', 'The effect observation is invalid.');
  if (['applied', 'not-applied'].includes(observation.status)) requireCondition(validReceipt(observation.receipt),
    'INVALID_INPUT', 'A conclusive effect observation needs a receipt.');
  const current = readCheckpoint(binding.repository, binding.identity.runId);
  const effect = current.outbox[operationId];
  requireCondition(effect, 'EFFECT_NOT_FOUND', 'The effect does not exist.');
  if (effect.phase === 'prepared' && observation.status === 'not-applied' && effect.attempt === observation.attempt + 1
    && effect.receipt?.externalId === observation.receipt.externalId
    && effect.receipt?.observationDigest === observation.receipt.observationDigest) return current;
  requireCondition(effect.attempt === observation.attempt, 'TARGET_MISMATCH', 'The observation names another effect attempt.');
  if (effect.phase === 'succeeded' && observation.status === 'applied') {
    requireCondition(effect.receipt.externalId === observation.receipt.externalId
      && effect.receipt.observationDigest === observation.receipt.observationDigest, 'EFFECT_SETTLED', 'The effect already has another receipt.');
    return current;
  }
  const absentCancellation = observation.status === 'applied' && observation.code === 'GROUP_ALREADY_EXITED'
    && preparedCancellationExited(current, effect) && validAbsentGroupReceipt(current, effect, observation.receipt);
  requireCondition(['in-flight', 'unknown'].includes(effect.phase) || absentCancellation,
    'EFFECT_SETTLED', 'The effect has no unresolved attempt.');
  const conclusions = {
    applied: { phase: 'succeeded', error: null },
    'not-applied': { phase: 'prepared', error: { code: 'NOT_APPLIED', message: 'Readback proves the effect was not applied.' } },
    unknown: { phase: 'unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'The effect outcome needs readback.' } },
    failed: { phase: 'failed', error: { code: observation.code, message: 'The effect failed.' } },
  };
  const conclusion = conclusions[observation.status];
  const settled = { ...effect, phase: conclusion.phase, attempt: effect.attempt + (observation.status === 'not-applied' ? 1 : 0),
    receipt: observation.status === 'unknown' ? null : observation.receipt, error: conclusion.error };
  let outcome = null;
  const updated = commitTransition(lease, current.revision, (value) => {
    const outbox = { ...value.outbox, [operationId]: settled };
    const requests = { ...value.requests };
    if (effect.requestId !== null) {
      const request = requests[effect.requestId];
      requireCondition(request && !['applied', 'refused'].includes(request.status), 'REQUEST_SETTLED', 'The linked request is already settled.');
      const linked = Object.values(outbox).filter((item) => item.requestId === effect.requestId);
      let status = 'processing';
      if (linked.some((item) => item.phase === 'unknown')) status = 'unknown';
      else if (linked.every((item) => item.phase === 'succeeded')
        && (request.request.kind !== 'stop-now' || cancellationGroupsExited(value))) status = 'applied';
      else if (linked.every((item) => ['succeeded', 'failed'].includes(item.phase)) && linked.some((item) => item.phase === 'failed')) status = 'refused';
      outcome = status === 'processing' ? null : outcomeFor(request, status,
        status === 'unknown' ? 'OUTCOME_UNKNOWN' : observation.code, current.revision + 1, operationId);
      requests[effect.requestId] = { ...request, status, outcome };
    }
    return { ...value, outbox, requests };
  });
  if (outcome) publishOutcome(binding.repository, outcome, binding.observe);
  return updated;
}

async function selfTest() {
  const results = [];
  const check = async (name, run) => {
    try {
      await run();
      results.push([name, true]);
    } catch (error) {
      results.push([name, false]);
      console.error(`FAIL ${name}: ${error.message}`);
    }
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scheduler-contract-')));
  const children = new Set();
  const moduleUrl = import.meta.url;
  const startChild = (script, args = [], options = {}) => {
    const scopedScript = `process.on('disconnect', () => process.exit(0));\n${script}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', scopedScript, ...args], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], ...options,
    });
    child.started = processStart(child.pid);
    child.errorText = '';
    child.stderr?.on('data', (chunk) => { child.errorText += chunk; });
    child.finished = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
    children.add(child);
    child.finished.then(() => children.delete(child));
    return child;
  };
  const message = (child) => new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('The fixture child did not report.')), 15000);
    child.once('message', (value) => { clearTimeout(timer); done(value); });
    child.finished.then(({ code, signal }) => { clearTimeout(timer); fail(new Error(`The fixture child ended: ${code ?? signal}. ${child.errorText.trim()}`)); });
  });
  const endChild = async (child, signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null && processStart(child.pid) === child.started) child.kill(signal);
    await child.finished;
  };
  const root = join(scratch, 'repo');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: scratch, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  try {
    git('init', '-q', '-b', 'main', root);
    git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-qm', 'base');
    const linked = join(scratch, 'linked');
    git('-C', root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    const alias = join(scratch, 'alias');
    symlinkSync(root, alias);
    await check('canonical common Git identity is shared by linked worktrees and aliases', () => {
      const repository = resolveRepository(root);
      const other = resolveRepository(linked);
      assert.equal(repository.commonDir, realpathSync(join(root, '.git')));
      assert.equal(repository.repositoryKey, other.repositoryKey);
      assert.equal(repository.repositoryKey, resolveRepository(alias).repositoryKey);
      assert.equal(repository.coordinatorRoot, root);
      assert.equal(other.coordinatorRoot, linked);
    });
    const fixture = () => {
      const home = join(scratch, randomUUID());
      mkdirSync(home);
      const checkout = join(home, 'repo');
      git('init', '-q', '-b', 'main', checkout);
      git('-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--allow-empty', '-qm', 'base');
      const pluginRoot = join(home, 'plugin');
      mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
      mkdirSync(join(pluginRoot, 'tools'));
      writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }));
      writeFileSync(join(pluginRoot, 'tools', 'fixture.mjs'), '// external fixture engine\n');
      const repository = resolveRepository(checkout);
      const config = resolveConfigText(JSON.stringify({ version: '0.28.0', baseBranch: 'main', gate: { command: 'node --version' } })).config;
      const pins = createPins(repository, { pluginRoot, enginePath: realpathSync(process.execPath), config, models: mergeModels(DEFAULT_MODELS) });
      const initiator = { kind: 'terminal', sessionId: null, process: readProcessIdentity(process.pid) };
      return { home, repository, pins, initiator, state: join(repository.commonDir, 'autoloop', 'scheduler') };
    };
    const refuses = (code, run) => assert.throws(run, (error) => error instanceof SchedulerError && error.code === code);
    await check('pins validate real config, model routes, digests and default containment without credentials', () => {
      const { repository, pins } = fixture();
      assert.equal(pins.schema, PINS_SCHEMA);
      assert.equal(pins.configDigest, schedulerDigest(pins.config));
      assert.equal(pins.modelsDigest, schedulerDigest(pins.models));
      assert.deepEqual(pins.supervisorProfile, DEFAULT_SUPERVISOR_PROFILE);
      assert.deepEqual(validatePins(pins), []);
      assert.notDeepEqual(validatePins({ ...pins, apiKey: 'fixture' }), []);
      assert.notDeepEqual(validatePins({ ...pins, configDigest: '0'.repeat(64) }), []);
      refuses('INVALID_INPUT', () => createPins(repository, { pluginRoot: pins.pluginRoot, enginePath: pins.enginePath,
        config: { ...pins.config, apiKey: 'fixture' }, models: pins.models }));
    });
    await check('new authoritative directories flush their parents before lease and pointer publication', async () => {
      const { repository, pins, initiator, state } = fixture();
      const operations = [];
      const directories = [repository.commonDir, join(repository.commonDir, 'autoloop'), state, join(state, 'lock'),
        join(state, 'runs'), join(state, 'runs', pins.runId), join(state, 'runs', pins.runId, 'streams')];
      // Test-only OS-operation instrumentation. Real mkdir and fsync still run.
      const fs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      let acquired;
      const originalMkdir = fs.mkdirSync; const originalFsync = fs.fsyncSync;
      try {
        fs.mkdirSync = (...args) => { const result = originalMkdir(...args); operations.push(['mkdir', args[0]]); return result; };
        fs.fsyncSync = (fd) => {
          const result = originalFsync(fd); const stat = fstatSync(fd);
          if (stat.isDirectory()) for (const path of directories) {
            if (!existsSync(path)) continue;
            const target = lstatSync(path);
            if (target.dev === stat.dev && target.ino === stat.ino) operations.push(['fsync', path]);
          }
          return result;
        };
        syncBuiltinESMExports();
        acquired = acquireScheduler(repository, pins, initiator, { observe: (phase, path) => operations.push([phase, path]) });
      } finally { fs.mkdirSync = originalMkdir; fs.fsyncSync = originalFsync; syncBuiltinESMExports(); }
      const before = (path, publication) => {
        const created = operations.findIndex(([at, target]) => at === 'mkdir' && target === path);
        const flush = operations.findIndex(([at, target], index) => index > created && at === 'fsync' && target === dirname(path));
        const published = operations.findIndex(([at, target]) => at === 'published' && target === publication);
        assert(created >= 0 && flush > created && published > flush, `Parent flush for ${path} must precede ${publication}.`);
      };
      before(join(state, 'lock'), join(state, 'lock', '1.json'));
      for (const path of [join(repository.commonDir, 'autoloop'), state, join(state, 'runs'), join(state, 'runs', pins.runId),
        join(state, 'runs', pins.runId, 'streams')]) before(path, join(state, 'current.json'));
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('directory parent fsync failure prevents dependent authoritative publication', async () => {
      const fs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      for (const component of ['lock', 'runs', 'run']) for (const code of ['EIO', 'EINVAL']) {
        const { repository, pins, initiator, state } = fixture();
        const failedPath = component === 'run' ? join(state, 'runs', pins.runId) : join(state, component);
        const original = fs.fsyncSync; let armed = false;
        try {
          fs.fsyncSync = (fd) => {
            if (armed) {
              const actual = fstatSync(fd); const parent = lstatSync(dirname(failedPath));
              if (actual.isDirectory() && actual.dev === parent.dev && actual.ino === parent.ino) {
                throw Object.assign(new Error('directory fsync failure'), { code });
              }
            }
            return original(fd);
          };
          syncBuiltinESMExports();
          refuses('STATE_IO_FAILED', () => acquireScheduler(repository, pins, initiator, { observe: (phase, path) => {
            if (phase === 'directory-parent-sync' && path === failedPath) armed = true;
          } }));
        } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
        assert.equal(existsSync(join(state, 'current.json')), false);
        if (component === 'lock') assert.equal(existsSync(join(state, 'lock', '1.json')), false);
      }
    });
    await check('an exclusive lease precedes a schema-checked checkpoint and current pointer', () => {
      const { repository, pins, initiator, state } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const checkpoint = readCheckpoint(repository, acquired.runId);
      assert.equal(checkpoint.schema, CHECKPOINT_SCHEMA);
      assert.equal(checkpoint.generation, 1);
      assert.equal(checkpoint.revision, 1);
      assert.equal(checkpoint.state, 'starting');
      assert.equal(checkpoint.queueEnabled, false);
      assert.deepEqual(checkpoint.workers, []);
      assert.equal(JSON.parse(readRegularFile(join(state, 'current.json'))).schema, CURRENT_SCHEMA);
      assert.equal(readRegularFile(join(state, 'runs', pins.runId, 'pins.json')), `${canonicalJson(pins)}\n`);
      assert.equal(JSON.parse(readRegularFile(join(state, 'lock', '1.json'))).generation, 1);
      refuses('SCHEDULER_ACTIVE', () => acquireScheduler(repository, pins, initiator));
      commitTransition(acquired.lease, checkpoint.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
      releaseScheduler(acquired.lease);
    });
    await check('checkpoint revision and nonserialized lease fence every writer; release revokes old capability', () => {
      const { repository, pins, initiator } = fixture();
      const first = acquireScheduler(repository, pins, initiator);
      const paused = commitTransition(first.lease, 1, (value) => ({ ...value, state: 'paused', desiredState: 'paused' }));
      assert.equal(paused.revision, 2);
      refuses('REVISION_MISMATCH', () => commitTransition(first.lease, 1, (value) => value));
      refuses('LEASE_INVALID', () => commitTransition(JSON.parse(JSON.stringify(first.lease)), 2, (value) => value));
      const stopped = commitTransition(first.lease, paused.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
      releaseScheduler(first.lease);
      const nextPins = { ...pins, runId: randomUUID(), createdAt: Date.now() };
      const second = acquireScheduler(repository, nextPins, initiator);
      assert.equal(readCheckpoint(repository, second.runId).revision, 1);
      refuses('LEASE_INVALID', () => commitTransition(first.lease, stopped.revision, (value) => value));
      assert.equal(readCheckpoint(repository, first.runId).state, 'stopped');
      commitTransition(second.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
      releaseScheduler(second.lease);
    });
    await check('corrupt checkpoints, unknown fields and production queue activation fail closed', () => {
      const { repository, pins, initiator, state } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      refuses('STATE_INVALID', () => commitTransition(acquired.lease, 1, (value) => ({ ...value, extra: true })));
      refuses('UNSUPPORTED_ACTION', () => commitTransition(acquired.lease, 1, (value) => ({ ...value, queueEnabled: true })));
      const path = join(state, 'runs', pins.runId, 'checkpoint.json');
      writeFileSync(`${path}.partial.tmp`, '{partial');
      assert.equal(readCheckpoint(repository, pins.runId).revision, 1);
      writeFileSync(path, '{corrupt');
      refuses('STATE_INVALID', () => readCheckpoint(repository, pins.runId));
    });
    await check('OS failure reading a live owner start or boot identity never permits takeover', () => {
      const { repository, pins, initiator, state } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      for (const phase of ['owner-start', 'owner-boot']) {
        refuses('OWNER_UNVERIFIED', () => acquireScheduler(repository, pins, initiator, { observe: (at) => {
          if (at === phase) throw Object.assign(new Error('OS read failure'), { code: 'EACCES' });
        } }));
      }
      assert.deepEqual(readdirSync(join(state, 'lock')).filter((name) => name.endsWith('.json')), ['1.json']);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
      releaseScheduler(acquired.lease);
    });
    await check('corrupt, gapped and wrong-generation authoritative lease ledgers fail closed', () => {
      for (const damage of ['corrupt', 'gap', 'generation', 'identity']) {
        const { repository, pins, initiator, state } = fixture();
        const acquired = acquireScheduler(repository, pins, initiator);
        const path = join(state, 'lock', '1.json');
        const original = JSON.parse(readRegularFile(path));
        if (damage === 'corrupt') writeFileSync(path, '{corrupt');
        if (damage === 'gap') writeFileSync(join(state, 'lock', '3.json'), JSON.stringify({ ...original, sequence: 3, generation: 2 }));
        if (damage === 'generation') writeFileSync(path, JSON.stringify({ ...original, generation: 2 }));
        if (damage === 'identity') writeFileSync(path, JSON.stringify({ ...original, owner: { ...original.owner, start: null } }));
        refuses('STATE_INVALID', () => readCheckpoint(repository, acquired.runId));
        refuses('STATE_INVALID', () => acquireScheduler(repository, pins, initiator));
      }
    });
    await check('missing lease and current records cannot make retained checkpoints appear absent', () => {
      const { repository, pins, initiator, home, state } = fixture();
      acquireScheduler(repository, pins, initiator);
      renameSync(join(state, 'lock', '1.json'), join(home, 'saved-lease.json'));
      renameSync(join(state, 'current.json'), join(home, 'saved-current.json'));
      refuses('STATE_INVALID', () => readSchedulerOwner(repository));
      refuses('STATE_INVALID', () => acquireScheduler(repository, { ...pins, runId: randomUUID() }, initiator));
    });
    await check('simultaneous linked-worktree contenders yield one owner and one checkpoint writer', async () => {
      const { repository, pins, state } = fixture();
      const linkedRoot = join(dirname(repository.coordinatorRoot), 'linked');
      git('-C', repository.coordinatorRoot, 'worktree', 'add', '-q', '--detach', linkedRoot, 'HEAD');
      const script = `const api = await import(process.argv[1]);
        const repository = api.resolveRepository(process.argv[2]); const pins = JSON.parse(process.argv[3]);
        let acquired;
        process.on('message', (command) => {
          if (command === 'go') {
            try {
              acquired = api.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() });
              api.commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'paused', desiredState: 'paused' }));
              process.send({ ok: true, pid: process.pid });
            } catch (error) { process.send({ ok: false, code: error.code }, () => process.disconnect()); }
          } else if (command === 'finish') {
            api.commitTransition(acquired.lease, 2, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
            api.releaseScheduler(acquired.lease); process.disconnect();
          }
        }); process.send({ ready: true });`;
      const contenders = Array.from({ length: 4 }, (_, index) => startChild(script,
        [moduleUrl, index % 2 === 0 ? repository.coordinatorRoot : linkedRoot, JSON.stringify(pins)]));
      await Promise.all(contenders.map(message));
      const answers = contenders.map(message);
      for (const child of contenders) child.send('go');
      const returned = await Promise.all(answers);
      assert.equal(returned.filter((value) => value.ok).length, 1);
      assert(returned.filter((value) => !value.ok).every((value) => value.code === 'SCHEDULER_ACTIVE'));
      const checkpoint = readCheckpoint(repository, pins.runId);
      assert.equal(checkpoint.revision, 2);
      assert.equal(checkpoint.owner.pid, returned.find((value) => value.ok).pid);
      assert.deepEqual(readdirSync(join(state, 'lock')), ['1.json']);
      contenders[returned.findIndex((value) => value.ok)].send('finish');
      await Promise.all(contenders.map((child) => child.finished));
    });
    await check('dead-owner recovery and a crashed successor retain a surviving bound worker', async () => {
      const { repository, pins, initiator, state } = fixture();
      const worker = startChild('setInterval(() => {}, 1000);', [], { cwd: repository.coordinatorRoot, detached: true });
      const attemptId = randomUUID();
      const binding = {
        schema: 'autoloop.worker-binding/1', runId: pins.runId, generation: 1, unitId: randomUUID(), unitGeneration: 1,
        attemptId, sessionId: randomUUID(), worktreeGitDir: git('-C', repository.coordinatorRoot, 'rev-parse', '--absolute-git-dir'),
        process: readProcessIdentity(worker.pid), pgid: worker.pid, groupLeader: readProcessIdentity(worker.pid),
        role: 'implement', posture: 'writer', actualModel: 'fixture-writer',
        liveFile: join(state, 'runs', pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false,
      };
      const owner = startChild(`const api = await import(process.argv[1]); const repository = api.resolveRepository(process.argv[2]);
        const pins = JSON.parse(process.argv[3]); const binding = JSON.parse(process.argv[4]);
        const acquired = api.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() });
        api.registerWorker(acquired.lease, 1, binding, { guardDirectory: process.argv[5] }); process.send({ ready: true }); setInterval(() => {}, 1000);`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(pins), JSON.stringify(binding), join(scratch, 'workers')]);
      assert.equal((await message(owner)).ready, true);
      await endChild(owner, 'SIGKILL');
      const crashed = startChild(`const api = await import(process.argv[1]); const repository = api.resolveRepository(process.argv[2]);
        const pins = JSON.parse(process.argv[3]); api.acquireScheduler(repository, pins,
          { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() }, { observe: (phase, path) => {
            if (phase === 'directory-flushed' && path.endsWith('/lock/2.json')) process.kill(process.pid, 'SIGKILL');
          } });`, [moduleUrl, repository.coordinatorRoot, JSON.stringify(pins)]);
      assert.equal((await crashed.finished).signal, 'SIGKILL');
      refuses('RECOVERY_REQUIRED', () => readCheckpoint(repository, pins.runId));
      const recovered = acquireScheduler(repository, pins, initiator);
      assert.equal(recovered.generation, 3);
      const checkpoint = readCheckpoint(repository, pins.runId);
      assert.equal(checkpoint.state, 'recovering');
      assert.deepEqual(checkpoint.workers, [binding]);
      assert.equal(ownerState(binding.process), 'alive');
      refuses('RECOVERY_REQUIRED', () => commitTransition(recovered.lease, checkpoint.revision,
        (value) => ({ ...value, state: 'running' })));
      await endChild(worker);
      const stopped = commitTransition(recovered.lease, checkpoint.revision,
        (value) => ({ ...value, state: 'stopped', desiredState: 'stopped', workers: [] }));
      assert.equal(stopped.workers.length, 0);
      releaseScheduler(recovered.lease);
      assert.equal(readdirSync(join(state, 'lock')).filter((name) => /^\d+\.json$/u.test(name)).length, 3);
    });
    await check('OS write failure revokes the lease without acknowledging a new checkpoint', () => {
      const { repository, pins, initiator } = fixture();
      let armed = false;
      const acquired = acquireScheduler(repository, pins, initiator, { observe: (phase, path) => {
        if (armed && phase === 'temporary-flushed' && path.endsWith('/checkpoint.json')) {
          throw Object.assign(new Error('OS write failure'), { code: 'EIO' });
        }
      } });
      armed = true;
      refuses('STATE_IO_FAILED', () => commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'paused', desiredState: 'paused' })));
      assert.equal(readCheckpoint(repository, pins.runId).revision, 1);
      refuses('LEASE_INVALID', () => commitTransition(acquired.lease, 1, (value) => value));
    });
    const actor = () => ({ kind: 'terminal', sessionId: null, host: readProcessIdentity(), invocationId: randomUUID() });
    const request = (runId, kind = 'pause', generation = 1) => ({
      schema: CONTROL_SCHEMA, requestId: randomUUID(), runId, kind,
      target: { type: 'run', generation }, payload: {}, submittedAt: Date.now(),
    });
    const effect = (runId, requestId = null) => ({
      operationId: randomUUID(), requestId, runId, unitId: null, unitGeneration: null,
      kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: schedulerDigest({ intent: 'fixture effect' }),
      expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null,
    });
    const finish = (repository, acquired) => {
      const current = readCheckpoint(repository, acquired.runId);
      commitTransition(acquired.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
      releaseScheduler(acquired.lease);
    };
    await check('prepared intents block fresh and legacy admission until stopped-before-launch accounting', () => {
      for (const linked of [false, true]) {
        const { repository, pins, initiator } = fixture();
        const acquired = acquireScheduler(repository, pins, initiator);
        commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
        const control = linked ? request(pins.runId) : null;
        if (control) { submitControl(repository, actor(), control); claimControl(acquired.lease, control.requestId); }
        const operation = effect(pins.runId, control?.requestId ?? null);
        prepareEffect(acquired.lease, readCheckpoint(repository, pins.runId).revision, operation);
        finish(repository, acquired);
        const nextPins = { ...pins, runId: randomUUID(), createdAt: Date.now() };
        refuses('RUN_MISMATCH', () => acquireScheduler(repository, nextPins, initiator));
        refuses('SCHEDULER_ACTIVE', () => assertNoSchedulerOwner(repository));
        assert.equal(readCheckpoint(repository, pins.runId).outbox[operation.operationId].phase, 'prepared');
        const resumed = acquireScheduler(repository, pins, initiator);
        refuses('LEASE_INVALID', () => abandonPreparedEffect(acquired.lease, operation.operationId));
        const settled = abandonPreparedEffect(resumed.lease, operation.operationId);
        assert.equal(settled.outbox[operation.operationId].phase, 'failed');
        assert.equal(settled.outbox[operation.operationId].error.code, 'STOPPED_BEFORE_LAUNCH');
        assert.equal(settled.outbox[operation.operationId].attempt, 1);
        assert.equal(settled.outbox[operation.operationId].receipt, null);
        if (control) {
          assert.equal(settled.requests[control.requestId].status, 'refused');
          assert.equal(readRequest(repository, pins.runId, control.requestId).outcome.code, 'STOPPED_BEFORE_LAUNCH');
        }
        finish(repository, resumed);
        assert.doesNotThrow(() => assertNoSchedulerOwner(repository));
        const fresh = acquireScheduler(repository, nextPins, initiator); finish(repository, fresh);
      }
    });
    await check('abandonment requires stopped intent and cannot discard an invoked effect', () => {
      const { repository, pins, initiator } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const prepared = effect(pins.runId); prepareEffect(acquired.lease, 2, prepared);
      refuses('RUN_ACTIVE', () => abandonPreparedEffect(acquired.lease, prepared.operationId));
      const invoked = effect(pins.runId); prepareEffect(acquired.lease, 3, invoked); markEffectInFlight(acquired.lease, invoked.operationId);
      let current = readCheckpoint(repository, pins.runId);
      commitTransition(acquired.lease, current.revision, (value) => ({ ...value, desiredState: 'stopped', state: 'draining' }));
      refuses('EFFECT_SETTLED', () => abandonPreparedEffect(acquired.lease, invoked.operationId));
      settleEffect(acquired.lease, invoked.operationId, { attempt: 1, status: 'unknown', code: 'OUTCOME_UNKNOWN', receipt: null });
      refuses('EFFECT_SETTLED', () => abandonPreparedEffect(acquired.lease, invoked.operationId));
      assert.equal(readCheckpoint(repository, pins.runId).outbox[invoked.operationId].phase, 'unknown');
      finish(repository, acquired);
    });
    await check('immutable request IDs survive claims and duplicate payloads cannot replace intent', () => {
      const { repository, pins, initiator } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const control = request(pins.runId);
      const admitted = actor();
      assert.equal(submitControl(repository, admitted, control).status, 'pending');
      assert.equal(submitControl(repository, admitted, { ...control, submittedAt: control.submittedAt + 1 }).status, 'pending');
      const first = claimControl(acquired.lease, control.requestId);
      assert.equal(first.status, 'processing');
      assert.equal(first.claimedNow, true);
      const duplicate = claimControl(acquired.lease, control.requestId);
      assert.equal(duplicate.claimedNow, false);
      refuses('REQUEST_ID_CONFLICT', () => submitControl(repository, admitted, { ...control, kind: 'resume' }));
      const applied = completeControl(acquired.lease, control.requestId, { status: 'applied', code: 'PAUSED', operationId: null },
        (value) => ({ ...value, state: 'paused', desiredState: 'paused' }));
      const response = readRequest(repository, pins.runId, control.requestId);
      assert.equal(response.status, 'applied');
      assert.equal(response.outcome.appliedRevision, applied.revision);
      assert.equal(response.outcome.schema, OUTCOME_SCHEMA);
      assert.equal(submitControl(repository, actor(), control).status, 'applied');
      assert.equal(completeControl(acquired.lease, control.requestId, { status: 'applied', code: 'PAUSED', operationId: null }).revision, applied.revision);
      finish(repository, acquired);
    });
    await check('stale run/target, model-supplied actor and unsupported unit actions cannot report success', () => {
      const { repository, pins, initiator } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const stale = request(pins.runId, 'pause', 9);
      submitControl(repository, actor(), stale);
      assert.equal(claimControl(acquired.lease, stale.requestId).outcome.code, 'TARGET_MISMATCH');
      assert.equal(readRequest(repository, pins.runId, stale.requestId).status, 'refused');
      refuses('RUN_MISMATCH', () => submitControl(repository, actor(), request(randomUUID())));
      refuses('INVALID_INPUT', () => submitControl(repository, actor(), { ...request(pins.runId), actor: { by: 'ui' } }));
      const unit = { schema: CONTROL_SCHEMA, requestId: randomUUID(), runId: pins.runId, submittedAt: Date.now(), payload: {},
        kind: 'cancel', target: { type: 'unit', unitId: randomUUID(), unitGeneration: 1, attemptId: randomUUID() } };
      refuses('UNSUPPORTED_ACTION', () => submitControl(repository, actor(), unit));
      refuses('REQUEST_NOT_FOUND', () => readRequest(repository, pins.runId, randomUUID()));
      refuses('INVALID_INPUT', () => claimControl(acquired.lease, '../escape'));
      finish(repository, acquired);
    });
    await check('a producer crash after immutable request publication is recoverable without a second intent', async () => {
      const { repository, pins, initiator } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const control = request(pins.runId);
      const producer = startChild(`const api = await import(process.argv[1]); const repository = api.resolveRepository(process.argv[2]);
        const control = JSON.parse(process.argv[3]); api.submitControl(repository,
          { kind: 'terminal', sessionId: null, host: api.readProcessIdentity(), invocationId: '${randomUUID()}' }, control,
          { observe: (phase, path) => { if (phase === 'directory-flushed' && path.includes('/requests/')) process.kill(process.pid, 'SIGKILL'); } });`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(control)]);
      assert.equal((await producer.finished).signal, 'SIGKILL');
      assert.equal(readRequest(repository, pins.runId, control.requestId).status, 'pending');
      assert.equal(claimControl(acquired.lease, control.requestId).claimedNow, true);
      completeControl(acquired.lease, control.requestId, { status: 'refused', code: 'FIXTURE_REFUSED', operationId: null });
      assert.equal(readRequest(repository, pins.runId, control.requestId).status, 'refused');
      finish(repository, acquired);
    });
    await check('real competing producer processes deduplicate immutable requests across queue moves', async () => {
      const { repository, pins, initiator } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const control = request(pins.runId);
      const script = `const api = await import(process.argv[1]); const repository = api.resolveRepository(process.argv[2]);
        const control = JSON.parse(process.argv[3]); try {
          const response = api.submitControl(repository,
            { kind: 'terminal', sessionId: null, host: api.readProcessIdentity(), invocationId: '${randomUUID()}' }, control);
          process.send({ ok: true, status: response.status }, () => process.disconnect());
        } catch (error) { process.send({ ok: false, code: error.code }, () => process.disconnect()); }`;
      const producers = Array.from({ length: 4 }, () => startChild(script, [moduleUrl, repository.coordinatorRoot, JSON.stringify(control)]));
      const produced = await Promise.all(producers.map(message));
      assert(produced.every((value) => value.ok));
      await Promise.all(producers.map((child) => child.finished));
      assert.equal(claimControl(acquired.lease, control.requestId).claimedNow, true);
      assert.equal(claimControl(acquired.lease, control.requestId).claimedNow, false);
      refuses('LEASE_INVALID', () => claimControl({}, control.requestId));
      const applied = completeControl(acquired.lease, control.requestId, { status: 'applied', code: 'PAUSED', operationId: null },
        (value) => ({ ...value, state: 'paused', desiredState: 'paused' }));
      assert.equal(Object.keys(applied.requests).length, 1);
      finish(repository, acquired);
    });
    await check('uncertain effects cannot retry until external readback proves not-applied', () => {
      const { repository, pins, initiator } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const running = commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const operation = effect(pins.runId);
      const prepared = prepareEffect(acquired.lease, running.revision, operation);
      assert.equal(prepared.outbox[operation.operationId].phase, 'prepared');
      assert.equal(prepareEffect(acquired.lease, prepared.revision, operation).revision, prepared.revision);
      refuses('EFFECT_ID_CONFLICT', () => prepareEffect(acquired.lease, prepared.revision, { ...operation, inputDigest: schedulerDigest({ intent: 'other' }) }));
      markEffectInFlight(acquired.lease, operation.operationId);
      settleEffect(acquired.lease, operation.operationId, { attempt: 1, status: 'unknown', code: 'OUTCOME_UNKNOWN', receipt: null });
      refuses('OUTCOME_UNKNOWN', () => markEffectInFlight(acquired.lease, operation.operationId));
      refuses('RECOVERY_REQUIRED', () => prepareEffect(acquired.lease, readCheckpoint(repository, pins.runId).revision, effect(pins.runId)));
      const readback = { externalId: null, observationDigest: schedulerDigest({ present: false }), observedAt: Date.now() };
      const reconciled = settleEffect(acquired.lease, operation.operationId, { attempt: 1, status: 'not-applied', code: 'NOT_APPLIED', receipt: readback });
      assert.equal(reconciled.outbox[operation.operationId].phase, 'prepared');
      assert.equal(reconciled.outbox[operation.operationId].attempt, 2);
      assert.equal(settleEffect(acquired.lease, operation.operationId,
        { attempt: 1, status: 'not-applied', code: 'NOT_APPLIED', receipt: readback }).revision, reconciled.revision);
      const retry = markEffectInFlight(acquired.lease, operation.operationId);
      assert.equal(retry.outbox[operation.operationId].phase, 'in-flight');
      refuses('TARGET_MISMATCH', () => settleEffect(acquired.lease, operation.operationId,
        { attempt: 1, status: 'not-applied', code: 'NOT_APPLIED', receipt: readback }));
      settleEffect(acquired.lease, operation.operationId, { attempt: 2, status: 'failed', code: 'FIXTURE_FAILED', receipt: null });
      finish(repository, acquired);
    });
    await check('crash after external effect and before acknowledgment reconciles receipt without duplicate effect', async () => {
      const { repository, pins, initiator, home } = fixture();
      const control = request(pins.runId, 'stop-now');
      const operation = effect(pins.runId, control.requestId);
      const externalFile = join(home, 'external-effect.json');
      const owner = startChild(`import { spawnSync } from 'node:child_process'; const api = await import(process.argv[1]);
        const repository = api.resolveRepository(process.argv[2]); const pins = JSON.parse(process.argv[3]);
        const control = JSON.parse(process.argv[4]); const operation = JSON.parse(process.argv[5]);
        const acquired = api.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() });
        api.commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
        api.submitControl(repository, { kind: 'terminal', sessionId: null, host: api.readProcessIdentity(), invocationId: '${randomUUID()}' }, control);
        api.claimControl(acquired.lease, control.requestId);
        api.prepareEffect(acquired.lease, api.readCheckpoint(repository, pins.runId).revision, operation);
        api.markEffectInFlight(acquired.lease, operation.operationId);
        const result = spawnSync(process.execPath, ['-e',
          "const fs=require('node:fs'); const [path,id]=process.argv.slice(1); const data=fs.existsSync(path)?JSON.parse(fs.readFileSync(path)):[]; data.push(id); fs.writeFileSync(path,JSON.stringify(data));",
          process.argv[6], operation.operationId], { encoding: 'utf8', timeout: 5000 });
        if (result.status !== 0) process.exit(7);
        process.send({ effectApplied: true }, () => process.kill(process.pid, 'SIGKILL'));`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(pins), JSON.stringify(control), JSON.stringify(operation), externalFile]);
      assert.equal((await message(owner)).effectApplied, true);
      assert.equal((await owner.finished).signal, 'SIGKILL');
      assert.deepEqual(JSON.parse(readFileSync(externalFile, 'utf8')), [operation.operationId]);
      const recovered = acquireScheduler(repository, pins, initiator);
      const checkpoint = readCheckpoint(repository, pins.runId);
      assert.equal(checkpoint.outbox[operation.operationId].phase, 'unknown');
      assert.equal(readRequest(repository, pins.runId, control.requestId).status, 'unknown');
      refuses('OUTCOME_UNKNOWN', () => markEffectInFlight(recovered.lease, operation.operationId));
      const receipt = { externalId: operation.target.id, observationDigest: schedulerDigest(JSON.parse(readFileSync(externalFile, 'utf8'))), observedAt: Date.now() };
      const settled = settleEffect(recovered.lease, operation.operationId, { attempt: 1, status: 'applied', code: 'CONTROL_APPLIED', receipt });
      assert.equal(settled.outbox[operation.operationId].phase, 'succeeded');
      assert.equal(settled.requests[control.requestId].status, 'applied');
      assert.equal(readRequest(repository, pins.runId, control.requestId).outcome.appliedRevision, settled.revision);
      assert.deepEqual(JSON.parse(readFileSync(externalFile, 'utf8')), [operation.operationId]);
      finish(repository, recovered);
    });
    await check('a stopped run with unclaimed durable requests must reconcile before a new run', () => {
      const { repository, pins, initiator } = fixture();
      const first = acquireScheduler(repository, pins, initiator);
      const control = request(pins.runId);
      submitControl(repository, actor(), control);
      finish(repository, first);
      const nextPins = { ...pins, runId: randomUUID(), createdAt: Date.now() };
      refuses('RUN_MISMATCH', () => acquireScheduler(repository, nextPins, initiator));
      const recovered = acquireScheduler(repository, pins, initiator);
      assert.equal(readCheckpoint(repository, pins.runId).desiredState, 'stopped');
      assert.deepEqual(listControlRequests(repository, pins.runId), [control.requestId]);
      assert.equal(claimControl(recovered.lease, control.requestId).outcome.code, 'TARGET_MISMATCH');
      finish(repository, recovered);
      const second = acquireScheduler(repository, nextPins, initiator);
      finish(repository, second);
    });
    await check('a late old-run producer is refused durably by the new sole repository writer', async () => {
      const { repository, pins, initiator, home } = fixture();
      const first = acquireScheduler(repository, pins, initiator);
      const control = request(pins.runId);
      const readyFile = join(home, 'producer-ready');
      const resumeFile = join(home, 'producer-resume');
      const producer = startChild(`import { existsSync, writeFileSync } from 'node:fs'; const api = await import(process.argv[1]);
        const repository = api.resolveRepository(process.argv[2]); const control = JSON.parse(process.argv[3]);
        try { api.submitControl(repository,
          { kind: 'terminal', sessionId: null, host: api.readProcessIdentity(), invocationId: '${randomUUID()}' }, control,
          { observe: (phase, path) => {
            if (phase === 'temporary-flushed' && path.includes('/requests/')) {
              writeFileSync(process.argv[4], 'ready'); const until = Date.now() + 15000;
              while (!existsSync(process.argv[5])) { if (Date.now() > until) throw new Error('Fixture synchronization failed');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
            }
          } }); process.send({ accepted: true }, () => process.disconnect());
        } catch (error) { process.send({ accepted: false, code: error.code }, () => process.disconnect()); }`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(control), readyFile, resumeFile]);
      const deadline = Date.now() + 15000;
      while (!existsSync(readyFile)) {
        assert(Date.now() < deadline, 'The producer did not reach its publication boundary.');
        await new Promise((done) => setTimeout(done, 10));
      }
      finish(repository, first);
      const nextPins = { ...pins, runId: randomUUID(), createdAt: Date.now() };
      const second = acquireScheduler(repository, nextPins, initiator);
      const answer = message(producer);
      writeFileSync(resumeFile, 'resume');
      assert.deepEqual(await answer, { accepted: false, code: 'RUN_MISMATCH' });
      await producer.finished;
      const claimed = claimControl(second.lease, control.requestId);
      assert.equal(claimed.status, 'refused');
      assert.equal(claimed.outcome.code, 'RUN_MISMATCH');
      assert.equal(readRequest(repository, pins.runId, control.requestId).status, 'refused');
      assert.equal(readCheckpoint(repository, pins.runId).state, 'stopped');
      finish(repository, second);
    });
    await check('schema validation rejects malformed nested outcomes without throwing or pruning receipts', () => {
      const { repository, pins, initiator } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const control = request(pins.runId);
      submitControl(repository, actor(), control);
      claimControl(acquired.lease, control.requestId);
      completeControl(acquired.lease, control.requestId, { status: 'applied', code: 'PAUSED', operationId: null });
      const checkpoint = readCheckpoint(repository, pins.runId);
      const malformed = JSON.parse(JSON.stringify(checkpoint));
      malformed.requests[control.requestId].outcome.operationId = randomUUID();
      malformed.outbox = null;
      assert(validateCheckpoint(malformed).length > 0);
      refuses('STATE_INVALID', () => commitTransition(acquired.lease, checkpoint.revision, (value) => ({ ...value, requests: {} })));
      assert.equal(readRequest(repository, pins.runId, control.requestId).status, 'applied');
      finish(repository, acquired);
    });
    await check('planted request links, FIFOs and state-directory links are refused without redirecting writes', () => {
      for (const type of ['link', 'fifo', 'directory']) {
        const { repository, pins, initiator, home, state } = fixture();
        const acquired = acquireScheduler(repository, pins, initiator);
        const control = request(pins.runId);
        const admitted = actor();
        const outside = join(home, 'outside.json');
        const original = JSON.stringify({ ...control, actor: admitted });
        writeFileSync(outside, original);
        if (type === 'directory') {
          const lock = join(state, 'lock');
          renameSync(lock, join(state, 'saved-lock'));
          symlinkSync(join(state, 'saved-lock'), lock);
          refuses('STATE_INVALID', () => readSchedulerOwner(repository));
        } else {
          const directory = controlDirectory(repository, 'requests', true);
          const path = join(directory, `${control.requestId}.json`);
          if (type === 'link') symlinkSync(outside, path);
          else {
            const made = spawnSync('mkfifo', [path], { encoding: 'utf8', timeout: 5000 });
            assert.equal(made.status, 0, made.stderr);
          }
          refuses('STATE_IO_FAILED', () => submitControl(repository, admitted, control));
          assert.deepEqual(readCheckpoint(repository, pins.runId).requests, {});
          finish(repository, acquired);
        }
        assert.equal(readFileSync(outside, 'utf8'), original);
      }
    });
    await check('registered worker process/session actors cannot submit controls and live bindings cannot be erased', async () => {
      const { repository, pins, initiator, state } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      const worker = startChild('setInterval(() => {}, 1000);', [], { cwd: repository.coordinatorRoot, detached: true });
      const attemptId = randomUUID();
      const binding = {
        schema: 'autoloop.worker-binding/1', runId: pins.runId, generation: 1, unitId: randomUUID(), unitGeneration: 1,
        attemptId, sessionId: randomUUID(), worktreeGitDir: git('-C', repository.coordinatorRoot, 'rev-parse', '--absolute-git-dir'),
        process: readProcessIdentity(worker.pid), pgid: worker.pid, groupLeader: readProcessIdentity(worker.pid),
        role: 'implement', posture: 'writer', actualModel: 'fixture-writer',
        liveFile: join(state, 'runs', pins.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false,
      };
      const bound = registerWorker(acquired.lease, 1, binding, { guardDirectory: join(scratch, 'workers') });
      assert.equal(readFileSync(binding.liveFile, 'utf8'), '');
      refuses('HOST_AUTH_REQUIRED', () => submitControl(repository,
        { kind: 'terminal', sessionId: null, host: binding.process, invocationId: randomUUID() }, request(pins.runId)));
      refuses('HOST_AUTH_REQUIRED', () => submitControl(repository,
        { kind: 'mod', sessionId: binding.sessionId, host: readProcessIdentity(), invocationId: randomUUID() }, request(pins.runId)));
      refuses('OWNER_UNVERIFIED', () => commitTransition(acquired.lease, bound.revision, (value) => ({ ...value, workers: [] })));
      await endChild(worker);
      const cleared = commitTransition(acquired.lease, bound.revision, (value) => ({ ...value, workers: [] }));
      assert.deepEqual(cleared.workers, []);
      finish(repository, acquired);
    });
    await check('a reused PID start identity cannot retain ownership or authorize an old in-process lease', () => {
      const { repository, pins, initiator, state } = fixture();
      const first = acquireScheduler(repository, pins, initiator);
      const leasePath = join(state, 'lock', '1.json');
      const checkpointPath = join(state, 'runs', pins.runId, 'checkpoint.json');
      const recorded = JSON.parse(readRegularFile(leasePath));
      const checkpoint = JSON.parse(readRegularFile(checkpointPath));
      const oldStart = process.platform === 'linux' ? '0' : 'Mon Jan 1 00:00:00 1990';
      assert.notEqual(oldStart, processStart(recorded.owner.pid));
      writeFileSync(leasePath, JSON.stringify({ ...recorded, owner: { ...recorded.owner, start: oldStart } }));
      writeFileSync(checkpointPath, JSON.stringify({ ...checkpoint, owner: { ...checkpoint.owner, start: oldStart } }));
      refuses('LEASE_INVALID', () => commitTransition(first.lease, 1, (value) => value));
      const recovered = acquireScheduler(repository, pins, initiator);
      assert.equal(recovered.generation, 2);
      assert.equal(readCheckpoint(repository, pins.runId).state, 'recovering');
      finish(repository, recovered);
    });
    await check('crash after transport claim and before checkpoint claim cannot execute an effect', async () => {
      const { repository, pins, initiator } = fixture();
      const control = request(pins.runId);
      const consumer = startChild(`const api = await import(process.argv[1]); const repository = api.resolveRepository(process.argv[2]);
        const pins = JSON.parse(process.argv[3]); const control = JSON.parse(process.argv[4]);
        const acquired = api.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() },
          { observe: (phase) => { if (phase === 'control-claimed') process.kill(process.pid, 'SIGKILL'); } });
        api.submitControl(repository, { kind: 'terminal', sessionId: null, host: api.readProcessIdentity(), invocationId: '${randomUUID()}' }, control);
        api.claimControl(acquired.lease, control.requestId);`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(pins), JSON.stringify(control)]);
      assert.equal((await consumer.finished).signal, 'SIGKILL');
      const recovered = acquireScheduler(repository, pins, initiator);
      assert.equal(readRequest(repository, pins.runId, control.requestId).status, 'pending');
      assert.equal(claimControl(recovered.lease, control.requestId).outcome.code, 'TARGET_MISMATCH');
      assert.deepEqual(readCheckpoint(repository, pins.runId).outbox, {});
      finish(repository, recovered);
    });
    await check('crash after outcome flush but before acknowledgment replays the durable outcome', async () => {
      const { repository, pins, initiator } = fixture();
      const control = request(pins.runId);
      const consumer = startChild(`const api = await import(process.argv[1]); const repository = api.resolveRepository(process.argv[2]);
        const pins = JSON.parse(process.argv[3]); const control = JSON.parse(process.argv[4]); let armed = false;
        const acquired = api.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() },
          { observe: (phase, path) => { if (armed && phase === 'directory-flushed' && path.endsWith('/checkpoint.json')) process.kill(process.pid, 'SIGKILL'); } });
        api.submitControl(repository, { kind: 'terminal', sessionId: null, host: api.readProcessIdentity(), invocationId: '${randomUUID()}' }, control);
        api.claimControl(acquired.lease, control.requestId); armed = true;
        api.completeControl(acquired.lease, control.requestId, { status: 'applied', code: 'PAUSED', operationId: null },
          (value) => ({ ...value, state: 'paused', desiredState: 'paused' }));`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(pins), JSON.stringify(control)]);
      assert.equal((await consumer.finished).signal, 'SIGKILL');
      const recovered = acquireScheduler(repository, pins, initiator);
      const response = claimControl(recovered.lease, control.requestId);
      assert.equal(response.status, 'applied');
      assert.equal(response.claimedNow, false);
      assert.equal(readRequest(repository, pins.runId, control.requestId).outcome.code, 'PAUSED');
      finish(repository, recovered);
    });
    await check('independent effect outcomes never imply sibling success or early control completion', () => {
      const { repository, pins, initiator, home } = fixture();
      const acquired = acquireScheduler(repository, pins, initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const control = request(pins.runId, 'stop-now');
      submitControl(repository, actor(), control);
      claimControl(acquired.lease, control.requestId);
      const review = { ...effect(pins.runId, control.requestId), kind: 'review.fixture' };
      const gate = { ...effect(pins.runId, control.requestId), kind: 'gate.fixture' };
      prepareEffect(acquired.lease, readCheckpoint(repository, pins.runId).revision, review);
      markEffectInFlight(acquired.lease, review.operationId);
      prepareEffect(acquired.lease, readCheckpoint(repository, pins.runId).revision, gate);
      markEffectInFlight(acquired.lease, gate.operationId);
      const externalFile = join(home, 'review-effect.json');
      const applied = spawnSync(process.execPath, ['-e',
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ applied: true }));", externalFile], { timeout: 5000 });
      assert.equal(applied.status, 0);
      const receipt = { externalId: review.target.id, observationDigest: schedulerDigest(JSON.parse(readFileSync(externalFile, 'utf8'))), observedAt: Date.now() };
      const reviewed = settleEffect(acquired.lease, review.operationId, { attempt: 1, status: 'applied', code: 'REVIEW_DONE', receipt });
      assert.equal(reviewed.outbox[review.operationId].phase, 'succeeded');
      assert.equal(reviewed.outbox[gate.operationId].phase, 'in-flight');
      assert.equal(reviewed.requests[control.requestId].status, 'processing');
      refuses('OUTCOME_UNKNOWN', () => completeControl(acquired.lease, control.requestId, { status: 'applied', code: 'DONE', operationId: review.operationId }));
      const failed = spawnSync(process.execPath, ['-e', 'process.exit(7);'], { timeout: 5000 });
      assert.equal(failed.status, 7);
      const gated = settleEffect(acquired.lease, gate.operationId, { attempt: 1, status: 'failed', code: 'GATE_FAILED', receipt: null });
      assert.equal(gated.outbox[review.operationId].phase, 'succeeded');
      assert.equal(gated.outbox[gate.operationId].phase, 'failed');
      assert.equal(gated.requests[control.requestId].status, 'refused');
      finish(repository, acquired);
    });
    await check('crash before an external call retains prepared intent until explicit stopped abandonment', async () => {
      const { repository, pins, initiator, home } = fixture();
      const operation = effect(pins.runId);
      const externalFile = join(home, 'external-before-call.json');
      const consumer = startChild(`const api = await import(process.argv[1]); const repository = api.resolveRepository(process.argv[2]);
        const pins = JSON.parse(process.argv[3]); const operation = JSON.parse(process.argv[4]);
        const acquired = api.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() });
        api.commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
        api.prepareEffect(acquired.lease, 2, operation); process.kill(process.pid, 'SIGKILL');`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(pins), JSON.stringify(operation)]);
      assert.equal((await consumer.finished).signal, 'SIGKILL');
      assert.equal(existsSync(externalFile), false);
      const recovered = acquireScheduler(repository, pins, initiator);
      const checkpoint = readCheckpoint(repository, pins.runId);
      assert.equal(checkpoint.outbox[operation.operationId].phase, 'prepared');
      refuses('RECOVERY_REQUIRED', () => markEffectInFlight(recovered.lease, operation.operationId));
      refuses('RECOVERY_REQUIRED', () => commitTransition(recovered.lease, checkpoint.revision, (value) => ({ ...value, state: 'running' })));
      refuses('RUN_ACTIVE', () => abandonPreparedEffect(recovered.lease, operation.operationId));
      commitTransition(recovered.lease, checkpoint.revision, (value) => ({ ...value, desiredState: 'stopped', state: 'draining' }));
      abandonPreparedEffect(recovered.lease, operation.operationId);
      assert.equal(readCheckpoint(repository, pins.runId).outbox[operation.operationId].phase, 'failed');
      assert.equal(existsSync(externalFile), false);
      finish(repository, recovered);
    });
  } finally {
    await Promise.all([...children].map((child) => endChild(child, 'SIGKILL')));
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(results.every(([, passed]) => passed)
    ? `self-test OK (${results.length} cases)`
    : `self-test FAILED (${results.filter(([, passed]) => !passed).length}/${results.length})`);
  return results.every(([, passed]) => passed);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exit(await selfTest() ? 0 : 1);
  console.error('usage: scheduler-contract.mjs --self-test');
  process.exit(2);
}
