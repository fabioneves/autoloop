#!/usr/bin/env node
// Durable scheduler state (docs/specs/SPEC-loop-daemon.md). No daemon launch,
// queue selection or operator-admission shortcut lives in this module.

import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigText, resolveProjectConfig, validateConfig } from './config-contract.mjs';
import {
  hasRetainedSelection, issueAuthorizationEvidence, selectionSnapshotReference, validateAllocationCreator,
  validateIssueAuthorizationEvidence, validateSelectionRecords, validateSelectionSnapshot, validateSnapshotReference,
  validatePlanArtifact, validatePlanningRelationship, requestedPlanGenerationFloor,
} from './scheduler-selection-schema.mjs';
import { deliveredPullRequests, markerSchedule, SNAPSHOT_SECTIONS } from './snapshot-contract.mjs';
export { hasRetainedSelection } from './scheduler-selection-schema.mjs';
import { DEFAULT_MODELS, invariantProblems, mergeModels, MODEL_ROLES, modelsShapeProblems } from './models-config.mjs';
import { isClaudeProcess, processAlive, processStart, procEntry, readRegularFile, publishWorkerGuard, readBootIdentity, executionAdmissionGuardDirectory } from './run-markers.mjs';
import { boundedGit } from './git-budget.mjs';
import { parseGitHubRemote } from './checkout-contract.mjs';
import { canonicalBoundary, inLane, intersectBoundaries } from './lane-contract.mjs';
import { readPlanningWorktreeContext } from './scheduler-planning-context.mjs';
import { readGitStatus } from './git-observation.mjs';
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

function checkoutGit(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  const result = boundedGit(['--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { env, maxBuffer: 1024 * 1024 });
  requireCondition(result.status === 0 && !result.error, 'REPOSITORY_INVALID', 'The repository cannot be verified.');
  return result.stdout.trim();
}
function gitFact(root, args) { return checkoutGit(root, ['rev-parse', ...args]); }
export function resolveRepositoryCheckout(root) {
  requireCondition(nonempty(root), 'INVALID_INPUT', 'A repository root is required.');
  try {
    const directory = realpathSync(resolve(root));
    const facts = gitFact(directory, ['--path-format=absolute', '--show-toplevel', '--git-common-dir', '--absolute-git-dir']).split('\n');
    // Git emits one line per fact, but a valid path can itself contain LF.
    // Preserve the original fresh reads and per-field trim for that framing.
    const [coordinatorRoot, commonDir, gitDir] = facts.length === 3
      ? facts.map((path) => realpathSync(path.trim()))
      : [realpathSync(gitFact(directory, ['--show-toplevel'])),
        realpathSync(gitFact(directory, ['--path-format=absolute', '--git-common-dir'])),
        realpathSync(gitFact(directory, ['--absolute-git-dir']))];
    requireCondition([commonDir, gitDir].every((path) => lstatSync(path).isDirectory()), 'REPOSITORY_INVALID', 'The Git directory is invalid.');
    return Object.freeze({
      repositoryKey: createHash('sha256').update(commonDir, 'utf8').digest('hex'),
      commonDir, gitDir, root: coordinatorRoot,
    });
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('REPOSITORY_INVALID', 'The repository cannot be verified.');
  }
}

export function resolveRepository(root) {
  const checkout = resolveRepositoryCheckout(root);
  return Object.freeze({ repositoryKey: checkout.repositoryKey, commonDir: checkout.commonDir, coordinatorRoot: checkout.root });
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

function checkStoragePermissions(stat, privateMode) {
  // Shared Git/legacy ancestors may be readable, but not writable by other accounts.
  // Null is only a read-only probe for never-daemon legacy storage. It still
  // requires an owned real directory, and cannot publish daemon authority.
  const prohibited = privateMode === null ? 0 : privateMode ? 0o077 : 0o022;
  requireCondition(stat.uid === userInfo().uid && (stat.mode & prohibited) === 0,
    'STATE_INVALID', 'State storage ownership or permissions are invalid.');
}
function safeDirectory(path, create = false, observe = () => {}, privateMode = false) {
  requireCondition(!create || privateMode !== null, 'INVALID_INPUT', 'An absence probe cannot create storage.');
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
      const stat = fstatSync(fd);
      requireCondition(stat.isDirectory(), 'STATE_INVALID', 'A state directory is invalid.');
      checkStoragePermissions(stat, privateMode);
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
  for (const name of ['autoloop', 'scheduler']) directory = safeDirectory(join(directory, name), create, observe, name === 'scheduler');
  return directory;
}
function childDirectory(parent, name, create = false, observe = () => {}, privateMode = true) {
  requireCondition(nonempty(name) && !name.includes('/') && name !== '.' && name !== '..', 'INVALID_INPUT', 'A state component is invalid.');
  return safeDirectory(join(safeDirectory(parent), name), create, observe, privateMode);
}
function readStateFile(path) {
  safeDirectory(dirname(path), false, undefined, true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireCondition(stat.isFile(), 'STATE_IO_FAILED', 'A state record is not a regular file.');
    checkStoragePermissions(stat, true);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function stateJson(path, optional = false) {
  try {
    return JSON.parse(readStateFile(path));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(error instanceof SyntaxError ? 'STATE_INVALID' : 'STATE_IO_FAILED', 'A state record cannot be read.');
  }
}
function syncDirectory(path) {
  const fd = openSync(safeDirectory(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireCondition(stat.isDirectory(), 'STATE_INVALID', 'A flush target is not a directory.');
    checkStoragePermissions(stat, false);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
// Instrumentation is for crash/OS-failure tests, not an alternate filesystem.
// Acknowledgment follows the file flush, publication and directory flush.
function durableWrite(path, value, { exclusive = false, observe = () => {} } = {}) {
  const directory = safeDirectory(dirname(path), false, undefined, true);
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
    safeDirectory(directory, false, undefined, true);
    if (exclusive) linkSync(temporary, path);
    else {
      if (present(path)) readStateFile(path);
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
  errors.push(...validateSelectionRecords(value));
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
  // Legacy reads and starts impose no daemon mode policy when its namespace
  // is absent. Protected established authority is checked separately.
  let directory = safeDirectory(repository.commonDir, false, undefined, null);
  const ancestors = [directory];
  for (const name of ['autoloop', 'scheduler']) {
    directory = join(directory, name);
    if (!present(directory)) return null;
    safeDirectory(directory, false, undefined, name === 'scheduler' ? true : null);
    if (name === 'autoloop') ancestors.push(directory);
  }
  for (const path of ancestors) safeDirectory(path);
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
  assertEstablishedAuthority(repository, ledger);
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
  assertEstablishedAuthority(repository, ledger);
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
const AUTHORITY_SCHEMA = 'autoloop.scheduler-authority/1';
function admissionDirectory(repository, create = false, observe = () => {}) {
  requireCondition(hash(repository.repositoryKey), 'INVALID_INPUT', 'The repository key is invalid.');
  const root = executionAdmissionGuardDirectory(); const directory = join(root, repository.repositoryKey);
  safeDirectory(dirname(dirname(dirname(root))));
  for (const path of [dirname(dirname(root)), dirname(root), root, directory]) {
    if (!create && !present(path)) return null;
    safeDirectory(path, create, observe, path === root || path === directory);
  }
  return directory;
}
function readAuthorityMarker(repository) {
  const directory = admissionDirectory(repository);
  if (directory === null) return null;
  const marker = stateJson(join(directory, 'daemon-authority.json'), true);
  requireCondition(marker === null || (exactKeys(marker, ['schema', 'repositoryKey', 'commonDir', 'leaseId', 'runId', 'createdAt'])
    && marker.schema === AUTHORITY_SCHEMA && marker.repositoryKey === repository.repositoryKey && marker.commonDir === repository.commonDir
    && uuid(marker.leaseId) && uuid(marker.runId) && timestamp(marker.createdAt)),
  'STATE_INVALID', 'The protected daemon authority marker is invalid.');
  return marker;
}
function assertEstablishedAuthority(repository, ledger) {
  const marker = readAuthorityMarker(repository);
  requireCondition(marker === null || ledger.some(({ record: item }) => item.leaseId === marker.leaseId && item.runId === marker.runId),
    'RECOVERY_REQUIRED', 'Protected daemon authority has missing Git state.');
  return marker;
}
function establishAuthorityMarker(repository, identity, ledger, observe) {
  if (assertEstablishedAuthority(repository, ledger) !== null) return;
  const directory = admissionDirectory(repository, true, observe);
  durableWrite(join(directory, 'daemon-authority.json'), { schema: AUTHORITY_SCHEMA, repositoryKey: repository.repositoryKey,
    commonDir: repository.commonDir, leaseId: identity.leaseId, runId: identity.runId, createdAt: identity.createdAt },
  { exclusive: true, observe });
}

// Both upgraded start paths hold this short gate until lifetime ownership is
// published. Its private OS-account ledger does not impose daemon storage modes
// on never-daemon legacy repositories. The immutable link election is unchanged.
export function withExecutionAdmission(repository, establish, { observe = () => {} } = {}) {
  verifyRepository(repository);
  const directory = admissionDirectory(repository, true, observe);
  readAuthorityMarker(repository);
  const owner = readProcessIdentity();
  const until = Date.now() + 10_000;
  let identity;
  for (;;) {
    const names = readdirSync(directory).filter((name) => name !== 'daemon-authority.json' && !/^\.[0-9a-f-]+\.tmp$/u.test(name));
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
    assertEstablishedAuthority(repository, readLedger(repository));
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
  if (!current || current.state !== 'stopped' || retainedWorkers(current) || hasRetainedSelection(current) || hasUnresolvedEffects(current) || pendingRequests(repository, current)) {
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
  assertEstablishedAuthority(repository, readLedger(repository));
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
    if (recovered === null || recovered.state !== 'stopped' || retainedWorkers(recovered) || hasRetainedSelection(recovered) || hasUnresolvedEffects(recovered) || pendingRequests(repository, recovered)) {
      requireCondition(previousId === pins.runId, 'RUN_MISMATCH', 'Recover the preceding run before starting another.');
    }
  }
  if (recovered && recovered.runId === pins.runId) {
    requireCondition(recovered.state !== 'stopped' || retainedWorkers(recovered) || hasRetainedSelection(recovered) || hasUnresolvedEffects(recovered) || pendingRequests(repository, recovered),
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
    establishAuthorityMarker(repository, identity, ledger, observe);
    durableWrite(join(lock, `${sequence}.json`), identity, { exclusive: true, observe });
  } catch (error) {
    if (error.code === 'STATE_CONFLICT') throw new SchedulerError('SCHEDULER_ACTIVE', 'Another scheduler acquired the repository.');
    throw error;
  }
  const lease = Object.freeze({});
  const binding = { repository: Object.freeze({ ...repository }), identity, active: true, observe, writing: false,
    planningAllowance: null, planningObservers: new Map() };
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
  const ledger = readLedger(binding.repository);
  assertEstablishedAuthority(binding.repository, ledger);
  const last = ledger.at(-1);
  requireCondition(last && !last.released && canonicalJson(last.record) === canonicalJson(binding.identity)
    && schedulerDigest(owner) === schedulerDigest(binding.identity.owner), 'LEASE_INVALID', 'The writer lease was superseded.');
  return binding;
}
// Returned data is a fresh read, not a transferable lease or writer handle.
export function readSchedulerContext(lease) {
  const binding = heldLease(lease, true);
  const checkpoint = readCheckpoint(binding.repository, binding.identity.runId);
  requireCondition(checkpoint.generation === binding.identity.generation, 'LEASE_INVALID', 'The writer generation changed.');
  const pins = readPins(binding.repository, checkpoint.runId);
  assertPinsLive(binding.repository, pins);
  heldLease(lease, true);
  return { repository: { ...binding.repository }, pins, checkpoint };
}
function selectionIdentity(binding, evidence, checkpoint, pins, current) {
  requireCondition(evidence.runId === checkpoint.runId && evidence.repositoryKey === binding.repository.repositoryKey
    && evidence.commonDir === binding.repository.commonDir && evidence.generation <= checkpoint.generation
    && evidence.checkpointRevision <= checkpoint.revision && evidence.configDigest === pins.configDigest
    && evidence.configuredBaseBranch === pins.baseBranch, 'EVIDENCE_INVALID', 'The evidence belongs to another run or configuration.');
  const checkout = resolveRepositoryCheckout(evidence.root);
  requireCondition(['root', 'gitDir', 'commonDir', 'repositoryKey'].every((key) => checkout[key] === evidence[key]),
    'EVIDENCE_CHANGED', 'The evidence checkout identity changed.');
  if (!current) return;
  requireCondition(evidence.generation === checkpoint.generation && evidence.checkpointRevision === checkpoint.revision,
    'REVISION_MISMATCH', 'The selection evidence is historical.');
  requireCondition(evidence.snapshot.invalidation.reasonCodes.length === 0
    && SNAPSHOT_SECTIONS.every((name) => evidence.snapshot.sections[name].complete)
    && evidence.sources.waitIssues.complete && evidence.sources.waitPullRequests.complete,
  'EVIDENCE_INCOMPLETE', 'Selection requires complete current evidence.');
  const configured = resolveProjectConfig(pins.coordinatorRoot);
  requireCondition(configured?.ok && schedulerDigest(configured.config) === pins.configDigest,
    'PINS_CHANGED', 'The pinned repository configuration changed.');
  const origins = checkoutGit(checkout.root, ['config', '--get-all', 'remote.origin.url']).split(/\r?\n/u).filter(Boolean);
  const origin = origins.length === 1 ? parseGitHubRemote(origins[0]) : null;
  requireCondition(origin && origin.host === evidence.repository.host.toLowerCase()
    && origin.owner === evidence.repository.owner.toLowerCase() && origin.repo === evidence.repository.name.toLowerCase(),
  'EVIDENCE_CHANGED', 'The canonical repository origin changed.');
  requireCondition(gitFact(checkout.root, ['--verify', 'HEAD^{commit}']) === evidence.headOid
    && gitFact(checkout.root, ['--verify', `${evidence.baseRef}^{commit}`]) === evidence.baseOid,
  'EVIDENCE_CHANGED', 'The checkout HEAD or configured base changed.');
}
function selectionEvidenceDirectory(binding, reference, create = false) {
  const checkout = resolveRepositoryCheckout(reference.root);
  requireCondition(checkout.gitDir === reference.gitDir && checkout.commonDir === binding.repository.commonDir
    && checkout.repositoryKey === binding.repository.repositoryKey, 'EVIDENCE_INVALID', 'The evidence administrative directory is invalid.');
  let directory = safeDirectory(checkout.gitDir);
  for (const name of ['autoloop', 'scheduler', 'snapshots', reference.runId, 'sha256']) {
    directory = childDirectory(directory, name, create, binding.observe, name !== 'autoloop');
  }
  return directory;
}
export function publishSelectionSnapshot(lease, expectedRevision, evidence) {
  const binding = heldLease(lease);
  requireCondition(validateSelectionSnapshot(evidence).length === 0 && safeValues(evidence), 'INVALID_INPUT', 'The selection evidence is invalid.');
  const immutable = JSON.parse(canonicalJson(evidence));
  const context = readSchedulerContext(lease);
  requireCondition(context.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
  selectionIdentity(binding, immutable, context.checkpoint, context.pins, true);
  const reference = selectionSnapshotReference(immutable);
  binding.writing = true;
  try {
    const path = join(selectionEvidenceDirectory(binding, reference, true), `${reference.contentDigest}.json`);
    heldLease(lease, true);
    try { durableWrite(path, immutable, { exclusive: true, observe: binding.observe }); }
    catch (error) {
      if (error.code !== 'STATE_CONFLICT') throw error;
      requireCondition(schedulerDigest(stateJson(path)) === reference.contentDigest, 'EVIDENCE_INVALID', 'The immutable evidence content changed.');
      try {
        syncDirectory(dirname(path));
        binding.observe('directory-flushed', path);
      } catch (failure) {
        if (failure instanceof SchedulerError) throw failure;
        throw new SchedulerError('STATE_IO_FAILED', 'The immutable evidence publication cannot be flushed.');
      }
    }
    readSelectionSnapshot(lease, reference);
    return reference;
  } finally { binding.writing = false; }
}
export function readSelectionSnapshot(lease, reference, { current = true } = {}) {
  const binding = heldLease(lease, true);
  requireCondition(validateSnapshotReference(reference).length === 0 && typeof current === 'boolean', 'INVALID_INPUT', 'The snapshot reference is invalid.');
  const context = readSchedulerContext(lease);
  const path = join(selectionEvidenceDirectory(binding, reference), `${reference.contentDigest}.json`);
  const evidence = stateJson(path);
  requireCondition(validateSelectionSnapshot(evidence).length === 0 && safeValues(evidence)
    && canonicalJson(selectionSnapshotReference(evidence)) === canonicalJson(reference), 'EVIDENCE_INVALID', 'The immutable selection evidence does not match its reference.');
  selectionIdentity(binding, evidence, context.checkpoint, context.pins, current);
  heldLease(lease, true);
  requireCondition(!current || readCheckpoint(binding.repository, context.checkpoint.runId).revision === context.checkpoint.revision,
    'REVISION_MISMATCH', 'The checkpoint changed during evidence readback.');
  return evidence;
}

function planningBoundary(root, paths) {
  try { return canonicalBoundary(root, paths); }
  catch (error) { throw new SchedulerError(error.code ?? 'BOUNDARY_PATH_INVALID', 'The canonical planning boundary cannot be verified.'); }
}
function planningFacts(root, retained, proposed, baseOid) {
  try { return readPlanningWorktreeContext(root, retained, proposed, baseOid); }
  catch (error) { throw new SchedulerError(error.code ?? 'EVIDENCE_CHANGED', 'The planning worktree context cannot be verified.'); }
}
function planningTarget(context, unitId, unitGeneration, proposed) {
  const { checkpoint, pins, repository } = context;
  const unit = checkpoint.units.find((item) => item.unitId === unitId);
  const reservation = checkpoint.reservations.find((item) => item.unitId === unitId);
  requireCondition(unit && reservation && unit.unitGeneration === unitGeneration && reservation.worktree && unit.plan
    && ['admitted', 'planning'].includes(reservation.state) && reservation.paths.length > 0 && unit.wait === null
    && unit.disposition === null, 'TARGET_MISMATCH', 'The retained planning unit is not available.');
  requireCondition(proposed.planGeneration > requestedPlanGenerationFloor(unit), 'TARGET_MISMATCH', 'A new proposal must exceed the requested plan generation floor.');
  const configured = resolveProjectConfig(pins.coordinatorRoot);
  requireCondition(configured?.ok && schedulerDigest(configured.config) === pins.configDigest, 'PINS_CHANGED', 'The pinned repository configuration changed.');
  const origins = checkoutGit(reservation.worktree.root, ['config', '--get-all', 'remote.origin.url']).split(/\r?\n/u).filter(Boolean);
  const origin = origins.length === 1 ? parseGitHubRemote(origins[0]) : null;
  const upstream = reservation.issueAuthorization.subject.repository;
  requireCondition(origin && origin.host === upstream.host.toLowerCase() && origin.owner === upstream.owner.toLowerCase()
    && origin.repo === upstream.name.toLowerCase(), 'EVIDENCE_CHANGED', 'The planning repository origin changed.');
  const checkout = resolveRepositoryCheckout(reservation.worktree.root);
  requireCondition(['root', 'gitDir', 'commonDir', 'repositoryKey'].every((key) => checkout[key] === reservation.worktree[key])
    && checkout.commonDir === repository.commonDir
    && checkoutGit(checkout.root, ['symbolic-ref', '--short', 'HEAD']) === reservation.worktree.branch,
  'EVIDENCE_CHANGED', 'The planning worktree binding changed.');
  const baseOid = gitFact(checkout.root, ['--verify', `refs/remotes/origin/${pins.baseBranch}^{commit}`]);
  requireCondition(baseOid === proposed.baseOid, 'EVIDENCE_CHANGED', 'The proposed plan does not use the configured base.');
  checkoutGit(checkout.root, ['merge-base', '--is-ancestor', baseOid, 'HEAD']);
  const boundary = planningBoundary(checkout.root, [...reservation.paths, ...proposed.boundary]).boundary;
  requireCondition(canonicalJson(boundary) === canonicalJson(proposed.boundary), 'TARGET_MISMATCH', 'A proposal must retain the full canonical boundary.');
  const addedPaths = boundary.filter((path) => !inLane(path, reservation.paths));
  requireCondition(addedPaths.length > 0, 'TARGET_MISMATCH', 'A failing-task relationship needs an expanded boundary.');
  return { unit, reservation, addedPaths, facts: planningFacts(checkout.root, reservation.paths, proposed.boundary, baseOid) };
}
function artifactMetadata(artifact) {
  return { planGeneration: artifact.planGeneration, planDigest: schedulerDigest(artifact), baseOid: artifact.baseOid, boundary: artifact.boundary };
}
function planningArtifactIdentity(artifact, context, unitId, unitGeneration) {
  requireCondition(validatePlanArtifact(artifact).length === 0 && safeValues(artifact), 'INVALID_INPUT', 'The full plan artifact is invalid.');
  const reservation = context.checkpoint.reservations.find((item) => item.unitId === unitId);
  requireCondition(reservation && artifact.repositoryKey === context.repository.repositoryKey && artifact.unitId === unitId
    && artifact.unitGeneration === unitGeneration && artifact.issue === reservation.issue
    && artifact.issueBodyDigest === reservation.issueAuthorization.subject.issueBodyDigest
    && artifact.authorizationDigest === reservation.issueAuthorization.authorizationDigest, 'TARGET_MISMATCH', 'The plan artifact names another unit or authorization.');
}
function checkPlanningRelationship(context, record, proposed) {
  requireCondition(record.runId === context.checkpoint.runId && record.schedulerGeneration === context.checkpoint.generation,
    'TARGET_MISMATCH', 'The observation belongs to another scheduler generation.');
  const target = planningTarget(context, record.unitId, record.unitGeneration, proposed);
  requireCondition(record.worktreeGitDir === target.reservation.worktree.gitDir
    && record.currentPlan.planGeneration === target.unit.plan.planGeneration && record.currentPlan.planDigest === target.unit.plan.planDigest
    && record.proposedPlan.planGeneration === proposed.planGeneration && record.proposedPlan.planDigest === proposed.planDigest
    && record.proposedPlan.boundaryDigest === schedulerDigest(proposed.boundary) && record.baseOid === proposed.baseOid
    && record.issueBodyDigest === target.reservation.issueAuthorization.subject.issueBodyDigest
    && record.authorizationDigest === target.reservation.issueAuthorization.authorizationDigest
    && canonicalJson(record.addedPaths) === canonicalJson(target.addedPaths), 'TARGET_MISMATCH', 'The observation does not match the retained plan and proposal.');
  requireCondition(['headOid', 'treeOid', 'worktreeStatusDigest'].every((key) => record[key] === target.facts[key]),
    'EVIDENCE_CHANGED', 'The observed worktree content or index changed.');
  return target;
}
export function readFailingTaskRelationship(lease, expectedRevision, relationshipId, request) {
  requireCondition(uuid(relationshipId) && exactKeys(request, ['unitId', 'unitGeneration', 'proposedPlanArtifact'])
    && uuid(request.unitId) && positive(request.unitGeneration), 'INVALID_INPUT', 'The planning relationship request is invalid.');
  const context = readSchedulerContext(lease);
  requireCondition(context.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
  requireCondition(context.checkpoint.state === 'running' && context.checkpoint.desiredState === 'running', 'RUN_ACTIVE', 'Widening requires running intent.');
  requireCondition(!pendingRequests(context.repository, context.checkpoint)
    && !Object.values(context.checkpoint.requests).some((item) => ['pending', 'processing', 'unknown'].includes(item.status)),
  'CONTROL_PENDING', 'Apply controls before consuming a planning relationship.');
  requireCondition(!planningRelationshipRecovery(context.checkpoint).pending, 'RECOVERY_REQUIRED', 'Task observation ownership is still pending.');
  const unit = context.checkpoint.units.find((item) => item.unitId === request.unitId);
  const record = unit?.planningRelationships?.find((item) => item.relationshipId === relationshipId);
  requireCondition(record && record.unitGeneration === request.unitGeneration, 'TARGET_MISMATCH', 'The planning relationship does not name this unit.');
  requireCondition(record.status === 'verified-failure', 'WIDEN_REASON_UNVERIFIED', 'The task observation is not a verified failure.');
  planningArtifactIdentity(request.proposedPlanArtifact, context, request.unitId, request.unitGeneration);
  checkPlanningRelationship(context, record, artifactMetadata(request.proposedPlanArtifact));
  heldLease(lease, true);
  requireCondition(readSchedulerContext(lease).checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint changed during relationship readback.');
  return JSON.parse(canonicalJson(record));
}
function writePlanningRecord(lease, revision, unitId, before, after) {
  const binding = heldLease(lease);
  requireCondition(binding.planningAllowance === null, 'STATE_BUSY', 'A planning observation transition is in progress.');
  binding.planningAllowance = { unitId, before: before === null ? null : canonicalJson(before), after: canonicalJson(after) };
  try {
    return commitTransition(lease, revision, (value) => ({ ...value, units: value.units.map((unit) => unit.unitId !== unitId ? unit : {
      ...unit, planningRelationships: before === null ? [...(unit.planningRelationships ?? []), after]
        : unit.planningRelationships.map((record) => record.relationshipId === before.relationshipId ? after : record),
    }) }));
  } finally { binding.planningAllowance = null; }
}
function ownedPlanningChild(child, pins) {
  requireCondition(child instanceof ChildProcess, 'INVALID_INPUT', 'A real directly owned child process is required.');
  requireCondition(child.exitCode === null && child.signalCode === null && child._handle,
    'OWNER_UNVERIFIED', 'The task child already exited.');
  requireCondition(child._handle.pid === child.pid && child._handle.constructor?.name === 'Process',
    'OWNER_UNVERIFIED', 'The native child process handle cannot be verified.');
  const identity = readProcessIdentity(child.pid); const entry = procEntry(child.pid);
  let executable = null;
  try { if (nonempty(entry?.[2])) executable = realpathSync(entry[2]); } catch { /* unverified executable refuses below */ }
  requireCondition(entry?.[0] === process.pid && executable === pins.nodePath && processGroupOf(child.pid) === child.pid
    && child.pid !== processGroupOf(process.pid), 'OWNER_UNVERIFIED', 'The Node child parent, executable or isolated group cannot be verified.');
  for (const [stream, index] of [[child.stdout, 1], [child.stderr, 2]]) requireCondition(stream && stream === child.stdio[index]
    && stream._handle?.constructor?.name === 'Pipe' && !stream.destroyed && !stream.readableEnded && !Readable.isDisturbed(stream)
    && stream.readableEncoding === null && stream.readableFlowing !== true && stream.listenerCount('data') === 0 && stream.listenerCount('readable') === 0,
  'INVALID_INPUT', 'The complete task output needs untouched stdout and stderr pipes.');
  let command;
  try {
    if (process.platform === 'linux') command = regularBytes(`/proc/${child.pid}/cmdline`);
    else {
      const observed = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(child.pid)], { encoding: null, timeout: 5000 });
      requireCondition(observed.status === 0 && !observed.error, 'OWNER_UNVERIFIED', 'The task command cannot be observed.'); command = observed.stdout;
    }
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('OWNER_UNVERIFIED', 'The task command cannot be observed.');
  }
  requireCondition(command.length > 0 && schedulerDigest(readProcessIdentity(child.pid)) === schedulerDigest(identity),
    'OWNER_UNVERIFIED', 'The task child identity changed.');
  return { process: identity, groupLeader: identity, pgid: child.pid,
    commandDigest: schedulerDigest({ nodePath: pins.nodePath, argvDigest: createHash('sha256').update(command).digest('hex') }) };
}
export function observeFailingTaskRelationship(lease, expectedRevision, child, request) {
  const binding = heldLease(lease);
  requireCondition(exactKeys(request, ['unitId', 'unitGeneration', 'currentPlanArtifact', 'proposedPlanArtifact', 'taskText', 'rationale'])
    && uuid(request.unitId) && positive(request.unitGeneration) && nonempty(request.taskText) && nonempty(request.rationale) && safeValues(request),
  'INVALID_INPUT', 'The owner planning judgment is invalid.');
  const context = readSchedulerContext(lease);
  requireCondition(context.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
  requireCondition(['running', 'paused'].includes(context.checkpoint.state) && context.checkpoint.desiredState !== 'stopped',
    'RUN_ACTIVE', 'This run cannot start a task observation.');
  planningArtifactIdentity(request.currentPlanArtifact, context, request.unitId, request.unitGeneration);
  planningArtifactIdentity(request.proposedPlanArtifact, context, request.unitId, request.unitGeneration);
  const proposed = artifactMetadata(request.proposedPlanArtifact);
  const target = planningTarget(context, request.unitId, request.unitGeneration, proposed);
  requireCondition(canonicalJson(artifactMetadata(request.currentPlanArtifact)) === canonicalJson(target.unit.plan),
    'TARGET_MISMATCH', 'The complete current artifact does not match the retained plan.');
  const first = request.currentPlanArtifact.body.indexOf(request.taskText);
  requireCondition(first >= 0 && request.currentPlanArtifact.body.indexOf(request.taskText, first + 1) === -1,
    'INVALID_INPUT', 'The owner must identify one exact task excerpt in the current plan.');
  const childBinding = ownedPlanningChild(child, context.pins);
  const record = { schema: 'autoloop.planning-relationship/1', relationshipId: randomUUID(), kind: 'failing-task',
    runId: context.checkpoint.runId, schedulerGeneration: context.checkpoint.generation, unitId: request.unitId,
    unitGeneration: request.unitGeneration, worktreeGitDir: target.reservation.worktree.gitDir,
    currentPlan: { planGeneration: target.unit.plan.planGeneration, planDigest: target.unit.plan.planDigest },
    proposedPlan: { planGeneration: proposed.planGeneration, planDigest: proposed.planDigest, boundaryDigest: schedulerDigest(proposed.boundary) },
    issueBodyDigest: target.reservation.issueAuthorization.subject.issueBodyDigest,
    authorizationDigest: target.reservation.issueAuthorization.authorizationDigest, baseOid: proposed.baseOid,
    headOid: target.facts.headOid, treeOid: target.facts.treeOid, worktreeStatusDigest: target.facts.worktreeStatusDigest,
    task: { text: request.taskText, textDigest: createHash('sha256').update(request.taskText, 'utf8').digest('hex') },
    rationale: request.rationale, addedPaths: target.addedPaths, ...childBinding, status: 'observing', exitCode: null, signal: null,
    stdoutDigest: null, stderrDigest: null, createdRevision: expectedRevision + 1, completedRevision: null };
  requireCondition(!(target.unit.planningRelationships ?? []).some((item) => item.status === 'observing'),
    'STATE_BUSY', 'This unit already has an observing task.');
  let finalized = false; let drainTimer = null;
  const streams = [child.stdout, child.stderr].map((stream) => {
    const state = { stream, hash: createHash('sha256'), failed: false };
    state.onData = (chunk) => { if (finalized) return; if (Buffer.isBuffer(chunk)) state.hash.update(chunk); else state.failed = true; };
    state.onError = () => { state.failed = true; };
    stream.on('data', state.onData); stream.on('error', state.onError); return state;
  });
  let monitorError = false; const onError = () => { monitorError = true; }; child.on('error', onError);
  let finish; let reject;
  const completion = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const settleObservation = (code, signal, forceInconclusive = false) => queueMicrotask(() => {
    if (finalized) return; finalized = true; clearTimeout(drainTimer);
    try {
      const held = heldLease(lease);
      const checkpoint = readCheckpoint(held.repository, held.identity.runId); const pins = readPins(held.repository, held.identity.runId);
      const current = { repository: held.repository, checkpoint, pins };
      let unchanged = false;
      try { assertPinsLive(held.repository, pins); checkPlanningRelationship(current, record, proposed); unchanged = true; }
      catch (error) { if (error.code === 'LEASE_INVALID') throw error; }
      const complete = streams.every((state) => !state.failed && state.stream.readableEnded);
      const normal = Number.isSafeInteger(code) && code >= 0 && signal === null && child.exitCode === code && child.signalCode === null;
      const conclusive = !forceInconclusive && complete && !monitorError && normal && observedGroupState(record) === 'empty' && unchanged;
      let status = 'inconclusive';
      if (conclusive) status = code === 0 ? 'not-failed' : 'verified-failure';
      const settled = { ...record, status,
        exitCode: Number.isSafeInteger(code) && code >= 0 ? code : null, signal: signal ?? null,
        stdoutDigest: !streams[0].failed && streams[0].stream.readableEnded ? streams[0].hash.digest('hex') : null,
        stderrDigest: !streams[1].failed && streams[1].stream.readableEnded ? streams[1].hash.digest('hex') : null,
        completedRevision: checkpoint.revision + 1 };
      writePlanningRecord(lease, checkpoint.revision, request.unitId, record, settled); finish(JSON.parse(canonicalJson(settled)));
    } catch (error) { reject(error); }
    finally { binding.planningObservers.delete(record.relationshipId); }
  });
  const onClose = (code, signal) => settleObservation(code, signal);
  const onExit = (code, signal) => {
    // This starts only after native exit, not at task launch. Detached children
    // can retain pipes even when the recorded group is empty. Give buffered
    // output a finite drain, without inventing EOF or verifying partial bytes.
    if (observedGroupState(record) !== 'empty') settleObservation(code, signal, true);
    else drainTimer = setTimeout(() => settleObservation(code, signal, true), 1000);
  };
  child.once('exit', onExit); child.once('close', onClose);
  try {
    // The gate remains with the trusted caller. Record and stream ownership are
    // established before returning; text/rationale are the owner's judgment.
    requireCondition(schedulerDigest(readProcessIdentity(child.pid)) === schedulerDigest(record.process), 'OWNER_UNVERIFIED', 'The task child exited before observation.');
    checkPlanningRelationship(context, record, proposed);
    writePlanningRecord(lease, expectedRevision, request.unitId, null, record);
    binding.planningObservers.set(record.relationshipId, child);
    return { relationshipId: record.relationshipId, completion };
  } catch (error) {
    clearTimeout(drainTimer);
    child.removeListener('exit', onExit); child.removeListener('close', onClose); child.removeListener('error', onError);
    for (const state of streams) { state.stream.removeListener('data', state.onData); state.stream.removeListener('error', state.onError); }
    throw error;
  }
}
export function reconcilePlanningRelationships(lease, expectedRevision) {
  const context = readSchedulerContext(lease);
  requireCondition(context.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
  let checkpoint = context.checkpoint;
  for (const unit of context.checkpoint.units) for (const record of unit.planningRelationships ?? []) {
    if (record.status !== 'observing' || record.schedulerGeneration === checkpoint.generation || observedGroupState(record) !== 'empty') continue;
    const settled = { ...record, status: 'inconclusive', exitCode: null, signal: null, stdoutDigest: null, stderrDigest: null,
      completedRevision: checkpoint.revision + 1 };
    checkpoint = writePlanningRecord(lease, checkpoint.revision, unit.unitId, record, settled);
  }
  return checkpoint;
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
  validatePersistentTransition(binding, current, updated, lease);
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
    && (hasRetainedSelection(updated) || hasUnresolvedEffects(updated) || updated.workers.some((worker) => worker.generation < updated.generation && boundGroupState(worker) !== 'empty'))),
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
  const units = checkpoint.units.map((unit) => unit.admission === null ? unit : { ...unit, admission: null, replanRequired: true });
  const reservations = checkpoint.reservations.map((reservation) => reservation.state === 'admitted' ? { ...reservation, state: 'recovering' } : reservation);
  return { ...checkpoint, outbox, requests, units, reservations };
}
export function hasUnresolvedEffects(checkpoint) {
  return Object.values(checkpoint.outbox ?? {}).some((effect) => ['prepared', 'in-flight', 'unknown'].includes(effect.phase));
}

function retainedWorkers(checkpoint) {
  return checkpoint.workers.some((worker) => boundGroupState(worker) !== 'empty');
}
export function boundGroupState(worker) {
  requireCondition(validWorker(worker), 'INVALID_INPUT', 'The worker binding is invalid.');
  return observedGroupState(worker);
}
function observedGroupState(worker) {
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
  } else readStateFile(worker.liveFile);
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
    directory = childDirectory(directory, name, create, observe, name !== 'autoloop');
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
  const ledger = readLedger(repository);
  assertEstablishedAuthority(repository, ledger);
  const pointer = currentPointer(repository);
  const latest = ledger.at(-1);
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
  validatePersistentTransition(binding, current, updated, lease);
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
function verifySelectionWorktree(worktree, { clean = false } = {}) {
  const actual = resolveRepositoryCheckout(worktree.root);
  requireCondition(['root', 'gitDir', 'commonDir', 'repositoryKey'].every((key) => actual[key] === worktree[key])
    && checkoutGit(worktree.root, ['symbolic-ref', '--short', 'HEAD']) === worktree.branch,
  'EVIDENCE_CHANGED', 'The bound worktree identity changed.');
  const headOid = gitFact(worktree.root, ['--verify', 'HEAD^{commit}']);
  if (clean) {
    let status;
    try { status = readGitStatus(worktree.root); }
    catch { throw new SchedulerError('EVIDENCE_CHANGED', 'The clean worktree status cannot be verified.'); }
    requireCondition(headOid === worktree.baseOid && status.length === 0,
      'EVIDENCE_CHANGED', 'The worktree is not clean at its creation base.');
  }
  return headOid;
}
export function boundCreatorState(creator) {
  requireCondition(validateAllocationCreator(creator).length === 0, 'INVALID_INPUT', 'The allocation creator is invalid.');
  return observedGroupState(creator);
}
function selectionNoWorkObservation(checkpoint, unitId) {
  const unit = checkpoint.units.find((item) => item.unitId === unitId);
  const reservation = checkpoint.reservations.find((item) => item.unitId === unitId);
  requireCondition(unit && reservation, 'TARGET_MISMATCH', 'The selection unit does not exist.');
  const observations = planningRelationshipRecovery(checkpoint).observations.filter((item) => item.unitId === unitId);
  requireCondition(observations.length === 0, observations.some((item) => item.status === 'observing') ? 'RECOVERY_REQUIRED' : 'OWNER_UNVERIFIED',
    'The selection unit retains unresolved task observation ownership.');
  const workers = checkpoint.workers.filter((item) => item.unitId === unitId);
  requireCondition(workers.every((item) => boundGroupState(item) === 'empty')
    && (unit.allocation?.creator === null || !unit.allocation || boundCreatorState(unit.allocation.creator) === 'empty'),
  'OWNER_UNVERIFIED', 'The selection worker or creator has no verified exit.');
  requireCondition(!Object.values(checkpoint.outbox).some((effect) => effect.unitId === unitId
    && ['prepared', 'in-flight', 'unknown'].includes(effect.phase)), 'OUTCOME_UNKNOWN', 'The selection unit retains uncertain effects.');
  requireCondition(unit.allocation === null || reservation.worktree !== null, 'RECOVERY_REQUIRED', 'The allocation needs a verified worktree disposition.');
  if (reservation.worktree) verifySelectionWorktree(reservation.worktree, { clean: true });
  return { unitId, unitGeneration: unit.unitGeneration,
    workers: workers.map((worker) => ({ attemptId: worker.attemptId, process: worker.process, pgid: worker.pgid, groupLeader: worker.groupLeader, state: 'empty' })),
    creator: unit.allocation?.creator ? { ...unit.allocation.creator, state: 'empty' } : null,
    worktree: reservation.worktree ? { ...reservation.worktree, headOid: reservation.worktree.baseOid, clean: true } : null,
    creatorHistory: unit.allocation?.creatorHistory ?? [], planningRelationshipsDigest: schedulerDigest(unit.planningRelationships ?? []) };
}
export function observeSelectionNoWork(lease, unitId) {
  requireCondition(uuid(unitId), 'INVALID_INPUT', 'The selection unit ID is invalid.');
  const { checkpoint } = readSchedulerContext(lease);
  return { kind: 'no-work', observationDigest: schedulerDigest(selectionNoWorkObservation(checkpoint, unitId)),
    observedAt: Date.now(), revision: checkpoint.revision + 1 };
}
function requireSelectionDecision(lease, binding, current, proposed, unit, reservation) {
  requireCondition(current.state === 'running' && current.desiredState === 'running', 'RUN_ACTIVE', 'Selection requires a running run.');
  requireCondition(!pendingRequests(binding.repository, current)
    && !Object.values(current.requests).some((request) => ['pending', 'processing', 'unknown'].includes(request.status)),
  'CONTROL_PENDING', 'Apply queued controls before a selection decision.');
  requireCondition(!planningRelationshipRecovery(current).pending, 'RECOVERY_REQUIRED', 'Reconcile task observation ownership before selection.');
  requireCondition(!hasUnresolvedEffects(current) && !retainedWorkers(current)
    && !current.reservations.some((item) => item.state === 'recovering'), 'RECOVERY_REQUIRED', 'Reconcile retained local work first.');
  const evidence = readSelectionSnapshot(lease, unit.checkedSnapshot);
  const authorization = reservation.issueAuthorization;
  const original = readSelectionSnapshot(lease, authorization.snapshot, { current: false });
  requireCondition(validateIssueAuthorizationEvidence(authorization, original).length === 0
    && issueAuthorizationEvidence({ ...authorization, snapshot: unit.checkedSnapshot }, evidence) !== null,
  'AUTHORIZATION_INVALID', 'The issue approval or its evidence changed.');
  const delivered = new Set(deliveredPullRequests(evidence.snapshot).map((item) => item.issue));
  const gating = markerSchedule(evidence.snapshot).gating.filter((issue) => !delivered.has(issue));
  requireCondition(gating.length === 0 && !evidence.snapshot.sections.openPrs.items.some((pr) => pr.orphanCandidate),
    'RECOVERY_REQUIRED', 'Repository recovery must precede selection.');
  const candidate = unit.wait?.requestedPlan ?? unit.plan;
  if (reservation.worktree && candidate) {
    const retained = current.reservations.find((item) => item.unitId === unit.unitId)?.paths ?? [];
    requireCondition(candidate.baseOid === evidence.baseOid, 'EVIDENCE_CHANGED', 'The candidate plan base changed.');
    verifySelectionWorktree(reservation.worktree);
    checkoutGit(reservation.worktree.root, ['merge-base', '--is-ancestor', candidate.baseOid, 'HEAD']);
    const facts = planningFacts(reservation.worktree.root, retained, candidate.boundary, candidate.baseOid);
    requireCondition(retained.length > 0 || facts.initialClean, 'EVIDENCE_CHANGED', 'An initial admission requires a clean workspace, including ignored entries.');
    if (unit.admission) {
      const boundary = planningBoundary(reservation.worktree.root, unit.admission.boundary);
      // Exclude every final scope, including admissions in this same reducer.
      // Authorization and before-scope checks above still use current state.
      for (const other of proposed.reservations) {
        if (other.unitId === unit.unitId || other.state === 'released' || other.paths.length === 0) continue;
        requireCondition(other.worktree !== null, 'RECOVERY_REQUIRED', 'Retained exclusions have no verified worktree.');
        const excluded = planningBoundary(other.worktree.root, other.paths);
        const rules = { caseSensitive: boundary.pathRules.caseSensitive && excluded.pathRules.caseSensitive };
        requireCondition(intersectBoundaries(boundary.boundary, excluded.boundary, rules).length === 0,
          'BOUNDARY_OVERLAP', 'The admitted boundary overlaps another retained unit.');
      }
      for (const delivered of deliveredPullRequests(evidence.snapshot)) {
        const excluded = planningBoundary(reservation.worktree.root, delivered.files);
        const rules = { caseSensitive: boundary.pathRules.caseSensitive && excluded.pathRules.caseSensitive };
        requireCondition(intersectBoundaries(boundary.boundary, excluded.boundary, rules).length === 0,
          'BOUNDARY_OVERLAP', 'The admitted boundary overlaps delivered work.');
      }
    }
  }
  return evidence;
}
function validateSelectionTransition(lease, binding, current, updated) {
  for (const old of current.reservations) {
    const kept = updated.reservations.find((item) => item.unitId === old.unitId);
    requireCondition(kept, 'STATE_INVALID', 'A retained reservation cannot be removed.');
    for (const key of ['schema', 'runId', 'unitId', 'unitGeneration', 'issue', 'repositoryKey', 'issueAuthorization', 'slot', 'baseOid', 'createdRevision']) {
      requireCondition(canonicalJson(old[key]) === canonicalJson(kept[key]), 'STATE_INVALID', 'A reservation changed immutable identity.');
    }
    const before = current.units.find((item) => item.unitId === old.unitId);
    const after = updated.units.find((item) => item.unitId === old.unitId);
    requireCondition(after && ['schema', 'runId', 'repositoryKey', 'unitId', 'unitGeneration'].every((key) => after[key] === before[key]),
      'STATE_INVALID', 'A selection unit cannot be removed or replaced.');
    validatePlanningRecordsTransition(binding, before, after);
    if (old.state === 'released') {
      requireCondition(canonicalJson(kept) === canonicalJson(old) && canonicalJson(after) === canonicalJson(before),
        'STATE_INVALID', 'Released selection history is immutable.');
      continue;
    }
    if (old.worktree) requireCondition(canonicalJson(old.worktree) === canonicalJson(kept.worktree), 'STATE_INVALID', 'The worktree binding cannot be removed or replaced.');
    if (before.allocation) {
      requireCondition(after.allocation && canonicalJson(before.allocation.intent) === canonicalJson(after.allocation.intent),
        'STATE_INVALID', 'The allocation intent cannot be removed or replaced.');
      const previousEffect = current.outbox[before.allocation.intent.operationId];
      const nextEffect = updated.outbox[before.allocation.intent.operationId];
      const retry = ['in-flight', 'unknown'].includes(previousEffect.phase) && nextEffect.phase === 'prepared'
        && nextEffect.attempt === previousEffect.attempt + 1 && nextEffect.error?.code === 'NOT_APPLIED';
      const history = retry ? [...before.allocation.creatorHistory,
        { attempt: previousEffect.attempt, creator: before.allocation.creator, receipt: nextEffect.receipt }] : before.allocation.creatorHistory;
      requireCondition(canonicalJson(after.allocation.creatorHistory) === canonicalJson(history),
        'STATE_INVALID', 'Allocation creator history can only append verified not-applied proof.');
      requireCondition(before.allocation.creator === null || canonicalJson(before.allocation.creator) === canonicalJson(after.allocation.creator)
        || retry && after.allocation.creator === null, 'STATE_INVALID', 'An allocation creator can only clear after verified not-applied settlement.');
    }
    if (after.allocation?.creator && !before.allocation?.creator) {
      const creator = after.allocation.creator;
      const effect = updated.outbox[after.allocation.intent.operationId];
      requireCondition(effect.phase === 'in-flight', 'STATE_INVALID', 'A creator must bind the current in-flight attempt.');
      requireCondition(boundCreatorState(creator) === 'alive', 'OWNER_UNVERIFIED', 'The allocation creator group cannot be verified.');
    }
    if (!before.allocation && after.allocation) {
      const { intent } = after.allocation;
      const root = join(dirname(binding.repository.coordinatorRoot), '.autoloop-worktrees', current.repositoryKey, current.runId,
        `${after.unitId}-g${after.unitGeneration}`);
      const branch = `feat/gh-${kept.issue}-unit-${after.unitId.replaceAll('-', '')}-g${after.unitGeneration}`;
      requireCondition(intent.root === root && intent.branch === branch, 'STATE_INVALID', 'Allocation must use its derived workspace and branch.');
      requireSelectionDecision(lease, binding, current, updated, after, kept);
    }
    if (!old.worktree && kept.worktree) {
      requireCondition(after.allocation.creator !== null && boundCreatorState(after.allocation.creator) === 'empty',
        'OWNER_UNVERIFIED', 'Worktree settlement needs verified creator exit.');
      verifySelectionWorktree(kept.worktree, { clean: true });
    }
    requireCondition(!before.plan || after.plan !== null, 'STATE_INVALID', 'A retained plan cannot be erased.');
    if (before.plan && after.plan) {
      requireCondition(after.plan.planGeneration >= before.plan.planGeneration
        && (after.plan.planGeneration !== before.plan.planGeneration || canonicalJson(after.plan) === canonicalJson(before.plan)),
      'STATE_INVALID', 'A changed plan requires a new generation.');
    }
    const newAdmission = after.admission && canonicalJson(after.admission) !== canonicalJson(before.admission);
    const newWait = after.wait && canonicalJson(after.wait) !== canonicalJson(before.wait);
    const proposal = newWait ? after.wait.requestedPlan : newAdmission ? after.plan : null;
    const refresh = newWait && before.wait && canonicalJson(after.wait.requestedPlan) === canonicalJson(before.wait.requestedPlan)
      || newAdmission && before.admission && canonicalJson(after.plan) === canonicalJson(before.plan);
    const floor = requestedPlanGenerationFloor(before); const nextFloor = requestedPlanGenerationFloor(after);
    requireCondition(!Object.hasOwn(before, 'lastRequestedPlanGeneration') || Object.hasOwn(after, 'lastRequestedPlanGeneration'),
      'STATE_INVALID', 'The requested plan generation floor cannot be cleared.');
    requireCondition(proposal && !refresh ? proposal.planGeneration > floor && nextFloor === proposal.planGeneration : nextFloor === floor,
      'STATE_INVALID', 'A new admitted or waiting proposal must advance its generation floor.');
    requireCondition(canonicalJson(before.plan) === canonicalJson(after.plan) || newAdmission,
      'STATE_INVALID', 'Only admission can replace the last admitted plan.');
    if (newWait) requireCondition(canonicalJson(before.plan) === canonicalJson(after.plan),
      'STATE_INVALID', 'A wait must retain the last admitted plan.');
    if (proposal && !refresh && old.paths.length > 0 && proposal.boundary.some((path) => !inLane(path, old.paths))) {
      const relationship = (before.planningRelationships ?? []).find((item) => item.status === 'verified-failure'
        && item.schedulerGeneration === current.generation && item.proposedPlan.planGeneration === proposal.planGeneration
        && item.proposedPlan.planDigest === proposal.planDigest && item.proposedPlan.boundaryDigest === schedulerDigest(proposal.boundary));
      requireCondition(relationship, 'WIDEN_REASON_UNVERIFIED', 'Path expansion needs a current owner-observed failing task.');
      checkPlanningRelationship(readSchedulerContext(lease), relationship, proposal);
    }
    if (newAdmission || newWait) {
      requireSelectionDecision(lease, binding, current, updated, after, kept);
      if (newAdmission) requireCondition(after.admission.reservationRevision === updated.revision,
        'STATE_INVALID', 'Admission must bind its committed reservation revision.');
      if (newWait) requireCondition(after.wait.createdRevision === updated.revision, 'STATE_INVALID', 'The wait must bind its committed revision.');
    }
    if (kept.paths.some((path) => !old.paths.includes(path))) requireCondition(kept.state === 'admitted' && newAdmission,
      'STATE_INVALID', 'Exclusion paths can grow only in a valid admission.');
    if (kept.state === 'waiting') requireCondition(canonicalJson(kept.paths) === canonicalJson(old.paths),
      'STATE_INVALID', 'A wait must retain exactly its prior exclusion paths.');
    if (before.wait && !after.wait && kept.state !== 'released') requireCondition(kept.state === 'planning' && after.replanRequired
      && after.admission === null && old.paths.every((path) => kept.paths.includes(path)), 'STATE_INVALID', 'Wake requires read-only replanning with retained paths.');
    if (old.paths.some((path) => !kept.paths.includes(path))) requireCondition(kept.state === 'released', 'STATE_INVALID', 'Exclusion paths cannot be removed before disposition.');
    for (const obligation of before.policy.authorize) requireCondition(after.policy.authorize.some((item) => canonicalJson(item) === canonicalJson(obligation)),
      'STATE_INVALID', 'Publication authorization obligations cannot be erased.');
    if (kept.state === 'released') requireCondition(after.disposition?.revision === updated.revision
      && after.disposition.observationDigest === schedulerDigest(selectionNoWorkObservation(updated, kept.unitId)),
    'STATE_INVALID', 'Path release requires verified exit and exact disposition evidence.');
  }
  for (const reservation of updated.reservations) if (!current.reservations.some((item) => item.unitId === reservation.unitId)) {
    const unit = updated.units.find((item) => item.unitId === reservation.unitId);
    requireCondition(reservation.createdRevision === updated.revision && reservation.state === 'planning' && reservation.worktree === null
      && reservation.paths.length === 0 && unit.allocation === null && unit.plan === null && unit.admission === null && unit.wait === null
      && unit.disposition === null && (unit.planningRelationships ?? []).length === 0 && requestedPlanGenerationFloor(unit) === 0
      && !unit.replanRequired && unit.policy.authorize.length === 0, 'STATE_INVALID', 'New selection pairs require unallocated planning state.');
    const occupied = new Set(current.reservations.filter((item) => item.state !== 'released').map((item) => item.slot));
    const free = [1, 2].find((slot) => !occupied.has(slot));
    requireCondition(free !== undefined, 'SLOTS_FULL', 'Both selection slots are retained.');
    requireCondition(reservation.slot === free, 'STATE_INVALID', 'Selection must use the lowest free slot.');
    requireSelectionDecision(lease, binding, current, updated, unit, reservation);
  }
}

export function planningRelationshipRecovery(checkpoint) {
  requireCondition(validateCheckpoint(checkpoint).length === 0, 'INVALID_INPUT', 'The observation checkpoint is invalid.');
  const observations = [];
  for (const unit of checkpoint.units) for (const record of unit.planningRelationships ?? []) {
    if (!['observing', 'inconclusive'].includes(record.status)) continue;
    const groupState = observedGroupState(record);
    if (record.status === 'observing' || groupState !== 'empty') observations.push({ unitId: unit.unitId,
      relationshipId: record.relationshipId, status: record.status, groupState });
  }
  return { pending: observations.length > 0, unitIds: [...new Set(observations.map((item) => item.unitId))].sort(), observations };
}
function validatePlanningRecordsTransition(binding, before, after) {
  const previous = before.planningRelationships ?? []; const next = after.planningRelationships ?? [];
  if (canonicalJson(previous) === canonicalJson(next)) return;
  const allowance = binding.planningAllowance;
  requireCondition(allowance?.unitId === before.unitId, 'STATE_INVALID', 'Only the core observer can write planning relationships.');
  const record = JSON.parse(allowance.after); let expected;
  if (allowance.before === null) {
    requireCondition(record.status === 'observing' && !previous.some((item) => item.relationshipId === record.relationshipId),
      'STATE_INVALID', 'A relationship must start as one new observing record.');
    expected = [...previous, record];
  } else {
    const old = previous.find((item) => canonicalJson(item) === allowance.before);
    requireCondition(old?.status === 'observing' && record.relationshipId === old.relationshipId && record.status !== 'observing',
      'STATE_INVALID', 'Only an observing relationship can settle.');
    const mutable = new Set(['status', 'exitCode', 'signal', 'stdoutDigest', 'stderrDigest', 'completedRevision']);
    requireCondition(canonicalJson(Object.fromEntries(Object.entries(old).filter(([key]) => !mutable.has(key))))
      === canonicalJson(Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)))),
    'STATE_INVALID', 'Planning relationship identity and judgment are immutable.');
    expected = previous.map((item) => item.relationshipId === old.relationshipId ? record : item);
  }
  requireCondition(canonicalJson(next) === canonicalJson(expected), 'STATE_INVALID', 'A planning observation cannot be forged, removed or reordered.');
}

function effectIntent(value) {
  return Object.fromEntries(EFFECT_KEYS.filter((key) => !['phase', 'attempt', 'receipt', 'error'].includes(key)).map((key) => [key, value[key]]));
}
function validatePersistentTransition(binding, current, updated, lease) {
  validateSelectionTransition(lease, binding, current, updated);
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
      if (effect.kind === 'worktree.create' && ['in-flight', 'unknown'].includes(effect.phase)
        && ['prepared', 'succeeded', 'failed'].includes(kept.phase)) {
        const allocation = current.units.find((unit) => unit.unitId === effect.unitId)?.allocation;
        requireCondition(allocation?.creator && boundCreatorState(allocation.creator) === 'empty',
          'OWNER_UNVERIFIED', 'Allocation readback needs verified creator exit.');
        if (kept.phase === 'prepared') requireCondition(!present(allocation.intent.root)
          && checkoutGit(binding.repository.coordinatorRoot, ['for-each-ref', '--format=%(refname)', `refs/heads/${allocation.intent.branch}`]) === ''
          && !checkoutGit(binding.repository.coordinatorRoot, ['worktree', 'list', '--porcelain']).split('\n')
            .includes(`worktree ${allocation.intent.root}`), 'OUTCOME_UNKNOWN', 'Allocation absence cannot be verified.');
      }
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
export function prepareEffect(lease, expectedRevision, effect, transition = (value) => value) {
  const binding = heldLease(lease);
  requireCondition(typeof transition === 'function', 'INVALID_INPUT', 'An effect preparation reducer is required.');
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
  return commitTransition(lease, expectedRevision, (value) => {
    const changed = transition(value);
    requireCondition(record(changed), 'STATE_INVALID', 'The effect preparation reducer returned invalid state.');
    return { ...changed, outbox: { ...changed.outbox, [effect.operationId]: effect } };
  });
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
export function settleEffect(lease, operationId, observation, { deferControl = false, transition = (value) => value } = {}) {
  const binding = heldLease(lease);
  requireCondition(typeof transition === 'function', 'INVALID_INPUT', 'An effect settlement reducer is required.');
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
  requireCondition(typeof deferControl === 'boolean', 'INVALID_INPUT', 'The control settlement option is invalid.');
  if (deferControl) {
    const request = current.requests[effect.requestId];
    requireCondition(effect.kind === 'process.cancel' && request?.status === 'processing' && request.request.kind === 'stop-now'
      && request.claimedGeneration === current.generation && request.request.target.generation === current.generation
      && current.desiredState === 'stopped' && current.stopMode === 'immediate',
    'TARGET_MISMATCH', 'Only the current immediate-stop pass can defer its aggregate outcome.');
  }
  requireCondition(['in-flight', 'unknown'].includes(effect.phase) || absentCancellation,
    'EFFECT_SETTLED', 'The effect has no unresolved attempt.');
  if (effect.kind === 'worktree.create' && observation.status !== 'unknown') {
    const allocation = current.units.find((unit) => unit.unitId === effect.unitId)?.allocation;
    requireCondition(allocation?.creator && boundCreatorState(allocation.creator) === 'empty',
      'OWNER_UNVERIFIED', 'Allocation settlement needs the current creator to have exited.');
  }
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
    let changed = transition(value);
    requireCondition(record(changed), 'STATE_INVALID', 'The effect settlement reducer returned invalid state.');
    if (effect.kind === 'worktree.create' && observation.status === 'not-applied') {
      requireCondition(Array.isArray(changed.units), 'STATE_INVALID', 'The allocation settlement returned invalid units.');
      const allocation = current.units.find((unit) => unit.unitId === effect.unitId).allocation;
      changed = { ...changed, units: changed.units.map((unit) => unit.unitId !== effect.unitId ? unit : { ...unit,
        allocation: { ...unit.allocation, creator: null, creatorHistory: [...allocation.creatorHistory,
          { attempt: effect.attempt, creator: allocation.creator, receipt: observation.receipt }] } }) };
    }
    const outbox = { ...changed.outbox, [operationId]: settled };
    const requests = { ...changed.requests };
    if (effect.requestId !== null && !deferControl) {
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
    return { ...changed, outbox, requests };
  });
  if (outcome) publishOutcome(binding.repository, outcome, binding.observe);
  return updated;
}

// Test-only external OS-account fixture. No production CLI or storage option
// selects a different authority root. Existing self-tests and their children
// share one scoped temp account, without relaunching a self-test.
export async function createSchedulerTestAccount(scratch) {
  const temporaryRoot = realpathSync(tmpdir());
  requireCondition(isAbsolute(scratch) && realpathSync(scratch) === scratch && scratch !== temporaryRoot
    && !relative(temporaryRoot, scratch).startsWith('..'), 'INVALID_INPUT', 'The test account needs a private temporary root.');
  safeDirectory(scratch, false, undefined, true);
  const originalUmask = process.umask(0o022); const originalNodeOptions = process.env.NODE_OPTIONS;
  let fixtureAccount;
  try {
    const accountHome = childDirectory(scratch, `account-${randomUUID()}`, true);
    const preload = join(scratch, `external-account-${randomUUID()}.mjs`);
    writeFileSync(preload, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
const actual = os.userInfo; const actualHome = os.homedir;
os.userInfo = (...args) => ({ ...actual(...args), homedir: ${JSON.stringify(accountHome)} });
os.homedir = () => ${JSON.stringify(accountHome)}; syncBuiltinESMExports();
export function restore() { os.userInfo = actual; os.homedir = actualHome; syncBuiltinESMExports(); }\n`, { flag: 'wx', mode: 0o600 });
    fixtureAccount = await import(preload);
    process.env.NODE_OPTIONS = `${originalNodeOptions ?? ''} --import=${JSON.stringify(preload)}`.trim();
    let active = true;
    return { accountHome, preload, restore() {
      if (!active) return;
      active = false; fixtureAccount.restore(); process.umask(originalUmask);
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
    } };
  } catch (error) {
    fixtureAccount?.restore(); process.umask(originalUmask);
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
    throw error;
  }
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
  const fixtureAccount = await createSchedulerTestAccount(scratch);
  const { accountHome } = fixtureAccount;
  const children = new Set();
  const moduleUrl = import.meta.url;
  const startChild = (script, args = [], options = {}) => {
    const home = userInfo().homedir;
    assert(home.startsWith(`${scratch}/`), 'A fixture child must use a temporary OS account.');
    const scopedScript = `if ((await import('node:os')).userInfo().homedir !== ${JSON.stringify(home)}) throw Error('The child OS account is not isolated.');
process.on('disconnect', () => process.exit(0));\n${script}`;
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
    await check('nested asynchronous test accounts restore the outer account and child environment', async () => {
      const outerHome = userInfo().homedir; const outerOptions = process.env.NODE_OPTIONS;
      const nestedRoot = join(scratch, randomUUID()); mkdirSync(nestedRoot, { mode: 0o700 });
      const nested = await createSchedulerTestAccount(nestedRoot);
      try {
        assert.equal(userInfo().homedir, nested.accountHome); assert.notEqual(nested.accountHome, outerHome);
        const child = startChild("process.send({ home: (await import('node:os')).userInfo().homedir }, () => process.disconnect());");
        assert.equal((await message(child)).home, nested.accountHome); await child.finished;
      } finally { nested.restore(); }
      assert.equal(userInfo().homedir, outerHome); assert.equal(process.env.NODE_OPTIONS, outerOptions);
      assert.equal(outerHome, accountHome);
    });
    await check('canonical common Git identity is shared by linked worktrees and aliases', () => {
      const repository = resolveRepository(root);
      const other = resolveRepository(linked);
      assert.equal(repository.commonDir, realpathSync(join(root, '.git')));
      assert.equal(repository.repositoryKey, other.repositoryKey);
      assert.equal(repository.repositoryKey, resolveRepository(alias).repositoryKey);
      assert.equal(repository.coordinatorRoot, root);
      assert.equal(other.coordinatorRoot, linked);
    });
    await check('fresh checkout identity batches ordinary roots and preserves ambiguous path framing', async () => {
      const childProcess = (await import('node:child_process')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const unusual = [];
      for (const name of [' space \tpart ', 'line\nbreak']) {
        const root = join(scratch, name, 'repo'); mkdirSync(root, { recursive: true });
        git('init', '-q', '-b', 'main', root);
        git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'path fixture');
        const linked = join(scratch, name, 'linked'); git('-C', root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
        unusual.push({ root, linked, commonDir: realpathSync(join(root, '.git')) });
      }
      const separateRoot = join(scratch, 'separate-root'); const separateAdmin = join(scratch, 'admin\nwith space', 'git');
      mkdirSync(dirname(separateAdmin), { recursive: true });
      git('init', '-q', '--separate-git-dir', separateAdmin, separateRoot);
      const absent = join(scratch, 'not-a-checkout'); mkdirSync(absent);
      const actual = childProcess.spawnSync; const calls = [];
      const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_NO_LAZY_FETCH'];
      const previous = new Map(names.map((name) => [name, process.env[name]]));
      try {
        Object.assign(process.env, { GIT_DIR: separateAdmin, GIT_WORK_TREE: separateRoot, GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: separateRoot, GIT_NO_LAZY_FETCH: '0' });
        // Count real subprocesses; the command, environment and result are not
        // replaced. One fresh identity command per ordinary call is specified.
        childProcess.spawnSync = (file, args, options) => {
          if (file === 'git' && args.includes('rev-parse')) {
            calls.push(args);
            for (const option of ['--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks']) assert(args.includes(option));
            assert.equal(options.env.GIT_NO_LAZY_FETCH, '1'); assert.equal(options.env.GIT_DIR, undefined);
          }
          return actual(file, args, options);
        };
        syncBuiltinESMExports();
        const expectedCommon = realpathSync(join(root, '.git'));
        for (const requested of [root, linked, alias, root]) {
          const before = calls.length; const result = resolveRepositoryCheckout(requested);
          assert.equal(result.root, requested === alias ? root : requested);
          assert.equal(result.commonDir, expectedCommon);
          assert.equal(result.gitDir, requested === linked ? realpathSync(join(expectedCommon, 'worktrees', 'linked')) : expectedCommon);
          assert.equal(result.repositoryKey, createHash('sha256').update(expectedCommon, 'utf8').digest('hex'));
          assert.equal(calls.length - before, 1, 'Each ordinary checkout read must run one fresh bounded Git process.');
        }
        for (const test of unusual) for (const requested of [test.root, test.linked]) {
          const result = resolveRepositoryCheckout(requested);
          assert.equal(result.root, requested); assert.equal(result.commonDir, test.commonDir);
          assert.equal(result.gitDir, requested === test.root ? test.commonDir : realpathSync(join(test.commonDir, 'worktrees', 'linked')));
          assert.equal(result.repositoryKey, createHash('sha256').update(test.commonDir, 'utf8').digest('hex'));
        }
        const separate = resolveRepositoryCheckout(separateRoot);
        assert.equal(separate.root, separateRoot); assert.equal(separate.commonDir, realpathSync(separateAdmin));
        assert.equal(separate.gitDir, separate.commonDir);
        assert.equal(separate.repositoryKey, createHash('sha256').update(separate.commonDir, 'utf8').digest('hex'));
        assert.throws(() => resolveRepositoryCheckout(absent), (error) => error instanceof SchedulerError && error.code === 'REPOSITORY_INVALID');
        assert.throws(() => resolveRepositoryCheckout(''), (error) => error instanceof SchedulerError && error.code === 'INVALID_INPUT');
      } finally {
        childProcess.spawnSync = actual; syncBuiltinESMExports();
        for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      }
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
    const admissionOf = (repository) => join(accountHome, '.claude', 'autoloop', 'execution-admission', repository.repositoryKey);
    const selectionFixture = async (setup, revision = 2, issueNumber = 7) => {
      const { createSnapshot, completeSection, SNAPSHOT_SECTIONS, issueSnapshotItem } = await import('./snapshot-contract.mjs');
      const root = setup.repository.coordinatorRoot;
      git('-C', root, 'remote', 'add', 'origin', 'https://github.com/example/scheduler-fixture.git');
      const baseOid = git('-C', root, 'rev-parse', 'HEAD');
      git('-C', root, 'update-ref', 'refs/remotes/origin/main', baseOid);
      mkdirSync(join(root, '.autoloop'));
      writeFileSync(join(root, '.autoloop', 'config.json'), JSON.stringify(setup.pins.config));
      const at = '2026-01-01T00:00:00.000Z';
      const repository = { host: 'github.com', owner: 'example', name: 'scheduler-fixture', nodeId: 'R_fixture' };
      const issue = issueSnapshotItem({ number: issueNumber, title: 'Fixture work', body: 'Public fixture body.\n', updatedAt: at,
        lastEditedAt: null, labels: ['loop-ready'] });
      const queue = { ...issue, blockedBy: [], dependencies: [], provenance: { labeledBy: 'fixture-operator', labeledAt: at } };
      const role = { login: 'fixture-operator', permission: 'write', roleName: 'write', evidence: [{ kind: 'queue-label',
        issueNumber, author: 'fixture-operator', authorAssociation: 'MEMBER', body: '', createdAt: at, updatedAt: at, url: null }] };
      const sections = Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]));
      sections.repo = completeSection([{ owner: repository.owner, name: repository.name, nameWithOwner: 'example/scheduler-fixture', defaultBranch: 'main' }]);
      sections.tree = completeSection([{ dirtyEntries: [], dirtyPaths: 0, branch: 'main', headOid: baseOid }]);
      sections.queue = completeSection([queue]); sections.openIssues = completeSection([issue]); sections.authorVerification = completeSection([role]);
      const snapshot = createSnapshot({ scannedAt: at, sections });
      const issueSource = { number: issueNumber, nodeId: `I_fixture_${issueNumber}` };
      const approvalSource = { issue: issueNumber, issueNodeId: issueSource.nodeId, approvalIssue: issueNumber,
        approvalIssueNodeId: issueSource.nodeId, eventId: `E_fixture_${issueNumber}`, actorLogin: role.login, createdAt: at, kind: 'loop-ready' };
      const roleSource = { login: role.login, userId: 101, permission: role.permission, roleName: role.roleName };
      const sources = { schema: 'autoloop.selection-sources/1', repository, issues: [issueSource], approvals: [approvalSource],
        roles: [roleSource], waitIssues: completeSection([]), waitPullRequests: completeSection([]) };
      const evidence = { schema: 'autoloop.selection-snapshot/1', runId: setup.pins.runId, generation: 1, checkpointRevision: revision,
        repositoryKey: setup.repository.repositoryKey, root, gitDir: realpathSync(join(root, '.git')), commonDir: setup.repository.commonDir,
        repository, configuredBaseBranch: 'main', baseRef: 'refs/remotes/origin/main', baseOid, headOid: baseOid,
        configDigest: setup.pins.configDigest, snapshot, sources };
      const { schema, snapshot: ignoredSnapshot, sources: ignoredSources, ...identity } = evidence;
      const reference = { schema: 'autoloop.snapshot-reference/1', ...identity, snapshotGeneration: snapshot.generation,
        snapshotFingerprint: snapshot.fingerprint, contentDigest: schedulerDigest(evidence) };
      const subject = { repositoryKey: evidence.repositoryKey, repository, issue: issueNumber, issueNodeId: issueSource.nodeId,
        issueBodyDigest: issue.bodySha256, approval: { kind: 'loop-ready', issue: issueNumber, issueNodeId: issueSource.nodeId,
          eventId: approvalSource.eventId, actorLogin: role.login, actorUserId: roleSource.userId, createdAt: at } };
      const authorization = { schema: 'autoloop.issue-authorization/1', subject, authorizationDigest: schedulerDigest(subject),
        evidenceDigest: schedulerDigest({ queue, openIssue: issue, role, issueSource, approvalSource, roleSource }), snapshot: reference };
      const unitId = randomUUID();
      const reservation = { schema: 'autoloop.reservation/1', runId: evidence.runId, unitId, unitGeneration: 1, issue: issueNumber,
        repositoryKey: evidence.repositoryKey, issueAuthorization: authorization, slot: 1, baseOid, worktree: null, paths: [], state: 'planning', createdRevision: revision + 1 };
      const unit = { schema: 'autoloop.selection-unit/1', runId: evidence.runId, repositoryKey: evidence.repositoryKey, unitId, unitGeneration: 1,
        allocation: null, plan: null, admission: null, wait: null, checkedSnapshot: reference, replanRequired: false, policy: { authorize: [] }, disposition: null };
      return { evidence, reference, authorization, reservation, unit };
    };
    // This test owner uses real exported transactions, Git and isolated native
    // children. Its source is also used by crash/reparenting fixture owners.
    async function createPlanningFixture({ setup, data, api, moduleUrl, accountHome, prepareOnly = false, existingLease = null }) {
      const assert = (await import('node:assert/strict')).default;
      const { spawn, spawnSync } = await import('node:child_process');
      const { join, dirname } = await import('node:path');
      const { mkdirSync } = await import('node:fs');
      const { randomUUID } = await import('node:crypto');
      const { createSnapshot, completeSection } = await import(new URL('./snapshot-contract.mjs', moduleUrl));
      assert.equal((await import('node:os')).userInfo().homedir, accountHome);
      const lease = existingLease ?? api.acquireScheduler(setup.repository, setup.pins,
        { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() }).lease;
      let revision = existingLease ? api.readSchedulerContext(lease).checkpoint.revision
        : api.commitTransition(lease, 1, (value) => ({ ...value, state: 'running' })).revision;
      api.publishSelectionSnapshot(lease, revision, data.evidence);
      revision = api.commitTransition(lease, revision, (value) => ({ ...value,
        units: [...value.units, data.unit], reservations: [...value.reservations, data.reservation] })).revision;
      const checkedSnapshot = api.publishSelectionSnapshot(lease, revision, { ...data.evidence, checkpointRevision: revision });
      const intent = { operationId: randomUUID(), runId: setup.pins.runId, unitId: data.unit.unitId, unitGeneration: 1,
        repositoryKey: setup.repository.repositoryKey, root: join(dirname(setup.repository.coordinatorRoot), '.autoloop-worktrees',
          setup.repository.repositoryKey, setup.pins.runId, data.unit.unitId + '-g1'),
        branch: 'feat/gh-' + data.reservation.issue + '-unit-' + data.unit.unitId.replaceAll('-', '') + '-g1', baseOid: data.evidence.baseOid };
      revision = api.prepareEffect(lease, revision, { operationId: intent.operationId, requestId: null, runId: intent.runId, unitId: intent.unitId,
        unitGeneration: 1, kind: 'worktree.create', target: { type: 'external', id: intent.unitId }, inputDigest: api.schedulerDigest(intent),
        expectedHead: intent.baseOid, phase: 'prepared', attempt: 1, receipt: null, error: null },
      (value) => ({ ...value, units: value.units.map((unit) => unit.unitId !== intent.unitId ? unit
        : { ...unit, checkedSnapshot, allocation: { intent, creator: null, creatorHistory: [] } }) })).revision;
      revision = api.markEffectInFlight(lease, intent.operationId).revision;
      mkdirSync(dirname(intent.root), { recursive: true, mode: 0o700 });
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import {spawnSync} from 'node:child_process';
        process.on('message', () => { const result=spawnSync('git',['-C',process.argv[1],'-c','core.hooksPath=/dev/null',
          '-c','core.fsmonitor=false','worktree','add','-q','-b',process.argv[3],process.argv[2],process.argv[4]],{encoding:'utf8',timeout:15000});
          if(result.status!==0)throw Error(result.stderr);process.disconnect(); });process.send({ready:true});`,
      setup.repository.coordinatorRoot, intent.root, intent.branch, intent.baseOid], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const closed = new Promise((done) => child.once('close', (code) => done(code)));
      await new Promise((done) => child.once('message', done));
      const identity = api.readProcessIdentity(child.pid); const creator = { process: identity, groupLeader: identity, pgid: child.pid };
      revision = api.commitTransition(lease, revision, (value) => ({ ...value,
        units: value.units.map((unit) => unit.unitId !== intent.unitId ? unit : { ...unit, allocation: { ...unit.allocation, creator } }) })).revision;
      child.send('create'); assert.equal(await closed, 0);
      const worktree = { ...api.resolveRepositoryCheckout(intent.root), branch: intent.branch, baseOid: intent.baseOid,
        createdByRun: intent.runId, unitId: intent.unitId, unitGeneration: 1 };
      revision = api.settleEffect(lease, intent.operationId, { attempt: 1, status: 'applied', code: 'READBACK_CONFIRMED',
        receipt: { externalId: intent.operationId, observationDigest: api.schedulerDigest(worktree), observedAt: Date.now() } },
      { transition: (value) => ({ ...value, reservations: value.reservations.map((item) => item.unitId !== intent.unitId ? item : { ...item, worktree }) }) }).revision;
      const taskText = '- Read fixture.txt and check its expected contents.';
      const artifact = { schema: 'autoloop.plan-artifact/1', repositoryKey: setup.repository.repositoryKey, unitId: intent.unitId,
        unitGeneration: 1, issue: data.reservation.issue, issueBodyDigest: data.authorization.subject.issueBodyDigest,
        authorizationDigest: data.authorization.authorizationDigest, planGeneration: 1, baseOid: intent.baseOid,
        title: 'Fixture plan', prBody: 'Closes #' + data.reservation.issue, body: '## Tasks\n' + taskText + '\n', boundary: ['fixture.txt'] };
      const proposed = { ...artifact, planGeneration: 2, body: artifact.body + '- Repair the extra fixture path.\n', boundary: ['extra.txt', 'fixture.txt'] };
      const plan = { planGeneration: 1, planDigest: api.schedulerDigest(artifact), baseOid: artifact.baseOid, boundary: artifact.boundary };
      const sections = { ...data.evidence.snapshot.sections, tree: completeSection([{ dirtyEntries: [], dirtyPaths: 0, branch: worktree.branch, headOid: intent.baseOid }]) };
      const linkedEvidence = { ...data.evidence, root: worktree.root, gitDir: worktree.gitDir,
        checkpointRevision: revision, snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:03.000Z', sections }) };
      const snapshot = api.publishSelectionSnapshot(lease, revision, linkedEvidence);
      if (prepareOnly) return { lease, setup, data, worktree, artifact, proposed, taskText, linkedEvidence, snapshot, plan };
      const checkpoint = api.commitTransition(lease, revision, (value) => ({ ...value,
        units: value.units.map((unit) => unit.unitId !== intent.unitId ? unit : { ...unit, checkedSnapshot: snapshot, plan,
          admission: { schema: 'autoloop.admission/1', runId: intent.runId, unitId: intent.unitId, unitGeneration: 1, ...plan, reservationRevision: value.revision + 1 } }),
        reservations: value.reservations.map((item) => item.unitId !== intent.unitId ? item : { ...item, state: 'admitted', paths: artifact.boundary }) }));
      return { lease, setup, data, worktree, artifact, proposed, taskText, checkpoint, linkedEvidence };
    }
    function startPlanningTask(api, root, expected, isolated = true, descendant = false, fromPath = false, executable = process.execPath) {
      const child = spawn(fromPath ? 'node' : executable, ['--input-type=module', '-e', `import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';
        const hold=setInterval(()=>{},1000);process.on('message', message=>{if(message!=='run')return;
          clearInterval(hold);process.stdout.write('fixture stdout\\n');process.stderr.write('fixture stderr\\n');
          if(process.argv[3]!=='single'){const mode=process.argv[3];const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
            {detached:mode==='detached-inherit',stdio:mode.includes('inherit')?'inherit':'ignore'});process.send({descendant:child.pid});}
          assert.equal(readFileSync(join(process.argv[1],'fixture.txt'),'utf8'),process.argv[2]);process.disconnect();});process.send({ready:true});`,
      root, expected, typeof descendant === 'string' ? descendant : descendant ? 'descendant' : 'single'], { cwd: root, detached: isolated, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.started = api.readProcessIdentity(child.pid).start;
      child.finished = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
      child.ready = new Promise((done) => child.once('message', done));
      children.add(child); child.finished.then(() => children.delete(child));
      return child;
    }
    await check('owner observations require real failing assertions and cannot be forged or replayed', async () => {
      const api = { acquireScheduler, commitTransition, publishSelectionSnapshot, prepareEffect, markEffectInFlight, readProcessIdentity,
        resolveRepositoryCheckout, schedulerDigest, settleEffect };
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n');
      git('-C', root, 'add', 'fixture.txt'); git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const data = await selectionFixture(setup);
      const ctx = await createPlanningFixture({ setup, data, api, moduleUrl, accountHome });
      const task = startPlanningTask(api, ctx.worktree.root, 'required fixture contents\n'); await task.ready;
      let observation;
      try {
        const revision = readSchedulerContext(ctx.lease).checkpoint.revision;
        observation = observeFailingTaskRelationship(ctx.lease, revision, task, { unitId: data.unit.unitId, unitGeneration: 1,
          currentPlanArtifact: ctx.artifact, proposedPlanArtifact: ctx.proposed, taskText: ctx.taskText,
          rationale: 'The owner judged that the extra fixture path is needed for this failing task.' });
        const observing = readSchedulerContext(ctx.lease).checkpoint.units[0].planningRelationships[0];
        assert.equal(observing.status, 'observing'); assert.equal(observing.completedRevision, null);
        refuses('STATE_INVALID', () => commitTransition(ctx.lease, revision + 1, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, planningRelationships: [{ ...observing, status: 'verified-failure', exitCode: 1,
            stdoutDigest: '0'.repeat(64), stderrDigest: '0'.repeat(64), completedRevision: value.revision + 1 }] })) })));
        task.send('run'); const recorded = await observation.completion;
        assert.equal((await task.finished).code, 1); assert.equal(recorded.status, 'verified-failure');
        assert.equal(recorded.stdoutDigest, createHash('sha256').update('fixture stdout\n').digest('hex'));
        const current = readSchedulerContext(ctx.lease).checkpoint;
        assert.equal(readFailingTaskRelationship(ctx.lease, current.revision, observation.relationshipId,
          { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: ctx.proposed }).relationshipId, observation.relationshipId);
        refuses('TARGET_MISMATCH', () => readFailingTaskRelationship(ctx.lease, current.revision, observation.relationshipId,
          { unitId: randomUUID(), unitGeneration: 1, proposedPlanArtifact: ctx.proposed }));
        refuses('TARGET_MISMATCH', () => readFailingTaskRelationship(ctx.lease, current.revision, observation.relationshipId,
          { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: { ...ctx.proposed, body: ctx.proposed.body + 'Different proposal.\n' } }));
        commitTransition(ctx.lease, current.revision, (value) => {
          assert.equal(readFailingTaskRelationship(ctx.lease, current.revision, observation.relationshipId,
            { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: ctx.proposed }).status, 'verified-failure');
          return value;
        });
      } finally {
        if (task.exitCode === null && task.signalCode === null) await endChild(task);
        await observation?.completion.catch(() => {});
        const current = readSchedulerContext(ctx.lease).checkpoint;
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(ctx.lease);
      }
    });
    await check('owner observations classify zero, signal, pipe errors, pause and changed dirty bytes without JSON grants', async () => {
      const api = { acquireScheduler, commitTransition, publishSelectionSnapshot, prepareEffect, markEffectInFlight, readProcessIdentity,
        resolveRepositoryCheckout, schedulerDigest, settleEffect };
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n'); git('-C', root, 'add', 'fixture.txt');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const data = await selectionFixture(setup); const ctx = await createPlanningFixture({ setup, data, api, moduleUrl, accountHome });
      const request = { unitId: data.unit.unitId, unitGeneration: 1, currentPlanArtifact: ctx.artifact, proposedPlanArtifact: ctx.proposed,
        taskText: ctx.taskText, rationale: 'The trusted owner judged that the added path is needed for the task.' };
      const tasks = [];
      const start = async (expected, isolated = true) => { const task = startPlanningTask(api, ctx.worktree.root, expected, isolated); tasks.push(task); await task.ready; return task; };
      const observe = (task, overrides = {}) => {
        try {
          return observeFailingTaskRelationship(ctx.lease, readSchedulerContext(ctx.lease).checkpoint.revision, task, { ...request, ...overrides });
        } catch (error) {
          if (error.code === 'OWNER_UNVERIFIED') {
            // Test-only failure facts. These later observations do not grant
            // authority or change the production observer's acceptance checks.
            const entry = procEntry(task.pid); let executable = null;
            try { if (entry?.[2]) executable = realpathSync(entry[2]); } catch { /* report the unverified path */ }
            error.message += ' Fixture ownership: ' + JSON.stringify({
              task: task.fixtureObservation ?? 'input rejection', platform: process.platform, pid: task.pid, nativePid: task._handle?.pid ?? null,
              launch: task.spawnfile, parentPid: entry?.[0] ?? null, expectedParentPid: process.pid,
              rawExecutable: entry?.[2] ?? null, executable, pinnedExecutable: setup.pins.nodePath,
              childGroup: processGroupOf(task.pid), ownerGroup: processGroupOf(process.pid),
              started: task.started, observedStart: processStart(task.pid), exitCode: task.exitCode, signal: task.signalCode,
            });
          }
          throw error;
        }
      };
      const recordFor = async (label, expected, action, status) => {
        const task = await start(expected); task.fixtureObservation = label; const observation = observe(task);
        assert.equal(planningRelationshipRecovery(readSchedulerContext(ctx.lease).checkpoint).pending, true);
        refuses('RECOVERY_REQUIRED', () => observeSelectionNoWork(ctx.lease, data.unit.unitId));
        await action(task); const record = await observation.completion; await task.finished;
        assert.equal(record.status, status); assert.equal(planningRelationshipRecovery(readSchedulerContext(ctx.lease).checkpoint).pending, false);
        return record;
      };
      try {
        const forgedChild = await start('required\n'); refuses('INVALID_INPUT', () => observe({ pid: forgedChild.pid }));
        const foreignParent = startChild(`import {spawn} from 'node:child_process';
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
          process.on('message',()=>child.kill('SIGTERM'));child.once('close',()=>process.disconnect());process.send({pid:child.pid});`);
        const foreign = await message(foreignParent);
        try {
          assert.equal(procEntry(foreign.pid)[0], foreignParent.pid);
          refuses('INVALID_INPUT', () => observe({ pid: foreign.pid }));
          const actualPid = forgedChild.pid;
          try { forgedChild.pid = foreign.pid; refuses('OWNER_UNVERIFIED', () => observe(forgedChild)); }
          finally { forgedChild.pid = actualPid; }
        } finally { foreignParent.send('cleanup'); await foreignParent.finished; }
        refuses('TARGET_MISMATCH', () => observe(forgedChild, { currentPlanArtifact: { ...ctx.artifact, body: ctx.artifact.body + 'Edited original.\n' } }));
        refuses('TARGET_MISMATCH', () => observe(forgedChild, { proposedPlanArtifact: { ...ctx.proposed, unitId: randomUUID() } }));
        refuses('INVALID_INPUT', () => observe(forgedChild, { taskText: 'Not a task in this plan.' })); await endChild(forgedChild);
        const exited = await start('actual fixture contents\n'); exited.send('run'); await exited.finished;
        refuses('OWNER_UNVERIFIED', () => observe(exited));
        const shared = await start('required\n', false); shared.fixtureObservation = 'shared-group refusal';
        assert.throws(() => observe(shared), (error) => {
          assert(error instanceof SchedulerError && error.code === 'OWNER_UNVERIFIED');
          const marker = ' Fixture ownership: '; const at = error.message.indexOf(marker);
          assert(at >= 0, 'The fixture must report the rejected ownership facts.');
          const facts = JSON.parse(error.message.slice(at + marker.length));
          assert.equal(facts.task, 'shared-group refusal'); assert.equal(facts.pid, shared.pid);
          assert.equal(facts.nativePid, shared.pid); assert.equal(facts.parentPid, process.pid);
          assert.equal(facts.childGroup, processGroupOf(process.pid)); assert.notEqual(facts.childGroup, shared.pid);
          return true;
        });
        await endChild(shared);
        const pathTask = startPlanningTask(api, ctx.worktree.root, 'required\n', true, false, true);
        pathTask.fixtureObservation = 'PATH launch'; tasks.push(pathTask); await pathTask.ready;
        const pathEntry = procEntry(pathTask.pid); let pathExecutable = null;
        try { if (pathEntry?.[2]) pathExecutable = realpathSync(pathEntry[2]); } catch { /* unknown executable must refuse */ }
        assert.equal(pathTask._handle?.pid, pathTask.pid); assert.equal(pathEntry?.[0], process.pid);
        assert.equal(processGroupOf(pathTask.pid), pathTask.pid); assert.equal(processStart(pathTask.pid), pathTask.started);
        if (pathExecutable !== null) {
          assert.equal(pathExecutable, setup.pins.nodePath);
          const pathObservation = observe(pathTask); pathTask.send('run');
          assert.equal((await pathObservation.completion).status, 'verified-failure'); await pathTask.finished;
        } else {
          // PATH spelling is not executable proof. Some hosts cannot observe
          // this child's image; refusal must not register a relationship.
          const before = readSchedulerContext(ctx.lease).checkpoint;
          refuses('OWNER_UNVERIFIED', () => observe(pathTask));
          assert.deepEqual(readSchedulerContext(ctx.lease).checkpoint, before); await endChild(pathTask);
        }
        const { copyFileSync, chmodSync } = await import('node:fs');
        const hiddenDirectory = join(setup.home, 'unresolvable-node'); mkdirSync(hiddenDirectory, { mode: 0o700 });
        const hiddenExecutable = join(hiddenDirectory, 'node'); copyFileSync(setup.pins.nodePath, hiddenExecutable);
        const hiddenTask = startPlanningTask(api, ctx.worktree.root, 'required\n', true, false, false, hiddenExecutable);
        hiddenTask.fixtureObservation = 'unresolvable executable'; tasks.push(hiddenTask); await hiddenTask.ready;
        try {
          // A real native child stays live after directory traversal is denied.
          // This tests unknown executable refusal, not Darwin emulation.
          chmodSync(hiddenDirectory, 0);
          assert.throws(() => realpathSync(hiddenExecutable), (error) => error.code === 'EACCES');
          assert.equal(hiddenTask._handle?.pid, hiddenTask.pid); assert.equal(procEntry(hiddenTask.pid)?.[0], process.pid);
          assert.equal(processGroupOf(hiddenTask.pid), hiddenTask.pid); assert.equal(processStart(hiddenTask.pid), hiddenTask.started);
          assert.equal(hiddenTask.exitCode, null); assert.equal(hiddenTask.signalCode, null);
          const before = readSchedulerContext(ctx.lease).checkpoint;
          refuses('OWNER_UNVERIFIED', () => observe(hiddenTask));
          assert.deepEqual(readSchedulerContext(ctx.lease).checkpoint, before);
        } finally { chmodSync(hiddenDirectory, 0o700); await endChild(hiddenTask); }
        const zero = await recordFor('zero exit', 'actual fixture contents\n', async (task) => {
          task.send('run'); await task.finished;
          const current = readSchedulerContext(ctx.lease).checkpoint;
          if (current.units[0].planningRelationships.at(-1).status === 'observing') {
            assert.equal(reconcilePlanningRelationships(ctx.lease, current.revision).units[0].planningRelationships.at(-1).status, 'observing');
          }
        }, 'not-failed');
        refuses('WIDEN_REASON_UNVERIFIED', () => readFailingTaskRelationship(ctx.lease, readSchedulerContext(ctx.lease).checkpoint.revision,
          zero.relationshipId, { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: ctx.proposed }));
        await recordFor('signal exit', 'required\n', async (task) => { task.kill('SIGTERM'); }, 'inconclusive');
        await recordFor('output pipe failure', 'required\n', async (task) => { task.stdout.destroy(new Error('fixture output pipe failure')); task.send('run'); }, 'inconclusive');
        await recordFor('changed HEAD with equal tree', 'required\n', async (task) => {
          const tree = gitFact(ctx.worktree.root, ['--verify', 'HEAD^{tree}']);
          git('-C', ctx.worktree.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
            'commit', '--allow-empty', '-qm', 'context moved without a tree change');
          assert.equal(gitFact(ctx.worktree.root, ['--verify', 'HEAD^{tree}']), tree); task.send('run');
        }, 'inconclusive');
        writeFileSync(join(ctx.worktree.root, 'fixture.txt'), 'dirty-a\n');
        await recordFor('changed dirty bytes', 'required\n', async (task) => {
          const before = checkoutGit(ctx.worktree.root, ['status', '--porcelain=v1']);
          writeFileSync(join(ctx.worktree.root, 'fixture.txt'), 'dirty-b\n');
          assert.equal(checkoutGit(ctx.worktree.root, ['status', '--porcelain=v1']), before); task.send('run');
        }, 'inconclusive');
        writeFileSync(join(ctx.worktree.root, 'fixture.txt'), 'actual fixture contents\n');
        const paused = await recordFor('pause during observation', 'required\n', async (task) => {
          let current = readSchedulerContext(ctx.lease).checkpoint; commitTransition(ctx.lease, current.revision, (value) => value);
          current = readSchedulerContext(ctx.lease).checkpoint;
          commitTransition(ctx.lease, current.revision, (value) => ({ ...value, state: 'paused', desiredState: 'paused' })); task.send('run');
        }, 'verified-failure');
        let current = readSchedulerContext(ctx.lease).checkpoint;
        refuses('RUN_ACTIVE', () => readFailingTaskRelationship(ctx.lease, current.revision, paused.relationshipId,
          { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: ctx.proposed }));
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value, state: 'running', desiredState: 'running' }));
        current = readSchedulerContext(ctx.lease).checkpoint;
        for (const next of [[], current.units[0].planningRelationships.map((record) => ({ ...record, rationale: record.rationale + 'Changed.' }))]) {
          refuses('STATE_INVALID', () => commitTransition(ctx.lease, current.revision, (value) => ({ ...value,
            units: value.units.map((unit) => ({ ...unit, planningRelationships: next })) })));
        }
        const fake = { ...paused, relationshipId: randomUUID(), status: 'observing', exitCode: null, signal: null,
          stdoutDigest: null, stderrDigest: null, createdRevision: current.revision + 1, completedRevision: null };
        refuses('STATE_INVALID', () => commitTransition(ctx.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, planningRelationships: [...unit.planningRelationships, fake] })) })));
        writeFileSync(join(ctx.worktree.root, 'extra.txt'), 'pre-edited new path\n');
        const preEdited = await start('required\n'); refuses('BOUNDARY_EDIT_BEFORE_ADMISSION', () => observe(preEdited)); await endChild(preEdited);
        refuses('BOUNDARY_EDIT_BEFORE_ADMISSION', () => readFailingTaskRelationship(ctx.lease, current.revision, paused.relationshipId,
          { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: ctx.proposed }));
        renameSync(join(ctx.worktree.root, 'extra.txt'), join(setup.home, 'retained-pre-edited-extra.txt'));
      } finally {
        for (const task of tasks) if (task.exitCode === null && task.signalCode === null) await endChild(task);
        const current = readSchedulerContext(ctx.lease).checkpoint;
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(ctx.lease);
      }
    });
    await check('raw admission uses before-scope, verified expansion provenance, delivered exclusions and a monotonic proposal floor', async () => {
      const { createSnapshot, completeSection } = await import('./snapshot-contract.mjs');
      const api = { acquireScheduler, commitTransition, publishSelectionSnapshot, prepareEffect, markEffectInFlight, readProcessIdentity,
        resolveRepositoryCheckout, schedulerDigest, settleEffect };
      const prepare = async (prepareOnly) => {
        const setup = fixture(); const root = setup.repository.coordinatorRoot;
        writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n'); writeFileSync(join(root, '.gitignore'), 'cache/\n');
        git('-C', root, 'add', 'fixture.txt', '.gitignore');
        git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
        const data = await selectionFixture(setup); return createPlanningFixture({ setup, data, api, moduleUrl, accountHome, prepareOnly });
      };
      const admit = (ctx, artifact, reference) => {
        const current = readSchedulerContext(ctx.lease).checkpoint;
        const plan = artifactMetadata(artifact);
        return commitTransition(ctx.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, plan, admission: { schema: 'autoloop.admission/1', runId: value.runId,
            unitId: unit.unitId, unitGeneration: unit.unitGeneration, ...plan, reservationRevision: value.revision + 1 },
          wait: null, replanRequired: false, checkedSnapshot: reference, lastRequestedPlanGeneration: artifact.planGeneration })),
          reservations: value.reservations.map((item) => ({ ...item, state: 'admitted', paths: artifact.boundary })) }));
      };
      const end = (ctx) => { const current = readSchedulerContext(ctx.lease).checkpoint;
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(ctx.lease); };
      const initial = await prepare(true);
      try {
        writeFileSync(join(initial.worktree.root, 'fixture.txt'), 'edited before admission\n');
        refuses('BOUNDARY_EDIT_BEFORE_ADMISSION', () => admit(initial, initial.artifact, initial.snapshot));
        assert.deepEqual(readSchedulerContext(initial.lease).checkpoint.reservations[0].paths, []);
        writeFileSync(join(initial.worktree.root, 'fixture.txt'), 'actual fixture contents\n');
        mkdirSync(join(initial.worktree.root, 'cache')); writeFileSync(join(initial.worktree.root, 'cache', 'generated.txt'), 'ignored before first admission\n');
        refuses('EVIDENCE_CHANGED', () => admit(initial, initial.artifact, initial.snapshot));
        assert.deepEqual(readSchedulerContext(initial.lease).checkpoint.reservations[0].paths, []);
      } finally { end(initial); }
      const ctx = await prepare(false);
      const refresh = (sections = ctx.linkedEvidence.snapshot.sections) => {
        const current = readSchedulerContext(ctx.lease).checkpoint;
        return publishSelectionSnapshot(ctx.lease, current.revision, { ...ctx.linkedEvidence, checkpointRevision: current.revision,
          snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:04.000Z', sections }) });
      };
      try {
        let reference = refresh();
        refuses('WIDEN_REASON_UNVERIFIED', () => admit(ctx, ctx.proposed, reference));
        const task = startPlanningTask(api, ctx.worktree.root, 'required fixture contents\n'); await task.ready;
        const observation = observeFailingTaskRelationship(ctx.lease, readSchedulerContext(ctx.lease).checkpoint.revision, task,
          { unitId: ctx.data.unit.unitId, unitGeneration: 1, currentPlanArtifact: ctx.artifact, proposedPlanArtifact: ctx.proposed,
            taskText: ctx.taskText, rationale: 'The owner judged the additional fixture path necessary.' });
        task.send('run'); assert.equal((await observation.completion).status, 'verified-failure'); await task.finished;
        const at = '2026-01-01T00:00:00.000Z';
        const pr = { number: 90, title: 'Delivered fixture', body: 'Closes #9', isDraft: false, reviewDecision: 'APPROVED',
          headRefName: 'feat/gh-9-fixture', headRefOid: ctx.artifact.baseOid, baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
          mergedAt: null, updatedAt: at, author: 'fixture-operator', headRepository: 'example/scheduler-fixture', statusCheckState: 'SUCCESS',
          statusCheckRollup: [], files: ['extra.txt'], issue: 9, orphanCandidate: false, ownership: 'loop' };
        const markerBody = { branch: pr.headRefName, intentSource: 'invocation', issue: 9, issueBodyHash: schedulerDigest('public issue'),
          mergePolicy: 'manual', phase: 'ready-head', planHash: schedulerDigest('public plan'), plannedBaseOid: ctx.artifact.baseOid,
          pr: 90, runIntentHash: schedulerDigest('public intent'), selector: 'native', v: 1 };
        const marker = { issueNumber: 9, id: 'IC_public_fixture', tipId: 'IC_public_fixture', sequence: 0, author: 'fixture-operator',
          authorAssociation: 'MEMBER', body: '<!-- autoloop-lifecycle-v1\n' + JSON.stringify(markerBody) + '\n-->', createdAt: at, updatedAt: at, url: null };
        reference = refresh({ ...ctx.linkedEvidence.snapshot.sections, openPrs: completeSection([pr]), lifecycleMarkers: completeSection([marker]) });
        refuses('BOUNDARY_OVERLAP', () => admit(ctx, ctx.proposed, reference));
        reference = refresh(); admit(ctx, ctx.proposed, reference);
        writeFileSync(join(ctx.worktree.root, 'fixture.txt'), 'legitimate dirty edit in retained scope\n');
        const sameScope = { ...ctx.proposed, planGeneration: 5, body: ctx.proposed.body + 'Re-plan the same retained scope.\n' };
        reference = refresh(); const admitted = admit(ctx, sameScope, reference);
        assert.equal(admitted.units[0].lastRequestedPlanGeneration, 5);
        refuses('STATE_INVALID', () => commitTransition(ctx.lease, admitted.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, lastRequestedPlanGeneration: 4 })) })));
        refuses('STATE_INVALID', () => commitTransition(ctx.lease, admitted.revision, (value) => ({ ...value,
          units: value.units.map((unit) => { const { lastRequestedPlanGeneration, ...rest } = unit; return rest; }) })));
        refuses('STATE_INVALID', () => commitTransition(ctx.lease, admitted.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, lastRequestedPlanGeneration: 99 })) })));
      } finally { end(ctx); }
    });
    await check('raw batch admissions exclude final scopes and retained waiting paths with one actual owner', async () => {
      const { createSnapshot, completeSection } = await import('./snapshot-contract.mjs');
      const { selectionSnapshotReference } = await import('./scheduler-selection-schema.mjs');
      const api = { acquireScheduler, commitTransition, publishSelectionSnapshot, prepareEffect, markEffectInFlight, readProcessIdentity,
        resolveRepositoryCheckout, schedulerDigest, settleEffect, readSchedulerContext };
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n'); git('-C', root, 'add', 'fixture.txt');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const data = await selectionFixture(setup);
      const first = await createPlanningFixture({ setup, data, api, moduleUrl, accountHome, prepareOnly: true });
      const sections = structuredClone(data.evidence.snapshot.sections); const sources = structuredClone(data.evidence.sources);
      const queue = { ...sections.queue.items[0], number: 8 }; const openIssue = { ...sections.openIssues.items[0], number: 8 };
      sections.queue.items.push(queue); sections.openIssues.items.push(openIssue);
      sections.authorVerification.items[0].evidence.push({ ...sections.authorVerification.items[0].evidence[0], issueNumber: 8 });
      const issueSource = { number: 8, nodeId: 'I_fixture_8' };
      const approvalSource = { ...sources.approvals[0], issue: 8, issueNodeId: issueSource.nodeId, approvalIssue: 8,
        approvalIssueNodeId: issueSource.nodeId, eventId: 'E_fixture_8' };
      sources.issues.push(issueSource); sources.approvals.push(approvalSource);
      const revision = readSchedulerContext(first.lease).checkpoint.revision;
      const evidence = { ...data.evidence, checkpointRevision: revision, sources,
        snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:04.000Z', sections }) };
      const reference = selectionSnapshotReference(evidence);
      const subject = { ...data.authorization.subject, issue: 8, issueNodeId: issueSource.nodeId,
        approval: { ...data.authorization.subject.approval, issue: 8, issueNodeId: issueSource.nodeId, eventId: approvalSource.eventId } };
      const authorization = { ...data.authorization, subject, snapshot: reference, authorizationDigest: schedulerDigest(subject),
        evidenceDigest: schedulerDigest({ queue, openIssue, role: sections.authorVerification.items[0], issueSource, approvalSource, roleSource: sources.roles[0] }) };
      const unit = { ...data.unit, unitId: randomUUID(), checkedSnapshot: reference };
      const reservation = { ...data.reservation, issue: 8, unitId: unit.unitId, slot: 2, issueAuthorization: authorization, createdRevision: revision + 1 };
      const data8 = { evidence, reference, authorization, unit, reservation };
      let second;
      const refresh = (ctx) => { const current = readSchedulerContext(first.lease).checkpoint;
        return publishSelectionSnapshot(first.lease, current.revision, { ...ctx.linkedEvidence, sources,
          checkpointRevision: current.revision, snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:05.000Z',
            sections: { ...sections, tree: completeSection([{ dirtyEntries: [], dirtyPaths: 0, branch: ctx.worktree.branch, headOid: data.evidence.headOid }]) } }) }); };
      const admit = (ctx, artifact, snapshot) => { const current = readSchedulerContext(first.lease).checkpoint; const plan = artifactMetadata(artifact);
        return commitTransition(first.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((item) => item.unitId !== ctx.data.unit.unitId ? item : { ...item, plan, checkedSnapshot: snapshot, wait: null,
            replanRequired: false, lastRequestedPlanGeneration: artifact.planGeneration,
            admission: { schema: 'autoloop.admission/1', runId: value.runId, unitId: item.unitId, unitGeneration: 1,
              ...plan, reservationRevision: value.revision + 1 } }),
          reservations: value.reservations.map((item) => item.unitId !== ctx.data.unit.unitId ? item : { ...item, state: 'admitted', paths: artifact.boundary }) })); };
      const failed = async (ctx, currentArtifact, proposedArtifact) => { const task = startPlanningTask(api, ctx.worktree.root, 'required fixture contents\n'); await task.ready;
        const observation = observeFailingTaskRelationship(first.lease, readSchedulerContext(first.lease).checkpoint.revision, task,
          { unitId: ctx.data.unit.unitId, unitGeneration: 1, currentPlanArtifact: currentArtifact, proposedPlanArtifact: proposedArtifact,
            taskText: ctx.taskText, rationale: 'The owner judged the expanded path necessary for the observed task.' });
        task.send('run'); assert.equal((await observation.completion).status, 'verified-failure'); await task.finished; return observation; };
      try {
        second = await createPlanningFixture({ setup, data: data8, api, moduleUrl, accountHome, prepareOnly: true, existingLease: first.lease });
        assert.equal(second.lease, first.lease);
        const before = readSchedulerContext(first.lease).checkpoint;
        assert(before.reservations.every((item) => item.worktree && item.paths.length === 0));
        const snapshots = new Map([first, second].map((ctx) => [ctx.data.unit.unitId, refresh(ctx)]));
        const admitBoth = (secondArtifact) => {
          const plans = new Map([[first.data.unit.unitId, artifactMetadata(first.artifact)], [unit.unitId, artifactMetadata(secondArtifact)]]);
          return commitTransition(first.lease, before.revision, (value) => ({ ...value,
            units: value.units.map((item) => { const plan = plans.get(item.unitId); return { ...item, plan,
              checkedSnapshot: snapshots.get(item.unitId), lastRequestedPlanGeneration: plan.planGeneration,
              admission: { schema: 'autoloop.admission/1', runId: value.runId, unitId: item.unitId, unitGeneration: 1,
                ...plan, reservationRevision: value.revision + 1 } }; }),
            reservations: value.reservations.map((item) => ({ ...item, state: 'admitted', paths: plans.get(item.unitId).boundary })) }));
        };
        refuses('BOUNDARY_OVERLAP', () => admitBoth(second.artifact));
        assert.deepEqual(readSchedulerContext(first.lease).checkpoint, before, 'A refused batch must not change the checkpoint.');
        const independent = { ...second.artifact, boundary: ['other.txt'] };
        const admitted = admitBoth(independent);
        assert.equal(admitted.revision, before.revision + 1);
        assert.deepEqual(admitted.reservations.map((item) => item.paths), [['fixture.txt'], ['other.txt']]);
        const secondProposal = { ...independent, planGeneration: 2, body: independent.body + 'Repair fixture.txt.\n', boundary: ['fixture.txt', 'other.txt'] };
        await failed(second, independent, secondProposal); let snapshot = refresh(second);
        let current = readSchedulerContext(first.lease).checkpoint;
        const wait = { schema: 'autoloop.selection-wait/1', code: 'UNIT_OVERLAP', unitId: unit.unitId,
          conflicts: [{ type: 'unit', id: first.data.unit.unitId, paths: ['fixture.txt'] }],
          condition: { all: [{ on: 'unit-release', unitId: first.data.unit.unitId, unitGeneration: 1 }] },
          requestedPlan: artifactMetadata(secondProposal), snapshot, createdRevision: current.revision + 1 };
        commitTransition(first.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((item) => item.unitId !== unit.unitId ? item : { ...item, checkedSnapshot: snapshot, admission: null, wait, lastRequestedPlanGeneration: 2 }),
          reservations: value.reservations.map((item) => item.unitId !== unit.unitId ? item : { ...item, state: 'waiting' }) }));
        const firstProposal = { ...first.artifact, planGeneration: 2, body: first.artifact.body + 'Repair other.txt.\n', boundary: ['fixture.txt', 'other.txt'] };
        await failed(first, first.artifact, firstProposal); snapshot = refresh(first);
        refuses('BOUNDARY_OVERLAP', () => admit(first, firstProposal, snapshot));
        current = readSchedulerContext(first.lease).checkpoint;
        const kept = current.reservations.find((item) => item.unitId === unit.unitId);
        assert.equal(kept.state, 'waiting'); assert.deepEqual(kept.paths, ['other.txt']);
        assert.deepEqual(current.units.find((item) => item.unitId === unit.unitId).plan, artifactMetadata(independent));
      } finally {
        const current = readSchedulerContext(first.lease).checkpoint;
        commitTransition(first.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(first.lease);
      }
    });
    await check('planning after wake retains the admitted plan and permits canonical child paths already covered by a directory', async () => {
      const { createSnapshot, completeSection } = await import('./snapshot-contract.mjs');
      const api = { acquireScheduler, commitTransition, publishSelectionSnapshot, prepareEffect, markEffectInFlight, readProcessIdentity,
        resolveRepositoryCheckout, schedulerDigest, settleEffect };
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n'); git('-C', root, 'add', 'fixture.txt');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const data = await selectionFixture(setup); const ctx = await createPlanningFixture({ setup, data, api, moduleUrl, accountHome, prepareOnly: true });
      mkdirSync(join(ctx.worktree.root, 'src'));
      const artifact = { ...ctx.artifact, boundary: ['src/'] }; const plan = artifactMetadata(artifact);
      const refresh = (closed = false) => { const current = readSchedulerContext(ctx.lease).checkpoint;
        return publishSelectionSnapshot(ctx.lease, current.revision, { ...ctx.linkedEvidence, checkpointRevision: current.revision,
          sources: { ...ctx.linkedEvidence.sources, waitIssues: completeSection([{ number: 8, nodeId: 'I_wait_fixture', state: closed ? 'CLOSED' : 'OPEN' }]) },
          snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:04.000Z', sections: ctx.linkedEvidence.snapshot.sections }) }); };
      let observation;
      try {
        let current = readSchedulerContext(ctx.lease).checkpoint; let snapshot = refresh();
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, checkedSnapshot: snapshot, plan, lastRequestedPlanGeneration: 1,
            admission: { schema: 'autoloop.admission/1', runId: value.runId, unitId: unit.unitId, unitGeneration: 1, ...plan, reservationRevision: value.revision + 1 } })),
          reservations: value.reservations.map((item) => ({ ...item, state: 'admitted', paths: plan.boundary })) }));
        current = readSchedulerContext(ctx.lease).checkpoint; snapshot = refresh();
        const wait = { schema: 'autoloop.selection-wait/1', code: 'ISSUE_WAIT', unitId: data.unit.unitId,
          conflicts: [{ type: 'issue', id: 8, paths: [] }], condition: { all: [{ on: 'issue', number: 8 }] },
          requestedPlan: { ...plan, planGeneration: 2, planDigest: schedulerDigest({ ...artifact, planGeneration: 2 }) },
          snapshot, createdRevision: current.revision + 1 };
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, checkedSnapshot: snapshot, admission: null, wait, lastRequestedPlanGeneration: 2 })),
          reservations: value.reservations.map((item) => ({ ...item, state: 'waiting' })) }));
        current = readSchedulerContext(ctx.lease).checkpoint; snapshot = refresh(true);
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, checkedSnapshot: snapshot, wait: null, replanRequired: true })),
          reservations: value.reservations.map((item) => ({ ...item, state: 'planning' })) }));
        current = readSchedulerContext(ctx.lease).checkpoint;
        assert.deepEqual(current.units[0].plan, plan); assert.equal(current.units[0].lastRequestedPlanGeneration, 2);
        const wider = { ...artifact, planGeneration: 4, boundary: ['next/', 'src/'], body: artifact.body + 'Repair next/.\n' };
        const task = startPlanningTask(api, ctx.worktree.root, 'required fixture contents\n'); await task.ready;
        observation = observeFailingTaskRelationship(ctx.lease, current.revision, task, { unitId: data.unit.unitId, unitGeneration: 1,
          currentPlanArtifact: artifact, proposedPlanArtifact: wider, taskText: ctx.taskText, rationale: 'The owner judged that next/ is needed.' });
        task.send('run'); assert.equal((await observation.completion).status, 'verified-failure'); await task.finished;
        current = readSchedulerContext(ctx.lease).checkpoint; assert.equal(current.units[0].lastRequestedPlanGeneration, 2);
        assert.equal(readFailingTaskRelationship(ctx.lease, current.revision, observation.relationshipId,
          { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: wider }).status, 'verified-failure');
        const refined = { ...artifact, planGeneration: 3, boundary: ['src/', 'src/a.mjs'], body: artifact.body + 'Refine the existing src/ scope.\n' };
        const refinedPlan = artifactMetadata(refined); snapshot = refresh(true);
        const admitted = commitTransition(ctx.lease, current.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, checkedSnapshot: snapshot, plan: refinedPlan, replanRequired: false, lastRequestedPlanGeneration: 3,
            admission: { schema: 'autoloop.admission/1', runId: value.runId, unitId: unit.unitId, unitGeneration: 1,
              ...refinedPlan, reservationRevision: value.revision + 1 } })),
          reservations: value.reservations.map((item) => ({ ...item, state: 'admitted', paths: refinedPlan.boundary })) }));
        assert.deepEqual(admitted.reservations[0].paths, ['src/', 'src/a.mjs']);
        refuses('TARGET_MISMATCH', () => readFailingTaskRelationship(ctx.lease, admitted.revision, observation.relationshipId,
          { unitId: data.unit.unitId, unitGeneration: 1, proposedPlanArtifact: wider }));
      } finally {
        await observation?.completion.catch(() => {}); const current = readSchedulerContext(ctx.lease).checkpoint;
        commitTransition(ctx.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(ctx.lease);
      }
    });
    await check('lost observation authority cannot settle into a successor generation or promote a real late exit', async () => {
      const api = { acquireScheduler, commitTransition, publishSelectionSnapshot, prepareEffect, markEffectInFlight, readProcessIdentity,
        resolveRepositoryCheckout, schedulerDigest, settleEffect };
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n'); git('-C', root, 'add', 'fixture.txt');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const data = await selectionFixture(setup); const ctx = await createPlanningFixture({ setup, data, api, moduleUrl, accountHome });
      const task = startPlanningTask(api, ctx.worktree.root, 'required fixture contents\n'); await task.ready;
      const observation = observeFailingTaskRelationship(ctx.lease, readSchedulerContext(ctx.lease).checkpoint.revision, task,
        { unitId: data.unit.unitId, unitGeneration: 1, currentPlanArtifact: ctx.artifact, proposedPlanArtifact: ctx.proposed,
          taskText: ctx.taskText, rationale: 'The owner judged the added path necessary.' });
      const rejected = assert.rejects(observation.completion, (error) => error instanceof SchedulerError && error.code === 'LEASE_INVALID');
      let current = readSchedulerContext(ctx.lease).checkpoint;
      commitTransition(ctx.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(ctx.lease);
      const successor = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      try {
        task.send('run'); await rejected; assert.equal((await task.finished).code, 1);
        current = readSchedulerContext(successor.lease).checkpoint;
        assert.equal(current.units[0].planningRelationships[0].status, 'observing');
        current = reconcilePlanningRelationships(successor.lease, current.revision);
        const record = current.units[0].planningRelationships[0];
        assert.equal(record.status, 'inconclusive'); assert.equal(record.exitCode, null); assert.equal(record.schedulerGeneration, 1);
        assert.equal(current.generation, 2); assert.equal(planningRelationshipRecovery(current).pending, false);
      } finally {
        if (task.exitCode === null && task.signalCode === null) await endChild(task);
        current = readSchedulerContext(successor.lease).checkpoint;
        commitTransition(successor.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(successor.lease);
      }
    });
    await check('descendants and crashed observation owners retain scope until real group exit without exit-file promotion', async () => {
      const reaperScript = `import ctypes,os,subprocess,sys
if sys.platform.startswith('linux'): ctypes.CDLL(None).prctl(36,1,0,0,0)
owner=subprocess.Popen([sys.argv[1],'--input-type=module','-e',sys.argv[2],*sys.argv[3:]])
result=None
while True:
    try: pid,status=os.waitpid(-1,0)
    except ChildProcessError: break
    if pid==owner.pid:
        result=os.waitstatus_to_exitcode(status)
        if not sys.platform.startswith('linux'): break
sys.exit(result if result is not None and result>=0 else 128+abs(result or 1))
`;
      for (const mode of ['descendant', 'inherit', 'detached-inherit', 'crash']) {
        const setup = fixture(); const root = setup.repository.coordinatorRoot;
        writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n'); git('-C', root, 'add', 'fixture.txt');
        git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
        const data = await selectionFixture(setup);
        const ownerScript = `const api=await import(process.argv[1]);const {spawn}=await import('node:child_process');const children=new Set();
          const setup=JSON.parse(process.argv[2]),data=JSON.parse(process.argv[3]),accountHome=process.argv[4],mode=process.argv[5];
          const ctx=await (${createPlanningFixture.toString()})({setup,data,api,moduleUrl:process.argv[1],accountHome});
          const task=(${startPlanningTask.toString()})(api,ctx.worktree.root,'required fixture contents\\n',true,
            mode.includes('inherit')?mode:mode==='descendant');await task.ready;
          console.log(JSON.stringify({kind:'child',owner:api.readProcessIdentity(),child:api.readProcessIdentity(task.pid)}));
          let descendant=null;task.on('message',value=>{if(value.descendant){descendant=api.readProcessIdentity(value.descendant);
            console.log(JSON.stringify({kind:'descendant',identity:descendant}));}});
          const current=api.readSchedulerContext(ctx.lease).checkpoint;
          const observation=api.observeFailingTaskRelationship(ctx.lease,current.revision,task,{unitId:data.unit.unitId,unitGeneration:1,
            currentPlanArtifact:ctx.artifact,proposedPlanArtifact:ctx.proposed,taskText:ctx.taskText,rationale:'The owner judged the extra fixture path necessary.'});
          console.log(JSON.stringify({kind:'observing',record:api.readSchedulerContext(ctx.lease).checkpoint.units[0].planningRelationships[0]}));
          task.once('exit',()=>{const observed=api.readSchedulerContext(ctx.lease).checkpoint.units[0].planningRelationships[0];
            console.log(JSON.stringify({kind:'exit-facts',groupState:api.boundCreatorState({process:observed.process,groupLeader:observed.groupLeader,pgid:observed.pgid}),
              descendantState:descendant&&api.processIdentityState(descendant)}));});
          if(mode==='crash'){await new Promise(()=>{});}else{
            task.send('run');const record=await observation.completion;
            if(record.status!=='inconclusive')throw Error('A surviving descendant must not verify failure.');
            let code=null;try{api.observeSelectionNoWork(ctx.lease,data.unit.unitId);}catch(error){code=error.code;}
            let widenCode=null;try{api.readFailingTaskRelationship(ctx.lease,api.readSchedulerContext(ctx.lease).checkpoint.revision,
              observation.relationshipId,{unitId:data.unit.unitId,unitGeneration:1,proposedPlanArtifact:ctx.proposed});}catch(error){widenCode=error.code;}
            console.log(JSON.stringify({kind:'settled',record,recovery:api.planningRelationshipRecovery(api.readSchedulerContext(ctx.lease).checkpoint),code,widenCode,
              groupState:api.boundCreatorState({process:record.process,groupLeader:record.groupLeader,pgid:record.pgid}),descendantState:api.processIdentityState(descendant)}));
            await new Promise(done=>process.stdin.once('data',done));process.stdin.pause();process.stdin.destroy();
            if(api.processIdentityState(descendant)==='alive')process.kill(descendant.pid,'SIGTERM');
            const until=Date.now()+15000;while(api.boundCreatorState({process:record.process,groupLeader:record.groupLeader,pgid:record.pgid})!=='empty'){
              if(Date.now()>until)throw Error('Fixture descendant did not exit.');await new Promise(done=>setTimeout(done,10));}
            await task.finished;await new Promise(done=>setImmediate(done));const checkpoint=api.readSchedulerContext(ctx.lease).checkpoint;
            if(checkpoint.revision!==record.completedRevision||JSON.stringify(checkpoint.units[0].planningRelationships.at(-1))!==JSON.stringify(record))
              throw Error('Late close rewrote the terminal observation.');
            if(api.planningRelationshipRecovery(checkpoint).pending)throw Error('Exited inconclusive group must be settled history.');
            api.commitTransition(ctx.lease,checkpoint.revision,value=>({...value,state:'stopped',desiredState:'stopped'}));api.releaseScheduler(ctx.lease);
          }`;
        const wrapper = spawn('python3', ['-I', '-u', '-c', reaperScript, process.execPath, ownerScript, moduleUrl,
          JSON.stringify(setup), JSON.stringify(data), accountHome, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
        wrapper.started = processStart(wrapper.pid); wrapper.finished = new Promise((done) => wrapper.once('close', (code, signal) => done({ code, signal })));
        children.add(wrapper); wrapper.finished.then(() => children.delete(wrapper));
        const events = []; let pending = ''; let errors = '';
        wrapper.stdout.on('data', (chunk) => { pending += chunk.toString();
          while (pending.includes('\n')) { const at = pending.indexOf('\n'); const line = pending.slice(0, at); pending = pending.slice(at + 1);
            if (line) events.push(JSON.parse(line)); } });
        wrapper.stderr.on('data', (chunk) => { errors += chunk; });
        const event = async (kind) => { const until = Date.now() + 20000;
          while (!events.some((item) => item.kind === kind)) { assert(Date.now() < until && wrapper.exitCode === null,
            'Fixture owner did not report ' + kind + ': ' + errors); await new Promise((done) => setTimeout(done, 10)); }
          return events.find((item) => item.kind === kind); };
        const exit = async () => { let timer;
          try { return await Promise.race([wrapper.finished, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Fixture owner exit timed out: ' + errors)), 20000); })]); }
          finally { clearTimeout(timer); } };
        let recovered = null;
        try {
          const observing = await event('observing'); const child = await event('child');
          assert.equal(observing.record.status, 'observing');
          assert.deepEqual(readCheckpoint(setup.repository, setup.pins.runId).owner, child.owner);
          if (mode !== 'crash') {
            if (mode === 'detached-inherit') {
              const facts = await event('exit-facts');
              assert.equal(facts.groupState, 'empty'); assert.equal(facts.descendantState, 'alive');
            }
            const settled = await event('settled'); assert.equal(settled.record.status, 'inconclusive');
            if (mode.includes('inherit')) {
              assert.equal(settled.record.stdoutDigest, null); assert.equal(settled.record.stderrDigest, null);
            }
            if (mode === 'detached-inherit') {
              assert.equal(settled.groupState, 'empty'); assert.equal(settled.descendantState, 'alive');
              assert.equal(settled.recovery.pending, false); assert.equal(settled.widenCode, 'WIDEN_REASON_UNVERIFIED');
            } else {
              assert.equal(settled.recovery.pending, true); assert.deepEqual(settled.recovery.unitIds, [data.unit.unitId]);
              assert.equal(settled.code, 'OWNER_UNVERIFIED');
            }
            wrapper.stdin.write('cleanup\n');
            assert.equal((await exit()).code, 0, errors);
          } else {
            assert.equal(processIdentityState(child.owner), 'alive'); process.kill(child.owner.pid, 'SIGKILL');
            const until = Date.now() + 15000;
            while (processIdentityState(child.owner) !== 'dead') { assert(Date.now() < until); await new Promise((done) => setTimeout(done, 10)); }
            recovered = acquireScheduler(setup.repository, setup.pins, setup.initiator);
            let checkpoint = readSchedulerContext(recovered.lease).checkpoint;
            assert.equal(checkpoint.generation, 2); assert.equal(checkpoint.units[0].planningRelationships[0].status, 'observing');
            writeFileSync(join(setup.home, 'untrusted-exit-code.json'), JSON.stringify({ exitCode: 1 }));
            checkpoint = reconcilePlanningRelationships(recovered.lease, checkpoint.revision);
            assert.equal(checkpoint.units[0].planningRelationships[0].status, 'observing');
            assert.equal(planningRelationshipRecovery(checkpoint).pending, true);
            assert.equal(processIdentityState(child.child), 'alive'); process.kill(child.child.pid, 'SIGTERM'); await exit();
            checkpoint = reconcilePlanningRelationships(recovered.lease, checkpoint.revision);
            const record = checkpoint.units[0].planningRelationships[0];
            assert.equal(record.status, 'inconclusive'); assert.equal(record.schedulerGeneration, 1);
            assert.equal(record.exitCode, null); assert.equal(record.stdoutDigest, null); assert.equal(record.stderrDigest, null);
            assert.equal(planningRelationshipRecovery(checkpoint).pending, false);
          }
        } finally {
          for (const identity of [events.find((item) => item.kind === 'descendant')?.identity,
            events.find((item) => item.kind === 'child')?.child, events.find((item) => item.kind === 'child')?.owner].filter(Boolean)) {
            if (processIdentityState(identity) === 'alive') process.kill(identity.pid, 'SIGTERM');
          }
          await exit();
          if (recovered) { const current = readSchedulerContext(recovered.lease).checkpoint;
            commitTransition(recovered.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(recovered.lease); }
        }
      }
    });
    await check('real allocation reconciliation and no-work readback share the filter-free status policy', async () => {
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'actual fixture contents\n'); writeFileSync(join(root, '.gitattributes'), 'fixture.txt filter=fixture\n');
      git('-C', root, 'add', 'fixture.txt', '.gitattributes');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const data = await selectionFixture(setup);
      const owner = startChild(`const api=await import(process.argv[1]);const {spawn}=await import('node:child_process');
        const {spawnSync}=await import('node:child_process');const {writeFileSync,existsSync,renameSync,utimesSync}=await import('node:fs');
        const {join}=await import('node:path');const setup=JSON.parse(process.argv[2]),data=JSON.parse(process.argv[3]);
        const ctx=await (${createPlanningFixture.toString()})({setup,data,api,moduleUrl:process.argv[1],accountHome:process.argv[4]});
        const marker=join(setup.home,'readback-filter-marker'),filter=join(setup.home,'readback-filter.mjs');
        writeFileSync(filter,'#!'+process.execPath+'\\nimport {writeFileSync} from "node:fs";writeFileSync('+JSON.stringify(marker)+',"invoked");process.stdin.pipe(process.stdout);\\n',{mode:448});
        const git=(args)=>{const result=spawnSync('git',['-C',ctx.worktree.root,...args],{encoding:'utf8',timeout:15000});
          if(result.status!==0)throw Error(result.stderr);return result.stdout;};
        git(['config','extensions.worktreeConfig','true']);git(['config','--worktree','filter.fixture.clean',filter]);
        git(['config','--worktree','filter.fixture.required','true']);writeFileSync(join(ctx.worktree.root,'fixture.txt'),'actual fixture contents\\n');
        utimesSync(join(ctx.worktree.root,'fixture.txt'),new Date(),new Date(Date.now()+2000));
        const {createWorktreeAllocator}=await import(new URL('./scheduler-worktree.mjs',process.argv[1]));
        const allocator=createWorktreeAllocator({lease:ctx.lease});
        const binding=await allocator.reconcileWorktree(ctx.lease,data.unit.unitId);
        if(binding.root!==ctx.worktree.root||existsSync(marker))throw Error('Allocation readback ran a project filter.');
        api.observeSelectionNoWork(ctx.lease,data.unit.unitId);
        if(existsSync(marker))throw Error('No-work readback ran a project filter.');
        git(['status','--porcelain=v1']);if(!existsSync(marker))throw Error('The real readback filter control did not run.');
        renameSync(marker,join(setup.home,'retained-readback-control-marker'));
        const checkpoint=api.readSchedulerContext(ctx.lease).checkpoint;
        api.commitTransition(ctx.lease,checkpoint.revision,value=>({...value,state:'stopped',desiredState:'stopped'}));api.releaseScheduler(ctx.lease);
        process.send({safe:true},()=>process.disconnect());`, [moduleUrl, JSON.stringify(setup), JSON.stringify(data), accountHome]);
      assert.deepEqual(await message(owner), { safe: true }); assert.equal((await owner.finished).code, 0, owner.errorText);
    });
    await check('read-only Git profiles refuse missing promised objects without transport or object writes', async () => {
      const setup = fixture(); const source = setup.repository.coordinatorRoot;
      writeFileSync(join(source, 'fixture.txt'), 'public promised fixture contents\n');
      git('-C', source, 'add', 'fixture.txt');
      git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'promised fixture');
      git('-C', source, 'config', 'uploadpack.allowFilter', 'true');
      git('-C', source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      const omitted = git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit-tree', git('-C', source, 'rev-parse', 'HEAD^{tree}'), '-m', 'unadvertised fixture commit');
      const helper = join(setup.home, 'local-transport.mjs');
      writeFileSync(helper, `import {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
        writeFileSync(process.argv[2],'local transport invoked\\n');
        const result=spawnSync(process.argv[3],[process.argv[4]],{stdio:'inherit'});process.exit(result.status??1);\n`);
      const objectBytes = (directory) => readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total
        + (entry.isDirectory() ? objectBytes(join(directory, entry.name)) : lstatSync(join(directory, entry.name)).size), 0);
      const clone = (name) => {
        const root = join(setup.home, name); const marker = join(setup.home, name + '.marker');
        git('clone', '-q', '--no-checkout', '--filter=tree:0', 'file://' + source, root);
        git('-C', root, 'config', 'protocol.ext.allow', 'always');
        git('-C', root, 'remote', 'set-url', 'origin', `ext::${process.execPath} ${helper} ${marker} %S ${source}`);
        assert.equal(git('-C', root, 'config', '--bool', 'remote.origin.promisor'), 'true');
        return { root, marker, objects: join(root, '.git', 'objects') };
      };
      const control = clone('ordinary'); const controlBefore = objectBytes(control.objects);
      const ordinary = spawnSync('git', ['-C', control.root, 'ls-tree', '-r', 'HEAD'],
        { encoding: 'utf8', timeout: 15000, env: { ...process.env, GIT_NO_LAZY_FETCH: '0' } });
      assert.equal(ordinary.status, 0, ordinary.stderr); assert(existsSync(control.marker));
      assert(objectBytes(control.objects) > controlBefore, 'The real local transport must supply missing objects.');
      const results = [];
      const previous = process.env.GIT_NO_LAZY_FETCH;
      try {
        process.env.GIT_NO_LAZY_FETCH = '1';
        for (const [name, observe] of [
          ['status', (root) => readGitStatus(root)],
          ['planning', (root) => readPlanningWorktreeContext(root, [], [])],
          ['core', (root) => gitFact(root, ['--verify', `${omitted}^{commit}`])],
        ]) {
          const test = clone(name); const before = objectBytes(test.objects);
          let code = null; try { observe(test.root); } catch (error) { code = error.code; }
          results.push({ name, code, transport: existsSync(test.marker), unchanged: objectBytes(test.objects) === before });
        }
      } finally { if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH; else process.env.GIT_NO_LAZY_FETCH = previous; }
      assert.deepEqual(results, [
        { name: 'status', code: 'GIT_OBSERVATION_FAILED', transport: false, unchanged: true },
        { name: 'planning', code: 'EVIDENCE_CHANGED', transport: false, unchanged: true },
        { name: 'core', code: 'REPOSITORY_INVALID', transport: false, unchanged: true },
      ]);
      for (const mode of ['create', 'readback']) {
        const test = clone('allocation-' + mode);
        git('-C', test.root, 'remote', 'rename', 'origin', 'fixture-promisor');
        const repository = resolveRepository(test.root);
        const allocationSetup = { ...setup, repository, pins: createPins(repository, { pluginRoot: setup.pins.pluginRoot,
          enginePath: setup.pins.enginePath, config: setup.pins.config, models: setup.pins.models }) };
        const data = await selectionFixture(allocationSetup);
        const owner = startChild(`const api=await import(process.argv[1]);
          const {createWorktreeAllocator}=await import(new URL('./scheduler-worktree.mjs',process.argv[1]));
          const {spawn}=await import('node:child_process');const {dirname,join}=await import('node:path');
          const {mkdirSync,existsSync,readdirSync,lstatSync}=await import('node:fs');const assert=(await import('node:assert/strict')).default;
          const setup=JSON.parse(process.argv[2]),data=JSON.parse(process.argv[3]),test=JSON.parse(process.argv[4]),mode=process.argv[5];
          const bytes=directory=>readdirSync(directory,{withFileTypes:true}).reduce((total,entry)=>total+(entry.isDirectory()?bytes(join(directory,entry.name)):lstatSync(join(directory,entry.name)).size),0);
          const beforeBytes=bytes(test.objects);const lease=api.acquireScheduler(setup.repository,setup.pins,
            {kind:'terminal',sessionId:null,process:api.readProcessIdentity()}).lease;
          try{
            api.commitTransition(lease,1,value=>({...value,state:'running'}));api.publishSelectionSnapshot(lease,2,data.evidence);
            api.commitTransition(lease,2,value=>({...value,units:[data.unit],reservations:[data.reservation]}));
            const checkedSnapshot=api.publishSelectionSnapshot(lease,3,{...data.evidence,checkpointRevision:3});
            const intent={operationId:crypto.randomUUID(),runId:setup.pins.runId,unitId:data.unit.unitId,unitGeneration:1,
              repositoryKey:setup.repository.repositoryKey,root:join(dirname(test.root),'.autoloop-worktrees',setup.repository.repositoryKey,setup.pins.runId,data.unit.unitId+'-g1'),
              branch:'feat/gh-'+data.reservation.issue+'-unit-'+data.unit.unitId.replaceAll('-','')+'-g1',baseOid:data.evidence.baseOid};
            api.prepareEffect(lease,3,{operationId:intent.operationId,requestId:null,runId:intent.runId,unitId:intent.unitId,unitGeneration:1,
              kind:'worktree.create',target:{type:'external',id:intent.unitId},inputDigest:api.schedulerDigest(intent),expectedHead:intent.baseOid,
              phase:'prepared',attempt:1,receipt:null,error:null},value=>({...value,units:value.units.map(unit=>({...unit,checkedSnapshot,allocation:{intent,creator:null,creatorHistory:[]}}))}));
            const allocator=createWorktreeAllocator({lease});
            if(mode==='readback'){
              mkdirSync(dirname(intent.root),{recursive:true,mode:0o700});
              const child=spawn(process.execPath,['--input-type=module','-e',
                'import {spawnSync} from "node:child_process";process.once("message",()=>{const value=spawnSync("git",JSON.parse(process.argv[1]),{stdio:"ignore"});process.exit(value.status===0?0:1);});process.send("ready");',
                JSON.stringify(['--no-lazy-fetch','-C',test.root,'-c','core.hooksPath=/dev/null','worktree','add','--no-track','--no-checkout','-b',intent.branch,intent.root,intent.baseOid])],
                {detached:true,stdio:['ignore','ignore','ignore','ipc']});
              const closed=new Promise(done=>child.once('close',done));await new Promise(done=>child.once('message',done));
              try{
                const identity=api.readProcessIdentity(child.pid);api.markEffectInFlight(lease,intent.operationId);
                api.commitTransition(lease,api.readSchedulerContext(lease).checkpoint.revision,value=>({...value,
                  units:value.units.map(unit=>({...unit,allocation:{...unit.allocation,creator:{process:identity,groupLeader:identity,pgid:child.pid}}}))}));
                child.send('create');assert.equal(await closed,0);
              }finally{if(child.connected)child.disconnect();await closed;}
              const before=api.readSchedulerContext(lease).checkpoint;
              await assert.rejects(()=>allocator.reconcileWorktree(lease,data.unit.unitId),error=>error.code==='WORKTREE_UNVERIFIED');
              assert.deepEqual(api.readSchedulerContext(lease).checkpoint,before,'Missing-object readback must retain uncertain state.');
            }else{
              try{await allocator.allocateWorktree(lease,data.unit.unitId,intent.baseOid);}catch(error){assert(['OUTCOME_UNKNOWN','WORKTREE_UNVERIFIED'].includes(error.code),error.code);}
            }
            const checkpoint=api.readSchedulerContext(lease).checkpoint;
            assert.equal(checkpoint.reservations[0].worktree,null);assert.notEqual(checkpoint.outbox[intent.operationId].phase,'succeeded');
            assert.deepEqual(checkpoint.units[0].allocation.intent,intent);assert.equal(existsSync(test.marker),false);assert.equal(bytes(test.objects),beforeBytes);
            process.send({mode,phase:checkpoint.outbox[intent.operationId].phase});
          }finally{const checkpoint=api.readSchedulerContext(lease).checkpoint;
            api.commitTransition(lease,checkpoint.revision,value=>({...value,state:'stopped',desiredState:'stopped'}));api.releaseScheduler(lease);}
          process.disconnect();`, [moduleUrl, JSON.stringify(allocationSetup), JSON.stringify(data), JSON.stringify(test), mode]);
        const result = await message(owner); assert.equal(result.mode, mode); assert.notEqual(result.phase, 'succeeded');
        if (mode === 'readback') assert.equal(result.phase, 'in-flight');
        assert.equal((await owner.finished).code, 0, owner.errorText);
      }
    });
    await check('shared status preserves clean uninitialized and initialized submodules and suppresses nested included drivers', async () => {
      const { readGitStatus } = await import('./git-observation.mjs');
      const { utimesSync } = await import('node:fs');
      const setup = fixture(); const root = setup.repository.coordinatorRoot; const source = join(setup.home, 'module-source');
      git('init', '-q', '-b', 'main', source);
      writeFileSync(join(source, 'fixture.txt'), 'baseline\n'); writeFileSync(join(source, '.gitattributes'), 'fixture.txt filter=nested\n');
      git('-C', source, 'add', 'fixture.txt', '.gitattributes');
      git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'module fixture');
      git('-C', root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'embedded');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'module binding');
      const ordinaryStatus = () => { const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr); return result.stdout; };
      assert.equal(readGitStatus(root).toString(), ordinaryStatus());
      const comparisonBase = git('-C', root, 'rev-parse', 'HEAD');
      assert.equal(readPlanningWorktreeContext(root, [], [], comparisonBase).initialClean, true);
      const saved = join(setup.home, 'retained-initialized-module');
      renameSync(join(root, 'embedded'), saved); mkdirSync(join(root, 'embedded'));
      assert.equal(readGitStatus(root).toString(), ordinaryStatus());
      assert.equal(readPlanningWorktreeContext(root, [], [], comparisonBase).initialClean, true);
      renameSync(join(root, 'embedded'), join(setup.home, 'retained-empty-module-directory'));
      renameSync(saved, join(root, 'embedded'));
      const marker = join(setup.home, 'nested-filter-marker'); const filter = join(setup.home, 'nested-filter.mjs');
      writeFileSync(filter, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'invoked');process.stdin.pipe(process.stdout);\n`, { mode: 0o700 });
      const included = join(setup.home, 'nested-included.config');
      git('config', '--file', included, 'filter.nested.clean', filter);
      git('-C', join(root, 'embedded'), 'config', 'include.path', included);
      git('-C', join(root, 'embedded'), 'config', 'extensions.worktreeConfig', 'true');
      git('-C', join(root, 'embedded'), 'config', '--worktree', 'filter.nested.required', 'true');
      writeFileSync(join(root, 'embedded', 'fixture.txt'), 'changed!\n');
      utimesSync(join(root, 'embedded', 'fixture.txt'), new Date(), new Date(Date.now() + 2000));
      const safe = readGitStatus(root).toString(); assert.equal(existsSync(marker), false);
      const ordinary = spawnSync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8', timeout: 15000 });
      assert.equal(ordinary.status, 0, ordinary.stderr); assert.equal(existsSync(marker), true, 'Ordinary nested status must exercise the real filter.');
      assert.equal(safe, ordinary.stdout);
      renameSync(marker, join(setup.home, 'retained-nested-filter-marker'));
      assert.throws(() => readPlanningWorktreeContext(root, [], [], comparisonBase),
        (error) => /^(?:BOUNDARY_|EVIDENCE_CHANGED)/u.test(error.code));
      assert.equal(existsSync(marker), false);
    });
    await check('shared status observations disable effective included and worktree filters without an executor API', async () => {
      const { readGitStatus } = await import('./git-observation.mjs');
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'baseline\n'); writeFileSync(join(root, '.gitattributes'), 'fixture.txt filter=fixture\n');
      git('-C', root, 'add', 'fixture.txt', '.gitattributes');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const marker = join(setup.home, 'filter-invoked'); const filter = join(setup.home, 'filter.mjs');
      writeFileSync(filter, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'invoked');process.stdin.pipe(process.stdout);\n`, { mode: 0o700 });
      const included = join(setup.home, 'included.config');
      git('config', '--file', included, 'filter.fixture.clean', filter); git('config', '--file', included, 'filter.fixture.required', 'true');
      git('-C', root, 'config', 'includeIf.onbranch:main.path', included);
      git('-C', root, 'config', 'extensions.worktreeConfig', 'true');
      git('-C', root, 'config', '--worktree', 'filter.fixture.process', filter);
      writeFileSync(join(root, 'fixture.txt'), 'changed!\n');
      assert.equal(readGitStatus(root, { zeroTerminated: true }).toString(), ' M fixture.txt\0');
      assert.equal(readGitStatus(root).toString(), ' M fixture.txt\n');
      assert.equal(existsSync(marker), false, 'Safe reads must not start either configured driver.');
      assert.throws(() => readGitStatus(root, { args: ['clean', '-ffdx'] }), (error) => error.code === 'GIT_OBSERVATION_FAILED');
      const ordinary = spawnSync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8', timeout: 15000 });
      assert.equal(existsSync(marker), true, 'The harmless marker must intercept the real filter path. ' + ordinary.status + ': ' + ordinary.stderr);
      assert(ordinary.status !== null);
      renameSync(marker, join(setup.home, 'retained-filter-marker'));
      git('-C', root, '-c', 'filter.fixture.clean=', '-c', 'filter.fixture.process=', '-c', 'filter.fixture.required=false',
        'update-index', '--add', '--cacheinfo', '160000,' + git('-C', root, 'rev-parse', 'HEAD') + ',embedded');
      symlinkSync(root, join(root, 'embedded'), 'dir');
      assert.throws(() => readGitStatus(root), (error) => error.code === 'GIT_OBSERVATION_FAILED');
      assert.equal(existsSync(marker), false, 'Unsupported submodule reads must refuse before filters can run.');
    });
    await check('clean CRLF linked checkouts use built-in Git conversions while raw bytes still identify observations', async () => {
      const { readGitContentOids } = await import('./git-observation.mjs');
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, '.gitattributes'), 'fixture.txt text eol=crlf filter=fixture\n');
      writeFileSync(join(root, 'fixture.txt'), 'line one\nline two\n');
      git('-C', root, 'add', '.gitattributes', 'fixture.txt');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'CRLF fixture');
      const base = git('-C', root, 'rev-parse', 'HEAD'); const linked = join(setup.home, 'crlf-worktree');
      git('-C', root, 'worktree', 'add', '-q', '--detach', linked, base);
      assert.equal(readFileSync(join(linked, 'fixture.txt'), 'utf8'), 'line one\r\nline two\r\n');
      assert.equal(checkoutGit(linked, ['status', '--porcelain=v1']), '');
      const marker = join(setup.home, 'hash-filter-marker'); const filter = join(setup.home, 'hash-filter.mjs');
      writeFileSync(filter, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'invoked');process.stdin.pipe(process.stdout);\n`, { mode: 0o700 });
      git('-C', linked, 'config', 'filter.fixture.clean', filter); git('-C', linked, 'config', 'filter.fixture.process', filter);
      git('-C', linked, 'config', 'filter.fixture.required', 'true');
      const indexOid = git('-C', linked, 'rev-parse', ':fixture.txt');
      assert.deepEqual(readGitContentOids(linked, ['fixture.txt']), [indexOid]);
      assert.equal(existsSync(marker), false, 'The normalized hash path must suppress both external drivers.');
      const ordinaryHash = spawnSync('git', ['-C', linked, 'hash-object', '--stdin-paths'],
        { input: '"fixture.txt"\n', encoding: 'utf8', timeout: 15000 });
      assert.equal(existsSync(marker), true, 'The ordinary hash control must exercise its actual configured driver. ' + ordinaryHash.stderr);
      renameSync(marker, join(setup.home, 'retained-hash-filter-control'));
      const context = (stage) => { try { return readPlanningWorktreeContext(linked, [], ['fixture.txt'], base); }
        catch (error) { error.message = stage + ': ' + error.code + ': ' + error.message; throw error; } };
      const crlf = context('fresh CRLF');
      assert.equal(crlf.initialClean, true); assert.deepEqual(crlf.changedPaths, []);
      writeFileSync(join(linked, 'fixture.txt'), 'line one\nline two\n');
      assert.deepEqual(readGitContentOids(linked, ['fixture.txt']), [indexOid]);
      const lfStatus = (await import('./git-observation.mjs')).readGitStatus(linked, { zeroTerminated: true });
      const lf = context('same logical LF bytes; status=' + JSON.stringify(lfStatus.toString('utf8')));
      assert.equal(lf.initialClean, true); assert.deepEqual(lf.changedPaths, []);
      assert.notEqual(lf.worktreeStatusDigest, crlf.worktreeStatusDigest, 'Raw byte identity must survive logical normalization.');
      writeFileSync(join(linked, 'fixture.txt'), 'changed content\r\nline two\r\n');
      assert.throws(() => readPlanningWorktreeContext(linked, [], ['fixture.txt'], base), (error) => error.code === 'BOUNDARY_EDIT_BEFORE_ADMISSION');
      writeFileSync(join(linked, 'fixture.txt'), 'line one\r\nline two\r\n');
      git('-C', linked, 'config', 'core.fileMode', 'true');
      const { chmodSync } = await import('node:fs'); chmodSync(join(linked, 'fixture.txt'), 0o755);
      assert.deepEqual(readGitContentOids(linked, ['fixture.txt']), [indexOid], 'Mode edits need not change blob content.');
      assert.throws(() => readPlanningWorktreeContext(linked, [], ['fixture.txt'], base), (error) => error.code === 'BOUNDARY_EDIT_BEFORE_ADMISSION');
      chmodSync(join(linked, 'fixture.txt'), 0o644);
      const paths = ['white space.txt', 'quote"file.txt', 'Café-😀.txt', 'back\\slash.txt', '--flag-is-data'];
      const contents = 'literal path data\n';
      for (const path of paths) writeFileSync(join(linked, path), contents);
      const expected = paths.map((path) => git('-C', linked, 'hash-object', '--no-filters', '--', path));
      assert.deepEqual(readGitContentOids(linked, paths), expected);
      assert.throws(() => readGitContentOids(linked, ['../outside']), (error) => error.code === 'GIT_OBSERVATION_FAILED');
      assert.throws(() => readGitContentOids(linked, ['.git/config']), (error) => error.code === 'GIT_OBSERVATION_FAILED');
      symlinkSync(join(root, 'fixture.txt'), join(linked, 'alias'));
      assert.throws(() => readGitContentOids(linked, ['alias']), (error) => error.code === 'GIT_OBSERVATION_FAILED');
      assert.equal(existsSync(marker), false);
    });
    await check('planning content fingerprints bind already-dirty bytes, index state and ignored proposed files without filters', async () => {
      const { readPlanningWorktreeContext } = await import('./scheduler-planning-context.mjs');
      const setup = fixture(); const root = setup.repository.coordinatorRoot;
      writeFileSync(join(root, 'fixture.txt'), 'baseline\n');
      writeFileSync(join(root, '.gitattributes'), 'fixture.txt filter=fixture\n');
      writeFileSync(join(root, '.gitignore'), 'ignored.txt\ncache/\n');
      git('-C', root, 'add', 'fixture.txt', '.gitattributes', '.gitignore');
      git('-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture contents');
      const marker = join(setup.home, 'filter-invoked'); const filter = join(setup.home, 'fixture-filter.mjs');
      writeFileSync(filter, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'invoked');\nprocess.stdin.pipe(process.stdout);\n`, { mode: 0o700 });
      git('-C', root, 'config', 'filter.fixture.clean', filter); git('-C', root, 'config', 'filter.fixture.required', 'true');
      assert.equal(readPlanningWorktreeContext(root, ['fixture.txt'], ['fixture.txt', 'ignored.txt']).initialClean, true);
      writeFileSync(join(root, 'fixture.txt'), 'dirty-a\n');
      const first = readPlanningWorktreeContext(root, ['fixture.txt'], ['fixture.txt', 'ignored.txt']);
      writeFileSync(join(root, 'fixture.txt'), 'dirty-b\n');
      const second = readPlanningWorktreeContext(root, ['fixture.txt'], ['fixture.txt', 'ignored.txt']);
      assert.equal(first.headOid, second.headOid); assert.equal(first.treeOid, second.treeOid);
      assert.deepEqual(first.changedPaths, second.changedPaths); assert.deepEqual(second.changedPaths, ['fixture.txt']);
      assert.notEqual(first.worktreeStatusDigest, second.worktreeStatusDigest, 'Dirty status letters cannot stand in for file bytes.');
      git('-C', root, '-c', 'filter.fixture.clean=', '-c', 'filter.fixture.process=', '-c', 'filter.fixture.required=false', 'add', 'fixture.txt');
      const staged = readPlanningWorktreeContext(root, ['fixture.txt'], ['fixture.txt', 'ignored.txt']);
      assert.notEqual(staged.worktreeStatusDigest, second.worktreeStatusDigest, 'Index state must be bound independently of working bytes.');
      writeFileSync(join(root, 'ignored.txt'), 'already edited outside admission\n');
      assert.throws(() => readPlanningWorktreeContext(root, ['fixture.txt'], ['fixture.txt', 'ignored.txt']),
        (error) => error.code === 'BOUNDARY_EDIT_BEFORE_ADMISSION');
      renameSync(join(root, 'ignored.txt'), join(setup.home, 'retained-ignored.txt'));
      writeFileSync(join(root, 'elsewhere.txt'), 'visible outside both scopes\n');
      assert.throws(() => readPlanningWorktreeContext(root, ['fixture.txt'], ['fixture.txt', 'ignored.txt']),
        (error) => error.code === 'BOUNDARY_EDIT_BEFORE_ADMISSION');
      renameSync(join(root, 'elsewhere.txt'), join(setup.home, 'retained-elsewhere.txt'));
      writeFileSync(join(root, 'fixture.txt'), 'baseline\n');
      git('-C', root, '-c', 'filter.fixture.clean=', '-c', 'filter.fixture.process=', '-c', 'filter.fixture.required=false', 'add', 'fixture.txt');
      mkdirSync(join(root, 'cache')); writeFileSync(join(root, 'cache', 'generated.txt'), 'ignored output\n');
      const ignoredOnly = readPlanningWorktreeContext(root, ['fixture.txt'], ['fixture.txt', 'ignored.txt']);
      assert.deepEqual(ignoredOnly.changedPaths, []); assert.equal(ignoredOnly.initialClean, false);
      assert.equal(existsSync(marker), false, 'Context reads must not run Git filters.');
    });
    await check('selection validators use exact versioned schemas and bind source IDs and body evidence', async () => {
      const schema = await import('./scheduler-selection-schema.mjs');
      const setup = fixture(); const data = await selectionFixture(setup);
      for (const [validate, value] of [[schema.validateSelectionSources, data.evidence.sources], [schema.validateSelectionSnapshot, data.evidence],
        [schema.validateSnapshotReference, data.reference], [schema.validateIssueAuthorization, data.authorization],
        [schema.validateReservation, data.reservation], [schema.validateSelectionUnit, data.unit]]) {
        assert.deepEqual(validate(value), []);
        assert.notDeepEqual(validate({ ...value, unexpected: true }), []);
        assert.notDeepEqual(validate({ ...value, schema: 'future/2' }), []);
      }
      assert.deepEqual(schema.validateIssueAuthorizationEvidence(data.authorization, data.evidence), []);
      const changed = structuredClone(data.evidence); changed.sources.approvals[0].eventId = null;
      assert.notDeepEqual(schema.validateIssueAuthorizationEvidence(data.authorization, changed), []);
      const edited = structuredClone(data.authorization); edited.subject.issueBodyDigest = schedulerDigest('different body');
      edited.authorizationDigest = schedulerDigest(edited.subject);
      assert.notDeepEqual(schema.validateIssueAuthorizationEvidence(edited, data.evidence), []);
      assert.notDeepEqual(schema.validateReservation({ ...data.reservation, slot: 3 }), []);
      assert.notDeepEqual(schema.validateSelectionUnit({ ...data.unit, admission: {} }), []);
      assert.notDeepEqual(schema.validateSelectionSources({ ...data.evidence.sources, waitIssues: { items: [], complete: false, error: null } }), []);
      const plan = { planGeneration: 1, planDigest: schedulerDigest({ body: 'Fixture plan.', boundary: ['src/a.mjs'], baseOid: data.evidence.baseOid }),
        baseOid: data.evidence.baseOid, boundary: ['src/a.mjs'] };
      const admission = { schema: 'autoloop.admission/1', runId: data.unit.runId, unitId: data.unit.unitId, unitGeneration: 1,
        ...plan, reservationRevision: 3 };
      const wait = { schema: 'autoloop.selection-wait/1', code: 'ISSUE_WAIT', unitId: data.unit.unitId, conflicts: [{ type: 'issue', id: 8, paths: [] }],
        condition: { all: [{ on: 'issue', number: 8 }] }, requestedPlan: plan, snapshot: data.reference, createdRevision: 3 };
      const creator = { process: readProcessIdentity(), pgid: process.pid, groupLeader: readProcessIdentity() };
      const branch = `feat/gh-7-unit-${data.unit.unitId.replaceAll('-', '')}-g1`;
      const allocation = { intent: { operationId: randomUUID(), runId: data.unit.runId, unitId: data.unit.unitId, unitGeneration: 1,
        repositoryKey: data.unit.repositoryKey, root: join(setup.home, 'workspace'), branch, baseOid: plan.baseOid }, creator, creatorHistory: [] };
      const worktree = { root: allocation.intent.root, gitDir: join(setup.repository.commonDir, 'worktrees', 'fixture'),
        commonDir: setup.repository.commonDir, repositoryKey: data.unit.repositoryKey, branch, baseOid: plan.baseOid,
        createdByRun: data.unit.runId, unitId: data.unit.unitId, unitGeneration: 1 };
      for (const [validate, value] of [[schema.validateSelectionPlan, plan], [schema.validateAdmission, admission],
        [schema.validateSelectionWait, wait], [schema.validateAllocationCreator, creator], [schema.validateAllocation, allocation],
        [schema.validateWorktreeBinding, worktree]]) {
        assert.deepEqual(validate(value), []); assert.notDeepEqual(validate({ ...value, unexpected: true }), []);
      }
      assert.notDeepEqual(schema.validateSelectionPlan({ ...plan, boundary: ['../escape'] }), []);
      assert.notDeepEqual(schema.validateAdmission({ ...admission, boundary: ['src/*.mjs'] }), []);
      assert.notDeepEqual(schema.validateAllocation({ ...allocation, creator: { ...creator, pgid: 1 } }), []);
      const activeHistory = { attempt: 1, creator };
      Object.defineProperty(activeHistory, 'receipt', { enumerable: true, get() { throw new Error('History accessors must not run.'); } });
      assert.notDeepEqual(schema.validateAllocation({ ...allocation, creatorHistory: [activeHistory] }), []);
      assert.notDeepEqual(schema.validateSelectionWait({ ...wait, condition: { any: [{ on: 'issue', number: 8 }] } }), []);
      const missingRepository = { ...data.evidence.sources, repository: null };
      assert.deepEqual(schema.validateSelectionSources(missingRepository), []);
      const missingIds = structuredClone(data.evidence.sources); missingIds.repository.nodeId = null;
      missingIds.approvals[0].eventId = null; missingIds.approvals[0].actorLogin = null; missingIds.approvals[0].createdAt = null;
      missingIds.roles[0].userId = null; assert.deepEqual(schema.validateSelectionSources(missingIds), []);
      assert.notDeepEqual(schema.validateIssueAuthorization({ ...data.authorization, subject: { ...data.authorization.subject,
        approval: { ...data.authorization.subject.approval, actorUserId: '101' } } }), []);
    });
    await check('selection context and immutable evidence use the owning lease and computed checkout paths', async () => {
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup);
      const context = readSchedulerContext(acquired.lease);
      assert.deepEqual(Object.keys(context).sort(), ['checkpoint', 'pins', 'repository']);
      assert.equal(context.checkpoint.revision, 2); assert.equal(context.pins.configDigest, data.evidence.configDigest);
      context.checkpoint.state = 'failed'; assert.equal(readSchedulerContext(acquired.lease).checkpoint.state, 'running');
      assert.deepEqual(resolveRepositoryCheckout(setup.repository.coordinatorRoot), {
        root: setup.repository.coordinatorRoot, gitDir: setup.repository.commonDir, commonDir: setup.repository.commonDir,
        repositoryKey: setup.repository.repositoryKey });
      const reference = publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      assert.deepEqual(reference, data.reference);
      assert.deepEqual(publishSelectionSnapshot(acquired.lease, 2, data.evidence), reference);
      assert.deepEqual(readSelectionSnapshot(acquired.lease, reference), data.evidence);
      const stored = join(data.evidence.gitDir, 'autoloop', 'scheduler', 'snapshots', setup.pins.runId, 'sha256', `${reference.contentDigest}.json`);
      assert.equal(lstatSync(stored).mode & 0o777, 0o600); assert.equal(lstatSync(dirname(stored)).mode & 0o777, 0o700);
      refuses('LEASE_INVALID', () => publishSelectionSnapshot({}, 2, data.evidence));
      refuses('LEASE_INVALID', () => readSchedulerContext({}));
      refuses('INVALID_INPUT', () => publishSelectionSnapshot(acquired.lease, 2, { ...data.evidence, output: join(setup.home, 'arbitrary.json') }));
      refuses('EVIDENCE_INVALID', () => readSelectionSnapshot(acquired.lease, { ...reference, baseOid: '1'.repeat(40) }));
      const saved = readFileSync(stored, 'utf8'); writeFileSync(stored, JSON.stringify({ ...data.evidence, headOid: '1'.repeat(40) }));
      refuses('EVIDENCE_INVALID', () => readSelectionSnapshot(acquired.lease, reference)); writeFileSync(stored, saved);
      commitTransition(acquired.lease, 2, (value) => value);
      refuses('REVISION_MISMATCH', () => readSelectionSnapshot(acquired.lease, reference));
      assert.deepEqual(readSelectionSnapshot(acquired.lease, reference, { current: false }), data.evidence);
      refuses('REVISION_MISMATCH', () => publishSelectionSnapshot(acquired.lease, 2, data.evidence));
      commitTransition(acquired.lease, 3, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
      refuses('LEASE_INVALID', () => readSelectionSnapshot(acquired.lease, reference, { current: false }));
    });
    await check('immutable evidence retries flush a prior publication before acknowledgment', async () => {
      const setup = fixture(); const operations = []; let failPublication = true;
      const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator, { observe: (phase, path) => {
        if (!path.includes('/snapshots/')) return;
        operations.push([phase, path]);
        if (phase === 'published' && failPublication) { failPublication = false; throw Object.assign(new Error('fixture evidence flush interruption'), { code: 'EIO' }); }
      } });
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup);
      refuses('STATE_IO_FAILED', () => publishSelectionSnapshot(acquired.lease, 2, data.evidence));
      const before = operations.length;
      assert.deepEqual(publishSelectionSnapshot(acquired.lease, 2, data.evidence), data.reference);
      assert(operations.slice(before).some(([phase]) => phase === 'directory-flushed'), 'Retry must flush the immutable publication before acknowledgment.');
      commitTransition(acquired.lease, 2, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('current selection evidence refuses changed origin, config, local head and configured base', async () => {
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup); const reference = publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      git('-C', setup.repository.coordinatorRoot, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git');
      refuses('EVIDENCE_CHANGED', () => readSelectionSnapshot(acquired.lease, reference));
      git('-C', setup.repository.coordinatorRoot, 'remote', 'set-url', 'origin', 'https://github.com/example/scheduler-fixture.git');
      const configPath = join(setup.repository.coordinatorRoot, '.autoloop', 'config.json');
      writeFileSync(configPath, JSON.stringify({ ...setup.pins.config, baseBranch: 'different' }));
      refuses('PINS_CHANGED', () => readSelectionSnapshot(acquired.lease, reference));
      writeFileSync(configPath, JSON.stringify(setup.pins.config));
      git('-C', setup.repository.coordinatorRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'later');
      refuses('EVIDENCE_CHANGED', () => readSelectionSnapshot(acquired.lease, reference));
      const later = git('-C', setup.repository.coordinatorRoot, 'rev-parse', 'HEAD');
      git('-C', setup.repository.coordinatorRoot, 'update-ref', 'refs/remotes/origin/main', later);
      const moved = { ...data.evidence, headOid: later };
      refuses('INVALID_INPUT', () => publishSelectionSnapshot(acquired.lease, 2, moved));
      assert.deepEqual(readSelectionSnapshot(acquired.lease, reference, { current: false }), data.evidence);
      commitTransition(acquired.lease, 2, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('selection records reject changed checked repositories and mixed upstream pairs in one common directory', async () => {
      const { createSnapshot } = await import('./snapshot-contract.mjs');
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup); publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      const persisted = commitTransition(acquired.lease, 2, (value) => ({ ...value, units: [data.unit], reservations: [data.reservation] }));
      const repositoryB = { host: 'github.com', owner: 'other-example', name: 'other-fixture', nodeId: 'R_other_fixture' };
      for (const [key, replacement] of [['host', 'git.example.invalid'], ['owner', 'other-example'], ['name', 'other-fixture'], ['nodeId', 'R_other_fixture']]) {
        const changedReference = { ...data.reference, repository: { ...data.reference.repository, [key]: replacement } };
        assert.notDeepEqual(validateCheckpoint({ ...persisted, units: [{ ...data.unit, checkedSnapshot: changedReference }] }), []);
      }
      const wrongChecked = { ...data.reference, repository: repositoryB };
      assert.notDeepEqual(validateCheckpoint({ ...persisted, units: [{ ...data.unit, checkedSnapshot: wrongChecked }] }), []);
      refuses('STATE_INVALID', () => commitTransition(acquired.lease, 3, (value) => ({ ...value,
        units: value.units.map((unit) => ({ ...unit, checkedSnapshot: wrongChecked })) })));
      const sections = structuredClone(data.evidence.snapshot.sections);
      sections.repo.items[0] = { owner: repositoryB.owner, name: repositoryB.name, nameWithOwner: 'other-example/other-fixture', defaultBranch: 'main' };
      sections.queue.items[0].number = 8; sections.openIssues.items[0].number = 8;
      sections.authorVerification.items[0].evidence[0].issueNumber = 8;
      const sources = structuredClone(data.evidence.sources); sources.repository = repositoryB;
      sources.issues[0] = { number: 8, nodeId: 'I_other_fixture' };
      sources.approvals[0] = { ...sources.approvals[0], issue: 8, issueNodeId: 'I_other_fixture', approvalIssue: 8,
        approvalIssueNodeId: 'I_other_fixture', eventId: 'E_other_fixture' };
      const evidenceB = { ...data.evidence, repository: repositoryB, checkpointRevision: 3, sources,
        snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:01.000Z', sections }) };
      git('-C', setup.repository.coordinatorRoot, 'remote', 'set-url', 'origin', 'https://github.com/other-example/other-fixture.git');
      const referenceB = publishSelectionSnapshot(acquired.lease, 3, evidenceB);
      const subjectB = { ...data.authorization.subject, repository: repositoryB, issue: 8, issueNodeId: 'I_other_fixture',
        approval: { ...data.authorization.subject.approval, issue: 8, issueNodeId: 'I_other_fixture', eventId: 'E_other_fixture' } };
      const authorizationB = { ...data.authorization, subject: subjectB, authorizationDigest: schedulerDigest(subjectB), snapshot: referenceB,
        evidenceDigest: schedulerDigest({ queue: sections.queue.items[0], openIssue: sections.openIssues.items[0], role: sections.authorVerification.items[0],
          issueSource: sources.issues[0], approvalSource: sources.approvals[0], roleSource: sources.roles[0] }) };
      const unitB = { ...data.unit, unitId: randomUUID(), checkedSnapshot: referenceB };
      const reservationB = { ...data.reservation, unitId: unitB.unitId, issue: 8, issueAuthorization: authorizationB, slot: 2, createdRevision: 4 };
      const mixed = { ...persisted, revision: 4, units: [data.unit, unitB], reservations: [data.reservation, reservationB] };
      assert.notDeepEqual(validateCheckpoint(mixed), []);
      refuses('STATE_INVALID', () => commitTransition(acquired.lease, 3, (value) => ({ ...value,
        units: [...value.units, unitB], reservations: [...value.reservations, reservationB] })));
      commitTransition(acquired.lease, 3, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('canonical origin and API case agree without changing original authorization subjects', async () => {
      const { createSnapshot } = await import('./snapshot-contract.mjs');
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup); publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      const locator = 'git@GITHUB.COM:Example/SCHEDULER-fixture.git';
      git('-C', setup.repository.coordinatorRoot, 'remote', 'set-url', 'origin', locator);
      const repository = { ...data.evidence.repository, owner: 'EXAMPLE', name: 'Scheduler-Fixture' };
      const sections = structuredClone(data.evidence.snapshot.sections);
      sections.repo.items[0] = { owner: repository.owner, name: repository.name, nameWithOwner: 'EXAMPLE/Scheduler-Fixture', defaultBranch: 'main' };
      const evidence = { ...data.evidence, repository, sources: { ...data.evidence.sources, repository },
        snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:01.000Z', sections }) };
      const reference = publishSelectionSnapshot(acquired.lease, 2, evidence);
      assert.deepEqual(readSelectionSnapshot(acquired.lease, reference), evidence);
      git('-C', setup.repository.coordinatorRoot, 'config', '--add', 'remote.origin.url', locator);
      refuses('EVIDENCE_CHANGED', () => readSelectionSnapshot(acquired.lease, reference));
      git('-C', setup.repository.coordinatorRoot, 'config', '--replace-all', 'remote.origin.url', 'https://github.com:8443/example/scheduler-fixture.git');
      refuses('EVIDENCE_CHANGED', () => readSelectionSnapshot(acquired.lease, reference));
      git('-C', setup.repository.coordinatorRoot, 'config', '--replace-all', 'remote.origin.url', locator);
      const reserved = commitTransition(acquired.lease, 2, (value) => ({ ...value,
        units: [{ ...data.unit, checkedSnapshot: reference }], reservations: [data.reservation] }));
      assert.deepEqual(reserved.reservations[0].issueAuthorization.subject, data.authorization.subject);
      assert.equal(reserved.units[0].checkedSnapshot.repository.nodeId, data.authorization.subject.repository.nodeId);
      commitTransition(acquired.lease, 3, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('selection pairs persist in checkpoint v1 and cannot erase or replace retained identities', async () => {
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup); publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      const persisted = commitTransition(acquired.lease, 2, (value) => ({ ...value, units: [data.unit], reservations: [data.reservation] }));
      assert.deepEqual(validateCheckpoint(persisted), []); assert.equal(persisted.schema, CHECKPOINT_SCHEMA);
      assert.equal(hasRetainedSelection(persisted), true); assert.equal(persisted.queueEnabled, false);
      for (const mutate of [
        (value) => ({ ...value, units: [], reservations: [] }),
        (value) => ({ ...value, reservations: value.reservations.map((item) => ({ ...item, createdRevision: 1 })) }),
        (value) => ({ ...value, reservations: value.reservations.map((item) => ({ ...item, slot: 2 })) }),
        (value) => ({ ...value, reservations: value.reservations.map((item) => ({ ...item, issueAuthorization: {
          ...item.issueAuthorization, evidenceDigest: '0'.repeat(64) } })) }),
        (value) => ({ ...value, reservations: value.reservations.map((item) => ({ ...item, state: 'released' })) }),
      ]) refuses('STATE_INVALID', () => commitTransition(acquired.lease, 3, mutate));
      const duplicate = structuredClone(data.reservation); duplicate.unitId = randomUUID(); duplicate.slot = 2;
      const duplicateUnit = { ...data.unit, unitId: duplicate.unitId };
      assert.notDeepEqual(validateCheckpoint({ ...persisted, units: [...persisted.units, duplicateUnit], reservations: [...persisted.reservations, duplicate] }), []);
      const invalidWorker = { schema: 'autoloop.worker-binding/1', runId: persisted.runId, generation: 1, unitId: data.unit.unitId, unitGeneration: 2,
        attemptId: randomUUID(), sessionId: randomUUID(), worktreeGitDir: setup.repository.commonDir, process: setup.initiator.process,
        pgid: setup.initiator.process.pid, groupLeader: setup.initiator.process, role: 'plan', posture: 'plan', actualModel: 'fixture',
        liveFile: join(setup.home, 'fixture.jsonl'), cancelledByOperator: false };
      assert.notDeepEqual(validateCheckpoint({ ...persisted, workers: [invalidWorker] }), []);
      commitTransition(acquired.lease, 3, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
      refuses('SCHEDULER_ACTIVE', () => assertNoSchedulerOwner(setup.repository));
      const nextPins = createPins(setup.repository, { pluginRoot: setup.pins.pluginRoot, enginePath: setup.pins.enginePath,
        config: setup.pins.config, models: setup.pins.models });
      refuses('RUN_MISMATCH', () => acquireScheduler(setup.repository, nextPins, setup.initiator));
      const recovered = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      assert.equal(readSchedulerContext(recovered.lease).checkpoint.state, 'recovering');
      refuses('RECOVERY_REQUIRED', () => commitTransition(recovered.lease, readSchedulerContext(recovered.lease).checkpoint.revision,
        (value) => ({ ...value, state: 'running' })));
      const checkpoint = readSchedulerContext(recovered.lease).checkpoint;
      commitTransition(recovered.lease, checkpoint.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(recovered.lease);
    });
    await check('immutable original approval survives a fresh role read but not revocation, editing or changed source identity', async () => {
      const { createSnapshot } = await import('./snapshot-contract.mjs');
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup); publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      const proposed = (reference) => (value) => ({ ...value, units: [{ ...data.unit, checkedSnapshot: reference }], reservations: [data.reservation] });
      for (const change of ['revoked', 'edited', 'event', 'halted']) {
        const sections = structuredClone(data.evidence.snapshot.sections); const sources = structuredClone(data.evidence.sources);
        if (change === 'revoked') { sections.authorVerification.items[0].permission = 'read'; sources.roles[0].permission = 'read'; }
        if (change === 'event') sources.approvals[0].eventId = 'E_different';
        if (change === 'edited') {
          const body = 'Changed public fixture body.'; const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
          for (const name of ['queue', 'openIssues']) Object.assign(sections[name].items[0], { body, bodySha256 });
        }
        if (change === 'halted') sections.openIssues.items[0].labels.push('loop-halt');
        const evidence = { ...data.evidence, sources, snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:01.000Z', sections }) };
        const reference = publishSelectionSnapshot(acquired.lease, 2, evidence);
        refuses('AUTHORIZATION_INVALID', () => commitTransition(acquired.lease, 2, proposed(reference)));
        assert.deepEqual(readSchedulerContext(acquired.lease).checkpoint.units, []);
      }
      const sections = structuredClone(data.evidence.snapshot.sections); const sources = structuredClone(data.evidence.sources);
      sections.authorVerification.items[0].permission = 'admin'; sources.roles[0].permission = 'admin';
      const evidence = { ...data.evidence, sources, snapshot: createSnapshot({ scannedAt: '2026-01-01T00:00:02.000Z', sections }) };
      const fresh = publishSelectionSnapshot(acquired.lease, 2, evidence);
      assert.notEqual(fresh.contentDigest, data.reference.contentDigest);
      const reserved = commitTransition(acquired.lease, 2, proposed(fresh));
      assert.deepEqual(reserved.reservations[0].issueAuthorization, data.authorization);
      assert.deepEqual(reserved.units[0].checkedSnapshot, fresh);
      commitTransition(acquired.lease, 3, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('selection commit rechecks queued controls and nested readback cannot acquire a second writer', async () => {
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup); publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      const actor = { kind: 'terminal', sessionId: null, host: readProcessIdentity(), invocationId: randomUUID() };
      const request = { schema: CONTROL_SCHEMA, requestId: randomUUID(), runId: setup.pins.runId, kind: 'pause',
        target: { type: 'run', generation: 1 }, payload: {}, submittedAt: Date.now() };
      refuses('CONTROL_PENDING', () => commitTransition(acquired.lease, 2, (value) => {
        assert.deepEqual(readSelectionSnapshot(acquired.lease, data.reference), data.evidence);
        refuses('STATE_BUSY', () => publishSelectionSnapshot(acquired.lease, 2, data.evidence));
        refuses('STATE_BUSY', () => commitTransition(acquired.lease, 2, (state) => state));
        submitControl(setup.repository, actor, request);
        return { ...value, units: [data.unit], reservations: [data.reservation] };
      }));
      assert.equal(readSchedulerContext(acquired.lease).checkpoint.revision, 2);
      assert.deepEqual(readSchedulerContext(acquired.lease).checkpoint.reservations, []);
      claimControl(acquired.lease, request.requestId);
      completeControl(acquired.lease, request.requestId, { status: 'applied', code: 'PAUSED', operationId: null },
        (value) => ({ ...value, state: 'paused', desiredState: 'paused' }));
      commitTransition(acquired.lease, 4, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('allocation preparation and settlement reducers bind one immutable outbox intent atomically', async () => {
      const setup = fixture(); const acquired = acquireScheduler(setup.repository, setup.pins, setup.initiator);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'running' }));
      const data = await selectionFixture(setup); publishSelectionSnapshot(acquired.lease, 2, data.evidence);
      commitTransition(acquired.lease, 2, (value) => ({ ...value, units: [data.unit], reservations: [data.reservation] }));
      const freshEvidence = { ...data.evidence, checkpointRevision: 3 };
      const freshReference = publishSelectionSnapshot(acquired.lease, 3, freshEvidence);
      const intent = { operationId: randomUUID(), runId: setup.pins.runId, unitId: data.unit.unitId, unitGeneration: 1,
        repositoryKey: setup.repository.repositoryKey, root: join(dirname(setup.repository.coordinatorRoot), '.autoloop-worktrees',
          setup.repository.repositoryKey, setup.pins.runId, `${data.unit.unitId}-g1`),
        branch: `feat/gh-7-unit-${data.unit.unitId.replaceAll('-', '')}-g1`, baseOid: data.evidence.baseOid };
      const effect = { operationId: intent.operationId, requestId: null, runId: intent.runId, unitId: intent.unitId, unitGeneration: 1,
        kind: 'worktree.create', target: { type: 'external', id: intent.unitId }, inputDigest: schedulerDigest(intent), expectedHead: intent.baseOid,
        phase: 'prepared', attempt: 1, receipt: null, error: null };
      const prepared = prepareEffect(acquired.lease, 3, effect, (value) => ({ ...value,
        units: value.units.map((unit) => ({ ...unit, allocation: { intent, creator: null, creatorHistory: [] }, checkedSnapshot: freshReference })) }));
      assert.deepEqual(prepared.units[0].allocation, { intent, creator: null, creatorHistory: [] });
      assert.deepEqual(prepared.outbox[intent.operationId], effect);
      refuses('STATE_INVALID', () => commitTransition(acquired.lease, prepared.revision, (value) => ({ ...value,
        units: value.units.map((unit) => ({ ...unit, allocation: { ...unit.allocation, intent: { ...intent, root: join(setup.home, 'other') } } })) })));
      markEffectInFlight(acquired.lease, intent.operationId);
      refuses('OWNER_UNVERIFIED', () => settleEffect(acquired.lease, intent.operationId, { attempt: 1, status: 'not-applied', code: 'NOT_APPLIED',
        receipt: { externalId: intent.operationId, observationDigest: schedulerDigest({ absent: true }), observedAt: Date.now() } }));
      const firstCreator = startChild(`process.send({ready:true}); process.on('message', () => process.disconnect());`, [], { detached: true });
      await message(firstCreator);
      const firstIdentity = readProcessIdentity(firstCreator.pid);
      const firstBinding = { process: firstIdentity, pgid: firstCreator.pid, groupLeader: firstIdentity };
      let beforeRetry = readSchedulerContext(acquired.lease).checkpoint;
      commitTransition(acquired.lease, beforeRetry.revision, (value) => ({ ...value,
        units: value.units.map((unit) => ({ ...unit, allocation: { ...unit.allocation, creator: firstBinding } })) }));
      firstCreator.send('exit-without-creation'); await firstCreator.finished;
      assert.equal(boundCreatorState(firstBinding), 'empty'); assert.equal(existsSync(intent.root), false);
      const absentReceipt = { externalId: intent.operationId,
        observationDigest: schedulerDigest({ intent, creator: firstBinding, rootExists: false, branchExists: false, registered: false }), observedAt: Date.now() };
      const retried = settleEffect(acquired.lease, intent.operationId, { attempt: 1, status: 'not-applied', code: 'NOT_APPLIED', receipt: absentReceipt });
      const history = [{ attempt: 1, creator: firstBinding, receipt: absentReceipt }];
      assert.equal(retried.outbox[intent.operationId].attempt, 2);
      assert.equal(retried.units[0].allocation.creator, null, 'A retry must not reuse its prior dead creator.');
      assert.deepEqual(retried.units[0].allocation.creatorHistory, history);
      for (const creatorHistory of [[], [{ ...history[0], receipt: { ...absentReceipt, observationDigest: '0'.repeat(64) } }]]) {
        refuses('STATE_INVALID', () => commitTransition(acquired.lease, retried.revision, (value) => ({ ...value,
          units: value.units.map((unit) => ({ ...unit, allocation: { ...unit.allocation, creatorHistory } })) })));
      }
      markEffectInFlight(acquired.lease, intent.operationId);
      beforeRetry = readSchedulerContext(acquired.lease).checkpoint;
      assert.equal(beforeRetry.outbox[intent.operationId].receipt, null);
      assert.deepEqual(beforeRetry.units[0].allocation.creatorHistory, history);
      refuses('STATE_INVALID', () => commitTransition(acquired.lease, beforeRetry.revision, (value) => ({ ...value,
        units: value.units.map((unit) => ({ ...unit, allocation: { ...unit.allocation,
          creatorHistory: [{ ...history[0], receipt: { ...absentReceipt, observationDigest: '0'.repeat(64) } }] } })) })));
      const creator = startChild(`import { spawnSync } from 'node:child_process';
        process.send({ready:true}); process.on('message', () => { const result = spawnSync('git', ['-C', process.argv[1],
          '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', process.argv[3], process.argv[2], process.argv[4]],
          { encoding: 'utf8', timeout: 15000 }); process.send({status:result.status,stderr:result.stderr}, () => process.disconnect()); });`,
      [setup.repository.coordinatorRoot, intent.root, intent.branch, intent.baseOid], { detached: true });
      await message(creator);
      const identity = readProcessIdentity(creator.pid); const creatorBinding = { process: identity, pgid: creator.pid, groupLeader: identity };
      const current = readSchedulerContext(acquired.lease).checkpoint;
      commitTransition(acquired.lease, current.revision, (value) => ({ ...value,
        units: value.units.map((unit) => ({ ...unit, allocation: { ...unit.allocation, creator: creatorBinding } })) }));
      assert.notEqual(schedulerDigest(creatorBinding.process), schedulerDigest(firstBinding.process));
      refuses('OWNER_UNVERIFIED', () => settleEffect(acquired.lease, intent.operationId, { attempt: 2, status: 'not-applied', code: 'NOT_APPLIED', receipt: absentReceipt }));
      const finished = message(creator); creator.send('create'); assert.equal((await finished).status, 0); await creator.finished;
      assert.equal(boundCreatorState(creatorBinding), 'empty');
      const checkout = resolveRepositoryCheckout(intent.root);
      const worktree = { ...checkout, branch: intent.branch, baseOid: intent.baseOid, createdByRun: intent.runId,
        unitId: intent.unitId, unitGeneration: 1 };
      const receipt = { externalId: intent.operationId, observationDigest: schedulerDigest(worktree), observedAt: Date.now() };
      const settled = settleEffect(acquired.lease, intent.operationId, { attempt: 2, status: 'applied', code: 'READBACK_CONFIRMED', receipt },
        { transition: (value) => ({ ...value, reservations: value.reservations.map((reservation) => ({ ...reservation, worktree })) }) });
      assert.deepEqual(settled.reservations[0].worktree, worktree); assert.equal(settled.outbox[intent.operationId].phase, 'succeeded');
      const monitorMarker = join(setup.home, 'monitor-invoked'); const monitorHook = join(setup.home, 'fixture-monitor.mjs');
      writeFileSync(monitorHook, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(monitorMarker)}, 'invoked');\nprocess.stdout.write('fixture-token\\0');\n`, { mode: 0o700 });
      git('-C', intent.root, 'config', 'core.fsmonitor', monitorHook);
      git('-C', intent.root, 'config', 'core.fsmonitorHookVersion', '2');
      const disposition = observeSelectionNoWork(acquired.lease, intent.unitId);
      assert.equal(existsSync(monitorMarker), false, 'Readback must not execute a configured Git fsmonitor hook.');
      const released = commitTransition(acquired.lease, settled.revision, (value) => ({ ...value,
        reservations: value.reservations.map((reservation) => ({ ...reservation, state: 'released', paths: [] })),
        units: value.units.map((unit) => ({ ...unit, admission: null, wait: null, disposition })) }));
      assert.equal(hasRetainedSelection(released), false); assert.equal(existsSync(intent.root), true);
      commitTransition(acquired.lease, released.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
      assert.doesNotThrow(() => assertNoSchedulerOwner(setup.repository));
    });
    await check('the short shared admission ledger uses only the private OS-account runtime', () => {
      const { repository, state } = fixture();
      assert.equal(withExecutionAdmission(repository, () => 'held'), 'held');
      const directory = admissionOf(repository);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(directory, '1.json')).mode & 0o777, 0o600);
      assert.equal(existsSync(join(directory, '1.released.json')), true);
      assert.equal(existsSync(state), false, 'Legacy admission must not create scheduler storage.');
    });
    await check('protected established authority is durable before the first daemon lease', () => {
      const { repository, pins, initiator, state } = fixture(); const operations = [];
      const acquired = acquireScheduler(repository, pins, initiator, { observe: (phase, path) => operations.push([phase, path]) });
      const markerPath = join(admissionOf(repository), 'daemon-authority.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(marker.schema, 'autoloop.scheduler-authority/1'); assert.equal(marker.repositoryKey, repository.repositoryKey);
      assert.equal(marker.commonDir, repository.commonDir); assert.equal(marker.runId, pins.runId);
      assert.equal(marker.leaseId, JSON.parse(readFileSync(join(state, 'lock', '1.json'), 'utf8')).leaseId);
      const flushed = operations.findIndex(([phase, path]) => phase === 'directory-flushed' && path === markerPath);
      const leasePublished = operations.findIndex(([phase, path]) => phase === 'published' && path === join(state, 'lock', '1.json'));
      assert(flushed >= 0 && leasePublished > flushed, 'Protected authority must be durable before a daemon lease.');
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('authority marker publication failure stops acquisition before daemon authority', () => {
      const { repository, pins, initiator, state } = fixture();
      refuses('STATE_IO_FAILED', () => acquireScheduler(repository, pins, initiator, { observe: (phase, path) => {
        if (phase === 'temporary-flushed' && path.endsWith('/daemon-authority.json')) throw Object.assign(new Error('authority marker write failed'), { code: 'EIO' });
      } }));
      assert.equal(existsSync(join(state, 'lock', '1.json')), false); assert.equal(existsSync(join(state, 'current.json')), false);
      assert.equal(existsSync(join(admissionOf(repository), 'daemon-authority.json')), false);
    });
    await check('marked missing or corrupt Git authority cannot become never-started state', () => {
      const { repository, pins, initiator, state, home } = fixture(); const acquired = acquireScheduler(repository, pins, initiator);
      assert.equal(existsSync(join(admissionOf(repository), 'daemon-authority.json')), true);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
      const saved = join(home, 'retained-scheduler'); renameSync(state, saved);
      try {
        refuses('RECOVERY_REQUIRED', () => readCurrentCheckpoint(repository));
        refuses('RECOVERY_REQUIRED', () => readSchedulerOwner(repository));
        refuses('RECOVERY_REQUIRED', () => assertNoSchedulerOwner(repository));
        const externalPath = join(home, 'unexpected-external-effect');
        refuses('RECOVERY_REQUIRED', () => withExecutionAdmission(repository, () => writeFileSync(externalPath, 'applied')));
        assert.equal(existsSync(externalPath), false);
        refuses('RECOVERY_REQUIRED', () => acquireScheduler(repository, { ...pins, runId: randomUUID() }, initiator));
      } finally { renameSync(saved, state); }
      const checkpointPath = join(state, 'runs', pins.runId, 'checkpoint.json'); const checkpoint = readFileSync(checkpointPath, 'utf8');
      writeFileSync(checkpointPath, '{corrupt');
      try { refuses('STATE_INVALID', () => readCurrentCheckpoint(repository)); refuses('STATE_INVALID', () => assertNoSchedulerOwner(repository)); }
      finally { writeFileSync(checkpointPath, checkpoint); }
    });
    await check('a crash after protected marker durability and before lease publication retains recovery refusal', async () => {
      const { repository, pins, initiator, state } = fixture();
      const owner = startChild(`const api = await import(process.argv[1]); const repo = api.resolveRepository(process.argv[2]);
        api.acquireScheduler(repo, JSON.parse(process.argv[3]), { kind: 'terminal', sessionId: null, process: api.readProcessIdentity() },
          { observe: (phase, path) => { if (phase === 'directory-flushed' && path.endsWith('/daemon-authority.json')) process.kill(process.pid, 'SIGKILL'); } });`,
      [moduleUrl, repository.coordinatorRoot, JSON.stringify(pins)]);
      assert.equal((await owner.finished).signal, 'SIGKILL');
      assert.equal(existsSync(join(admissionOf(repository), 'daemon-authority.json')), true);
      assert.equal(existsSync(join(state, 'lock', '1.json')), false);
      refuses('RECOVERY_REQUIRED', () => readCurrentCheckpoint(repository));
      refuses('RECOVERY_REQUIRED', () => acquireScheduler(repository, pins, initiator));
    });
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
    await check('shared Git-admin ancestors refuse other-account write permission without changing legacy modes', async () => {
      const { chmodSync } = await import('node:fs');
      for (const component of ['git', 'autoloop']) for (const mode of [0o775, 0o777]) {
        const { repository, pins, initiator, state } = fixture();
        const path = component === 'git' ? repository.commonDir : join(repository.commonDir, 'autoloop');
        if (component === 'autoloop') mkdirSync(path, { mode: 0o755 });
        chmodSync(path, mode);
        refuses('STATE_INVALID', () => acquireScheduler(repository, pins, initiator));
        assert.equal(lstatSync(path).mode & 0o777, mode);
        assert.equal(existsSync(state), false);
      }
      const { repository, pins, initiator } = fixture(); const legacy = join(repository.commonDir, 'autoloop');
      mkdirSync(legacy, { mode: 0o755 }); chmodSync(legacy, 0o755);
      const acquired = acquireScheduler(repository, pins, initiator);
      assert.equal(lstatSync(legacy).mode & 0o777, 0o755);
      commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
    });
    await check('private scheduler namespaces refuse loose existing directories', async () => {
      const { chmodSync } = await import('node:fs');
      for (const component of ['scheduler', 'admission', 'lock', 'runs', 'run', 'streams']) {
        const { repository, pins, initiator, state } = fixture(); const acquired = acquireScheduler(repository, pins, initiator);
        commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'failed' })); releaseScheduler(acquired.lease);
        const path = component === 'admission' ? admissionOf(repository) : component === 'scheduler' ? state : component === 'run' ? join(state, 'runs', pins.runId)
          : component === 'streams' ? join(state, 'runs', pins.runId, 'streams') : join(state, component);
        chmodSync(path, 0o755);
        refuses('STATE_INVALID', () => acquireScheduler(repository, pins, initiator));
        assert.equal(lstatSync(path).mode & 0o777, 0o755);
      }
    });
    await check('authoritative records refuse nonprivate permissions without rewriting content', async () => {
      const { chmodSync } = await import('node:fs');
      for (const component of ['authority', 'current.json', 'lease', 'pins.json', 'checkpoint.json']) for (const mode of [0o644, 0o666]) {
        const { repository, pins, initiator, state } = fixture(); const acquired = acquireScheduler(repository, pins, initiator);
        const path = component === 'authority' ? join(admissionOf(repository), 'daemon-authority.json')
          : component === 'current.json' ? join(state, component) : component === 'lease' ? join(state, 'lock', '1.json')
          : join(state, 'runs', pins.runId, component);
        const content = readFileSync(path, 'utf8'); chmodSync(path, mode);
        refuses('STATE_INVALID', () => readCurrentCheckpoint(repository));
        assert.equal(readFileSync(path, 'utf8'), content); assert.equal(lstatSync(path).mode & 0o777, mode);
        chmodSync(path, 0o600);
        commitTransition(acquired.lease, 1, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(acquired.lease);
      }
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
    await check('unsafe control ancestors and request records cannot become durable claims', async () => {
      const { chmodSync } = await import('node:fs');
      for (const component of ['control', 'v2', 'requests', 'request', 'pending', 'processing']) {
        const { repository, pins, initiator } = fixture(); const acquired = acquireScheduler(repository, pins, initiator);
        const control = request(pins.runId); submitControl(repository, actor(), control);
        const root = join(repository.commonDir, 'autoloop', 'control');
        const path = component === 'control' ? root : component === 'v2' ? join(root, 'v2')
          : component === 'request' ? join(root, 'v2', 'requests', `${control.requestId}.json`) : join(root, 'v2', component);
        const mode = component === 'request' ? 0o666 : 0o777; chmodSync(path, mode);
        refuses('STATE_INVALID', () => claimControl(acquired.lease, control.requestId));
        assert.equal(lstatSync(path).mode & 0o777, mode);
        assert.deepEqual(readCheckpoint(repository, pins.runId).requests, {});
        chmodSync(path, component === 'request' ? 0o600 : 0o700); finish(repository, acquired);
      }
    });
    await check('foreign ownership on directory and record descriptors refuses state admission and claims', async () => {
      const fs = (await import('node:fs')).default; const { syncBuiltinESMExports } = await import('node:module');
      for (const component of ['shared', 'directory', 'record']) {
        const { repository, pins, initiator, state } = fixture(); const acquired = acquireScheduler(repository, pins, initiator);
        const control = request(pins.runId); submitControl(repository, actor(), control);
        const path = component === 'shared' ? join(repository.commonDir, 'autoloop') : component === 'directory' ? join(state, 'lock')
          : join(repository.commonDir, 'autoloop', 'control', 'v2', 'requests', `${control.requestId}.json`);
        const target = lstatSync(path); const original = fs.fstatSync;
        try {
          // External OS ownership fault; all paths and file operations stay real.
          fs.fstatSync = (...args) => {
            const stat = original(...args); if (stat.dev === target.dev && stat.ino === target.ino) stat.uid += 1; return stat;
          };
          syncBuiltinESMExports();
          refuses('STATE_INVALID', () => claimControl(acquired.lease, control.requestId));
        } finally { fs.fstatSync = original; syncBuiltinESMExports(); }
        assert.deepEqual(readCheckpoint(repository, pins.runId).requests, {}); finish(repository, acquired);
      }
    });
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
    try {
      await Promise.all([...children].map((child) => endChild(child, 'SIGKILL')));
      rmSync(scratch, { recursive: true, force: true });
    } finally {
      fixtureAccount.restore();
    }
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
