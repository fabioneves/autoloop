#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  INTENT_PROVENANCE,
  RELAUNCH_PROMPT,
  finish,
  fixtureQueueEvidence,
  open,
  transitionContinuationLease,
} from './runtime-contract.mjs';
import {
  issueHostEvidence,
  snapshotExecutionCheckout,
} from './route-adapter-contract.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_REQUEST_AGE_MS = 5 * 60 * 1000;
const HASH_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const STATE_FILE_RE =
  /^state-(\d{3})-(issued|claimed|session-created|opened|prompted)\.json$/;
const OWNER_FILE_RE = /^owner-(\d{3})\.json$/;
const REQUEST_KEYS = [
  'action',
  'continuationState',
  'envelope',
  'lease',
  'prompt',
  'reason',
];
const CHECKOUT_KEYS = [
  'repositoryFingerprint',
  'branch',
  'headOid',
  'clean',
];
const POINTER_KEYS = ['version', 'leaseFingerprint', 'pointerNonce'];
const OWNER_KEYS = [
  'version',
  'leaseFingerprint',
  'revision',
  'ownerId',
  'acquiredAtMs',
  'previousOwnerFingerprint',
  'claimFingerprint',
  'fingerprint',
];
const SESSION_KEYS = [
  'version',
  'activeHost',
  'integration',
  'sessionId',
  'sessionFingerprint',
];
const RELAUNCH_EFFECTS = [
  'session-create',
  'context-inject',
  'prompt',
];
const EFFECT_KEYS = [
  'version',
  'leaseFingerprint',
  'claimFingerprint',
  'expectedStatus',
  'effect',
  'subjectFingerprint',
  'issuedByOwnerFingerprint',
  'effectNonce',
  'fingerprint',
];
const LOCK_KEYS = [
  'version',
  'leaseFingerprint',
  'pid',
  'processIdentity',
  'nonce',
];
const LOCK_REF = 'refs/autoloop/continuation-operation-lock';
const ZERO_OID = '0'.repeat(40);
const RUN_SCOPE_ENTRYPOINT = realpathSync(
  fileURLToPath(new URL('./run-scope.mjs', import.meta.url)),
);
const RUN_SCOPE_EXECUTABLE = realpathSync(process.execPath);
const CONTINUATION_SELF_TEST_MODE = (() => {
  try {
    return process.argv.length === 3
      && process.argv[2] === '--self-test'
      && realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional = []) {
  return isPlainObject(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function hashValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function textFingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprinted(value) {
  return { ...value, fingerprint: hashValue(value) };
}

function runScopeBrokerOperation(flag, input, invoke = spawnSync) {
  const result = invoke(
    RUN_SCOPE_EXECUTABLE,
    [RUN_SCOPE_ENTRYPOINT, flag, '-'],
    {
      input: `${JSON.stringify(input)}\n`,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: MAX_INPUT_BYTES,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          key !== 'NODE_OPTIONS'
          && !key.startsWith('AUTOLOOP_AUTHORITY_')),
      ),
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  const output = String(result.stdout ?? '');
  if (
    Buffer.byteLength(output) > MAX_INPUT_BYTES
    || output.trimEnd().split('\n').length !== 1
  ) {
    throw new Error('authority broker returned an invalid response');
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('authority broker returned invalid JSON');
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || typeof parsed.ok !== 'boolean'
  ) {
    throw new Error('authority broker returned an invalid result');
  }
  return parsed;
}

function productionContinuationTransition(
  input,
  invoke = runScopeBrokerOperation,
) {
  return invoke('--transition-continuation-json', input);
}

function productionContinuationHistory(
  input,
  invoke = runScopeBrokerOperation,
) {
  return invoke('--validate-continuation-history-json', input);
}

function productionContinuationPromptPreparation(
  input,
  invoke = runScopeBrokerOperation,
) {
  return invoke('--prepare-continuation-prompt-json', input);
}

function boundedJson(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const bytes = readFileSync(descriptor);
    if (bytes.length > MAX_INPUT_BYTES) throw new Error('input exceeds 1 MiB');
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function exclusiveJson(path, value) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(resolve(path, '..'));
    return { ok: true };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    return { ok: false, error: error.message };
  }
}

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return `${pid}:${tail[19]}`;
  } catch {
    try {
      return `${pid}:${execFileSync(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        },
      ).trim()}`;
    } catch {
      return null;
    }
  }
}

function validLock(lock) {
  return exactKeys(lock, LOCK_KEYS)
    && lock.version === 1
    && HASH_RE.test(lock.leaseFingerprint)
    && Number.isSafeInteger(lock.pid)
    && lock.pid > 0
    && (
      lock.processIdentity === null
      || (
        typeof lock.processIdentity === 'string'
        && lock.processIdentity.length > 0
        && lock.processIdentity.length <= 255
      )
    )
    && SAFE_SESSION.test(lock.nonce);
}

function lockProcessActive(lock) {
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    return error?.code === 'EPERM';
  }
  const observed = processIdentity(lock.pid);
  return lock.processIdentity === null
    || observed === null
    || observed === lock.processIdentity;
}

function lockGitDirectory(directory) {
  return resolve(directory, '..', '..', '..');
}

function lockGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function lockGit(directory, args, input) {
  return spawnSync('git', [
    '--no-replace-objects',
    `--git-dir=${lockGitDirectory(directory)}`,
    '-c',
    'core.hooksPath=/dev/null',
    ...args,
  ], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: MAX_INPUT_BYTES,
    env: lockGitEnvironment(),
  });
}

function writeLockBlob(directory, lock) {
  const result = lockGit(
    directory,
    ['hash-object', '-w', '--stdin'],
    `${JSON.stringify(lock)}\n`,
  );
  const oid = String(result.stdout ?? '').trim();
  if (result.status !== 0 || result.error || !OID_RE.test(oid)) {
    throw new Error('continuation lock blob could not be written');
  }
  return oid;
}

function currentLockOid(directory) {
  const symbolic = lockGit(
    directory,
    ['symbolic-ref', '--quiet', LOCK_REF],
  );
  if (symbolic.status === 0 && !symbolic.error) {
    throw new Error('continuation lock ref must not be symbolic');
  }
  if (![1].includes(symbolic.status) || symbolic.error) {
    throw new Error('continuation lock ref type could not be read');
  }
  const result = lockGit(
    directory,
    ['rev-parse', '--verify', '--quiet', LOCK_REF],
  );
  if (result.status === 1 && !result.error) return null;
  const oid = String(result.stdout ?? '').trim();
  if (result.status !== 0 || result.error || !OID_RE.test(oid)) {
    throw new Error('continuation lock ref could not be read');
  }
  return oid;
}

function readLockBlob(directory, oid) {
  if (!OID_RE.test(oid)) throw new Error('continuation lock OID is invalid');
  const result = lockGit(directory, ['cat-file', 'blob', oid]);
  if (result.status !== 0 || result.error) {
    throw new Error('continuation lock blob could not be read');
  }
  let lock;
  try {
    lock = JSON.parse(String(result.stdout ?? ''));
  } catch {
    throw new Error('continuation lock blob is not JSON');
  }
  if (!validLock(lock)) throw new Error('continuation lock is invalid');
  return lock;
}

function updateLockRef(directory, nextOid, expectedOid) {
  const result = lockGit(directory, [
    'update-ref',
    '--no-deref',
    LOCK_REF,
    nextOid,
    expectedOid ?? ZERO_OID,
  ]);
  return result.status === 0 && !result.error;
}

function deleteLockRef(directory, expectedOid) {
  const result = lockGit(directory, [
    'update-ref',
    '--no-deref',
    '-d',
    LOCK_REF,
    expectedOid,
  ]);
  return result.status === 0 && !result.error;
}

function makeLeaseLock(directory) {
  return {
    version: 1,
    leaseFingerprint: basename(directory),
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    nonce: randomUUID(),
  };
}

function acquireLeaseLock(directory) {
  const lock = makeLeaseLock(directory);
  if (!validLock(lock)) throw new Error('continuation lock scope is invalid');
  const oid = writeLockBlob(directory, lock);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const previousOid = currentLockOid(directory);
    if (previousOid !== null) {
      const previous = readLockBlob(directory, previousOid);
      if (lockProcessActive(previous)) {
        throw new Error('continuation operation is already active');
      }
    }
    if (updateLockRef(directory, oid, previousOid)) {
      return { oid, lock };
    }
  }
  throw new Error('continuation lock acquisition did not converge');
}

function releaseLeaseLock(acquired, directory) {
  if (!deleteLockRef(directory, acquired.oid)) {
    throw new Error('continuation lock ownership changed before release');
  }
}

function withLeaseLock(directory, operation) {
  let acquired;
  try {
    acquired = acquireLeaseLock(directory);
  } catch (error) {
    return {
      ok: false,
      error: `continuation operation lock failed: ${error.message}`,
    };
  }
  try {
    return operation();
  } finally {
    releaseLeaseLock(acquired, directory);
  }
}

function validScope(scope) {
  return exactKeys(scope, ['scope', 'autoContinue'])
    && scope.scope === 'queue'
    && scope.autoContinue === true;
}

function validEnvelope(envelope) {
  return exactKeys(
    envelope,
    ['v', 'originHost', 'selector', 'scope', 'generation', 'runIntentHash'],
  )
    && envelope.v === 2
    && ['claude', 'codex', 'opencode'].includes(envelope.originHost)
    && ['native', 'claude', 'codex', 'opencode'].includes(envelope.selector)
    && validScope(envelope.scope)
    && Number.isSafeInteger(envelope.generation)
    && envelope.generation >= 1
    && envelope.generation <= 25
    && HASH_RE.test(envelope.runIntentHash);
}

export function validateRelaunchRequest(value) {
  if (
    !exactKeys(value, REQUEST_KEYS)
    || value.action !== 'relaunch'
    || value.reason !== 'context-budget'
    || value.prompt !== RELAUNCH_PROMPT
    || !validEnvelope(value.envelope)
    || !HASH_RE.test(value.lease?.fingerprint ?? '')
    || value.lease.envelopeFingerprint !== hashValue(value.envelope)
    || value.lease.repositoryFingerprint === undefined
    || value.lease.expectedBaseBranch === undefined
    || value.lease.expectedHeadOid === undefined
  ) {
    return {
      ok: false,
      error: 'request is not an exact RuntimeContract relaunch result',
    };
  }
  let issued;
  try {
    issued = CONTINUATION_SELF_TEST_MODE
      ? transitionContinuationLease({
        lease: value.lease,
        state: value.continuationState,
        nextStatus: 'issued',
      })
      : productionContinuationHistory({
        lease: value.lease,
        states: [value.continuationState],
      });
  } catch (error) {
    return {
      ok: false,
      error: `continuation authority is unavailable: ${error.message}`,
    };
  }
  if (!issued.ok) {
    return {
      ok: false,
      error: `continuation lease is invalid: ${issued.error.code}`,
    };
  }
  return { ok: true };
}

function leaseDirectory(markerDirectory, leaseFingerprint) {
  if (!HASH_RE.test(leaseFingerprint)) {
    throw new Error('lease fingerprint is invalid');
  }
  return join(markerDirectory, 'continuations', leaseFingerprint);
}

function pointerPath(markerDirectory) {
  return join(markerDirectory, 'relaunch-request');
}

function statePath(directory, state) {
  return join(
    directory,
    `state-${String(state.revision).padStart(3, '0')}-${state.status}.json`,
  );
}

function currentState(directory, request) {
  const files = readdirSync(directory)
    .map((name) => ({ name, match: name.match(STATE_FILE_RE) }))
    .filter(({ match }) => match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  if (files.length === 0) throw new Error('continuation has no durable state');
  let previous = request.continuationState;
  const states = files.map(({ name }) => boundedJson(join(directory, name)));
  if (
    files[0].name !== 'state-000-issued.json'
    || hashValue(states[0]) !== hashValue(previous)
  ) {
    throw new Error('issued continuation state is corrupt');
  }
  for (let index = 1; index < files.length; index += 1) {
    const { name, match } = files[index];
    if (Number(match[1]) !== index) {
      throw new Error('continuation state history has a revision gap');
    }
    const state = states[index];
    if (state.status !== match[2]) {
      throw new Error('continuation state history is corrupt');
    }
    if (CONTINUATION_SELF_TEST_MODE) {
      const advanced = transitionContinuationLease({
        lease: request.lease,
        state: previous,
        nextStatus: match[2],
        claimFingerprint: state.claimFingerprint,
        sessionFingerprint: state.sessionFingerprint,
      });
      if (
        !advanced.ok
        || advanced.value.state.fingerprint !== state.fingerprint
      ) {
        throw new Error('continuation state history is corrupt');
      }
    }
    previous = state;
  }
  if (!CONTINUATION_SELF_TEST_MODE) {
    const validated = productionContinuationHistory({
      lease: request.lease,
      states,
    });
    if (
      !validated.ok
      || validated.value.stateFingerprint !== previous.fingerprint
    ) {
      throw new Error('continuation state history is corrupt');
    }
  }
  return previous;
}

function ownerPath(directory, revision) {
  return join(directory, `owner-${String(revision).padStart(3, '0')}.json`);
}

function validOwner(owner, request, previous) {
  if (
    !exactKeys(owner, OWNER_KEYS)
    || owner.version !== 1
    || owner.leaseFingerprint !== request.lease.fingerprint
    || !Number.isSafeInteger(owner.revision)
    || owner.revision < 0
    || !SAFE_SESSION.test(owner.ownerId)
    || !Number.isFinite(owner.acquiredAtMs)
    || !HASH_RE.test(owner.claimFingerprint)
    || !HASH_RE.test(owner.fingerprint)
  ) {
    return false;
  }
  const unsigned = { ...owner };
  delete unsigned.fingerprint;
  return owner.fingerprint === hashValue(unsigned)
    && (
      previous === null
        ? (
          owner.revision === 0
          && owner.previousOwnerFingerprint === null
        )
        : (
          owner.revision === previous.revision + 1
          && owner.previousOwnerFingerprint === previous.fingerprint
        )
    );
}

function currentOwner(directory, request) {
  const files = readdirSync(directory)
    .map((name) => ({ name, match: name.match(OWNER_FILE_RE) }))
    .filter(({ match }) => match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  let previous = null;
  for (let index = 0; index < files.length; index += 1) {
    const { name, match } = files[index];
    if (Number(match[1]) !== index) {
      throw new Error('continuation owner history has a revision gap');
    }
    const owner = boundedJson(join(directory, name));
    if (!validOwner(owner, request, previous)) {
      throw new Error('continuation owner history is corrupt');
    }
    previous = owner;
  }
  return previous;
}

function acquireOwner(directory, request, state, ownerId, nowMs, maxAgeMs) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const previous = currentOwner(directory, request);
    if (previous?.ownerId === ownerId) {
      return { ok: true, value: previous };
    }
    if (
      previous !== null
      && (
        !Number.isFinite(nowMs - previous.acquiredAtMs)
        || nowMs - previous.acquiredAtMs < 0
        || nowMs - previous.acquiredAtMs <= maxAgeMs
      )
    ) {
      return {
        ok: false,
        error: 'relaunch request is claimed by another live handler',
      };
    }
    const revision = previous === null ? 0 : previous.revision + 1;
    const claimFingerprint = state.status === 'issued'
      ? hashValue({
        kind: 'autoloop-continuation-claim-owner',
        leaseFingerprint: request.lease.fingerprint,
        ownerId,
        revision,
        nonce: randomUUID(),
      })
      : state.claimFingerprint;
    const owner = fingerprinted({
      version: 1,
      leaseFingerprint: request.lease.fingerprint,
      revision,
      ownerId,
      acquiredAtMs: nowMs,
      previousOwnerFingerprint: previous?.fingerprint ?? null,
      claimFingerprint,
    });
    const written = exclusiveJson(ownerPath(directory, revision), owner);
    if (written.ok) return { ok: true, value: owner };
  }
  return {
    ok: false,
    error: 'another handler won the continuation owner CAS',
  };
}

function renewedOwner(owner, nowMs = Date.now()) {
  return fingerprinted({
    version: 1,
    leaseFingerprint: owner.leaseFingerprint,
    revision: owner.revision + 1,
    ownerId: owner.ownerId,
    acquiredAtMs: nowMs,
    previousOwnerFingerprint: owner.fingerprint,
    claimFingerprint: owner.claimFingerprint,
  });
}

function readPointer(markerDirectory) {
  const pointer = boundedJson(pointerPath(markerDirectory));
  if (
    !exactKeys(pointer, POINTER_KEYS)
    || pointer.version !== 1
    || !HASH_RE.test(pointer.leaseFingerprint)
    || !SAFE_SESSION.test(pointer.pointerNonce)
  ) {
    throw new Error('relaunch pointer is invalid');
  }
  return pointer;
}

function readRequest(markerDirectory, leaseFingerprint) {
  const directory = leaseDirectory(markerDirectory, leaseFingerprint);
  assertDirectory(directory);
  const request = boundedJson(join(directory, 'request.json'));
  const validation = validateRelaunchRequest(request);
  if (!validation.ok || request.lease.fingerprint !== leaseFingerprint) {
    throw new Error(validation.error ?? 'request lease does not match its path');
  }
  return { directory, request, state: currentState(directory, request) };
}

function assertDirectory(path) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('continuation path is not a real directory');
  }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertDirectory(path);
}

function ensurePointer(markerDirectory, leaseFingerprint) {
  const path = pointerPath(markerDirectory);
  if (existsSync(path)) {
    const current = readPointer(markerDirectory);
    return current.leaseFingerprint === leaseFingerprint
      ? { ok: true }
      : { ok: false, error: 'another relaunch request is already active' };
  }
  return exclusiveJson(path, {
    version: 1,
    leaseFingerprint,
    pointerNonce: randomUUID(),
  });
}

function clearPointerIfCurrent(markerDirectory, leaseFingerprint) {
  const path = pointerPath(markerDirectory);
  if (!existsSync(path)) return false;
  const pointer = readPointer(markerDirectory);
  if (pointer.leaseFingerprint !== leaseFingerprint) return false;
  const cleanupPath = join(
    markerDirectory,
    `relaunch-request-clear-${pointer.pointerNonce}.json`,
  );
  const cleanupIntent = {
    version: 1,
    leaseFingerprint,
    pointerNonce: pointer.pointerNonce,
  };
  if (existsSync(cleanupPath)) {
    if (hashValue(boundedJson(cleanupPath)) !== hashValue(cleanupIntent)) {
      return false;
    }
  } else {
    const cleanup = exclusiveJson(cleanupPath, cleanupIntent);
    if (!cleanup.ok) {
      if (
        !existsSync(cleanupPath)
        || hashValue(boundedJson(cleanupPath)) !== hashValue(cleanupIntent)
      ) {
        return false;
      }
    }
  }
  const current = readPointer(markerDirectory);
  if (
    current.leaseFingerprint !== leaseFingerprint
    || current.pointerNonce !== pointer.pointerNonce
  ) {
    return false;
  }
  unlinkSync(path);
  syncDirectory(markerDirectory);
  return true;
}

export function issueRelaunchRequestAt(request, markerDirectory) {
  const validation = validateRelaunchRequest(request);
  if (!validation.ok) return validation;
  try {
    ensureDirectory(markerDirectory);
    const continuations = join(markerDirectory, 'continuations');
    ensureDirectory(continuations);
    const directory = leaseDirectory(
      markerDirectory,
      request.lease.fingerprint,
    );
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      syncDirectory(continuations);
    }
    assertDirectory(directory);
    const requestPath = join(directory, 'request.json');
    if (existsSync(requestPath)) {
      if (hashValue(boundedJson(requestPath)) !== hashValue(request)) {
        return { ok: false, error: 'lease directory contains another request' };
      }
    } else {
      const written = exclusiveJson(requestPath, request);
      if (!written.ok) {
        return {
          ok: false,
          error: `request persistence failed: ${written.error}`,
        };
      }
    }
    const issuedPath = statePath(directory, request.continuationState);
    if (!existsSync(issuedPath)) {
      const written = exclusiveJson(issuedPath, request.continuationState);
      if (!written.ok) {
        return {
          ok: false,
          error: `issued state persistence failed: ${written.error}`,
        };
      }
    }
    const state = currentState(directory, request);
    if (state.status === 'prompted') {
      return {
        ok: true,
        value: { directory, request, state, terminal: true },
      };
    }
    const pointer = ensurePointer(
      markerDirectory,
      request.lease.fingerprint,
    );
    return pointer.ok
      ? { ok: true, value: { directory, request, state, terminal: false } }
      : pointer;
  } catch (error) {
    return { ok: false, error: `request persistence failed: ${error.message}` };
  }
}

function validCheckout(checkout) {
  return exactKeys(checkout, CHECKOUT_KEYS)
    && HASH_RE.test(checkout.repositoryFingerprint)
    && typeof checkout.branch === 'string'
    && checkout.branch.length > 0
    && checkout.branch.length <= 255
    && OID_RE.test(checkout.headOid)
    && typeof checkout.clean === 'boolean';
}

function checkoutMatches(checkout, lease) {
  return validCheckout(checkout)
    && checkout.repositoryFingerprint === lease.repositoryFingerprint
    && checkout.branch === lease.expectedBaseBranch
    && checkout.headOid === lease.expectedHeadOid
    && checkout.clean === true;
}

function persistTransition(directory, request, state, input) {
  const transition = {
    lease: request.lease,
    state,
    ...input,
  };
  const advanced = CONTINUATION_SELF_TEST_MODE
    ? transitionContinuationLease(transition)
    : productionContinuationTransition(transition);
  if (!advanced.ok) {
    return {
      ok: false,
      error: `continuation CAS failed: ${advanced.error.message}`,
    };
  }
  if (advanced.value.state.fingerprint === state.fingerprint) {
    return { ok: true, value: { ...advanced.value, created: false } };
  }
  const written = exclusiveJson(
    statePath(directory, advanced.value.state),
    advanced.value.state,
  );
  if (!written.ok) {
    try {
      const latest = currentState(directory, request);
      if (latest.fingerprint === advanced.value.state.fingerprint) {
        return { ok: true, value: { ...advanced.value, created: false } };
      }
    } catch {
      // Return the original atomic-create failure below.
    }
    return {
      ok: false,
      error: `continuation CAS persistence failed: ${written.error}`,
    };
  }
  return { ok: true, value: { ...advanced.value, created: true } };
}

export function claimRelaunchRequestAt(
  markerDirectory,
  checkout,
  options = {},
) {
  try {
    if (
      !exactKeys(options, ['ownerId'], ['nowMs', 'maxAgeMs'])
      || (
        options.nowMs !== undefined
        && !Number.isFinite(options.nowMs)
      )
      || (
        options.maxAgeMs !== undefined
        && (
          !Number.isFinite(options.maxAgeMs)
          || options.maxAgeMs < 0
        )
      )
    ) {
      return { ok: false, error: 'claim options have an invalid shape' };
    }
    const {
      nowMs = Date.now(),
      maxAgeMs = MAX_REQUEST_AGE_MS,
      ownerId,
    } = options;
    if (!SAFE_SESSION.test(ownerId ?? '')) {
      return { ok: false, error: 'claim requires a bounded owner id' };
    }
    const pointer = readPointer(markerDirectory);
    const directory = leaseDirectory(
      markerDirectory,
      pointer.leaseFingerprint,
    );
    return withLeaseLock(directory, () => {
    const loaded = readRequest(markerDirectory, pointer.leaseFingerprint);
    if (!checkoutMatches(checkout, loaded.request.lease)) {
      return {
        ok: false,
        error: 'checkout does not match the lease repository, base, HEAD, or clean state',
      };
    }
    const ownership = acquireOwner(
      loaded.directory,
      loaded.request,
      loaded.state,
      ownerId,
      nowMs,
      maxAgeMs,
    );
    if (!ownership.ok) return ownership;
    const owner = ownership.value;
    const age = nowMs - lstatSync(join(loaded.directory, 'request.json')).mtimeMs;
    if (
      loaded.state.status === 'issued'
      && (!Number.isFinite(age) || age < 0 || age > maxAgeMs)
    ) {
      clearPointerIfCurrent(
        markerDirectory,
        loaded.request.lease.fingerprint,
      );
      return {
        ok: false,
        error: 'unclaimed relaunch request is stale; active pointer cleared',
      };
    }
    if (loaded.state.status === 'prompted') {
      clearPointerIfCurrent(
        markerDirectory,
        loaded.request.lease.fingerprint,
      );
      return { ok: false, error: 'relaunch request is already prompted' };
    }
    if (loaded.state.status !== 'issued') {
      if (loaded.state.claimFingerprint !== owner.claimFingerprint) {
        return {
          ok: false,
          error: 'active owner does not match the durable continuation claim',
        };
      }
      return {
        ok: true,
        value: {
          ...loaded,
          ownerFingerprint: owner.fingerprint,
          ...(['session-created', 'opened'].includes(loaded.state.status)
            ? { session: readSession(loaded.directory) }
            : {}),
        },
      };
    }
    const claimed = persistTransition(
      loaded.directory,
      loaded.request,
      loaded.state,
      {
        nextStatus: 'claimed',
        claimFingerprint: owner.claimFingerprint,
      },
    );
    return claimed.ok
      ? {
        ok: true,
        value: {
          ...loaded,
          state: claimed.value.state,
          ownerFingerprint: owner.fingerprint,
        },
      }
      : claimed;
    });
  } catch (error) {
    return { ok: false, error: `request claim failed: ${error.message}` };
  }
}

export function renewRelaunchOwnerAt(
  markerDirectory,
  input,
  checkout,
) {
  if (
    !exactKeys(input, ['leaseFingerprint', 'ownerFingerprint'])
    || !HASH_RE.test(input.leaseFingerprint)
    || !HASH_RE.test(input.ownerFingerprint)
  ) {
    return { ok: false, error: 'owner renewal input has an invalid shape' };
  }
  try {
    const directory = leaseDirectory(
      markerDirectory,
      input.leaseFingerprint,
    );
    return withLeaseLock(directory, () => {
      const loaded = readRequest(markerDirectory, input.leaseFingerprint);
      if (!checkoutMatches(checkout, loaded.request.lease)) {
        return {
          ok: false,
          error: 'checkout changed before owner renewal',
        };
      }
      const owner = currentOwner(directory, loaded.request);
      if (owner?.fingerprint !== input.ownerFingerprint) {
        return {
          ok: false,
          error: 'owner renewal does not hold the active lease',
        };
      }
      const renewed = renewedOwner(owner);
      const written = exclusiveJson(
        ownerPath(directory, renewed.revision),
        renewed,
      );
      return written.ok
        ? {
          ok: true,
          value: {
            ownerFingerprint: renewed.fingerprint,
            state: loaded.state,
            ...(['session-created', 'opened'].includes(loaded.state.status)
              ? { session: readSession(directory) }
              : {}),
          },
        }
        : {
          ok: false,
          error: `owner renewal persistence failed: ${written.error}`,
        };
    });
  } catch (error) {
    return {
      ok: false,
      error: `owner renewal failed: ${error.message}`,
    };
  }
}

function sessionFingerprint(activeHost, integration, sessionId) {
  return hashValue({ activeHost, integration, sessionId });
}

function effectPath(directory, effect) {
  return join(directory, `effect-${effect}.json`);
}

function validEffect(effect, request) {
  if (
    !exactKeys(effect, EFFECT_KEYS)
    || effect.version !== 1
    || effect.leaseFingerprint !== request.lease.fingerprint
    || !HASH_RE.test(effect.claimFingerprint)
    || !['claimed', 'opened'].includes(effect.expectedStatus)
    || !RELAUNCH_EFFECTS.includes(effect.effect)
    || !HASH_RE.test(effect.subjectFingerprint)
    || !HASH_RE.test(effect.issuedByOwnerFingerprint)
    || !SAFE_SESSION.test(effect.effectNonce)
    || !HASH_RE.test(effect.fingerprint)
  ) {
    return false;
  }
  const unsigned = { ...effect };
  delete unsigned.fingerprint;
  return effect.fingerprint === hashValue(unsigned)
    && (
      effect.effect === 'session-create'
        ? effect.expectedStatus === 'claimed'
          && effect.subjectFingerprint === textFingerprint(
            `autoloop relaunch ${effect.leaseFingerprint.slice(0, 16)}`,
          )
        : effect.expectedStatus === 'opened'
    )
    && (
      effect.effect !== 'prompt'
      || effect.subjectFingerprint === textFingerprint(request.prompt)
    );
}

function readEffect(directory, request, effect) {
  const value = boundedJson(effectPath(directory, effect));
  if (!validEffect(value, request) || value.effect !== effect) {
    throw new Error(`continuation ${effect} intent is invalid`);
  }
  return value;
}

export function issueRelaunchEffectAt(
  markerDirectory,
  input,
  checkout,
) {
  if (
    !exactKeys(input, [
      'leaseFingerprint',
      'claimFingerprint',
      'ownerFingerprint',
      'expectedStatus',
      'effect',
      'subjectFingerprint',
    ])
    || !HASH_RE.test(input.leaseFingerprint)
    || !HASH_RE.test(input.claimFingerprint)
    || !HASH_RE.test(input.ownerFingerprint)
    || !['claimed', 'opened'].includes(input.expectedStatus)
    || !RELAUNCH_EFFECTS.includes(input.effect)
    || !HASH_RE.test(input.subjectFingerprint)
    || (
      input.effect === 'session-create'
        ? input.expectedStatus !== 'claimed'
        : input.expectedStatus !== 'opened'
    )
  ) {
    return { ok: false, error: 'effect intent input has an invalid shape' };
  }
  try {
    const directory = leaseDirectory(
      markerDirectory,
      input.leaseFingerprint,
    );
    return withLeaseLock(directory, () => {
      const loaded = readRequest(markerDirectory, input.leaseFingerprint);
      const owner = currentOwner(directory, loaded.request);
      if (
        owner?.fingerprint !== input.ownerFingerprint
        || owner.claimFingerprint !== input.claimFingerprint
      ) {
        return {
          ok: false,
          error: 'effect intent does not hold the active continuation owner',
        };
      }
      if (!checkoutMatches(checkout, loaded.request.lease)) {
        return {
          ok: false,
          error: 'checkout changed before provider effect intent',
        };
      }
      if (
        loaded.state.status !== input.expectedStatus
        || loaded.state.claimFingerprint !== input.claimFingerprint
      ) {
        return {
          ok: false,
          error:
            `effect intent expected ${input.expectedStatus}, ` +
            `found ${loaded.state.status}`,
        };
      }
      const path = effectPath(directory, input.effect);
      if (existsSync(path)) {
        const existing = readEffect(
          directory,
          loaded.request,
          input.effect,
        );
        return existing.claimFingerprint === input.claimFingerprint
          && existing.expectedStatus === input.expectedStatus
          && existing.subjectFingerprint === input.subjectFingerprint
          ? {
            ok: true,
            value: {
              effect: existing,
              created: false,
              ownerFingerprint: owner.fingerprint,
            },
          }
          : {
            ok: false,
            error: 'provider effect intent conflicts with durable history',
          };
      }
      const effect = fingerprinted({
        version: 1,
        leaseFingerprint: input.leaseFingerprint,
        claimFingerprint: input.claimFingerprint,
        expectedStatus: input.expectedStatus,
        effect: input.effect,
        subjectFingerprint: input.subjectFingerprint,
        issuedByOwnerFingerprint: owner.fingerprint,
        effectNonce: randomUUID(),
      });
      if (!validEffect(effect, loaded.request)) {
        return {
          ok: false,
          error: 'provider effect intent violates the exact effect contract',
        };
      }
      const written = exclusiveJson(path, effect);
      return written.ok
        ? {
          ok: true,
          value: {
            effect,
            created: true,
            ownerFingerprint: owner.fingerprint,
          },
        }
        : {
          ok: false,
          error: `provider effect intent persistence failed: ${written.error}`,
        };
    });
  } catch (error) {
    return {
      ok: false,
      error: `provider effect intent failed: ${error.message}`,
    };
  }
}

function readSession(directory) {
  const session = boundedJson(join(directory, 'session.json'));
  if (
    !exactKeys(session, SESSION_KEYS)
    || session.version !== 1
    || !['claude', 'codex', 'opencode'].includes(session.activeHost)
    || !SAFE_IDENTITY.test(session.integration)
    || !SAFE_SESSION.test(session.sessionId)
    || !HASH_RE.test(session.sessionFingerprint)
    || session.sessionFingerprint !==
      sessionFingerprint(
        session.activeHost,
        session.integration,
        session.sessionId,
      )
  ) {
    throw new Error('continuation session binding is invalid');
  }
  return session;
}

function ensureSession(directory, activeHost, integration, sessionId) {
  const value = {
    version: 1,
    activeHost,
    integration,
    sessionId,
    sessionFingerprint: sessionFingerprint(activeHost, integration, sessionId),
  };
  const path = join(directory, 'session.json');
  if (existsSync(path)) {
    const existing = readSession(directory);
    if (hashValue(existing) !== hashValue(value)) {
      throw new Error('continuation is already bound to another session');
    }
    return existing;
  }
  const written = exclusiveJson(path, value);
  if (!written.ok) {
    throw new Error(`session binding failed: ${written.error}`);
  }
  return value;
}

function continuationBundle(request, state, authorization) {
  return {
    continuation: request.envelope,
    continuationLease: request.lease,
    continuationState: state,
    continuationAuthorization: authorization,
  };
}

function selfTestContinuationPromptPreparation(input) {
  const opened = transitionContinuationLease({
    lease: input.lease,
    state: input.state,
    nextStatus: 'opened',
  });
  if (
    !opened.ok
    || hashValue(opened.value.authorization) !== hashValue(input.authorization)
  ) {
    return { ok: false, error: { message: 'authorization is invalid' } };
  }
  return {
    ok: true,
    value: {
      leaseFingerprint: input.lease.fingerprint,
      stateFingerprint: input.state.fingerprint,
      effectFingerprint: input.effect.fingerprint,
      targetSessionFingerprint: input.session.sessionFingerprint,
      prepared: true,
    },
  };
}

export function prepareRelaunchPromptAt(
  markerDirectory,
  input,
  checkout,
) {
  if (
    !exactKeys(input, [
      'leaseFingerprint',
      'claimFingerprint',
      'ownerFingerprint',
      'continuation',
    ])
    || !HASH_RE.test(input.leaseFingerprint)
    || !HASH_RE.test(input.claimFingerprint)
    || !HASH_RE.test(input.ownerFingerprint)
    || !exactKeys(input.continuation, [
      'continuation',
      'continuationLease',
      'continuationState',
      'continuationAuthorization',
    ])
  ) {
    return { ok: false, error: 'prompt preparation input has an invalid shape' };
  }
  try {
    const directory = leaseDirectory(
      markerDirectory,
      input.leaseFingerprint,
    );
    return withLeaseLock(directory, () => {
      const loaded = readRequest(markerDirectory, input.leaseFingerprint);
      const owner = currentOwner(directory, loaded.request);
      if (
        owner?.fingerprint !== input.ownerFingerprint
        || owner.claimFingerprint !== input.claimFingerprint
      ) {
        return {
          ok: false,
          error: 'prompt preparation does not hold the active continuation owner',
        };
      }
      if (!checkoutMatches(checkout, loaded.request.lease)) {
        return {
          ok: false,
          error: 'checkout changed before prompt preparation',
        };
      }
      if (
        loaded.state.status !== 'opened'
        || loaded.state.claimFingerprint !== input.claimFingerprint
      ) {
        return {
          ok: false,
          error: 'prompt preparation requires the exact opened continuation',
        };
      }
      const effect = readEffect(directory, loaded.request, 'prompt');
      const session = readSession(directory);
      const continuation = input.continuation;
      if (
        effect.claimFingerprint !== input.claimFingerprint
        || hashValue(continuation.continuation)
          !== hashValue(loaded.request.envelope)
        || hashValue(continuation.continuationLease)
          !== hashValue(loaded.request.lease)
        || hashValue(continuation.continuationState)
          !== hashValue(loaded.state)
        || continuation.continuationState.sessionFingerprint
          !== session.sessionFingerprint
      ) {
        return {
          ok: false,
          error: 'prompt preparation does not match durable continuation history',
        };
      }
      const operation = {
        lease: continuation.continuationLease,
        state: continuation.continuationState,
        authorization: continuation.continuationAuthorization,
        effect,
        session,
      };
      const prepared = CONTINUATION_SELF_TEST_MODE
        ? selfTestContinuationPromptPreparation(operation)
        : productionContinuationPromptPreparation(operation);
      if (
        !prepared.ok
        || prepared.value?.leaseFingerprint
          !== loaded.request.lease.fingerprint
        || prepared.value?.stateFingerprint !== loaded.state.fingerprint
        || prepared.value?.effectFingerprint !== effect.fingerprint
        || prepared.value?.targetSessionFingerprint
          !== session.sessionFingerprint
        || prepared.value?.prepared !== true
      ) {
        return {
          ok: false,
          error: prepared.ok
            ? 'prompt preparation returned mismatched authority'
            : `prompt preparation failed: ${prepared.error.message}`,
        };
      }
      return {
        ok: true,
        value: {
          ...prepared.value,
          effect,
          session,
        },
      };
    });
  } catch (error) {
    return {
      ok: false,
      error: `prompt preparation failed: ${error.message}`,
    };
  }
}

export function transitionRelaunchRequestAt(
  markerDirectory,
  input,
  checkout,
) {
  if (
    !exactKeys(
      input,
      [
        'leaseFingerprint',
        'claimFingerprint',
        'ownerFingerprint',
        'expectedStatus',
        'nextStatus',
      ],
      ['activeHost', 'integration', 'sessionId'],
    )
    || !HASH_RE.test(input.leaseFingerprint)
    || !HASH_RE.test(input.claimFingerprint)
    || !HASH_RE.test(input.ownerFingerprint)
    || (
      input.nextStatus === 'session-created'
        ? !['activeHost', 'integration', 'sessionId'].every((key) =>
          Object.hasOwn(input, key))
        : ['activeHost', 'integration', 'sessionId'].some((key) =>
          Object.hasOwn(input, key))
    )
  ) {
    return { ok: false, error: 'transition input has an invalid shape' };
  }
  try {
    const directory = leaseDirectory(
      markerDirectory,
      input.leaseFingerprint,
    );
    return withLeaseLock(directory, () => {
    const loaded = readRequest(markerDirectory, input.leaseFingerprint);
    const owner = currentOwner(loaded.directory, loaded.request);
    if (
      owner === null
      || owner.fingerprint !== input.ownerFingerprint
      || owner.claimFingerprint !== input.claimFingerprint
    ) {
      return {
        ok: false,
        error: 'transition does not hold the active continuation owner lease',
      };
    }
    if (!checkoutMatches(checkout, loaded.request.lease)) {
      return {
        ok: false,
        error: 'checkout changed after claim; continuation side effect refused',
      };
    }
    if (loaded.state.claimFingerprint !== input.claimFingerprint) {
      return {
        ok: false,
        error: 'transition does not own the continuation claim',
      };
    }
    if (
      loaded.state.status !== input.expectedStatus
      && loaded.state.status !== input.nextStatus
    ) {
      return {
        ok: false,
        error:
          `continuation CAS expected ${input.expectedStatus}, ` +
          `found ${loaded.state.status}`,
      };
    }
    let session = null;
    if (input.nextStatus === 'session-created') {
      if (
        !['claude', 'codex', 'opencode'].includes(input.activeHost)
        || !SAFE_IDENTITY.test(input.integration ?? '')
        || !SAFE_SESSION.test(input.sessionId ?? '')
      ) {
        return {
          ok: false,
          error: 'session-created requires a bounded integration and session id',
        };
      }
      const intent = readEffect(
        loaded.directory,
        loaded.request,
        'session-create',
      );
      if (intent.claimFingerprint !== input.claimFingerprint) {
        return {
          ok: false,
          error: 'session creation does not match its one-shot effect intent',
        };
      }
      session = ensureSession(
        loaded.directory,
        input.activeHost,
        input.integration,
        input.sessionId,
      );
    } else if (
      ['session-created', 'opened', 'prompted'].includes(loaded.state.status)
      || ['opened', 'prompted'].includes(input.nextStatus)
    ) {
      session = readSession(loaded.directory);
    }
    if (input.nextStatus === 'prompted') {
      for (const effect of ['context-inject', 'prompt']) {
        const intent = readEffect(
          loaded.directory,
          loaded.request,
          effect,
        );
        if (intent.claimFingerprint !== input.claimFingerprint) {
          return {
            ok: false,
            error: `${effect} does not match its one-shot effect intent`,
          };
        }
      }
    }
    const transitioned = persistTransition(
      loaded.directory,
      loaded.request,
      loaded.state,
      {
        nextStatus: input.nextStatus,
        claimFingerprint: input.claimFingerprint,
        sessionFingerprint: session?.sessionFingerprint,
      },
    );
    if (!transitioned.ok) return transitioned;
    const state = transitioned.value.state;
    if (state.status === 'prompted' && transitioned.value.created) {
      clearPointerIfCurrent(markerDirectory, input.leaseFingerprint);
    }
    return {
      ok: true,
      value: {
        request: loaded.request,
        state,
        session,
        ownerFingerprint: owner.fingerprint,
        ...(state.status === 'opened'
          ? {
            continuation: continuationBundle(
              loaded.request,
              state,
              transitioned.value.authorization,
            ),
          }
          : {}),
      },
    };
    });
  } catch (error) {
    return { ok: false, error: `continuation transition failed: ${error.message}` };
  }
}

function gitOutput(cwd, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return execFileSync('git', [
    '--no-replace-objects',
    '--no-optional-locks',
    '-C',
    cwd,
    '-c',
    'core.hooksPath=/dev/null',
    ...args,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
  }).trim();
}

export function snapshotCheckoutAt(cwd) {
  const {
    repositoryFingerprint,
    branch,
    headOid,
    clean,
  } = snapshotExecutionCheckout(cwd);
  return {
    repositoryFingerprint,
    branch,
    headOid,
    clean,
  };
}

function gitMarkerDirectory(cwd) {
  const gitPath = gitOutput(cwd, ['rev-parse', '--git-path', 'autoloop']);
  if (!gitPath) throw new Error('git returned an empty autoloop path');
  return isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
}

function fixtureConfig() {
  return {
    version: '0.25.0',
    baseBranch: 'main',
    gate: {
      command: 'npm test',
      quickCommand: null,
      setupCommand: null,
    },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/checklist.md' },
    caps: {
      gateRetriesPerUnit: 2,
      reviseRoundsPerPr: 3,
      codeReviewRoundsPerUnit: 5,
      sliceMaxLines: 700,
      sliceMaxFiles: 10,
    },
  };
}

function fixtureCheckout() {
  return {
    repositoryFingerprint: 'e'.repeat(64),
    branch: 'main',
    headOid: 'c'.repeat(40),
    clean: true,
  };
}

function fixtureMarkerDirectory(prefix) {
  const root = join(tmpdir(), `${prefix}-${randomUUID()}`);
  const gitDirectory = join(root, 'repo.git');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '--bare', '-q', gitDirectory], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 15000,
  });
  return join(gitDirectory, 'autoloop');
}

function removeFixtureMarkerDirectory(markerDirectory) {
  rmSync(resolve(markerDirectory, '..', '..'), {
    recursive: true,
    force: true,
  });
}

function fixtureRequest() {
  const evidence = issueHostEvidence({
    integration: 'continuation-self-test',
    sessionId: 'source-session',
    observedSurface: { tool: 'task' },
    expectedHost: 'opencode',
  });
  if (!evidence.ok) throw new Error('fixture host did not attest');
  const opened = open({
    invocation: '/autoloop:dev; auto-continue',
    intentProvenance: INTENT_PROVENANCE,
    hostEvidence: evidence.value,
    config: fixtureConfig(),
  });
  if (!opened.ok) throw new Error('fixture run did not open');
  const finished = finish({
    run: opened.value,
    progress: {
      reason: 'context-budget',
      unitsCompleted: 1,
      queueEvidence: fixtureQueueEvidence(
        opened.value,
        1,
        'relaunch',
      ),
      checkout: fixtureCheckout(),
    },
  });
  if (!finished.ok || finished.value.action !== 'relaunch') {
    throw new Error('fixture run did not issue a relaunch');
  }
  return finished.value;
}

function selfTest() {
  const directory = fixtureMarkerDirectory('autoloop-continuation');
  const request = fixtureRequest();
  const issued = issueRelaunchRequestAt(request, directory);
  const duplicate = issueRelaunchRequestAt(request, directory);
  const wrongCheckout = claimRelaunchRequestAt(directory, {
    ...fixtureCheckout(),
    headOid: 'd'.repeat(40),
  }, { ownerId: 'source-session' });
  const claimed = claimRelaunchRequestAt(
    directory,
    fixtureCheckout(),
    { ownerId: 'source-session' },
  );
  const claimFingerprint = claimed.value?.state?.claimFingerprint;
  const ownerFingerprint = claimed.value?.ownerFingerprint;
  const repeatedClaim = claimRelaunchRequestAt(
    directory,
    fixtureCheckout(),
    { ownerId: 'source-session' },
  );
  const competingClaim = claimRelaunchRequestAt(
    directory,
    fixtureCheckout(),
    { ownerId: 'competing-session' },
  );
  const sessionTitle =
    `autoloop relaunch ${request.lease.fingerprint.slice(0, 16)}`;
  const sessionEffectInput = {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'claimed',
    effect: 'session-create',
    subjectFingerprint: textFingerprint(sessionTitle),
  };
  const sessionEffect = issueRelaunchEffectAt(
    directory,
    sessionEffectInput,
    fixtureCheckout(),
  );
  const repeatedSessionEffect = issueRelaunchEffectAt(
    directory,
    sessionEffectInput,
    fixtureCheckout(),
  );
  const conflictingSessionEffect = issueRelaunchEffectAt(directory, {
    ...sessionEffectInput,
    subjectFingerprint: 'f'.repeat(64),
  }, fixtureCheckout());
  const skipped = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'claimed',
    nextStatus: 'opened',
  }, fixtureCheckout());
  const changedCheckout = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'claimed',
    nextStatus: 'session-created',
    activeHost: 'opencode',
    integration: 'opencode.user-prompt-hook',
    sessionId: 'session-1',
  }, {
    ...fixtureCheckout(),
    headOid: 'd'.repeat(40),
  });
  const created = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'claimed',
    nextStatus: 'session-created',
    activeHost: 'opencode',
    integration: 'opencode.user-prompt-hook',
    sessionId: 'session-1',
  }, fixtureCheckout());
  const repeatedCreate = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'claimed',
    nextStatus: 'session-created',
    activeHost: 'opencode',
    integration: 'opencode.user-prompt-hook',
    sessionId: 'session-1',
  }, fixtureCheckout());
  const conflictingSession = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'session-created',
    nextStatus: 'session-created',
    activeHost: 'opencode',
    integration: 'opencode.user-prompt-hook',
    sessionId: 'session-2',
  }, fixtureCheckout());
  const opened = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'session-created',
    nextStatus: 'opened',
  }, fixtureCheckout());
  const repeatedOpen = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'session-created',
    nextStatus: 'opened',
  }, fixtureCheckout());
  const targetHost = issueHostEvidence({
    integration: 'opencode.user-prompt-hook',
    sessionId: 'session-1',
    observedSurface: { tool: 'task' },
    expectedHost: 'opencode',
  });
  const otherHost = issueHostEvidence({
    integration: 'opencode.user-prompt-hook',
    sessionId: 'session-2',
    observedSurface: { tool: 'task' },
    expectedHost: 'opencode',
  });
  const runtimeOpened = targetHost.ok && opened.ok
    ? open({
      invocation: RELAUNCH_PROMPT,
      intentProvenance: INTENT_PROVENANCE,
      hostEvidence: targetHost.value,
      config: fixtureConfig(),
      ...opened.value.continuation,
    })
    : { ok: false };
  const crossSessionOpen = otherHost.ok && opened.ok
    ? open({
      invocation: RELAUNCH_PROMPT,
      intentProvenance: INTENT_PROVENANCE,
      hostEvidence: otherHost.value,
      config: fixtureConfig(),
      ...opened.value.continuation,
    })
    : { ok: false };
  const contextEffect = issueRelaunchEffectAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'opened',
    effect: 'context-inject',
    subjectFingerprint: textFingerprint('fixture continuation context'),
  }, fixtureCheckout());
  const promptPreparationInput = {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    continuation: opened.value?.continuation,
  };
  const prematurePromptPreparation = prepareRelaunchPromptAt(
    directory,
    promptPreparationInput,
    fixtureCheckout(),
  );
  const promptEffect = issueRelaunchEffectAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'opened',
    effect: 'prompt',
    subjectFingerprint: textFingerprint(request.prompt),
  }, fixtureCheckout());
  const preparedPrompt = prepareRelaunchPromptAt(
    directory,
    promptPreparationInput,
    fixtureCheckout(),
  );
  const recoveredPromptPreparation = prepareRelaunchPromptAt(
    directory,
    promptPreparationInput,
    fixtureCheckout(),
  );
  const forgedPromptPreparation = prepareRelaunchPromptAt(directory, {
    ...promptPreparationInput,
    continuation: {
      ...promptPreparationInput.continuation,
      continuationAuthorization: {
        ...promptPreparationInput.continuation.continuationAuthorization,
        authorization: 'f'.repeat(64),
      },
    },
  }, fixtureCheckout());
  const prompted = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'opened',
    nextStatus: 'prompted',
  }, fixtureCheckout());
  const pointerClearedAfterPrompt = !existsSync(pointerPath(directory));
  const terminalReplay = issueRelaunchRequestAt(request, directory);
  const nextRequest = fixtureRequest();
  const nextIssued = issueRelaunchRequestAt(nextRequest, directory);
  const repeatedPrompt = transitionRelaunchRequestAt(directory, {
    leaseFingerprint: request.lease.fingerprint,
    claimFingerprint,
    ownerFingerprint,
    expectedStatus: 'opened',
    nextStatus: 'prompted',
  }, fixtureCheckout());
  const nextPointer = nextIssued.ok ? readPointer(directory) : null;
  const durableStates = readdirSync(
    leaseDirectory(directory, request.lease.fingerprint),
  ).filter((name) => STATE_FILE_RE.test(name)).sort();
  const staleDirectory = fixtureMarkerDirectory(
    'autoloop-continuation-stale',
  );
  const staleRequest = fixtureRequest();
  const staleIssued = issueRelaunchRequestAt(staleRequest, staleDirectory);
  const staleClaim = claimRelaunchRequestAt(
    staleDirectory,
    fixtureCheckout(),
    {
      ownerId: 'stale-owner',
      nowMs: Date.now() + MAX_REQUEST_AGE_MS + 1000,
    },
  );
  const replacement = fixtureRequest();
  const replacementIssued =
    issueRelaunchRequestAt(replacement, staleDirectory);
  const takeoverDirectory = fixtureMarkerDirectory(
    'autoloop-continuation-takeover',
  );
  const takeoverRequest = fixtureRequest();
  const takeoverIssued = issueRelaunchRequestAt(
    takeoverRequest,
    takeoverDirectory,
  );
  const takeoverNow = Date.now();
  const firstOwner = takeoverIssued.ok
    ? claimRelaunchRequestAt(
      takeoverDirectory,
      fixtureCheckout(),
      { ownerId: 'owner-a', nowMs: takeoverNow, maxAgeMs: 100 },
    )
    : { ok: false };
  const takeoverEffectInput = firstOwner.ok
    ? {
      leaseFingerprint: takeoverRequest.lease.fingerprint,
      claimFingerprint: firstOwner.value.state.claimFingerprint,
      ownerFingerprint: firstOwner.value.ownerFingerprint,
      expectedStatus: 'claimed',
      effect: 'session-create',
      subjectFingerprint: textFingerprint(
        `autoloop relaunch ${takeoverRequest.lease.fingerprint.slice(0, 16)}`,
      ),
    }
    : null;
  const takeoverInitialEffect = takeoverEffectInput
    ? issueRelaunchEffectAt(
      takeoverDirectory,
      takeoverEffectInput,
      fixtureCheckout(),
    )
    : { ok: false };
  const liveCompetitor = firstOwner.ok
    ? claimRelaunchRequestAt(
      takeoverDirectory,
      fixtureCheckout(),
      { ownerId: 'owner-b', nowMs: takeoverNow + 50, maxAgeMs: 100 },
    )
    : { ok: false };
  const takeover = firstOwner.ok
    ? claimRelaunchRequestAt(
      takeoverDirectory,
      fixtureCheckout(),
      { ownerId: 'owner-b', nowMs: takeoverNow + 101, maxAgeMs: 100 },
    )
    : { ok: false };
  const takeoverRecoveredEffect = takeover.ok && takeoverEffectInput
    ? issueRelaunchEffectAt(takeoverDirectory, {
      ...takeoverEffectInput,
      ownerFingerprint: takeover.value.ownerFingerprint,
    }, fixtureCheckout())
    : { ok: false };
  const staleOwnerRenewal = takeover.ok
    ? renewRelaunchOwnerAt(takeoverDirectory, {
      leaseFingerprint: takeoverRequest.lease.fingerprint,
      ownerFingerprint: firstOwner.value.ownerFingerprint,
    }, fixtureCheckout())
    : { ok: true };
  const oldOwnerTransition = firstOwner.ok
    ? transitionRelaunchRequestAt(takeoverDirectory, {
      leaseFingerprint: takeoverRequest.lease.fingerprint,
      claimFingerprint: firstOwner.value.state.claimFingerprint,
      ownerFingerprint: firstOwner.value.ownerFingerprint,
      expectedStatus: 'claimed',
      nextStatus: 'session-created',
      activeHost: 'opencode',
      integration: 'opencode.user-prompt-hook',
      sessionId: 'stale-owner-session',
    }, fixtureCheckout())
    : { ok: false };
  const takeoverTransition = takeover.ok
    ? transitionRelaunchRequestAt(takeoverDirectory, {
      leaseFingerprint: takeoverRequest.lease.fingerprint,
      claimFingerprint: takeover.value.state.claimFingerprint,
      ownerFingerprint: takeover.value.ownerFingerprint,
      expectedStatus: 'claimed',
      nextStatus: 'session-created',
      activeHost: 'opencode',
      integration: 'opencode.user-prompt-hook',
      sessionId: 'takeover-session',
    }, fixtureCheckout())
    : { ok: false };
  const forgedLeaseUnsigned = {
    ...request.lease,
    authorization: '0'.repeat(64),
  };
  delete forgedLeaseUnsigned.fingerprint;
  const forgedLease = fingerprinted(forgedLeaseUnsigned);
  const forgedStateUnsigned = {
    ...request.continuationState,
    leaseFingerprint: forgedLease.fingerprint,
    authorization: '0'.repeat(64),
  };
  delete forgedStateUnsigned.fingerprint;
  const forgedRequest = {
    ...request,
    lease: forgedLease,
    continuationState: fingerprinted(forgedStateUnsigned),
  };
  const symlinkDirectory = fixtureMarkerDirectory(
    'autoloop-continuation-symlink',
  );
  const symlinkTarget =
    join(tmpdir(), `autoloop-continuation-target-${randomUUID()}`);
  ensureDirectory(symlinkDirectory);
  ensureDirectory(join(symlinkDirectory, 'continuations'));
  ensureDirectory(symlinkTarget);
  symlinkSync(
    symlinkTarget,
    leaseDirectory(symlinkDirectory, request.lease.fingerprint),
  );
  const symlinkIssue = issueRelaunchRequestAt(request, symlinkDirectory);
  const cleanupDirectory = fixtureMarkerDirectory(
    'autoloop-continuation-cleanup',
  );
  const cleanupRequest = fixtureRequest();
  const cleanupIssued = issueRelaunchRequestAt(
    cleanupRequest,
    cleanupDirectory,
  );
  const cleanupPointer = cleanupIssued.ok
    ? readPointer(cleanupDirectory)
    : null;
  const cleanupIntent = cleanupPointer
    ? exclusiveJson(
      join(
        cleanupDirectory,
        `relaunch-request-clear-${cleanupPointer.pointerNonce}.json`,
      ),
      {
        version: 1,
        leaseFingerprint: cleanupPointer.leaseFingerprint,
        pointerNonce: cleanupPointer.pointerNonce,
      },
    )
    : { ok: false };
  const resumedCleanup = cleanupIntent.ok
    ? clearPointerIfCurrent(
      cleanupDirectory,
      cleanupRequest.lease.fingerprint,
    )
    : false;
  const cleanupReplacement = fixtureRequest();
  const cleanupReplacementIssued = resumedCleanup
    ? issueRelaunchRequestAt(cleanupReplacement, cleanupDirectory)
    : { ok: false };
  const lockDirectory = fixtureMarkerDirectory(
    'autoloop-continuation-lock',
  );
  const lockRequest = fixtureRequest();
  const lockIssued = issueRelaunchRequestAt(lockRequest, lockDirectory);
  const lockLeaseDirectory = leaseDirectory(
    lockDirectory,
    lockRequest.lease.fingerprint,
  );
  const deadLockNonce = randomUUID();
  const deadLock = {
    version: 1,
    leaseFingerprint: lockRequest.lease.fingerprint,
    pid: 2147483647,
    processIdentity: '2147483647:dead',
    nonce: deadLockNonce,
  };
  const deadLockOid = lockIssued.ok
    ? writeLockBlob(lockLeaseDirectory, deadLock)
    : null;
  const deadLockWritten = deadLockOid
    ? {
      ok: updateLockRef(lockLeaseDirectory, deadLockOid, null),
    }
    : { ok: false };
  const recoveredLockClaim = deadLockWritten.ok
    ? claimRelaunchRequestAt(
      lockDirectory,
      fixtureCheckout(),
      { ownerId: 'lock-owner' },
    )
    : { ok: false };
  const activeLock = recoveredLockClaim.ok
    ? acquireLeaseLock(lockLeaseDirectory)
    : null;
  const blockedByActiveLock = activeLock
    ? claimRelaunchRequestAt(
      lockDirectory,
      fixtureCheckout(),
      { ownerId: 'lock-owner' },
    )
    : { ok: true };
  if (activeLock) releaseLeaseLock(activeLock, lockLeaseDirectory);
  const resumedAfterActiveLock = activeLock
    ? claimRelaunchRequestAt(
      lockDirectory,
      fixtureCheckout(),
      { ownerId: 'lock-owner' },
    )
    : { ok: false };
  const staleRaceLock = {
    ...deadLock,
    nonce: randomUUID(),
  };
  const staleRaceOid = writeLockBlob(lockLeaseDirectory, staleRaceLock);
  const staleRaceSeeded = updateLockRef(
    lockLeaseDirectory,
    staleRaceOid,
    null,
  );
  const contenderALock = makeLeaseLock(lockLeaseDirectory);
  const contenderBLock = makeLeaseLock(lockLeaseDirectory);
  const contenderAOid = writeLockBlob(lockLeaseDirectory, contenderALock);
  const contenderBOid = writeLockBlob(lockLeaseDirectory, contenderBLock);
  const contenderAObserved = currentLockOid(lockLeaseDirectory);
  const contenderBObserved = currentLockOid(lockLeaseDirectory);
  const contenderAWon = updateLockRef(
    lockLeaseDirectory,
    contenderAOid,
    contenderAObserved,
  );
  const contenderBWon = updateLockRef(
    lockLeaseDirectory,
    contenderBOid,
    contenderBObserved,
  );
  const staleReleaseRejected = !deleteLockRef(
    lockLeaseDirectory,
    contenderBOid,
  );
  const contenderAReleased = deleteLockRef(
    lockLeaseDirectory,
    contenderAOid,
  );
  const symbolicTarget = 'refs/autoloop/continuation-lock-target';
  const symbolicTargetWritten = lockGit(lockLeaseDirectory, [
    'update-ref',
    '--no-deref',
    symbolicTarget,
    contenderBOid,
    ZERO_OID,
  ]);
  const symbolicLockWritten = lockGit(lockLeaseDirectory, [
    'symbolic-ref',
    LOCK_REF,
    symbolicTarget,
  ]);
  let symbolicLockRejected = false;
  try {
    acquireLeaseLock(lockLeaseDirectory);
  } catch {
    symbolicLockRejected = true;
  }
  const symbolicTargetAfter = lockGit(lockLeaseDirectory, [
    'rev-parse',
    '--verify',
    '--quiet',
    symbolicTarget,
  ]);
  const symbolicLockRemoved = lockGit(lockLeaseDirectory, [
    'symbolic-ref',
    '--delete',
    LOCK_REF,
  ]);
  const symbolicTargetRemoved = lockGit(lockLeaseDirectory, [
    'update-ref',
    '--no-deref',
    '-d',
    symbolicTarget,
    contenderBOid,
  ]);
  const productionRoutes = [];
  const productionTransition = productionContinuationTransition(
    { lease: request.lease, state: request.continuationState },
    (flag, input) => {
      productionRoutes.push([flag, input]);
      return { ok: true };
    },
  );
  const productionHistory = productionContinuationHistory(
    { lease: request.lease, states: [request.continuationState] },
    (flag, input) => {
      productionRoutes.push([flag, input]);
      return { ok: true };
    },
  );
  const productionPromptPreparation =
    productionContinuationPromptPreparation(
      { lease: request.lease, state: request.continuationState },
      (flag, input) => {
        productionRoutes.push([flag, input]);
        return { ok: true };
      },
    );
  const cases = [
    ['runtime request validates', validateRelaunchRequest(request).ok],
    [
      'production continuation validation and CAS route through run-scope',
      productionTransition.ok
        && productionHistory.ok
        && productionPromptPreparation.ok
        && productionRoutes.map(([flag]) => flag).join(',') === [
          '--transition-continuation-json',
          '--validate-continuation-history-json',
          '--prepare-continuation-prompt-json',
        ].join(','),
    ],
    ['issue is durable and idempotent', issued.ok && duplicate.ok],
    ['checkout mismatch does not claim', !wrongCheckout.ok],
    [
      'claim is durable and recoverable',
      claimed.ok
        && repeatedClaim.ok
        && claimed.value.state.fingerprint ===
          repeatedClaim.value.state.fingerprint
        && claimed.value.state.status === 'claimed',
    ],
    ['another handler cannot adopt an existing claim', !competingClaim.ok],
    [
      'provider effects are durable one-shot intents',
      sessionEffect.ok
        && sessionEffect.value.created === true
        && repeatedSessionEffect.ok
        && repeatedSessionEffect.value.created === false
        && !conflictingSessionEffect.ok,
    ],
    ['state transitions cannot skip session creation', !skipped.ok],
    ['checkout is revalidated before every transition', !changedCheckout.ok],
    [
      'session creation is idempotent',
      created.ok
        && repeatedCreate.ok
        && created.value.state.fingerprint ===
          repeatedCreate.value.state.fingerprint
        && created.value.session.integration
          === 'opencode.user-prompt-hook',
    ],
    ['session binding cannot be replaced', !conflictingSession.ok],
    [
      'opened state yields a session-bound authorization',
      opened.ok
        && repeatedOpen.ok
        && opened.value.continuation.continuationState.status === 'opened'
        && opened.value.continuation.continuationAuthorization
          .sessionFingerprint === created.value.session.sessionFingerprint,
    ],
    [
      'authorization opens only in the lease-bound provider session',
      runtimeOpened.ok && !crossSessionOpen.ok,
    ],
    [
      'prompt readiness requires its durable intent and exact opened authority',
      !prematurePromptPreparation.ok
        && preparedPrompt.ok
        && recoveredPromptPreparation.ok
        && !forgedPromptPreparation.ok,
    ],
    [
      'prompted is terminal and clears the active pointer',
      prompted.ok
        && prompted.value.state.status === 'prompted'
        && contextEffect.ok
        && promptEffect.ok
        && pointerClearedAfterPrompt,
    ],
    [
      'all five lifecycle states remain append-only',
      durableStates.join(',') === [
        'state-000-issued.json',
        'state-001-claimed.json',
        'state-002-session-created.json',
        'state-003-opened.json',
        'state-004-prompted.json',
      ].join(','),
    ],
    [
      'terminal request replay cannot recreate an active pointer',
      terminalReplay.ok
        && nextIssued.ok
        && repeatedPrompt.ok
        && nextPointer?.leaseFingerprint === nextRequest.lease.fingerprint,
    ],
    [
      'stale unclaimed pointers are cleared without deleting audit state',
      staleIssued.ok
        && !staleClaim.ok
        && replacementIssued.ok
        && existsSync(join(
          leaseDirectory(staleDirectory, staleRequest.lease.fingerprint),
          'request.json',
        )),
    ],
    [
      'expired ownership transfers atomically and stale owners lose authority',
      takeoverIssued.ok
        && firstOwner.ok
        && !liveCompetitor.ok
        && takeover.ok
        && takeover.value.state.claimFingerprint ===
          firstOwner.value.state.claimFingerprint
        && takeover.value.ownerFingerprint !==
          firstOwner.value.ownerFingerprint
        && takeoverInitialEffect.ok
        && takeoverInitialEffect.value.created === true
        && takeoverRecoveredEffect.ok
        && takeoverRecoveredEffect.value.created === false
        && !staleOwnerRenewal.ok
        && !oldOwnerTransition.ok
        && takeoverTransition.ok
        && readdirSync(leaseDirectory(
          takeoverDirectory,
          takeoverRequest.lease.fingerprint,
        )).filter((name) => OWNER_FILE_RE.test(name)).length === 2,
    ],
    [
      'public hash resealing cannot forge a Runtime continuation lease',
      !validateRelaunchRequest(forgedRequest).ok,
    ],
    [
      'precreated lease-directory symlinks are rejected',
      !symlinkIssue.ok
        && readdirSync(symlinkTarget).length === 0,
    ],
    [
      'pointer cleanup resumes across both crash boundaries',
      cleanupIssued.ok
        && cleanupIntent.ok
        && resumedCleanup
        && cleanupReplacementIssued.ok
        && readPointer(cleanupDirectory).leaseFingerprint
          === cleanupReplacement.lease.fingerprint,
    ],
    [
      'dead process locks recover while live locks remain exclusive',
      lockIssued.ok
        && deadLockWritten.ok
        && recoveredLockClaim.ok
        && !blockedByActiveLock.ok
        && resumedAfterActiveLock.ok
        && currentLockOid(lockLeaseDirectory) === null,
    ],
    [
      'stale-lock reclaim and release use exact Git ref CAS',
      staleRaceSeeded
        && contenderAObserved === staleRaceOid
        && contenderBObserved === staleRaceOid
        && contenderAWon
        && !contenderBWon
        && staleReleaseRejected
        && contenderAReleased
        && currentLockOid(lockLeaseDirectory) === null,
    ],
    [
      'symbolic lock refs fail closed without changing their target',
      symbolicTargetWritten.status === 0
        && symbolicLockWritten.status === 0
        && symbolicLockRejected
        && String(symbolicTargetAfter.stdout ?? '').trim()
          === contenderBOid
        && symbolicLockRemoved.status === 0
        && symbolicTargetRemoved.status === 0,
    ],
  ];
  removeFixtureMarkerDirectory(directory);
  removeFixtureMarkerDirectory(staleDirectory);
  removeFixtureMarkerDirectory(takeoverDirectory);
  removeFixtureMarkerDirectory(symlinkDirectory);
  rmSync(symlinkTarget, { recursive: true, force: true });
  removeFixtureMarkerDirectory(cleanupDirectory);
  removeFixtureMarkerDirectory(lockDirectory);
  const failures = cases.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

function readStdin() {
  const bytes = readFileSync(0);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('input exceeds 1 MiB');
  return JSON.parse(bytes.toString('utf8'));
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '--self-test' && rest.length === 0) {
    process.exit(selfTest() ? 0 : 1);
  }
  if (
    ![
      '--checkout',
      '--issue',
      '--claim',
      '--renew',
      '--issue-effect',
      '--prepare-prompt',
      '--transition',
    ].includes(mode)
    || rest.length > 0
  ) {
    console.error(
      'continuation-store: expected --checkout, --issue, --claim, ' +
      '--renew, --issue-effect, --prepare-prompt, --transition, or --self-test',
    );
    process.exit(2);
  }
  let result;
  try {
    if (mode === '--checkout') {
      result = { ok: true, value: snapshotCheckoutAt(process.cwd()) };
    } else {
      const markerDirectory = gitMarkerDirectory(process.cwd());
      if (mode === '--issue') {
        result = issueRelaunchRequestAt(readStdin(), markerDirectory);
      } else if (mode === '--claim') {
        const input = readStdin();
        result = claimRelaunchRequestAt(
          markerDirectory,
          snapshotCheckoutAt(process.cwd()),
          { ownerId: input.ownerId },
        );
      } else if (mode === '--renew') {
        result = renewRelaunchOwnerAt(
          markerDirectory,
          readStdin(),
          snapshotCheckoutAt(process.cwd()),
        );
      } else if (mode === '--issue-effect') {
        result = issueRelaunchEffectAt(
          markerDirectory,
          readStdin(),
          snapshotCheckoutAt(process.cwd()),
        );
      } else if (mode === '--prepare-prompt') {
        result = prepareRelaunchPromptAt(
          markerDirectory,
          readStdin(),
          snapshotCheckoutAt(process.cwd()),
        );
      } else {
        result = transitionRelaunchRequestAt(
          markerDirectory,
          readStdin(),
          snapshotCheckoutAt(process.cwd()),
        );
      }
    }
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) main();
