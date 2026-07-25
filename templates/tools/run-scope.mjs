#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  extractConfig,
  validateProjectConfig,
} from './config-contract.mjs';
import {
  captureHostIntent,
  consumeHostIntent,
  INTENT_PROVENANCE,
} from './intent-contract.mjs';
import {
  bindRuntimeMeasurement,
  bindRuntimeMeasurementUnit,
  captureRuntimeDispatchMeasurement,
} from './measurement-contract.mjs';
import {
  finish,
  fixtureQueueEvidence,
  initializeRouteState,
  observe,
  open,
  plan,
  RELAUNCH_PROMPT,
  refreshRouteState,
  transitionContinuationLease,
  validateRuntimeRun,
} from './runtime-contract.mjs';
import {
  clearRuntimeAuthority,
  compileRouteAttempt,
  detectHostProcessBinding,
  executeRouteAttempt,
  issueCapabilitySnapshot,
  issueHostEvidence,
  validateCapabilitySnapshot,
  validateRuntimeAuthorization,
} from './route-adapter-contract.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const BROKER_SOCKET_MAX_BYTES = process.platform === 'linux' ? 107 : 103;

function portableBrokerDirectory(platform = process.platform) {
  const parent = ['darwin', 'linux'].includes(platform)
    ? realpathSync('/tmp')
    : realpathSync(tmpdir());
  return join(
    parent,
    `autoloop-broker-${typeof process.getuid === 'function'
      ? process.getuid()
      : 'user'}`,
  );
}

const BROKER_DIRECTORY = portableBrokerDirectory();
const LEGACY_AUTHORITY_DIRECTORY = join(
  process.env.XDG_RUNTIME_DIR || tmpdir(),
  `autoloop-authority-${typeof process.getuid === 'function'
    ? process.getuid()
    : 'user'}`,
);
const HEX_64 = /^[a-f0-9]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEASUREMENT_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,79}$/;
const CONTINUATION_SESSION_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SOCKET_NAME = /^[a-f0-9]{32}\.sock$/;
const BROKER_ENTRYPOINT = realpathSync(fileURLToPath(import.meta.url));
const BROKER_EXECUTABLE = realpathSync(process.execPath);
const INTENT_ENTRYPOINT = realpathSync(
  fileURLToPath(new URL('./intent-contract.mjs', import.meta.url)),
);
const STATE_RELATIVE_PATH = join('docs', 'agentic', 'STATE.md');

function brokerOnlyOperation() {
  throw new Error('broker-only operation cannot run outside the broker');
}

function brokerSocketPath(name, platform = process.platform) {
  const path = join(portableBrokerDirectory(platform), name);
  const maximum = platform === 'linux' ? 107 : 103;
  if (Buffer.byteLength(path) > maximum) {
    throw new Error('broker socket path exceeds the platform limit');
  }
  return path;
}

export function openRunScope(input) {
  return open(input);
}

export function finishRunScope(input) {
  return finish(input);
}

export function transitionRunContinuation(input) {
  return transitionContinuationLease(input);
}

function validateContinuationHistory(input) {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'lease,states'
    || !Array.isArray(input.states)
    || input.states.length < 1
    || input.states.length > 5
  ) {
    return brokerFailure(
      'INVALID_CONTINUATION_HISTORY',
      'continuation history input has an invalid shape',
    );
  }
  let previous = input.states[0];
  let validated = transitionContinuationLease({
    lease: input.lease,
    state: previous,
    nextStatus: 'issued',
  });
  if (
    !validated.ok
    || validated.value.state.fingerprint !== previous?.fingerprint
  ) {
    return brokerFailure(
      'INVALID_CONTINUATION_HISTORY',
      'issued continuation state is invalid',
    );
  }
  for (let index = 1; index < input.states.length; index += 1) {
    const state = input.states[index];
    validated = transitionContinuationLease({
      lease: input.lease,
      state: previous,
      nextStatus: state?.status,
      claimFingerprint: state?.claimFingerprint,
      sessionFingerprint: state?.sessionFingerprint,
    });
    if (
      !validated.ok
      || validated.value.state.fingerprint !== state?.fingerprint
    ) {
      return brokerFailure(
        'INVALID_CONTINUATION_HISTORY',
        'continuation state history is invalid',
      );
    }
    previous = state;
  }
  return {
    ok: true,
    value: {
      leaseFingerprint: input.lease.fingerprint,
      stateFingerprint: previous.fingerprint,
    },
  };
}

const OPERATION_FLAGS = Object.freeze({
  '--attest-host-json': ['attest-host', issueHostEvidence],
  '--probe-json': ['probe', issueCapabilitySnapshot],
  '--open-json': ['open', open],
  '--initialize-route-state-json': ['initialize-route-state', initializeRouteState],
  '--refresh-route-state-json': ['refresh-route-state', refreshRouteState],
  '--plan-json': ['plan', plan],
  '--compile-json': ['compile', compileRouteAttempt],
  '--execute-json': ['execute', executeRouteAttempt],
  '--observe-json': ['observe', observe],
  '--observe-measured-json': ['observe-measured', brokerOnlyOperation],
  '--bind-measurement-json': ['bind-measurement', brokerOnlyOperation],
  '--bind-measurement-unit-json': ['bind-measurement-unit', brokerOnlyOperation],
  '--finish-json': ['finish', finish],
  '--transition-continuation-json': [
    'transition-continuation',
    transitionContinuationLease,
  ],
  '--prepare-continuation-prompt-json': [
    'prepare-continuation-prompt',
    brokerOnlyOperation,
  ],
  '--validate-continuation-history-json': [
    'validate-continuation-history',
    validateContinuationHistory,
  ],
});

function brokerFailure(code, message) {
  return { ok: false, error: { code, message } };
}

function validContinuationPromptPreparation(input, continuation) {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).sort().join(',')
      !== 'authorization,effect,lease,session,state'
    || continuation?.status !== 'opened'
    || ![
      null,
      input.effect?.fingerprint,
    ].includes(continuation.promptEffectFingerprint)
  ) {
    return false;
  }
  const effect = input.effect;
  const session = input.session;
  if (
    !effect
    || typeof effect !== 'object'
    || Array.isArray(effect)
    || Object.keys(effect).sort().join(',') !== [
      'claimFingerprint',
      'effect',
      'effectNonce',
      'expectedStatus',
      'fingerprint',
      'issuedByOwnerFingerprint',
      'leaseFingerprint',
      'subjectFingerprint',
      'version',
    ].join(',')
    || !session
    || typeof session !== 'object'
    || Array.isArray(session)
    || Object.keys(session).sort().join(',') !== [
      'activeHost',
      'integration',
      'sessionFingerprint',
      'sessionId',
      'version',
    ].join(',')
  ) {
    return false;
  }
  const unsignedEffect = { ...effect };
  delete unsignedEffect.fingerprint;
  const effectFingerprint = createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(
      Object.entries(unsignedEffect).sort(([left], [right]) =>
        left.localeCompare(right)),
    )))
    .digest('hex');
  const sessionFingerprint = createHash('sha256')
    .update(JSON.stringify({
      activeHost: session.activeHost,
      integration: session.integration,
      sessionId: session.sessionId,
    }))
    .digest('hex');
  return isDeepStrictEqual(input.lease, continuation.leaseArtifact)
    && isDeepStrictEqual(input.state, continuation.openedState)
    && isDeepStrictEqual(
      input.authorization,
      continuation.continuationAuthorization,
    )
    && session.version === 1
    && ['claude', 'codex', 'opencode'].includes(session.activeHost)
    && session.integration === `${session.activeHost}.user-prompt-hook`
    && CONTINUATION_SESSION_ID.test(session.sessionId ?? '')
    && session.sessionFingerprint === sessionFingerprint
    && session.sessionFingerprint === continuation.targetSessionFingerprint
    && effect.version === 1
    && effect.leaseFingerprint === continuation.leaseFingerprint
    && effect.claimFingerprint === continuation.openedState.claimFingerprint
    && effect.expectedStatus === 'opened'
    && effect.effect === 'prompt'
    && effect.subjectFingerprint === createHash('sha256')
      .update(RELAUNCH_PROMPT)
      .digest('hex')
    && HEX_64.test(effect.issuedByOwnerFingerprint ?? '')
    && UUID_V4.test(effect.effectNonce ?? '')
    && effect.fingerprint === effectFingerprint;
}

function brokerCheckoutRoot(cwd = process.cwd()) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const result = spawnSync('git', [
    '--no-replace-objects',
    '--no-optional-locks',
    '-C',
    cwd,
    '-c',
    'core.hooksPath=/dev/null',
    'rev-parse',
    '--show-toplevel',
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
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    throw new Error('broker checkout root is unavailable');
  }
  const root = realpathSync(String(result.stdout ?? '').trim());
  if (!resolve(root).startsWith('/')) {
    throw new Error('broker checkout root is invalid');
  }
  return root;
}

function brokerProjectConfig(root) {
  const installed = join(root, STATE_RELATIVE_PATH);
  const sourceTemplate = join(root, 'templates', 'STATE.template.md');
  if (
    !existsSync(installed)
    && existsSync(join(root, 'VERSION'))
    && existsSync(sourceTemplate)
  ) {
    return configFixture();
  }
  const path = installed;
  const stats = lstatSync(path);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size > MAX_INPUT_BYTES
  ) {
    throw new Error('STATE is not a bounded regular file');
  }
  const config = extractConfig(readFileSync(path, 'utf8'));
  if (validateProjectConfig(config).length !== 0) {
    throw new Error('STATE ProjectConfig is invalid');
  }
  return config;
}

function capturedAttestation(input, binding) {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).join(',') !== 'sessionId'
    || typeof input.sessionId !== 'string'
  ) {
    throw new Error('host attestation request is invalid');
  }
  const root = brokerCheckoutRoot();
  const intent = consumeHostIntent(
    { sessionId: input.sessionId },
    { binding, cwd: root },
  );
  if (
    intent.repositoryRoot !== root
    || intent.host !== binding.host
    || intent.hostProcessFingerprint !== binding.fingerprint
  ) {
    throw new Error('captured host intent does not match this broker');
  }
  const config = brokerProjectConfig(root);
  return {
    operationInput: {
      integration: `${binding.host}.user-prompt-hook`,
      sessionId: intent.sessionId,
      observedSurface: {
        authority: 'same-uid-user-prompt-hook-v1',
        intentProvenance: INTENT_PROVENANCE,
        intentFingerprint: intent.fingerprint,
        repositoryRoot: root,
      },
      expectedHost: binding.host,
    },
    ledgerInput: {
      capturedIntent: {
        invocation: intent.prompt,
        intentProvenance: intent.intentProvenance,
        intentFingerprint: intent.fingerprint,
        repositoryRoot: root,
        config,
      },
    },
  };
}

function continuationAttestation(input, binding) {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).join(',') !== 'sessionId'
    || typeof input.sessionId !== 'string'
  ) {
    throw new Error('continuation attestation request is invalid');
  }
  const root = brokerCheckoutRoot();
  const targetSessionFingerprint = createHash('sha256')
    .update(JSON.stringify({
      activeHost: binding.host,
      integration: `${binding.host}.user-prompt-hook`,
      sessionId: input.sessionId,
    }))
    .digest('hex');
  return {
    operationInput: {
      integration: `${binding.host}.user-prompt-hook`,
      sessionId: input.sessionId,
      observedSurface: {
        authority: 'same-host-continuation-handoff-v1',
        intentProvenance: INTENT_PROVENANCE,
        repositoryRoot: root,
      },
      expectedHost: binding.host,
    },
    ledgerInput: {
      targetSessionFingerprint,
      capturedIntent: {
        invocation: RELAUNCH_PROMPT,
        intentProvenance: INTENT_PROVENANCE,
        repositoryRoot: root,
        config: brokerProjectConfig(root),
      },
    },
  };
}

function ensureBrokerDirectory() {
  mkdirSync(BROKER_DIRECTORY, { recursive: true, mode: 0o700 });
  const stats = lstatSync(BROKER_DIRECTORY);
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || typeof process.getuid === 'function' && stats.uid !== process.getuid()
  ) {
    throw new Error('broker state path is invalid');
  }
  chmodSync(BROKER_DIRECTORY, 0o700);
}

function purgeLegacyAuthorityKeys() {
  let entries;
  try {
    const stats = lstatSync(LEGACY_AUTHORITY_DIRECTORY);
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || typeof process.getuid === 'function' && stats.uid !== process.getuid()
    ) {
      throw new Error('legacy authority path is invalid');
    }
    entries = readdirSync(LEGACY_AUTHORITY_DIRECTORY);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (/^[a-f0-9]{64}\.key$/.test(entry)) {
      rmSync(join(LEGACY_AUTHORITY_DIRECTORY, entry), { force: true });
    }
  }
}

function collectSessionFingerprints(value, found = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (
    Object.hasOwn(value, 'sessionFingerprint')
    && HEX_64.test(value.sessionFingerprint)
  ) {
    found.add(value.sessionFingerprint);
  }
  for (const nested of Object.values(value)) {
    collectSessionFingerprints(nested, found, seen);
  }
  return found;
}

function brokerRegistryPath(sessionFingerprint) {
  if (!HEX_64.test(sessionFingerprint)) {
    throw new Error('broker session fingerprint is invalid');
  }
  return join(BROKER_DIRECTORY, `${sessionFingerprint}.json`);
}

function validBrokerSocketPath(path) {
  return typeof path === 'string'
    && dirname(path) === BROKER_DIRECTORY
    && SOCKET_NAME.test(basename(path))
    && resolve(path) === path
    && Buffer.byteLength(path) <= BROKER_SOCKET_MAX_BYTES;
}

function readSmallOwnedFile(path, maximumBytes) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile()
      || typeof process.getuid === 'function'
        && stats.uid !== process.getuid()
      || (stats.mode & 0o077) !== 0
      || stats.size > maximumBytes
    ) {
      throw new Error('broker state file is invalid');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function processStartIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = value.slice(value.lastIndexOf(') ') + 2).split(' ');
      return /^[0-9]+$/.test(fields[19] ?? '') ? fields[19] : null;
    }
    if (process.platform === 'darwin') {
      const result = spawnSync(
        '/bin/ps',
        ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8', timeout: 5000 },
      );
      const value = String(result.stdout ?? '').trim();
      return result.status === 0 && value.length > 0 ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

function hostProcessAlive(hostBinding) {
  return Number.isSafeInteger(hostBinding?.pid)
    && hostBinding.pid > 1
    && typeof hostBinding.processStart === 'string'
    && processStartIdentity(hostBinding.pid) === hostBinding.processStart;
}

function startHostLivenessMonitor(hostBinding, onDeath, interval = 250) {
  let stopped = false;
  const inspect = () => {
    if (stopped || hostProcessAlive(hostBinding)) return;
    stopped = true;
    clearInterval(timer);
    onDeath();
  };
  const timer = setInterval(inspect, interval);
  timer.unref();
  inspect();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function socketOwnedByProcess(socketPath, pid) {
  const stats = lstatSync(socketPath);
  if (
    !stats.isSocket()
    || stats.isSymbolicLink()
    || typeof process.getuid === 'function' && stats.uid !== process.getuid()
  ) {
    return false;
  }
  if (process.platform === 'linux') {
    const socketInodes = new Set(readFileSync('/proc/net/unix', 'utf8')
      .split('\n')
      .filter((line) => line.endsWith(` ${socketPath}`))
      .map((line) => line.trim().split(/\s+/)[6])
      .filter((inode) => /^[0-9]+$/.test(inode ?? '')));
    if (socketInodes.size === 0) return false;
    return readdirSync(`/proc/${pid}/fd`).some((entry) => {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${entry}`);
        return target.startsWith('socket:[')
          && socketInodes.has(target.slice(8, -1));
      } catch {
        return false;
      }
    });
  }
  if (process.platform === 'darwin') {
    const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(existsSync);
    if (!lsof) return false;
    const result = spawnSync(
      lsof,
      ['-a', '-p', String(pid), '-U', '-Fn'],
      { encoding: 'utf8', timeout: 5000 },
    );
    return result.status === 0
      && String(result.stdout ?? '').split(/\r?\n/)
        .includes(`n${socketPath}`);
  }
  return false;
}

function brokerCommandMatches(registry) {
  try {
    if (processStartIdentity(registry.pid) !== registry.processStart) {
      return false;
    }
    if (process.platform === 'linux') {
      const executable = realpathSync(`/proc/${registry.pid}/exe`);
      const argv = readFileSync(
        `/proc/${registry.pid}/cmdline`,
        'utf8',
      ).split('\0').filter((value) => value.length > 0);
      return executable === BROKER_EXECUTABLE
        && argv.length === 5
        && realpathSync(argv[0]) === BROKER_EXECUTABLE
        && realpathSync(argv[1]) === BROKER_ENTRYPOINT
        && argv[2] === '--authority-broker'
        && argv[3] === registry.socketPath
        && argv[4] === BROKER_DIRECTORY;
    }
    if (process.platform === 'darwin') {
      const result = spawnSync(
        '/bin/ps',
        ['-p', String(registry.pid), '-o', 'command='],
        { encoding: 'utf8', timeout: 5000 },
      );
      const command = String(result.stdout ?? '').trim();
      return result.status === 0
        && command === [
          BROKER_EXECUTABLE,
          BROKER_ENTRYPOINT,
          '--authority-broker',
          registry.socketPath,
          BROKER_DIRECTORY,
        ].join(' ');
    }
    return false;
  } catch {
    return false;
  }
}

function brokerProcessMatches(registry) {
  try {
    return brokerCommandMatches(registry)
      && socketOwnedByProcess(registry.socketPath, registry.pid);
  } catch {
    return false;
  }
}

function parseBrokerRegistry(sessionFingerprint) {
  const registry = JSON.parse(
    readSmallOwnedFile(brokerRegistryPath(sessionFingerprint), 4096),
  );
  if (
    registry?.version !== 2
    || Object.keys(registry).sort().join(',') !==
      'entrypoint,executable,nonce,pid,processStart,sessionFingerprint,socketPath,version'
    || registry.sessionFingerprint !== sessionFingerprint
    || !Number.isSafeInteger(registry.pid)
    || registry.pid < 1
    || !validBrokerSocketPath(registry.socketPath)
    || registry.executable !== BROKER_EXECUTABLE
    || registry.entrypoint !== BROKER_ENTRYPOINT
    || typeof registry.processStart !== 'string'
    || registry.processStart.length < 1
    || !/^[a-f0-9]{64}$/.test(registry.nonce)
  ) {
    throw new Error('broker registry is invalid');
  }
  return registry;
}

function readBrokerRegistry(sessionFingerprint) {
  ensureBrokerDirectory();
  const registry = parseBrokerRegistry(sessionFingerprint);
  if (!brokerProcessMatches(registry)) {
    throw new Error('broker registry does not identify a live broker');
  }
  return registry;
}

function writeExclusiveState(path, value) {
  const temporary = join(
    BROKER_DIRECTORY,
    `${basename(path)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  writeFileSync(
    temporary,
    `${JSON.stringify(value)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  try {
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function lockPathFor(scope) {
  if (!/^(?:host-)?[a-f0-9]{64}$/.test(scope)) {
    throw new Error('broker lock scope is invalid');
  }
  return join(BROKER_DIRECTORY, `${scope}.lock`);
}

function lockOwner(path) {
  return JSON.parse(readSmallOwnedFile(join(path, 'owner.json'), 1024));
}

function liveLockOwner(owner) {
  return Number.isSafeInteger(owner?.pid)
    && owner.pid > 0
    && typeof owner.processStart === 'string'
    && processStartIdentity(owner.pid) === owner.processStart;
}

function validRecoveryClaim(value) {
  return value?.version === 1
    && Object.keys(value).sort().join(',')
      === 'pid,processStart,token,version'
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.processStart === 'string'
    && HEX_64.test(value.token);
}

function recoveryClaim(path) {
  const value = JSON.parse(readSmallOwnedFile(path, 1024));
  if (!validRecoveryClaim(value)) {
    throw new Error('broker registry recovery claim is invalid');
  }
  return value;
}

function removeOwnedRecoveryClaim(claim) {
  try {
    if (recoveryClaim(claim.path).token === claim.value.token) {
      rmSync(claim.path, { force: true });
    }
  } catch {}
}

function claimLockRecovery(path) {
  const value = {
    version: 1,
    pid: process.pid,
    processStart: processStartIdentity(process.pid),
    token: randomBytes(32).toString('hex'),
  };
  if (typeof value.processStart !== 'string') {
    throw new Error('broker recovery process identity is unavailable');
  }
  let claimPath = join(path, 'recovery.json');
  for (let depth = 0; depth < 1024; depth += 1) {
    try {
      writeFileSync(
        claimPath,
        `${JSON.stringify(value)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      return { path: claimPath, value };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = recoveryClaim(claimPath);
      if (liveLockOwner(existing)) return null;
      claimPath = join(path, `recovery-${existing.token}.json`);
    }
  }
  throw new Error('broker registry recovery chain is invalid');
}

function readLockOwner(path) {
  try {
    return lockOwner(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeOwnedLockOwner(path, token) {
  try {
    if (lockOwner(path).token === token) {
      rmSync(join(path, 'owner.json'), { force: true });
    }
  } catch {}
}

function reclaimStaleLock(path, expectedOwner, afterRecovery = () => {}) {
  const recovery = claimLockRecovery(path);
  if (recovery === null) return false;
  afterRecovery();
  const currentOwner = readLockOwner(path);
  if (
    currentOwner !== null
    && (
      liveLockOwner(currentOwner)
      || expectedOwner !== null
        && currentOwner.token !== expectedOwner.token
    )
  ) {
    removeOwnedRecoveryClaim(recovery);
    return false;
  }
  const quarantine = join(
    BROKER_DIRECTORY,
    `${basename(path)}.${recovery.value.token}.stale`,
  );
  renameSync(path, quarantine);
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function acquireRegistryLock(scope) {
  const path = lockPathFor(scope);
  const token = randomBytes(32).toString('hex');
  const value = {
    version: 1,
    pid: process.pid,
    processStart: processStartIdentity(process.pid),
    token,
  };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (created) {
      try {
        writeFileSync(
          join(path, 'owner.json'),
          `${JSON.stringify(value)}\n`,
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        );
      } catch (error) {
        removeOwnedLockOwner(path, token);
        throw error;
      }
      if (existsSync(join(path, 'recovery.json'))) {
        removeOwnedLockOwner(path, token);
      } else {
        return { path, token };
      }
    }
    let current;
    try {
      const stats = lstatSync(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('broker registry lock is invalid');
      }
      current = readLockOwner(path);
    } catch {
      throw new Error('broker registry lock is invalid');
    }
    if (
      (current === null || !liveLockOwner(current))
      && reclaimStaleLock(path, current)
    ) {
      continue;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      10,
    );
  }
  throw new Error('broker registry lock timed out');
}

function releaseRegistryLock(lock) {
  try {
    const current = lockOwner(lock.path);
    if (current?.token === lock.token) {
      rmSync(lock.path, { recursive: true, force: true });
    }
  } catch {}
}

function removeStaleSocket(socketPath) {
  if (!validBrokerSocketPath(socketPath)) return;
  try {
    const stats = lstatSync(socketPath);
    if (
      stats.isSocket()
      && !stats.isSymbolicLink()
      && (
        typeof process.getuid !== 'function'
        || stats.uid === process.getuid()
      )
    ) {
      rmSync(socketPath, { force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function claimBrokerRegistry(sessionFingerprint, socketPath) {
  const lock = acquireRegistryLock(sessionFingerprint);
  try {
    let existing = null;
    try {
      existing = parseBrokerRegistry(sessionFingerprint);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing && brokerProcessMatches(existing)) {
      return { claimed: false, registry: existing };
    }
    if (existing) {
      rmSync(brokerRegistryPath(sessionFingerprint), { force: true });
      removeStaleSocket(existing.socketPath);
    }
    const registry = {
      version: 2,
      pid: process.pid,
      processStart: processStartIdentity(process.pid),
      executable: BROKER_EXECUTABLE,
      entrypoint: BROKER_ENTRYPOINT,
      sessionFingerprint,
      socketPath,
      nonce: randomBytes(32).toString('hex'),
    };
    if (typeof registry.processStart !== 'string') {
      throw new Error('broker process identity is unavailable');
    }
    writeExclusiveState(brokerRegistryPath(sessionFingerprint), registry);
    if (!brokerProcessMatches(registry)) {
      rmSync(brokerRegistryPath(sessionFingerprint), { force: true });
      throw new Error('broker process identity could not be verified');
    }
    return { claimed: true, registry };
  } finally {
    releaseRegistryLock(lock);
  }
}

function removeOwnedRegistry(registry) {
  let lock = null;
  try {
    lock = acquireRegistryLock(registry.sessionFingerprint);
    const current = parseBrokerRegistry(registry.sessionFingerprint);
    if (
      current.pid === registry.pid
      && current.processStart === registry.processStart
      && current.socketPath === registry.socketPath
      && current.nonce === registry.nonce
    ) {
      rmSync(brokerRegistryPath(registry.sessionFingerprint), { force: true });
    }
  } catch {
  } finally {
    if (lock) releaseRegistryLock(lock);
  }
}

function hostLeasePath(hostBindingFingerprint) {
  if (!HEX_64.test(hostBindingFingerprint)) {
    throw new Error('host process binding is invalid');
  }
  return join(
    BROKER_DIRECTORY,
    `host-${hostBindingFingerprint}.lease`,
  );
}

function parseHostLease(hostBindingFingerprint) {
  const lease = JSON.parse(
    readSmallOwnedFile(hostLeasePath(hostBindingFingerprint), 4096),
  );
  if (
    lease?.version !== 2
    || Object.keys(lease).sort().join(',') !==
      'entrypoint,executable,hostBindingFingerprint,hostPid,hostProcessStart,nonce,pid,processStart,socketPath,version'
    || lease.hostBindingFingerprint !== hostBindingFingerprint
    || !Number.isSafeInteger(lease.hostPid)
    || lease.hostPid < 2
    || typeof lease.hostProcessStart !== 'string'
    || lease.hostProcessStart.length < 1
    || !Number.isSafeInteger(lease.pid)
    || lease.pid < 1
    || typeof lease.processStart !== 'string'
    || lease.processStart.length < 1
    || lease.executable !== BROKER_EXECUTABLE
    || lease.entrypoint !== BROKER_ENTRYPOINT
    || !validBrokerSocketPath(lease.socketPath)
    || !HEX_64.test(lease.nonce)
  ) {
    throw new Error('host broker lease is invalid');
  }
  return lease;
}

function liveHostBroker(hostBinding) {
  try {
    const lease = parseHostLease(hostBinding.fingerprint);
    return lease.hostPid === hostBinding.pid
      && lease.hostProcessStart === hostBinding.processStart
      && brokerProcessMatches(lease)
      ? lease
      : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function claimHostLease(hostBinding, socketPath) {
  const path = hostLeasePath(hostBinding.fingerprint);
  const lock = acquireRegistryLock(`host-${hostBinding.fingerprint}`);
  const lease = {
    version: 2,
    pid: process.pid,
    processStart: processStartIdentity(process.pid),
    executable: BROKER_EXECUTABLE,
    entrypoint: BROKER_ENTRYPOINT,
    hostBindingFingerprint: hostBinding.fingerprint,
    hostPid: hostBinding.pid,
    hostProcessStart: hostBinding.processStart,
    socketPath,
    nonce: randomBytes(32).toString('hex'),
  };
  if (
    typeof lease.processStart !== 'string'
    || !hostProcessAlive(hostBinding)
  ) {
    releaseRegistryLock(lock);
    throw new Error('broker or host process identity is unavailable');
  }
  try {
    let existing = null;
    try {
      existing = parseHostLease(hostBinding.fingerprint);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing && brokerProcessMatches(existing)) {
      throw new Error('a live broker already owns this host process');
    }
    if (existing) {
      rmSync(path, { force: true });
      removeStaleSocket(existing.socketPath);
    }
    writeExclusiveState(path, lease);
    if (!brokerProcessMatches(lease)) {
      rmSync(path, { force: true });
      throw new Error('host broker process identity could not be verified');
    }
    return lease;
  } finally {
    releaseRegistryLock(lock);
  }
}

function releaseHostLease(lease) {
  if (!lease) return;
  let lock = null;
  try {
    lock = acquireRegistryLock(`host-${lease.hostBindingFingerprint}`);
    const current = parseHostLease(lease.hostBindingFingerprint);
    if (
      current.pid === lease.pid
      && current.processStart === lease.processStart
      && current.socketPath === lease.socketPath
      && current.nonce === lease.nonce
    ) {
      rmSync(hostLeasePath(lease.hostBindingFingerprint), { force: true });
    }
  } catch {
  } finally {
    if (lock) releaseRegistryLock(lock);
  }
}

function brokerRequest(socketPath, payload, timeout = 30 * 60 * 1000) {
  return new Promise((resolveRequest, rejectRequest) => {
    if (!validBrokerSocketPath(socketPath)) {
      rejectRequest(new Error('broker socket path is invalid'));
      return;
    }
    const socket = createConnection(socketPath);
    let settled = false;
    let output = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeout, () =>
      finish(new Error('broker request timed out')));
    socket.on('connect', () => {
      socket.end(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_INPUT_BYTES) {
        finish(new Error('broker response exceeds 1 MiB'));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      try {
        finish(null, JSON.parse(output));
      } catch {
        finish(new Error('broker returned invalid JSON'));
      }
    });
  });
}

async function requestSessionBroker(sessionFingerprint, operation, input) {
  const registry = readBrokerRegistry(sessionFingerprint);
  const result = await brokerRequest(
    registry.socketPath,
    { operation, input },
  );
  const retired = result?.brokerRetiredSessionFingerprints ?? [];
  if (
    !Array.isArray(retired)
    || retired.some((value) => !HEX_64.test(value))
    || new Set(retired).size !== retired.length
  ) {
    throw new Error('broker returned invalid retired sessions');
  }
  let current = null;
  try {
    current = readBrokerRegistry(sessionFingerprint);
  } catch (error) {
    if (!retired.includes(sessionFingerprint)) throw error;
  }
  if (
    current !== null
    && (
      current.pid !== registry.pid
      || current.processStart !== registry.processStart
      || current.socketPath !== registry.socketPath
      || current.nonce !== registry.nonce
    )
  ) {
    throw new Error('broker identity changed during the request');
  }
  const publicResult = { ...result };
  delete publicResult.brokerRetiredSessionFingerprints;
  const acknowledgement = result?.brokerTerminalAcknowledgement;
  if (acknowledgement === undefined) return publicResult;
  if (!HEX_64.test(acknowledgement)) {
    throw new Error('broker returned an invalid terminal acknowledgement');
  }
  const acknowledged = await brokerRequest(
    registry.socketPath,
    {
      operation: 'ack-terminal',
      input: { token: acknowledgement },
    },
  );
  if (!acknowledged.ok || acknowledged.value?.acknowledged !== true) {
    throw new Error('broker terminal acknowledgement failed');
  }
  delete publicResult.brokerTerminalAcknowledgement;
  return publicResult;
}

async function startSessionBroker(input) {
  ensureBrokerDirectory();
  purgeLegacyAuthorityKeys();
  const hostBinding = detectHostProcessBinding();
  if (hostBinding === null) {
    throw new Error('broker host process binding is unavailable');
  }
  const existing = liveHostBroker(hostBinding);
  if (existing !== null) {
    const result = await brokerRequest(
      existing.socketPath,
      { operation: 'attest-continuation', input },
    );
    if (result.ok) {
      const registry = readBrokerRegistry(result.value.sessionFingerprint);
      if (
        registry.pid !== existing.pid
        || registry.processStart !== existing.processStart
        || registry.socketPath !== existing.socketPath
      ) {
        throw new Error('continuation attestation changed broker identity');
      }
    }
    return result;
  }
  const socketPath = brokerSocketPath(
    `${randomBytes(16).toString('hex')}.sock`,
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--authority-broker',
      socketPath,
      BROKER_DIRECTORY,
    ],
    {
      detached: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          key !== 'NODE_OPTIONS'
          && !key.startsWith('AUTOLOOP_AUTHORITY_')),
      ),
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  let lastError = null;
  let childProcessStart = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    childProcessStart ??= processStartIdentity(child.pid);
    try {
      const result = await brokerRequest(
        socketPath,
        { operation: 'attest-host', input },
        15000,
      );
      if (result.ok) {
        const registry = readBrokerRegistry(
          result.value.sessionFingerprint,
        );
        if (
          registry.pid !== child.pid
          || registry.socketPath !== socketPath
        ) {
          throw new Error('new broker did not claim its own registry');
        }
      }
      return result;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  if (brokerCommandMatches({
    pid: child.pid,
    processStart: childProcessStart,
    socketPath,
  })) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {}
  }
  throw lastError ?? new Error('authority broker did not start');
}

function operationForName(name) {
  return Object.values(OPERATION_FLAGS)
    .find(([candidate]) => candidate === name)?.[1] ?? null;
}

export function formatRunScope(run) {
  if (run?.scope?.scope !== 'bounded') {
    return run?.scope?.autoContinue === true ? 'scope queue+auto' : 'scope queue';
  }
  return run.scope.issue !== undefined
    ? `scope bounded(#${run.scope.issue})`
    : `scope bounded(${run.scope.maxUnits})`;
}

function readJsonInput(path) {
  const bytes = readFileSync(path === '-' ? 0 : path);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('input exceeds 1 MiB');
  return JSON.parse(bytes.toString('utf8'));
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test', path: null, error: null };
  }
  if (
    args.length === 2
    && Object.hasOwn(OPERATION_FLAGS, args[0])
    && typeof args[1] === 'string'
    && args[1].length > 0
  ) {
    return {
      mode: OPERATION_FLAGS[args[0]][0],
      path: args[1],
      error: null,
    };
  }
  return {
    mode: null,
    path: null,
    error:
      `expected ${Object.keys(OPERATION_FLAGS).join(', ')} <path|->, ` +
      'or --self-test',
  };
}

function brokerSessionsFor(input) {
  return [...collectSessionFingerprints(input)];
}

function createBrokerLedger() {
  const issued = {
    hostEvidence: new Set(),
    intents: new Map(),
    capabilities: new Map(),
    runs: new Map(),
    runArtifacts: new Map(),
    routeStates: new Map(),
    currentRouteStates: new Map(),
    plans: new Map(),
    compiledPlans: new Map(),
    attempts: new Map(),
    outcomes: new Map(),
    continuations: new Map(),
    handoffs: new Map(),
    completedTransfers: new Map(),
    authorizations: new Map(),
    schedules: new Map(),
    measurementRuns: new Map(),
  };
  const owns = (set, value) =>
    typeof value === 'string' && set.has(value);
  const ownsRun = (value) =>
    typeof value === 'string' && issued.runs.get(value) === 'issued';
  const ownsArtifact = (map, fingerprint, runFingerprint) =>
    typeof fingerprint === 'string'
    && map.get(fingerprint)?.runFingerprint === runFingerprint;
  const ownsExactArtifact = (map, value, runFingerprint) =>
    ownsArtifact(map, value?.fingerprint, runFingerprint)
    && isDeepStrictEqual(map.get(value.fingerprint).artifact, value);
  const ownsExactRun = (run) =>
    ownsRun(run?.instanceFingerprint)
    && isDeepStrictEqual(
      issued.runArtifacts.get(run.instanceFingerprint),
      run,
    );
  const scheduleFor = (runFingerprint) =>
    issued.schedules.get(runFingerprint);
  const expectedConcurrency = (schedule) => ({
    activeWriters: schedule.writerAttempt === null ? 0 : 1,
    stagedAhead:
      schedule.writerAttempt !== null
        && (
          schedule.reviewerAttempt !== null
          || schedule.stagedImplementationAuthorized
        )
        ? 1
        : 0,
    stagedAheadReadOnly: true,
  });
  const exactConcurrency = (work, schedule) => {
    const expected = expectedConcurrency(schedule);
    return work?.concurrency?.activeWriters === expected.activeWriters
      && work?.concurrency?.stagedAhead === expected.stagedAhead
      && work?.concurrency?.stagedAheadReadOnly
        === expected.stagedAheadReadOnly;
  };
  const trackAuthorization = (value, runFingerprint = null) => {
    if (!value || typeof value !== 'object') return;
    if (HEX_64.test(value.authorization ?? '')) {
      const existing = issued.authorizations.get(value.authorization);
      issued.authorizations.set(value.authorization, {
        runFingerprint:
          runFingerprint ?? existing?.runFingerprint ?? null,
      });
    }
  };
  const bindCapability = (fingerprint, runFingerprint) => {
    const capability = issued.capabilities.get(fingerprint);
    if (
      !capability
      || capability.runFingerprint !== null
        && capability.runFingerprint !== runFingerprint
    ) {
      return false;
    }
    capability.runFingerprint = runFingerprint;
    if (HEX_64.test(capability.authorization ?? '')) {
      issued.authorizations.set(capability.authorization, { runFingerprint });
    }
    return true;
  };
  const revokeRun = (runFingerprint) => {
    issued.runs.set(runFingerprint, 'consumed');
    for (const map of [
      issued.capabilities,
      issued.routeStates,
      issued.plans,
      issued.compiledPlans,
      issued.attempts,
      issued.outcomes,
    ]) {
      for (const [fingerprint, value] of map) {
        if (value.runFingerprint === runFingerprint) map.delete(fingerprint);
      }
    }
    for (const [authorization, value] of issued.authorizations) {
      if (value.runFingerprint === runFingerprint) {
        issued.authorizations.delete(authorization);
      }
    }
    issued.schedules.delete(runFingerprint);
    issued.currentRouteStates.delete(runFingerprint);
    issued.runArtifacts.delete(runFingerprint);
    for (const [measurementRunId, measurement] of issued.measurementRuns) {
      if (measurement.runFingerprint === runFingerprint) {
        issued.measurementRuns.delete(measurementRunId);
      }
    }
  };
  const completeContinuationTransfer = (continuation) => {
    if (
      continuation.transferCompleted
      || continuation.status !== 'prompted'
      || continuation.targetRunFingerprint === null
    ) {
      return;
    }
    continuation.transferCompleted = true;
    revokeRun(continuation.sourceRunFingerprint);
    issued.completedTransfers.set(continuation.leaseFingerprint, {
      sourceSessionFingerprint: continuation.sourceSessionFingerprint,
      targetSessionFingerprint: continuation.targetSessionFingerprint,
      targetTerminal: continuation.targetTerminal,
    });
  };
  const authorize = (name, input) => {
    if (name === 'probe') {
      return owns(issued.hostEvidence, input?.hostEvidence?.fingerprint)
        && ownsExactRun(input?.run)
        && input.run.hostEvidenceFingerprint
          === input.hostEvidence.fingerprint
        && input.run.sessionFingerprint
          === input.hostEvidence.sessionFingerprint
        && Array.isArray(input.routes)
        && input.routes.length >= 1
        && input.routes.length <= 2
        && input.routes[0] === input.run.requestedRoute
        && (
          input.routes.length === 1
          || (
            !input.run.requestedRoute.endsWith('.native')
            && input.routes[1] === `${input.run.activeHost}.native`
          )
        )
        && !Object.hasOwn(input, 'invocationNonce');
    }
    if (name === 'open') {
      const hostEvidenceFingerprint = input?.hostEvidence?.fingerprint;
      const handoff = issued.handoffs.get(hostEvidenceFingerprint);
      const continuation = handoff === undefined
        ? null
        : issued.continuations.get(handoff.leaseFingerprint);
      const continuationFields = [
        input?.continuation,
        input?.continuationLease,
        input?.continuationState,
        input?.continuationAuthorization,
      ];
      const exactHandoff = handoff === undefined
        ? continuationFields.every((value) => value === undefined)
        : (
          handoff.status === 'issued'
          && ['opened', 'prompted'].includes(continuation?.status)
          && continuation.promptEffectFingerprint !== null
          && continuation.targetRunFingerprint === null
          && continuation.targetSessionFingerprint
            === input.hostEvidence.sessionFingerprint
          && isDeepStrictEqual(
            input.continuationLease,
            continuation.leaseArtifact,
          )
          && isDeepStrictEqual(
            input.continuationState,
            continuation.openedState,
          )
          && isDeepStrictEqual(
            input.continuationAuthorization,
            continuation.continuationAuthorization,
          )
          && isDeepStrictEqual(
            input.continuation,
            continuation.envelope,
          )
        );
      return owns(issued.hostEvidence, hostEvidenceFingerprint)
        && issued.intents.has(input.hostEvidence.fingerprint)
        && !Object.hasOwn(input, 'invocation')
        && !Object.hasOwn(input, 'config')
        && exactHandoff;
    }
    if (name === 'initialize-route-state') {
      const runFingerprint = input?.run?.instanceFingerprint;
      const capability = issued.capabilities.get(
        input?.capabilities?.fingerprint,
      );
      return ownsRun(runFingerprint)
        && capability !== undefined
        && [null, runFingerprint].includes(capability.runFingerprint);
    }
    if (name === 'refresh-route-state') {
      const runFingerprint = input?.run?.instanceFingerprint;
      const next = issued.capabilities.get(input?.capabilities?.fingerprint);
      return ownsRun(runFingerprint)
        && ownsArtifact(
          issued.routeStates,
          input?.routeState?.fingerprint,
          runFingerprint,
        )
        && ownsArtifact(
          issued.capabilities,
          input?.previousCapabilities?.fingerprint,
          runFingerprint,
        )
        && next !== undefined
        && [null, runFingerprint].includes(next.runFingerprint);
    }
    if (name === 'plan') {
      const runFingerprint = input?.run?.instanceFingerprint;
      const schedule = scheduleFor(runFingerprint);
      const stage = input?.work?.stage;
      const role = stage === 'implementation'
        ? 'writer'
        : stage === 'doctor'
          ? 'probe'
          : 'reviewer';
      return ownsRun(runFingerprint)
        && schedule !== undefined
        && ownsArtifact(
          issued.capabilities,
          input?.capabilities?.fingerprint,
          runFingerprint,
        )
        && ownsArtifact(
          issued.routeStates,
          input?.routeState?.fingerprint,
          runFingerprint,
        )
        && exactConcurrency(input.work, schedule)
        && (
          role === 'probe'
          || role === 'writer'
            ? schedule.writerAttempt === null
              && schedule.reviewerAttempt === null
              && (
                input.work.flow !== 'dev'
                || schedule.implementationAuthorized
              )
            : schedule.reviewerAttempt === null
              && (
                schedule.writerAttempt === null
                || stage === 'plan-review'
              )
        )
        && (
          stage !== 'plan-review'
          || schedule.planReviewPlan === null
            && (
              schedule.writerAttempt === null
                ? !schedule.implementationAuthorized
                : !schedule.stagedImplementationAuthorized
            )
        );
    }
    if (name === 'compile') {
      const plan = issued.plans.get(input?.fingerprint);
      const schedule = scheduleFor(plan?.runFingerprint);
      return plan !== undefined
        && schedule !== undefined
        && ownsRun(plan.runFingerprint)
        && !issued.compiledPlans.has(input.fingerprint)
        && (
          plan.role === 'writer'
            ? schedule.writerAttempt === null
              && schedule.reviewerAttempt === null
            : plan.role === 'probe'
              ? schedule.writerAttempt === null
                && schedule.reviewerAttempt === null
              : schedule.reviewerAttempt === null
                && (
                  schedule.writerAttempt === null
                  || plan.stage === 'plan-review'
                )
        )
        && (
          plan.stage !== 'plan-review'
          || schedule.planReviewPlan === input.fingerprint
        );
    }
    if (name === 'execute') {
      const state = issued.attempts.get(input?.attempt?.fingerprint);
      return state?.status === 'issued'
        && ownsRun(state.runFingerprint)
        && input.attempt.launch?.transport === 'process'
        && isDeepStrictEqual(state.artifact, input.attempt);
    }
    if (name === 'observe') {
      const runFingerprint = input?.run?.instanceFingerprint;
      const outcome = issued.outcomes.get(input?.outcome?.fingerprint);
      return ownsRun(runFingerprint)
        && ownsArtifact(
          issued.routeStates,
          input?.routeState?.fingerprint,
          runFingerprint,
        )
        && ownsArtifact(
          issued.plans,
          input?.plan?.fingerprint,
          runFingerprint,
        )
        && outcome?.status === 'issued'
        && outcome.runFingerprint === runFingerprint
        && outcome.planFingerprint === input?.plan?.fingerprint;
    }
    if (name === 'observe-measured') {
      if (
        !input
        || typeof input !== 'object'
        || Array.isArray(input)
        || Object.keys(input).sort().join(',')
          !== 'outcome,plan,routeState,run,runId'
        || !UUID_V4.test(input.runId ?? '')
      ) {
        return false;
      }
      const { runId, ...observeInput } = input;
      const measurement = issued.measurementRuns.get(runId);
      return measurement?.runFingerprint === input.run.instanceFingerprint
        && measurement.unitBinding !== undefined
        && (
          measurement.observedDispatches > 0
          || input.plan?.fingerprint
            === measurement.unitBinding.planFingerprint
        )
        && authorize('observe', observeInput);
    }
    if (name === 'bind-measurement') {
      if (
        !input
        || typeof input !== 'object'
        || Array.isArray(input)
        || Object.keys(input).sort().join(',') !== 'measurement,run'
        || !UUID_V4.test(input.measurement?.runId ?? '')
      ) {
        return false;
      }
      const runFingerprint = input.run.instanceFingerprint;
      const runId = input.measurement.runId;
      const boundRun = issued.measurementRuns.get(runId)?.runFingerprint;
      return ownsExactRun(input.run)
        && validateRuntimeRun(input.run)
        && [undefined, runFingerprint].includes(boundRun);
    }
    if (name === 'bind-measurement-unit') {
      if (
        !input
        || typeof input !== 'object'
        || Array.isArray(input)
        || Object.keys(input).sort().join(',') !== 'plan,run,runId,unitId'
        || !UUID_V4.test(input.runId ?? '')
        || !MEASUREMENT_UNIT_ID.test(input.unitId ?? '')
      ) {
        return false;
      }
      const runFingerprint = input.run?.instanceFingerprint;
      const measurement = issued.measurementRuns.get(input.runId);
      const retainedPlan = issued.plans.get(input.plan?.fingerprint);
      const expectedBinding = {
        unitId: input.unitId,
        planFingerprint: input.plan?.fingerprint,
      };
      return measurement?.runFingerprint === runFingerprint
        && (
          measurement.unitBinding === undefined
          || isDeepStrictEqual(measurement.unitBinding, expectedBinding)
        )
        && [undefined, input.runId].includes(retainedPlan?.measurementRunId)
        && ownsExactRun(input.run)
        && validateRuntimeRun(input.run)
        && ownsExactArtifact(issued.plans, input.plan, runFingerprint);
    }
    if (name === 'finish') {
      return ownsRun(input?.run?.instanceFingerprint);
    }
    if (name === 'transition-continuation') {
      const continuation = issued.continuations.get(
        input?.lease?.fingerprint,
      );
      return continuation?.stateFingerprint === input?.state?.fingerprint
        && continuation.status === input?.state?.status
        && (
          input?.nextStatus !== 'prompted'
          || continuation.promptEffectFingerprint !== null
        );
    }
    if (name === 'prepare-continuation-prompt') {
      const continuation = issued.continuations.get(
        input?.lease?.fingerprint,
      );
      return validContinuationPromptPreparation(input, continuation);
    }
    if (name === 'validate-continuation-history') {
      const continuation = issued.continuations.get(
        input?.lease?.fingerprint,
      );
      return continuation !== undefined
        && Array.isArray(input?.states)
        && input.states.length > 0
        && input.states.every((state) =>
          continuation.states.has(state?.fingerprint));
    }
    return false;
  };
  const begin = (name, input) => {
    if (name === 'execute') {
      issued.attempts.get(input.attempt.fingerprint).status = 'in-flight';
    }
  };
  const prepare = (name, input) => {
    if (name === 'probe') {
      return {
        hostEvidence: input.hostEvidence,
        invocationNonce: input.run.invocationNonce,
        routes: input.routes,
        cwd: input.cwd,
      };
    }
    if (name !== 'open') return input;
    const captured = issued.intents.get(input?.hostEvidence?.fingerprint);
    if (captured === undefined) return null;
    return {
      ...input,
      invocation: captured.invocation,
      intentProvenance: captured.intentProvenance,
      config: structuredClone(captured.config),
    };
  };
  const fail = (name, input) => {
    if (name === 'execute') {
      issued.attempts.get(input.attempt.fingerprint).status = 'consumed';
    }
  };
  const retain = (name, input, result) => {
    if (!result.ok) return;
    const value = result.value;
    if (name === 'attest-host') {
      issued.hostEvidence.add(value.fingerprint);
      if (input.capturedIntent) {
        issued.intents.set(
          value.fingerprint,
          structuredClone(input.capturedIntent),
        );
      }
      trackAuthorization(value);
    }
    if (name === 'probe') {
      const invocationNonce = input.invocationNonce;
      const runFingerprint = invocationNonce === undefined
        ? null
        : [...issued.runArtifacts.entries()]
          .find(([, run]) =>
            run.invocationNonce === invocationNonce
            && run.sessionFingerprint === value.sessionFingerprint)?.[0];
      if (invocationNonce !== undefined && runFingerprint === undefined) {
        throw new Error('capability result has no exact broker-issued run');
      }
      issued.capabilities.set(value.fingerprint, {
        artifact: structuredClone(value),
        authorization: value.authorization,
        runFingerprint,
      });
      trackAuthorization(value);
    }
    if (name === 'open') {
      const handoff = issued.handoffs.get(input.hostEvidence.fingerprint);
      issued.intents.delete(input.hostEvidence.fingerprint);
      issued.runs.set(value.instanceFingerprint, 'issued');
      issued.runArtifacts.set(
        value.instanceFingerprint,
        structuredClone(value),
      );
      issued.schedules.set(value.instanceFingerprint, {
        writerAttempt: null,
        reviewerAttempt: null,
        planReviewPlan: null,
        planReviewTarget: null,
        implementationAuthorized: false,
        stagedImplementationAuthorized: false,
      });
      trackAuthorization(value, value.instanceFingerprint);
      if (handoff !== undefined) {
        const continuation = issued.continuations.get(
          handoff.leaseFingerprint,
        );
        handoff.status = 'consumed';
        continuation.targetRunFingerprint = value.instanceFingerprint;
        completeContinuationTransfer(continuation);
      }
    }
    if (name === 'bind-measurement') {
      const runFingerprint = input.run.instanceFingerprint;
      const runId = input.measurement.runId;
      const previous = issued.measurementRuns.get(runId);
      issued.measurementRuns.set(runId, {
        runFingerprint,
        unitBinding: previous?.unitBinding,
        observedDispatches: previous?.observedDispatches ?? 0,
      });
    }
    if (name === 'bind-measurement-unit') {
      const measurement = issued.measurementRuns.get(input.runId);
      measurement.unitBinding = {
        unitId: input.unitId,
        planFingerprint: input.plan.fingerprint,
      };
      issued.plans.get(input.plan.fingerprint).measurementRunId = input.runId;
    }
    if (
      ['initialize-route-state', 'refresh-route-state'].includes(name)
    ) {
      const runFingerprint = input.run.instanceFingerprint;
      bindCapability(input.capabilities.fingerprint, runFingerprint);
      issued.routeStates.set(value.fingerprint, {
        artifact: structuredClone(value),
        runFingerprint,
      });
      issued.currentRouteStates.set(runFingerprint, value.fingerprint);
      trackAuthorization(value, runFingerprint);
    }
    if (name === 'plan') {
      const runFingerprint = input.run.instanceFingerprint;
      issued.plans.set(value.fingerprint, {
        artifact: structuredClone(value),
        runFingerprint,
        role: value.role,
        stage: value.stage,
        measurementRunId: undefined,
      });
      if (value.stage === 'plan-review') {
        const schedule = scheduleFor(runFingerprint);
        schedule.planReviewPlan = value.fingerprint;
        schedule.planReviewTarget =
          schedule.writerAttempt === null ? 'current' : 'staged';
      }
      trackAuthorization(value, runFingerprint);
    }
    if (name === 'compile') {
      const runFingerprint =
        issued.plans.get(input.fingerprint).runFingerprint;
      issued.compiledPlans.set(input.fingerprint, { runFingerprint });
      issued.attempts.set(value.fingerprint, {
        artifact: structuredClone(value),
        planFingerprint: input.fingerprint,
        role: value.role,
        runFingerprint,
        status: 'issued',
      });
      const schedule = scheduleFor(runFingerprint);
      if (value.role === 'writer') {
        schedule.implementationAuthorized = false;
        schedule.writerAttempt = value.fingerprint;
      } else if (value.role === 'reviewer') {
        schedule.reviewerAttempt = value.fingerprint;
      }
      trackAuthorization(value, runFingerprint);
    }
    if (name === 'execute') {
      const attempt = issued.attempts.get(input.attempt.fingerprint);
      attempt.status = 'consumed';
      issued.outcomes.set(value.outcome.fingerprint, {
        planFingerprint: attempt.planFingerprint,
        runFingerprint: attempt.runFingerprint,
        status: 'issued',
      });
      trackAuthorization(value.outcome, attempt.runFingerprint);
    }
    if (name === 'observe') {
      const runFingerprint = input.run.instanceFingerprint;
      issued.outcomes.get(input.outcome.fingerprint).status = 'consumed';
      const schedule = scheduleFor(runFingerprint);
      if (input.plan.role === 'writer') {
        schedule.writerAttempt = null;
      } else if (input.plan.role === 'reviewer') {
        schedule.reviewerAttempt = null;
      }
      issued.routeStates.set(
        value.routeState.fingerprint,
        {
          artifact: structuredClone(value.routeState),
          runFingerprint,
        },
      );
      issued.currentRouteStates.set(
        runFingerprint,
        value.routeState.fingerprint,
      );
      if (value.nextPlan?.fingerprint) {
        issued.plans.set(value.nextPlan.fingerprint, {
          artifact: structuredClone(value.nextPlan),
          runFingerprint,
          role: value.nextPlan.role,
          stage: value.nextPlan.stage,
          measurementRunId: undefined,
        });
        if (value.nextPlan.stage === 'plan-review') {
          schedule.planReviewPlan = value.nextPlan.fingerprint;
        }
      } else if (input.plan.stage === 'plan-review') {
        if (schedule.planReviewTarget === 'current') {
          schedule.implementationAuthorized = true;
        } else {
          schedule.stagedImplementationAuthorized = true;
        }
        schedule.planReviewPlan = null;
        schedule.planReviewTarget = null;
      } else if (input.plan.stage === 'implementation') {
        if (value.nextPlan?.role === 'writer') {
          schedule.implementationAuthorized = true;
        } else {
          schedule.implementationAuthorized =
            schedule.stagedImplementationAuthorized;
          schedule.stagedImplementationAuthorized = false;
        }
      }
      trackAuthorization(value.routeState, runFingerprint);
      trackAuthorization(value.nextPlan, runFingerprint);
      trackAuthorization(value.receipt, runFingerprint);
    }
    if (name === 'observe-measured') {
      issued.measurementRuns.get(input.runId).observedDispatches += 1;
    }
    if (name === 'finish' && value.action === 'relaunch') {
      issued.continuations.set(value.lease.fingerprint, {
        leaseFingerprint: value.lease.fingerprint,
        leaseArtifact: structuredClone(value.lease),
        envelope: structuredClone(value.envelope),
        sourceRunFingerprint: input.run.instanceFingerprint,
        sourceSessionFingerprint: input.run.sessionFingerprint,
        targetSessionFingerprint: null,
        openedState: null,
        continuationAuthorization: null,
        promptEffectFingerprint: null,
        handoffEvidenceFingerprint: null,
        targetRunFingerprint: null,
        targetTerminal: false,
        transferCompleted: false,
        stateFingerprint: value.continuationState.fingerprint,
        status: value.continuationState.status,
        states: new Set([value.continuationState.fingerprint]),
      });
      trackAuthorization(value.lease);
      trackAuthorization(value.continuationState);
    }
    if (name === 'finish' && value.action === 'stop') {
      const continuation = [...issued.continuations.values()].find(
        (candidate) =>
          candidate.targetRunFingerprint === input.run.instanceFingerprint
          && !candidate.transferCompleted,
      );
      if (continuation) continuation.targetTerminal = true;
      revokeRun(input.run.instanceFingerprint);
    }
    if (name === 'transition-continuation') {
      const continuation = issued.continuations.get(input.lease.fingerprint);
      continuation.stateFingerprint = value.state.fingerprint;
      continuation.status = value.state.status;
      continuation.states.add(value.state.fingerprint);
      continuation.targetSessionFingerprint =
        value.state.sessionFingerprint
        ?? continuation.targetSessionFingerprint;
      if (value.state.status === 'opened') {
        continuation.openedState = structuredClone(value.state);
        continuation.continuationAuthorization =
          structuredClone(value.authorization);
      }
      trackAuthorization(value.state);
      trackAuthorization(value.authorization);
      completeContinuationTransfer(continuation);
    }
    if (name === 'prepare-continuation-prompt') {
      const continuation = issued.continuations.get(input.lease.fingerprint);
      continuation.promptEffectFingerprint = input.effect.fingerprint;
    }
  };
  const authorizeContinuationAttestation = (prepared) => {
    if (
      prepared?.ledgerInput?.capturedIntent?.invocation !== RELAUNCH_PROMPT
      || prepared.ledgerInput.capturedIntent.intentProvenance
        !== INTENT_PROVENANCE
      || !HEX_64.test(
        prepared.ledgerInput.targetSessionFingerprint ?? '',
      )
    ) {
      return null;
    }
    const matches = [...issued.continuations.values()].filter(
      (continuation) =>
        ['opened', 'prompted'].includes(continuation.status)
        && continuation.promptEffectFingerprint !== null
        && continuation.handoffEvidenceFingerprint === null
        && continuation.targetSessionFingerprint
          === prepared.ledgerInput.targetSessionFingerprint
        && continuation.openedState !== null
        && continuation.continuationAuthorization !== null,
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const retainContinuationAttestation = (prepared, result, continuation) => {
    const evidenceFingerprint = result.value.fingerprint;
    issued.hostEvidence.add(evidenceFingerprint);
    issued.intents.set(
      evidenceFingerprint,
      structuredClone(prepared.ledgerInput.capturedIntent),
    );
    trackAuthorization(result.value);
    continuation.handoffEvidenceFingerprint = evidenceFingerprint;
    issued.handoffs.set(evidenceFingerprint, {
      leaseFingerprint: continuation.leaseFingerprint,
      sourceRunFingerprint: continuation.sourceRunFingerprint,
      sourceSessionFingerprint: continuation.sourceSessionFingerprint,
      targetSessionFingerprint: continuation.targetSessionFingerprint,
      status: 'issued',
    });
  };
  const takeCompletedTransfer = (leaseFingerprint) => {
    const transfer = issued.completedTransfers.get(leaseFingerprint) ?? null;
    issued.completedTransfers.delete(leaseFingerprint);
    return transfer;
  };
  const continuationTransferPending = (runFingerprint) =>
    [...issued.continuations.values()].some(
      (continuation) =>
        continuation.targetRunFingerprint === runFingerprint
        && !continuation.transferCompleted,
    );
  const verify = (value, sessionFingerprint, authorization) =>
    issued.authorizations.has(authorization)
    && validateRuntimeAuthorization(
      value,
      sessionFingerprint,
      authorization,
    );
  const dispose = () => {};
  return {
    authorize,
    authorizeContinuationAttestation,
    begin,
    fail,
    prepare,
    retain,
    retainContinuationAttestation,
    takeCompletedTransfer,
    continuationTransferPending,
    verify,
    dispose,
  };
}

function inputBoundToBrokerSession(name, input, sessionFingerprint) {
  const requestSessions = brokerSessionsFor(input);
  if (
    [
      'prepare-continuation-prompt',
      'transition-continuation',
      'validate-continuation-history',
    ].includes(name)
    && input?.lease?.sessionFingerprint === sessionFingerprint
  ) {
    return requestSessions.length <= 2
      && requestSessions.includes(sessionFingerprint);
  }
  if (
    name === 'open'
    && input?.continuation !== undefined
    && input?.hostEvidence?.sessionFingerprint === sessionFingerprint
    && input?.continuationState?.sessionFingerprint === sessionFingerprint
  ) {
    return requestSessions.length === 2
      && requestSessions.includes(sessionFingerprint);
  }
  return requestSessions.length === 1
    && requestSessions[0] === sessionFingerprint;
}

function brokerTargetSession(name, input) {
  if (name === 'verify-authorization') {
    return input?.sessionFingerprint ?? null;
  }
  if (name === 'open') return input?.hostEvidence?.sessionFingerprint ?? null;
  if (
    [
      'prepare-continuation-prompt',
      'transition-continuation',
      'validate-continuation-history',
    ].includes(name)
  ) {
    return input?.lease?.sessionFingerprint ?? null;
  }
  const sessions = brokerSessionsFor(input);
  return sessions.length === 1 ? sessions[0] : null;
}

function terminalBrokerResult(request, result) {
  return request?.operation === 'finish'
      && result.ok
      && result.value.action === 'stop'
      && result.brokerTerminalDeferred !== true;
}

function createTerminalProtocol(
  dispatch,
  scheduleShutdown,
  fallbackDelay = 30000,
) {
  let pending = null;
  let fallbackTimer = null;
  const protocolDispatch = (request) => {
    if (request?.operation === 'ack-terminal') {
      if (
        !request.input
        || typeof request.input !== 'object'
        || Array.isArray(request.input)
        || Object.keys(request.input).join(',') !== 'token'
        || request.input.token !== pending
      ) {
        return brokerFailure(
          'INVALID_TERMINAL_ACKNOWLEDGEMENT',
          'terminal acknowledgement is invalid',
        );
      }
      pending = null;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = null;
      return { ok: true, value: { acknowledged: true } };
    }
    if (pending !== null) {
      return brokerFailure(
        'BROKER_TERMINATING',
        'broker is awaiting terminal delivery acknowledgement',
      );
    }
    const result = dispatch(request);
    if (!terminalBrokerResult(request, result)) return result;
    pending = randomBytes(32).toString('hex');
    fallbackTimer = setTimeout(() => scheduleShutdown(0), fallbackDelay);
    fallbackTimer.unref();
    return { ...result, brokerTerminalAcknowledgement: pending };
  };
  const onResponse = (request, result, socket) => {
    if (
      request?.operation === 'ack-terminal'
      && result.ok
      && result.value?.acknowledged === true
    ) {
      socket.once('finish', () => scheduleShutdown(0));
    }
  };
  const dispose = () => {
    pending = null;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };
  return { dispatch: protocolDispatch, onResponse, dispose };
}

function createBrokerDispatch({
  sessions,
  ledger,
  registerSession,
  bindMeasurement = null,
  bindMeasurementUnit = null,
  captureMeasurement = null,
  completeContinuation = () => {},
  repositoryRoot = null,
  prepareAttestation = (input) => ({
    operationInput: input,
    ledgerInput: input,
  }),
  prepareContinuationAttestation = prepareAttestation,
  invoke = (name, input) => operationForName(name)(input),
}) {
  const rejectUnissued = () => brokerFailure(
    'UNISSUED_BROKER_CAPABILITY',
    'operation input was not issued by this broker',
  );
  return (request) => {
    if (
      !request
      || typeof request !== 'object'
      || Array.isArray(request)
      || Object.keys(request).sort().join(',') !== 'input,operation'
      || typeof request.operation !== 'string'
    ) {
      return brokerFailure(
        'INVALID_BROKER_REQUEST',
        'broker request has an invalid shape',
      );
    }
    if (request.operation === 'verify-authorization') {
      const input = request.input;
      if (
        !input
        || typeof input !== 'object'
        || Array.isArray(input)
        || Object.keys(input).sort().join(',')
          !== 'authorization,sessionFingerprint,value'
        || !sessions.has(input.sessionFingerprint)
      ) {
        return brokerFailure(
          'INVALID_BROKER_REQUEST',
          'authorization verification request is invalid',
        );
      }
      return {
        ok: true,
        value: {
          valid: ledger.verify(
            input.value,
            input.sessionFingerprint,
            input.authorization,
          ),
        },
      };
    }
    if (request.operation === 'attest-continuation') {
      let prepared;
      try {
        prepared = prepareContinuationAttestation(request.input);
      } catch (error) {
        return brokerFailure(
          'INVALID_CONTINUATION_HANDOFF',
          `continuation intent is unavailable: ${error.message}`,
        );
      }
      const continuation = ledger.authorizeContinuationAttestation(
        prepared,
      );
      if (continuation === null) {
        return brokerFailure(
          'INVALID_CONTINUATION_HANDOFF',
          'target session is not the one-use prepared continuation',
        );
      }
      const result = invoke('attest-host', prepared.operationInput, issueHostEvidence);
      if (!result.ok) return result;
      if (
        result.value.sessionFingerprint
        !== prepared.ledgerInput.targetSessionFingerprint
      ) {
        clearRuntimeAuthority(result.value.sessionFingerprint);
        return brokerFailure(
          'INVALID_CONTINUATION_HANDOFF',
          'target attestation changed its bound continuation session',
        );
      }
      let claim;
      try {
        claim = registerSession(result.value.sessionFingerprint);
      } catch {
        clearRuntimeAuthority(result.value.sessionFingerprint);
        return brokerFailure(
          'BROKER_REGISTRY_UNAVAILABLE',
          'target continuation registry could not be claimed',
        );
      }
      if (!claim.claimed) {
        clearRuntimeAuthority(result.value.sessionFingerprint);
        return brokerFailure(
          'BROKER_SESSION_EXISTS',
          'a live broker already owns the continuation session',
        );
      }
      sessions.add(result.value.sessionFingerprint);
      ledger.retainContinuationAttestation(prepared, result, continuation);
      return result;
    }
    const operation = operationForName(request.operation);
    if (!operation) {
      return brokerFailure(
        'INVALID_BROKER_OPERATION',
        'broker operation is not in the closed contract',
      );
    }
    if (request.operation === 'attest-host') {
      if (sessions.size !== 0) {
        return brokerFailure(
          'BROKER_ALREADY_ATTESTED',
          'host attestation is closed after broker initialization',
        );
      }
      let prepared;
      try {
        prepared = prepareAttestation(request.input);
      } catch (error) {
        return brokerFailure(
          'INVALID_HOST_ATTESTATION',
          `best-effort host intent is unavailable: ${error.message}`,
        );
      }
      const result = invoke(
        request.operation,
        prepared.operationInput,
        operation,
      );
      if (!result.ok) return result;
      const sessionFingerprint = result.value.sessionFingerprint;
      let claim;
      try {
        claim = registerSession(sessionFingerprint);
      } catch {
        clearRuntimeAuthority(sessionFingerprint);
        return brokerFailure(
          'BROKER_REGISTRY_UNAVAILABLE',
          'broker session registry could not be claimed',
        );
      }
      if (!claim.claimed) {
        clearRuntimeAuthority(sessionFingerprint);
        return brokerFailure(
          'BROKER_SESSION_EXISTS',
          'a live broker already owns this host session',
        );
      }
      sessions.add(sessionFingerprint);
      ledger.retain(request.operation, prepared.ledgerInput, result);
      return result;
    }
    const sessionFingerprint = brokerTargetSession(
      request.operation,
      request.input,
    );
    if (
      !sessions.has(sessionFingerprint)
      || !inputBoundToBrokerSession(
        request.operation,
        request.input,
        sessionFingerprint,
      )
    ) {
      return brokerFailure(
        'INVALID_BROKER_SESSION',
        'typed operation is not bound to this broker session',
      );
    }
    if (request.operation === 'prepare-continuation-prompt') {
      if (!ledger.authorize(request.operation, request.input)) {
        return rejectUnissued();
      }
      const result = {
        ok: true,
        value: {
          leaseFingerprint: request.input.lease.fingerprint,
          stateFingerprint: request.input.state.fingerprint,
          effectFingerprint: request.input.effect.fingerprint,
          targetSessionFingerprint:
            request.input.session.sessionFingerprint,
          prepared: true,
        },
      };
      ledger.retain(request.operation, request.input, result);
      return result;
    }
    if (
      request.operation === 'probe'
      && (
        typeof repositoryRoot !== 'string'
        || typeof request.input?.cwd !== 'string'
        || (() => {
          try {
            return realpathSync(request.input.cwd) !== repositoryRoot;
          } catch {
            return true;
          }
        })()
      )
    ) {
      return brokerFailure(
        'INVALID_CAPABILITY_ATTESTATION',
        'capability probe cwd is not the broker repository root',
      );
    }
    if (request.operation === 'bind-measurement') {
      if (!ledger.authorize(request.operation, request.input)) {
        return rejectUnissued();
      }
      if (
        typeof bindMeasurement !== 'function'
        || typeof repositoryRoot !== 'string'
      ) {
        return brokerFailure(
          'MEASUREMENT_BIND_FAILED',
          'measurement binding authority is unavailable',
        );
      }
      let result;
      try {
        result = bindMeasurement(request.input, repositoryRoot);
      } catch (error) {
        return brokerFailure(
          'MEASUREMENT_BIND_FAILED',
          `measurement binding failed: ${error.message}`,
        );
      }
      if (
        result?.ok !== true
        || result.value?.runId !== request.input.measurement.runId
        || result.value?.runInstanceFingerprint
          !== request.input.run.instanceFingerprint
      ) {
        return result?.ok === false
          ? result
          : brokerFailure(
              'MEASUREMENT_BIND_FAILED',
              'measurement binding returned mismatched authority',
            );
      }
      ledger.retain(request.operation, request.input, result);
      return result;
    }
    if (request.operation === 'bind-measurement-unit') {
      if (!ledger.authorize(request.operation, request.input)) {
        return rejectUnissued();
      }
      if (
        typeof bindMeasurementUnit !== 'function'
        || typeof repositoryRoot !== 'string'
      ) {
        return brokerFailure(
          'MEASUREMENT_UNIT_BIND_FAILED',
          'measurement unit binding authority is unavailable',
        );
      }
      let result;
      try {
        result = bindMeasurementUnit(request.input, repositoryRoot);
      } catch (error) {
        return brokerFailure(
          'MEASUREMENT_UNIT_BIND_FAILED',
          `measurement unit binding failed: ${error.message}`,
        );
      }
      if (
        result?.ok !== true
        || result.value?.runId !== request.input.runId
        || result.value?.runInstanceFingerprint
          !== request.input.run.instanceFingerprint
        || result.value?.unitId !== request.input.unitId
        || result.value?.planFingerprint !== request.input.plan.fingerprint
      ) {
        return result?.ok === false
          ? result
          : brokerFailure(
              'MEASUREMENT_UNIT_BIND_FAILED',
              'measurement unit binding returned mismatched authority',
            );
      }
      ledger.retain(request.operation, request.input, result);
      return result;
    }
    if (request.operation === 'observe-measured') {
      if (!ledger.authorize(request.operation, request.input)) {
        return rejectUnissued();
      }
      const { runId, ...observeInput } = request.input;
      const result = invoke('observe', observeInput, observe);
      if (!result.ok || result.value?.receipt === undefined) {
        ledger.retain('observe', observeInput, result);
        if (result.ok) {
          ledger.retain('observe-measured', request.input, result);
        }
        return result;
      }
      if (
        typeof captureMeasurement !== 'function'
        || typeof repositoryRoot !== 'string'
      ) {
        return brokerFailure(
          'MEASUREMENT_CAPTURE_FAILED',
          'measurement capture authority is unavailable',
        );
      }
      let captured;
      try {
        captured = captureMeasurement(
          { runId, receipt: result.value.receipt },
          repositoryRoot,
        );
      } catch (error) {
        return brokerFailure(
          'MEASUREMENT_CAPTURE_FAILED',
          `measurement capture failed: ${error.message}`,
        );
      }
      if (captured?.ok !== true || captured.value?.runId !== runId) {
        return captured?.ok === false
          ? captured
          : brokerFailure(
              'MEASUREMENT_CAPTURE_FAILED',
              'measurement capture returned mismatched authority',
            );
      }
      ledger.retain('observe', observeInput, result);
      ledger.retain('observe-measured', request.input, result);
      return result;
    }
    if (!ledger.authorize(request.operation, request.input)) {
      return rejectUnissued();
    }
    const operationInput = ledger.prepare(
      request.operation,
      request.input,
    );
    if (operationInput === null) return rejectUnissued();
    ledger.begin(request.operation, operationInput);
    const result = invoke(request.operation, operationInput, operation);
    if (!result.ok) ledger.fail(request.operation, operationInput);
    if (
      request.operation === 'observe'
      && result.ok
      && result.value?.receipt !== undefined
      && operationInput.run.invocationFlow !== 'doctor'
    ) {
      return brokerFailure(
        'MEASUREMENT_REQUIRED',
        'Dev and Pitcrew dispatch receipts require bound measurement capture',
      );
    }
    const deferredTerminal = request.operation === 'finish'
      && result.ok
      && result.value.action === 'stop'
      && ledger.continuationTransferPending(
        operationInput.run.instanceFingerprint,
      );
    ledger.retain(request.operation, operationInput, result);
    let completedTransfer = null;
    if (
      result.ok
      && (
        request.operation === 'transition-continuation'
        || request.operation === 'open'
          && request.input.continuation !== undefined
      )
    ) {
      const leaseFingerprint = request.operation === 'open'
        ? request.input.continuationLease.fingerprint
        : request.input.lease.fingerprint;
      const transfer = ledger.takeCompletedTransfer(
        leaseFingerprint,
      );
      if (transfer !== null) {
        completeContinuation(transfer);
        completedTransfer = transfer;
      }
    }
    const completed = deferredTerminal
      ? { ...result, brokerTerminalDeferred: true }
      : result;
    return completedTransfer === null
      ? completed
      : {
        ...completed,
        brokerRetiredSessionFingerprints: completedTransfer.targetTerminal
          ? [
            completedTransfer.sourceSessionFingerprint,
            completedTransfer.targetSessionFingerprint,
          ]
          : [completedTransfer.sourceSessionFingerprint],
      };
  };
}

function createBrokerServer(dispatch, onResponse, sockets = new Set()) {
  return createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let input = '';
    let finished = false;
    const respond = (result, request = null) => {
      if (finished) return;
      finished = true;
      onResponse(request, result, socket);
      socket.end(`${JSON.stringify(result)}\n`);
    };
    socket.setTimeout(30 * 60 * 1000, () =>
      respond(brokerFailure(
        'BROKER_TIMEOUT',
        'broker request timed out',
      )));
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
        respond(brokerFailure(
          'INVALID_BROKER_REQUEST',
          'broker request exceeds 1 MiB',
        ));
      }
    });
    socket.on('end', () => {
      if (finished) return;
      try {
        const lines = input.trimEnd().split('\n');
        if (lines.length !== 1) {
          respond(brokerFailure(
            'INVALID_BROKER_REQUEST',
            'broker accepts exactly one JSON request',
          ));
          return;
        }
        const request = JSON.parse(lines[0]);
        respond(dispatch(request), request);
      } catch {
        respond(brokerFailure(
          'INVALID_BROKER_REQUEST',
          'broker request is not valid JSON',
        ));
      }
    });
  });
}

function closeBrokerServer(server, sockets, cleanup) {
  if (server.listening) server.close();
  for (const socket of sockets) socket.destroy();
  cleanup();
}

async function listenBrokerServer(server, socketPath) {
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      chmodSync(socketPath, 0o600);
      resolveListen();
    });
  });
}

async function authorityBrokerMain(socketPath, stateDirectory) {
  if (
    stateDirectory !== BROKER_DIRECTORY
    || !validBrokerSocketPath(socketPath)
    || String(process.env.NODE_OPTIONS ?? '').trim() !== ''
    || process.execArgv.length !== 0
  ) {
    throw new Error('authority broker invocation is invalid');
  }
  ensureBrokerDirectory();
  purgeLegacyAuthorityKeys();
  const hostBinding = detectHostProcessBinding();
  if (hostBinding === null) {
    throw new Error('broker host process binding is unavailable');
  }
  const repositoryRoot = brokerCheckoutRoot();
  const sessions = new Set();
  const ledger = createBrokerLedger();
  const registries = new Map();
  const retiredSessions = new Set();
  let idleTimer = null;
  let shutdownTimer = null;
  let closing = false;
  let exitAfterClose = false;
  let hostLease = null;
  let stopHostMonitor = null;
  let terminalProtocol = null;
  let cleaned = false;
  const sockets = new Set();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    ledger.dispose();
    clearRuntimeAuthority();
    rmSync(socketPath, { force: true });
    if (idleTimer) clearTimeout(idleTimer);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    stopHostMonitor?.();
    stopHostMonitor = null;
    terminalProtocol?.dispose();
    for (const registry of registries.values()) {
      removeOwnedRegistry(registry);
    }
    registries.clear();
    releaseHostLease(hostLease);
    hostLease = null;
  };
  let server;
  const shutdown = (exitProcess = false) => {
    exitAfterClose ||= exitProcess;
    if (closing) return;
    closing = true;
    closeBrokerServer(server, sockets, cleanup);
    if (exitAfterClose) setImmediate(() => process.exit(0));
  };
  const scheduleShutdown = (delay = 250, exitProcess = false) => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => shutdown(exitProcess), delay);
  };
  const touchIdleDeadline = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => shutdown(),
      sessions.size === 0 ? 30000 : 30 * 60 * 1000,
    );
  };
  const dispatch = createBrokerDispatch({
    sessions,
    ledger,
    bindMeasurement: bindRuntimeMeasurement,
    bindMeasurementUnit: bindRuntimeMeasurementUnit,
    captureMeasurement: captureRuntimeDispatchMeasurement,
    repositoryRoot,
    prepareAttestation: (input) =>
      capturedAttestation(input, hostBinding),
    prepareContinuationAttestation: (input) =>
      continuationAttestation(input, hostBinding),
    completeContinuation: ({
      sourceSessionFingerprint,
      targetSessionFingerprint,
      targetTerminal,
    }) => {
      if (
        sourceSessionFingerprint === targetSessionFingerprint
        || !sessions.has(sourceSessionFingerprint)
        || !sessions.has(targetSessionFingerprint)
      ) {
        throw new Error('continuation transfer sessions are invalid');
      }
      const completedSessions = targetTerminal
        ? [sourceSessionFingerprint, targetSessionFingerprint]
        : [sourceSessionFingerprint];
      for (const sessionFingerprint of completedSessions) {
        sessions.delete(sessionFingerprint);
        retiredSessions.add(sessionFingerprint);
        clearRuntimeAuthority(sessionFingerprint);
      }
    },
    registerSession: (sessionFingerprint) => {
      const claim = claimBrokerRegistry(sessionFingerprint, socketPath);
      if (claim.claimed) {
        registries.set(sessionFingerprint, claim.registry);
      }
      return claim;
    },
  });
  terminalProtocol = createTerminalProtocol(dispatch, scheduleShutdown);
  server = createBrokerServer(terminalProtocol.dispatch, (
    request,
    result,
    socket,
  ) => {
    touchIdleDeadline();
    terminalProtocol.onResponse(request, result, socket);
    const retireAfterResponse = [...retiredSessions];
    retiredSessions.clear();
    if (retireAfterResponse.length > 0) {
      socket.once('finish', () => {
        for (const sessionFingerprint of retireAfterResponse) {
          const registry = registries.get(sessionFingerprint);
          if (registry) removeOwnedRegistry(registry);
          registries.delete(sessionFingerprint);
        }
      });
    }
    if (sessions.size === 0) {
      socket.once('finish', () => scheduleShutdown());
    }
  }, sockets);
  process.once('SIGINT', () => scheduleShutdown(0, true));
  process.once('SIGTERM', () => scheduleShutdown(0, true));
  process.once('exit', cleanup);
  await listenBrokerServer(server, socketPath);
  hostLease = claimHostLease(hostBinding, socketPath);
  stopHostMonitor = startHostLivenessMonitor(
    hostBinding,
    () => shutdown(true),
  );
  touchIdleDeadline();
}

function configFixture() {
  return {
    version: '0.25.0',
    baseBranch: 'main',
    gate: { command: 'npm test', quickCommand: null, setupCommand: null },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
    caps: {
      gateRetriesPerUnit: 2,
      reviseRoundsPerPr: 3,
      codeReviewRoundsPerUnit: 5,
      sliceMaxLines: 700,
      sliceMaxFiles: 10,
    },
  };
}

function hostFixture() {
  const result = issueHostEvidence({
    integration: 'run-scope-self-test',
    sessionId: 'self-test-session',
    observedSurface: { tool: 'worker' },
    expectedHost: 'claude',
  });
  if (!result.ok) throw new Error('host fixture did not attest');
  return result.value;
}

function brokerLedgerFixture(sessionFingerprint = 'c'.repeat(64)) {
  const ledger = createBrokerLedger();
  const withSession = (value) => ({ ...value, sessionFingerprint });
  const hostEvidence = withSession({ fingerprint: '1'.repeat(64) });
  const capabilities = withSession({ fingerprint: '2'.repeat(64) });
  const run = withSession({ instanceFingerprint: '3'.repeat(64) });
  const routeState = withSession({ fingerprint: '4'.repeat(64) });
  const writerPlan = withSession({
    fingerprint: '5'.repeat(64),
    role: 'writer',
    stage: 'implementation',
  });
  const reviewerPlan = withSession({
    fingerprint: '6'.repeat(64),
    role: 'reviewer',
    stage: 'code-review',
  });
  const writerAttempt = {
    fingerprint: '7'.repeat(64),
    sessionFingerprint,
    role: 'writer',
    launch: { transport: 'process' },
  };
  const reviewerAttempt = {
    fingerprint: '8'.repeat(64),
    sessionFingerprint,
    role: 'reviewer',
    launch: { transport: 'process' },
  };
  const writerOutcome = withSession({ fingerprint: 'b'.repeat(64) });
  ledger.retain('attest-host', {}, { ok: true, value: hostEvidence });
  ledger.retain('probe', { hostEvidence }, {
    ok: true,
    value: capabilities,
  });
  ledger.retain('open', { hostEvidence }, { ok: true, value: run });
  ledger.retain('initialize-route-state', { run, capabilities }, {
    ok: true,
    value: routeState,
  });
  ledger.retain('plan', { run, capabilities, routeState }, {
    ok: true,
    value: writerPlan,
  });
  ledger.retain('compile', writerPlan, {
    ok: true,
    value: writerAttempt,
  });
  ledger.retain('plan', { run, capabilities, routeState }, {
    ok: true,
    value: reviewerPlan,
  });
  ledger.retain('compile', reviewerPlan, {
    ok: true,
    value: reviewerAttempt,
  });
  return {
    ledger,
    run,
    routeState,
    writerPlan,
    reviewerPlan,
    writerAttempt,
    reviewerAttempt,
    writerOutcome,
  };
}

function brokerMeasurementFixture({
  flow = 'dev',
  hostEvidence = hostFixture(),
  ledger = createBrokerLedger(),
} = {}) {
  const opened = open({
    invocation: `/autoloop:${flow}`,
    intentProvenance: INTENT_PROVENANCE,
    hostEvidence,
    config: configFixture(),
  });
  if (!opened.ok) throw new Error('measurement fixture run did not open');
  const capabilities = issueCapabilitySnapshot({
    hostEvidence,
    invocationNonce: opened.value.invocationNonce,
    checkout: {
      root: '/tmp',
      repositoryFingerprint: 'd'.repeat(64),
      branch: 'main',
      headOid: 'e'.repeat(40),
      clean: true,
    },
    observations: [],
  });
  if (!capabilities.ok) {
    throw new Error('measurement fixture capabilities did not issue');
  }
  const routeState = initializeRouteState({
    run: opened.value,
    capabilities: capabilities.value,
  });
  if (!routeState.ok) {
    throw new Error('measurement fixture route state did not issue');
  }
  ledger.retain('attest-host', {}, { ok: true, value: hostEvidence });
  ledger.retain('probe', { hostEvidence }, capabilities);
  ledger.retain('open', { hostEvidence }, opened);
  ledger.retain(
    'initialize-route-state',
    { run: opened.value, capabilities: capabilities.value },
    routeState,
  );
  const planValue = {
    fingerprint: randomBytes(32).toString('hex'),
    role: flow === 'doctor' ? 'probe' : 'writer',
    stage: flow === 'doctor' ? 'doctor' : 'implementation',
    sessionFingerprint: opened.value.sessionFingerprint,
  };
  ledger.retain('plan', {
    run: opened.value,
    capabilities: capabilities.value,
    routeState: routeState.value,
  }, { ok: true, value: planValue });
  const attempt = {
    fingerprint: randomBytes(32).toString('hex'),
    role: planValue.role,
    launch: { transport: 'process' },
    sessionFingerprint: opened.value.sessionFingerprint,
  };
  ledger.retain('compile', planValue, { ok: true, value: attempt });
  const outcome = {
    fingerprint: randomBytes(32).toString('hex'),
    sessionFingerprint: opened.value.sessionFingerprint,
  };
  ledger.retain('execute', { attempt }, {
    ok: true,
    value: { outcome },
  });
  return {
    ledger,
    hostEvidence,
    run: opened.value,
    capabilities: capabilities.value,
    routeState: routeState.value,
    plan: planValue,
    outcome,
    observeInput: {
      run: opened.value,
      routeState: routeState.value,
      plan: planValue,
      outcome,
    },
  };
}

function brokerSchedulingSelfTest() {
  const ledger = createBrokerLedger();
  const sessionFingerprint = 'c'.repeat(64);
  const withSession = (value) => ({ ...value, sessionFingerprint });
  const hostEvidence = withSession({ fingerprint: '1'.repeat(64) });
  const capabilities = withSession({ fingerprint: '2'.repeat(64) });
  const run = withSession({ instanceFingerprint: '3'.repeat(64) });
  let routeState = withSession({ fingerprint: '4'.repeat(64) });
  ledger.retain('attest-host', {}, { ok: true, value: hostEvidence });
  ledger.retain('probe', { hostEvidence }, {
    ok: true,
    value: capabilities,
  });
  ledger.retain('open', { hostEvidence }, { ok: true, value: run });
  ledger.retain('initialize-route-state', { run, capabilities }, {
    ok: true,
    value: routeState,
  });
  const concurrency = (
    activeWriters,
    stagedAhead,
  ) => ({
    activeWriters,
    stagedAhead,
    stagedAheadReadOnly: true,
  });
  const planInput = (stage, workConcurrency) => ({
    run,
    capabilities,
    routeState,
    work: {
      flow: 'dev',
      stage,
      concurrency: workConcurrency,
    },
  });
  let sequence = 5;
  const nextFingerprint = () =>
    (sequence++).toString(16).padStart(64, '0');
  const planValue = (stage) => withSession({
    fingerprint: nextFingerprint(),
    role: stage === 'implementation' ? 'writer' : 'reviewer',
    stage,
  });
  const compile = (planValueInput) => {
    if (!ledger.authorize('compile', planValueInput)) return null;
    const attempt = withSession({
      fingerprint: nextFingerprint(),
      role: planValueInput.role,
      launch: { transport: 'process' },
    });
    ledger.retain('compile', planValueInput, {
      ok: true,
      value: attempt,
    });
    return attempt;
  };
  const complete = (planValueInput, attempt) => {
    if (!ledger.authorize('execute', { attempt })) return false;
    const outcome = withSession({ fingerprint: nextFingerprint() });
    ledger.retain('execute', { attempt }, {
      ok: true,
      value: { outcome },
    });
    const nextRouteState = withSession({ fingerprint: nextFingerprint() });
    const input = {
      run,
      routeState,
      plan: planValueInput,
      outcome,
    };
    if (!ledger.authorize('observe', input)) return false;
    ledger.retain('observe', input, {
      ok: true,
      value: {
        kind: 'complete',
        routeState: nextRouteState,
      },
    });
    routeState = nextRouteState;
    return true;
  };

  const firstReviewInput = planInput(
    'plan-review',
    concurrency(0, 0),
  );
  if (!ledger.authorize('plan', firstReviewInput)) return false;
  const firstReview = planValue('plan-review');
  ledger.retain('plan', firstReviewInput, {
    ok: true,
    value: firstReview,
  });
  if (ledger.authorize(
    'plan',
    planInput('plan-review', concurrency(0, 0)),
  )) return false;
  const firstReviewAttempt = compile(firstReview);
  if (
    firstReviewAttempt === null
    || !complete(firstReview, firstReviewAttempt)
  ) return false;

  const writerInput = planInput(
    'implementation',
    concurrency(0, 0),
  );
  if (!ledger.authorize('plan', writerInput)) return false;
  const writer = planValue('implementation');
  ledger.retain('plan', writerInput, { ok: true, value: writer });
  const writerAttempt = compile(writer);
  if (writerAttempt === null) return false;
  if (ledger.authorize(
    'plan',
    planInput('implementation', concurrency(0, 0)),
  )) return false;

  const stagedReviewInput = planInput(
    'plan-review',
    concurrency(1, 0),
  );
  if (!ledger.authorize('plan', stagedReviewInput)) return false;
  const stagedReview = planValue('plan-review');
  ledger.retain('plan', stagedReviewInput, {
    ok: true,
    value: stagedReview,
  });
  if (ledger.authorize(
    'plan',
    planInput('plan-review', concurrency(1, 0)),
  )) return false;
  const stagedReviewAttempt = compile(stagedReview);
  if (
    stagedReviewAttempt === null
    || !complete(stagedReview, stagedReviewAttempt)
    || ledger.authorize(
      'plan',
      planInput('plan-review', concurrency(1, 1)),
    )
    || !complete(writer, writerAttempt)
  ) return false;

  return ledger.authorize(
    'plan',
    planInput('implementation', concurrency(0, 0)),
  );
}

function brokerMeasurementSelfTest() {
  const first = brokerMeasurementFixture();
  const sessionFingerprint = first.run.sessionFingerprint;
  const bound = new Map();
  const unitBound = new Map();
  const captured = new Map();
  let captureCalls = 0;
  const declaration = (runId, workload = 'fixture') => ({
    version: 1,
    runId,
    workload,
    checkpoint: 'safe-system',
    comparisonContextFingerprint: '1'.repeat(64),
    checkpointEndpointFingerprint: '2'.repeat(64),
    intentSource: 'invocation',
    intentProvenance: 'best-effort-unverified',
    mergePolicy: 'manual',
    baseFreshnessStrategy: 'direct-strict',
  });
  const bindMeasurement = (input) => {
    const runId = input.measurement.runId;
    const serialized = JSON.stringify(input);
    const previous = bound.get(runId);
    if (previous !== undefined && previous !== serialized) {
      return brokerFailure(
        'MEASUREMENT_BIND_FAILED',
        'measurement binding does not match the persisted declaration',
      );
    }
    bound.set(runId, serialized);
    return {
      ok: true,
      value: {
        runId,
        runInstanceFingerprint: input.run.instanceFingerprint,
        idempotent: previous !== undefined,
      },
    };
  };
  const bindMeasurementUnit = (input) => {
    const serialized = JSON.stringify(input);
    const previous = unitBound.get(input.runId);
    if (previous !== undefined && previous !== serialized) {
      return brokerFailure(
        'MEASUREMENT_UNIT_BIND_FAILED',
        'measurement unit binding does not match the persisted Runtime plan',
      );
    }
    unitBound.set(input.runId, serialized);
    return {
      ok: true,
      value: {
        runId: input.runId,
        runInstanceFingerprint: input.run.instanceFingerprint,
        unitId: input.unitId,
        planFingerprint: input.plan.fingerprint,
        idempotent: previous !== undefined,
      },
    };
  };
  const captureMeasurement = ({ runId, receipt }) => {
    captureCalls += 1;
    const serialized = JSON.stringify(receipt);
    const previous = captured.get(runId);
    if (previous === undefined) {
      captured.set(runId, serialized);
      return brokerFailure(
        'MEASUREMENT_CAPTURE_FAILED',
        'fixture failure after durable capture',
      );
    }
    if (previous !== serialized) {
      return brokerFailure(
        'MEASUREMENT_CAPTURE_FAILED',
        'dispatch receipt changed after durable capture',
      );
    }
    return {
      ok: true,
      value: {
        runId,
        dispatchId: 'fixture-dispatch',
        idempotent: true,
        dispatch: {},
        stageEnd: {},
      },
    };
  };
  const receipt = {
    authorization: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64),
  };
  const completedRouteState = {
    ...first.routeState,
    fingerprint: 'c'.repeat(64),
  };
  const finalResult = {
    ok: true,
    value: {
      kind: 'complete',
      routeState: completedRouteState,
      receipt,
    },
  };
  const dispatch = createBrokerDispatch({
    sessions: new Set([sessionFingerprint]),
    ledger: first.ledger,
    registerSession: () => ({ claimed: false }),
    repositoryRoot: '/fixture-repository',
    bindMeasurement,
    bindMeasurementUnit,
    captureMeasurement,
    invoke: (name) => name === 'observe'
      ? structuredClone(finalResult)
      : brokerFailure('INVALID_FIXTURE_OPERATION', name),
  });
  const firstRunId = 'f23e4567-e89b-42d3-a456-426614174000';
  const secondRunId = 'f23e4567-e89b-42d3-a456-426614174001';
  const nextUnitRunId = 'f23e4567-e89b-42d3-a456-426614174002';
  const unbound = dispatch({
    operation: 'observe-measured',
    input: { ...first.observeInput, runId: firstRunId },
  });
  const bindingInput = {
    run: first.run,
    measurement: declaration(firstRunId),
  };
  const boundFirst = dispatch({
    operation: 'bind-measurement',
    input: bindingInput,
  });
  const reboundFirst = dispatch({
    operation: 'bind-measurement',
    input: structuredClone(bindingInput),
  });
  const mismatchedBinding = dispatch({
    operation: 'bind-measurement',
    input: {
      ...bindingInput,
      measurement: declaration(firstRunId, 'changed'),
    },
  });
  const malformedBinding = dispatch({
    operation: 'bind-measurement',
    input: { ...bindingInput, callerRoot: '/untrusted' },
  });
  const lateBinding = dispatch({
    operation: 'bind-measurement',
    input: {
      ...bindingInput,
      capabilities: first.capabilities,
      routeState: first.routeState,
    },
  });
  const boundNextUnit = dispatch({
    operation: 'bind-measurement',
    input: {
      ...bindingInput,
      measurement: declaration(nextUnitRunId),
    },
  });
  const unitBindingInput = {
    runId: firstRunId,
    run: first.run,
    plan: first.plan,
    unitId: 'fixture-unit',
  };
  const boundUnit = dispatch({
    operation: 'bind-measurement-unit',
    input: unitBindingInput,
  });
  const reboundUnit = dispatch({
    operation: 'bind-measurement-unit',
    input: structuredClone(unitBindingInput),
  });
  const changedUnit = dispatch({
    operation: 'bind-measurement-unit',
    input: { ...unitBindingInput, unitId: 'changed-unit' },
  });
  const callerLane = dispatch({
    operation: 'bind-measurement-unit',
    input: { ...unitBindingInput, lane: 'full' },
  });
  const reusedPlan = dispatch({
    operation: 'bind-measurement-unit',
    input: {
      ...unitBindingInput,
      runId: nextUnitRunId,
      unitId: 'next-unit',
    },
  });
  const alternatePlan = {
    ...first.plan,
    fingerprint: randomBytes(32).toString('hex'),
  };
  first.ledger.retain('plan', {
    run: first.run,
    capabilities: first.capabilities,
    routeState: first.routeState,
  }, { ok: true, value: alternatePlan });
  const alternateAttempt = {
    fingerprint: randomBytes(32).toString('hex'),
    role: alternatePlan.role,
    launch: { transport: 'process' },
    sessionFingerprint: first.run.sessionFingerprint,
  };
  first.ledger.retain(
    'compile',
    alternatePlan,
    { ok: true, value: alternateAttempt },
  );
  const alternateOutcome = {
    fingerprint: randomBytes(32).toString('hex'),
    sessionFingerprint: first.run.sessionFingerprint,
  };
  first.ledger.retain('execute', { attempt: alternateAttempt }, {
    ok: true,
    value: { outcome: alternateOutcome },
  });
  const changedFirstPlan = dispatch({
    operation: 'observe-measured',
    input: {
      runId: firstRunId,
      run: first.run,
      routeState: first.routeState,
      plan: alternatePlan,
      outcome: alternateOutcome,
    },
  });
  const second = brokerMeasurementFixture({
    hostEvidence: first.hostEvidence,
    ledger: first.ledger,
  });
  const boundSecond = dispatch({
    operation: 'bind-measurement',
    input: {
      run: second.run,
      measurement: declaration(secondRunId),
    },
  });
  const foreignPlan = dispatch({
    operation: 'bind-measurement-unit',
    input: {
      runId: secondRunId,
      run: second.run,
      plan: first.plan,
      unitId: 'foreign-plan-unit',
    },
  });
  const boundSecondUnit = dispatch({
    operation: 'bind-measurement-unit',
    input: {
      runId: secondRunId,
      run: second.run,
      plan: second.plan,
      unitId: 'second-unit',
    },
  });
  const crossRun = dispatch({
    operation: 'observe-measured',
    input: { ...first.observeInput, runId: secondRunId },
  });
  const unmeasured = dispatch({
    operation: 'observe',
    input: first.observeInput,
  });
  const captureFailed = dispatch({
    operation: 'observe-measured',
    input: { ...first.observeInput, runId: firstRunId },
  });
  const retryAuthorized = first.ledger.authorize(
    'observe-measured',
    { ...first.observeInput, runId: firstRunId },
  );
  const capturedRetry = dispatch({
    operation: 'observe-measured',
    input: { ...first.observeInput, runId: firstRunId },
  });
  const consumed = !first.ledger.authorize(
    'observe-measured',
    { ...first.observeInput, runId: firstRunId },
  );

  let nonfinalPassed = true;
  for (const [index, kind] of ['retry', 'fallback'].entries()) {
    const fixture = brokerMeasurementFixture();
    const runId =
      `a23e4567-e89b-42d3-a456-${String(426614174000 + index)
        .padStart(12, '0')}`;
    const nextPlan = {
      fingerprint: randomBytes(32).toString('hex'),
      role: 'writer',
      stage: 'implementation',
      sessionFingerprint: fixture.run.sessionFingerprint,
    };
    const routeState = {
      ...fixture.routeState,
      fingerprint: randomBytes(32).toString('hex'),
    };
    const completedAfterTransition = {
      ...routeState,
      fingerprint: randomBytes(32).toString('hex'),
    };
    const completedReceipt = {
      authorization: randomBytes(32).toString('hex'),
      fingerprint: randomBytes(32).toString('hex'),
      planFingerprint: nextPlan.fingerprint,
      attempts: [
        { planFingerprint: fixture.plan.fingerprint },
        { planFingerprint: nextPlan.fingerprint },
      ],
    };
    let observationCount = 0;
    const nonfinalDispatch = createBrokerDispatch({
      sessions: new Set([fixture.run.sessionFingerprint]),
      ledger: fixture.ledger,
      registerSession: () => ({ claimed: false }),
      repositoryRoot: '/fixture-repository',
      bindMeasurement,
      bindMeasurementUnit,
      captureMeasurement,
      invoke: (name) => {
        if (name !== 'observe') {
          return brokerFailure('INVALID_FIXTURE_OPERATION', name);
        }
        observationCount += 1;
        return observationCount === 1
          ? {
              ok: true,
              value: { kind, routeState, nextPlan },
            }
          : {
              ok: true,
              value: {
                kind: 'complete',
                routeState: completedAfterTransition,
                receipt: completedReceipt,
              },
            };
      },
    });
    const binding = nonfinalDispatch({
      operation: 'bind-measurement',
      input: {
        run: fixture.run,
        measurement: declaration(runId),
      },
    });
    const unitBinding = nonfinalDispatch({
      operation: 'bind-measurement-unit',
      input: {
        runId,
        run: fixture.run,
        plan: fixture.plan,
        unitId: `fixture-${kind}`,
      },
    });
    const callsBefore = captureCalls;
    const observed = nonfinalDispatch({
      operation: 'observe-measured',
      input: { ...fixture.observeInput, runId },
    });
    const nextAttempt = {
      fingerprint: randomBytes(32).toString('hex'),
      role: nextPlan.role,
      launch: { transport: 'process' },
      sessionFingerprint: fixture.run.sessionFingerprint,
    };
    const nextOutcome = {
      fingerprint: randomBytes(32).toString('hex'),
      sessionFingerprint: fixture.run.sessionFingerprint,
    };
    const nextCompileAuthorized = fixture.ledger.authorize(
      'compile',
      nextPlan,
    );
    if (nextCompileAuthorized) {
      fixture.ledger.retain('compile', nextPlan, {
        ok: true,
        value: nextAttempt,
      });
    }
    const nextExecuteAuthorized = fixture.ledger.authorize(
      'execute',
      { attempt: nextAttempt },
    );
    if (nextExecuteAuthorized) {
      fixture.ledger.retain('execute', { attempt: nextAttempt }, {
        ok: true,
        value: { outcome: nextOutcome },
      });
    }
    const callsBeforeFinal = captureCalls;
    const completed = nonfinalDispatch({
      operation: 'observe-measured',
      input: {
        runId,
        run: fixture.run,
        routeState,
        plan: nextPlan,
        outcome: nextOutcome,
      },
    });
    const capturedReceipt = JSON.parse(captured.get(runId) ?? 'null');
    nonfinalPassed &&= binding.ok
      && unitBinding.ok
      && observed.ok
      && observed.value.kind === kind
      && captureCalls === callsBefore + 1
      && nextCompileAuthorized
      && nextExecuteAuthorized
      && !completed.ok
      && completed.error?.code === 'MEASUREMENT_CAPTURE_FAILED'
      && captureCalls === callsBeforeFinal + 1
      && capturedReceipt?.attempts?.[0]?.planFingerprint
        === fixture.plan.fingerprint
      && capturedReceipt?.planFingerprint === nextPlan.fingerprint;
  }

  const doctor = brokerMeasurementFixture({ flow: 'doctor' });
  const doctorDispatch = createBrokerDispatch({
    sessions: new Set([doctor.run.sessionFingerprint]),
    ledger: doctor.ledger,
    registerSession: () => ({ claimed: false }),
    invoke: () => ({
      ...structuredClone(finalResult),
      value: {
        ...structuredClone(finalResult.value),
        routeState: {
          ...doctor.routeState,
          fingerprint: 'd'.repeat(64),
        },
      },
    }),
  });
  const unmeasuredDoctor = doctorDispatch({
    operation: 'observe',
    input: doctor.observeInput,
  });
  const nativeProbeInput = {
    hostEvidence: first.hostEvidence,
    run: first.run,
    routes: [first.run.requestedRoute],
    cwd: process.cwd(),
  };
  const probeAuthorized = first.ledger.authorize(
    'probe',
    nativeProbeInput,
  );
  const callerNonceProbeRejected = !first.ledger.authorize(
    'probe',
    { ...nativeProbeInput, invocationNonce: first.run.invocationNonce },
  );

  return {
    parsing:
      parseArgs(['--bind-measurement-json', '-']).mode
        === 'bind-measurement'
      && parseArgs(['--prepare-native-probe-json', '-']).mode === null
      && parseArgs(['--complete-native-probe-json', '-']).mode === null
      && parseArgs(['--bind-measurement-unit-json', '-']).mode
        === 'bind-measurement-unit'
      && parseArgs(['--observe-measured-json', '-']).mode
        === 'observe-measured'
      && probeAuthorized
      && callerNonceProbeRejected
      && malformedBinding.ok === false
      && lateBinding.ok === false,
    binding:
      unbound.ok === false
      && boundFirst.ok
      && reboundFirst.ok
      && reboundFirst.value.idempotent === true
      && mismatchedBinding.ok === false
      && boundNextUnit.ok
      && boundSecond.ok
      && boundUnit.ok
      && reboundUnit.ok
      && reboundUnit.value.idempotent === true
      && changedUnit.ok === false
      && callerLane.ok === false
      && reusedPlan.ok === false
      && changedFirstPlan.ok === false
      && foreignPlan.ok === false
      && boundSecondUnit.ok,
    isolation: crossRun.ok === false,
    capture:
      unmeasured.error?.code === 'MEASUREMENT_REQUIRED'
      && captureFailed.ok === false
      && retryAuthorized
      && capturedRetry.ok
      && consumed
      && captureCalls >= 2,
    nonfinal: nonfinalPassed,
    doctor: unmeasuredDoctor.ok,
  };
}

async function hostileBrokerSelfTest() {
  ensureBrokerDirectory();
  const sessionFingerprint = randomBytes(32).toString('hex');
  const foreignSession = randomBytes(32).toString('hex');
  const broker = brokerLedgerFixture(sessionFingerprint);
  const socketPath = join(
    BROKER_DIRECTORY,
    `${randomBytes(16).toString('hex')}.sock`,
  );
  const registryPath = join(
    BROKER_DIRECTORY,
    `${randomBytes(32).toString('hex')}.hostile-registry.json`,
  );
  const sessions = new Set([sessionFingerprint]);
  const dispatch = createBrokerDispatch({
    sessions,
    ledger: broker.ledger,
    registerSession: () => {
      throw new Error('fixture broker is already attested');
    },
    invoke: (name) => name === 'execute'
      ? { ok: true, value: { outcome: broker.writerOutcome } }
      : { ok: true, value: { fingerprint: 'e'.repeat(64) } },
  });
  const server = createBrokerServer(dispatch, () => {});
  let child = null;
  let passed = false;
  try {
    await listenBrokerServer(server, socketPath);
    writeFileSync(
      registryPath,
      `${JSON.stringify({ socketPath })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    const forgedReviewer = {
      ...broker.reviewerAttempt,
      fingerprint: randomBytes(32).toString('hex'),
    };
    const crossSessionAttempt = {
      ...broker.writerAttempt,
      sessionFingerprint: foreignSession,
    };
    const requests = [
      { operation: 'sign', input: { value: broker.writerAttempt } },
      {
        operation: 'attest-host',
        input: {
          integration: 'hostile-child',
          sessionId: 'bootstrap',
          observedSurface: { tool: 'shell' },
        },
      },
      {
        operation: 'open',
        input: {
          hostEvidence: {
            fingerprint: broker.writerAttempt.fingerprint,
            sessionFingerprint,
          },
        },
      },
      {
        operation: 'plan',
        input: {
          run: broker.writerAttempt,
          capabilities: broker.writerAttempt,
          routeState: broker.writerAttempt,
        },
      },
      { operation: 'compile', input: broker.writerAttempt },
      {
        operation: 'execute',
        input: { attempt: forgedReviewer },
      },
      {
        operation: 'execute',
        input: { attempt: crossSessionAttempt },
      },
      {
        operation: 'execute',
        input: { attempt: broker.writerAttempt },
      },
      {
        operation: 'execute',
        input: { attempt: broker.writerAttempt },
      },
    ];
    const script = [
      "import { readFileSync } from 'node:fs';",
      "import { createConnection } from 'node:net';",
      'const registry = JSON.parse(readFileSync(process.env.REGISTRY, "utf8"));',
      'const requests = JSON.parse(process.env.REQUESTS);',
      'const send = (request) => new Promise((resolve, reject) => {',
      '  const socket = createConnection(registry.socketPath);',
      '  let output = "";',
      '  socket.setEncoding("utf8");',
      '  socket.setTimeout(5000, () => reject(new Error("timeout")));',
      '  socket.on("connect", () => socket.end(`${JSON.stringify(request)}\\n`));',
      '  socket.on("data", (chunk) => { output += chunk; });',
      '  socket.on("error", reject);',
      '  socket.on("end", () => resolve(JSON.parse(output)));',
      '});',
      'const results = [];',
      'for (const request of requests) results.push(await send(request));',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n');
    child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        env: {
          REGISTRY: registryPath,
          REQUESTS: JSON.stringify(requests),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        rejectExit(new Error('hostile broker child timed out'));
      }, 15000);
      child.once('error', rejectExit);
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });
    if (exitCode === 0 && stderr === '') {
      const results = JSON.parse(stdout);
      passed = results.length === requests.length
        && results[0].error?.code === 'INVALID_BROKER_OPERATION'
        && results[1].error?.code === 'BROKER_ALREADY_ATTESTED'
        && results.slice(2, 6).every((result) =>
          result.error?.code === 'UNISSUED_BROKER_CAPABILITY')
        && results[6].error?.code === 'INVALID_BROKER_SESSION'
        && results[7].ok === true
        && results[8].error?.code === 'UNISSUED_BROKER_CAPABILITY';
    }
  } catch {
    passed = false;
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (server.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    rmSync(registryPath, { force: true });
    rmSync(socketPath, { force: true });
  }
  return passed
    && child?.exitCode === 0
    && !existsSync(registryPath)
    && !existsSync(socketPath);
}

function staleLockSelfTest() {
  ensureBrokerDirectory();
  const scope = randomBytes(32).toString('hex');
  const path = lockPathFor(scope);
  const owner = {
    version: 1,
    pid: 2147483647,
    processStart: 'stale',
    token: randomBytes(32).toString('hex'),
  };
  let secondReclaimer = null;
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(
      join(path, 'owner.json'),
      `${JSON.stringify(owner)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    const firstReclaimer = reclaimStaleLock(path, owner, () => {
      secondReclaimer = reclaimStaleLock(path, owner);
    });
    return firstReclaimer === true
      && secondReclaimer === false
      && !existsSync(path);
  } catch {
    return false;
  } finally {
    rmSync(path, { recursive: true, force: true });
    for (const entry of readdirSync(BROKER_DIRECTORY)) {
      if (
        entry.startsWith(`${basename(path)}.`)
        && entry.endsWith('.stale')
      ) {
        rmSync(join(BROKER_DIRECTORY, entry), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

function replacementLockSelfTest() {
  const scope = randomBytes(32).toString('hex');
  let first = null;
  let second = null;
  try {
    first = acquireRegistryLock(scope);
    releaseRegistryLock(first);
    second = acquireRegistryLock(scope);
    releaseRegistryLock(first);
    return existsSync(second.path)
      && lockOwner(second.path).token === second.token;
  } catch {
    return false;
  } finally {
    if (second) releaseRegistryLock(second);
    rmSync(lockPathFor(scope), { recursive: true, force: true });
  }
}

function ownerlessLockRecoverySelfTest() {
  ensureBrokerDirectory();
  const scope = randomBytes(32).toString('hex');
  const path = lockPathFor(scope);
  let lock = null;
  try {
    mkdirSync(path, { mode: 0o700 });
    lock = acquireRegistryLock(scope);
    return lockOwner(path).token === lock.token;
  } catch {
    return false;
  } finally {
    if (lock) releaseRegistryLock(lock);
    rmSync(path, { recursive: true, force: true });
  }
}

function abandonedRecoveryLockSelfTest() {
  ensureBrokerDirectory();
  const scope = randomBytes(32).toString('hex');
  const path = lockPathFor(scope);
  const stale = {
    version: 1,
    pid: 2147483647,
    processStart: 'stale',
    token: randomBytes(32).toString('hex'),
  };
  let lock = null;
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(
      join(path, 'owner.json'),
      `${JSON.stringify(stale)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    writeFileSync(
      join(path, 'recovery.json'),
      `${JSON.stringify(stale)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    lock = acquireRegistryLock(scope);
    return lockOwner(path).token === lock.token;
  } catch {
    return false;
  } finally {
    if (lock) releaseRegistryLock(lock);
    rmSync(path, { recursive: true, force: true });
  }
}

function finishRevocationSelfTest() {
  const broker = brokerLedgerFixture();
  const input = { attempt: broker.writerAttempt };
  if (!broker.ledger.authorize('execute', input)) return false;
  broker.ledger.retain('finish', { run: broker.run }, {
    ok: true,
    value: {
      action: 'stop',
    },
  });
  return broker.ledger.authorize('execute', input) === false
    && broker.ledger.authorize('compile', broker.reviewerPlan) === false
    && broker.ledger.authorize('finish', { run: broker.run }) === false;
}

async function stuckClientSelfTest() {
  ensureBrokerDirectory();
  const socketPath = join(
    BROKER_DIRECTORY,
    `${randomBytes(16).toString('hex')}.sock`,
  );
  const sockets = new Set();
  const server = createBrokerServer(
    () => brokerFailure('UNUSED', 'unused'),
    () => {},
    sockets,
  );
  let client = null;
  let cleaned = false;
  try {
    await listenBrokerServer(server, socketPath);
    client = createConnection(socketPath);
    client.on('error', () => {});
    await new Promise((resolveConnect, rejectConnect) => {
      const timeout = setTimeout(
        () => rejectConnect(new Error('stuck client did not connect')),
        5000,
      );
      client.once('connect', () => {
        clearTimeout(timeout);
        resolveConnect();
      });
    });
    closeBrokerServer(server, sockets, () => {
      cleaned = true;
      rmSync(socketPath, { force: true });
    });
    await new Promise((resolveClose, rejectClose) => {
      const timeout = setTimeout(
        () => rejectClose(new Error('stuck client was not destroyed')),
        5000,
      );
      client.once('close', () => {
        clearTimeout(timeout);
        resolveClose();
      });
    });
    return cleaned && sockets.size === 0 && !existsSync(socketPath);
  } catch {
    return false;
  } finally {
    client?.destroy();
    if (server.listening) server.close();
    rmSync(socketPath, { force: true });
  }
}

async function hostLivenessSelfTest() {
  const child = spawn(
    process.execPath,
    ['--eval', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', windowsHide: true },
  );
  let stopMonitor = null;
  try {
    let processStart = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      processStart = processStartIdentity(child.pid);
      if (processStart !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (processStart === null) return false;
    let timeout;
    const observed = new Promise((resolveObserved) => {
      stopMonitor = startHostLivenessMonitor(
        { pid: child.pid, processStart },
        () => resolveObserved(Date.now()),
        20,
      );
      timeout = setTimeout(() => resolveObserved(null), 1500);
    });
    const terminatedAt = Date.now();
    child.kill('SIGKILL');
    const observedAt = await observed;
    clearTimeout(timeout);
    return observedAt !== null && observedAt - terminatedAt < 1000;
  } catch {
    return false;
  } finally {
    stopMonitor?.();
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function terminalAcknowledgementSelfTest() {
  ensureBrokerDirectory();
  const socketPath = brokerSocketPath(
    `${randomBytes(16).toString('hex')}.sock`,
  );
  let shutdowns = 0;
  let protocol = null;
  let server = null;
  try {
    protocol = createTerminalProtocol(
      (request) => request?.operation === 'finish'
        ? { ok: true, value: { action: 'stop' } }
        : brokerFailure('UNEXPECTED', 'unexpected test operation'),
      () => {
        shutdowns += 1;
      },
      1000,
    );
    server = createBrokerServer(
      protocol.dispatch,
      protocol.onResponse,
    );
    await listenBrokerServer(server, socketPath);
    const terminal = await brokerRequest(socketPath, {
      operation: 'finish',
      input: {},
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    if (
      shutdowns !== 0
      || !HEX_64.test(terminal.brokerTerminalAcknowledgement ?? '')
    ) {
      return false;
    }
    const acknowledged = await brokerRequest(socketPath, {
      operation: 'ack-terminal',
      input: { token: terminal.brokerTerminalAcknowledgement },
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    return acknowledged.ok
      && acknowledged.value.acknowledged === true
      && shutdowns === 1;
  } catch {
    return false;
  } finally {
    protocol?.dispose();
    if (server?.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    rmSync(socketPath, { force: true });
  }
}

function liveBrokerCliSelfTest(flag, input) {
  const result = spawnSync(
    BROKER_EXECUTABLE,
    [BROKER_ENTRYPOINT, flag, '-'],
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
  return JSON.parse(String(result.stdout ?? ''));
}

function fixtureSessionFingerprint(host, sessionId) {
  return createHash('sha256').update(JSON.stringify({
    activeHost: host,
    integration: `${host}.user-prompt-hook`,
    sessionId,
  })).digest('hex');
}

function fixturePromptEffect(leaseFingerprint, claimFingerprint) {
  const effect = {
    version: 1,
    leaseFingerprint,
    claimFingerprint,
    expectedStatus: 'opened',
    effect: 'prompt',
    subjectFingerprint: createHash('sha256')
      .update(RELAUNCH_PROMPT)
      .digest('hex'),
    issuedByOwnerFingerprint: randomBytes(32).toString('hex'),
    effectNonce: randomUUID(),
  };
  return {
    ...effect,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(
        Object.entries(effect).sort(([left], [right]) =>
          left.localeCompare(right)),
      )))
      .digest('hex'),
  };
}

async function liveBrokerContinuationScenario(targetFirst) {
  const hostBinding = detectHostProcessBinding();
  if (hostBinding === null) return false;
  const hookEventName = hostBinding.host === 'opencode'
    ? 'opencode.user-prompt'
    : 'UserPromptSubmit';
  let registry = null;
  try {
    const sourceSessionId =
      `run-scope-live-self-test-${randomBytes(8).toString('hex')}`;
    captureHostIntent({
      hook_event_name: hookEventName,
      session_id: sourceSessionId,
      turn_id: `turn-${randomBytes(8).toString('hex')}`,
      cwd: process.cwd(),
      prompt: '/autoloop:dev; auto-continue',
    }, {
      binding: hostBinding,
      cwd: process.cwd(),
    });
    const attested = await startSessionBroker({ sessionId: sourceSessionId });
    if (!attested.ok) {
      if (process.env.AUTOLOOP_SELF_TEST_DEBUG === '1') {
        console.error(JSON.stringify({ attested }));
      }
      return false;
    }
    const sessionFingerprint = attested.value.sessionFingerprint;
    registry = readBrokerRegistry(sessionFingerprint);
    const opened = await requestSessionBroker(
      sessionFingerprint,
      'open',
      {
        hostEvidence: attested.value,
      },
    );
    if (!opened.ok) {
      if (process.env.AUTOLOOP_SELF_TEST_DEBUG === '1') {
        console.error(JSON.stringify({ opened }));
      }
      return false;
    }
    const unsignedRun = { ...opened.value };
    delete unsignedRun.authorization;
    const verification = {
      value: unsignedRun,
      sessionFingerprint,
      authorization: opened.value.authorization,
    };
    const validBeforeFinish = await requestSessionBroker(
      sessionFingerprint,
      'verify-authorization',
      verification,
    );
    const finished = await requestSessionBroker(
      sessionFingerprint,
      'finish',
      {
        run: opened.value,
        progress: {
          reason: 'context-budget',
          unitsCompleted: 1,
          queueEvidence: fixtureQueueEvidence(
            opened.value,
            1,
            'relaunch',
          ),
          checkout: {
            repositoryFingerprint: 'e'.repeat(64),
            branch: 'main',
            headOid: 'c'.repeat(40),
            clean: true,
          },
        },
      },
    );
    if (!finished.ok || finished.value.action !== 'relaunch') {
      if (process.env.AUTOLOOP_SELF_TEST_DEBUG === '1') {
        console.error(JSON.stringify({ finished }));
      }
      return false;
    }
    const validAfterFinish = await requestSessionBroker(
      sessionFingerprint,
      'verify-authorization',
      verification,
    );
    const states = [finished.value.continuationState];
    const initialHistory = await requestSessionBroker(
      sessionFingerprint,
      'validate-continuation-history',
      { lease: finished.value.lease, states },
    );
    const claimFingerprint = randomBytes(32).toString('hex');
    const targetSessionId =
      `run-scope-target-${randomBytes(8).toString('hex')}`;
    const targetSession = fixtureSessionFingerprint(
      hostBinding.host,
      targetSessionId,
    );
    let continuationBundle = null;
    for (const [nextStatus, extra] of [
      ['claimed', { claimFingerprint }],
      ['session-created', { claimFingerprint, sessionFingerprint: targetSession }],
      ['opened', { claimFingerprint, sessionFingerprint: targetSession }],
    ]) {
      const advanced = await requestSessionBroker(
        sessionFingerprint,
        'transition-continuation',
        {
          lease: finished.value.lease,
          state: states.at(-1),
          nextStatus,
          ...extra,
        },
      );
      if (!advanced.ok) {
        if (process.env.AUTOLOOP_SELF_TEST_DEBUG === '1') {
          console.error(JSON.stringify({ nextStatus, advanced }));
        }
        return false;
      }
      states.push(advanced.value.state);
      if (nextStatus === 'opened') {
        continuationBundle = {
          continuation: finished.value.envelope,
          continuationLease: finished.value.lease,
          continuationState: advanced.value.state,
          continuationAuthorization: advanced.value.authorization,
        };
      }
    }
    const arbitrarySessionId =
      `run-scope-arbitrary-${randomBytes(8).toString('hex')}`;
    const arbitrarySession = fixtureSessionFingerprint(
      hostBinding.host,
      arbitrarySessionId,
    );
    const session = {
      version: 1,
      activeHost: hostBinding.host,
      integration: `${hostBinding.host}.user-prompt-hook`,
      sessionId: targetSessionId,
      sessionFingerprint: targetSession,
    };
    const promptEffect = fixturePromptEffect(
      finished.value.lease.fingerprint,
      claimFingerprint,
    );
    const preparationInput = {
      lease: finished.value.lease,
      state: continuationBundle.continuationState,
      authorization: continuationBundle.continuationAuthorization,
      effect: promptEffect,
      session,
    };
    const unpreparedAttestation = await startSessionBroker({
      sessionId: targetSessionId,
    });
    const mismatchedPreparation = await requestSessionBroker(
      sessionFingerprint,
      'prepare-continuation-prompt',
      {
        ...preparationInput,
        session: {
          ...session,
          sessionId: arbitrarySessionId,
          sessionFingerprint: arbitrarySession,
        },
      },
    );
    const prepared = await requestSessionBroker(
      sessionFingerprint,
      'prepare-continuation-prompt',
      preparationInput,
    );
    const recoveredPreparation = await requestSessionBroker(
      sessionFingerprint,
      'prepare-continuation-prompt',
      preparationInput,
    );
    const arbitraryAttestation = await startSessionBroker({
      sessionId: arbitrarySessionId,
    });
    const transitionPrompted = async () => {
      const advanced = await requestSessionBroker(
        sessionFingerprint,
        'transition-continuation',
        {
          lease: finished.value.lease,
          state: states.at(-1),
          nextStatus: 'prompted',
          claimFingerprint,
          sessionFingerprint: targetSession,
        },
      );
      if (advanced.ok) states.push(advanced.value.state);
      return advanced;
    };
    let prompted = null;
    let fullHistory = null;
    let sourceBeforeTransfer = null;
    if (!targetFirst) {
      prompted = await transitionPrompted();
      fullHistory = prompted.ok
        ? await requestSessionBroker(
          sessionFingerprint,
          'validate-continuation-history',
          { lease: finished.value.lease, states },
        )
        : { ok: false };
      sourceBeforeTransfer = prompted.ok
        ? await requestSessionBroker(
          sessionFingerprint,
          'verify-authorization',
          verification,
        )
        : { ok: false };
    }
    const targetAttestation = await startSessionBroker({
      sessionId: targetSessionId,
    });
    const replayedAttestation = await startSessionBroker({
      sessionId: targetSessionId,
    });
    const reboundBundle = {
      ...continuationBundle,
      continuationState: {
        ...continuationBundle.continuationState,
        sessionFingerprint: arbitrarySession,
      },
    };
    const reboundOpen = targetAttestation.ok
      ? await requestSessionBroker(
        targetSession,
        'open',
        {
          hostEvidence: targetAttestation.value,
          ...reboundBundle,
        },
      )
      : { ok: false };
    const targetOpen = targetAttestation.ok
      ? await requestSessionBroker(
        targetSession,
        'open',
        {
          hostEvidence: targetAttestation.value,
          ...continuationBundle,
        },
      )
      : { ok: false };
    const unsignedTargetRun = targetOpen.ok ? { ...targetOpen.value } : null;
    if (unsignedTargetRun) delete unsignedTargetRun.authorization;
    if (targetFirst && targetOpen.ok) {
      sourceBeforeTransfer = await requestSessionBroker(
        targetSession,
        'verify-authorization',
        verification,
      );
    }
    const targetBeforeTransfer = targetOpen.ok
      ? await requestSessionBroker(
        targetSession,
        'verify-authorization',
        {
          value: unsignedTargetRun,
          sessionFingerprint: targetSession,
          authorization: targetOpen.value.authorization,
        },
      )
      : { ok: false };
    let sourceAfterTransfer = null;
    let targetAfterTransfer = null;
    let targetAfterStop = null;
    let replayedOpen = null;
    let stopped = null;
    if (targetFirst && targetOpen.ok) {
      stopped = await requestSessionBroker(
        targetSession,
        'finish',
        {
          run: targetOpen.value,
          progress: {
            reason: 'guardrail-failure',
            unitsCompleted: 0,
            queueEvidence: null,
          },
        },
      );
      targetAfterStop = await requestSessionBroker(
        sessionFingerprint,
        'verify-authorization',
        {
          value: unsignedTargetRun,
          sessionFingerprint: targetSession,
          authorization: targetOpen.value.authorization,
        },
      );
      prompted = await transitionPrompted();
    } else if (targetOpen.ok) {
      sourceAfterTransfer = await requestSessionBroker(
        targetSession,
        'verify-authorization',
        verification,
      );
      targetAfterTransfer = await requestSessionBroker(
        targetSession,
        'verify-authorization',
        {
          value: unsignedTargetRun,
          sessionFingerprint: targetSession,
          authorization: targetOpen.value.authorization,
        },
      );
      replayedOpen = await requestSessionBroker(
        targetSession,
        'open',
        {
          hostEvidence: targetAttestation.value,
          ...continuationBundle,
        },
      );
      stopped = await requestSessionBroker(
        targetSession,
        'finish',
        {
          run: targetOpen.value,
          progress: {
            reason: 'guardrail-failure',
            unitsCompleted: 0,
            queueEvidence: null,
          },
        },
      );
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        !existsSync(registry.socketPath)
        && liveHostBroker(hostBinding) === null
        && !brokerProcessMatches(registry)
      ) {
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const transferOrderPassed = targetFirst
      ? stopped?.ok
        && stopped.value.action === 'stop'
        && stopped.brokerTerminalDeferred === true
        && targetAfterStop.value?.valid === false
        && prompted?.ok
        && !existsSync(brokerRegistryPath(sessionFingerprint))
        && !existsSync(brokerRegistryPath(targetSession))
      : fullHistory?.ok
        && sourceAfterTransfer
        && (
          sourceAfterTransfer.ok === false
          || sourceAfterTransfer.value?.valid === false
        )
        && targetAfterTransfer?.value?.valid === true
        && replayedOpen?.ok === false
        && stopped?.ok
        && stopped.value.action === 'stop'
        && stopped.brokerTerminalDeferred === undefined;
    const passed = validBeforeFinish.value?.valid === true
      && validAfterFinish.value?.valid === true
      && initialHistory.ok
      && states.at(-1).status === 'prompted'
      && continuationBundle !== null
      && unpreparedAttestation.ok === false
      && mismatchedPreparation.ok === false
      && prepared.ok
      && recoveredPreparation.ok
      && arbitraryAttestation.ok === false
      && replayedAttestation.ok === false
      && reboundOpen.ok === false
      && targetOpen.ok
      && targetOpen.value.sessionFingerprint === targetSession
      && sourceBeforeTransfer?.value?.valid === true
      && targetBeforeTransfer.value?.valid === true
      && transferOrderPassed
      && !existsSync(registry.socketPath)
      && liveHostBroker(hostBinding) === null
      && !brokerProcessMatches(registry);
    if (!passed && process.env.AUTOLOOP_SELF_TEST_DEBUG === '1') {
      console.error(JSON.stringify({
        targetFirst,
        validBeforeFinish,
        finished,
        validAfterFinish,
        initialHistory,
        fullHistory,
        unpreparedAttestation,
        mismatchedPreparation,
        prepared,
        recoveredPreparation,
        arbitraryAttestation,
        targetAttestation,
        replayedAttestation,
        reboundOpen,
        targetOpen,
        sourceBeforeTransfer,
        targetBeforeTransfer,
        sourceAfterTransfer,
        targetAfterTransfer,
        targetAfterStop,
        replayedOpen,
        prompted,
        stopped,
        sourceRegistryExists: existsSync(
          brokerRegistryPath(sessionFingerprint),
        ),
        targetRegistryExists: existsSync(
          brokerRegistryPath(targetSession),
        ),
        socketExists: existsSync(registry.socketPath),
      }));
    }
    return passed;
  } catch (error) {
    if (process.env.AUTOLOOP_SELF_TEST_DEBUG === '1') {
      console.error(`live broker continuation: ${error.stack ?? error.message}`);
    }
    return false;
  } finally {
    if (registry && brokerCommandMatches(registry)) {
      try {
        process.kill(registry.pid, 'SIGTERM');
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

async function liveBrokerContinuationSelfTest() {
  if (detectHostProcessBinding() !== null) {
    return await liveBrokerContinuationScenario(true)
      && await liveBrokerContinuationScenario(false);
  }
  const result = spawnSync(
    BROKER_EXECUTABLE,
    [BROKER_ENTRYPOINT, '--continuation-broker-self-test-driver'],
    {
      argv0: 'codex',
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: MAX_INPUT_BYTES,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          key !== 'NODE_OPTIONS'
          && !key.startsWith('AUTOLOOP_AUTHORITY_')),
      ),
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    if (process.env.AUTOLOOP_SELF_TEST_DEBUG === '1') {
      console.error(String(result.stderr ?? result.error?.message ?? ''));
    }
    return false;
  }
  try {
    return JSON.parse(result.stdout).ok === true;
  } catch {
    return false;
  }
}

async function detachedBrokerHostDeathSelfTest() {
  if (detectHostProcessBinding() !== null) return true;
  const script = [
    "import { spawnSync } from 'node:child_process';",
    'const sessionId = `fixture-${Date.now()}`;',
    'const capture = spawnSync(process.execPath, [',
    '  process.argv[2], "--capture-hook"',
    '], {',
    '  input: `${JSON.stringify({',
    '    hook_event_name: "UserPromptSubmit",',
    '    session_id: sessionId,',
    '    turn_id: "fixture-turn",',
    '    cwd: process.cwd(),',
    '    prompt: "/autoloop:dev"',
    '  })}\\n`,',
    '  encoding: "utf8",',
    '  env: process.env',
    '});',
    'if (capture.status !== 0) process.exit(1);',
    'const result = spawnSync(process.execPath, [',
    '  process.argv[1], "--attest-host-json", "-"',
    '], {',
    '  input: `${JSON.stringify({',
    '    sessionId',
    '  })}\\n`,',
    '  encoding: "utf8",',
    '  env: process.env',
    '});',
    'process.stdout.write(String(result.stdout ?? ""));',
    'if (result.status !== 0) process.exit(1);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(
    BROKER_EXECUTABLE,
    [
      '--input-type=module',
      '--eval',
      script,
      BROKER_ENTRYPOINT,
      INTENT_ENTRYPOINT,
    ],
    {
      argv0: 'codex',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          key !== 'NODE_OPTIONS'
          && !key.startsWith('AUTOLOOP_AUTHORITY_')),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let registry = null;
  let leasePath = null;
  try {
    child.stdout.setEncoding('utf8');
    let output = '';
    const line = await new Promise((resolveLine, rejectLine) => {
      const timeout = setTimeout(
        () => rejectLine(new Error('fixture host did not attest')),
        15000,
      );
      child.once('error', rejectLine);
      child.once('close', () =>
        rejectLine(new Error('fixture host exited before attestation')));
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        resolveLine(output.slice(0, newline));
      });
    });
    const attested = JSON.parse(line);
    if (!attested.ok) return false;
    registry = readBrokerRegistry(attested.value.sessionFingerprint);
    leasePath = readdirSync(BROKER_DIRECTORY)
      .filter((entry) => /^host-[a-f0-9]{64}\.lease$/.test(entry))
      .map((entry) => join(BROKER_DIRECTORY, entry))
      .find((path) => {
        try {
          return JSON.parse(readSmallOwnedFile(path, 4096)).socketPath
            === registry.socketPath;
        } catch {
          return false;
        }
      }) ?? null;
    if (leasePath === null) return false;
    child.kill('SIGKILL');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        !existsSync(brokerRegistryPath(attested.value.sessionFingerprint))
        && !existsSync(registry.socketPath)
        && !existsSync(leasePath)
      ) {
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    return !brokerProcessMatches(registry)
      && !existsSync(brokerRegistryPath(attested.value.sessionFingerprint))
      && !existsSync(registry.socketPath)
      && !existsSync(leasePath);
  } catch {
    return false;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (registry && brokerProcessMatches(registry)) {
      try {
        process.kill(registry.pid, 'SIGTERM');
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

function forgedSameUidIntentSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 'autoloop-forged-intent-'));
  const binding = {
    host: 'claude',
    pid: 4242,
    processStart: 'same-uid-fixture',
    fingerprint: 'f'.repeat(64),
  };
  const event = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'printf-forged-session',
    turn_id: 'printf-forged-turn',
    cwd: root,
    prompt: '/autoloop:dev with codex',
  };
  try {
    const initialized = spawnSync('git', ['init', '--quiet'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (initialized.status !== 0) return false;
    const captured = captureHostIntent(event, {
      binding,
      cwd: root,
      now: 1,
    });
    const consumed = consumeHostIntent(
      { sessionId: event.session_id },
      { binding, cwd: root },
    );
    const hostEvidence = hostFixture();
    const manual = open({
      invocation: consumed.prompt,
      intentProvenance: consumed.intentProvenance,
      hostEvidence,
      config: configFixture(),
    });
    const ratifiedConfig = structuredClone(configFixture());
    ratifiedConfig.merge.policy = 'ratified';
    const ratified = open({
      invocation: consumed.prompt,
      intentProvenance: consumed.intentProvenance,
      hostEvidence,
      config: ratifiedConfig,
    });
    const autoConfig = structuredClone(configFixture());
    autoConfig.merge.policy = 'auto';
    const automatic = open({
      invocation: consumed.prompt,
      intentProvenance: consumed.intentProvenance,
      hostEvidence,
      config: autoConfig,
    });
    const upgraded = open({
      invocation: consumed.prompt,
      intentProvenance: 'verified-user',
      hostEvidence,
      config: configFixture(),
    });
    return captured.captured
      && consumed.intentProvenance === INTENT_PROVENANCE
      && manual.ok
      && manual.value.selector === 'codex'
      && manual.value.requestedRoute === 'claude.codex-exec'
      && manual.value.intentProvenance === INTENT_PROVENANCE
      && ratified.error?.code === 'UNVERIFIABLE_INVOCATION_PROVENANCE'
      && automatic.error?.code === 'UNVERIFIABLE_INVOCATION_PROVENANCE'
      && upgraded.ok === false;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function selfTest() {
  const queue = openRunScope({
    invocation: '/autoloop:dev',
    intentProvenance: INTENT_PROVENANCE,
    hostEvidence: hostFixture(),
    config: configFixture(),
  });
  const bounded = openRunScope({
    invocation: '/autoloop:dev only #7',
    intentProvenance: INTENT_PROVENANCE,
    hostEvidence: hostFixture(),
    config: configFixture(),
  });
  const stop = queue.ok
    ? finishRunScope({
        run: queue.value,
        progress: {
          reason: 'queue-exhausted',
          unitsCompleted: 2,
          queueEvidence: fixtureQueueEvidence(
            queue.value,
            0,
            'queueExhaustion',
          ),
        },
      })
    : null;
  const incomplete = queue.ok
    ? finishRunScope({
        run: queue.value,
        progress: {
          reason: 'queue-exhausted',
          unitsCompleted: 2,
          queueEvidence: null,
        },
      })
    : null;
  const wallClock = queue.ok
    ? finishRunScope({
        run: queue.value,
        progress: {
          reason: 'wall-clock-cap',
          unitsCompleted: 1,
          queueEvidence: null,
        },
      })
    : null;
  const relaunchSource = openRunScope({
    invocation: '/autoloop:dev; auto-continue',
    intentProvenance: INTENT_PROVENANCE,
    hostEvidence: hostFixture(),
    config: configFixture(),
  });
  const relaunch = relaunchSource.ok
    ? finishRunScope({
        run: relaunchSource.value,
        progress: {
          reason: 'context-budget',
          unitsCompleted: 1,
          queueEvidence: fixtureQueueEvidence(
            relaunchSource.value,
            1,
            'relaunch',
          ),
          checkout: {
            repositoryFingerprint: 'e'.repeat(64),
            branch: 'main',
            headOid: 'c'.repeat(40),
            clean: true,
          },
        },
      })
    : null;
  const claimed = relaunch?.ok && relaunch.value.action === 'relaunch'
    ? transitionRunContinuation({
        lease: relaunch.value.lease,
        state: relaunch.value.continuationState,
        nextStatus: 'claimed',
        claimFingerprint: 'f'.repeat(64),
      })
    : null;
  const broker = brokerLedgerFixture();
  const brokerScheduling = brokerSchedulingSelfTest();
  const brokerMeasurement = brokerMeasurementSelfTest();
  const hostileBroker = await hostileBrokerSelfTest();
  const staleLock = staleLockSelfTest();
  const replacementLock = replacementLockSelfTest();
  const ownerlessLock = ownerlessLockRecoverySelfTest();
  const abandonedRecoveryLock = abandonedRecoveryLockSelfTest();
  const finishRevocation = finishRevocationSelfTest();
  const stuckClient = await stuckClientSelfTest();
  const hostLiveness = await hostLivenessSelfTest();
  const terminalAcknowledgement =
    await terminalAcknowledgementSelfTest();
  const liveBrokerContinuation =
    await liveBrokerContinuationSelfTest();
  const detachedBrokerHostDeath =
    await detachedBrokerHostDeathSelfTest();
  const forgedSameUidIntent = forgedSameUidIntentSelfTest();
  const portableSocket =
    Buffer.byteLength(brokerSocketPath(
      `${'f'.repeat(32)}.sock`,
      'darwin',
    )) <= 103;
  const cases = [
    ['queue delegates to RuntimeContract', queue.ok && formatRunScope(queue.value) === 'scope queue'],
    [
      'bounded issue delegates to RuntimeContract',
      bounded.ok && formatRunScope(bounded.value) === 'scope bounded(#7)',
    ],
    ['finish delegates complete absence', stop?.ok === true && stop.value.action === 'stop'],
    [
      'finish rejects incomplete absence',
      incomplete?.ok === false && incomplete.error.code === 'INCOMPLETE_PROGRESS',
    ],
    [
      'retired wall-clock stop reason is rejected',
      wallClock?.ok === false && wallClock.error.code === 'INVALID_STOP',
    ],
    [
      'legacy free-form CLI is rejected',
      parseArgs(['/autoloop:dev']).error?.includes('--open-json'),
    ],
    ['open CLI parses', parseArgs(['--open-json', '-']).mode === 'open'],
    ['finish CLI parses', parseArgs(['--finish-json', '/tmp/finish.json']).mode === 'finish'],
    ['plan CLI parses', parseArgs(['--plan-json', '-']).mode === 'plan'],
    ['compile CLI parses', parseArgs(['--compile-json', '-']).mode === 'compile'],
    ['execute CLI parses', parseArgs(['--execute-json', '-']).mode === 'execute'],
    [
      'retired native execution CLIs are rejected',
      parseArgs(['--authorize-native-json', '-']).mode === null
        && parseArgs(['--classify-json', '-']).mode === null
        && parseArgs(['--prepare-native-probe-json', '-']).mode === null
        && parseArgs(['--complete-native-probe-json', '-']).mode === null,
    ],
    ['observe CLI parses', parseArgs(['--observe-json', '-']).mode === 'observe'],
    [
      'measurement broker CLI parses exact closed operations',
      brokerMeasurement.parsing,
    ],
    [
      'capability refresh CLI parses',
      parseArgs(['--refresh-route-state-json', '-']).mode ===
        'refresh-route-state',
    ],
    [
      'continuation lease delegates to RuntimeContract',
      claimed?.ok === true
        && claimed.value.state.status === 'claimed'
        && claimed.value.state.leaseFingerprint ===
          relaunch.value.lease.fingerprint,
    ],
    [
      'continuation transition CLI parses',
      parseArgs(['--transition-continuation-json', '-']).mode ===
        'transition-continuation',
    ],
    [
      'continuation prompt preparation CLI parses',
      parseArgs(['--prepare-continuation-prompt-json', '-']).mode ===
        'prepare-continuation-prompt',
    ],
    [
      'continuation history validation CLI parses',
      parseArgs(['--validate-continuation-history-json', '-']).mode ===
        'validate-continuation-history',
    ],
    [
      'broker exposes no generic signing operation',
      operationForName('sign') === null
        && operationForName('authorize-value') === null,
    ],
    [
      'process execution cannot cross attempts or sessions',
      broker.ledger.authorize('execute', {
        attempt: {
          ...broker.reviewerAttempt,
          fingerprint: broker.writerAttempt.fingerprint,
        },
      }) === false
        && broker.ledger.authorize('execute', {
          attempt: {
            ...broker.writerAttempt,
            sessionFingerprint: 'd'.repeat(64),
          },
        }) === false,
    ],
    [
      'one process attempt can execute only once',
      (() => {
        const input = { attempt: broker.writerAttempt };
        if (!broker.ledger.authorize('execute', input)) return false;
        broker.ledger.retain('execute', input, {
          ok: true,
          value: { outcome: broker.writerOutcome },
        });
        return broker.ledger.authorize('execute', input) === false
          && broker.ledger.authorize('observe', {
            run: broker.run,
            routeState: broker.routeState,
            plan: broker.reviewerPlan,
            outcome: broker.writerOutcome,
          }) === false
          && broker.ledger.authorize('observe', {
            run: broker.run,
            routeState: broker.routeState,
            plan: broker.writerPlan,
            outcome: broker.writerOutcome,
          }) === true;
      })(),
    ],
    [
      'broker owns writer serialization, depth-one overlap, and plan-review count',
      brokerScheduling,
    ],
    [
      'measurement binding is exact, persistent, and idempotent',
      brokerMeasurement.binding,
    ],
    [
      'measurement run IDs cannot cross Runtime runs',
      brokerMeasurement.isolation,
    ],
    [
      'final receipts capture durably before broker retain',
      brokerMeasurement.capture,
    ],
    [
      'retry and fallback observations preserve the measured stage',
      brokerMeasurement.nonfinal,
    ],
    [
      'doctor final receipts remain exempt from measurement binding',
      brokerMeasurement.doctor,
    ],
    [
      'broker rejects mixed-session operation envelopes',
      brokerSessionsFor({
        current: { sessionFingerprint: 'c'.repeat(64) },
        foreign: { sessionFingerprint: 'd'.repeat(64) },
      }).length === 2,
    ],
    [
      'raw hostile child cannot bootstrap or cross broker capabilities',
      hostileBroker,
    ],
    [
      'concurrent stale-lock reclaim cannot unlink a replacement owner',
      staleLock,
    ],
    [
      'delayed cleanup cannot unlink a replacement lock owner',
      replacementLock,
    ],
    [
      'ownerless lock directories recover after creator crash',
      ownerlessLock,
    ],
    [
      'abandoned stale-lock recovery claims remain recoverable',
      abandonedRecoveryLock,
    ],
    [
      'terminal finish revokes every outstanding run-scoped capability',
      finishRevocation,
    ],
    [
      'shutdown destroys a held-open client before authority cleanup',
      stuckClient,
    ],
    [
      'broker shutdown observes bound host process death promptly',
      hostLiveness,
    ],
    [
      'terminal cleanup waits for a descheduled caller acknowledgement',
      terminalAcknowledgement,
    ],
    [
      'same-host continuation transfer is order-independent and terminal-safe',
      liveBrokerContinuation,
    ],
    [
      'detached broker removes all authority state when its host dies',
      detachedBrokerHostDeath,
    ],
    [
      'a forged same-UID hook record cannot upgrade provenance or merge policy',
      forgedSameUidIntent,
    ],
    [
      'Darwin broker socket path stays within sun_path',
      portableSocket,
    ],
  ];
  const failures = cases.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length === 1
    && args[0] === '--continuation-broker-self-test-driver'
  ) {
    const ok = await liveBrokerContinuationScenario(true)
      && await liveBrokerContinuationScenario(false);
    process.stdout.write(`${JSON.stringify({ ok })}\n`);
    process.exit(ok ? 0 : 1);
  }
  if (
    args.length === 3
    && args[0] === '--authority-broker'
  ) {
    await authorityBrokerMain(args[1], args[2]);
    return;
  }
  const authorityVerify =
    args.length === 2 && args[0] === '--authority-verify-json';
  const parsed = authorityVerify
    ? { mode: 'authority-verify', path: args[1], error: null }
    : parseArgs(args);
  if (parsed.error) {
    console.error(`run-scope: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') {
    process.exit(await selfTest() ? 0 : 1);
  }

  let input;
  try {
    input = readJsonInput(parsed.path);
  } catch (error) {
    console.error(`run-scope: unable to read JSON input: ${error.message}`);
    process.exit(2);
  }
  let result;
  if (parsed.mode === 'attest-host') {
    result = await startSessionBroker(input);
  } else {
    const operation = parsed.mode === 'authority-verify'
      ? 'verify-authorization'
      : parsed.mode;
    const sessionFingerprint = brokerTargetSession(operation, input);
    if (!HEX_64.test(sessionFingerprint ?? '')) {
      result = brokerFailure(
        'INVALID_BROKER_SESSION',
        'operation does not identify one broker target session',
      );
    } else {
      result = await requestSessionBroker(
        sessionFingerprint,
        operation,
        input,
      );
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(brokerFailure(
      'BROKER_UNAVAILABLE',
      `authority broker unavailable: ${error.message}`,
    ))}\n`);
    process.exit(1);
  });
}
