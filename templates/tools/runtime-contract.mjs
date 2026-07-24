#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  classifyLaneProof,
  verifyLaneProof,
} from './lane-contract.mjs';

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
  'wall-clock-cap',
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
  'expectedGeneration',
];
const HOST_EVIDENCE_KEYS = [
  'kind',
  'version',
  'source',
  'observedHosts',
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
const RUN_KEYS = [
  'version',
  'configVersion',
  'invocationFlow',
  'originHost',
  'activeHost',
  'hostEvidenceFingerprint',
  'selector',
  'requestedEngine',
  'requestedRoute',
  'scope',
  'generation',
  'runIntentHash',
];
const WORK_KEYS = [
  'flow',
  'stage',
  'round',
  'planReviewDispatches',
  'configuredBaseOid',
  'artifact',
  'concurrency',
];
const CONCURRENCY_KEYS = [
  'activeWriters',
  'stagedAhead',
  'stagedAheadReadOnly',
];
const ROUTE_STATE_KEYS = [
  'status',
  'requestedRoute',
  'consecutiveFailures',
  'capabilityFingerprint',
];
const PLAN_KEYS = [
  'version',
  'runIntentHash',
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
  'planReviewDispatches',
  'role',
  'reviewScope',
  'effectiveLane',
  'laneProof',
  'laneProofFingerprint',
  'artifactSubject',
  'artifactVersion',
  'artifactFingerprint',
  'artifactAuthorFingerprint',
  'actorIdentityFingerprint',
  'capabilityFingerprint',
  'evaluatedCapabilities',
  'requirements',
  'isolation',
  'recoveryProbe',
  'fallbackUsed',
  'fallback',
  'degradation',
  'outageTransition',
  'attempt',
  'maxAttempts',
  'history',
  'routeState',
  'fingerprint',
];
const PROGRESS_KEYS = [
  'reason',
  'eligibleRemaining',
  'unitsCompleted',
  'queueComplete',
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
  const unknownSuffix = invocation.match(
    /\bwith\s+([a-z][a-z0-9-]*)\s*[.!?;]*\s*$/i,
  );
  if (
    unknownSuffix
    && !HOSTS.includes(unknownSuffix[1].toLowerCase())
  ) {
    return invalidIntent('invocation carries an unknown engine selector');
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

function validateHostEvidence(evidence) {
  if (!hasExactKeys(evidence, HOST_EVIDENCE_KEYS)) {
    return failure(
      'UNKNOWN_ACTIVE_HOST',
      'active host requires exact live-integration evidence',
    );
  }
  if (
    evidence.kind !== 'autoloop-host-evidence'
    || evidence.version !== 1
    || evidence.source !== 'live-integration'
    || !HEX_64.test(evidence.fingerprint)
    || !Array.isArray(evidence.observedHosts)
  ) {
    return failure(
      'UNKNOWN_ACTIVE_HOST',
      'active host evidence is not a valid live attestation',
    );
  }
  if (evidence.observedHosts.length > 1) {
    return failure(
      'AMBIGUOUS_ACTIVE_HOST',
      'live integration attested more than one active host',
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
  });
}

function validateConfigInput(config) {
  if (
    !isPlainObject(config)
    || !isJsonSerializable(config)
    || config.version !== CONFIG_VERSION
  ) {
    return migrateConfigFailure();
  }
  if (FORBIDDEN_CONFIG_KEYS.some((key) => Object.hasOwn(config, key))) {
    return migrateConfigFailure();
  }
  return success(true);
}

function validateEnvelope(envelope, expectedGeneration, activeHost, parsed) {
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
  if (
    !Number.isSafeInteger(expectedGeneration)
    || expectedGeneration < 1
    || expectedGeneration > MAX_RELAUNCH_GENERATIONS
    || expectedGeneration !== envelope.generation
  ) {
    return failure(
      'INVALID_RELAUNCH',
      'relaunch generation is missing, stale, replayed, or ahead',
    );
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
  if (input.continuation === undefined && input.expectedGeneration !== undefined) {
    return failure(
      'INVALID_RELAUNCH',
      'expectedGeneration is valid only with a continuation envelope',
    );
  }
  let selector = parsed.value.selector;
  let scope = parsed.value.scope;
  let generation = 0;
  let originHost = host.value.activeHost;
  let invocationFlow = parsed.value.invocationFlow;
  let runIntentHash;
  if (input.continuation !== undefined) {
    const envelope = validateEnvelope(
      input.continuation,
      input.expectedGeneration,
      host.value.activeHost,
      parsed.value,
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
  return success({
    version: RUNTIME_CONTRACT_VERSION,
    configVersion: CONFIG_VERSION,
    invocationFlow,
    originHost,
    activeHost: host.value.activeHost,
    hostEvidenceFingerprint: host.value.fingerprint,
    selector,
    requestedEngine,
    requestedRoute,
    scope,
    generation,
    runIntentHash,
  });
}

function validateRun(run) {
  if (!hasExactKeys(run, RUN_KEYS)) return false;
  if (
    run.version !== RUNTIME_CONTRACT_VERSION
    || run.configVersion !== CONFIG_VERSION
    || !FLOWS.includes(run.invocationFlow)
    || !HOSTS.includes(run.originHost)
    || run.activeHost !== run.originHost
    || !HOSTS.includes(run.activeHost)
    || !HEX_64.test(run.hostEvidenceFingerprint)
    || !SELECTORS.includes(run.selector)
    || !HOSTS.includes(run.requestedEngine)
    || !Object.hasOwn(ROUTE_CATALOG, run.requestedRoute)
    || !validateScope(run.scope)
    || !Number.isSafeInteger(run.generation)
    || run.generation < 0
    || run.generation > MAX_RELAUNCH_GENERATIONS
    || !HEX_64.test(run.runIntentHash)
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
    );
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
    ['kind', 'version', 'fingerprint', 'authorIdentity'],
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
  if (work.stage === 'code-review' && work.artifact.headOid === undefined) {
    return invalidIntent('code review requires the reviewed head OID');
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
  return work.stage === 'code-review'
    ? finalArtifactSubject(work)
    : plannedArtifactSubject(work);
}

function validArtifactSubject(subject, planValue) {
  if (planValue.stage === 'code-review') {
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
  if (
    work.stage === 'code-review'
    && work.round === 1
    && lane !== 'full'
    && proof.mode !== 'final'
  ) {
    lane = 'full';
    status = 'promoted';
    reasonCodes.push('FINAL_PROOF_REQUIRED');
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
    reasonCodes,
  };
}

function validateCapabilities(capabilities) {
  if (
    !hasExactKeys(capabilities, ['version', 'facts'])
    || capabilities.version !== 1
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
    fingerprint: hashValue(capabilities),
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

function validateRouteState(routeState, run, capabilityFingerprint) {
  if (!hasExactKeys(routeState, ROUTE_STATE_KEYS)) {
    return invalidIntent('route state has an invalid shape');
  }
  if (
    !['healthy', 'outage'].includes(routeState.status)
    || routeState.requestedRoute !== run.requestedRoute
    || !Number.isSafeInteger(routeState.consecutiveFailures)
    || routeState.consecutiveFailures < 0
    || (
      routeState.capabilityFingerprint !== null
      && !HEX_64.test(routeState.capabilityFingerprint)
    )
  ) {
    return invalidIntent('route state is invalid for this run');
  }
  if (
    routeState.status === 'healthy'
    && routeState.consecutiveFailures > 1
  ) {
    return invalidIntent('healthy route state exceeds the retry bound');
  }
  if (
    routeState.status === 'outage'
    && (
      routeState.consecutiveFailures < 2
      || routeState.capabilityFingerprint === null
    )
  ) {
    return invalidIntent('outage route state lacks the bounded retry evidence');
  }
  if (routeState.capabilityFingerprint !== capabilityFingerprint) {
    return success({
      status: 'healthy',
      requestedRoute: run.requestedRoute,
      consecutiveFailures: 0,
      capabilityFingerprint,
    });
  }
  return success({ ...routeState });
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
  return deepFreeze({
    ...withoutFingerprint,
    fingerprint: hashValue(withoutFingerprint),
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

function validAttemptRecord(record, index, planValue, run) {
  if (!hasExactKeys(record, [
    'attempt',
    'route',
    'adapter',
    'execution',
    'status',
    'effect',
    'evidenceFingerprint',
    'actorIdentityFingerprint',
    'isolation',
    'modelIdentity',
  ])) {
    return false;
  }
  const postureValue = postureForExecution(
    record.route,
    planValue.role,
    record.execution,
  );
  return record.attempt === index + 1
    && Object.hasOwn(ROUTE_CATALOG, record.route)
    && ROUTE_CATALOG[record.route].activeHost === run.activeHost
    && record.adapter === record.route
    && postureValue !== null
    && ['transient-failure', 'invalid-result'].includes(record.status)
    && record.effect === 'none'
    && HEX_64.test(record.evidenceFingerprint)
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
    );
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
  const capability = validateCapabilities(input.capabilities);
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
  return success(makePlan({
    version: RUNTIME_CONTRACT_VERSION,
    runIntentHash: input.run.runIntentHash,
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
    reviewScope: reviewScopeFor(input.work.stage, input.work.round),
    effectiveLane: laneProof.lane,
    laneProof: {
      status: laneProof.status,
      reasonCodes: [...laneProof.reasonCodes],
    },
    laneProofFingerprint: laneProof.fingerprint,
    artifactSubject: dispatchArtifactSubject(input.work),
    artifactVersion: input.work.artifact.version,
    artifactFingerprint: input.work.artifact.fingerprint,
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
  const native = `${run.activeHost}.native`;
  const laneReasons = [
    'UNVERIFIABLE_LANE_PROOF',
    'STALE_LANE_PROOF',
    'FINAL_PROOF_REQUIRED',
    'PITCREW_FULL_LANE',
  ];
  const flowCompatible =
    (run.invocationFlow === 'dev'
      && ['dev', 'pitcrew'].includes(planValue.flow))
    || run.invocationFlow === planValue.flow;
  if (
    !HEX_64.test(planValue.fingerprint)
    || hashValue(withoutFingerprint) !== planValue.fingerprint
    || planValue.version !== RUNTIME_CONTRACT_VERSION
    || planValue.runIntentHash !== run.runIntentHash
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
    || hashValue(planValue.routeState) !== hashValue(routeState)
    || !hasExactKeys(planValue.routeState, ROUTE_STATE_KEYS)
    || planValue.routeState.requestedRoute !== run.requestedRoute
    || planValue.routeState.capabilityFingerprint
      !== planValue.capabilityFingerprint
    || !ROUTE_STATUSES.includes(planValue.routeState.status)
    || !Number.isSafeInteger(planValue.routeState.consecutiveFailures)
    || planValue.routeState.consecutiveFailures < 0
    || (
      planValue.routeState.status === 'healthy'
      && planValue.routeState.consecutiveFailures > 1
    )
    || (
      planValue.routeState.status === 'outage'
      && planValue.routeState.consecutiveFailures < 2
    )
    || !HEX_64.test(planValue.capabilityFingerprint)
    || !HEX_64.test(planValue.laneProofFingerprint)
    || !validArtifactSubject(planValue.artifactSubject, planValue)
    || !Number.isSafeInteger(planValue.artifactVersion)
    || planValue.artifactVersion < 1
    || !HEX_64.test(planValue.artifactFingerprint)
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
    || !hasExactKeys(planValue.laneProof, ['status', 'reasonCodes'])
    || !['verified', 'promoted', 'unverifiable'].includes(
      planValue.laneProof.status,
    )
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
  if (!hasExactKeys(
    outcome,
    [
      'version',
      'planFingerprint',
      'attempt',
      'route',
      'adapter',
      'status',
      'effect',
      'evidenceFingerprint',
      'actorIdentityFingerprint',
      'isolation',
    ],
    ['modelIdentity'],
  )) {
    return failure(
      'INVALID_ATTEMPT_OUTCOME',
      'adapter outcome must contain exactly one attempt of evidence',
    );
  }
  if (
    outcome.version !== 1
    || !ATTEMPT_STATUSES.includes(outcome.status)
    || !EFFECTS.includes(outcome.effect)
    || !HEX_64.test(outcome.evidenceFingerprint)
    || !HEX_64.test(outcome.actorIdentityFingerprint)
    || !hasExactKeys(
      outcome.isolation,
      ['mode', 'verified', 'fingerprint'],
    )
    || typeof outcome.isolation.mode !== 'string'
    || typeof outcome.isolation.verified !== 'boolean'
    || !HEX_64.test(outcome.isolation.fingerprint)
    || (
      Object.hasOwn(outcome, 'modelIdentity')
      && (
        typeof outcome.modelIdentity !== 'string'
        || !SAFE_IDENTITY.test(outcome.modelIdentity)
      )
    )
  ) {
    return failure(
      'INVALID_ATTEMPT_OUTCOME',
      'adapter outcome contains an invalid enum or evidence field',
    );
  }
  if (
    outcome.planFingerprint !== planValue.fingerprint
    || outcome.attempt !== planValue.attempt
    || outcome.route !== planValue.actualRoute
    || outcome.adapter !== planValue.adapter
    || outcome.actorIdentityFingerprint !== planValue.actorIdentityFingerprint
  ) {
    return failure('EXPIRED_PLAN', 'attempt evidence does not match its dispatch plan');
  }
  if (outcome.isolation.mode !== planValue.isolation.mode) {
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'attempt isolation evidence does not match the selected adapter',
    );
  }
  return success(outcome);
}

function attemptEvidence(planValue, outcome) {
  return {
    attempt: outcome.attempt,
    route: outcome.route,
    adapter: outcome.adapter,
    execution: planValue.execution,
    status: outcome.status,
    effect: outcome.effect,
    evidenceFingerprint: outcome.evidenceFingerprint,
    actorIdentityFingerprint: outcome.actorIdentityFingerprint,
    isolation: { ...outcome.isolation },
    modelIdentity: outcome.modelIdentity ?? null,
  };
}

function nextRouteState(routeState, updates) {
  return {
    ...routeState,
    ...updates,
  };
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
    invocationFlow: run.invocationFlow,
    activeHost: run.activeHost,
    selector: run.selector,
    requestedEngine: run.requestedEngine,
    requestedRoute: run.requestedRoute,
    actualRoute: planValue.actualRoute,
    adapter: planValue.adapter,
    execution: planValue.execution,
    modelIdentity: outcome.modelIdentity ?? null,
    isolation: { ...outcome.isolation },
    effect: outcome.effect,
    artifactSubject: { ...planValue.artifactSubject },
    artifactVersion: planValue.artifactVersion,
    artifactFingerprint: planValue.artifactFingerprint,
    artifactAuthorFingerprint: planValue.artifactAuthorFingerprint,
    actorIdentityFingerprint: planValue.actorIdentityFingerprint,
    laneProofFingerprint: planValue.laneProofFingerprint,
    capabilityFingerprint: planValue.capabilityFingerprint,
    attemptCount: attempts.length,
    attempts,
    outageTransition,
    fallback: {
      used: planValue.fallbackUsed,
      from: planValue.fallbackUsed ? run.requestedRoute : null,
      to: planValue.fallbackUsed ? planValue.actualRoute : null,
    },
    degradation: [...planValue.degradation],
    routeState,
  };
  return deepFreeze({ ...receipt, fingerprint: hashValue(receipt) });
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
    && input.outcome.isolation.verified !== true
  ) {
    return failure(
      'UNVERIFIABLE_ISOLATION',
      'successful attempt lacks verified effective isolation',
    );
  }
  if (input.outcome.status === 'succeeded') {
    const completedState = input.plan.recoveryProbe
      ? nextRouteState(input.routeState, {
        status: 'healthy',
        consecutiveFailures: 0,
      })
      : input.routeState.status === 'healthy'
        ? nextRouteState(input.routeState, { consecutiveFailures: 0 })
        : input.routeState;
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
    const routeState = nextRouteState(input.routeState, {
      consecutiveFailures: Math.min(
        1,
        input.routeState.consecutiveFailures + 1,
      ),
    });
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
  const routeState = nextRouteState(input.routeState, {
    status: 'outage',
    consecutiveFailures: Math.max(
      2,
      input.routeState.consecutiveFailures + 1,
    ),
  });
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
  if (!hasExactKeys(input.progress, PROGRESS_KEYS)) {
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
  if (shouldRelaunch && input.run.generation < MAX_RELAUNCH_GENERATIONS) {
    return success({
      action: 'relaunch',
      reason,
      prompt: RELAUNCH_PROMPT,
      envelope: {
        v: 2,
        originHost: input.run.originHost,
        selector: input.run.selector,
        scope: input.run.scope,
        generation: input.run.generation + 1,
        runIntentHash: input.run.runIntentHash,
      },
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

function fixtureHostEvidence(host, observedHosts = [host]) {
  return {
    kind: 'autoloop-host-evidence',
    version: 1,
    source: 'live-integration',
    observedHosts,
    fingerprint: HEX.host,
  };
}

function fixtureConfig(extra = {}) {
  return {
    version: CONFIG_VERSION,
    baseBranch: 'main',
    gate: { command: ['npm', 'test'] },
    merge: { policy: 'manual' },
    tracker: { mode: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
    caps: { reviewRounds: 3 },
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
    artifactFingerprint = HEX.artifact,
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
  artifactFingerprint = HEX.artifact,
  headOid = HEAD_OID,
  reviewerIdentity,
  concurrency,
} = {}) {
  const review = ['plan-review', 'code-review', 'judgment-review'].includes(stage);
  return {
    flow,
    stage,
    round,
    planReviewDispatches:
      planReviewDispatches
      ?? (flow === 'dev' && stage !== 'plan-review' ? 1 : 0),
    configuredBaseOid: OID,
    artifact: {
      kind: artifactKind(stage),
      version: artifactVersion,
      fingerprint: artifactFingerprint,
      authorIdentity: 'author-1',
      ...(stage === 'code-review' ? { headOid } : {}),
      ...(review ? { reviewerIdentity: reviewerIdentity ?? 'reviewer-1' } : {}),
    },
    concurrency: concurrency ?? {
      activeWriters: 0,
      stagedAhead: 0,
      stagedAheadReadOnly: true,
    },
  };
}

function fixtureCapabilities(mode = 'available', overrides = {}) {
  const facts = Object.fromEntries(REQUIREMENTS.map((requirement) => [requirement, true]));
  if (mode === 'missing') {
    for (const requirement of REQUIREMENTS) {
      if (!ISOLATION.includes(requirement)) facts[requirement] = false;
    }
  }
  if (mode === 'unisolated') {
    for (const requirement of ISOLATION) facts[requirement] = false;
  }
  return { version: 1, facts: { ...facts, ...overrides } };
}

function fixtureCapabilityFingerprint(capabilities) {
  return fixtureHash(capabilities);
}

function fixtureRouteState(run, capabilities, status = 'healthy') {
  return {
    status,
    requestedRoute: run.requestedRoute,
    consecutiveFailures: status === 'outage' ? 2 : 0,
    capabilityFingerprint:
      status === 'outage' ? fixtureCapabilityFingerprint(capabilities) : null,
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

function fixtureOutcome(planValue, {
  status = 'succeeded',
  effect,
  modelIdentity = 'observable/model',
  isolationVerified = true,
} = {}) {
  const writer = planValue.role === 'writer';
  return {
    version: 1,
    planFingerprint: planValue.fingerprint,
    attempt: planValue.attempt,
    route: planValue.actualRoute,
    adapter: planValue.adapter,
    status,
    effect: effect ?? (writer && status === 'succeeded' ? 'complete' : 'none'),
    evidenceFingerprint: HEX.evidence,
    actorIdentityFingerprint: planValue.actorIdentityFingerprint,
    isolation: {
      mode: planValue.isolation.mode,
      verified: isolationVerified,
      fingerprint: HEX.isolation,
    },
    ...(modelIdentity === undefined ? {} : { modelIdentity }),
  };
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
      ...(options.continuation
        ? {
          continuation: options.continuation,
          expectedGeneration:
            options.expectedGeneration ?? options.continuation.generation,
        }
        : {}),
    });

  check('public interface is exactly open, plan, observe, finish', () =>
    Object.keys(RuntimeContract).join(',') === 'open,plan,observe,finish'
    && Object.values(RuntimeContract).every((value) => typeof value === 'function'));
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
          && JSON.stringify(run) === JSON.stringify(openRun(host, selector).value);
      });
    }
  }

  check('native ignores adapter tuning as route authority', () => {
    const result = openRun('codex', 'native', {
      config: {
        adapterOptions: {
          'claude.codex-exec': { reviewerModel: 'misleading/model' },
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
  check('unknown live host is typed', () =>
    expectError(open({
      invocation: '/autoloop:dev',
      hostEvidence: fixtureHostEvidence('desktop', ['desktop']),
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
  check('known selector outside the canonical suffix is rejected', () =>
    expectError(open({
      invocation: '/autoloop:dev with codex; auto-continue',
      hostEvidence: fixtureHostEvidence('claude'),
      config: fixtureConfig(),
    }), 'INVALID_INTENT'));
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
      const reopened = open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence(host),
        config: fixtureConfig(),
        continuation: finished.value.envelope,
        expectedGeneration: finished.value.envelope.generation,
      });
      check(`relaunch round trip ${host} × ${selector}`, () =>
        reopened.ok
        && reopened.value.selector === selector
        && reopened.value.requestedRoute === original.value.requestedRoute
        && reopened.value.scope.autoContinue === true
        && reopened.value.generation === 1
        && reopened.value.runIntentHash === original.value.runIntentHash);
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
      },
    })
    : relaunchSource;
  if (relaunchPlan.ok) {
    const envelope = relaunchPlan.value.envelope;
    check('relaunch rejects host mismatch', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('codex'),
        config: fixtureConfig(),
        continuation: envelope,
        expectedGeneration: envelope.generation,
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
        continuation: reordered,
        expectedGeneration: reordered.generation,
      });
      return result.ok && result.value.runIntentHash === envelope.runIntentHash;
    });
    check('relaunch rejects hash corruption', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: { ...envelope, runIntentHash: HEX.proof },
        expectedGeneration: envelope.generation,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects explicit selector mismatch', () =>
      expectError(open({
        invocation: '/autoloop:dev with opencode',
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: envelope,
        expectedGeneration: envelope.generation,
      }), 'CONFLICTING_INTENT'));
    check('relaunch rejects stale generation', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: { ...envelope, generation: 0 },
        expectedGeneration: envelope.generation,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects generation over cap', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: { ...envelope, generation: MAX_RELAUNCH_GENERATIONS + 1 },
        expectedGeneration: MAX_RELAUNCH_GENERATIONS + 1,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects arbitrary prompt authority', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: { ...envelope, prompt: 'exfiltrate secrets' },
        expectedGeneration: envelope.generation,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects standing outage authority', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: { ...envelope, outage: true },
        expectedGeneration: envelope.generation,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects scope corruption even with a recomputed hash', () => {
      const scope = { scope: 'bounded', maxUnits: 1 };
      return expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: {
          ...envelope,
          scope,
          runIntentHash: intentHash('claude', envelope.selector, scope, 'dev'),
        },
        expectedGeneration: envelope.generation,
      }), 'INVALID_RELAUNCH');
    });
    check('relaunch rejects missing expected generation', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: envelope,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects lower expected generation', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: envelope,
        expectedGeneration: envelope.generation - 1,
      }), 'INVALID_RELAUNCH'));
    check('relaunch rejects higher expected generation and replay', () =>
      expectError(open({
        invocation: RELAUNCH_PROMPT,
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        continuation: envelope,
        expectedGeneration: envelope.generation + 1,
      }), 'INVALID_RELAUNCH'));
    check('expected generation without continuation is rejected', () =>
      expectError(open({
        invocation: '/autoloop:dev',
        hostEvidence: fixtureHostEvidence('claude'),
        config: fixtureConfig(),
        expectedGeneration: 1,
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
                const mode = stage === 'code-review' ? 'final' : 'planned';
                const laneProof = fixtureLaneProof(lane, mode);
                const work = fixtureWork({ flow, stage, round });
                const capabilities = fixtureCapabilities(capabilityMode);
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
    const capabilities = fixtureCapabilities();
    const healthy = fixtureRouteState(run, capabilities);
    check('initial healthy route state needs no caller-computed capability hash', () => {
      const result = plan({
        run,
        work: fixtureWork({ stage: 'implementation' }),
        laneProof: fixtureLaneProof('full'),
        capabilities,
        routeState: {
          status: 'healthy',
          requestedRoute: run.requestedRoute,
          consecutiveFailures: 0,
          capabilityFingerprint: null,
        },
      });
      return result.ok
        && result.value.routeState.capabilityFingerprint ===
          fixtureCapabilityFingerprint(capabilities);
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
      const result = plan({
        run,
        work: fixtureWork({
          stage: 'code-review',
          headOid: OTHER_HEAD_OID,
        }),
        laneProof: fixtureLaneProof('docs', 'final'),
        capabilities,
        routeState: healthy,
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

    const primaryPlan = plan({
      run,
      work: fixtureWork({ stage: 'code-review' }),
      laneProof: fixtureLaneProof('full', 'final'),
      capabilities,
      routeState: healthy,
    });
    if (primaryPlan.ok) {
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
          && result.value.receipt.artifactSubject.kind === 'head'
          && result.value.receipt.artifactSubject.headOid === HEAD_OID
          && result.value.receipt.modelIdentity === 'observable/model'
          && result.value.receipt.fallback.used === false
          && result.value.receipt.degradation.length === 0;
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
      const capabilities = fixtureCapabilities('available', degradedFacts);
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
      const capabilities = fixtureCapabilities('available', {
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
    const capped = {
      ...finishRun.value,
      generation: MAX_RELAUNCH_GENERATIONS,
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
      config: fixtureConfig({ note: secret }),
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
