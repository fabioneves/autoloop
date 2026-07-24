#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyLaneProof,
  verifyLaneProof,
} from './lane-contract.mjs';
import { validateProjectConfig } from './config-contract.mjs';
import {
  artifactSourceFingerprint,
  classifyRouteAttempt,
  compileRouteAttempt,
  HOST_ADAPTER_AUTHORITY,
  HOST_ADAPTER_TRUST,
  issueCapabilitySnapshot,
  issueHostAttemptReceipt,
  issueHostEvidence,
  RUNTIME_DISPATCH_PLAN_KEYS,
  sealGitReviewSource,
  snapshotExecutionCheckout,
  validateCapabilitySnapshot,
  validateHostEvidence as validateHostEvidenceReceipt,
  validateArtifactSource,
  validateSealedArtifactSource,
  validateUnsealedArtifactSource,
  validateRouteAttemptOutcome,
} from './route-adapter-contract.mjs';

export const RUNTIME_CONTRACT_VERSION = 1;
export const CONFIG_VERSION = '0.25.0';
export const MAX_RELAUNCH_GENERATIONS = 25;
export const RELAUNCH_PROMPT =
  "Load the autoloop dev skill and drain the queue; auto-continue across sessions; stop per STATE's stop condition.";

export const HOSTS = Object.freeze(['claude', 'codex', 'opencode']);
export const SELECTORS = Object.freeze(['native', ...HOSTS]);
export const FLOWS = Object.freeze(['dev', 'pitcrew', 'doctor']);
export const STAGES = Object.freeze([
  'plan-review',
  'implementation',
  'code-review',
  'judgment-review',
  'doctor',
]);
export const LANES = Object.freeze(['docs', 'small', 'full']);
export const ATTEMPT_STATUSES = Object.freeze([
  'succeeded',
  'transient-failure',
  'environment-failure',
  'invalid-result',
]);
export const EFFECTS = Object.freeze(['none', 'complete', 'partial', 'unknown']);
export const ROLES = Object.freeze(['writer', 'reviewer', 'probe']);
export const REVIEW_SCOPES = Object.freeze([
  'write-artifact',
  'full-artifact',
  'fix-delta-and-open-rebuttals',
  'in-flight-decision',
  'capability-probe',
]);
export const ROUTE_STATUSES = Object.freeze(['healthy', 'outage']);
export const OUTAGE_TRANSITIONS = Object.freeze([
  'none',
  'probe',
  'entered',
  'continued',
  'recovered',
]);
export const DEGRADATIONS = Object.freeze([
  'native-fallback',
  'degraded-native-codex-review',
]);
export const STOP_REASONS = Object.freeze([
  'queue-exhausted',
  'context-budget',
  'invocation-bound-reached',
  'guardrail-failure',
]);
export const ERROR_CODES = Object.freeze([
  'INVALID_INTENT',
  'CONFLICTING_INTENT',
  'UNKNOWN_ACTIVE_HOST',
  'AMBIGUOUS_ACTIVE_HOST',
  'CONFIG_MIGRATION_REQUIRED',
  'UNSUPPORTED_ROUTE',
  'MISSING_CAPABILITY',
  'UNVERIFIABLE_ISOLATION',
  'STALE_LANE_PROOF',
  'EXPIRED_PLAN',
  'PARTIAL_WRITER_RESULT',
  'INVALID_RELAUNCH',
  'UNSAFE_FALLBACK',
  'AUTHOR_REVIEWER_COLLISION',
  'UNSAFE_CONCURRENCY',
  'INVALID_ATTEMPT_OUTCOME',
  'INVALID_STOP',
  'INCOMPLETE_PROGRESS',
]);

export const CAPABILITY_REQUIREMENTS = Object.freeze([
  'claude.agent.available',
  'claude.agent.fresh-context',
  'claude.agent.writer',
  'claude.agent.reviewer-read-only',
  'codex.worker.available',
  'codex.worker.fresh-context',
  'codex.worker.writer',
  'codex.exec.available',
  'codex.authenticated',
  'codex.version.0.145.0',
  'codex.exec.workspace-write',
  'codex.exec.read-only',
  'codex.exec.network-denied',
  'codex.verdict-schema',
  'codex.spawn.available',
  'codex.spawn.agent-type',
  'codex.spawn.fork-turns-none',
  'codex.spawn.effective-read-only',
  'codex.spawn.integrity',
  'artifact.codex-reviewer',
  'opencode.task.available',
  'opencode.task.fresh-context',
  'opencode.task.writer',
  'opencode.run.available',
  'opencode.authenticated',
  'opencode.version.1.18.3',
  'opencode.run.writer',
  'opencode.reviewer.typed',
  'opencode.reviewer.denied-tools',
  'opencode.verdict-schema',
  'artifact.opencode-reviewer',
]);
export const ISOLATION_REQUIREMENTS = Object.freeze([
  'claude.agent.fresh-context',
  'claude.agent.reviewer-read-only',
  'codex.worker.fresh-context',
  'codex.exec.workspace-write',
  'codex.exec.read-only',
  'codex.exec.network-denied',
  'codex.spawn.fork-turns-none',
  'codex.spawn.effective-read-only',
  'codex.spawn.integrity',
  'opencode.task.fresh-context',
  'opencode.run.writer',
  'opencode.reviewer.typed',
  'opencode.reviewer.denied-tools',
]);

const CODEX_ARTIFACT = Object.freeze({
  path: '.codex/agents/autoloop-reviewer.toml',
  validator: 'codex-reviewer-0.145',
  roles: Object.freeze(['reviewer', 'doctor']),
});
const OPENCODE_ARTIFACT = Object.freeze({
  path: '.opencode/agent/autoloop-reviewer.md',
  validator: 'opencode-reviewer-1.18.3',
  roles: Object.freeze(['reviewer', 'doctor']),
});

const posture = (execution, requirements, mode, degraded) => ({
  execution,
  requirements,
  isolation: { mode },
  ...(degraded ? { degraded } : {}),
});

export const ROUTE_CATALOG = deepFreeze({
  'claude.native': {
    id: 'claude.native',
    activeHost: 'claude',
    requestedEngine: 'claude',
    native: true,
    adapterOptionsKey: 'claude.native',
    requiredArtifacts: [],
    doctor: {
      executable: null,
      minimumVersion: null,
      staticChecks: [],
      liveChecks: [
        'claude.agent.available',
        'claude.agent.fresh-context',
        'claude.agent.writer',
        'claude.agent.reviewer-read-only',
      ],
      inactiveStatus: 'unverified',
    },
    postures: {
      writer: posture(
        'claude.fresh-agent-writer',
        [
          'claude.agent.available',
          'claude.agent.fresh-context',
          'claude.agent.writer',
        ],
        'fresh-writable-agent',
      ),
      reviewer: posture(
        'claude.fresh-agent-reviewer',
        [
          'claude.agent.available',
          'claude.agent.fresh-context',
          'claude.agent.reviewer-read-only',
        ],
        'fresh-read-only-agent',
      ),
      probe: posture(
        'claude.live-doctor',
        [
          'claude.agent.available',
          'claude.agent.fresh-context',
          'claude.agent.writer',
          'claude.agent.reviewer-read-only',
        ],
        'live-route-probe',
      ),
    },
  },
  'codex.native': {
    id: 'codex.native',
    activeHost: 'codex',
    requestedEngine: 'codex',
    native: true,
    adapterOptionsKey: null,
    requiredArtifacts: [CODEX_ARTIFACT],
    doctor: {
      executable: 'codex',
      minimumVersion: '0.145.0',
      staticChecks: ['artifact.codex-reviewer'],
      liveChecks: [
        'codex.worker.available',
        'codex.worker.fresh-context',
        'codex.worker.writer',
        'codex.exec.available',
        'codex.authenticated',
        'codex.version.0.145.0',
        'codex.exec.read-only',
        'codex.exec.network-denied',
        'codex.verdict-schema',
      ],
      inactiveStatus: 'unverified',
    },
    postures: {
      writer: posture(
        'codex.fresh-writable-worker',
        [
          'codex.worker.available',
          'codex.worker.fresh-context',
          'codex.worker.writer',
        ],
        'fresh-writable-worker',
      ),
      reviewer: posture(
        'codex.exec-read-only',
        [
          'codex.exec.available',
          'codex.authenticated',
          'codex.version.0.145.0',
          'codex.exec.read-only',
          'codex.exec.network-denied',
          'codex.verdict-schema',
          'artifact.codex-reviewer',
        ],
        'os-read-only',
        posture(
          'codex.in-session-reviewer',
          [
            'codex.spawn.available',
            'codex.spawn.agent-type',
            'codex.spawn.fork-turns-none',
            'codex.spawn.effective-read-only',
            'codex.spawn.integrity',
            'artifact.codex-reviewer',
          ],
          'integrity-checked-read-only',
        ),
      ),
      probe: posture(
        'codex.live-doctor',
        [
          'codex.worker.available',
          'codex.worker.fresh-context',
          'codex.worker.writer',
          'codex.exec.available',
          'codex.authenticated',
          'codex.version.0.145.0',
          'codex.exec.read-only',
          'codex.exec.network-denied',
          'codex.verdict-schema',
          'artifact.codex-reviewer',
        ],
        'live-route-probe',
        posture(
          'codex.degraded-live-doctor',
          [
            'codex.worker.available',
            'codex.worker.fresh-context',
            'codex.worker.writer',
            'codex.spawn.available',
            'codex.spawn.agent-type',
            'codex.spawn.fork-turns-none',
            'codex.spawn.effective-read-only',
            'codex.spawn.integrity',
            'artifact.codex-reviewer',
          ],
          'degraded-live-route-probe',
        ),
      ),
    },
  },
  'opencode.native': {
    id: 'opencode.native',
    activeHost: 'opencode',
    requestedEngine: 'opencode',
    native: true,
    adapterOptionsKey: null,
    requiredArtifacts: [OPENCODE_ARTIFACT],
    doctor: {
      executable: 'opencode',
      minimumVersion: '1.18.3',
      staticChecks: ['artifact.opencode-reviewer'],
      liveChecks: [
        'opencode.task.available',
        'opencode.task.fresh-context',
        'opencode.task.writer',
        'opencode.version.1.18.3',
        'opencode.reviewer.typed',
        'opencode.reviewer.denied-tools',
        'opencode.verdict-schema',
      ],
      inactiveStatus: 'unverified',
    },
    postures: {
      writer: posture(
        'opencode.fresh-task-writer',
        [
          'opencode.task.available',
          'opencode.task.fresh-context',
          'opencode.task.writer',
        ],
        'fresh-writable-task',
      ),
      reviewer: posture(
        'opencode.typed-reviewer',
        [
          'opencode.task.available',
          'opencode.task.fresh-context',
          'opencode.version.1.18.3',
          'opencode.reviewer.typed',
          'opencode.reviewer.denied-tools',
          'opencode.verdict-schema',
          'artifact.opencode-reviewer',
        ],
        'typed-deny-read-only',
      ),
      probe: posture(
        'opencode.live-doctor',
        [
          'opencode.task.available',
          'opencode.task.fresh-context',
          'opencode.task.writer',
          'opencode.version.1.18.3',
          'opencode.reviewer.typed',
          'opencode.reviewer.denied-tools',
          'opencode.verdict-schema',
          'artifact.opencode-reviewer',
        ],
        'live-route-probe',
      ),
    },
  },
  'claude.codex-exec': {
    id: 'claude.codex-exec',
    activeHost: 'claude',
    requestedEngine: 'codex',
    native: false,
    adapterOptionsKey: 'claude.codex-exec',
    requiredArtifacts: [CODEX_ARTIFACT],
    doctor: {
      executable: 'codex',
      minimumVersion: '0.145.0',
      staticChecks: ['artifact.codex-reviewer'],
      liveChecks: [
        'codex.exec.available',
        'codex.authenticated',
        'codex.version.0.145.0',
        'codex.exec.workspace-write',
        'codex.exec.read-only',
        'codex.exec.network-denied',
        'codex.verdict-schema',
      ],
      inactiveStatus: 'unverified',
    },
    postures: {
      writer: posture(
        'codex.exec-workspace-write',
        [
          'codex.exec.available',
          'codex.authenticated',
          'codex.version.0.145.0',
          'codex.exec.workspace-write',
        ],
        'fresh-workspace-write-process',
      ),
      reviewer: posture(
        'codex.exec-read-only',
        [
          'codex.exec.available',
          'codex.authenticated',
          'codex.version.0.145.0',
          'codex.exec.read-only',
          'codex.exec.network-denied',
          'codex.verdict-schema',
          'artifact.codex-reviewer',
        ],
        'os-read-only',
      ),
      probe: posture(
        'codex.exec-live-doctor',
        [
          'codex.exec.available',
          'codex.authenticated',
          'codex.version.0.145.0',
          'codex.exec.workspace-write',
          'codex.exec.read-only',
          'codex.exec.network-denied',
          'codex.verdict-schema',
          'artifact.codex-reviewer',
        ],
        'live-route-probe',
      ),
    },
  },
  'claude.opencode-exec': {
    id: 'claude.opencode-exec',
    activeHost: 'claude',
    requestedEngine: 'opencode',
    native: false,
    adapterOptionsKey: 'claude.opencode-exec',
    requiredArtifacts: [OPENCODE_ARTIFACT],
    doctor: {
      executable: 'opencode',
      minimumVersion: '1.18.3',
      staticChecks: ['artifact.opencode-reviewer'],
      liveChecks: [
        'opencode.run.available',
        'opencode.authenticated',
        'opencode.version.1.18.3',
        'opencode.run.writer',
        'opencode.reviewer.typed',
        'opencode.reviewer.denied-tools',
        'opencode.verdict-schema',
      ],
      inactiveStatus: 'unverified',
    },
    postures: {
      writer: posture(
        'opencode.run-writer',
        [
          'opencode.run.available',
          'opencode.authenticated',
          'opencode.version.1.18.3',
          'opencode.run.writer',
        ],
        'fresh-writable-process',
      ),
      reviewer: posture(
        'opencode.run-typed-reviewer',
        [
          'opencode.run.available',
          'opencode.authenticated',
          'opencode.version.1.18.3',
          'opencode.reviewer.typed',
          'opencode.reviewer.denied-tools',
          'opencode.verdict-schema',
          'artifact.opencode-reviewer',
        ],
        'typed-deny-read-only',
      ),
      probe: posture(
        'opencode.run-live-doctor',
        [
          'opencode.run.available',
          'opencode.authenticated',
          'opencode.version.1.18.3',
          'opencode.run.writer',
          'opencode.reviewer.typed',
          'opencode.reviewer.denied-tools',
          'opencode.verdict-schema',
          'artifact.opencode-reviewer',
        ],
        'live-route-probe',
      ),
    },
  },
});

const OPEN_KEYS = [
  'invocation',
  'hostEvidence',
  'config',
  'continuation',
  'continuationLease',
  'continuationState',
  'continuationAuthorization',
];
const HOST_EVIDENCE_KEYS = [
  'kind',
  'version',
  'authority',
  'trustModel',
  'source',
  'observedHosts',
  'integration',
  'sessionFingerprint',
  'invocationNonce',
  'observedSurfaceFingerprint',
  'authorization',
  'fingerprint',
];
const ENVELOPE_KEYS = [
  'v',
  'originHost',
  'selector',
  'scope',
  'generation',
  'runIntentHash',
];
const CONTINUATION_LEASE_KEYS = [
  'kind',
  'version',
  'sourceRunInstanceFingerprint',
  'sourceConfigFingerprint',
  'runIntentHash',
  'originHost',
  'selector',
  'scope',
  'fromGeneration',
  'toGeneration',
  'envelopeFingerprint',
  'repositoryFingerprint',
  'expectedBaseBranch',
  'expectedHeadOid',
  'sessionFingerprint',
  'authorization',
  'fingerprint',
];
const CONTINUATION_STATE_KEYS = [
  'kind',
  'version',
  'leaseFingerprint',
  'generation',
  'status',
  'revision',
  'previousStateFingerprint',
  'claimFingerprint',
  'sessionFingerprint',
  'authorization',
  'fingerprint',
];
const CONTINUATION_AUTHORIZATION_KEYS = [
  'kind',
  'version',
  'leaseFingerprint',
  'openedStateFingerprint',
  'sessionFingerprint',
  'generation',
  'authorization',
  'fingerprint',
];
const RUN_KEYS = [
  'version',
  'configVersion',
  'invocationFlow',
  'originHost',
  'activeHost',
  'hostEvidenceFingerprint',
  'sessionFingerprint',
  'invocationNonce',
  'selector',
  'requestedEngine',
  'requestedRoute',
  'scope',
  'generation',
  'runIntentHash',
  'configuredBaseBranch',
  'configFingerprint',
  'instanceFingerprint',
  'authorization',
];
const WORK_KEYS = [
  'flow',
  'stage',
  'round',
  'planReviewDispatches',
  'configuredBaseOid',
  'checkout',
  'artifact',
  'concurrency',
];
const CONCURRENCY_KEYS = [
  'activeWriters',
  'stagedAhead',
  'stagedAheadReadOnly',
];
const ROUTE_STATE_KEYS = [
  'kind',
  'version',
  'runInstanceFingerprint',
  'status',
  'requestedRoute',
  'consecutiveFailures',
  'capabilityFingerprint',
  'sequence',
  'lastTransition',
  'fingerprint',
];
const ROUTE_TRANSITION_KEYS = [
  'kind',
  'version',
  'source',
  'runInstanceFingerprint',
  'sequence',
  'previousStateFingerprint',
  'planFingerprint',
  'outcomeEvidenceFingerprint',
  'event',
  'fromStatus',
  'toStatus',
  'consecutiveFailures',
  'previousCapabilityFingerprint',
  'capabilityFingerprint',
  'fingerprint',
];
const PLAN_KEYS = RUNTIME_DISPATCH_PLAN_KEYS;
const ATTEMPT_EVIDENCE_KEYS = [
  'attempt',
  'planFingerprint',
  'route',
  'adapter',
  'execution',
  'status',
  'effect',
  'launchStatus',
  'evidenceFingerprint',
  'executionEvidence',
  'actorIdentityFingerprint',
  'isolation',
  'modelIdentity',
  'verdict',
];
const REVIEW_VERDICT_ENTRY_KEYS = [
  'attempt',
  'planFingerprint',
  'route',
  'evidenceFingerprint',
  'verdict',
];
const RUNTIME_RECEIPT_KEYS = [
  'version',
  'runIntentHash',
  'generation',
  'hostEvidenceFingerprint',
  'runInstanceFingerprint',
  'invocationNonce',
  'configFingerprint',
  'checkout',
  'sessionFingerprint',
  'invocationFlow',
  'activeHost',
  'selector',
  'requestedEngine',
  'requestedRoute',
  'actualRoute',
  'adapter',
  'execution',
  'flow',
  'stage',
  'round',
  'role',
  'reviewScope',
  'planFingerprint',
  'modelIdentity',
  'isolation',
  'effect',
  'configuredBaseOid',
  'artifactSubject',
  'artifactVersion',
  'artifactFingerprint',
  'artifactSource',
  'artifactAuthorFingerprint',
  'actorIdentityFingerprint',
  'laneProofFingerprint',
  'capabilityFingerprint',
  'attemptCount',
  'attempts',
  'reviewVerdicts',
  'outageTransition',
  'fallback',
  'degradation',
  'routeState',
  'authorization',
  'fingerprint',
];
const PROGRESS_KEYS = [
  'reason',
  'eligibleRemaining',
  'unitsCompleted',
  'queueComplete',
];
const CHECKOUT_KEYS = [
  'repositoryFingerprint',
  'branch',
  'headOid',
  'clean',
];
const EXECUTION_CHECKOUT_KEYS = [
  'root',
  ...CHECKOUT_KEYS,
];
const FORBIDDEN_CONFIG_KEYS = [
  'runtime',
  'engine',
  'activeHost',
  'requestedEngine',
  'requestedRoute',
  'resolvedRoute',
  'capabilities',
  'capability',
  'outage',
  'routeState',
];
const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_40 = /^[a-f0-9]{40}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const AUTHORIZATION_DIRECTORY =
  join(
    process.env.XDG_RUNTIME_DIR || tmpdir(),
    `autoloop-authority-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
  );
const AUTHORIZATION_DOMAIN = 'autoloop-host-adapter-authority-v1';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonSerializable(value) {
  const seen = new Set();
  let nodes = 0;
  let stringUnits = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > 10000 || depth > 20) return false;
    if (current === null || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current === 'string') {
      stringUnits += current.length;
      return stringUnits <= 262144;
    }
    if (typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > 1000) return false;
      const valid = current.every((entry) => visit(entry, depth + 1));
      seen.delete(current);
      return valid;
    }
    if (!isPlainObject(current)) return false;
    const keys = Object.keys(current);
    if (keys.length > 1000) return false;
    const valid = keys.every((key) => {
      stringUnits += key.length;
      return stringUnits <= 262144 && visit(current[key], depth + 1);
    });
    seen.delete(current);
    return valid;
  };
  return visit(value, 0);
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value, allowed, optional = []) {
  if (!hasOnlyKeys(value, [...allowed, ...optional])) return false;
  return allowed.every((key) => Object.hasOwn(value, key));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function hashValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function authorityKey(sessionFingerprint) {
  if (!HEX_64.test(sessionFingerprint)) {
    throw new Error('session fingerprint is invalid');
  }
  const directoryStats = lstatSync(AUTHORIZATION_DIRECTORY);
  if (
    !directoryStats.isDirectory()
    || directoryStats.isSymbolicLink()
    || typeof process.getuid === 'function'
      && directoryStats.uid !== process.getuid()
  ) {
    throw new Error('host authority path is invalid');
  }
  const descriptor = openSync(
    join(AUTHORIZATION_DIRECTORY, `${sessionFingerprint}.key`),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile()
      || typeof process.getuid === 'function' && stats.uid !== process.getuid()
      || (stats.mode & 0o077) !== 0
    ) {
      throw new Error('host authority key permissions are invalid');
    }
    const value = readFileSync(descriptor, 'utf8');
    if (!HEX_64.test(value)) throw new Error('host authority key is invalid');
    return value;
  } finally {
    closeSync(descriptor);
  }
}

function authorizeValue(value, sessionFingerprint) {
  return createHmac('sha256', authorityKey(sessionFingerprint))
    .update(AUTHORIZATION_DOMAIN)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function authorizedFingerprinted(value, sessionFingerprint) {
  const authorization = authorizeValue(value, sessionFingerprint);
  return {
    ...value,
    authorization,
    fingerprint: hashValue({ ...value, authorization }),
  };
}

function validAuthorization(value, sessionFingerprint, authorization) {
  if (!HEX_64.test(authorization)) return false;
  try {
    const expected = authorizeValue(value, sessionFingerprint);
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(authorization, 'hex'),
    );
  } catch {
    return false;
  }
}

function success(value) {
  return deepFreeze({ ok: true, value: deepFreeze(value) });
}

function failure(code, message, extra = {}) {
  return deepFreeze({ ok: false, error: { code, message, ...extra } });
}

function invalidIntent(message = 'runtime intent is invalid') {
  return failure('INVALID_INTENT', message);
}

function migrateConfigFailure() {
  return failure(
    'CONFIG_MIGRATION_REQUIRED',
    `runtime requires configuration schema ${CONFIG_VERSION}`,
    {
      remedy:
        'Run /autoloop:setup to migrate STATE to configuration schema 0.25.0.',
    },
  );
}

function validateScope(scope) {
  if (!isPlainObject(scope) || !['queue', 'bounded'].includes(scope.scope)) return false;
  if (scope.scope === 'queue') {
    return hasExactKeys(scope, ['scope'], ['autoContinue'])
      && (scope.autoContinue === undefined || typeof scope.autoContinue === 'boolean');
  }
  return hasExactKeys(scope, ['scope', 'maxUnits'], ['issue'])
    && Number.isSafeInteger(scope.maxUnits)
    && scope.maxUnits >= 1
    && scope.maxUnits <= 1000
    && (scope.issue === undefined
      || (Number.isSafeInteger(scope.issue) && scope.issue >= 1));
}

function parseScope(invocation) {
  const candidates = [];
  const issueMatches = [
    ...invocation.matchAll(/\b(?:only|just)\s+(?:issue\s+)?#(\d+)\b/gi),
  ];
  const maxMatches = [
    ...invocation.matchAll(/\bmaxUnits\s*[:=]\s*([+-]?\d+)\b/gi),
  ];
  const oneMatches = [
    ...invocation.matchAll(
      /\b(?:take|do|run|process|complete|ship)\s+(?:just\s+|only\s+)?one\s+(?:issue|unit)\b/gi,
    ),
    ...invocation.matchAll(
      /\bstop\s+after\s+(?:just\s+)?one\s+(?:issue|unit)\b/gi,
    ),
  ];
  if (issueMatches.length > 1 || maxMatches.length > 1 || oneMatches.length > 1) {
    return failure('CONFLICTING_INTENT', 'invocation carries repeated scope intent');
  }
  if (issueMatches.length === 1) {
    const issue = Number(issueMatches[0][1]);
    if (!Number.isSafeInteger(issue) || issue < 1) {
      return invalidIntent('bounded issue intent is invalid');
    }
    candidates.push({ scope: 'bounded', maxUnits: 1, issue });
  }
  if (maxMatches.length === 1) {
    const maxUnits = Number(maxMatches[0][1]);
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 1 || maxUnits > 1000) {
      return invalidIntent('maxUnits must be an integer from 1 through 1000');
    }
    candidates.push({ scope: 'bounded', maxUnits });
  }
  if (oneMatches.length === 1) {
    candidates.push({ scope: 'bounded', maxUnits: 1 });
  }
  if (candidates.length > 1) {
    return failure('CONFLICTING_INTENT', 'invocation carries conflicting scope intent');
  }
  const phrase = invocation.match(
    /\bauto[-\s]?continue\b|\b(?:relaunch|keep going|continue)\s+across\s+sessions\b/i,
  );
  let autoContinue = false;
  if (phrase) {
    const before = invocation.slice(0, phrase.index).slice(-24);
    const after = invocation
      .slice(phrase.index + phrase[0].length)
      .slice(0, 20);
    autoContinue = !/\b(?:no|not|without|skip|don'?t|disable)\b/i.test(before)
      && !/\b(?:disabled?|off|not)\b/i.test(after);
  }
  if (candidates.length === 1 && autoContinue) {
    return failure(
      'CONFLICTING_INTENT',
      'bounded scope cannot auto-continue across sessions',
    );
  }
  return success(
    candidates[0]
      ?? { scope: 'queue', ...(autoContinue ? { autoContinue: true } : {}) },
  );
}

function parseInvocation(invocation) {
  if (typeof invocation !== 'string' || invocation.length < 1 || invocation.length > 4096) {
    return invalidIntent('invocation must be a non-empty bounded string');
  }
  if (
    /\b(?:use|using|select|choose|via|on)\s+(?:the\s+)?(?:claude|codex|opencode)\b/i
      .test(invocation)
    || /\b(?:claude|codex|opencode)\s+(?:engine|model)\b/i
      .test(invocation)
    || /(?:^|\s)--engine(?:\s+|=)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;,.!?]+)/i
      .test(invocation)
    || /\bengine\s*(?:=|:)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[a-z][a-z0-9._/-]*)/i
      .test(invocation)
    || /(?:^|\s)--engine\s*(?:=\s*)?(?=$|[;,.!?])/i.test(invocation)
    || /\bengine\s*(?:=|:)\s*(?=$|[;,.!?])/i.test(invocation)
    || /\/autoloop:(?:dev|pitcrew|doctor)\b\s+with\s*(?:(?:=|:)\s*)?(?=$|[;,.!?])/i
      .test(invocation)
    || /\bwith(?:=|:)(?:claude|codex|opencode)\b/i.test(invocation)
  ) {
    return invalidIntent(
      'engine selector must use the canonical trailing "with <engine>" suffix',
    );
  }
  if (/\[autoloop-relaunch\s+gen=/i.test(invocation)) {
    return failure('INVALID_RELAUNCH', 'v1 relaunch markers are not accepted');
  }
  let invocationFlow;
  if (invocation === RELAUNCH_PROMPT) {
    invocationFlow = 'dev';
  } else {
    const flows = [];
    if (/\/autoloop:dev\b/i.test(invocation)) flows.push('dev');
    if (/\/autoloop:pitcrew\b/i.test(invocation)) flows.push('pitcrew');
    if (
      /\/autoloop:doctor\b/i.test(invocation)
      || /\/autoloop:setup\b[\s\S]*\bdoctor\b/i.test(invocation)
    ) {
      flows.push('doctor');
    }
    if (flows.length > 1) {
      return failure(
        'CONFLICTING_INTENT',
        'invocation carries more than one Autoloop flow',
      );
    }
    if (flows.length === 0) {
      return invalidIntent('invocation does not identify Dev, Pitcrew, or doctor');
    }
    [invocationFlow] = flows;
  }
  const directSelector = invocation.match(
    /\/autoloop:(?:dev|pitcrew|doctor)\b\s+with(?:\s+|=|:)([^\s;,.!?]+)/i,
  );
  if (
    directSelector
    && !HOSTS.includes(directSelector[1].toLowerCase())
  ) {
    return invalidIntent('invocation carries an unknown engine selector');
  }
  const engineOccurrences = [
    ...invocation.matchAll(/\bwith\s+(claude|codex|opencode)\b/gi),
  ];
  if (engineOccurrences.length > 1) {
    return failure(
      'CONFLICTING_INTENT',
      'invocation carries more than one engine selector',
    );
  }
  const engineSuffix = invocation.match(
    /\bwith\s+(claude|codex|opencode)\s*[.!?]?\s*$/i,
  );
  if (engineOccurrences.length === 1 && !engineSuffix) {
    return invalidIntent('engine selector must be the canonical invocation suffix');
  }
  const selector = engineSuffix
    ? engineSuffix[1].toLowerCase()
    : 'native';
  const scope = parseScope(invocation);
  if (!scope.ok) return scope;
  return success({
    selector,
    selectorExplicit: engineSuffix !== null,
    invocationFlow,
    scope: scope.value,
  });
}

function routeFor(activeHost, requestedEngine) {
  if (activeHost === requestedEngine) return `${activeHost}.native`;
  if (activeHost === 'claude' && requestedEngine === 'codex') {
    return 'claude.codex-exec';
  }
  if (activeHost === 'claude' && requestedEngine === 'opencode') {
    return 'claude.opencode-exec';
  }
  return null;
}

function intentHash(originHost, selector, scope, invocationFlow) {
  return hashValue({
    version: RUNTIME_CONTRACT_VERSION,
    configVersion: CONFIG_VERSION,
    invocationFlow,
    originHost,
    selector,
    scope,
  });
}

function runInstanceFingerprint({
  runIntentHash,
  originHost,
  activeHost,
  hostEvidenceFingerprint,
  sessionFingerprint,
  invocationNonce,
  configuredBaseBranch,
  configFingerprint,
  generation,
}) {
  return hashValue({
    kind: 'autoloop-run-instance',
    version: 1,
    runIntentHash,
    originHost,
    activeHost,
    hostEvidenceFingerprint,
    sessionFingerprint,
    invocationNonce,
    configuredBaseBranch,
    configFingerprint,
    generation,
  });
}

function fingerprinted(value) {
  return {
    ...value,
    fingerprint: hashValue(value),
  };
}

function validateHostEvidence(evidence) {
  if (
    !hasExactKeys(evidence, HOST_EVIDENCE_KEYS)
  ) {
    return failure(
      'UNKNOWN_ACTIVE_HOST',
      'active host requires one sealed local HostAdapter attestation',
    );
  }
  if (evidence.observedHosts.length > 1) {
    return failure(
      'AMBIGUOUS_ACTIVE_HOST',
      'live integration attested more than one active host',
    );
  }
  if (!validateHostEvidenceReceipt(evidence)) {
    return failure(
      'UNKNOWN_ACTIVE_HOST',
      'active host requires one sealed local HostAdapter attestation',
    );
  }
  if (
    evidence.observedHosts.length !== 1
    || !HOSTS.includes(evidence.observedHosts[0])
  ) {
    return failure(
      'UNKNOWN_ACTIVE_HOST',
      'live integration did not attest one known active host',
    );
  }
  return success({
    activeHost: evidence.observedHosts[0],
    fingerprint: evidence.fingerprint,
    sessionFingerprint: evidence.sessionFingerprint,
    invocationNonce: evidence.invocationNonce,
  });
}

function validateConfigInput(config) {
  if (
    !isPlainObject(config)
    || !isJsonSerializable(config)
    || validateProjectConfig(config).length !== 0
  ) {
    return migrateConfigFailure();
  }
  if (FORBIDDEN_CONFIG_KEYS.some((key) => Object.hasOwn(config, key))) {
    return migrateConfigFailure();
  }
  return success(true);
}

function validateEnvelope(envelope, activeHost, parsed) {
  if (!hasExactKeys(envelope, ENVELOPE_KEYS)) {
    return failure('INVALID_RELAUNCH', 'v2 relaunch envelope has an invalid shape');
  }
  if (
    envelope.v !== 2
    || !HOSTS.includes(envelope.originHost)
    || !SELECTORS.includes(envelope.selector)
    || !validateScope(envelope.scope)
    || !Number.isSafeInteger(envelope.generation)
    || envelope.generation < 1
    || envelope.generation > MAX_RELAUNCH_GENERATIONS
    || !HEX_64.test(envelope.runIntentHash)
  ) {
    return failure('INVALID_RELAUNCH', 'v2 relaunch envelope is invalid');
  }
  if (envelope.originHost !== activeHost) {
    return failure('INVALID_RELAUNCH', 'relaunch active host does not match its origin');
  }
  if (parsed.selectorExplicit && parsed.selector !== envelope.selector) {
    return failure(
      'CONFLICTING_INTENT',
      'current selector conflicts with the relaunch selector',
    );
  }
  if (
    parsed.invocationFlow !== 'dev'
    || hashValue(parsed.scope) !== hashValue(envelope.scope)
  ) {
    return failure(
      'INVALID_RELAUNCH',
      'relaunch prompt and envelope scope do not match',
    );
  }
  if (intentHash(
    envelope.originHost,
    envelope.selector,
    envelope.scope,
    'dev',
  )
    !== envelope.runIntentHash) {
    return failure('INVALID_RELAUNCH', 'relaunch run-intent hash is stale or corrupt');
  }
  return success(envelope);
}

function makeContinuationLease(run, envelope, checkout) {
  return authorizedFingerprinted({
    kind: 'autoloop-continuation-lease',
    version: 1,
    sourceRunInstanceFingerprint: run.instanceFingerprint,
    sourceConfigFingerprint: run.configFingerprint,
    runIntentHash: run.runIntentHash,
    originHost: run.originHost,
    selector: run.selector,
    scope: run.scope,
    fromGeneration: run.generation,
    toGeneration: envelope.generation,
    envelopeFingerprint: hashValue(envelope),
    repositoryFingerprint: checkout.repositoryFingerprint,
    expectedBaseBranch: checkout.branch,
    expectedHeadOid: checkout.headOid,
    sessionFingerprint: run.sessionFingerprint,
  }, run.sessionFingerprint);
}

const CONTINUATION_STATUSES = [
  'issued',
  'claimed',
  'session-created',
  'opened',
  'prompted',
];

function makeContinuationState(
  lease,
  status,
  previousStateFingerprint = null,
  claimFingerprint = null,
  sessionFingerprint = null,
) {
  return authorizedFingerprinted({
    kind: 'autoloop-continuation-state',
    version: 1,
    leaseFingerprint: lease.fingerprint,
    generation: lease.toGeneration,
    status,
    revision: CONTINUATION_STATUSES.indexOf(status),
    previousStateFingerprint,
    claimFingerprint,
    sessionFingerprint,
  }, lease.sessionFingerprint);
}

function makeContinuationAuthorization(lease, openedState) {
  return authorizedFingerprinted({
    kind: 'autoloop-continuation-authorization',
    version: 1,
    leaseFingerprint: lease.fingerprint,
    openedStateFingerprint: openedState.fingerprint,
    sessionFingerprint: openedState.sessionFingerprint,
    generation: lease.toGeneration,
  }, lease.sessionFingerprint);
}

function validFingerprinted(value, keys) {
  if (!hasExactKeys(value, keys) || !HEX_64.test(value.fingerprint)) {
    return false;
  }
  const unsigned = { ...value };
  delete unsigned.fingerprint;
  return value.fingerprint === hashValue(unsigned);
}

function validateContinuationLease(lease, envelope = null) {
  const authorizationInput = isPlainObject(lease) ? { ...lease } : null;
  if (authorizationInput) {
    delete authorizationInput.authorization;
    delete authorizationInput.fingerprint;
  }
  if (
    !validFingerprinted(lease, CONTINUATION_LEASE_KEYS)
    || lease.kind !== 'autoloop-continuation-lease'
    || lease.version !== 1
    || !HEX_64.test(lease.sourceRunInstanceFingerprint)
    || !HEX_64.test(lease.sourceConfigFingerprint)
    || !HEX_64.test(lease.runIntentHash)
    || !HOSTS.includes(lease.originHost)
    || !SELECTORS.includes(lease.selector)
    || !validateScope(lease.scope)
    || !Number.isSafeInteger(lease.fromGeneration)
    || lease.fromGeneration < 0
    || !Number.isSafeInteger(lease.toGeneration)
    || lease.toGeneration !== lease.fromGeneration + 1
    || lease.toGeneration > MAX_RELAUNCH_GENERATIONS
    || !HEX_64.test(lease.envelopeFingerprint)
    || !HEX_64.test(lease.repositoryFingerprint)
    || typeof lease.expectedBaseBranch !== 'string'
    || lease.expectedBaseBranch.length < 1
    || lease.expectedBaseBranch.length > 255
    || /[\x00-\x20\x7f~^:?*[\\]/.test(lease.expectedBaseBranch)
    || !HEX_40.test(lease.expectedHeadOid)
    || !HEX_64.test(lease.sessionFingerprint)
    || !validAuthorization(
      authorizationInput,
      lease.sessionFingerprint,
      lease.authorization,
    )
  ) {
    return false;
  }
  if (envelope === null) return true;
  return lease.envelopeFingerprint === hashValue(envelope)
    && lease.runIntentHash === envelope.runIntentHash
    && lease.originHost === envelope.originHost
    && lease.selector === envelope.selector
    && hashValue(lease.scope) === hashValue(envelope.scope)
    && lease.toGeneration === envelope.generation;
}

function validateContinuationState(state, lease, status) {
  const authorizationInput = isPlainObject(state) ? { ...state } : null;
  if (authorizationInput) {
    delete authorizationInput.authorization;
    delete authorizationInput.fingerprint;
  }
  if (
    !validFingerprinted(state, CONTINUATION_STATE_KEYS)
    || state.kind !== 'autoloop-continuation-state'
    || state.version !== 1
    || state.status !== status
    || state.leaseFingerprint !== lease.fingerprint
    || state.generation !== lease.toGeneration
    || state.revision !== CONTINUATION_STATUSES.indexOf(status)
    || !validAuthorization(
      authorizationInput,
      lease.sessionFingerprint,
      state.authorization,
    )
  ) {
    return false;
  }
  if (status === 'issued') {
    return state.previousStateFingerprint === null
      && state.claimFingerprint === null
      && state.sessionFingerprint === null
      && hashValue(state) === hashValue(makeContinuationState(lease, 'issued'));
  }
  return HEX_64.test(state.previousStateFingerprint)
    && HEX_64.test(state.claimFingerprint)
    && (
      status === 'claimed'
        ? state.sessionFingerprint === null
        : HEX_64.test(state.sessionFingerprint)
    );
}

function validateContinuationAuthorization(authorization, lease, state) {
  const authorizationInput = isPlainObject(authorization)
    ? { ...authorization }
    : null;
  if (authorizationInput) {
    delete authorizationInput.authorization;
    delete authorizationInput.fingerprint;
  }
  if (
    !validFingerprinted(
      authorization,
      CONTINUATION_AUTHORIZATION_KEYS,
    )
    || authorization.kind !== 'autoloop-continuation-authorization'
    || authorization.version !== 1
    || !validateContinuationState(state, lease, 'opened')
    || !validAuthorization(
      authorizationInput,
      lease.sessionFingerprint,
      authorization.authorization,
    )
  ) {
    return false;
  }
  const expected = makeContinuationAuthorization(lease, state);
  return hashValue(authorization) === hashValue(expected);
}

function transitionContinuationLeasePolicy(input) {
  if (
    !hasOnlyKeys(
      input,
      [
        'lease',
        'state',
        'nextStatus',
        'claimFingerprint',
        'sessionFingerprint',
      ],
    )
    || !['lease', 'state', 'nextStatus'].every((key) =>
      Object.hasOwn(input, key))
  ) {
    return failure(
      'INVALID_RELAUNCH',
      'continuation lease transition input has an invalid shape',
    );
  }
  const currentIndex = CONTINUATION_STATUSES.indexOf(input.state?.status);
  const nextIndex = CONTINUATION_STATUSES.indexOf(input.nextStatus);
  if (
    !validateContinuationLease(input.lease)
    || currentIndex < 0
    || !validateContinuationState(
      input.state,
      input.lease,
      input.state.status,
    )
    || ![currentIndex, currentIndex + 1].includes(nextIndex)
  ) {
    return failure(
      'INVALID_RELAUNCH',
      'continuation lease transition is stale, skipped, or invalid',
    );
  }
  const claimFingerprint =
    input.claimFingerprint ?? input.state.claimFingerprint;
  const sessionFingerprint =
    input.sessionFingerprint ?? input.state.sessionFingerprint;
  if (
    nextIndex >= 1 && !HEX_64.test(claimFingerprint)
    || nextIndex >= 2 && !HEX_64.test(sessionFingerprint)
    || currentIndex >= 1
      && claimFingerprint !== input.state.claimFingerprint
    || currentIndex >= 2
      && sessionFingerprint !== input.state.sessionFingerprint
  ) {
    return failure(
      'INVALID_RELAUNCH',
      'continuation transition changed its claim or target session binding',
    );
  }
  const state = nextIndex === currentIndex
    ? input.state
    : makeContinuationState(
      input.lease,
      input.nextStatus,
      input.state.fingerprint,
      claimFingerprint,
      sessionFingerprint,
    );
  return success({
    state,
    ...(state.status === 'opened'
      ? { authorization: makeContinuationAuthorization(input.lease, state) }
      : {}),
  });
}

function validateContinuationBundle(input, host, parsed, config) {
  const envelope = validateEnvelope(
    input.continuation,
    host.activeHost,
    parsed,
  );
  if (!envelope.ok) return envelope;
  if (
    !validateContinuationLease(
      input.continuationLease,
      envelope.value,
    )
    || !validateContinuationAuthorization(
      input.continuationAuthorization,
      input.continuationLease,
      input.continuationState,
    )
    || input.continuationState.sessionFingerprint !== host.sessionFingerprint
    || input.continuationLease.sourceConfigFingerprint !== hashValue(config)
    || input.continuationLease.expectedBaseBranch !== config.baseBranch
  ) {
    return failure(
      'INVALID_RELAUNCH',
      'continuation requires one opened CAS lease bound to this host session',
    );
  }
  return success(envelope.value);
}

function openPolicy(input) {
  if (!hasOnlyKeys(input, OPEN_KEYS)) {
    return invalidIntent('open input has an invalid shape');
  }
  const config = validateConfigInput(input.config);
  if (!config.ok) return config;
  const host = validateHostEvidence(input.hostEvidence);
  if (!host.ok) return host;
  const parsed = parseInvocation(input.invocation);
  if (!parsed.ok) return parsed;
  const continuationFields = [
    input.continuation,
    input.continuationLease,
    input.continuationState,
    input.continuationAuthorization,
  ];
  const continuationFieldCount = continuationFields.filter(
    (value) => value !== undefined,
  ).length;
  if (![0, continuationFields.length].includes(continuationFieldCount)) {
    return failure(
      'INVALID_RELAUNCH',
      'continuation envelope, lease, opened state, and authorization are atomic',
    );
  }
  let selector = parsed.value.selector;
  let scope = parsed.value.scope;
  let generation = 0;
  let originHost = host.value.activeHost;
  let invocationFlow = parsed.value.invocationFlow;
  let runIntentHash;
  if (input.continuation !== undefined) {
    const envelope = validateContinuationBundle(
      input,
      host.value,
      parsed.value,
      input.config,
    );
    if (!envelope.ok) return envelope;
    if (input.invocation !== RELAUNCH_PROMPT) {
      return failure('INVALID_RELAUNCH', 'relaunch invocation is not the canonical prompt');
    }
    selector = envelope.value.selector;
    scope = envelope.value.scope;
    generation = envelope.value.generation;
    originHost = envelope.value.originHost;
    invocationFlow = 'dev';
    runIntentHash = envelope.value.runIntentHash;
  } else {
    runIntentHash = intentHash(originHost, selector, scope, invocationFlow);
  }
  const requestedEngine = selector === 'native' ? host.value.activeHost : selector;
  const requestedRoute = routeFor(host.value.activeHost, requestedEngine);
  if (!requestedRoute) {
    return failure(
      'UNSUPPORTED_ROUTE',
      'active-host and requested-engine pairing is not in the v0.40 route catalog',
      {
        activeHost: host.value.activeHost,
        selector,
        requestedEngine,
      },
    );
  }
  const run = {
    version: RUNTIME_CONTRACT_VERSION,
    configVersion: CONFIG_VERSION,
    invocationFlow,
    originHost,
    activeHost: host.value.activeHost,
    hostEvidenceFingerprint: host.value.fingerprint,
    sessionFingerprint: host.value.sessionFingerprint,
    invocationNonce: randomBytes(32).toString('hex'),
    selector,
    requestedEngine,
    requestedRoute,
    scope,
    generation,
    runIntentHash,
    configuredBaseBranch: input.config.baseBranch,
    configFingerprint: hashValue(input.config),
  };
  const unsignedRun = {
    ...run,
    instanceFingerprint: runInstanceFingerprint(run),
  };
  return success({
    ...unsignedRun,
    authorization: authorizeValue(
      unsignedRun,
      unsignedRun.sessionFingerprint,
    ),
  });
}

function validateRun(run) {
  if (!hasExactKeys(run, RUN_KEYS)) return false;
  const unsignedRun = isPlainObject(run) ? { ...run } : null;
  if (unsignedRun) delete unsignedRun.authorization;
  if (
    run.version !== RUNTIME_CONTRACT_VERSION
    || run.configVersion !== CONFIG_VERSION
    || !FLOWS.includes(run.invocationFlow)
    || !HOSTS.includes(run.originHost)
    || run.activeHost !== run.originHost
    || !HOSTS.includes(run.activeHost)
    || !HEX_64.test(run.hostEvidenceFingerprint)
    || !HEX_64.test(run.sessionFingerprint)
    || !HEX_64.test(run.invocationNonce)
    || !SELECTORS.includes(run.selector)
    || !HOSTS.includes(run.requestedEngine)
    || !Object.hasOwn(ROUTE_CATALOG, run.requestedRoute)
    || !validateScope(run.scope)
    || !Number.isSafeInteger(run.generation)
    || run.generation < 0
    || run.generation > MAX_RELAUNCH_GENERATIONS
    || !HEX_64.test(run.runIntentHash)
    || typeof run.configuredBaseBranch !== 'string'
    || run.configuredBaseBranch.length < 1
    || run.configuredBaseBranch.length > 255
    || /[\x00-\x1f\x7f]/.test(run.configuredBaseBranch)
    || !HEX_64.test(run.configFingerprint)
    || !HEX_64.test(run.instanceFingerprint)
    || !validAuthorization(
      unsignedRun,
      run.sessionFingerprint,
      run.authorization,
    )
  ) {
    return false;
  }
  const requestedEngine =
    run.selector === 'native' ? run.activeHost : run.selector;
  return run.requestedEngine === requestedEngine
    && run.requestedRoute === routeFor(run.activeHost, requestedEngine)
    && run.runIntentHash === intentHash(
      run.originHost,
      run.selector,
      run.scope,
      run.invocationFlow,
    )
    && run.instanceFingerprint === runInstanceFingerprint(run);
}

function validExecutionCheckout(checkout) {
  return hasExactKeys(checkout, EXECUTION_CHECKOUT_KEYS)
    && typeof checkout.root === 'string'
    && checkout.root.length > 1
    && checkout.root.length <= 4096
    && isAbsolute(checkout.root)
    && resolve(checkout.root) === checkout.root
    && !/[\x00-\x1f\x7f]/.test(checkout.root)
    && HEX_64.test(checkout.repositoryFingerprint)
    && typeof checkout.branch === 'string'
    && checkout.branch.length > 0
    && checkout.branch.length <= 255
    && !/[\x00-\x1f\x7f]/.test(checkout.branch)
    && HEX_40.test(checkout.headOid)
    && checkout.clean === true;
}

function validateWork(work) {
  if (!hasExactKeys(work, WORK_KEYS)) {
    return invalidIntent('work context has an invalid shape');
  }
  if (
    !FLOWS.includes(work.flow)
    || !STAGES.includes(work.stage)
    || !Number.isInteger(work.round)
    || work.round < 1
    || work.round > 100
    || !HEX_40.test(work.configuredBaseOid)
    || !Number.isInteger(work.planReviewDispatches)
    || work.planReviewDispatches < 0
    || work.planReviewDispatches > 1
    || !validExecutionCheckout(work.checkout)
  ) {
    return invalidIntent('work context has an invalid enum, round, or base OID');
  }
  if (
    (work.flow === 'doctor') !== (work.stage === 'doctor')
    || (work.flow === 'pitcrew' && work.stage === 'plan-review')
    || (work.stage === 'code-review' ? false : work.round !== 1)
    || (
      work.flow === 'dev'
      && (
        (work.stage === 'plan-review' && work.planReviewDispatches !== 0)
        || (
          work.stage !== 'plan-review'
          && work.planReviewDispatches !== 1
        )
      )
    )
    || (work.flow === 'doctor' && work.planReviewDispatches !== 0)
  ) {
    return invalidIntent('flow, stage, and round combination is invalid');
  }
  if (!hasExactKeys(
    work.artifact,
    ['kind', 'version', 'fingerprint', 'authorIdentity', 'source'],
    ['reviewerIdentity', 'headOid'],
  )) {
    return invalidIntent('artifact identity has an invalid shape');
  }
  const expectedKind = work.stage === 'plan-review'
    ? 'plan'
    : work.stage === 'judgment-review'
      ? 'judgment'
      : work.stage === 'doctor'
        ? 'doctor'
        : 'code';
  if (
    work.artifact.kind !== expectedKind
    || !Number.isSafeInteger(work.artifact.version)
    || work.artifact.version < 1
    || !HEX_64.test(work.artifact.fingerprint)
    || !SAFE_IDENTITY.test(work.artifact.authorIdentity)
    || (
      work.artifact.headOid !== undefined
      && !HEX_40.test(work.artifact.headOid)
    )
    || (
      work.artifact.reviewerIdentity !== undefined
      && !SAFE_IDENTITY.test(work.artifact.reviewerIdentity)
    )
  ) {
    return invalidIntent('artifact identity is invalid for the selected stage');
  }
  const reviewerStage = [
    'plan-review',
    'code-review',
    'judgment-review',
  ].includes(work.stage);
  if (reviewerStage && work.artifact.reviewerIdentity === undefined) {
    return invalidIntent('review stages require a reviewer identity');
  }
  if (
    ['code-review', 'judgment-review'].includes(work.stage)
    && work.artifact.headOid === undefined
  ) {
    return invalidIntent('head-bound review requires the reviewed head OID');
  }
  if (
    ['code-review', 'judgment-review'].includes(work.stage)
    && work.checkout.headOid !== work.artifact.headOid
  ) {
    return invalidIntent(
      'review checkout HEAD does not match the sealed artifact head',
    );
  }
  if (
    reviewerStage
    && work.artifact.authorIdentity === work.artifact.reviewerIdentity
  ) {
    return failure(
      'AUTHOR_REVIEWER_COLLISION',
      'artifact author and reviewer identities must differ',
    );
  }
  if (!validateUnsealedArtifactSource({
    stage: work.stage,
    round: work.round,
    reviewScope: reviewScopeFor(work.stage, work.round),
    configuredBaseOid: work.configuredBaseOid,
    headOid: work.artifact.headOid ?? null,
    artifactVersion: work.artifact.version,
    artifactFingerprint: work.artifact.fingerprint,
    source: work.artifact.source,
  })) {
    return invalidIntent(
      'artifact source is invalid or does not match its sealed identity',
    );
  }
  if (!hasExactKeys(work.concurrency, CONCURRENCY_KEYS)) {
    return invalidIntent('concurrency facts have an invalid shape');
  }
  if (
    !Number.isInteger(work.concurrency.activeWriters)
    || work.concurrency.activeWriters < 0
    || work.concurrency.activeWriters > 1
    || !Number.isInteger(work.concurrency.stagedAhead)
    || work.concurrency.stagedAhead < 0
    || typeof work.concurrency.stagedAheadReadOnly !== 'boolean'
  ) {
    return invalidIntent('concurrency facts are invalid');
  }
  if (work.concurrency.stagedAhead > 1) {
    return failure(
      'UNSAFE_CONCURRENCY',
      'staged-ahead overlap is limited to depth one',
    );
  }
  if (
    work.concurrency.stagedAhead === 1
    && work.concurrency.stagedAheadReadOnly !== true
  ) {
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'staged-ahead overlap must be independently read-only',
    );
  }
  if (
    work.stage === 'implementation'
    && work.concurrency.activeWriters !== 0
  ) {
    return failure('UNSAFE_CONCURRENCY', 'writers must be serialized');
  }
  return success(work);
}

function plannedArtifactSubject(work) {
  return {
    kind: 'plan',
    artifactVersion: work.artifact.version,
    fingerprint: work.artifact.fingerprint,
  };
}

function finalArtifactSubject(work) {
  return {
    kind: 'head',
    headOid: work.artifact.headOid,
  };
}

function dispatchArtifactSubject(work) {
  return ['code-review', 'judgment-review'].includes(work.stage)
    ? finalArtifactSubject(work)
    : plannedArtifactSubject(work);
}

function validArtifactSubject(subject, planValue) {
  if (['code-review', 'judgment-review'].includes(planValue.stage)) {
    return hasExactKeys(subject, ['kind', 'headOid'])
      && subject.kind === 'head'
      && HEX_40.test(subject.headOid);
  }
  return hasExactKeys(
    subject,
    ['kind', 'artifactVersion', 'fingerprint'],
  )
    && subject.kind === 'plan'
    && subject.artifactVersion === planValue.artifactVersion
    && subject.fingerprint === planValue.artifactFingerprint;
}

function proofModeForStage(stage) {
  if (['plan-review', 'implementation'].includes(stage)) return 'planned';
  if (['code-review', 'judgment-review'].includes(stage)) return 'final';
  return null;
}

function normalizeLaneProof(proof, work) {
  const artifactSubject = dispatchArtifactSubject(work);
  const missingFingerprint = hashValue({
    kind: 'unverifiable-lane-proof',
    baseOid: work.configuredBaseOid,
    artifactSubject,
  });
  if (!verifyLaneProof(proof)) {
    return {
      lane: 'full',
      fingerprint: missingFingerprint,
      status: 'unverifiable',
      authority: 'structural-replay-only',
      reasonCodes: ['UNVERIFIABLE_LANE_PROOF'],
    };
  }
  const reasonCodes = [];
  let lane = proof.lane;
  let status = 'verified';
  const expectedSubject = proof.mode === 'final'
    ? finalArtifactSubject(work)
    : plannedArtifactSubject(work);
  if (!verifyLaneProof(proof, {
    expectedBaseOid: work.configuredBaseOid,
    expectedSubject,
  })) {
    lane = 'full';
    status = 'promoted';
    reasonCodes.push('STALE_LANE_PROOF');
  }
  const requiredMode = proofModeForStage(work.stage);
  if (requiredMode !== null && proof.mode !== requiredMode) {
    lane = 'full';
    status = 'promoted';
    reasonCodes.push('PROOF_MODE_MISMATCH');
  }
  if (work.flow === 'pitcrew' && lane !== 'full') {
    lane = 'full';
    status = 'promoted';
    reasonCodes.push('PITCREW_FULL_LANE');
  }
  return {
    lane,
    fingerprint: proof.fingerprint,
    status,
    authority: 'structural-replay-only',
    reasonCodes,
  };
}

function validateCapabilities(
  capabilities,
  invocationNonce,
  sessionFingerprint,
  expectedCheckout,
) {
  if (
    !validateCapabilitySnapshot(capabilities, invocationNonce)
    || capabilities.sessionFingerprint !== sessionFingerprint
    || (
      expectedCheckout !== undefined
      && hashValue(capabilities.checkout) !== hashValue(expectedCheckout)
    )
    || !isPlainObject(capabilities.facts)
    || Object.keys(capabilities.facts).length > CAPABILITY_REQUIREMENTS.length
  ) {
    return invalidIntent('capability snapshot has an invalid shape');
  }
  for (const [requirement, available] of Object.entries(capabilities.facts)) {
    if (
      !CAPABILITY_REQUIREMENTS.includes(requirement)
      || typeof available !== 'boolean'
    ) {
      return invalidIntent('capability snapshot contains an unknown or invalid fact');
    }
  }
  return success({
    facts: capabilities.facts,
    fingerprint: capabilities.fingerprint,
    checkout: capabilities.checkout,
  });
}

function missingRequirements(candidate, facts) {
  return candidate.requirements.filter((requirement) => facts[requirement] !== true);
}

function candidateFor(routeId, role, facts, allowDegraded = true) {
  const primary = ROUTE_CATALOG[routeId]?.postures?.[role];
  if (!primary) return { candidate: null, missing: [], degraded: false };
  const primaryMissing = missingRequirements(primary, facts);
  if (primaryMissing.length === 0) {
    return { candidate: primary, missing: [], degraded: false };
  }
  if (allowDegraded && primary.degraded) {
    const degradedMissing = missingRequirements(primary.degraded, facts);
    if (degradedMissing.length === 0) {
      return {
        candidate: primary.degraded,
        missing: [],
        degraded: true,
      };
    }
  }
  return { candidate: null, missing: primaryMissing, degraded: false };
}

function capabilityFailure(missing) {
  const nonIsolation = missing.filter(
    (requirement) => !ISOLATION_REQUIREMENTS.includes(requirement),
  );
  const code =
    nonIsolation.length === 0 && missing.length > 0
      ? 'UNVERIFIABLE_ISOLATION'
      : 'MISSING_CAPABILITY';
  return failure(
    code,
    code === 'UNVERIFIABLE_ISOLATION'
      ? 'selected route cannot prove its isolation contract'
      : 'selected route is missing a required capability',
    { missing: [...missing].sort() },
  );
}

function makeInitialRouteState(run, capabilityFingerprint) {
  return fingerprinted({
    kind: 'autoloop-route-state',
    version: 1,
    runInstanceFingerprint: run.instanceFingerprint,
    status: 'healthy',
    requestedRoute: run.requestedRoute,
    consecutiveFailures: 0,
    capabilityFingerprint,
    sequence: 0,
    lastTransition: null,
  });
}

function makeRouteTransition(
  routeState,
  planFingerprint,
  outcomeEvidenceFingerprint,
  event,
  updates,
  source = 'observe',
) {
  const nextCapabilityFingerprint =
    updates.capabilityFingerprint ?? routeState.capabilityFingerprint;
  const transition = fingerprinted({
    kind: 'autoloop-route-transition',
    version: 1,
    source,
    runInstanceFingerprint: routeState.runInstanceFingerprint,
    sequence: routeState.sequence + 1,
    previousStateFingerprint: routeState.fingerprint,
    planFingerprint,
    outcomeEvidenceFingerprint,
    event,
    fromStatus: routeState.status,
    toStatus: updates.status ?? routeState.status,
    consecutiveFailures:
      updates.consecutiveFailures ?? routeState.consecutiveFailures,
    previousCapabilityFingerprint: routeState.capabilityFingerprint,
    capabilityFingerprint: nextCapabilityFingerprint,
  });
  return fingerprinted({
    kind: 'autoloop-route-state',
    version: 1,
    runInstanceFingerprint: routeState.runInstanceFingerprint,
    status: transition.toStatus,
    requestedRoute: routeState.requestedRoute,
    consecutiveFailures: transition.consecutiveFailures,
    capabilityFingerprint: nextCapabilityFingerprint,
    sequence: transition.sequence,
    lastTransition: transition,
  });
}

function validRouteTransition(transition, routeState) {
  return validFingerprinted(transition, ROUTE_TRANSITION_KEYS)
    && transition.kind === 'autoloop-route-transition'
    && transition.version === 1
    && ['observe', 'capability-refresh'].includes(transition.source)
    && transition.runInstanceFingerprint
      === routeState.runInstanceFingerprint
    && transition.sequence === routeState.sequence
    && transition.sequence >= 1
    && HEX_64.test(transition.previousStateFingerprint)
    && HEX_64.test(transition.planFingerprint)
    && HEX_64.test(transition.outcomeEvidenceFingerprint)
    && [
      'attempt-succeeded',
      'attempt-failed',
      'pre-execution-failed',
      'recovery-succeeded',
      'fallback-succeeded',
      'capability-refreshed',
    ].includes(transition.event)
    && ROUTE_STATUSES.includes(transition.fromStatus)
    && transition.toStatus === routeState.status
    && transition.consecutiveFailures === routeState.consecutiveFailures
    && HEX_64.test(transition.previousCapabilityFingerprint)
    && transition.capabilityFingerprint
      === routeState.capabilityFingerprint
    && (
      transition.source === 'capability-refresh'
        ? (
          transition.event === 'capability-refreshed'
          && transition.toStatus === transition.fromStatus
        )
        : (
          transition.event !== 'capability-refreshed'
          && transition.previousCapabilityFingerprint
            === transition.capabilityFingerprint
        )
    );
}

function validateRouteState(routeState, run, capabilityFingerprint) {
  if (
    !validFingerprinted(routeState, ROUTE_STATE_KEYS)
    || routeState.kind !== 'autoloop-route-state'
    || routeState.version !== 1
    || routeState.runInstanceFingerprint !== run.instanceFingerprint
    || routeState.requestedRoute !== run.requestedRoute
    || !ROUTE_STATUSES.includes(routeState.status)
    || !Number.isSafeInteger(routeState.consecutiveFailures)
    || routeState.consecutiveFailures < 0
    || !HEX_64.test(routeState.capabilityFingerprint)
    || !Number.isSafeInteger(routeState.sequence)
    || routeState.sequence < 0
  ) {
    return invalidIntent('route state is invalid or not issued for this run');
  }
  if (routeState.capabilityFingerprint !== capabilityFingerprint) {
    return failure(
      'EXPIRED_PLAN',
      'route state capability evidence is stale; transition explicitly',
    );
  }
  if (
    routeState.status === 'healthy'
    && routeState.consecutiveFailures > 1
  ) {
    return invalidIntent('healthy route state exceeds the retry bound');
  }
  if (
    routeState.status === 'outage'
    && routeState.consecutiveFailures < 2
  ) {
    return invalidIntent('outage route state lacks bounded retry evidence');
  }
  if (
    routeState.sequence === 0
      ? (
        routeState.lastTransition !== null
        || routeState.status !== 'healthy'
        || routeState.consecutiveFailures !== 0
      )
      : !validRouteTransition(routeState.lastTransition, routeState)
  ) {
    return invalidIntent('route state transition provenance is invalid');
  }
  if (
    routeState.status === 'outage'
    && routeState.lastTransition?.toStatus !== 'outage'
  ) {
    return invalidIntent('outage state was not issued by an observe transition');
  }
  return success(routeState);
}

function initializeRouteStatePolicy(input) {
  if (!hasExactKeys(input, ['run', 'capabilities'])) {
    return invalidIntent('route-state initialization input is invalid');
  }
  if (!validateRun(input.run)) {
    return failure('EXPIRED_PLAN', 'route state requires a valid run instance');
  }
  const capability = validateCapabilities(
    input.capabilities,
    input.run.invocationNonce,
    input.run.sessionFingerprint,
  );
  if (!capability.ok) return capability;
  return success(makeInitialRouteState(
    input.run,
    capability.value.fingerprint,
  ));
}

function refreshRouteStatePolicy(input) {
  if (
    !hasExactKeys(
      input,
      ['run', 'routeState', 'previousCapabilities', 'capabilities'],
    )
  ) {
    return invalidIntent('capability refresh input is invalid');
  }
  if (!validateRun(input.run)) {
    return failure('EXPIRED_PLAN', 'capability refresh requires a valid run');
  }
  const previous = validateCapabilities(
    input.previousCapabilities,
    input.run.invocationNonce,
    input.run.sessionFingerprint,
  );
  if (!previous.ok) return previous;
  const routeState = validateRouteState(
    input.routeState,
    input.run,
    previous.value.fingerprint,
  );
  if (!routeState.ok) return routeState;
  const next = validateCapabilities(
    input.capabilities,
    input.run.invocationNonce,
    input.run.sessionFingerprint,
  );
  if (!next.ok) return next;
  if (next.value.fingerprint === previous.value.fingerprint) {
    return success(routeState.value);
  }
  return success(makeRouteTransition(
    routeState.value,
    previous.value.fingerprint,
    next.value.fingerprint,
    'capability-refreshed',
    { capabilityFingerprint: next.value.fingerprint },
    'capability-refresh',
  ));
}

function roleFor(stage) {
  if (stage === 'implementation') return 'writer';
  if (stage === 'doctor') return 'probe';
  return 'reviewer';
}

function reviewScopeFor(stage, round) {
  if (stage === 'plan-review') return 'full-artifact';
  if (stage === 'code-review') {
    return round === 1 ? 'full-artifact' : 'fix-delta-and-open-rebuttals';
  }
  if (stage === 'judgment-review') return 'in-flight-decision';
  if (stage === 'doctor') return 'capability-probe';
  return 'write-artifact';
}

function nominalRouteFor(run, work, effectiveLane) {
  const native = `${run.activeHost}.native`;
  if (work.stage === 'judgment-review') return native;
  if (work.flow === 'doctor') return run.requestedRoute;
  if (work.flow === 'pitcrew') {
    if (work.stage === 'code-review' && work.round >= 2) return native;
    return run.requestedRoute;
  }
  if (work.stage === 'plan-review') {
    return effectiveLane === 'full' ? run.requestedRoute : native;
  }
  if (work.stage === 'implementation') {
    return effectiveLane === 'docs' ? native : run.requestedRoute;
  }
  if (work.stage === 'code-review') {
    if (work.round >= 2 || effectiveLane !== 'full') return native;
    return run.requestedRoute;
  }
  return run.requestedRoute;
}

function makePlan(base) {
  const withoutFingerprint = { ...base };
  delete withoutFingerprint.fingerprint;
  delete withoutFingerprint.authorization;
  const authorization = authorizeValue(
    withoutFingerprint,
    withoutFingerprint.sessionFingerprint,
  );
  return deepFreeze({
    ...withoutFingerprint,
    authorization,
    fingerprint: hashValue({ ...withoutFingerprint, authorization }),
  });
}

function equalArrays(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function postureForExecution(routeId, role, execution) {
  const primary = ROUTE_CATALOG[routeId]?.postures?.[role];
  if (primary?.execution === execution) return primary;
  if (primary?.degraded?.execution === execution) return primary.degraded;
  return null;
}

function validPlanIsolation(isolation, postureValue) {
  return hasExactKeys(isolation, ['mode'])
    && isolation.mode === postureValue.isolation.mode;
}

function validateDispatchArtifactSource(input) {
  return input.stage === 'code-review'
    ? validateSealedArtifactSource(input)
    : validateArtifactSource(input);
}

function validReviewVerdict(value) {
  return hasExactKeys(value, ['verdict', 'findings', 'rebuts'])
    && ['pass', 'fail'].includes(value.verdict)
    && Array.isArray(value.findings)
    && value.findings.length <= 100
    && new Set(value.findings.map(({ id }) => id)).size
      === value.findings.length
    && value.findings.every((finding) =>
      hasExactKeys(finding, ['id', 'severity', 'summary', 'evidence'])
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(finding.id)
      && ['Critical', 'Major', 'Minor', 'Suggestion'].includes(
        finding.severity,
      )
      && typeof finding.summary === 'string'
      && finding.summary.length >= 1
      && finding.summary.length <= 4096
      && typeof finding.evidence === 'string'
      && finding.evidence.length <= 16384)
    && Array.isArray(value.rebuts)
    && value.rebuts.length <= 100
    && new Set(value.rebuts.map(({ findingId }) => findingId)).size
      === value.rebuts.length
    && value.rebuts.every((rebut) =>
      hasExactKeys(rebut, ['findingId', 'status', 'evidence'])
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rebut.findingId)
      && ['accepted', 'rejected'].includes(rebut.status)
      && typeof rebut.evidence === 'string'
      && rebut.evidence.length >= 1
      && rebut.evidence.length <= 16384)
    && (
      value.verdict === 'pass'
        ? !value.findings.some(({ severity }) =>
          ['Critical', 'Major'].includes(severity))
        : value.findings.some(({ severity }) =>
          ['Critical', 'Major'].includes(severity))
    );
}

function validExecutionEvidence(value, execution) {
  if (!isPlainObject(value)) return false;
  const processExecutions = [
    'codex.exec-workspace-write',
    'codex.exec-read-only',
    'codex.exec-live-doctor',
    'opencode.run-writer',
    'opencode.run-typed-reviewer',
    'opencode.run-live-doctor',
  ];
  const probeExecutions = [
    'claude.live-doctor',
    'codex.live-doctor',
    'codex.degraded-live-doctor',
    'opencode.live-doctor',
  ];
  const expectedKind = processExecutions.includes(execution)
    ? 'process'
    : probeExecutions.includes(execution)
      ? 'host-surface'
      : 'host-child';
  if (value.kind !== expectedKind) return false;
  if (expectedKind !== 'host-child') {
    return hasExactKeys(value, [
      'kind',
      'instanceId',
      'integration',
      'transcriptFingerprint',
    ])
      && SAFE_IDENTITY.test(value.instanceId)
      && SAFE_IDENTITY.test(value.integration)
      && HEX_64.test(value.transcriptFingerprint);
  }
  return hasExactKeys(value, [
    'kind',
    'instanceId',
    'integration',
    'metadataFile',
    'metadataFingerprint',
    'transcriptFile',
    'transcriptFingerprint',
  ])
    && SAFE_IDENTITY.test(value.instanceId)
    && SAFE_IDENTITY.test(value.integration)
    && /^[A-Za-z0-9._-]{1,255}-payload\.json$/.test(value.metadataFile)
    && HEX_64.test(value.metadataFingerprint)
    && /^[A-Za-z0-9._-]{1,255}-transcript\.jsonl$/.test(
      value.transcriptFile,
    )
    && HEX_64.test(value.transcriptFingerprint);
}

function validAttemptRecord(record, index, planValue, run) {
  if (!hasExactKeys(record, ATTEMPT_EVIDENCE_KEYS)) {
    return false;
  }
  const postureValue = postureForExecution(
    record.route,
    planValue.role,
    record.execution,
  );
  return record.attempt === index + 1
    && HEX_64.test(record.planFingerprint)
    && Object.hasOwn(ROUTE_CATALOG, record.route)
    && ROUTE_CATALOG[record.route].activeHost === run.activeHost
    && record.adapter === record.route
    && postureValue !== null
    && [
      'transient-failure',
      'environment-failure',
      'invalid-result',
    ].includes(record.status)
    && record.effect === 'none'
    && (
      record.status === 'environment-failure'
        ? (
          record.launchStatus === 'not-launched'
          && record.isolation.verified === false
        )
        : record.launchStatus === 'launched'
    )
    && HEX_64.test(record.evidenceFingerprint)
    && validExecutionEvidence(record.executionEvidence, record.execution)
    && record.actorIdentityFingerprint === planValue.actorIdentityFingerprint
    && hasExactKeys(
      record.isolation,
      ['mode', 'verified', 'fingerprint'],
    )
    && record.isolation.mode === postureValue.isolation.mode
    && typeof record.isolation.verified === 'boolean'
    && HEX_64.test(record.isolation.fingerprint)
    && (
      record.modelIdentity === null
      || (
        typeof record.modelIdentity === 'string'
        && SAFE_IDENTITY.test(record.modelIdentity)
      )
    )
    && (record.verdict === null || validReviewVerdict(record.verdict));
}

function safeFallbackRoute(planValue, run, fallbackRoute, execution = null) {
  const native = `${run.activeHost}.native`;
  if (fallbackRoute !== native) return false;
  if (run.requestedRoute !== native) {
    return planValue.actualRoute === run.requestedRoute;
  }
  return native === 'codex.native'
    && planValue.actualRoute === native
    && planValue.execution === 'codex.exec-read-only'
    && (
      execution === null
      || execution === 'codex.in-session-reviewer'
    );
}

function validFallback(fallback, planValue, run) {
  if (fallback === null) return true;
  if (!isPlainObject(fallback) || typeof fallback.available !== 'boolean') {
    return false;
  }
  if (fallback.available === false) {
    return hasExactKeys(fallback, ['available', 'route', 'missing'])
      && safeFallbackRoute(planValue, run, fallback.route)
      && Array.isArray(fallback.missing)
      && fallback.missing.length >= 1
      && fallback.missing.length <= CAPABILITY_REQUIREMENTS.length
      && new Set(fallback.missing).size === fallback.missing.length
      && fallback.missing.every(
        (requirement) => CAPABILITY_REQUIREMENTS.includes(requirement),
      );
  }
  if (!hasExactKeys(fallback, [
    'available',
    'route',
    'adapter',
    'execution',
    'requirements',
    'isolation',
    'degradation',
  ])) {
    return false;
  }
  const postureValue = postureForExecution(
    fallback.route,
    planValue.role,
    fallback.execution,
  );
  return safeFallbackRoute(
    planValue,
    run,
    fallback.route,
    fallback.execution,
  )
    && fallback.adapter === fallback.route
    && postureValue !== null
    && equalArrays(fallback.requirements, postureValue.requirements)
    && validPlanIsolation(fallback.isolation, postureValue)
    && Array.isArray(fallback.degradation)
    && fallback.degradation.length >= 1
    && new Set(fallback.degradation).size === fallback.degradation.length
    && fallback.degradation.every(
      (degradation) => DEGRADATIONS.includes(degradation),
    );
}

function fallbackCandidate(run, role, selected, facts) {
  if (
    selected.route === 'codex.native'
    && role === 'reviewer'
    && selected.candidate.execution === 'codex.exec-read-only'
  ) {
    const degraded = ROUTE_CATALOG['codex.native'].postures.reviewer.degraded;
    const missing = missingRequirements(degraded, facts);
    return missing.length === 0
      ? {
        available: true,
        route: 'codex.native',
        adapter: 'codex.native',
        execution: degraded.execution,
        requirements: [...degraded.requirements],
        isolation: { ...degraded.isolation },
        degradation: ['degraded-native-codex-review'],
      }
      : {
        available: false,
        route: 'codex.native',
        missing: [...missing].sort(),
      };
  }
  const native = `${run.activeHost}.native`;
  if (selected.route === run.requestedRoute && run.requestedRoute !== native) {
    const fallback = candidateFor(native, role, facts);
    return fallback.candidate
      ? {
        available: true,
        route: native,
        adapter: native,
        execution: fallback.candidate.execution,
        requirements: [...fallback.candidate.requirements],
        isolation: { ...fallback.candidate.isolation },
        degradation: ['native-fallback'],
      }
      : {
        available: false,
        route: native,
        missing: [...fallback.missing].sort(),
      };
  }
  return null;
}

function planPolicy(input) {
  if (!hasExactKeys(
    input,
    ['run', 'work', 'capabilities', 'routeState'],
    ['laneProof'],
  )) {
    return invalidIntent('plan input has an invalid shape');
  }
  if (!validateRun(input.run)) {
    return failure('EXPIRED_PLAN', 'run context is invalid or stale');
  }
  const work = validateWork(input.work);
  if (!work.ok) return work;
  const flowCompatible =
    (input.run.invocationFlow === 'dev'
      && ['dev', 'pitcrew'].includes(input.work.flow))
    || input.run.invocationFlow === input.work.flow;
  if (!flowCompatible) {
    return invalidIntent('work flow does not belong to this invocation intent');
  }
  const capability = validateCapabilities(
    input.capabilities,
    input.run.invocationNonce,
    input.run.sessionFingerprint,
    input.work.checkout,
  );
  if (!capability.ok) return capability;
  const routeState = validateRouteState(
    input.routeState,
    input.run,
    capability.value.fingerprint,
  );
  if (!routeState.ok) return routeState;
  const laneProof = normalizeLaneProof(input.laneProof, input.work);
  const role = roleFor(input.work.stage);
  const nominalRoute = nominalRouteFor(
    input.run,
    input.work,
    laneProof.lane,
  );
  let actualRoute = nominalRoute;
  let recoveryProbe = false;
  let fallbackUsed = false;
  let outageTransition = 'none';
  let initialDegradation = [];
  if (
    routeState.value.status === 'outage'
    && nominalRoute === input.run.requestedRoute
  ) {
    if (input.work.stage === 'judgment-review') {
      return failure(
        'UNSAFE_FALLBACK',
        'judgment review cannot use an outage route as a recovery probe',
      );
    }
    if (role === 'reviewer' || role === 'probe') {
      recoveryProbe = true;
      outageTransition = 'probe';
    } else {
      const native = `${input.run.activeHost}.native`;
      if (input.run.requestedRoute === native) {
        return failure(
          'UNSAFE_FALLBACK',
          'outage writer has no distinct safe native fallback',
        );
      }
      actualRoute = native;
      fallbackUsed = true;
      outageTransition = 'continued';
      initialDegradation = ['native-fallback'];
    }
  }
  const selected = candidateFor(
    actualRoute,
    role,
    capability.value.facts,
  );
  if (!selected.candidate) {
    if (fallbackUsed) {
      return failure(
        'UNSAFE_FALLBACK',
        'safe native fallback is unavailable',
        { missing: [...selected.missing].sort() },
      );
    }
    return capabilityFailure(selected.missing);
  }
  if (selected.degraded) {
    fallbackUsed = true;
    if (recoveryProbe) {
      recoveryProbe = false;
      outageTransition = 'continued';
    }
    initialDegradation.push('degraded-native-codex-review');
  }
  const fallback = fallbackUsed
    ? null
    : fallbackCandidate(
      input.run,
      role,
      {
        route: actualRoute,
        candidate: selected.candidate,
      },
      capability.value.facts,
    );
  const maxAttempts =
    input.work.stage === 'judgment-review'
    || recoveryProbe
    || fallbackUsed
    || selected.degraded
      ? 1
      : 2;
  const reviewScope = reviewScopeFor(input.work.stage, input.work.round);
  let artifactSource = input.work.artifact.source;
  let artifactFingerprint = input.work.artifact.fingerprint;
  if (input.work.stage === 'code-review') {
    const sealed = sealGitReviewSource({
      checkout: input.work.checkout,
      round: input.work.round,
      reviewScope,
      configuredBaseOid: input.work.configuredBaseOid,
      headOid: input.work.artifact.headOid,
      source: input.work.artifact.source,
    });
    if (!sealed.ok) return sealed;
    artifactSource = sealed.value;
    artifactFingerprint = artifactSourceFingerprint({
      stage: input.work.stage,
      artifactVersion: input.work.artifact.version,
      source: artifactSource,
    });
  }
  return success(makePlan({
    kind: 'autoloop-dispatch-plan',
    authority: 'runtime-contract-v1',
    version: RUNTIME_CONTRACT_VERSION,
    runIntentHash: input.run.runIntentHash,
    generation: input.run.generation,
    hostEvidenceFingerprint: input.run.hostEvidenceFingerprint,
    runInstanceFingerprint: input.run.instanceFingerprint,
    invocationNonce: input.run.invocationNonce,
    configFingerprint: input.run.configFingerprint,
    sessionFingerprint: input.run.sessionFingerprint,
    invocationFlow: input.run.invocationFlow,
    activeHost: input.run.activeHost,
    selector: input.run.selector,
    requestedEngine: input.run.requestedEngine,
    requestedRoute: input.run.requestedRoute,
    actualRoute,
    adapter: actualRoute,
    execution: selected.candidate.execution,
    flow: input.work.flow,
    stage: input.work.stage,
    round: input.work.round,
    planReviewDispatches: input.work.planReviewDispatches,
    role,
    reviewScope,
    effectiveLane: laneProof.lane,
    laneProof: {
      status: laneProof.status,
      authority: laneProof.authority,
      reasonCodes: [...laneProof.reasonCodes],
    },
    laneProofFingerprint: laneProof.fingerprint,
    checkout: structuredClone(input.work.checkout),
    configuredBaseOid: input.work.configuredBaseOid,
    artifactSubject: dispatchArtifactSubject(input.work),
    artifactVersion: input.work.artifact.version,
    artifactFingerprint,
    artifactSource: structuredClone(artifactSource),
    artifactAuthorFingerprint: hashValue({
      kind: 'autoloop-actor-identity',
      identity: input.work.artifact.authorIdentity,
    }),
    actorIdentityFingerprint: hashValue({
      kind: 'autoloop-actor-identity',
      identity:
        input.work.artifact.reviewerIdentity
        ?? input.work.artifact.authorIdentity,
    }),
    capabilityFingerprint: capability.value.fingerprint,
    evaluatedCapabilities: [...selected.candidate.requirements],
    requirements: [...selected.candidate.requirements],
    isolation: { ...selected.candidate.isolation },
    recoveryProbe,
    fallbackUsed,
    fallback,
    degradation: [...new Set(initialDegradation)],
    outageTransition,
    attempt: 1,
    maxAttempts,
    history: [],
    routeState: routeState.value,
  }));
}

function validatePlan(planValue, run, routeState) {
  if (!hasExactKeys(planValue, PLAN_KEYS)) return false;
  const withoutFingerprint = { ...planValue };
  delete withoutFingerprint.fingerprint;
  const authorizationInput = { ...withoutFingerprint };
  delete authorizationInput.authorization;
  const postureValue = postureForExecution(
    planValue.actualRoute,
    planValue.role,
    planValue.execution,
  );
  const nominalRoute = (
    FLOWS.includes(planValue.flow)
    && STAGES.includes(planValue.stage)
    && LANES.includes(planValue.effectiveLane)
  )
    ? nominalRouteFor(
      run,
      {
        flow: planValue.flow,
        stage: planValue.stage,
        round: planValue.round,
      },
      planValue.effectiveLane,
    )
    : null;
  const planRouteState = validateRouteState(
    planValue.routeState,
    run,
    planValue.capabilityFingerprint,
  );
  const native = `${run.activeHost}.native`;
  const laneReasons = [
    'UNVERIFIABLE_LANE_PROOF',
    'STALE_LANE_PROOF',
    'PROOF_MODE_MISMATCH',
    'PITCREW_FULL_LANE',
  ];
  const flowCompatible =
    (run.invocationFlow === 'dev'
      && ['dev', 'pitcrew'].includes(planValue.flow))
    || run.invocationFlow === planValue.flow;
  if (
    !HEX_64.test(planValue.fingerprint)
    || hashValue(withoutFingerprint) !== planValue.fingerprint
    || planValue.sessionFingerprint !== run.sessionFingerprint
    || !validAuthorization(
      authorizationInput,
      planValue.sessionFingerprint,
      planValue.authorization,
    )
    || planValue.kind !== 'autoloop-dispatch-plan'
    || planValue.authority !== 'runtime-contract-v1'
    || planValue.version !== RUNTIME_CONTRACT_VERSION
    || planValue.runIntentHash !== run.runIntentHash
    || planValue.generation !== run.generation
    || planValue.hostEvidenceFingerprint
      !== run.hostEvidenceFingerprint
    || planValue.runInstanceFingerprint !== run.instanceFingerprint
    || planValue.invocationNonce !== run.invocationNonce
    || planValue.configFingerprint !== run.configFingerprint
    || planValue.invocationFlow !== run.invocationFlow
    || planValue.activeHost !== run.activeHost
    || planValue.selector !== run.selector
    || planValue.requestedEngine !== run.requestedEngine
    || planValue.requestedRoute !== run.requestedRoute
    || !Object.hasOwn(ROUTE_CATALOG, planValue.actualRoute)
    || ROUTE_CATALOG[planValue.actualRoute].activeHost !== run.activeHost
    || planValue.adapter !== planValue.actualRoute
    || !FLOWS.includes(planValue.flow)
    || !STAGES.includes(planValue.stage)
    || !LANES.includes(planValue.effectiveLane)
    || !flowCompatible
    || ((planValue.flow === 'doctor') !== (planValue.stage === 'doctor'))
    || roleFor(planValue.stage) !== planValue.role
    || !ROLES.includes(planValue.role)
    || reviewScopeFor(planValue.stage, planValue.round) !== planValue.reviewScope
    || !REVIEW_SCOPES.includes(planValue.reviewScope)
    || !Number.isInteger(planValue.round)
    || planValue.round < 1
    || planValue.round > 100
    || !Number.isInteger(planValue.planReviewDispatches)
    || planValue.planReviewDispatches < 0
    || planValue.planReviewDispatches > 1
    || (
      planValue.flow === 'dev'
      && (
        (
          planValue.stage === 'plan-review'
          && planValue.planReviewDispatches !== 0
        )
        || (
          planValue.stage !== 'plan-review'
          && planValue.planReviewDispatches !== 1
        )
      )
    )
    || (
      planValue.stage !== 'code-review'
      && planValue.round !== 1
    )
    || (planValue.flow === 'pitcrew' && planValue.stage === 'plan-review')
    || (planValue.flow === 'pitcrew' && planValue.effectiveLane !== 'full')
    || (
      planValue.fallbackUsed !== true
      && planValue.actualRoute !== nominalRoute
    )
    || (
      planValue.fallbackUsed === true
      && ![nominalRoute, native].includes(planValue.actualRoute)
    )
    || typeof planValue.recoveryProbe !== 'boolean'
    || typeof planValue.fallbackUsed !== 'boolean'
    || !['none', 'probe', 'entered', 'continued'].includes(
      planValue.outageTransition,
    )
    || (
      planValue.recoveryProbe
      && (
        planValue.routeState.status !== 'outage'
        || planValue.actualRoute !== run.requestedRoute
        || !['plan-review', 'code-review', 'doctor'].includes(planValue.stage)
        || planValue.outageTransition !== 'probe'
      )
    )
    || (
      !planValue.recoveryProbe
      && planValue.outageTransition === 'probe'
    )
    || postureValue === null
    || !equalArrays(planValue.requirements, postureValue.requirements)
    || !equalArrays(
      planValue.evaluatedCapabilities,
      postureValue.requirements,
    )
    || !validPlanIsolation(planValue.isolation, postureValue)
    || !Number.isInteger(planValue.attempt)
    || planValue.attempt < 1
    || planValue.attempt > 3
    || !Number.isInteger(planValue.maxAttempts)
    || planValue.maxAttempts < planValue.attempt
    || planValue.maxAttempts > 3
    || !Array.isArray(planValue.history)
    || planValue.history.length > 2
    || planValue.attempt !== planValue.history.length + 1
    || !planValue.history.every(
      (record, index) => validAttemptRecord(record, index, planValue, run),
    )
    || new Set(planValue.history.map(
      ({ executionEvidence }) => executionEvidence.instanceId,
    )).size !== planValue.history.length
    || new Set(planValue.history.map(
      ({ evidenceFingerprint }) => evidenceFingerprint,
    )).size !== planValue.history.length
    || hashValue(planValue.routeState) !== hashValue(routeState)
    || !planRouteState.ok
    || !HEX_64.test(planValue.capabilityFingerprint)
    || !HEX_64.test(planValue.laneProofFingerprint)
    || !validExecutionCheckout(planValue.checkout)
    || !HEX_40.test(planValue.configuredBaseOid)
    || !validArtifactSubject(planValue.artifactSubject, planValue)
    || (
      planValue.artifactSubject.kind === 'head'
      && planValue.artifactSubject.headOid !== planValue.checkout.headOid
    )
    || !Number.isSafeInteger(planValue.artifactVersion)
    || planValue.artifactVersion < 1
    || !HEX_64.test(planValue.artifactFingerprint)
    || !validateDispatchArtifactSource({
      stage: planValue.stage,
      round: planValue.round,
      reviewScope: planValue.reviewScope,
      configuredBaseOid: planValue.configuredBaseOid,
      headOid: ['code-review', 'judgment-review'].includes(planValue.stage)
        ? planValue.artifactSubject.headOid
        : null,
      artifactVersion: planValue.artifactVersion,
      artifactFingerprint: planValue.artifactFingerprint,
      source: planValue.artifactSource,
    })
    || !HEX_64.test(planValue.artifactAuthorFingerprint)
    || !HEX_64.test(planValue.actorIdentityFingerprint)
    || (
      planValue.role === 'reviewer'
      && planValue.artifactAuthorFingerprint === planValue.actorIdentityFingerprint
    )
    || (
      planValue.role === 'writer'
      && planValue.artifactAuthorFingerprint !== planValue.actorIdentityFingerprint
    )
    || !hasExactKeys(
      planValue.laneProof,
      ['status', 'authority', 'reasonCodes'],
    )
    || !['verified', 'promoted', 'unverifiable'].includes(
      planValue.laneProof.status,
    )
    || planValue.laneProof.authority !== 'structural-replay-only'
    || !Array.isArray(planValue.laneProof.reasonCodes)
    || planValue.laneProof.reasonCodes.length > laneReasons.length
    || new Set(planValue.laneProof.reasonCodes).size
      !== planValue.laneProof.reasonCodes.length
    || !planValue.laneProof.reasonCodes.every(
      (reason) => laneReasons.includes(reason),
    )
    || !Array.isArray(planValue.degradation)
    || planValue.degradation.length > DEGRADATIONS.length
    || new Set(planValue.degradation).size !== planValue.degradation.length
    || !planValue.degradation.every(
      (degradation) => DEGRADATIONS.includes(degradation),
    )
    || (planValue.fallbackUsed && planValue.degradation.length === 0)
    || (
      planValue.degradation.includes('native-fallback')
      && (
        !planValue.fallbackUsed
        || planValue.actualRoute !== native
        || planValue.requestedRoute === native
      )
    )
    || (
      planValue.degradation.includes('degraded-native-codex-review')
      && (
        !planValue.fallbackUsed
        || planValue.actualRoute !== 'codex.native'
        || planValue.execution !== 'codex.in-session-reviewer'
      )
    )
    || !validFallback(planValue.fallback, planValue, run)
    || (planValue.fallbackUsed && planValue.fallback !== null)
  ) {
    return false;
  }
  return true;
}

function validateOutcome(outcome, planValue) {
  if (!isPlainObject(outcome)) {
    return failure(
      'INVALID_ATTEMPT_OUTCOME',
      'adapter outcome is not a structural route-adapter value',
    );
  }
  if (
    outcome.planFingerprint !== planValue.fingerprint
    || outcome.attempt !== planValue.attempt
    || outcome.route !== planValue.actualRoute
    || outcome.adapter !== planValue.adapter
    || outcome.actorIdentityFingerprint
      !== planValue.actorIdentityFingerprint
  ) {
    return failure(
      'EXPIRED_PLAN',
      'attempt evidence does not match its dispatch plan',
    );
  }
  if (
    outcome.isolation?.mode !== planValue.isolation.mode
  ) {
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'attempt isolation evidence does not match the selected adapter',
    );
  }
  if (!validateRouteAttemptOutcome(outcome, planValue)) {
    return failure(
      'INVALID_ATTEMPT_OUTCOME',
      'adapter outcome failed its compiled five-route evidence contract',
    );
  }
  return success(outcome);
}

function attemptEvidence(planValue, outcome) {
  return {
    attempt: outcome.attempt,
    planFingerprint: planValue.fingerprint,
    route: outcome.route,
    adapter: outcome.adapter,
    execution: planValue.execution,
    status: outcome.status,
    effect: outcome.effect,
    launchStatus: outcome.launchStatus,
    evidenceFingerprint: outcome.evidenceFingerprint,
    executionEvidence: structuredClone(outcome.executionEvidence),
    actorIdentityFingerprint: outcome.actorIdentityFingerprint,
    isolation: { ...outcome.isolation },
    modelIdentity: outcome.modelIdentity ?? null,
    verdict: outcome.verdict ?? null,
  };
}

function observedRouteState(
  routeState,
  planValue,
  outcome,
  event,
  updates = {},
) {
  return makeRouteTransition(
    routeState,
    planValue.fingerprint,
    outcome.evidenceFingerprint,
    event,
    updates,
  );
}

function buildReceipt(run, planValue, outcome, routeState) {
  const attempts = [
    ...planValue.history,
    attemptEvidence(planValue, outcome),
  ];
  const outageTransition = planValue.recoveryProbe
    ? 'recovered'
    : planValue.outageTransition;
  const receipt = {
    version: 1,
    runIntentHash: run.runIntentHash,
    generation: run.generation,
    hostEvidenceFingerprint: run.hostEvidenceFingerprint,
    runInstanceFingerprint: run.instanceFingerprint,
    invocationNonce: run.invocationNonce,
    configFingerprint: run.configFingerprint,
    checkout: structuredClone(planValue.checkout),
    sessionFingerprint: run.sessionFingerprint,
    invocationFlow: run.invocationFlow,
    activeHost: run.activeHost,
    selector: run.selector,
    requestedEngine: run.requestedEngine,
    requestedRoute: run.requestedRoute,
    actualRoute: planValue.actualRoute,
    adapter: planValue.adapter,
    execution: planValue.execution,
    flow: planValue.flow,
    stage: planValue.stage,
    round: planValue.round,
    role: planValue.role,
    reviewScope: planValue.reviewScope,
    planFingerprint: planValue.fingerprint,
    modelIdentity: outcome.modelIdentity ?? null,
    isolation: { ...outcome.isolation },
    effect: outcome.effect,
    configuredBaseOid: planValue.configuredBaseOid,
    artifactSubject: { ...planValue.artifactSubject },
    artifactVersion: planValue.artifactVersion,
    artifactFingerprint: planValue.artifactFingerprint,
    artifactSource: structuredClone(planValue.artifactSource),
    artifactAuthorFingerprint: planValue.artifactAuthorFingerprint,
    actorIdentityFingerprint: planValue.actorIdentityFingerprint,
    laneProofFingerprint: planValue.laneProofFingerprint,
    capabilityFingerprint: planValue.capabilityFingerprint,
    attemptCount: attempts.length,
    attempts,
    reviewVerdicts: attempts
      .filter(({ verdict }) => verdict !== null)
      .map(({
        attempt,
        planFingerprint,
        route,
        evidenceFingerprint,
        verdict,
      }) => ({
        attempt,
        planFingerprint,
        route,
        evidenceFingerprint,
        verdict,
      })),
    outageTransition,
    fallback: {
      used: planValue.fallbackUsed,
      from: planValue.fallbackUsed ? run.requestedRoute : null,
      to: planValue.fallbackUsed ? planValue.actualRoute : null,
    },
    degradation: [...planValue.degradation],
    routeState,
  };
  const authorization = authorizeValue(receipt, run.sessionFingerprint);
  return deepFreeze({
    ...receipt,
    authorization,
    fingerprint: hashValue({ ...receipt, authorization }),
  });
}

function validReceiptAttempt(record, index, receipt) {
  if (!hasExactKeys(record, ATTEMPT_EVIDENCE_KEYS)) return false;
  const postureValue = postureForExecution(
    record.route,
    receipt.role,
    record.execution,
  );
  const terminal = index === receipt.attempts.length - 1;
  return record.attempt === index + 1
    && HEX_64.test(record.planFingerprint)
    && (!terminal || record.planFingerprint === receipt.planFingerprint)
    && Object.hasOwn(ROUTE_CATALOG, record.route)
    && ROUTE_CATALOG[record.route].activeHost === receipt.activeHost
    && record.adapter === record.route
    && postureValue !== null
    && (
      terminal
        ? record.status === 'succeeded'
        : [
          'transient-failure',
          'environment-failure',
          'invalid-result',
        ].includes(record.status)
    )
    && (
      terminal
        ? record.effect === (receipt.role === 'writer' ? 'complete' : 'none')
        : record.effect === 'none'
    )
    && (
      record.status === 'environment-failure'
        ? record.launchStatus === 'not-launched'
        : record.launchStatus === 'launched'
    )
    && HEX_64.test(record.evidenceFingerprint)
    && validExecutionEvidence(record.executionEvidence, record.execution)
    && record.actorIdentityFingerprint === receipt.actorIdentityFingerprint
    && hasExactKeys(
      record.isolation,
      ['mode', 'verified', 'fingerprint'],
    )
    && record.isolation.mode === postureValue.isolation.mode
    && typeof record.isolation.verified === 'boolean'
    && HEX_64.test(record.isolation.fingerprint)
    && (
      record.modelIdentity === null
      || SAFE_IDENTITY.test(record.modelIdentity)
    )
    && (
      receipt.role === 'reviewer' && terminal
        ? validReviewVerdict(record.verdict)
        : record.verdict === null
    );
}

function validateRuntimeReceiptPolicy(receipt) {
  if (!hasExactKeys(receipt, RUNTIME_RECEIPT_KEYS)) return false;
  const withoutFingerprint = { ...receipt };
  delete withoutFingerprint.fingerprint;
  const authorizationInput = { ...withoutFingerprint };
  delete authorizationInput.authorization;
  if (
    receipt.version !== 1
    || !HEX_64.test(receipt.runIntentHash)
    || !Number.isSafeInteger(receipt.generation)
    || receipt.generation < 0
    || receipt.generation > MAX_RELAUNCH_GENERATIONS
    || !HEX_64.test(receipt.hostEvidenceFingerprint)
    || !HEX_64.test(receipt.runInstanceFingerprint)
    || !HEX_64.test(receipt.invocationNonce)
    || !HEX_64.test(receipt.configFingerprint)
    || !validExecutionCheckout(receipt.checkout)
    || !HEX_64.test(receipt.sessionFingerprint)
    || !FLOWS.includes(receipt.invocationFlow)
    || !HOSTS.includes(receipt.activeHost)
    || !SELECTORS.includes(receipt.selector)
    || !HOSTS.includes(receipt.requestedEngine)
    || !Object.hasOwn(ROUTE_CATALOG, receipt.requestedRoute)
    || !Object.hasOwn(ROUTE_CATALOG, receipt.actualRoute)
    || receipt.adapter !== receipt.actualRoute
    || !FLOWS.includes(receipt.flow)
    || !STAGES.includes(receipt.stage)
    || !Number.isSafeInteger(receipt.round)
    || receipt.round < 1
    || receipt.round > 100
    || receipt.role !== roleFor(receipt.stage)
    || receipt.reviewScope !== reviewScopeFor(receipt.stage, receipt.round)
    || !HEX_64.test(receipt.planFingerprint)
    || (
      receipt.modelIdentity !== null
      && !SAFE_IDENTITY.test(receipt.modelIdentity)
    )
    || !hasExactKeys(
      receipt.isolation,
      ['mode', 'verified', 'fingerprint'],
    )
    || receipt.isolation.verified !== true
    || !HEX_64.test(receipt.isolation.fingerprint)
    || receipt.effect !== (receipt.role === 'writer' ? 'complete' : 'none')
    || !HEX_40.test(receipt.configuredBaseOid)
    || !validArtifactSubject(receipt.artifactSubject, receipt)
    || !Number.isSafeInteger(receipt.artifactVersion)
    || receipt.artifactVersion < 1
    || !HEX_64.test(receipt.artifactFingerprint)
    || !validateDispatchArtifactSource({
      stage: receipt.stage,
      round: receipt.round,
      reviewScope: receipt.reviewScope,
      configuredBaseOid: receipt.configuredBaseOid,
      headOid: ['code-review', 'judgment-review'].includes(receipt.stage)
        ? receipt.artifactSubject.headOid
        : null,
      artifactVersion: receipt.artifactVersion,
      artifactFingerprint: receipt.artifactFingerprint,
      source: receipt.artifactSource,
    })
    || !HEX_64.test(receipt.artifactAuthorFingerprint)
    || !HEX_64.test(receipt.actorIdentityFingerprint)
    || !HEX_64.test(receipt.laneProofFingerprint)
    || !HEX_64.test(receipt.capabilityFingerprint)
    || !Number.isSafeInteger(receipt.attemptCount)
    || receipt.attemptCount < 1
    || receipt.attemptCount > 3
    || !Array.isArray(receipt.attempts)
    || receipt.attempts.length !== receipt.attemptCount
    || !receipt.attempts.every((record, index) =>
      validReceiptAttempt(record, index, receipt))
    || new Set(receipt.attempts.map(
      ({ executionEvidence }) => executionEvidence.instanceId,
    )).size !== receipt.attempts.length
    || new Set(receipt.attempts.map(
      ({ evidenceFingerprint }) => evidenceFingerprint,
    )).size !== receipt.attempts.length
    || receipt.attempts.at(-1).route !== receipt.actualRoute
    || receipt.attempts.at(-1).execution !== receipt.execution
    || receipt.modelIdentity !== receipt.attempts.at(-1).modelIdentity
    || hashValue(receipt.isolation)
      !== hashValue(receipt.attempts.at(-1).isolation)
    || !OUTAGE_TRANSITIONS.includes(receipt.outageTransition)
    || !hasExactKeys(receipt.fallback, ['used', 'from', 'to'])
    || typeof receipt.fallback.used !== 'boolean'
    || (
      receipt.fallback.used
        ? (
          receipt.fallback.from !== receipt.requestedRoute
          || receipt.fallback.to !== receipt.actualRoute
        )
        : receipt.fallback.from !== null || receipt.fallback.to !== null
    )
    || !Array.isArray(receipt.degradation)
    || receipt.degradation.length > DEGRADATIONS.length
    || new Set(receipt.degradation).size !== receipt.degradation.length
    || !receipt.degradation.every((value) => DEGRADATIONS.includes(value))
    || !validFingerprinted(receipt.routeState, ROUTE_STATE_KEYS)
    || receipt.routeState.runInstanceFingerprint
      !== receipt.runInstanceFingerprint
    || receipt.routeState.requestedRoute !== receipt.requestedRoute
    || receipt.routeState.capabilityFingerprint
      !== receipt.capabilityFingerprint
    || !Array.isArray(receipt.reviewVerdicts)
    || !receipt.reviewVerdicts.every((entry) =>
      hasExactKeys(entry, REVIEW_VERDICT_ENTRY_KEYS)
      && validReviewVerdict(entry.verdict))
    || hashValue(receipt.reviewVerdicts) !== hashValue(
      receipt.attempts
        .filter(({ verdict }) => verdict !== null)
        .map(({
          attempt,
          planFingerprint,
          route,
          evidenceFingerprint,
          verdict,
        }) => ({
          attempt,
          planFingerprint,
          route,
          evidenceFingerprint,
          verdict,
        })),
    )
    || receipt.fingerprint !== hashValue(withoutFingerprint)
    || !validAuthorization(
      authorizationInput,
      receipt.sessionFingerprint,
      receipt.authorization,
    )
  ) {
    return false;
  }
  return receipt.requestedEngine === (
    receipt.selector === 'native' ? receipt.activeHost : receipt.selector
  )
    && receipt.requestedRoute === routeFor(
      receipt.activeHost,
      receipt.requestedEngine,
    )
    && (
      receipt.artifactSubject.kind !== 'head'
      || receipt.checkout.headOid === receipt.artifactSubject.headOid
    )
    && (
      receipt.role === 'reviewer'
        ? receipt.reviewVerdicts.length === 1
        : receipt.reviewVerdicts.length === 0
    );
}

export function validateRuntimeReceipt(receipt) {
  try {
    return validateRuntimeReceiptPolicy(receipt);
  } catch {
    return false;
  }
}

function retryPlan(planValue, history, routeState) {
  return makePlan({
    ...planValue,
    attempt: planValue.attempt + 1,
    history,
    routeState,
  });
}

function fallbackPlan(planValue, history, routeState) {
  const fallback = planValue.fallback;
  return makePlan({
    ...planValue,
    actualRoute: fallback.route,
    adapter: fallback.adapter,
    execution: fallback.execution,
    requirements: [...fallback.requirements],
    evaluatedCapabilities: [...fallback.requirements],
    isolation: { ...fallback.isolation },
    recoveryProbe: false,
    fallbackUsed: true,
    fallback: null,
    degradation: [...new Set([
      ...planValue.degradation,
      ...fallback.degradation,
    ])],
    outageTransition:
      planValue.routeState.status === 'outage' ? 'continued' : 'entered',
    attempt: planValue.attempt + 1,
    maxAttempts: planValue.attempt + 1,
    history,
    routeState,
  });
}

function observePolicy(input) {
  if (!hasExactKeys(input, ['run', 'routeState', 'plan', 'outcome'])) {
    return invalidIntent('observe input has an invalid shape');
  }
  if (!validateRun(input.run)) {
    return failure('EXPIRED_PLAN', 'run context is invalid or stale');
  }
  if (!validatePlan(input.plan, input.run, input.routeState)) {
    return failure('EXPIRED_PLAN', 'dispatch plan is invalid, changed, or stale');
  }
  const outcome = validateOutcome(input.outcome, input.plan);
  if (!outcome.ok) return outcome;
  if (
    input.outcome.launchStatus === 'launched'
    && input.outcome.isolation.verified !== true
  ) {
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'executed attempt lacks verified effective isolation',
    );
  }
  if (input.outcome.launchStatus === 'not-launched') {
    if (
      !input.plan.fallbackUsed
      && input.plan.attempt < input.plan.maxAttempts
    ) {
      const history = [
        ...input.plan.history,
        attemptEvidence(input.plan, input.outcome),
      ];
      const routeState = observedRouteState(
        input.routeState,
        input.plan,
        input.outcome,
        'pre-execution-failed',
      );
      return success({
        kind: 'retry',
        routeState,
        nextPlan: retryPlan(input.plan, history, routeState),
      });
    }
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'pre-execution environment failed before a verified launch',
    );
  }
  if (
    input.plan.role === 'writer'
    && (
      ['partial', 'unknown'].includes(input.outcome.effect)
      || (
        input.outcome.status === 'succeeded'
        && input.outcome.effect !== 'complete'
      )
      || (
        input.outcome.status !== 'succeeded'
        && input.outcome.effect === 'complete'
      )
    )
  ) {
    return failure(
      'PARTIAL_WRITER_RESULT',
      'writer effects are partial or uncertain and require lifecycle recovery',
    );
  }
  if (input.outcome.status === 'environment-failure') {
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'adapter reported an environment or sandbox initialization failure',
    );
  }
  if (
    input.plan.role !== 'writer'
    && input.outcome.effect !== 'none'
  ) {
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'read-only dispatch reported a repository effect',
    );
  }
  if (
    input.outcome.status === 'succeeded'
  ) {
    const completedState = input.plan.recoveryProbe
      ? observedRouteState(
        input.routeState,
        input.plan,
        input.outcome,
        'recovery-succeeded',
        {
        status: 'healthy',
        consecutiveFailures: 0,
        },
      )
      : input.routeState.status === 'healthy'
        ? observedRouteState(
          input.routeState,
          input.plan,
          input.outcome,
          'attempt-succeeded',
          { consecutiveFailures: 0 },
        )
        : observedRouteState(
          input.routeState,
          input.plan,
          input.outcome,
          'fallback-succeeded',
        );
    const receipt = buildReceipt(
      input.run,
      input.plan,
      input.outcome,
      completedState,
    );
    return success({
      kind: 'complete',
      routeState: completedState,
      receipt,
    });
  }
  if (input.plan.fallbackUsed) {
    return failure(
      'UNSAFE_FALLBACK',
      'safe fallback failed and no further substitution is authorized',
    );
  }
  const history = [
    ...input.plan.history,
    attemptEvidence(input.plan, input.outcome),
  ];
  if (
    !input.plan.recoveryProbe
    && input.plan.attempt < input.plan.maxAttempts
  ) {
    const routeState = observedRouteState(
      input.routeState,
      input.plan,
      input.outcome,
      'attempt-failed',
      {
        consecutiveFailures: Math.min(
          1,
          input.routeState.consecutiveFailures + 1,
        ),
      },
    );
    return success({
      kind: 'retry',
      routeState,
      nextPlan: retryPlan(input.plan, history, routeState),
    });
  }
  if (!input.plan.fallback?.available) {
    return failure(
      'UNSAFE_FALLBACK',
      'bounded retry failed and no attested safe fallback is available',
    );
  }
  const routeState = observedRouteState(
    input.routeState,
    input.plan,
    input.outcome,
    'attempt-failed',
    {
      status: 'outage',
      consecutiveFailures: Math.max(
        2,
        input.routeState.consecutiveFailures + 1,
      ),
    },
  );
  return success({
    kind: 'fallback',
    routeState,
    nextPlan: fallbackPlan(input.plan, history, routeState),
  });
}

function finishPolicy(input) {
  if (!hasExactKeys(input, ['run', 'progress'])) {
    return invalidIntent('finish input has an invalid shape');
  }
  if (!validateRun(input.run)) {
    return invalidIntent('finish requires a valid frozen run context');
  }
  if (!hasExactKeys(input.progress, PROGRESS_KEYS, ['checkout'])) {
    return failure('INVALID_STOP', 'progress facts have an invalid shape');
  }
  const {
    reason,
    eligibleRemaining,
    unitsCompleted,
    queueComplete,
  } = input.progress;
  if (
    !STOP_REASONS.includes(reason)
    || !Number.isSafeInteger(eligibleRemaining)
    || eligibleRemaining < 0
    || !Number.isSafeInteger(unitsCompleted)
    || unitsCompleted < 0
    || typeof queueComplete !== 'boolean'
  ) {
    return failure('INVALID_STOP', 'progress facts contain an invalid stop value');
  }
  if (reason === 'queue-exhausted') {
    if (queueComplete !== true) {
      return failure(
        'INCOMPLETE_PROGRESS',
        'queue exhaustion requires complete absence evidence',
      );
    }
    if (eligibleRemaining !== 0) {
      return failure(
        'INVALID_STOP',
        'queue exhaustion cannot be claimed while eligible work remains',
      );
    }
  }
  if (reason === 'invocation-bound-reached') {
    if (
      input.run.scope.scope !== 'bounded'
      || unitsCompleted < input.run.scope.maxUnits
    ) {
      return failure(
        'INVALID_STOP',
        'invocation bound has not been reached',
      );
    }
  }
  const shouldRelaunch =
    reason === 'context-budget'
    && input.run.scope.scope === 'queue'
    && input.run.scope.autoContinue === true
    && unitsCompleted >= 1
    && eligibleRemaining >= 1
    && queueComplete === true;
  if (
    shouldRelaunch
    && input.run.generation < MAX_RELAUNCH_GENERATIONS
    && (
      !hasExactKeys(input.progress.checkout, CHECKOUT_KEYS)
      || !HEX_64.test(input.progress.checkout.repositoryFingerprint)
      || input.progress.checkout.branch !== input.run.configuredBaseBranch
      || !HEX_40.test(input.progress.checkout.headOid)
      || input.progress.checkout.clean !== true
    )
  ) {
    return failure(
      'INVALID_RELAUNCH',
      'relaunch requires a clean configured-base checkout and expected HEAD binding',
    );
  }
  if (shouldRelaunch && input.run.generation < MAX_RELAUNCH_GENERATIONS) {
    const envelope = {
      v: 2,
      originHost: input.run.originHost,
      selector: input.run.selector,
      scope: input.run.scope,
      generation: input.run.generation + 1,
      runIntentHash: input.run.runIntentHash,
    };
    const lease = makeContinuationLease(
      input.run,
      envelope,
      input.progress.checkout,
    );
    return success({
      action: 'relaunch',
      reason,
      prompt: RELAUNCH_PROMPT,
      envelope,
      lease,
      continuationState: makeContinuationState(lease, 'issued'),
    });
  }
  return success({
    action: 'stop',
    reason,
    ...(shouldRelaunch
      ? { relaunchSuppressed: 'generation-cap' }
      : {}),
  });
}

function guarded(code, message, operation) {
  try {
    return operation();
  } catch {
    return failure(code, message);
  }
}

export function open(input) {
  return guarded(
    'INVALID_INTENT',
    'open input is not a valid serializable runtime value',
    () => openPolicy(input),
  );
}

export function plan(input) {
  return guarded(
    'INVALID_INTENT',
    'plan input is not a valid serializable runtime value',
    () => planPolicy(input),
  );
}

export function observe(input) {
  return guarded(
    'INVALID_ATTEMPT_OUTCOME',
    'observe input is not a valid serializable runtime value',
    () => observePolicy(input),
  );
}

export function finish(input) {
  return guarded(
    'INVALID_STOP',
    'finish input is not a valid serializable runtime value',
    () => finishPolicy(input),
  );
}

export function transitionContinuationLease(input) {
  return guarded(
    'INVALID_RELAUNCH',
    'continuation lease transition input is not serializable',
    () => transitionContinuationLeasePolicy(input),
  );
}

export function initializeRouteState(input) {
  return guarded(
    'INVALID_INTENT',
    'route-state initialization input is not serializable',
    () => initializeRouteStatePolicy(input),
  );
}

export function refreshRouteState(input) {
  return guarded(
    'INVALID_INTENT',
    'capability refresh input is not serializable',
    () => refreshRouteStatePolicy(input),
  );
}

export const RuntimeContract = Object.freeze({ open, plan, observe, finish });

const HEX = {
  host: '1'.repeat(64),
  proof: '4'.repeat(64),
  artifact: '5'.repeat(64),
  evidence: '6'.repeat(64),
  isolation: '7'.repeat(64),
};
const OID = 'a'.repeat(40);
const OTHER_OID = 'b'.repeat(40);
const HEAD_OID = 'c'.repeat(40);
const OTHER_HEAD_OID = 'd'.repeat(40);
const FIXTURE_INLINE_SOURCE = Object.freeze({
  kind: 'inline-work',
  contentType: 'text/markdown',
  content: '# Ratified fixture\n\nPerform only this sealed work.',
});
const FIXTURE_INLINE_FINGERPRINT = artifactSourceFingerprint({
  stage: 'implementation',
  artifactVersion: 1,
  source: FIXTURE_INLINE_SOURCE,
});
const ROUTES = [
  'claude.native',
  'codex.native',
  'opencode.native',
  'claude.codex-exec',
  'claude.opencode-exec',
];
const REQUIREMENTS = [
  'claude.agent.available',
  'claude.agent.fresh-context',
  'claude.agent.writer',
  'claude.agent.reviewer-read-only',
  'codex.worker.available',
  'codex.worker.fresh-context',
  'codex.worker.writer',
  'codex.exec.available',
  'codex.authenticated',
  'codex.version.0.145.0',
  'codex.exec.workspace-write',
  'codex.exec.read-only',
  'codex.exec.network-denied',
  'codex.verdict-schema',
  'codex.spawn.available',
  'codex.spawn.agent-type',
  'codex.spawn.fork-turns-none',
  'codex.spawn.effective-read-only',
  'codex.spawn.integrity',
  'artifact.codex-reviewer',
  'opencode.task.available',
  'opencode.task.fresh-context',
  'opencode.task.writer',
  'opencode.run.available',
  'opencode.authenticated',
  'opencode.version.1.18.3',
  'opencode.run.writer',
  'opencode.reviewer.typed',
  'opencode.reviewer.denied-tools',
  'opencode.verdict-schema',
  'artifact.opencode-reviewer',
];
const ISOLATION = [
  'claude.agent.fresh-context',
  'claude.agent.reviewer-read-only',
  'codex.worker.fresh-context',
  'codex.exec.workspace-write',
  'codex.exec.read-only',
  'codex.exec.network-denied',
  'codex.spawn.fork-turns-none',
  'codex.spawn.effective-read-only',
  'codex.spawn.integrity',
  'opencode.task.fresh-context',
  'opencode.run.writer',
  'opencode.reviewer.typed',
  'opencode.reviewer.denied-tools',
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function fixtureHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

const FIXTURE_HOST_EVIDENCE = new Map();

function fixtureHostEvidence(host, observedHosts = [host]) {
  if (observedHosts.length !== 1 || observedHosts[0] !== host) {
    const valid = fixtureHostEvidence(host);
    const unsigned = { ...valid, observedHosts };
    delete unsigned.fingerprint;
    return { ...unsigned, fingerprint: fixtureHash(unsigned) };
  }
  if (!FIXTURE_HOST_EVIDENCE.has(host)) {
    const issued = issueHostEvidence({
      integration: 'runtime-self-test',
      sessionId: `session-${host}`,
      observedSurface: { host },
      expectedHost: host,
    });
    if (!issued.ok) throw new Error(`fixture ${host} host did not attest`);
    FIXTURE_HOST_EVIDENCE.set(host, issued.value);
  }
  return FIXTURE_HOST_EVIDENCE.get(host);
}

function fixtureConfig(extra = {}) {
  return {
    version: CONFIG_VERSION,
    baseBranch: 'main',
    gate: {
      command: 'npm test',
      quickCommand: null,
      setupCommand: null,
    },
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
    ...extra,
  };
}

function fixtureCheckout(extra = {}) {
  return {
    repositoryFingerprint: 'e'.repeat(64),
    branch: 'main',
    headOid: HEAD_OID,
    clean: true,
    ...extra,
  };
}

function fixtureInvocation(flow, selector = 'native', suffix = '') {
  const engine = selector === 'native' ? '' : ` with ${selector}`;
  return `/autoloop:${flow}${engine}${suffix}`;
}

function fixtureLaneProof(
  lane = 'full',
  mode = 'planned',
  oid = OID,
  {
    artifactVersion = 1,
    artifactFingerprint = FIXTURE_INLINE_FINGERPRINT,
    headOid = HEAD_OID,
  } = {},
) {
  const path = lane === 'docs'
    ? 'docs/guide.md'
    : lane === 'small'
      ? 'src/one.mjs'
      : '.githooks/pre-push';
  const subject = mode === 'final'
    ? { kind: 'head', headOid }
    : {
      kind: 'plan',
      artifactVersion,
      fingerprint: artifactFingerprint,
    };
  return classifyLaneProof({
    mode,
    configuredBase: { ref: 'origin/main', oid },
    subject,
    ...(mode === 'final'
      ? {
        final: {
          complete: true,
          changedFiles: 1,
          files: [{
            status: 'M',
            path,
            additions: 2,
            deletions: 1,
            contentRead: true,
          }],
          persistedData: false,
        },
      }
      : {
        planned: {
          complete: true,
          files: [{ path, contentRead: true }],
          estimatedChangedLines: 20,
          persistedData: false,
        },
      }),
  });
}

function artifactKind(stage) {
  if (stage === 'plan-review') return 'plan';
  if (stage === 'judgment-review') return 'judgment';
  if (stage === 'doctor') return 'doctor';
  return 'code';
}

function fixtureWork({
  flow = 'dev',
  stage = 'implementation',
  round = 1,
  planReviewDispatches,
  artifactVersion = 1,
  headOid = HEAD_OID,
  artifactSource,
  deltaBaseOid,
  openRebuttals = [],
  priorFindings,
  reviewerIdentity,
  concurrency,
  checkout,
  configuredBaseOid = OID,
} = {}) {
  const review = ['plan-review', 'code-review', 'judgment-review'].includes(stage);
  const source = artifactSource ?? (
    ['plan-review', 'implementation'].includes(stage)
      ? { ...FIXTURE_INLINE_SOURCE }
      : stage === 'code-review'
        ? {
          kind: 'git-review',
          configuredBaseOid,
          finalHeadOid: headOid,
          deltaBaseOid: deltaBaseOid
            ?? (round === 1 ? configuredBaseOid : OTHER_OID),
          priorFindings: round === 1
            ? []
            : structuredClone(priorFindings ?? (
              openRebuttals.length > 0
                ? openRebuttals.map(({ findingId }) => ({
                  findingId,
                  severity: 'Major',
                  summary: 'The prior review found a gating defect.',
                  evidence: 'The prior authenticated verdict is sealed.',
                  disposition: 'rebut',
                  state: 'open',
                  rationale: 'The author supplied a bounded rebuttal.',
                }))
                : [{
                  findingId: 'F-fixed',
                  severity: 'Major',
                  summary: 'The prior review found a gating defect.',
                  evidence: 'The prior authenticated verdict is sealed.',
                  disposition: 'fix',
                  state: 'open',
                  rationale: 'The exact delta contains the bounded fix.',
                }]
            )),
          openRebuttals: structuredClone(openRebuttals),
        }
        : stage === 'judgment-review'
          ? {
            kind: 'judgment',
            configuredBaseOid,
            finalHeadOid: headOid,
            question: 'Does the sealed evidence justify accepting this decision?',
            evidence: 'The disputed finding and rebuttal are attached here.',
          }
          : { kind: 'runtime-diagnostics' }
  );
  const artifactFingerprint = artifactSourceFingerprint({
    stage,
    artifactVersion,
    source,
  });
  return {
    flow,
    stage,
    round,
    planReviewDispatches:
      planReviewDispatches
      ?? (flow === 'dev' && stage !== 'plan-review' ? 1 : 0),
    configuredBaseOid,
    checkout: checkout ?? {
      root: '/workspace/autoloop',
      repositoryFingerprint: 'e'.repeat(64),
      branch: 'feature/autoloop-fixture',
      headOid,
      clean: true,
    },
    artifact: {
      kind: artifactKind(stage),
      version: artifactVersion,
      fingerprint: artifactFingerprint,
      authorIdentity: 'author-1',
      source,
      ...(['code-review', 'judgment-review'].includes(stage)
        ? { headOid }
        : {}),
      ...(review ? { reviewerIdentity: reviewerIdentity ?? 'reviewer-1' } : {}),
    },
    concurrency: concurrency ?? {
      activeWriters: 0,
      stagedAhead: 0,
      stagedAheadReadOnly: true,
    },
  };
}

function fixtureGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`fixture Git command failed: ${args.join(' ')}`);
  }
  return String(result.stdout ?? '').trim();
}

function fixtureLiveReviewWork() {
  const root = mkdtempSync(join(tmpdir(), 'autoloop-runtime-review-'));
  const initialized = spawnSync('git', [
    'init',
    '-q',
    '-b',
    'main',
    root,
  ], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  if (initialized.status !== 0 || initialized.error) {
    rmSync(root, { recursive: true, force: true });
    throw new Error('fixture Git repository did not initialize');
  }
  fixtureGit(root, ['config', 'user.email', 'autoloop@example.invalid']);
  fixtureGit(root, ['config', 'user.name', 'Autoloop Fixture']);
  fixtureGit(root, [
    'remote',
    'add',
    'origin',
    'https://github.com/autoloop/runtime-fixture.git',
  ]);
  writeFileSync(join(root, 'review.txt'), 'before\n');
  fixtureGit(root, ['add', '--', 'review.txt']);
  fixtureGit(root, ['commit', '-q', '-m', 'base']);
  const baseOid = fixtureGit(root, ['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'review.txt'), 'after\n');
  fixtureGit(root, ['add', '--', 'review.txt']);
  fixtureGit(root, ['commit', '-q', '-m', 'head']);
  const checkout = snapshotExecutionCheckout(root);
  const expectedPatch = `${fixtureGit(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-color',
    '--full-index',
    '--patch',
    baseOid,
    checkout.headOid,
    '--',
  ])}\n`;
  return {
    root,
    expectedPatch,
    work: fixtureWork({
      stage: 'code-review',
      headOid: checkout.headOid,
      deltaBaseOid: baseOid,
      checkout,
      configuredBaseOid: baseOid,
    }),
  };
}

function fixtureCapabilities(
  run,
  mode = 'available',
  overrides = {},
  checkout = fixtureWork().checkout,
) {
  const facts = Object.fromEntries(REQUIREMENTS.map((requirement) => [requirement, true]));
  if (mode === 'missing') {
    for (const requirement of REQUIREMENTS) {
      if (!ISOLATION.includes(requirement)) facts[requirement] = false;
    }
  }
  if (mode === 'unisolated') {
    for (const requirement of ISOLATION) facts[requirement] = false;
  }
  const resolved = { ...facts, ...overrides };
  const observations = Object.entries(resolved)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([requirement, available]) => ({
      requirement,
      available,
      source: 'runtime-self-test',
      evidenceFingerprint: fixtureHash({ requirement, available }),
    }));
  const snapshot = issueCapabilitySnapshot({
    hostEvidence: fixtureHostEvidence(run.activeHost),
    invocationNonce: run.invocationNonce,
    checkout,
    observations,
  });
  if (!snapshot.ok) throw new Error('fixture capability snapshot did not issue');
  return snapshot.value;
}

function fixtureCapabilityFingerprint(capabilities) {
  return capabilities.fingerprint;
}

function fixtureRouteState(run, capabilities, status = 'healthy') {
  const initialized = initializeRouteState({ run, capabilities });
  if (!initialized.ok || status === 'healthy') {
    return initialized.value;
  }
  const firstFailure = makeRouteTransition(
    initialized.value,
    HEX.proof,
    HEX.evidence,
    'attempt-failed',
    { consecutiveFailures: 1 },
  );
  return makeRouteTransition(
    firstFailure,
    HEX.proof,
    HEX.evidence,
    'attempt-failed',
    { status: 'outage', consecutiveFailures: 2 },
  );
}

function fixtureContinuationBundle(relaunch) {
  const claimed = transitionContinuationLease({
    lease: relaunch.lease,
    state: relaunch.continuationState,
    nextStatus: 'claimed',
    claimFingerprint: HEX.evidence,
  });
  if (!claimed.ok) return null;
  const sessionFingerprint =
    fixtureHostEvidence(relaunch.envelope.originHost).sessionFingerprint;
  const created = transitionContinuationLease({
    lease: relaunch.lease,
    state: claimed.value.state,
    nextStatus: 'session-created',
    sessionFingerprint,
  });
  if (!created.ok) return null;
  const opened = transitionContinuationLease({
    lease: relaunch.lease,
    state: created.value.state,
    nextStatus: 'opened',
  });
  if (!opened.ok) return null;
  return {
    continuation: relaunch.envelope,
    continuationLease: relaunch.lease,
    continuationState: opened.value.state,
    continuationAuthorization: opened.value.authorization,
  };
}

function nativeRoute(host) {
  return `${host}.native`;
}

function expectedRequestedRoute(host, selector) {
  const engine = selector === 'native' ? host : selector;
  if (engine === host) return nativeRoute(host);
  if (host === 'claude' && engine === 'codex') return 'claude.codex-exec';
  if (host === 'claude' && engine === 'opencode') return 'claude.opencode-exec';
  return null;
}

function stageAcceptsRound(flow, stage, round) {
  if (flow === 'pitcrew' && stage === 'plan-review') return false;
  if (stage === 'code-review') return Number.isInteger(round) && round >= 1;
  return round === 1;
}

function expectedEffectiveLane(flow, stage, round, lane, mode) {
  if (flow === 'pitcrew') return 'full';
  if (stage === 'code-review' && round === 1 && lane !== 'full' && mode !== 'final') {
    return 'full';
  }
  return lane;
}

function expectedNominalRoute(run, flow, stage, round, lane) {
  const native = nativeRoute(run.activeHost);
  if (stage === 'judgment-review') return native;
  if (flow === 'pitcrew') {
    if (stage === 'code-review' && round >= 2) return native;
    return run.requestedRoute;
  }
  if (stage === 'plan-review') return lane === 'full' ? run.requestedRoute : native;
  if (stage === 'implementation') return lane === 'docs' ? native : run.requestedRoute;
  if (stage === 'code-review') {
    if (round >= 2 || lane !== 'full') return native;
    return run.requestedRoute;
  }
  return run.requestedRoute;
}

function isReview(stage) {
  return ['plan-review', 'code-review', 'judgment-review'].includes(stage);
}

function expectedActualRoute(run, state, nominal, stage) {
  if (state.status !== 'outage' || nominal !== run.requestedRoute) return nominal;
  if (stage === 'judgment-review') return null;
  if (isReview(stage)) return nominal;
  if (run.requestedRoute !== nativeRoute(run.activeHost)) return nativeRoute(run.activeHost);
  return null;
}

function fixtureExecutionEvidence(attempt) {
  const instanceId =
    `fixture-${attempt.attempt}-${attempt.role}-${attempt.execution}`
      .replace(/[^A-Za-z0-9._:-]/g, '-');
  if (attempt.launch.transport === 'process') {
    return {
      kind: 'process',
      instanceId,
      integration: attempt.producer,
      transcriptFingerprint: HEX.evidence,
    };
  }
  if (attempt.role === 'probe') {
    return {
      kind: 'host-surface',
      instanceId,
      integration: attempt.producer,
      transcriptFingerprint: HEX.evidence,
    };
  }
  return {
    kind: 'host-child',
    instanceId,
    integration: attempt.producer,
    metadataFile: `${instanceId}-payload.json`,
    metadataFingerprint: HEX.evidence,
    transcriptFile: `${instanceId}-transcript.jsonl`,
    transcriptFingerprint: HEX.evidence,
  };
}

function fixtureOutcome(planValue, {
  status = 'succeeded',
  effect,
  modelIdentity = 'observable/model',
  isolationVerified = true,
  launchStatus = 'launched',
} = {}) {
  const writer = planValue.role === 'writer';
  const attempt = compileRouteAttempt(planValue);
  if (!attempt.ok) throw new Error('fixture plan does not compile');
  const receipt = issueHostAttemptReceipt({
    attempt: attempt.value,
    raw: {
      producer: attempt.value.producer,
      status,
      effect: effect
        ?? (writer && status === 'succeeded' ? 'complete' : 'none'),
      launchStatus,
      isolation: {
        mode: planValue.isolation.mode,
        verified: isolationVerified,
        fingerprint: HEX.isolation,
      },
      executionEvidence: fixtureExecutionEvidence(attempt.value),
      ...(modelIdentity === undefined ? {} : { modelIdentity }),
      ...(!writer && planValue.role === 'reviewer' && status === 'succeeded'
        ? { verdict: { verdict: 'pass', findings: [], rebuts: [] } }
        : {}),
    },
  });
  if (!receipt.ok) throw new Error('fixture host receipt does not issue');
  const outcome = classifyRouteAttempt({
    attempt: attempt.value,
    evidence: receipt.value,
  });
  if (!outcome.ok) throw new Error('fixture evidence does not classify');
  return outcome.value;
}

function selfTest() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  const check = (name, predicate) => {
    try {
      if (predicate()) {
        passed += 1;
      } else {
        failed += 1;
        if (failures.length < 30) failures.push(name);
      }
    } catch (error) {
      failed += 1;
      if (failures.length < 30) failures.push(`${name}: ${error.message}`);
    }
  };
  const expectError = (result, code) =>
    result?.ok === false
    && result.error?.code === code
    && ERROR_CODES.includes(result.error.code)
    && JSON.stringify(result).length < 2048;
  const openRun = (host, selector = 'native', options = {}) =>
    open({
      invocation: fixtureInvocation(options.flow ?? 'dev', selector, options.suffix ?? ''),
      hostEvidence: fixtureHostEvidence(host),
      config: fixtureConfig(options.config ?? {}),
      ...(options.continuationBundle ?? {}),
    });

  check('public interface is exactly open, plan, observe, finish', () =>
    Object.keys(RuntimeContract).join(',') === 'open,plan,observe,finish'
    && Object.values(RuntimeContract).every((value) => typeof value === 'function')
    && typeof transitionContinuationLease === 'function'
    && typeof initializeRouteState === 'function');
  check('stable enum exports are exact', () =>
    HOSTS.join(',') === 'claude,codex,opencode'
    && SELECTORS.join(',') === 'native,claude,codex,opencode'
    && FLOWS.join(',') === 'dev,pitcrew,doctor'
    && LANES.join(',') === 'docs,small,full'
    && ATTEMPT_STATUSES.join(',') ===
      'succeeded,transient-failure,environment-failure,invalid-result'
    && EFFECTS.join(',') === 'none,complete,partial,unknown');
  check('route catalog is closed and serializable', () =>
    Object.keys(ROUTE_CATALOG).join(',') === ROUTES.join(',')
    && JSON.parse(JSON.stringify(ROUTE_CATALOG)) !== null
    && !JSON.stringify(ROUTE_CATALOG).includes('function'));
  check('capability allowlists are exact', () =>
    CAPABILITY_REQUIREMENTS.join(',') === REQUIREMENTS.join(',')
    && ISOLATION_REQUIREMENTS.join(',') === ISOLATION.join(','));
  check('route catalog carries artifact and doctor contracts', () =>
    ROUTE_CATALOG['claude.native']?.requiredArtifacts?.length === 0
    && ROUTE_CATALOG['codex.native']?.requiredArtifacts?.some(
      (artifact) => artifact.path === '.codex/agents/autoloop-reviewer.toml',
    )
    && ROUTE_CATALOG['opencode.native']?.requiredArtifacts?.some(
      (artifact) => artifact.path === '.opencode/agent/autoloop-reviewer.md',
    )
    && ROUTE_CATALOG['claude.codex-exec']?.doctor?.minimumVersion === '0.145.0'
    && ROUTE_CATALOG['claude.opencode-exec']?.doctor?.minimumVersion === '1.18.3');

  for (const host of HOSTS) {
    for (const selector of SELECTORS) {
      const expected = expectedRequestedRoute(host, selector);
      const result = openRun(host, selector);
      check(`route ${host} × ${selector}`, () => {
        if (!expected) return expectError(result, 'UNSUPPORTED_ROUTE');
        if (!result?.ok) return false;
        const run = result.value;
        const replay = openRun(host, selector);
        return run.activeHost === host
          && run.originHost === host
          && run.invocationFlow === 'dev'
          && run.selector === selector
          && run.requestedEngine === (selector === 'native' ? host : selector)
          && run.requestedRoute === expected
          && run.scope.scope === 'queue'
          && run.generation === 0
          && /^[a-f0-9]{64}$/.test(run.runIntentHash)
          && Object.isFrozen(run)
          && replay.ok
          && replay.value.runIntentHash === run.runIntentHash
          && replay.value.invocationNonce !== run.invocationNonce
          && replay.value.instanceFingerprint !== run.instanceFingerprint;
      });
    }
  }

  check('native ignores adapter tuning as route authority', () => {
    const result = openRun('codex', 'native', {
      config: {
        adapterOptions: {
          'claude.codex-exec': { reviewerModel: 'misleading-model' },
        },
      },
    });
    return result.ok
      && result.value.requestedRoute === 'codex.native'
      && !JSON.stringify(result.value).includes('misleading');
  });
  check('runtime authority in config is rejected', () =>
    expectError(openRun('claude', 'native', {
      config: { runtime: { supportedHosts: ['codex'] } },
    }), 'CONFIG_MIGRATION_REQUIRED')
    && expectError(openRun('claude', 'native', {
      config: { engine: { profile: 'codex' } },
    }), 'CONFIG_MIGRATION_REQUIRED')
    && expectError(openRun('claude', 'native', {
      config: { requestedEngine: 'codex' },
    }), 'CONFIG_MIGRATION_REQUIRED'));
  check('public rehashing cannot mutate sealed run intent', () => {
    const opened = openRun('claude', 'native');
    if (!opened.ok) return false;
    const forged = {
      ...opened.value,
      selector: 'codex',
      requestedEngine: 'codex',
      requestedRoute: 'claude.codex-exec',
      scope: { scope: 'queue', autoContinue: true },
    };
    forged.runIntentHash = intentHash(
      forged.originHost,
      forged.selector,
      forged.scope,
      forged.invocationFlow,
    );
    forged.instanceFingerprint = runInstanceFingerprint(forged);
    return expectError(finish({
      run: forged,
      progress: {
        reason: 'context-budget',
        eligibleRemaining: 1,
        unitsCompleted: 1,
        queueComplete: true,
        checkout: fixtureCheckout(),
      },
    }), 'INVALID_INTENT')
      && expectError(initializeRouteState({
        run: forged,
        capabilities: fixtureCapabilities(opened.value),
      }), 'EXPIRED_PLAN');
  });
  check('old config requires exact migration remedy', () => {
    const result = open({
      invocation: '/autoloop:dev',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig({ version: '0.24.0' }),
    });
    return expectError(result, 'CONFIG_MIGRATION_REQUIRED')
      && result.error.remedy ===
        'Run /autoloop:setup to migrate STATE to configuration schema 0.25.0.';
  });
  check('runtime rejects a shallow config that omits ProjectContract fields', () =>
    expectError(open({
      invocation: '/autoloop:dev',
      hostEvidence: fixtureHostEvidence('claude'),
      config: {
        version: CONFIG_VERSION,
        baseBranch: 'main',
      },
    }), 'CONFIG_MIGRATION_REQUIRED'));
  check('unknown live host is typed', () =>
    expectError(open({
      invocation: '/autoloop:dev',
      hostEvidence: fixtureHostEvidence('claude', ['desktop']),
      config: fixtureConfig(),
    }), 'UNKNOWN_ACTIVE_HOST'));
  check('ambiguous live host is typed', () =>
    expectError(open({
      invocation: '/autoloop:dev',
      hostEvidence: fixtureHostEvidence('claude', ['claude', 'codex']),
      config: fixtureConfig(),
    }), 'AMBIGUOUS_ACTIVE_HOST'));
  check('non-live host evidence is rejected', () =>
    expectError(open({
      invocation: '/autoloop:dev',
      hostEvidence: { ...fixtureHostEvidence('claude'), source: 'environment' },
      config: fixtureConfig(),
    }), 'UNKNOWN_ACTIVE_HOST'));
  check('explicit selector conflict is typed', () =>
    expectError(open({
      invocation: '/autoloop:dev with codex with opencode',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'CONFLICTING_INTENT'));
  check('flow conflict is typed', () =>
    expectError(open({
      invocation: '/autoloop:dev /autoloop:pitcrew',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'CONFLICTING_INTENT'));
  check('unknown selector is not silently native', () =>
    expectError(open({
      invocation: '/autoloop:dev with desktop',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'INVALID_INTENT'));
  check('unknown selector before trailing scope prose is rejected', () =>
    expectError(open({
      invocation: '/autoloop:dev with desktop; auto-continue',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'INVALID_INTENT'));
  for (const invocation of [
    '/autoloop:dev using codex',
    '/autoloop:dev; use codex',
    '/autoloop:dev select codex',
    '/autoloop:dev choose the codex model',
    '/autoloop:dev run on the codex engine',
    '/autoloop:dev via codex',
    '/autoloop:dev on codex',
    '/autoloop:dev engine=codex',
    '/autoloop:dev engine:codex',
    '/autoloop:dev --engine gemini',
    '/autoloop:dev engine=gemini',
    '/autoloop:dev engine="gemini"',
    '/autoloop:dev with=codex',
    '/autoloop:dev with 123',
    '/autoloop:dev with _desktop',
    '/autoloop:dev --engine',
    '/autoloop:dev --engine=',
    '/autoloop:dev engine=',
    '/autoloop:dev with',
    '/autoloop:dev with=',
  ]) {
    check(`recognizable noncanonical selector is rejected: ${invocation}`, () =>
      expectError(open({
        invocation,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
      }), 'INVALID_INTENT'));
  }
  check('unknown selector cannot hide before a canonical selector', () =>
    expectError(open({
      invocation: '/autoloop:dev with desktop then with codex',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'INVALID_INTENT'));
  check('known selector outside the canonical suffix is rejected', () =>
    expectError(open({
      invocation: '/autoloop:dev with codex; auto-continue',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'INVALID_INTENT'));
  for (const invocation of [
    '/autoloop:dev use the ratified plan',
    '/autoloop:dev using the existing spec',
    '/autoloop:dev choose issue #7',
    '/autoloop:dev implement with tests',
    '/autoloop:dev use plan',
    '/autoloop:dev update the data model',
    '/autoloop:dev fix the simulation engine',
    '/autoloop:dev improve engine performance',
  ]) {
    check(`ordinary workflow prose is not an engine selector: ${invocation}`, () =>
      open({
        invocation,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
      }).ok);
  }
  check('old relaunch marker is rejected', () =>
    expectError(open({
      invocation: '/autoloop:dev [autoloop-relaunch gen=2]',
      hostEvidence: fixtureHostEvidence('opencode'),
      config: fixtureConfig(),
    }), 'INVALID_RELAUNCH'));
  check('scope grammar preserves queue default', () => {
    const queue = open({
      invocation: '/autoloop:dev drain the queue',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    });
    const bounded = open({
      invocation: '/autoloop:dev take one issue and stop',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    });
    const issue = open({
      invocation: '/autoloop:dev only #52',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    });
    const max = open({
      invocation: '/autoloop:dev maxUnits: 3',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    });
    return queue.ok && queue.value.scope.scope === 'queue'
      && bounded.ok && bounded.value.scope.maxUnits === 1
      && issue.ok && issue.value.scope.issue === 52
      && max.ok && max.value.scope.maxUnits === 3;
  });
  check('bounded and auto-continue intent conflicts', () =>
    expectError(open({
      invocation: '/autoloop:dev take one issue and auto-continue',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'CONFLICTING_INTENT'));
  check('Dev, standalone Pitcrew, and doctor open distinct invocation intent', () => {
    const dev = openRun('claude', 'native', { flow: 'dev' });
    const pitcrew = openRun('claude', 'native', { flow: 'pitcrew' });
    const doctor = open({
      invocation: '/autoloop:setup doctor',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    });
    return dev.ok
      && pitcrew.ok
      && doctor.ok
      && dev.value.invocationFlow === 'dev'
      && pitcrew.value.invocationFlow === 'pitcrew'
      && doctor.value.invocationFlow === 'doctor'
      && dev.value.runIntentHash !== pitcrew.value.runIntentHash
      && dev.value.runIntentHash !== doctor.value.runIntentHash;
  });

  for (const host of HOSTS) {
    for (const selector of SELECTORS) {
      if (!expectedRequestedRoute(host, selector)) continue;
      const original = open({
        invocation: selector === 'native'
          ? '/autoloop:dev; auto-continue'
          : `/autoloop:dev; auto-continue with ${selector}`,
        hostEvidence: fixtureHostEvidence(host),
        config: fixtureConfig(),
      });
      check(`relaunch source opens ${host} × ${selector}`, () =>
        original.ok && original.value.scope.autoContinue === true);
      if (!original.ok) continue;
      const finished = finish({
        run: original.value,
        progress: {
          reason: 'context-budget',
          eligibleRemaining: 2,
          unitsCompleted: 1,
          queueComplete: true,
          checkout: fixtureCheckout(),
        },
      });
      check(`relaunch envelope emitted ${host} × ${selector}`, () =>
        finished.ok
        && finished.value.action === 'relaunch'
        && finished.value.prompt === RELAUNCH_PROMPT
        && finished.value.envelope.selector === selector
        && finished.value.envelope.originHost === host
        && finished.value.envelope.runIntentHash === original.value.runIntentHash
        && finished.value.envelope.generation === 1
        && Object.keys(finished.value.envelope).join(',') ===
          'v,originHost,selector,scope,generation,runIntentHash');
      if (!finished.ok) continue;
      const continuationBundle = fixtureContinuationBundle(finished.value);
      const reopened = open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence(host),
        config: fixtureConfig(),
        ...continuationBundle,
      });
      check(`relaunch round trip ${host} × ${selector}`, () =>
        reopened.ok
        && reopened.value.selector === selector
        && reopened.value.requestedRoute === original.value.requestedRoute
        && reopened.value.scope.autoContinue === true
        && reopened.value.generation === 1
        && reopened.value.runIntentHash === original.value.runIntentHash);
      if (host === 'claude' && selector === 'codex') {
        check('valid generation-one run rejects a generation-zero plan', () => {
          if (!reopened.ok) return false;
          const capabilities = fixtureCapabilities(original.value);
          const routeState = fixtureRouteState(
            original.value,
            capabilities,
          );
          const dispatch = plan({
            run: original.value,
            work: fixtureWork({ stage: 'code-review' }),
            laneProof: fixtureLaneProof('full', 'final'),
            capabilities,
            routeState,
          });
          if (!dispatch.ok) return false;
          return expectError(observe({
            run: reopened.value,
            routeState: dispatch.value.routeState,
            plan: dispatch.value,
            outcome: fixtureOutcome(dispatch.value),
          }), 'EXPIRED_PLAN');
        });
      }
    }
  }

  const relaunchSource = open({
    invocation: '/autoloop:dev; auto-continue with codex',
    hostEvidence: fixtureHostEvidence('claude'),
    config: fixtureConfig(),
  });
  const relaunchPlan = relaunchSource.ok
    ? finish({
      run: relaunchSource.value,
      progress: {
        reason: 'context-budget',
        eligibleRemaining: 1,
        unitsCompleted: 1,
        queueComplete: true,
        checkout: fixtureCheckout(),
      },
    })
    : relaunchSource;
  if (relaunchPlan.ok) {
    const envelope = relaunchPlan.value.envelope;
    const continuationBundle = fixtureContinuationBundle(
      relaunchPlan.value,
    );
    check('finish issues an exact continuation lease and CAS state', () =>
      typeof transitionContinuationLease === 'function'
      && relaunchPlan.value.lease?.kind === 'autoloop-continuation-lease'
      && relaunchPlan.value.continuationState?.kind ===
        'autoloop-continuation-state'
      && relaunchPlan.value.continuationState?.status === 'issued'
      && relaunchPlan.value.lease?.repositoryFingerprint ===
        fixtureCheckout().repositoryFingerprint
      && relaunchPlan.value.lease?.expectedBaseBranch === 'main'
      && relaunchPlan.value.lease?.expectedHeadOid === HEAD_OID
      && relaunchPlan.value.lease?.envelopeFingerprint ===
        hashValue(envelope));
    check('continuation lifecycle is ordered and idempotent at each CAS state', () => {
      const claimed = transitionContinuationLease({
        lease: relaunchPlan.value.lease,
        state: relaunchPlan.value.continuationState,
        nextStatus: 'claimed',
        claimFingerprint: HEX.evidence,
      });
      if (!claimed.ok) return false;
      const repeat = transitionContinuationLease({
        lease: relaunchPlan.value.lease,
        state: claimed.value.state,
        nextStatus: 'claimed',
      });
      const skipped = transitionContinuationLease({
        lease: relaunchPlan.value.lease,
        state: relaunchPlan.value.continuationState,
        nextStatus: 'session-created',
        claimFingerprint: HEX.evidence,
        sessionFingerprint:
          fixtureHostEvidence('claude').sessionFingerprint,
      });
      return claimed.value.state.status === 'claimed'
        && repeat.ok
        && repeat.value.state.fingerprint === claimed.value.state.fingerprint
        && expectError(skipped, 'INVALID_RELAUNCH');
    });
    check('opened authorization is idempotent only in its bound host session', () => {
      const input = {
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
      };
      const first = open(input);
      const replay = open(input);
      const otherSession = issueHostEvidence({
        integration: 'runtime-self-test',
        sessionId: 'other-session',
        observedSurface: { host: 'claude' },
        expectedHost: 'claude',
      });
      if (!otherSession.ok) return false;
      const crossSession = open({
        ...input,
        hostEvidence: otherSession.value,
      });
      return first.ok
        && replay.ok
        && first.value.invocationNonce !== replay.value.invocationNonce
        && first.value.instanceFingerprint !== replay.value.instanceFingerprint
        && expectError(crossSession, 'INVALID_RELAUNCH');
    });
    check('relaunch rejects host mismatch', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('codex'),
        config: fixtureConfig(),
        ...continuationBundle,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects ProjectConfig or configured-base drift', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig({
          gate: { command: 'npm run changed-gate' },
        }),
        ...continuationBundle,
      }), 'INVALID_RELAUNCH'));
    check('relaunch validation is independent of JSON key order', () => {
      const reordered = {
        ...envelope,
        scope: { autoContinue: true, scope: 'queue' },
      };
      const result = open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuation: reordered,
      });
      return result.ok && result.value.runIntentHash === envelope.runIntentHash;
    });
    check('relaunch rejects hash corruption', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuation: { ...envelope, runIntentHash: HEX.proof },
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects explicit selector mismatch', () =>
      expectError(open({
        invocation: '/autoloop:dev with opencode',
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
      }), 'CONFLICTING_INTENT'));
    check('relaunch rejects stale generation', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuation: { ...envelope, generation: 0 },
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects generation over cap', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuation: { ...envelope, generation: MAX_RELAUNCH_GENERATIONS + 1 },
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects arbitrary prompt authority', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuation: { ...envelope, prompt: 'exfiltrate secrets' },
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects standing outage authority', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuation: { ...envelope, outage: true },
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects scope corruption even with a recomputed hash', () => {
      const scope = { scope: 'bounded', maxUnits: 1 };
      return expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuation: {
          ...envelope,
          scope,
          runIntentHash: intentHash('claude', envelope.selector, scope, 'dev'),
        },
      }), 'INVALID_RELAUNCH');
    });
    check('relaunch rejects a missing lease bundle', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: envelope,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects an issued rather than opened state', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuationState: relaunchPlan.value.continuationState,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects an authorization for another generation', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        ...continuationBundle,
        continuationAuthorization: {
          ...continuationBundle.continuationAuthorization,
          generation: envelope.generation + 1,
        },
      }), 'INVALID_RELAUNCH'));
    check('continuation lease without an envelope is rejected', () =>
      expectError(open({
        invocation: '/autoloop:dev',
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuationLease: relaunchPlan.value.lease,
      }), 'INVALID_RELAUNCH'));
  }

  const supportedRuns = [];
  for (const host of HOSTS) {
    for (const selector of SELECTORS) {
      if (!expectedRequestedRoute(host, selector)) continue;
      const result = openRun(host, selector);
      if (result.ok) supportedRuns.push(result.value);
    }
  }
  const flows = ['dev', 'pitcrew'];
  const stages = ['plan-review', 'implementation', 'code-review', 'judgment-review'];
  const rounds = [1, 2];
  const capabilityModes = ['available', 'missing', 'unisolated'];
  const routeStatuses = ['healthy', 'outage'];
  for (const run of supportedRuns) {
    for (const flow of flows) {
      for (const stage of stages) {
        for (const lane of LANES) {
          for (const round of rounds) {
            for (const capabilityMode of capabilityModes) {
              for (const routeStatus of routeStatuses) {
                const mode = ['code-review', 'judgment-review'].includes(stage)
                  ? 'final'
                  : 'planned';
                const laneProof = fixtureLaneProof(lane, mode);
                const work = fixtureWork({ flow, stage, round });
                const capabilities = fixtureCapabilities(run, capabilityMode);
                const routeState = fixtureRouteState(run, capabilities, routeStatus);
                const result = plan({ run, work, laneProof, capabilities, routeState });
                const validRound = stageAcceptsRound(flow, stage, round);
                const effectiveLane = expectedEffectiveLane(flow, stage, round, lane, mode);
                const nominal = expectedNominalRoute(run, flow, stage, round, effectiveLane);
                const actual = expectedActualRoute(run, routeState, nominal, stage);
                const outageWriterFallback =
                  routeStatus === 'outage'
                  && stage === 'implementation'
                  && nominal === run.requestedRoute
                  && run.requestedRoute !== nativeRoute(run.activeHost);
                const name = [
                  run.activeHost,
                  run.selector,
                  flow,
                  stage,
                  lane,
                  `r${round}`,
                  capabilityMode,
                  routeStatus,
                ].join(' · ');
                check(`matrix ${name}`, () => {
                  if (!validRound) return expectError(result, 'INVALID_INTENT');
                  if (capabilityMode === 'missing') {
                    return expectError(
                      result,
                      actual && !outageWriterFallback
                        ? 'MISSING_CAPABILITY'
                        : 'UNSAFE_FALLBACK',
                    );
                  }
                  if (capabilityMode === 'unisolated') {
                    return expectError(
                      result,
                      actual && !outageWriterFallback
                        ? 'UNVERIFIABLE_ISOLATION'
                        : 'UNSAFE_FALLBACK',
                    );
                  }
                  if (!actual) return expectError(result, 'UNSAFE_FALLBACK');
                  if (!result.ok) return false;
                  const value = result.value;
                  const repeat = plan({ run, work, laneProof, capabilities, routeState });
                  return repeat.ok
                    && JSON.stringify(repeat.value) === JSON.stringify(value)
                    && value.requestedRoute === run.requestedRoute
                    && value.actualRoute === actual
                    && value.effectiveLane === effectiveLane
                    && value.artifactVersion === work.artifact.version
                    && JSON.stringify(value.artifactSubject) === JSON.stringify(
                      dispatchArtifactSubject(work),
                    )
                    && value.laneProofFingerprint === laneProof.fingerprint
                    && value.capabilityFingerprint ===
                      fixtureCapabilityFingerprint(capabilities)
                    && /^[a-f0-9]{64}$/.test(value.fingerprint)
                    && value.recoveryProbe ===
                      (routeStatus === 'outage'
                        && nominal === run.requestedRoute
                        && ['plan-review', 'code-review'].includes(stage));
                });
              }
            }
          }
        }
      }
    }
  }

  const crossRunResult = openRun('claude', 'codex');
  if (crossRunResult.ok) {
    const run = crossRunResult.value;
    const capabilities = fixtureCapabilities(run);
    const healthy = fixtureRouteState(run, capabilities);
    check('run context exposes a complete run-instance fingerprint', () =>
      /^[a-f0-9]{64}$/.test(run.instanceFingerprint ?? '')
      && run.instanceFingerprint === hashValue({
        kind: 'autoloop-run-instance',
        version: 1,
        runIntentHash: run.runIntentHash,
        originHost: run.originHost,
        activeHost: run.activeHost,
        hostEvidenceFingerprint: run.hostEvidenceFingerprint,
        sessionFingerprint: run.sessionFingerprint,
        invocationNonce: run.invocationNonce,
        configuredBaseBranch: run.configuredBaseBranch,
        configFingerprint: run.configFingerprint,
        generation: run.generation,
      }));
    check('caller-authored outage state cannot select recovery or fallback', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'code-review' }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: {
          status: 'outage',
          requestedRoute: run.requestedRoute,
          consecutiveFailures: 2,
          capabilityFingerprint: fixtureCapabilityFingerprint(capabilities),
        },
      });
      return expectError(result, 'INVALID_INTENT');
    });
    check('capability fingerprint churn cannot silently clear an outage', () => {
      const outage = fixtureRouteState(run, capabilities, 'outage');
      const changed = fixtureCapabilities(run, 'available', {
        'opencode.task.available': false,
      });
      return expectError(plan({
        run,
        work: fixtureWork({ stage: 'code-review' }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities: changed,
        routeState: outage,
      }), 'EXPIRED_PLAN');
    });
    check('capability refresh preserves outage and retry history', () => {
      const outage = fixtureRouteState(run, capabilities, 'outage');
      const changed = fixtureCapabilities(run, 'available', {
        'opencode.task.available': false,
      });
      const refreshed = refreshRouteState({
        run,
        routeState: outage,
        previousCapabilities: capabilities,
        capabilities: changed,
      });
      const replanned = refreshed.ok
        ? plan({
          run,
          work: fixtureWork({ stage: 'code-review' }),
          laneProof: fixtureLaneProof('full', 'final'),
          capabilities: changed,
          routeState: refreshed.value,
        })
        : refreshed;
      return refreshed.ok
        && refreshed.value.status === 'outage'
        && refreshed.value.consecutiveFailures === outage.consecutiveFailures
        && refreshed.value.sequence === outage.sequence + 1
        && refreshed.value.capabilityFingerprint === changed.fingerprint
        && refreshed.value.lastTransition?.source === 'capability-refresh'
        && refreshed.value.lastTransition?.event === 'capability-refreshed'
        && refreshed.value.lastTransition?.previousCapabilityFingerprint
          === capabilities.fingerprint
        && replanned.ok
        && replanned.value.routeState.status === 'outage'
        && replanned.value.capabilityFingerprint === changed.fingerprint;
    });
    check('initial healthy route state needs no caller-computed capability hash', () => {
      const initialized = initializeRouteState({ run, capabilities });
      if (!initialized.ok) return false;
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: initialized.value,
      });
      return result.ok
        && result.value.routeState.capabilityFingerprint ===
          fixtureCapabilityFingerprint(capabilities)
        && result.value.routeState.kind === 'autoloop-route-state'
        && result.value.routeState.runInstanceFingerprint ===
          run.instanceFingerprint;
    });
    check('small round-one review requires final proof', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'code-review', round: 1 }),
        laneProof: fixtureLaneProof('small', 'planned'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.actualRoute === 'claude.codex-exec'
        && result.value.laneProof.status === 'promoted';
    });
    check('implementation cannot narrow from a final proof', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        laneProof: fixtureLaneProof('docs', 'final'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.reasonCodes.includes(
          'PROOF_MODE_MISMATCH',
        );
    });
    check('plan review cannot narrow from a final proof', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'plan-review' }),
        laneProof: fixtureLaneProof('docs', 'final'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.reasonCodes.includes(
          'PROOF_MODE_MISMATCH',
        );
    });
    check('full code review proof still must be final', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'code-review' }),
        laneProof: fixtureLaneProof('full', 'planned'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.reasonCodes.includes(
          'PROOF_MODE_MISMATCH',
        );
    });
    check('judgment review requires a final head-bound proof', () => {
      const result = plan({
        run,
        work: fixtureWork({
          stage: 'judgment-review',
          headOid: HEAD_OID,
        }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.laneProof.status === 'verified'
        && result.value.artifactSubject.kind === 'head'
        && result.value.artifactSubject.headOid === HEAD_OID;
    });
    check('planned judgment proof is rejected as a mode mismatch', () => {
      const result = plan({
        run,
        work: fixtureWork({
          stage: 'judgment-review',
          headOid: HEAD_OID,
        }),
        laneProof: fixtureLaneProof('full', 'planned'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.laneProof.reasonCodes.includes(
          'PROOF_MODE_MISMATCH',
        );
    });
    check('code review requires an explicit reviewed head', () => {
      const work = fixtureWork({ stage: 'code-review' });
      const { headOid, ...artifact } = work.artifact;
      return expectError(plan({
        run,
        work: { ...work, artifact },
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: healthy,
      }), 'INVALID_INTENT');
    });
    check('missing lane proof fails closed to full', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        laneProof: undefined,
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.status === 'unverifiable';
    });
    check('omitted lane proof also fails closed to full', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.status === 'unverifiable';
    });
    check('stale lane proof fails closed to full', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        laneProof: fixtureLaneProof('docs', 'planned', OTHER_OID),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.reasonCodes.includes('STALE_LANE_PROOF');
    });
    check('planned proof is bound to the exact artifact identity', () => {
      const result = plan({
        run,
        work: fixtureWork({
          stage: 'implementation',
          artifactVersion: 2,
        }),
        laneProof: fixtureLaneProof('docs', 'planned'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.reasonCodes.includes('STALE_LANE_PROOF');
    });
    check('final proof is bound to the exact reviewed head', () => {
      const work = fixtureWork({
        stage: 'code-review',
        headOid: OTHER_HEAD_OID,
      });
      const headCapabilities = fixtureCapabilities(
        run,
        'available',
        {},
        work.checkout,
      );
      const result = plan({
        run,
        work,
        laneProof: fixtureLaneProof('docs', 'final'),
        capabilities: headCapabilities,
        routeState: fixtureRouteState(run, headCapabilities),
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.reasonCodes.includes('STALE_LANE_PROOF');
    });
    check('tampered lane proof cannot retain its old fingerprint authority', () => {
      const proof = fixtureLaneProof('full');
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        laneProof: { ...proof, lane: 'docs' },
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.laneProof.status === 'unverifiable';
    });
    check('lane proof exposes replay validation without cryptographic authority', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        laneProof: fixtureLaneProof('full', 'planned'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.laneProof.authority === 'structural-replay-only';
    });
    check('caller-authored lane is rejected', () =>
      expectError(plan({
        run,
        work: { ...fixtureWork(), lane: 'docs' },
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: healthy,
      }), 'INVALID_INTENT'));
    check('pitcrew revision lane is unconditionally full', () => {
      const result = plan({
        run,
        work: fixtureWork({ flow: 'pitcrew', stage: 'implementation' }),
        laneProof: fixtureLaneProof('docs'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.effectiveLane === 'full'
        && result.value.actualRoute === 'claude.codex-exec';
    });
    check('Dev may share its run with Pitcrew but standalone Pitcrew cannot become Dev', () => {
      const shared = plan({
        run,
        work: fixtureWork({ flow: 'pitcrew', stage: 'implementation' }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: healthy,
      });
      const standalone = openRun('claude', 'codex', { flow: 'pitcrew' });
      if (!standalone.ok) return false;
      return shared.ok
        && expectError(plan({
          run: standalone.value,
          work: fixtureWork({ flow: 'dev', stage: 'implementation' }),
          laneProof: fixtureLaneProof('full'),
          capabilities,
          routeState: fixtureRouteState(standalone.value, capabilities),
        }), 'INVALID_INTENT');
    });
    check('plan review can dispatch only once', () =>
      expectError(plan({
        run,
        work: fixtureWork({ stage: 'plan-review', round: 2 }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: healthy,
      }), 'INVALID_INTENT')
      && expectError(plan({
        run,
        work: fixtureWork({
          stage: 'plan-review',
          round: 1,
          planReviewDispatches: 1,
        }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: healthy,
      }), 'INVALID_INTENT'));
    check('round one reviews the full artifact', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'code-review', round: 1 }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: healthy,
      });
      return result.ok && result.value.reviewScope === 'full-artifact';
    });
    check('round two reviews delta and rebuttals natively', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'code-review', round: 2 }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: healthy,
      });
      return result.ok
        && result.value.reviewScope === 'fix-delta-and-open-rebuttals'
        && result.value.actualRoute === 'claude.native';
    });
    check('round three preserves closed history and open rebuttal state', () => {
      const openRebuttals = [{
        findingId: 'F-2',
        claim: 'The behavior is required by the sealed contract.',
        evidence: 'Inspect the exact patch and bounded evidence.',
      }];
      const result = plan({
        run,
        work: fixtureWork({
          stage: 'code-review',
          round: 3,
          openRebuttals,
          priorFindings: [{
            findingId: 'F-1',
            severity: 'Major',
            summary: 'The first finding remains in cumulative history.',
            evidence: 'Authenticated round-one evidence.',
            disposition: 'fix',
            state: 'closed',
            rationale: 'The round-two verdict did not repeat the finding.',
          }, {
            findingId: 'F-2',
            severity: 'Critical',
            summary: 'The second finding remains actionable.',
            evidence: 'Authenticated round-two evidence.',
            disposition: 'rebut',
            state: 'open',
            rationale: 'The author supplied a bounded rebuttal.',
          }],
        }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: healthy,
      });
      if (!result.ok) return false;
      const attempt = compileRouteAttempt(result.value);
      if (!attempt.ok) return false;
      const source = JSON.parse(attempt.value.prompt).artifactSource;
      return source.priorFindings.length === 2
        && source.priorFindings[0].state === 'closed'
        && source.priorFindings[1].state === 'open'
        && source.openRebuttals.length === 1
        && source.openRebuttals[0].findingId === 'F-2';
    });
    check('judgment review is bounded native and not a recovery probe', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'judgment-review' }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: fixtureRouteState(run, capabilities, 'outage'),
      });
      return result.ok
        && result.value.actualRoute === 'claude.native'
        && result.value.reviewScope === 'in-flight-decision'
        && result.value.maxAttempts === 1
        && result.value.recoveryProbe === false;
    });
    check('author reviewer collision is typed', () =>
      expectError(plan({
        run,
        work: fixtureWork({
          stage: 'code-review',
          reviewerIdentity: 'author-1',
        }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: healthy,
      }), 'AUTHOR_REVIEWER_COLLISION'));
    check('writers are serialized', () =>
      expectError(plan({
        run,
        work: fixtureWork({
          stage: 'implementation',
          concurrency: {
            activeWriters: 1,
            stagedAhead: 0,
            stagedAheadReadOnly: true,
          },
        }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: healthy,
      }), 'UNSAFE_CONCURRENCY'));
    check('overlap is at most depth one and read only', () =>
      expectError(plan({
        run,
        work: fixtureWork({
          stage: 'plan-review',
          concurrency: {
            activeWriters: 1,
            stagedAhead: 2,
            stagedAheadReadOnly: true,
          },
        }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: healthy,
      }), 'UNSAFE_CONCURRENCY')
      && expectError(plan({
        run,
        work: fixtureWork({
          stage: 'plan-review',
          concurrency: {
            activeWriters: 1,
            stagedAhead: 1,
            stagedAheadReadOnly: false,
          },
        }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: healthy,
      }), 'UNVERIFIABLE_ISOLATION'));

    check('real review checkout seals an exact patch without caller transport', () => {
      const fixture = fixtureLiveReviewWork();
      try {
        const liveCapabilities = fixtureCapabilities(
          run,
          'available',
          {},
          fixture.work.checkout,
        );
        const livePlan = plan({
          run,
          work: fixture.work,
          laneProof: fixtureLaneProof('full', 'final'),
          capabilities: liveCapabilities,
          routeState: fixtureRouteState(run, liveCapabilities),
        });
        if (!livePlan.ok) return false;
        const attempt = compileRouteAttempt(livePlan.value);
        if (!attempt.ok) return false;
        const prompt = JSON.parse(attempt.value.prompt);
        return fixture.work.artifact.source.sealedDiff === undefined
          && prompt.artifactSource.sealedDiff.content
            === fixture.expectedPatch
          && prompt.artifactSource.sealedDiff.sha256
            === createHash('sha256')
              .update(fixture.expectedPatch)
              .digest('hex');
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    const primaryWork = fixtureWork({ stage: 'code-review' });
    const primaryPlan = plan({
      run,
      work: primaryWork,
      laneProof: fixtureLaneProof('full', 'final'),
      capabilities,
      routeState: healthy,
    });
    if (primaryPlan.ok) {
      check('Runtime seals the exact Git patch before route compilation', () => {
        const attempt = compileRouteAttempt(primaryPlan.value);
        if (!attempt.ok) return false;
        const prompt = JSON.parse(attempt.value.prompt);
        return primaryWork.artifact.source.sealedDiff === undefined
          && primaryPlan.value.artifactSource.sealedDiff.kind
            === 'sealed-git-diff'
          && primaryPlan.value.artifactSource.sealedDiff.baseOid
            === primaryWork.artifact.source.deltaBaseOid
          && primaryPlan.value.artifactSource.sealedDiff.headOid
            === primaryWork.artifact.headOid
          && prompt.artifactSource.sealedDiff.content
            === primaryPlan.value.artifactSource.sealedDiff.content;
      });
      check('caller-forged sealed Git patches fail despite recomputed public hashes', () => {
        const content = 'diff --git a/forged.txt b/forged.txt\n';
        const artifactSource = {
          ...primaryPlan.value.artifactSource,
          sealedDiff: {
            ...primaryPlan.value.artifactSource.sealedDiff,
            bytes: Buffer.byteLength(content),
            lines: 2,
            sha256: createHash('sha256').update(content).digest('hex'),
            content,
          },
        };
        return expectError(plan({
          run,
          work: fixtureWork({
            stage: 'code-review',
            artifactSource,
          }),
          laneProof: fixtureLaneProof('full', 'final'),
          capabilities,
          routeState: healthy,
        }), 'INVALID_INTENT');
      });
      check('runtime outcome crosses the compiled five-route adapter boundary', () => {
        const attempt = compileRouteAttempt(primaryPlan.value);
        const outcome = fixtureOutcome(primaryPlan.value);
        return attempt.ok
          && outcome.kind === 'autoloop-route-attempt-outcome'
          && outcome.attemptFingerprint === attempt.value.fingerprint
          && validateRouteAttemptOutcome(outcome, primaryPlan.value);
      });
      check('dispatch plan binds generation and complete run instance', () =>
        primaryPlan.value.generation === run.generation
        && primaryPlan.value.hostEvidenceFingerprint ===
          run.hostEvidenceFingerprint
        && primaryPlan.value.runInstanceFingerprint ===
          run.instanceFingerprint
        && primaryPlan.value.configFingerprint === run.configFingerprint);
      check('generation-zero plan expires under generation one', () =>
        expectError(observe({
          run: { ...run, generation: 1 },
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value),
        }), 'EXPIRED_PLAN'));
      check('plan expires when live-host evidence changes within one intent', () =>
        expectError(observe({
          run: {
            ...run,
            hostEvidenceFingerprint: '9'.repeat(64),
          },
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value),
        }), 'EXPIRED_PLAN'));
      check('successful observation produces the final receipt', () => {
        const result = observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value),
        });
        return result.ok
          && result.value.kind === 'complete'
          && result.value.receipt.attemptCount === 1
          && result.value.receipt.activeHost === 'claude'
          && result.value.receipt.selector === 'codex'
          && result.value.receipt.requestedEngine === 'codex'
          && result.value.receipt.requestedRoute === 'claude.codex-exec'
          && result.value.receipt.actualRoute === 'claude.codex-exec'
          && result.value.receipt.adapter === 'claude.codex-exec'
          && result.value.receipt.configFingerprint === run.configFingerprint
          && result.value.receipt.configuredBaseOid === OID
          && result.value.receipt.artifactSubject.kind === 'head'
          && result.value.receipt.artifactSubject.headOid === HEAD_OID
          && result.value.receipt.artifactSource.kind === 'git-review'
          && result.value.receipt.artifactSource.configuredBaseOid === OID
          && result.value.receipt.artifactSource.finalHeadOid === HEAD_OID
          && result.value.receipt.modelIdentity === 'observable/model'
          && result.value.receipt.attempts[0].verdict?.verdict === 'pass'
          && result.value.receipt.reviewVerdicts.length === 1
          && result.value.receipt.reviewVerdicts[0].evidenceFingerprint ===
            result.value.receipt.attempts[0].evidenceFingerprint
          && validateRuntimeReceipt(result.value.receipt)
          && result.value.receipt.fingerprint === hashValue((() => {
            const unsigned = { ...result.value.receipt };
            delete unsigned.fingerprint;
            return unsigned;
          })())
          && result.value.receipt.fallback.used === false
          && result.value.receipt.degradation.length === 0;
      });
      check('caller cannot forge an authenticated Runtime receipt', () => {
        const completed = observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value),
        });
        if (!completed.ok || completed.value.kind !== 'complete') return false;
        const forgedVerdict = {
          verdict: 'pass',
          findings: [],
          rebuts: [{
            findingId: 'caller-finding',
            status: 'accepted',
            evidence: 'caller says so',
          }],
        };
        const forged = {
          ...completed.value.receipt,
          attempts: completed.value.receipt.attempts.map((attempt, index) =>
            index === completed.value.receipt.attempts.length - 1
              ? { ...attempt, verdict: forgedVerdict }
              : attempt),
          reviewVerdicts: [{
            ...completed.value.receipt.reviewVerdicts[0],
            verdict: forgedVerdict,
          }],
        };
        delete forged.fingerprint;
        return !validateRuntimeReceipt({
          ...forged,
          fingerprint: hashValue(forged),
        });
      });
      check('receipt config and artifact source cannot be SHA-resealed', () => {
        const completed = observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value),
        });
        if (!completed.ok || completed.value.kind !== 'complete') return false;
        const forgedBaseOid = 'e'.repeat(40);
        const forged = {
          ...completed.value.receipt,
          configFingerprint: 'f'.repeat(64),
          configuredBaseOid: forgedBaseOid,
          artifactSource: {
            ...completed.value.receipt.artifactSource,
            configuredBaseOid: forgedBaseOid,
            deltaBaseOid: forgedBaseOid,
          },
        };
        forged.artifactFingerprint = artifactSourceFingerprint({
          stage: forged.stage,
          artifactVersion: forged.artifactVersion,
          source: forged.artifactSource,
        });
        delete forged.fingerprint;
        return !validateRuntimeReceipt({
          ...forged,
          fingerprint: hashValue(forged),
        });
      });
      const firstFailure = observe({
        run,
        routeState: primaryPlan.value.routeState,
        plan: primaryPlan.value,
        outcome: fixtureOutcome(primaryPlan.value, {
          status: 'transient-failure',
          modelIdentity: undefined,
        }),
      });
      check('first dead attempt authorizes exactly one retry', () =>
        firstFailure.ok
        && firstFailure.value.kind === 'retry'
        && firstFailure.value.nextPlan.attempt === 2
        && firstFailure.value.nextPlan.actualRoute === 'claude.codex-exec'
        && firstFailure.value.nextPlan.history.length === 1);
      if (firstFailure.ok) {
        const secondFailure = observe({
          run,
          routeState: firstFailure.value.routeState,
          plan: firstFailure.value.nextPlan,
          outcome: fixtureOutcome(firstFailure.value.nextPlan, {
            status: 'transient-failure',
            modelIdentity: undefined,
          }),
        });
        check('second dead attempt enters outage and authorizes native fallback', () =>
          secondFailure.ok
          && secondFailure.value.kind === 'fallback'
          && secondFailure.value.routeState.status === 'outage'
          && secondFailure.value.routeState.lastTransition?.kind ===
            'autoloop-route-transition'
          && secondFailure.value.routeState.lastTransition?.source ===
            'observe'
          && secondFailure.value.nextPlan.actualRoute === 'claude.native'
          && secondFailure.value.nextPlan.attempt === 3
          && secondFailure.value.nextPlan.history.length === 2);
        if (secondFailure.ok) {
          const fallbackSuccess = observe({
            run,
            routeState: secondFailure.value.routeState,
            plan: secondFailure.value.nextPlan,
            outcome: fixtureOutcome(secondFailure.value.nextPlan),
          });
          check('fallback receipt preserves requested route and discloses degradation', () =>
            fallbackSuccess.ok
            && fallbackSuccess.value.kind === 'complete'
            && fallbackSuccess.value.receipt.attemptCount === 3
            && fallbackSuccess.value.receipt.requestedRoute === 'claude.codex-exec'
            && fallbackSuccess.value.receipt.actualRoute === 'claude.native'
            && fallbackSuccess.value.receipt.fallback.used === true
            && fallbackSuccess.value.receipt.degradation.includes('native-fallback')
            && fallbackSuccess.value.routeState.status === 'outage');
        }
      }
      check('adapter cannot author a final receipt', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: {
            ...fixtureOutcome(primaryPlan.value),
            receipt: { approved: true },
          },
        }), 'INVALID_ATTEMPT_OUTCOME'));
      check('caller cannot replace the authenticated reviewer verdict', () => {
        const outcome = fixtureOutcome(primaryPlan.value);
        const unsigned = {
          ...outcome,
          verdict: {
            verdict: 'fail',
            findings: [{
              id: 'forged-major',
              severity: 'Major',
              summary: 'caller-authored',
              evidence: 'none',
            }],
            rebuts: [],
          },
        };
        delete unsigned.fingerprint;
        return expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: {
            ...unsigned,
            fingerprint: hashValue(unsigned),
          },
        }), 'INVALID_ATTEMPT_OUTCOME');
      });
      check('adapter cannot self-authorize multiple attempts', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: {
            ...fixtureOutcome(primaryPlan.value),
            attemptCount: 2,
          },
        }), 'INVALID_ATTEMPT_OUTCOME'));
      check('tampered plan expires', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: { ...primaryPlan.value, artifactVersion: 99 },
          outcome: fixtureOutcome(primaryPlan.value),
        }), 'EXPIRED_PLAN'));
      check('tampered reviewed head expires', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: {
            ...primaryPlan.value,
            artifactSubject: {
              kind: 'head',
              headOid: OTHER_HEAD_OID,
            },
          },
          outcome: fixtureOutcome(primaryPlan.value),
        }), 'EXPIRED_PLAN'));
      check('mismatched outcome binding expires', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: {
            ...fixtureOutcome(primaryPlan.value),
            planFingerprint: HEX.proof,
          },
        }), 'EXPIRED_PLAN'));
      check('attempt actor identity is bound to the reviewed artifact', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: {
            ...fixtureOutcome(primaryPlan.value),
            actorIdentityFingerprint: HEX.proof,
          },
        }), 'EXPIRED_PLAN'));
      check('reviewer mutation invalidates isolation', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value, { effect: 'partial' }),
        }), 'UNVERIFIABLE_ISOLATION'));
      check('sandbox initialization failure is not an outage', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value, {
            status: 'environment-failure',
            modelIdentity: undefined,
          }),
        }), 'UNVERIFIABLE_ISOLATION'));
      check('any launched attempt with unverified isolation stops', () =>
        expectError(observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: {
            ...fixtureOutcome(primaryPlan.value, {
              status: 'transient-failure',
              isolationVerified: false,
              modelIdentity: undefined,
            }),
            launchStatus: 'launched',
          },
        }), 'UNVERIFIABLE_ISOLATION'));
      check('typed no-launch pre-execution failure may retry without outage evidence', () => {
        const result = observe({
          run,
          routeState: primaryPlan.value.routeState,
          plan: primaryPlan.value,
          outcome: fixtureOutcome(primaryPlan.value, {
            status: 'environment-failure',
            isolationVerified: false,
            launchStatus: 'not-launched',
            modelIdentity: undefined,
          }),
        });
        return result.ok
          && result.value.kind === 'retry'
          && result.value.routeState.consecutiveFailures === 0;
      });
    }

    const writerPlan = plan({
      run,
      work: fixtureWork({ stage: 'implementation' }),
      laneProof: fixtureLaneProof('full'),
      capabilities,
      routeState: healthy,
    });
    if (writerPlan.ok) {
      check('partial writer is never blindly retried', () =>
        expectError(observe({
          run,
          routeState: writerPlan.value.routeState,
          plan: writerPlan.value,
          outcome: fixtureOutcome(writerPlan.value, {
            status: 'transient-failure',
            effect: 'partial',
            modelIdentity: undefined,
          }),
        }), 'PARTIAL_WRITER_RESULT')
        && expectError(observe({
          run,
          routeState: writerPlan.value.routeState,
          plan: writerPlan.value,
          outcome: fixtureOutcome(writerPlan.value, {
            status: 'transient-failure',
            effect: 'unknown',
            modelIdentity: undefined,
          }),
        }), 'PARTIAL_WRITER_RESULT')
        && expectError(observe({
          run,
          routeState: writerPlan.value.routeState,
          plan: writerPlan.value,
          outcome: fixtureOutcome(writerPlan.value, {
            status: 'environment-failure',
            effect: 'partial',
            modelIdentity: undefined,
          }),
        }), 'PARTIAL_WRITER_RESULT'));
    }

    const outageReview = plan({
      run,
      work: fixtureWork({ stage: 'code-review' }),
      laneProof: fixtureLaneProof('full', 'final'),
      capabilities,
      routeState: fixtureRouteState(run, capabilities, 'outage'),
    });
    if (outageReview.ok) {
      check('successful recovery probe clears outage', () => {
        const result = observe({
          run,
          routeState: outageReview.value.routeState,
          plan: outageReview.value,
          outcome: fixtureOutcome(outageReview.value),
        });
        return result.ok
          && result.value.kind === 'complete'
          && result.value.routeState.status === 'healthy'
          && result.value.receipt.outageTransition === 'recovered';
      });
      check('failed recovery probe falls back without a retry', () => {
        const result = observe({
          run,
          routeState: outageReview.value.routeState,
          plan: outageReview.value,
          outcome: fixtureOutcome(outageReview.value, {
            status: 'transient-failure',
            modelIdentity: undefined,
          }),
        });
        return result.ok
          && result.value.kind === 'fallback'
          && result.value.nextPlan.attempt === 2
          && result.value.nextPlan.actualRoute === 'claude.native';
      });
    }
  }

  const nativeCodex = openRun('codex', 'native');
  if (nativeCodex.ok) {
    const degradedFacts = {
      'codex.exec.available': false,
      'codex.exec.read-only': false,
      'codex.exec.network-denied': false,
    };
    check('native Codex review selects attested degraded fallback only when primary is unavailable', () => {
      const capabilities = fixtureCapabilities(
        nativeCodex.value,
        'available',
        degradedFacts,
      );
      const result = plan({
        run: nativeCodex.value,
        work: fixtureWork({ stage: 'code-review' }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: fixtureRouteState(nativeCodex.value, capabilities),
      });
      return result.ok
        && result.value.actualRoute === 'codex.native'
        && result.value.execution === 'codex.in-session-reviewer'
        && result.value.fallbackUsed === true
        && result.value.degradation.includes('degraded-native-codex-review');
    });
    check('healthy native Codex external review ignores unused degraded-spawn failures', () => {
      const capabilities = fixtureCapabilities(nativeCodex.value, 'available', {
        'codex.spawn.available': false,
        'codex.spawn.agent-type': false,
        'codex.spawn.fork-turns-none': false,
        'codex.spawn.effective-read-only': false,
        'codex.spawn.integrity': false,
      });
      const result = plan({
        run: nativeCodex.value,
        work: fixtureWork({ stage: 'code-review' }),
        laneProof: fixtureLaneProof('full', 'final'),
        capabilities,
        routeState: fixtureRouteState(nativeCodex.value, capabilities),
      });
      return result.ok
        && result.value.execution === 'codex.exec-read-only'
        && result.value.degradation.length === 0;
    });
  }

  const finishRun = open({
    invocation: '/autoloop:dev; auto-continue',
    hostEvidence: fixtureHostEvidence('opencode'),
    config: fixtureConfig(),
  });
  if (finishRun.ok) {
    check('queue exhaustion requires complete absence evidence', () =>
      expectError(finish({
        run: finishRun.value,
        progress: {
          reason: 'queue-exhausted',
          eligibleRemaining: 0,
          unitsCompleted: 2,
          queueComplete: false,
        },
      }), 'INCOMPLETE_PROGRESS'));
    check('queue exhaustion rejects eligible work', () =>
      expectError(finish({
        run: finishRun.value,
        progress: {
          reason: 'queue-exhausted',
          eligibleRemaining: 1,
          unitsCompleted: 2,
          queueComplete: true,
        },
      }), 'INVALID_STOP'));
    check('complete empty queue stops', () => {
      const result = finish({
        run: finishRun.value,
        progress: {
          reason: 'queue-exhausted',
          eligibleRemaining: 0,
          unitsCompleted: 2,
          queueComplete: true,
        },
      });
      return result.ok
        && result.value.action === 'stop'
        && result.value.reason === 'queue-exhausted';
    });
    check('retired wall-clock stop reason is rejected', () =>
      expectError(finish({
        run: finishRun.value,
        progress: {
          reason: 'wall-clock-cap',
          eligibleRemaining: 1,
          unitsCompleted: 1,
          queueComplete: true,
        },
      }), 'INVALID_STOP'));
    check('no progress means no relaunch', () => {
      const result = finish({
        run: finishRun.value,
        progress: {
          reason: 'context-budget',
          eligibleRemaining: 1,
          unitsCompleted: 0,
          queueComplete: true,
        },
      });
      return result.ok && result.value.action === 'stop';
    });
    const {
      authorization: _authorization,
      ...finishRunUnsigned
    } = finishRun.value;
    const cappedBase = {
      ...finishRunUnsigned,
      generation: MAX_RELAUNCH_GENERATIONS,
    };
    const cappedUnsigned = {
      ...cappedBase,
      instanceFingerprint: runInstanceFingerprint(cappedBase),
    };
    const capped = {
      ...cappedUnsigned,
      authorization: authorizeValue(
        cappedUnsigned,
        cappedUnsigned.sessionFingerprint,
      ),
    };
    check('generation cap stops relaunch', () => {
      const result = finish({
        run: capped,
        progress: {
          reason: 'context-budget',
          eligibleRemaining: 1,
          unitsCompleted: 1,
          queueComplete: true,
        },
      });
      return result.ok
        && result.value.action === 'stop'
        && result.value.relaunchSuppressed === 'generation-cap';
    });
  }

  const boundedRun = open({
    invocation: '/autoloop:dev maxUnits: 2',
    hostEvidence: fixtureHostEvidence('claude'),
    config: fixtureConfig(),
  });
  if (boundedRun.ok) {
    check('bounded stop requires the bound to be reached', () =>
      expectError(finish({
        run: boundedRun.value,
        progress: {
          reason: 'invocation-bound-reached',
          eligibleRemaining: 1,
          unitsCompleted: 1,
          queueComplete: true,
        },
      }), 'INVALID_STOP'));
    check('bounded stop succeeds at the bound', () => {
      const result = finish({
        run: boundedRun.value,
        progress: {
          reason: 'invocation-bound-reached',
          eligibleRemaining: 1,
          unitsCompleted: 2,
          queueComplete: true,
        },
      });
      return result.ok
        && result.value.action === 'stop'
        && result.value.reason === 'invocation-bound-reached';
    });
  }

  check('outputs never echo invocation or config secrets', () => {
    const secret = 'TOP_SECRET_4f5d';
    const result = open({
      invocation: `/autoloop:dev ${secret}`,
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig({
        adapterOptions: {
          'claude.codex-exec': { reviewerModel: secret },
        },
      }),
    });
    return result.ok && !JSON.stringify(result).includes(secret);
  });
  check('all errors are serializable and use the closed vocabulary', () => {
    const result = finish({ run: null, progress: null });
    return result.ok === false
      && ERROR_CODES.includes(result.error.code)
      && JSON.parse(JSON.stringify(result)).error.code === result.error.code;
  });
  check('non-serializable and hostile boundary values return typed failures', () => {
    const cyclic = fixtureConfig();
    cyclic.self = cyclic;
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('hostile ownKeys');
      },
    });
    const cyclicResult = open({
      invocation: '/autoloop:dev',
      hostEvidence: fixtureHostEvidence('claude'),
      config: cyclic,
    });
    const hostileResult = plan(hostile);
    return cyclicResult.ok === false
      && ERROR_CODES.includes(cyclicResult.error.code)
      && hostileResult.ok === false
      && ERROR_CODES.includes(hostileResult.error.code);
  });

  const total = passed + failed;
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
  }
  console.log(
    failed === 0
      ? `self-test OK (${total} checks)`
      : `self-test FAILED (${passed}/${total} checks; ${failed} failed)`,
  );
  return failed === 0;
}

const isMain =
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') {
    process.exit(selfTest() ? 0 : 1);
  }
  console.error('usage: runtime-contract.mjs --self-test');
  process.exit(2);
}
